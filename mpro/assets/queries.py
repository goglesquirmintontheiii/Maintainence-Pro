"""Location and asset lists, serialization, insights and exports (0.3.0)."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import Select, case, func, or_, select

from mpro.assets.models import (
    ASSET_STATUS_LABELS,
    ASSET_STATUSES,
    CRITICALITY,
    CRITICALITY_LABELS,
    Asset,
    AssetStatusChange,
    AssetTypeLink,
    FloorPlan,
    FloorPlanPin,
    Location,
)
from mpro.assets.services import FINANCIAL_FIELDS, depreciation, downtime, teams_of
from mpro.core.files import file_dict, links_for, links_for_many
from mpro.core.hierarchy import TreePath, subtree_ids
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.search import like
from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.orgs.services import RuleError
from mpro.workorders.models import ACTIVE_STATUSES, CostEntry, TimeEntry, WorkOrder


def _uuid(v: Any) -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError("That record doesn't exist.", 422) from e


def _paging(params: dict[str, Any], default: int = 50) -> tuple[int, int]:
    try:
        return max(1, min(int(params.get("per_page") or default), 500)), max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("page and per_page must be numbers.", 422) from e


def paths_for(kind: str, model: Any, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, str]]]:
    """Breadcrumbs (root first, excluding the record) for many records in one query."""
    if not ids:
        return {}
    rows = db.session.execute(
        select(TreePath.descendant_id, model.id, model.name, TreePath.depth)
        .join(model, model.id == TreePath.ancestor_id)
        .where(TreePath.kind == kind, TreePath.descendant_id.in_(ids), TreePath.depth > 0)
        .order_by(TreePath.descendant_id, TreePath.depth.desc())
    ).all()
    out: dict[uuid.UUID, list[dict[str, str]]] = {i: [] for i in ids}
    for d, aid, name, _ in rows:
        out[d].append({"id": str(aid), "name": name})
    return out


def _child_counts(model: Any, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = db.session.execute(
        select(model.parent_id, func.count())
        .where(model.parent_id.in_(ids), model.deleted_at.is_(None))
        .group_by(model.parent_id)
    ).all()
    return {r[0]: int(r[1]) for r in rows}


def open_wo_counts(m: Membership, column: Any, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    from mpro.workorders.services import visibility_filter

    if not ids or not can(m, "wo.view"):
        return {}
    rows = db.session.execute(
        select(column, func.count())
        .where(
            column.in_(ids), WorkOrder.deleted_at.is_(None), WorkOrder.status.in_(ACTIVE_STATUSES), visibility_filter(m)
        )
        .group_by(column)
    ).all()
    return {r[0]: int(r[1]) for r in rows}


# ---- locations -------------------------------------------------------------------------------
def location_dict(loc: Location, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    d = {
        "id": str(loc.id),
        "name": loc.name,
        "description": loc.description,
        "parent_id": str(loc.parent_id) if loc.parent_id else None,
        "address_line1": loc.address_line1,
        "address_line2": loc.address_line2,
        "city": loc.city,
        "region": loc.region,
        "postal_code": loc.postal_code,
        "country": loc.country,
        "address": ", ".join(
            x for x in (loc.address_line1, loc.address_line2, loc.city, loc.region, loc.postal_code, loc.country) if x
        ),
        "latitude": loc.latitude,
        "longitude": loc.longitude,
        "custom": loc.custom or {},
        "created_at": iso(loc.created_at),
        "updated_at": iso(loc.updated_at),
        "deleted": loc.deleted_at is not None,
    }
    if extra:
        d.update(extra)
    return d


def location_list(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    q = select(Location).where(Location.org_id == m.org_id)
    if str(params.get("include_deleted")) not in ("1", "true"):
        q = q.where(Location.deleted_at.is_(None))
    if params.get("q"):
        q = q.where(
            or_(
                func.lower(Location.name).like(like(params["q"]), escape="\\"),
                func.lower(Location.city).like(like(params["q"]), escape="\\"),
            )
        )
    parent = params.get("parent_id")
    if parent == "root":
        q = q.where(Location.parent_id.is_(None))
    elif parent:
        q = q.where(Location.parent_id == _uuid(parent))
    if params.get("within"):
        q = q.where(Location.id.in_(subtree_ids("location", _uuid(params["within"]))))
    total = db.session.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    per_page, page = _paging(params, 200)
    sort = params.get("sort") or "name"
    order = {
        "name": func.lower(Location.name),
        "-name": func.lower(Location.name).desc(),
        "-updated_at": Location.updated_at.desc(),
        "updated_at": Location.updated_at,
    }.get(sort, func.lower(Location.name))
    rows = db.session.scalars(q.order_by(order, Location.id).limit(per_page).offset((page - 1) * per_page)).all()
    ids = [r.id for r in rows]
    paths = paths_for("location", Location, ids)
    kids = _child_counts(Location, ids)
    assets = (
        dict(
            db.session.execute(
                select(Asset.location_id, func.count())
                .where(Asset.location_id.in_(ids), Asset.deleted_at.is_(None))
                .group_by(Asset.location_id)
            ).all()
        )
        if ids
        else {}
    )
    teams = teams_of("location", ids)
    wos = open_wo_counts(m, WorkOrder.location_id, ids)
    return {
        "items": [
            location_dict(
                r,
                {
                    "path": paths.get(r.id, []),
                    "child_count": kids.get(r.id, 0),
                    "asset_count": int(assets.get(r.id, 0)),
                    "teams": teams.get(r.id, []),
                    "open_work_orders": wos.get(r.id, 0),
                },
            )
            for r in rows
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def location_detail(m: Membership, loc: Location) -> dict[str, Any]:
    pins_by_plan: dict[uuid.UUID, list[dict[str, Any]]] = {}
    plans = db.session.scalars(
        select(FloorPlan)
        .where(FloorPlan.location_id == loc.id, FloorPlan.deleted_at.is_(None))
        .order_by(FloorPlan.sort, FloorPlan.created_at)
    ).all()
    if plans:
        pins = db.session.scalars(
            select(FloorPlanPin).where(FloorPlanPin.floor_plan_id.in_([p.id for p in plans]))
        ).all()
        names = dict(
            db.session.execute(
                select(Asset.id, Asset.name).where(Asset.id.in_([p.asset_id for p in pins if p.asset_id]))
            ).all()
        )
        status = dict(
            db.session.execute(
                select(Asset.id, Asset.status).where(Asset.id.in_([p.asset_id for p in pins if p.asset_id]))
            ).all()
        )
        for p in pins:
            pins_by_plan.setdefault(p.floor_plan_id, []).append(
                {
                    "id": str(p.id),
                    "x": p.x,
                    "y": p.y,
                    "label": p.label or (names.get(p.asset_id, "") if p.asset_id else ""),
                    "asset_id": str(p.asset_id) if p.asset_id else None,
                    "asset_status": status.get(p.asset_id) if p.asset_id else None,
                }
            )
    files = links_for("location", loc.id)
    sub_ids = db.session.scalars(subtree_ids("location", loc.id)).all()
    return location_dict(
        loc,
        {
            "path": paths_for("location", Location, [loc.id]).get(loc.id, []),
            "teams": teams_of("location", [loc.id]).get(loc.id, []),
            "child_count": _child_counts(Location, [loc.id]).get(loc.id, 0),
            "asset_count": db.session.scalar(
                select(func.count())
                .select_from(Asset)
                .where(Asset.location_id.in_(sub_ids), Asset.deleted_at.is_(None))
            )
            or 0,
            "open_work_orders": sum(open_wo_counts(m, WorkOrder.location_id, list(sub_ids)).values()),
            "files": [file_dict(link.file, link.role, link.id) for link in files if link.role != "floor_plan"],
            "floor_plans": [
                {
                    "id": str(p.id),
                    "name": p.name,
                    "file_id": str(p.file_id),
                    "url": f"/api/v1/files/{p.file_id}",
                    "pins": pins_by_plan.get(p.id, []),
                }
                for p in plans
            ],
            "maps_url": (
                f"https://www.openstreetmap.org/?mlat={loc.latitude}&mlon={loc.longitude}#map=18/{loc.latitude}/{loc.longitude}"
                if loc.latitude is not None and loc.longitude is not None
                else None
            ),
        },
    )


# ---- assets ----------------------------------------------------------------------------------
def asset_dict(m: Membership, a: Asset, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(a.id),
        "name": a.name,
        "status": a.status,
        "status_label": ASSET_STATUS_LABELS.get(a.status, a.status),
        "status_reason": a.status_reason,
        "downtime_type": a.downtime_type,
        "status_changed_at": iso(a.status_changed_at),
        "criticality": a.criticality,
        "criticality_label": CRITICALITY_LABELS.get(a.criticality, ""),
        "parent_id": str(a.parent_id) if a.parent_id else None,
        "location": {"id": str(a.location.id), "name": a.location.name}
        if a.location and a.location.deleted_at is None
        else None,
        "manufacturer": a.manufacturer,
        "model": a.model,
        "serial_number": a.serial_number,
        "year": a.year,
        "barcode": a.barcode,
        "types": [
            {"id": str(t.type.id), "name": t.type.name, "color": t.type.color}
            for t in a.type_links
            if t.type.deleted_at is None
        ],
        "warranty_end": a.warranty_end.isoformat() if a.warranty_end else None,
        "warranty_active": bool(a.warranty_end and a.warranty_end >= datetime.now(UTC).date()),
        "replacement_year": a.replacement_year,
        "disposed": a.disposed_on is not None,
        "custom": a.custom or {},
        "created_at": iso(a.created_at),
        "updated_at": iso(a.updated_at),
        "deleted": a.deleted_at is not None,
        "version": a.version,
    }
    if extra:
        d.update(extra)
    return d


SORTS: dict[str, Any] = {
    "name": func.lower(Asset.name),
    "status": Asset.status,
    "criticality": case({"critical": 0, "important": 1, "normal": 2}, value=Asset.criticality, else_=3),
    "updated_at": Asset.updated_at,
    "created_at": Asset.created_at,
    "manufacturer": func.lower(Asset.manufacturer),
    "warranty_end": Asset.warranty_end,
    "year": Asset.year,
}


def asset_query(m: Membership, params: dict[str, Any]) -> Select[Any]:
    q = select(Asset).where(Asset.org_id == m.org_id)
    if str(params.get("include_deleted")) not in ("1", "true"):
        q = q.where(Asset.deleted_at.is_(None))
    if params.get("q"):
        pat = like(params["q"])
        q = q.where(
            or_(
                *(
                    func.lower(c).like(pat, escape="\\")
                    for c in (Asset.name, Asset.serial_number, Asset.model, Asset.manufacturer, Asset.barcode)
                )
            )
        )
    for key, col, allowed in (
        ("status", Asset.status, ASSET_STATUSES),
        ("criticality", Asset.criticality, CRITICALITY),
    ):
        if params.get(key):
            vals = [v for v in str(params[key]).split(",") if v in allowed or (key == "criticality" and v == "none")]
            if not vals:
                raise RuleError(f"Unknown {key}.", 422)
            q = q.where(col.in_(["" if v == "none" else v for v in vals]))
    parent = params.get("parent_id")
    if parent == "root":
        q = q.where(Asset.parent_id.is_(None))
    elif parent:
        q = q.where(Asset.parent_id == _uuid(parent))
    if params.get("within"):
        q = q.where(Asset.id.in_(subtree_ids("asset", _uuid(params["within"]))), Asset.id != _uuid(params["within"]))
    if params.get("location_id"):
        lid = params["location_id"]
        if lid == "none":
            q = q.where(Asset.location_id.is_(None))
        else:
            q = q.where(Asset.location_id.in_(subtree_ids("location", _uuid(lid))))
    if params.get("type_id"):
        q = q.where(
            Asset.id.in_(
                select(AssetTypeLink.asset_id).where(
                    AssetTypeLink.type_id.in_([_uuid(x) for x in str(params["type_id"]).split(",")])
                )
            )
        )
    if params.get("manufacturer"):
        q = q.where(func.lower(Asset.manufacturer) == str(params["manufacturer"]).lower())
    if params.get("warranty") == "active":
        q = q.where(Asset.warranty_end >= datetime.now(UTC).date())
    elif params.get("warranty") == "expired":
        q = q.where(Asset.warranty_end < datetime.now(UTC).date())
    elif params.get("warranty_expiring_days"):
        try:
            days = max(1, min(int(params["warranty_expiring_days"]), 3650))
        except ValueError as e:
            raise RuleError("warranty_expiring_days must be a number.", 422) from e
        today = datetime.now(UTC).date()
        q = q.where(Asset.warranty_end >= today, Asset.warranty_end <= today + timedelta(days=days))
    if params.get("label") in ("none", "has"):
        from mpro.qr.models import QrCode

        labelled = select(QrCode.entity_id).where(
            QrCode.org_id == m.org_id, QrCode.entity_type == "asset", QrCode.retired_at.is_(None)
        )
        q = q.where(Asset.id.not_in(labelled) if params["label"] == "none" else Asset.id.in_(labelled))
    return q


def apply_asset_sort(q: Select[Any], sort: str | None) -> Select[Any]:
    order: list[Any] = []
    for part in (sort or "name").split(","):
        desc = part.startswith("-")
        col = SORTS.get(part.lstrip("-"))
        if col is None:
            raise RuleError(f"Can't sort by {part.lstrip('-')}.", 422)
        order.append(col.desc() if desc else col)
    return q.order_by(*order, Asset.id)


def asset_list(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    q = asset_query(m, params)
    total = db.session.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    per_page, page = _paging(params)
    rows = db.session.scalars(
        apply_asset_sort(q, params.get("sort")).limit(per_page).offset((page - 1) * per_page)
    ).all()
    return {"items": summaries(m, list(rows)), "total": total, "page": page, "per_page": per_page}


def summaries(m: Membership, rows: list[Asset]) -> list[dict[str, Any]]:
    ids = [a.id for a in rows]
    paths = paths_for("asset", Asset, ids)
    kids = _child_counts(Asset, ids)
    wos = open_wo_counts(m, WorkOrder.asset_id, ids)
    photos = links_for_many("asset", ids)
    out = []
    for a in rows:
        thumb = next(
            (lk.file for lk in photos.get(a.id, []) if lk.file.is_image and lk.role in ("photo", "file")), None
        )
        out.append(
            asset_dict(
                m,
                a,
                {
                    "path": paths.get(a.id, []),
                    "child_count": kids.get(a.id, 0),
                    "open_work_orders": wos.get(a.id, 0),
                    "thumb_url": f"/api/v1/files/{thumb.id}/thumb" if thumb else None,
                },
            )
        )
    return out


def asset_detail(m: Membership, a: Asset) -> dict[str, Any]:
    from mpro.workorders.services import custom_fields

    now = utcnow()
    files = links_for("asset", a.id)
    d = summaries(m, [a])[0]
    d.update(
        {
            "description": a.description,
            "teams": teams_of("asset", [a.id]).get(a.id, []),
            "status_changed_by": {"id": str(a.status_changed_by.id), "name": a.status_changed_by.name}
            if a.status_changed_by
            else None,
            "files": [file_dict(link.file, link.role, link.id) for link in files],
            "lifecycle": {
                "commissioned_on": a.commissioned_on.isoformat() if a.commissioned_on else None,
                "expected_life_years": a.expected_life_years,
                "replacement_year": a.replacement_year,
                "disposed_on": a.disposed_on.isoformat() if a.disposed_on else None,
                "disposal_method": a.disposal_method,
                "disposal_notes": a.disposal_notes,
                "age_years": round(
                    (now.date() - (a.commissioned_on or a.purchase_date or a.created_at.date())).days / 365.25, 1
                ),
            },
            "warranty": {
                "start": a.warranty_start.isoformat() if a.warranty_start else None,
                "end": a.warranty_end.isoformat() if a.warranty_end else None,
                "provider": a.warranty_provider,
                "terms": a.warranty_terms,
                "days_left": (a.warranty_end - now.date()).days if a.warranty_end else None,
            },
            "downtime_30d": downtime(a.id, now - timedelta(days=30), now),
            "custom_fields": [
                {"id": str(f.id), "name": f.name, "type": f.type, "options": f.options or [], "required": f.required}
                for f in custom_fields(a.org_id, "asset")
                if f.scope_id is None or f.scope_id in {t.type_id for t in a.type_links}
            ],
        }
    )
    if can(m, "assets.financials"):
        d["financials"] = {
            "purchase_price_cents": a.purchase_price_cents,
            "purchase_date": a.purchase_date.isoformat() if a.purchase_date else None,
            "useful_life_years": a.useful_life_years,
            "salvage_value_cents": a.salvage_value_cents,
            "depreciation_start": a.depreciation_start.isoformat() if a.depreciation_start else None,
            "replacement_cost_cents": a.replacement_cost_cents,
            "disposal_value_cents": a.disposal_value_cents,
            "depreciation": depreciation(a),
        }
    from mpro.qr.services import codes_for

    d["codes"] = codes_for(a.org_id, "asset", a.id)
    return d


def status_history(a: Asset, limit: int = 100) -> list[dict[str, Any]]:
    from mpro.auth.models import User

    rows = db.session.execute(
        select(AssetStatusChange, User.name)
        .outerjoin(User, User.id == AssetStatusChange.actor_id)
        .where(AssetStatusChange.asset_id == a.id)
        .order_by(AssetStatusChange.at.desc(), AssetStatusChange.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(c.id),
            "from": c.from_status,
            "to": c.to_status,
            "reason": c.reason,
            "downtime_type": c.downtime_type,
            "note": c.note,
            "actor": name,
            "work_order_id": str(c.work_order_id) if c.work_order_id else None,
            "at": iso(c.at),
        }
        for c, name in rows
    ]


def insights(m: Membership, a: Asset, days: int = 90, include_children: bool = True) -> dict[str, Any]:
    """Work orders created vs completed per week, costs and downtime (MaintainX asset Insights)."""
    from mpro.workorders.activity import can_see_rates
    from mpro.workorders.services import visibility_filter

    days = max(7, min(days, 730))
    now = utcnow()
    start = now - timedelta(days=days)
    ids = list(db.session.scalars(subtree_ids("asset", a.id)).all()) if include_children else [a.id]
    base = select(WorkOrder).where(WorkOrder.asset_id.in_(ids), WorkOrder.deleted_at.is_(None), visibility_filter(m))
    created = db.session.scalars(base.where(WorkOrder.created_at >= start)).all()
    completed = db.session.scalars(base.where(WorkOrder.completed_at >= start)).all()
    weeks: dict[str, dict[str, Any]] = {}
    first = (start - timedelta(days=start.weekday())).date()
    d = first
    while d <= now.date():
        weeks[d.isoformat()] = {"week": d.isoformat(), "created": 0, "completed": 0}
        d += timedelta(days=7)

    def wk(dt: datetime) -> str:
        day = dt.date()
        return (day - timedelta(days=day.weekday())).isoformat()

    for w in created:
        if wk(w.created_at) in weeks:
            weeks[wk(w.created_at)]["created"] += 1
    for w in completed:
        if w.completed_at and wk(w.completed_at) in weeks:
            weeks[wk(w.completed_at)]["completed"] += 1
    out: dict[str, Any] = {
        "days": days,
        "weeks": list(weeks.values()),
        "created": len(created),
        "completed": len(completed),
        "open": db.session.scalar(
            select(func.count()).select_from(base.where(WorkOrder.status.in_(ACTIVE_STATUSES)).subquery())
        )
        or 0,
        "downtime": downtime(a.id, start, now),
    }
    wo_ids = select(WorkOrder.id).where(
        WorkOrder.asset_id.in_(ids), WorkOrder.deleted_at.is_(None), visibility_filter(m)
    )
    other = (
        db.session.scalar(
            select(func.coalesce(func.sum(CostEntry.amount_cents), 0)).where(
                CostEntry.work_order_id.in_(wo_ids), CostEntry.created_at >= start
            )
        )
        or 0
    )
    out["costs"] = {"other_cents": int(other)}
    minutes = (
        db.session.scalar(
            select(func.coalesce(func.sum(TimeEntry.minutes), 0)).where(
                TimeEntry.work_order_id.in_(wo_ids), TimeEntry.created_at >= start
            )
        )
        or 0
    )
    out["costs"]["minutes"] = int(minutes)
    if can_see_rates(m):
        labor = (
            db.session.scalar(
                select(func.coalesce(func.sum(TimeEntry.minutes * TimeEntry.effective_rate_cents / 60), 0)).where(
                    TimeEntry.work_order_id.in_(wo_ids), TimeEntry.created_at >= start
                )
            )
            or 0
        )
        out["costs"]["labor_cents"] = int(labor)
        out["costs"]["total_cents"] = int(labor) + int(other)
    return out


def warranties_expiring(m: Membership, days: int = 60) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        asset_query(m, {"warranty_expiring_days": days}).order_by(Asset.warranty_end, Asset.name).limit(200)
    ).all()
    return summaries(m, list(rows))


# ---- CSV ---------------------------------------------------------------------------------------
def assets_csv(m: Membership, params: dict[str, Any]) -> bytes:
    from mpro.workorders.services import custom_fields

    rows = db.session.scalars(apply_asset_sort(asset_query(m, params), params.get("sort")).limit(50000)).all()
    fields = custom_fields(m.org_id, "asset")
    fin = can(m, "assets.financials")
    paths = paths_for("asset", Asset, [a.id for a in rows])
    cols = [
        "ID",
        "Name",
        "Status",
        "Status reason",
        "Criticality",
        "Parent path",
        "Location",
        "Types",
        "Manufacturer",
        "Model",
        "Serial number",
        "Year",
        "Barcode",
        "Commissioned",
        "Expected life (years)",
        "Replacement year",
        "Warranty start",
        "Warranty end",
        "Warranty provider",
        "Disposed on",
        "Disposal method",
        "Description",
        "Updated",
    ]
    if fin:
        cols += [
            "Purchase price",
            "Purchase date",
            "Useful life (years)",
            "Salvage value",
            "Book value",
            "Replacement cost",
        ]
    cols += [f.name for f in fields]
    buf = io.StringIO()
    w = csv.writer(buf)

    def money(c: int | None) -> str:
        return f"{c / 100:.2f}" if c is not None else ""

    def safe(v: Any) -> str:
        s = "" if v is None else str(v)
        if isinstance(v, int | float) and not isinstance(v, bool):
            return s  # numbers (including negatives) are safe
        return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s  # CSV injection guard

    def dt(v: date | None) -> str:
        return v.isoformat() if v else ""

    w.writerow([safe(c) for c in cols])

    for a in rows:
        r: list[Any] = [
            str(a.id),
            a.name,
            ASSET_STATUS_LABELS[a.status],
            a.status_reason,
            CRITICALITY_LABELS.get(a.criticality, ""),
            " / ".join(p["name"] for p in paths.get(a.id, [])),
            a.location.name if a.location else "",
            ", ".join(t.type.name for t in a.type_links),
            a.manufacturer,
            a.model,
            a.serial_number,
            a.year or "",
            a.barcode,
            dt(a.commissioned_on),
            a.expected_life_years or "",
            a.replacement_year or "",
            dt(a.warranty_start),
            dt(a.warranty_end),
            a.warranty_provider,
            dt(a.disposed_on),
            a.disposal_method,
            a.description,
            iso(a.updated_at),
        ]
        if fin:
            dep = depreciation(a)
            r += [
                money(a.purchase_price_cents),
                dt(a.purchase_date),
                a.useful_life_years or "",
                money(a.salvage_value_cents),
                money(dep["book_value_cents"]) if dep else "",
                money(a.replacement_cost_cents),
            ]
        r += [(a.custom or {}).get(str(f.id), "") for f in fields]
        w.writerow([safe(x) for x in r])
    return ("﻿" + buf.getvalue()).encode()


_ = FINANCIAL_FIELDS
