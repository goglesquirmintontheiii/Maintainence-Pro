"""Locations and assets REST API (/api/v1)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, or_, select

from mpro.assets import queries as qry
from mpro.assets import services as svc
from mpro.assets.models import (
    ASSET_STATUS_LABELS,
    CRITICALITY_LABELS,
    DISPOSAL_METHODS,
    Asset,
    AssetType,
    FloorPlan,
    FloorPlanPin,
    Location,
)
from mpro.core.events import DomainEvent
from mpro.core.files import FileError, exporter, register_entity, request_export
from mpro.core.models import iso
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError

bp = APIBlueprint("assets", __name__, url_prefix="/api/v1", tag="Assets and locations")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _params() -> dict[str, Any]:
    return dict(request.args.items())


def _asset(aid: str, include_deleted: bool = False) -> Asset:
    try:
        uid = uuid.UUID(aid)
    except ValueError:
        abort(404)
    a = db.session.scalars(scoped(Asset, include_deleted=include_deleted).where(Asset.id == uid)).first()
    if a is None:
        abort(404)
    return a


def _location(lid: str, include_deleted: bool = False) -> Location:
    try:
        uid = uuid.UUID(lid)
    except ValueError:
        abort(404)
    loc = db.session.scalars(scoped(Location, include_deleted=include_deleted).where(Location.id == uid)).first()
    if loc is None:
        abort(404)
    return loc


def _version() -> int | None:
    import re

    m = re.search(r"\d+", request.headers.get("If-Match", ""))
    if m:
        return int(m.group())
    v = body().get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _history(entity_type: str, entity_id: uuid.UUID, limit: int = 200) -> list[dict[str, Any]]:
    """The record's audit trail (MaintainX History tab)."""
    rows = db.session.scalars(
        select(DomainEvent)
        .where(
            DomainEvent.org_id == g.org.id,
            DomainEvent.entity_type == entity_type,
            DomainEvent.entity_id == str(entity_id),
        )
        .order_by(DomainEvent.created_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(e.id),
            "type": e.type,
            "summary": e.summary,
            "actor": e.actor_label,
            "changes": e.changes or {},
            "at": iso(e.created_at),
        }
        for e in rows
    ]


# ---- locations -------------------------------------------------------------------------------
@bp.get("/locations")
@require("locations.view")
def list_locations() -> dict[str, Any]:
    """Query: q, parent_id (`root` for top level), within (a location id: it and everything under it), sort,
    page, per_page."""
    return guard(qry.location_list, g.membership, _params())


@bp.post("/locations")
@require("locations.manage")
def create_location() -> tuple[dict[str, Any], int]:
    """{name, description, parent_id, address_line1, address_line2, city, region, postal_code, country, latitude,
    longitude, teams: [ids], custom: {}, file_ids: []}"""
    loc = guard(svc.create_location, g.org, g.membership, body())
    return qry.location_detail(g.membership, loc), 201


@bp.get("/locations/<lid>")
@require("locations.view")
def get_location(lid: str) -> dict[str, Any]:
    return qry.location_detail(g.membership, _location(lid, include_deleted=True))


@bp.patch("/locations/<lid>")
@require("locations.manage")
def patch_location(lid: str) -> dict[str, Any]:
    loc = guard(svc.update_location, g.org, g.membership, _location(lid), body())
    return qry.location_detail(g.membership, loc)


@bp.delete("/locations/<lid>")
@require("locations.delete")
def delete_location(lid: str) -> tuple[str, int]:
    guard(svc.delete_location, g.org, g.membership, _location(lid))
    return "", 204


@bp.post("/locations/<lid>/restore")
@require("locations.delete")
def restore_location(lid: str) -> dict[str, Any]:
    loc = _location(lid, include_deleted=True)
    guard(svc.restore_location, g.org, loc)
    return qry.location_detail(g.membership, loc)


@bp.get("/locations/<lid>/history")
@require("locations.view")
def location_history(lid: str) -> dict[str, Any]:
    return {"items": _history("location", _location(lid, include_deleted=True).id)}


@bp.post("/locations/<lid>/floor-plans")
@require("locations.manage")
def add_floor_plan(lid: str) -> tuple[dict[str, Any], int]:
    """{name, file_id} — upload the image with POST /files first."""
    b = body()
    fp = guard(svc.add_floor_plan, g.org, g.membership, _location(lid), str(b.get("name") or ""), b.get("file_id"))
    return {"id": str(fp.id), "name": fp.name}, 201


