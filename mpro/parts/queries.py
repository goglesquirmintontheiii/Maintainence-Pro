"""Parts lists, details, transaction log and reports (CSV for the Download Center)."""

from __future__ import annotations

import base64
import csv
import io
import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, exists, func, or_, select

from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.search import like
from mpro.extensions import db
from mpro.orgs.models import Membership, Team
from mpro.orgs.services import RuleError
from mpro.parts import services as svc
from mpro.parts.ledger import ZERO
from mpro.parts.models import (
    InventoryTransaction,
    Part,
    PartAsset,
    PartStock,
    PartTeam,
    PartType,
    PartTypeLink,
    PartVendor,
    WorkOrderPart,
)
from mpro.workorders.models import WorkOrder

KIND_LABELS = {
    "restock": "Restock",
    "use": "Used on work order",
    "return": "Returned",
    "adjust": "Adjustment",
    "transfer_out": "Moved out",
    "transfer_in": "Moved in",
    "receive": "Received (purchase order)",
    "count": "Cycle count",
    "initial": "Opening stock",
}
SORTS = {
    "name": func.lower(Part.name),
    "part_number": func.lower(Part.part_number),
    "on_hand": Part.on_hand,
    "unit_cost": Part.unit_cost,
    "updated_at": Part.updated_at,
    "created_at": Part.created_at,
}


def q(d: Decimal | None) -> str | None:
    if d is None:
        return None
    return svc._q(d)


def money(d: Decimal | None) -> str:
    """Unit costs keep up to 4 decimals but show at least 2: 2.5000 → "2.50", 0.1234 → "0.1234"."""
    if d is None:
        return ""
    n = d.normalize()
    return str(n.quantize(Decimal("0.01"))) if -n.as_tuple().exponent <= 2 else format(n, "f")  # type: ignore[operator]


def _paging(params: dict[str, Any], default: int = 50) -> tuple[int, int]:
    try:
        return max(1, min(int(params.get("per_page") or default), 500)), max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("page and per_page must be numbers.", 422) from e