def _plan(lid: str, pid: str) -> FloorPlan:
    loc = _location(lid)
    fp = get_scoped(FloorPlan, pid)
    if fp.location_id != loc.id:
        abort(404)
    return fp


@bp.patch("/locations/<lid>/floor-plans/<pid>")
@require("locations.manage")
def patch_floor_plan(lid: str, pid: str) -> dict[str, Any]:
    fp = _plan(lid, pid)
    b = body()
    if "name" in b:
        name = str(b["name"] or "").strip()[:120]
        if not name:
            abort(422, message="The floor plan needs a name.")
        if name != fp.name:
            from mpro.core.events import emit

            emit(
                "location.floor_plan_renamed",
                entity_type="location",
                entity_id=fp.location_id,
                entity_label=name,
                summary=f"Renamed floor plan {fp.name} to {name}",
            )
        fp.name = name
    if "sort" in b and isinstance(b["sort"], int):
        fp.sort = b["sort"]
    db.session.commit()
    return {"id": str(fp.id), "name": fp.name}


@bp.delete("/locations/<lid>/floor-plans/<pid>")
@require("locations.manage")
def delete_floor_plan(lid: str, pid: str) -> tuple[str, int]:
    from mpro.core.events import emit
    from mpro.core.models import utcnow

    fp = _plan(lid, pid)
    fp.deleted_at = utcnow()
    emit(
        "location.floor_plan_removed",
        entity_type="location",
        entity_id=fp.location_id,
        entity_label=fp.name,
        summary=f"Removed floor plan {fp.name}",
    )
    db.session.commit()
    return "", 204


@bp.post("/locations/<lid>/floor-plans/<pid>/pins")
@require("locations.manage")
def add_pin(lid: str, pid: str) -> tuple[dict[str, Any], int]:
    """{x, y (fractions 0–1 of the image), asset_id?, label?}"""
    pin = guard(svc.set_pin, g.org, _plan(lid, pid), body())
    return {"id": str(pin.id)}, 201


@bp.patch("/locations/<lid>/floor-plans/<pid>/pins/<pin_id>")
@require("locations.manage")
def move_pin(lid: str, pid: str, pin_id: str) -> dict[str, Any]:
    fp = _plan(lid, pid)
    pin = get_scoped(FloorPlanPin, pin_id)
    if pin.floor_plan_id != fp.id:
        abort(404)
    guard(svc.set_pin, g.org, fp, body(), pin)
    return {"id": str(pin.id)}


@bp.delete("/locations/<lid>/floor-plans/<pid>/pins/<pin_id>")
@require("locations.manage")
def delete_pin(lid: str, pid: str, pin_id: str) -> tuple[str, int]:
    fp = _plan(lid, pid)
    pin = get_scoped(FloorPlanPin, pin_id)
    if pin.floor_plan_id != fp.id:
        abort(404)
    from mpro.core.events import emit

    emit(
        "location.pin_removed",
        entity_type="location",
        entity_id=fp.location_id,
        entity_label=fp.name,
        summary=f"Removed pin {pin.label or ''} from {fp.name}".replace("  ", " "),
    )
    db.session.delete(pin)
    db.session.commit()
    return "", 204


# ---- assets ----------------------------------------------------------------------------------
@bp.get("/assets")
@require("assets.view")
def list_assets() -> dict[str, Any]:
    """Query: q, status (online,offline,do_not_track), criticality, parent_id (`root`), within (an asset id),
    location_id
    (includes sub-locations; `none`), type_id, manufacturer, warranty (active|expired), warranty_expiring_days, label
    (none|has), include_deleted, sort (name, status, criticality, updated_at, warranty_end, …; `-` for descending)."""
    return guard(qry.asset_list, g.membership, _params())


@bp.get("/assets/options")
@require("assets.view")
def asset_options() -> dict[str, Any]:
    from mpro.meters.models import UNITS
    from mpro.workorders.services import custom_field_dict, custom_fields

    types = db.session.scalars(scoped(AssetType).order_by(func.lower(AssetType.name))).all()
    s = svc.asset_settings(g.org.id)
    return {
        "statuses": [
            {"id": k, "label": v, "reasons": s["status_reasons"].get(k, [])} for k, v in ASSET_STATUS_LABELS.items()
        ],
        "criticality": [{"id": k, "label": v} for k, v in CRITICALITY_LABELS.items()],
        "disposal_methods": [m for m in DISPOSAL_METHODS if m],
        "types": [{"id": str(t.id), "name": t.name, "color": t.color} for t in types],
        "custom_fields": [custom_field_dict(f) for f in custom_fields(g.org.id, "asset")],
        "location_custom_fields": [custom_field_dict(f) for f in custom_fields(g.org.id, "location")],
        "units": UNITS,
        "settings": s,
        "can": {k: can(g.membership, f"assets.{k}") for k in ("manage", "status", "delete", "financials", "settings")},
    }


@bp.post("/assets")
@require("assets.manage")
def create_asset() -> tuple[dict[str, Any], int]:
    """{name, description, parent_id, location_id, criticality, manufacturer, model, serial_number, year, barcode,
    types,
    teams, custom, status, file_ids, lifecycle/warranty fields; financial fields need assets.financials}"""
    a = guard(svc.create_asset, g.org, g.membership, body())
    return qry.asset_detail(g.membership, a), 201


@bp.get("/assets/<aid>")
@require("assets.view")
def get_asset(aid: str) -> dict[str, Any]:
    return qry.asset_detail(g.membership, _asset(aid, include_deleted=True))


@bp.patch("/assets/<aid>")
@require("assets.manage")
def patch_asset(aid: str) -> dict[str, Any]:
    b = body()
    a = guard(
        svc.update_asset, g.org, g.membership, _asset(aid), {k: v for k, v in b.items() if k != "version"}, _version()
    )
    return qry.asset_detail(g.membership, a)


@bp.delete("/assets/<aid>")
@require("assets.delete")
def delete_asset(aid: str) -> tuple[str, int]:
    guard(svc.delete_asset, g.org, g.membership, _asset(aid))
    return "", 204


@bp.post("/assets/<aid>/restore")
@require("assets.delete")
def restore_asset(aid: str) -> dict[str, Any]:
    a = _asset(aid, include_deleted=True)
    guard(svc.restore_asset, g.org, a)
    return qry.asset_detail(g.membership, a)


@bp.post("/assets/<aid>/duplicate")
@require("assets.manage")
def duplicate_asset(aid: str) -> tuple[dict[str, Any], int]:
    a = guard(svc.duplicate_asset, g.org, g.membership, _asset(aid))
    return qry.asset_detail(g.membership, a), 201


@bp.post("/assets/<aid>/status")
@require("assets.status")
def asset_status(aid: str) -> dict[str, Any]:
    """{status: online|offline|do_not_track, reason, downtime_type: planned|unplanned, note, apply_to_children, at}"""
    from mpro.workorders.services import _dt

    b = body()
    a = _asset(aid)
    at = guard(_dt, b.get("at"), "Time") if b.get("at") else None
    guard(
        svc.set_status,
        g.org,
        g.membership,
        a,
        str(b.get("status") or ""),
        reason=str(b.get("reason") or ""),
        downtime_type=str(b.get("downtime_type") or ""),
        note=str(b.get("note") or ""),
        apply_to_children=bool(b.get("apply_to_children")),
        at=at,
    )
    return qry.asset_detail(g.membership, a)


@bp.get("/assets/<aid>/status-history")
@require("assets.view")
def asset_status_history(aid: str) -> dict[str, Any]:
    return {"items": qry.status_history(_asset(aid, include_deleted=True))}


@bp.get("/assets/<aid>/downtime")
@require("assets.view")
def asset_downtime(aid: str) -> dict[str, Any]:
    """Query: days (default 30, max 730)."""
    a = _asset(aid, include_deleted=True)
    try:
        days = max(1, min(int(request.args.get("days") or 30), 730))
    except ValueError:
        abort(422, message="days must be a number.")
    now = datetime.now(UTC)
    return svc.downtime(a.id, now - timedelta(days=days), now)