def _uid(v: Any, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


# ---------------------------------------------------------------- list
def part_query(m: Membership, params: dict[str, Any]) -> Select[Any]:
    """Filters: q, stock (in_stock|needs_restock|out_of_stock), type_id, location_id, vendor_id, asset_id, team_id,
    critical (1), non_stock (1|0), include_deleted (1), ids (comma separated)."""
    org_id = m.org_id
    qy = select(Part).where(Part.org_id == org_id)
    if params.get("include_deleted") != "1" or not can(m, "parts.delete"):
        qy = qy.where(Part.deleted_at.is_(None))
    if params.get("ids"):
        ids = [_uid(i, "part") for i in str(params["ids"]).split(",") if i.strip()][:500]
        qy = qy.where(Part.id.in_(ids))
    text = str(params.get("q") or "").strip()
    if text:
        pat = like(text)
        from mpro.assets.models import Asset
        from mpro.vendors.models import Vendor
        from mpro.workorders.services import custom_fields

        conds = [
            func.lower(Part.name).like(pat, escape="\\"),
            func.lower(Part.part_number).like(pat, escape="\\"),
            func.lower(Part.description).like(pat, escape="\\"),
            func.lower(Part.barcode).like(pat, escape="\\"),
            func.lower(Part.mpn).like(pat, escape="\\"),
            func.lower(Part.manufacturer).like(pat, escape="\\"),
            Part.id.in_(
                select(PartVendor.part_id).where(
                    PartVendor.org_id == org_id, func.lower(PartVendor.vendor_part_number).like(pat, escape="\\")
                )
            ),
            Part.id.in_(
                select(PartVendor.part_id)
                .join(Vendor, Vendor.id == PartVendor.vendor_id)
                .where(PartVendor.org_id == org_id, func.lower(Vendor.name).like(pat, escape="\\"))
            ),
            Part.id.in_(
                select(PartAsset.part_id)
                .join(Asset, Asset.id == PartAsset.asset_id)
                .where(PartAsset.org_id == org_id, func.lower(Asset.name).like(pat, escape="\\"))
            ),
        ]
        if custom_fields(org_id, "part"):
            conds.append(func.lower(func.cast(Part.custom, db.String)).like(pat, escape="\\"))
        qy = qy.where(or_(*conds))
    if params.get("type_id"):
        qy = qy.where(
            Part.id.in_(select(PartTypeLink.part_id).where(PartTypeLink.type_id == _uid(params["type_id"], "type")))
        )
    if params.get("critical") == "1":
        qy = qy.where(
            Part.id.in_(
                select(PartTypeLink.part_id)
                .join(PartType, PartType.id == PartTypeLink.type_id)
                .where(PartType.critical.is_(True))
            )
        )
    if params.get("vendor_id"):
        qy = qy.where(
            Part.id.in_(select(PartVendor.part_id).where(PartVendor.vendor_id == _uid(params["vendor_id"], "vendor")))
        )
    if params.get("asset_id"):
        qy = qy.where(
            Part.id.in_(select(PartAsset.part_id).where(PartAsset.asset_id == _uid(params["asset_id"], "asset")))
        )
    if params.get("team_id"):
        qy = qy.where(Part.id.in_(select(PartTeam.part_id).where(PartTeam.team_id == _uid(params["team_id"], "team"))))
    if params.get("non_stock") in ("0", "1"):
        qy = qy.where(Part.non_stock.is_(params["non_stock"] == "1"))
    loc = params.get("location_id")
    if loc:
        lid = None if loc == "none" else _uid(loc, "location")
        qy = qy.where(
            exists().where(
                PartStock.part_id == Part.id,
                PartStock.location_id.is_(None) if lid is None else PartStock.location_id == lid,
            )
        )
    stock = params.get("stock")
    if stock:
        trig = svc.settings(org_id)["restock_trigger"]
        level = (PartStock.on_hand - PartStock.reserved) if trig == "available" else PartStock.on_hand
        low = and_(PartStock.part_id == Part.id, PartStock.min_qty.is_not(None), level < PartStock.min_qty)
        if loc:
            lid = None if loc == "none" else _uid(loc, "location")
            low = and_(low, PartStock.location_id.is_(None) if lid is None else PartStock.location_id == lid)
        if stock == "needs_restock":
            qy = qy.where(Part.non_stock.is_(False), exists().where(low))
        elif stock == "out_of_stock":
            qy = qy.where(Part.non_stock.is_(False), Part.on_hand <= 0)
        elif stock == "in_stock":
            qy = qy.where(Part.non_stock.is_(False), Part.on_hand > 0, ~exists().where(low))
        else:
            raise RuleError("Stock filter must be in_stock, needs_restock or out_of_stock.", 422)
    return qy


def apply_sort(qy: Select[Any], sort: str | None) -> Select[Any]:
    s = (sort or "name").strip()
    desc = s.startswith("-")
    col = SORTS.get(s.lstrip("-"))
    if col is None:
        raise RuleError("Unknown sort.", 422)
    return qy.order_by(col.desc() if desc else col.asc(), Part.id)


def part_list(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    qy = part_query(m, params)
    total = db.session.scalar(select(func.count()).select_from(qy.order_by(None).subquery())) or 0
    per_page, page = _paging(params)
    rows = list(
        db.session.scalars(apply_sort(qy, params.get("sort")).limit(per_page).offset((page - 1) * per_page)).all()
    )
    out: dict[str, Any] = {"items": summaries(m, rows), "total": total, "page": page, "per_page": per_page}
    if params.get("per_location") == "1":
        out["per_location"] = per_location_rows(m, rows, params.get("location_id"))
    return out


def summaries(m: Membership, rows: list[Part]) -> list[dict[str, Any]]:
    from mpro.core.files import FileObject

    ids = [p.id for p in rows]
    if not ids:
        return []
    org_id = m.org_id
    show_cost = can(m, "costs.view")
    types: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for link, t in db.session.execute(
        select(PartTypeLink, PartType)
        .join(PartType, PartType.id == PartTypeLink.type_id)
        .where(PartTypeLink.part_id.in_(ids), PartType.deleted_at.is_(None))
    ).all():
        types.setdefault(link.part_id, []).append(
            {"id": str(t.id), "name": t.name, "color": t.color, "critical": t.critical}
        )
    stocks: dict[uuid.UUID, list[PartStock]] = {}
    for st in db.session.scalars(select(PartStock).where(PartStock.part_id.in_(ids))).all():
        stocks.setdefault(st.part_id, []).append(st)
    trig = svc.settings(org_id)["restock_trigger"]
    pics = {
        f.id: f
        for f in db.session.scalars(
            select(FileObject).where(FileObject.id.in_([p.picture_file_id for p in rows if p.picture_file_id]))
        ).all()
    }
    out = []
    for p in rows:
        sts = stocks.get(p.id, [])
        mins = [s.min_qty for s in sts if s.min_qty is not None]
        maxs = [s.max_qty for s in sts if s.max_qty is not None]
        low = [s for s in sts if svc.needs_restock(org_id, s, trig)]
        avail = (p.on_hand or ZERO) - (p.reserved or ZERO)
        pic = pics.get(p.picture_file_id) if p.picture_file_id else None
        out.append(
            {
                "id": str(p.id),
                "name": p.name,
                "part_number": p.part_number,
                "description": p.description[:300],
                "unit": p.unit,
                "unit_cost": money(p.unit_cost) if show_cost else None,
                "on_hand": None if p.non_stock else q(p.on_hand),
                "reserved": None if p.non_stock else q(p.reserved),
                "available": None if p.non_stock else q(avail),
                "ordered": None if p.non_stock else q(p.ordered),
                "min_qty": q(sum(mins, ZERO)) if mins else None,
                "max_qty": q(sum(maxs, ZERO)) if maxs else None,
                "non_stock": p.non_stock,
                "needs_restock": bool(low) and not p.non_stock,
                "out_of_stock": not p.non_stock and (p.on_hand or ZERO) <= ZERO,
                "negative": not p.non_stock and (p.on_hand or ZERO) < ZERO,
                "locations": len(sts),
                "barcode": p.barcode,
                "types": types.get(p.id, []),
                "critical": any(t["critical"] for t in types.get(p.id, [])),
                "thumb_url": f"/api/v1/files/{pic.id}/thumb" if pic else None,
                "picture": _picture(pic.id) if pic else None,
                "deleted": p.deleted_at is not None,
                "updated_at": iso(p.updated_at),
                "version": p.version,
            }
        )
    return out


def _picture(fid: uuid.UUID | None) -> dict[str, str] | None:
    """The part's picture (MP-131) as {id, url, thumb_url}."""
    if fid is None:
        return None
    return {"id": str(fid), "url": f"/api/v1/files/{fid}", "thumb_url": f"/api/v1/files/{fid}/thumb"}


def stock_dict(org_id: uuid.UUID, st: PartStock, trig: str, loc_names: dict[uuid.UUID, str]) -> dict[str, Any]:
    return {
        "id": str(st.id),
        "location": {"id": str(st.location_id), "name": loc_names.get(st.location_id, "")} if st.location_id else None,
        "area": st.area,
        "on_hand": q(st.on_hand),
        "reserved": q(st.reserved),
        "available": q((st.on_hand or ZERO) - (st.reserved or ZERO)),
        "min_qty": q(st.min_qty),
        "max_qty": q(st.max_qty),
        "needs_restock": svc.needs_restock(org_id, st, trig),
        "negative": (st.on_hand or ZERO) < ZERO,
        "restock_quantity": q(svc.restock_quantity(st)),
    }


def _loc_names(ids: list[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    from mpro.assets.models import Location

    real = [i for i in ids if i is not None]
    if not real:
        return {}
    return dict(db.session.execute(select(Location.id, Location.name).where(Location.id.in_(real))).all())  # type: ignore[arg-type, unused-ignore]


def per_location_rows(m: Membership, rows: list[Part], location: str | None) -> list[dict[str, Any]]:
    """ "Show per location" (r218): one row per part and stocking location."""
    ids = [p.id for p in rows]
    if not ids:
        return []
    qy = select(PartStock).where(PartStock.part_id.in_(ids))
    if location:
        qy = qy.where(
            PartStock.location_id.is_(None)
            if location == "none"
            else PartStock.location_id == _uid(location, "location")
        )
    sts = db.session.scalars(qy).all()
    names = _loc_names([s.location_id for s in sts])
    trig = svc.settings(m.org_id)["restock_trigger"]
    by_part = {p.id: p for p in rows}
    out = []
    for st in sts:
        p = by_part[st.part_id]
        d = stock_dict(m.org_id, st, trig, names)
        d["part"] = {"id": str(p.id), "name": p.name, "part_number": p.part_number, "unit": p.unit}
        out.append(d)
    order = {pid: i for i, pid in enumerate(ids)}
    out.sort(key=lambda d: (order[uuid.UUID(d["part"]["id"])], d["location"]["name"] if d["location"] else ""))
    return out


# ---------------------------------------------------------------- detail
def part_detail(m: Membership, p: Part) -> dict[str, Any]:
    from mpro.assets.models import Asset
    from mpro.core.files import file_dict, links_for
    from mpro.qr.services import codes_for
    from mpro.vendors.models import Vendor

    org_id = m.org_id
    show_cost = can(m, "costs.view")
    d = summaries(m, [p])[0]
    sts = list(db.session.scalars(select(PartStock).where(PartStock.part_id == p.id)).all())
    names = _loc_names([s.location_id for s in sts])
    trig = svc.settings(org_id)["restock_trigger"]
    stock = sorted(
        (stock_dict(org_id, s, trig, names) for s in sts), key=lambda x: x["location"]["name"] if x["location"] else ""
    )
    vendors = [
        {
            "vendor": {"id": str(v.id), "name": v.name, "color": v.color},
            "vendor_part_number": pv.vendor_part_number,
            "unit_cost": money(pv.unit_cost) if show_cost and pv.unit_cost is not None else None,
            "lead_time_days": pv.lead_time_days,
            "preferred": pv.preferred,
        }
        for pv, v in db.session.execute(
            select(PartVendor, Vendor)
            .join(Vendor, Vendor.id == PartVendor.vendor_id)
            .where(PartVendor.part_id == p.id, Vendor.deleted_at.is_(None))
            .order_by(PartVendor.preferred.desc(), Vendor.name)
        ).all()
    ]
    assets = [
        {"id": str(a.id), "name": a.name, "auto": pa.auto}
        for pa, a in db.session.execute(
            select(PartAsset, Asset)
            .join(Asset, Asset.id == PartAsset.asset_id)
            .where(PartAsset.part_id == p.id, Asset.deleted_at.is_(None))
            .order_by(Asset.name)
        ).all()
    ]
    teams = [
        {"id": str(t.id), "name": t.name, "color": t.color}
        for t in db.session.scalars(
            select(Team).join(PartTeam, PartTeam.team_id == Team.id).where(PartTeam.part_id == p.id).order_by(Team.name)
        ).all()
    ]
    preferred: dict[str, Any] | None = next((v for v in vendors if v["preferred"]), vendors[0] if vendors else None)
    # "Order this part" (r217): the first location that needs restocking, else the first one
    target = next((s for s in stock if s["needs_restock"]), stock[0] if stock else None)
    order_qty = target["restock_quantity"] if target and target["restock_quantity"] not in (None, "0") else "1"
    d.update(
        {
            "description": p.description,
            "manufacturer": p.manufacturer,
            "mpn": p.mpn,
            "lead_time_days": p.lead_time_days,
            "custom": p.custom or {},
            "stock": stock,
            "vendors": vendors,
            "assets": assets,
            "teams": teams,
            "assigned": q(svc.assigned_in_window(org_id, p.id)),
            "order_link": f"/purchase-orders?new=1&part_id={p.id}"
            + (f"&vendor_id={preferred['vendor']['id']}" if preferred else "")
            + f"&quantity={order_qty}",
            "picture_file_id": str(p.picture_file_id) if p.picture_file_id else None,
            "picture": _picture(p.picture_file_id),
            "files": [file_dict(link.file, link.role, link.id) for link in links_for("part", p.id)],
            "codes": codes_for(org_id, "part", p.id),
            "value": str(((p.on_hand or ZERO) * (p.unit_cost or ZERO)).quantize(Decimal("0.01")))
            if show_cost and not p.non_stock
            else None,
            "open_work_orders": open_work_orders(m, p.id),
            "created_at": iso(p.created_at),
        }
    )
    return d


def open_work_orders(m: Membership, part_id: uuid.UUID, limit: int = 50) -> list[dict[str, Any]]:
    from mpro.workorders.services import visibility_filter

    rows = db.session.execute(
        select(WorkOrderPart, WorkOrder)
        .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
        .where(
            WorkOrderPart.part_id == part_id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.not_in(("done", "canceled")),
            WorkOrderPart.status.not_in(("issued", "released")),
            visibility_filter(m),
        )
        .order_by(WorkOrder.due_at.is_(None), WorkOrder.due_at)
        .limit(limit)
    ).all()
    return [
        {
            "id": str(wo.id),
            "number": wo.number,
            "title": wo.title,
            "status": wo.status,
            "due_at": iso(wo.due_at),
            "quantity": q(wp.quantity - (wp.used or ZERO)),
            "part_status": wp.status,
            "part_status_label": svc.STATUS_LABELS.get(wp.status, wp.status),
        }
        for wp, wo in rows
    ]


# ---------------------------------------------------------------- transaction log (r223), cursor pagination
def _cursor(at: datetime, tid: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(json.dumps([at.isoformat(), str(tid)]).encode()).decode()


def _uncursor(c: str) -> tuple[datetime, uuid.UUID]:
    try:
        at, tid = json.loads(base64.urlsafe_b64decode(c.encode()))
        return datetime.fromisoformat(at), uuid.UUID(tid)
    except Exception as e:  # noqa: BLE001
        raise RuleError("That page link isn't valid.", 422) from e


def txn_query(m: Membership, params: dict[str, Any]) -> Select[Any]:
    """Filters: part_id, location_id, kind (comma separated), work_order_id, purchase_order_id, from, to (ISO)."""
    from mpro.workorders.services import _dt

    qy = select(InventoryTransaction).where(InventoryTransaction.org_id == m.org_id)
    if params.get("part_id"):
        qy = qy.where(InventoryTransaction.part_id == _uid(params["part_id"], "part"))
    if params.get("location_id"):
        loc = params["location_id"]
        qy = qy.where(
            InventoryTransaction.location_id.is_(None)
            if loc == "none"
            else InventoryTransaction.location_id == _uid(loc, "location")
        )
    if params.get("kind"):
        kinds = [k for k in str(params["kind"]).split(",") if k]
        if any(k not in KIND_LABELS for k in kinds):
            raise RuleError("Unknown transaction type.", 422)
        qy = qy.where(InventoryTransaction.kind.in_(kinds))
    if params.get("work_order_id"):
        qy = qy.where(InventoryTransaction.work_order_id == _uid(params["work_order_id"], "work order"))
    if params.get("purchase_order_id"):
        qy = qy.where(InventoryTransaction.purchase_order_id == _uid(params["purchase_order_id"], "purchase order"))
    if params.get("from"):
        qy = qy.where(InventoryTransaction.at >= _dt(params["from"], "from"))
    if params.get("to"):
        qy = qy.where(InventoryTransaction.at < _dt(params["to"], "to"))
    return qy


def transactions(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    qy = txn_query(m, params)
    try:
        limit = max(1, min(int(params.get("limit") or 50), 200))
    except ValueError as e:
        raise RuleError("limit must be a number.", 422) from e
    if params.get("cursor"):
        at, tid = _uncursor(str(params["cursor"]))
        qy = qy.where(
            or_(InventoryTransaction.at < at, and_(InventoryTransaction.at == at, InventoryTransaction.id < tid))
        )
    rows = list(
        db.session.scalars(
            qy.order_by(InventoryTransaction.at.desc(), InventoryTransaction.id.desc()).limit(limit + 1)
        ).all()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": txn_dicts(m, rows), "next_cursor": _cursor(rows[-1].at, rows[-1].id) if more and rows else None}


def txn_dicts(m: Membership, rows: list[InventoryTransaction]) -> list[dict[str, Any]]:
    from mpro.auth.models import User
    from mpro.workorders.services import can_see

    show_cost = can(m, "costs.view")
    parts = (
        {p.id: p for p in db.session.scalars(select(Part).where(Part.id.in_({r.part_id for r in rows}))).all()}
        if rows
        else {}
    )
    users = (
        dict(
            db.session.execute(
                select(User.id, User.name).where(User.id.in_({r.user_id for r in rows if r.user_id}))
            ).all()
        )
        if rows
        else {}
    )
    names = _loc_names([r.location_id for r in rows])
    wos = (
        {
            w.id: w
            for w in db.session.scalars(
                select(WorkOrder).where(WorkOrder.id.in_({r.work_order_id for r in rows if r.work_order_id}))
            ).all()
        }
        if rows
        else {}
    )
    out = []
    for r in rows:
        p = parts.get(r.part_id)
        wo = wos.get(r.work_order_id) if r.work_order_id else None
        out.append(
            {
                "id": str(r.id),
                "at": iso(r.at),
                "kind": r.kind,
                "kind_label": KIND_LABELS.get(r.kind, r.kind),
                "direction": "in" if r.quantity > 0 else "out" if r.quantity < 0 else "none",
                "quantity": q(r.quantity),
                "before": q(r.before),
                "after": q(r.after),
                "unit_cost": money(r.unit_cost) if show_cost and r.unit_cost is not None else None,
                "part": {"id": str(p.id), "name": p.name, "part_number": p.part_number, "unit": p.unit} if p else None,
                "location": {"id": str(r.location_id), "name": names.get(r.location_id, "")} if r.location_id else None,
                "note": r.note,
                "user": users.get(r.user_id) if r.user_id else None,
                "work_order": {"id": str(wo.id), "number": wo.number, "title": wo.title}
                if wo is not None and can_see(m, wo)
                else None,
                "purchase_order_id": str(r.purchase_order_id) if r.purchase_order_id else None,
                "file_ids": r.file_ids or [],
            }
        )
    return out


# ---------------------------------------------------------------- work-order parts
def work_order_parts(m: Membership, wo: WorkOrder) -> dict[str, Any]:
    show_cost = can(m, "costs.view")
    rows = db.session.execute(
        select(WorkOrderPart, Part)
        .join(Part, Part.id == WorkOrderPart.part_id)
        .where(WorkOrderPart.work_order_id == wo.id)
        .order_by(WorkOrderPart.created_at)
    ).all()
    names = _loc_names([wp.location_id for wp, _p in rows])
    items = []
    total = ZERO
    for wp, p in rows:
        cost = wp.unit_cost_override if wp.unit_cost_override is not None else (p.unit_cost or ZERO)
        line = ((wp.used if wp.status == "issued" else wp.quantity) or ZERO) * cost
        total += line
        items.append(
            {
                "id": str(wp.id),
                "part": {
                    "id": str(p.id),
                    "name": p.name,
                    "part_number": p.part_number,
                    "unit": p.unit,
                    "non_stock": p.non_stock,
                    "deleted": p.deleted_at is not None,
                    "picture": _picture(p.picture_file_id),
                },
                "location": {"id": str(wp.location_id), "name": names.get(wp.location_id, "")}
                if wp.location_id
                else None,
                "quantity": q(wp.quantity),
                "used": q(wp.used),
                "shortfall": q(wp.shortfall or ZERO),
                "status": wp.status,
                "status_label": svc.STATUS_LABELS.get(wp.status, wp.status),
                "unit_cost": money(cost) if show_cost else None,
                "unit_cost_override": money(wp.unit_cost_override)
                if show_cost and wp.unit_cost_override is not None
                else None,
                "line_cost": str(line.quantize(Decimal("0.01"))) if show_cost else None,
                "note": wp.note,
                "availability": svc.availability(m.org_id, wp, p),
            }
        )
    return {
        "items": items,
        "total_cost": str(total.quantize(Decimal("0.01"))) if show_cost else None,
        "costs_visible": show_cost,
    }


# ---------------------------------------------------------------- CSV reports (r223, r248)
def _safe(v: Any) -> str:
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def _csv(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow([_safe(x) for x in r])
    return buf.getvalue().encode("utf-8-sig")


def parts_csv(m: Membership, params: dict[str, Any]) -> bytes:
    rows = list(db.session.scalars(apply_sort(part_query(m, params), params.get("sort")).limit(50000)).all())
    show_cost = can(m, "costs.view")
    data = summaries(m, rows)
    return _csv(
        [
            "Name",
            "Part number",
            "Description",
            "Unit",
            "In stock",
            "Reserved",
            "Available",
            "Ordered",
            "Minimum",
            "Maximum",
            "Unit cost",
            "Types",
            "Barcode",
            "Needs restock",
            "Non-stock",
        ],
        [
            [
                d["name"],
                d["part_number"],
                d["description"],
                d["unit"],
                d["on_hand"],
                d["reserved"],
                d["available"],
                d["ordered"],
                d["min_qty"],
                d["max_qty"],
                d["unit_cost"] if show_cost else "",
                ", ".join(t["name"] for t in d["types"]),
                d["barcode"],
                "Yes" if d["needs_restock"] else "",
                "Yes" if d["non_stock"] else "",
            ]
            for d in data
        ],
    )


def transactions_csv(m: Membership, params: dict[str, Any]) -> bytes:
    rows = list(db.session.scalars(txn_query(m, params).order_by(InventoryTransaction.at.desc()).limit(100000)).all())
    data = txn_dicts(m, rows)
    return _csv(
        [
            "Date",
            "Part",
            "Part number",
            "Location",
            "Type",
            "Direction",
            "Change",
            "Before",
            "After",
            "Unit cost",
            "Work order",
            "Note",
            "By",
        ],
        [
            [
                d["at"],
                d["part"]["name"] if d["part"] else "",
                d["part"]["part_number"] if d["part"] else "",
                d["location"]["name"] if d["location"] else "",
                d["kind_label"],
                d["direction"],
                d["quantity"],
                d["before"],
                d["after"],
                d["unit_cost"] or "",
                f"#{d['work_order']['number']}" if d["work_order"] else "",
                d["note"],
                d["user"] or "",
            ]
            for d in data
        ],
    )


def valuation_csv(m: Membership, params: dict[str, Any]) -> bytes:
    """Inventory value per part and location: on hand × unit cost (r248)."""
    if not can(m, "costs.view"):
        raise RuleError("You don't have permission to see costs.", 403)
    parts = {p.id: p for p in db.session.scalars(part_query(m, {**params, "non_stock": "0"})).all()}
    sts = db.session.scalars(select(PartStock).where(PartStock.part_id.in_(list(parts)))).all() if parts else []
    names = _loc_names([s.location_id for s in sts])
    rows = []
    total = ZERO
    for st in sorted(
        sts, key=lambda s: (parts[s.part_id].name.lower(), names.get(s.location_id, "") if s.location_id else "")
    ):
        p = parts[st.part_id]
        value = (st.on_hand or ZERO) * (p.unit_cost or ZERO)
        total += value
        rows.append(
            [
                p.name,
                p.part_number,
                names.get(st.location_id, "") if st.location_id else "",
                st.area,
                q(st.on_hand),
                p.unit,
                money(p.unit_cost),
                str(value.quantize(Decimal("0.01"))),
            ]
        )
    rows.append(["Total", "", "", "", "", "", "", str(total.quantize(Decimal("0.01")))])
    return _csv(["Part", "Part number", "Location", "Area", "In stock", "Unit", "Unit cost", "Value"], rows)


def slow_moving_csv(m: Membership, params: dict[str, Any]) -> bytes:
    """Stocked parts not used in the last N days (default 180) (r248)."""
    try:
        days = max(1, min(int(params.get("days") or 180), 3650))
    except ValueError as e:
        raise RuleError("days must be a number.", 422) from e
    since = utcnow() - timedelta(days=days)
    last_use = dict(
        db.session.execute(
            select(InventoryTransaction.part_id, func.max(InventoryTransaction.at))
            .where(InventoryTransaction.org_id == m.org_id, InventoryTransaction.kind == "use")
            .group_by(InventoryTransaction.part_id)
        ).all()
    )
    show_cost = can(m, "costs.view")
    rows = []
    for p in db.session.scalars(part_query(m, {**params, "non_stock": "0"}).order_by(func.lower(Part.name))).all():
        last = last_use.get(p.id)
        if (p.on_hand or ZERO) <= ZERO or (
            last is not None and last.replace(tzinfo=last.tzinfo or since.tzinfo) >= since
        ):
            continue
        value = (p.on_hand or ZERO) * (p.unit_cost or ZERO)
        rows.append(
            [
                p.name,
                p.part_number,
                q(p.on_hand),
                p.unit,
                iso(last) or "Never",
                str(value.quantize(Decimal("0.01"))) if show_cost else "",
            ]
        )
    return _csv(["Part", "Part number", "In stock", "Unit", "Last used", "Value"], rows)