@bp.get("/assets/<aid>/insights")
@require("assets.view")
def asset_insights(aid: str) -> dict[str, Any]:
    """Query: days (7–730, default 90), children (1 to include sub-assets, default 1)."""
    try:
        days = int(request.args.get("days") or 90)
    except ValueError:
        abort(422, message="days must be a number.")
    return qry.insights(g.membership, _asset(aid, include_deleted=True), days, request.args.get("children", "1") == "1")


@bp.get("/assets/<aid>/history")
@require("assets.view")
def asset_history(aid: str) -> dict[str, Any]:
    return {"items": _history("asset", _asset(aid, include_deleted=True).id)}


@bp.get("/assets/<aid>/work-orders")
@require("wo.view")
def asset_work_orders(aid: str) -> dict[str, Any]:
    """Work orders on this asset (and its sub-assets with children=1). Query: tab (open|done|all), page."""
    from mpro.workorders.queries import list_page

    a = _asset(aid, include_deleted=True)
    op = "within" if request.args.get("children") == "1" else "in"
    tab = request.args.get("tab") or "all"
    filters: list[dict[str, Any]] = [{"field": "asset", "op": op, "value": [str(a.id)]}]
    if tab == "open":
        filters.append({"field": "status", "op": "in", "value": ["open", "in_progress", "on_hold"]})
    elif tab == "done":
        filters.append({"field": "status", "op": "in", "value": ["done", "canceled"]})
    return guard(
        list_page,
        g.membership,
        {
            "tab": "all",
            "filters": filters,
            "sort": "-created_at",
            "page": request.args.get("page") or 1,
            "per_page": request.args.get("per_page") or 25,
        },
    )


@bp.get("/assets/<aid>/photos")
@require("assets.view")
def asset_photos(aid: str) -> dict[str, Any]:
    """Condition photo timeline (r591): every photo of the asset, from its own files, its work orders and their
    comments, newest first."""
    from mpro.core.files import FileLink, FileObject, file_dict
    from mpro.workorders.models import Comment, WorkOrder
    from mpro.workorders.services import visibility_filter

    a = _asset(aid, include_deleted=True)
    wo_rows = (
        db.session.execute(
            select(WorkOrder.id, WorkOrder.number, WorkOrder.title).where(
                WorkOrder.asset_id == a.id, WorkOrder.deleted_at.is_(None), visibility_filter(g.membership)
            )
        ).all()
        if can(g.membership, "wo.view")
        else []
    )
    wos = {r[0]: r for r in wo_rows}
    comment_wo = (
        dict(
            db.session.execute(
                select(Comment.id, Comment.entity_id).where(
                    Comment.entity_id.in_(list(wos)), Comment.deleted_at.is_(None)
                )
            ).all()
        )
        if wos
        else {}
    )
    conds = [(FileLink.entity_type == "asset") & (FileLink.entity_id == a.id)]
    if wos:
        conds.append((FileLink.entity_type == "work_order") & FileLink.entity_id.in_(list(wos)))
    if comment_wo:
        conds.append((FileLink.entity_type == "comment") & FileLink.entity_id.in_(list(comment_wo)))
    links = db.session.scalars(
        select(FileLink)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(or_(*conds), FileObject.deleted_at.is_(None), FileLink.role != "signature")
        .order_by(FileObject.created_at.desc())
        .limit(500)
    ).all()
    out = []
    for lk in links:
        if not lk.file.is_image:
            continue
        src: dict[str, Any] = {"type": "asset"}
        wid = (
            lk.entity_id
            if lk.entity_type == "work_order"
            else comment_wo.get(lk.entity_id)
            if lk.entity_type == "comment"
            else None
        )
        if wid is not None and wid in wos:
            src = {"type": lk.entity_type, "work_order": {"id": str(wid), "number": wos[wid][1], "title": wos[wid][2]}}
        out.append({**file_dict(lk.file, lk.role, lk.id), "taken_at": iso(lk.file.created_at), "source": src})
    return {"items": out}


@bp.post("/assets/bulk")
@require("assets.manage")
def bulk_assets() -> dict[str, Any]:
    """{ids: [...] (≤500), action: edit|status|delete|restore, patch: {...}} — edit patches location_id, parent_id,
    criticality, types, manufacturer, model, teams; status takes {status, reason, downtime_type, note}."""
    b = body()
    ids = b.get("ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500:
        abort(422, message="Pick 1 to 500 assets.")
    action = b.get("action")
    patch = b.get("patch") or {}
    if not isinstance(patch, dict):
        abort(422, message="patch must be an object.")
    need = {
        "edit": "assets.manage",
        "status": "assets.status",
        "delete": "assets.delete",
        "restore": "assets.delete",
    }.get(str(action))
    if need is None:
        abort(422, message="Action is edit, status, delete or restore.")
    if not can(g.membership, need):
        abort(403, message="You don't have permission to do that.")
    allowed = {"location_id", "parent_id", "criticality", "types", "manufacturer", "model", "teams"}
    if action == "edit" and (not patch or set(patch) - allowed):
        abort(422, message="Bulk edit can change " + ", ".join(sorted(allowed)) + ".")
    assets = [_asset(str(i), include_deleted=action == "restore") for i in ids]
    done, failed = [], []
    for a in assets:
        try:
            if action == "edit":
                svc.update_asset(g.org, g.membership, a, patch)
            elif action == "status":
                svc.set_status(
                    g.org,
                    g.membership,
                    a,
                    str(patch.get("status") or ""),
                    reason=str(patch.get("reason") or ""),
                    downtime_type=str(patch.get("downtime_type") or ""),
                    note=str(patch.get("note") or ""),
                )
            elif action == "delete":
                svc.delete_asset(g.org, g.membership, a)
            else:
                svc.restore_asset(g.org, a)
            done.append(str(a.id))
        except RuleError as e:
            db.session.rollback()
            failed.append({"id": str(a.id), "name": a.name, "message": e.message})
    return {"done": done, "failed": failed}


@bp.post("/assets/export")
@require("assets.view")
def export_assets() -> tuple[dict[str, Any], int]:
    """CSV of assets to the Download Center: {query: {same params as GET /assets}}."""
    from mpro.core.files import export_dict

    if not can(g.membership, "exports.use"):
        abort(403, message="You don't have permission to export.")
    q = body().get("query") or {}
    if not isinstance(q, dict):
        abort(422, message="query must be an object.")
    q = {k: str(v) for k, v in q.items() if k not in ("page", "per_page")}
    guard(qry.asset_query, g.membership, q)  # validate now, not in the job
    ex = guard(request_export, g.org.id, g.user.id, "assets.csv", "Assets (CSV)", {"query": q})
    db.session.commit()
    return export_dict(ex), 202


@exporter("assets.csv")
def _assets_csv(ex: Any) -> tuple[str, bytes, str]:
    from mpro.core.models import utcnow
    from mpro.workorders.exports import _member

    m, _org = _member(ex)
    if not can(m, "assets.view"):
        raise PermissionError("You no longer have access to assets.")
    return f"assets-{utcnow():%Y-%m-%d}.csv", qry.assets_csv(m, ex.params.get("query") or {}), "text/csv"


@bp.get("/assets/warranties")
@require("assets.view")
def expiring_warranties() -> dict[str, Any]:
    """Assets whose warranty ends within `days` (default 60)."""
    try:
        days = max(1, min(int(request.args.get("days") or 60), 3650))
    except ValueError:
        abort(422, message="days must be a number.")
    return {"items": qry.warranties_expiring(g.membership, days)}


# ---- asset types, catalog, settings ----------------------------------------------------------
@bp.get("/asset-types")
@require("assets.view")
def list_types() -> dict[str, Any]:
    from mpro.assets.models import AssetTypeLink

    types = db.session.scalars(scoped(AssetType).order_by(func.lower(AssetType.name))).all()
    usage = dict(
        db.session.execute(
            select(AssetTypeLink.type_id, func.count())
            .join(Asset, Asset.id == AssetTypeLink.asset_id)
            .where(AssetTypeLink.org_id == g.org.id, Asset.deleted_at.is_(None))
            .group_by(AssetTypeLink.type_id)
        ).all()
    )
    return {
        "items": [{"id": str(t.id), "name": t.name, "color": t.color, "usage": int(usage.get(t.id, 0))} for t in types]
    }


@bp.post("/asset-types")
@require("assets.settings")
def create_type() -> tuple[dict[str, Any], int]:
    t = guard(svc.save_asset_type, g.org, body())
    return {"id": str(t.id), "name": t.name, "color": t.color}, 201


@bp.patch("/asset-types/<tid>")
@require("assets.settings")
def patch_type(tid: str) -> dict[str, Any]:
    t = guard(svc.save_asset_type, g.org, body(), get_scoped(AssetType, tid))
    return {"id": str(t.id), "name": t.name, "color": t.color}


@bp.delete("/asset-types/<tid>")
@require("assets.settings")
def delete_type(tid: str) -> tuple[str, int]:
    svc.delete_asset_type(g.org, get_scoped(AssetType, tid))
    return "", 204


@bp.get("/asset-catalog")
@require("assets.view")
def get_catalog() -> dict[str, Any]:
    """Manufacturers (no query) or a manufacturer's models (?manufacturer=)."""
    return svc.catalog(g.org.id, request.args.get("manufacturer"))


@bp.post("/asset-catalog")
@require("assets.manage")
def add_catalog() -> tuple[dict[str, Any], int]:
    """{kind: manufacturer|model, name, parent (the manufacturer, for models)}"""
    b = body()
    guard(svc.add_catalog_entry, g.org, str(b.get("kind") or ""), str(b.get("name") or ""), str(b.get("parent") or ""))
    return {"ok": True}, 201


@bp.get("/assets/settings")
@require("assets.view")
def get_asset_settings() -> dict[str, Any]:
    return svc.asset_settings(g.org.id)


@bp.patch("/assets/settings")
@require("assets.settings")
def patch_asset_settings() -> dict[str, Any]:
    """{status_reasons: {online: [...], offline: [...], do_not_track: [...]}, max_depth (0 = unlimited),
    ask_status_on_work_orders}"""
    return guard(svc.update_settings, g.org, body())


# ---- search, files, QR targets ----------------------------------------------------------------
@provider("assets", "Assets", "assets.view")
def _search_assets(q: str, limit: int) -> list[dict[str, Any]]:
    pat = like(q)
    rows = db.session.scalars(
        scoped(Asset)
        .where(
            or_(
                func.lower(Asset.name).like(pat, escape="\\"),
                func.lower(Asset.serial_number).like(pat, escape="\\"),
                func.lower(Asset.model).like(pat, escape="\\"),
                func.lower(Asset.barcode).like(pat, escape="\\"),
            )
        )
        .order_by(func.lower(Asset.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(a.id),
            "title": a.name,
            "subtitle": " · ".join(
                x for x in (ASSET_STATUS_LABELS[a.status], a.location.name if a.location else "", a.serial_number) if x
            ),
            "url": f"/assets/{a.id}",
            "status": a.status,
        }
        for a in rows
    ]


@provider("locations", "Locations", "locations.view")
def _search_locations(q: str, limit: int) -> list[dict[str, Any]]:
    pat = like(q)
    rows = db.session.scalars(
        scoped(Location)
        .where(
            or_(
                func.lower(Location.name).like(pat, escape="\\"),
                func.lower(Location.address_line1).like(pat, escape="\\"),
                func.lower(Location.city).like(pat, escape="\\"),
            )
        )
        .order_by(func.lower(Location.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(x.id),
            "title": x.name,
            "subtitle": ", ".join(y for y in (x.address_line1, x.city) if y),
            "url": f"/locations/{x.id}",
        }
        for x in rows
    ]


def _visible(model: Any, perm: str, rid: uuid.UUID) -> Any:
    rec = db.session.get(model, rid)
    if rec is None or rec.org_id != g.org.id or rec.deleted_at is not None or not can(g.membership, perm):
        return None
    return rec


def _touch_asset(aid: uuid.UUID) -> None:
    a = db.session.get(Asset, aid)
    if a is not None:
        from mpro.core.models import utcnow

        a.updated_at = utcnow()


register_entity(
    "asset",
    lambda i: _visible(Asset, "assets.view", i) is not None,
    lambda i: _visible(Asset, "assets.manage", i) is not None,
    _touch_asset,
)
register_entity(
    "location",
    lambda i: _visible(Location, "locations.view", i) is not None,
    lambda i: _visible(Location, "locations.manage", i) is not None,
)


def _register_qr() -> None:
    from mpro.qr.services import register_target

    register_target("asset", Asset, lambda a: a.name, lambda a: f"/assets/{a.id}", "assets.view")
    register_target("location", Location, lambda x: x.name, lambda x: f"/locations/{x.id}", "locations.view")


_register_qr()
