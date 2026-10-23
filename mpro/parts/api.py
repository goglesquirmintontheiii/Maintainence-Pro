"""Parts and inventory REST API (/api/v1). Built in 0.5.0 (MP-039–041)."""

from __future__ import annotations

import re
import uuid
from datetime import timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, or_, select

from mpro.core.events import DomainEvent
from mpro.core.files import FileError, export_dict, exporter, register_entity, request_export
from mpro.core.models import iso
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.parts import counts as cc
from mpro.parts import queries as qry
from mpro.parts import services as svc
from mpro.parts.models import CycleCount, CycleCountRun, Part, PartType, WorkOrderPart
from mpro.workorders.models import SavedView, WorkOrder

bp = APIBlueprint("parts", __name__, url_prefix="/api/v1", tag="Parts")


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


def _part(pid: str, include_deleted: bool = False) -> Part:
    try:
        uid = uuid.UUID(pid)
    except ValueError:
        abort(404)
    p = db.session.scalars(scoped(Part, include_deleted=include_deleted).where(Part.id == uid)).first()
    if p is None:
        abort(404)
    return p


def _version() -> int | None:
    m = re.search(r"\d+", request.headers.get("If-Match", ""))
    if m:
        return int(m.group())
    v = body().get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _wo(wid: str) -> WorkOrder:
    from mpro.workorders.services import can_see

    wo = get_scoped(WorkOrder, wid)
    if not can_see(g.membership, wo):
        abort(404)
    return wo


def _wp(wo: WorkOrder, lid: str) -> WorkOrderPart:
    wp = get_scoped(WorkOrderPart, lid)
    if wp.work_order_id != wo.id:
        abort(404)
    return wp


def _need(action: str) -> None:
    if not can(g.membership, action):
        abort(403, message="You don't have permission to do that.")


# ---------------------------------------------------------------- parts
@bp.get("/parts")
@require("parts.view")
def list_parts() -> dict[str, Any]:
    """Query: q, stock (in_stock|needs_restock|out_of_stock), type_id, location_id (`none`), vendor_id, asset_id,
    team_id, critical=1, non_stock=0|1, ids, include_deleted=1, per_location=1 (adds one row per part and location),
    sort (name, part_number, on_hand, unit_cost, updated_at, created_at; `-` for descending), page, per_page."""
    return guard(qry.part_list, g.membership, _params())


@bp.get("/parts/options")
@require("parts.view")
def part_options() -> dict[str, Any]:
    types = db.session.scalars(scoped(PartType).order_by(func.lower(PartType.name))).all()
    units = [
        u
        for u in db.session.scalars(
            select(Part.unit).where(Part.org_id == g.org.id, Part.deleted_at.is_(None)).distinct().limit(100)
        ).all()
        if u
    ]
    return {
        "types": [{"id": str(t.id), "name": t.name, "color": t.color, "critical": t.critical} for t in types],
        "units": sorted(set(units) | {"each", "box", "pack", "pair", "set", "m", "ft", "l", "gal", "kg", "lb", "roll"}),
        "settings": svc.settings(g.org.id),
        "costs_visible": can(g.membership, "costs.view"),
    }


@bp.get("/parts/duplicates")
@require("parts.view")
def part_duplicates() -> dict[str, Any]:
    """Possible duplicates before saving (r237): ?name=&vendor_part_number=&barcode=&exclude=<part id>"""
    a = request.args
    exclude = None
    if a.get("exclude"):
        try:
            exclude = uuid.UUID(a["exclude"])
        except ValueError:
            abort(422, message="exclude must be a part id.")
    rows = svc.duplicates(g.org.id, a.get("name", ""), a.get("vendor_part_number", ""), a.get("barcode", ""), exclude)
    return {
        "items": [{"id": str(p.id), "name": p.name, "part_number": p.part_number, "barcode": p.barcode} for p in rows]
    }


@bp.post("/parts")
@require("parts.manage")
def create_part() -> tuple[dict[str, Any], int]:
    """{name, part_number, description, unit, unit_cost, barcode, lead_time_days, non_stock, manufacturer, mpn,
    picture_file_id, custom, type_ids, team_ids, asset_ids, vendors: [{vendor_id, vendor_part_number, unit_cost,
    lead_time_days, preferred}], stock: [{location_id, area, min_qty, max_qty, initial_quantity}]}"""
    b = body()
    if "unit_cost" in b and not can(g.membership, "costs.view"):
        b.pop("unit_cost")
    p = guard(svc.create_part, g.org, g.membership, b)
    return qry.part_detail(g.membership, p), 201


@bp.get("/parts/<pid>")
@require("parts.view")
def get_part(pid: str) -> dict[str, Any]:
    return qry.part_detail(g.membership, _part(pid, include_deleted=can(g.membership, "parts.delete")))


@bp.patch("/parts/<pid>")
@require("parts.manage")
def patch_part(pid: str) -> dict[str, Any]:
    version = _version()
    b = {k: v for k, v in body().items() if k != "version"}
    if "unit_cost" in b and not can(g.membership, "costs.view"):
        abort(403, message="You don't have permission to change costs.")
    p = guard(svc.update_part, g.org, g.membership, _part(pid), b, version)
    return qry.part_detail(g.membership, p)


@bp.delete("/parts/<pid>")
@require("parts.delete")
def delete_part(pid: str) -> tuple[str, int]:
    guard(svc.delete_part, g.org, _part(pid))
    return "", 204


@bp.post("/parts/<pid>/restore")
@require("parts.delete")
def restore_part(pid: str) -> dict[str, Any]:
    p = _part(pid, include_deleted=True)
    guard(svc.restore_part, g.org, p)
    return qry.part_detail(g.membership, p)


@bp.get("/parts/<pid>/history")
@require("parts.view")
def part_history(pid: str) -> dict[str, Any]:
    p = _part(pid, include_deleted=True)
    rows = db.session.scalars(
        select(DomainEvent)
        .where(DomainEvent.org_id == g.org.id, DomainEvent.entity_type == "part", DomainEvent.entity_id == str(p.id))
        .order_by(DomainEvent.created_at.desc())
        .limit(200)
    ).all()
    return {
        "items": [
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
    }


@bp.put("/parts/<pid>/stock")
@require("parts.manage")
def put_stock(pid: str) -> dict[str, Any]:
    """Add or change a stocking location: {location_id, area, min_qty, max_qty, initial_quantity}"""
    b = body()
    if b.get("initial_quantity") not in (None, "", 0, "0"):
        _need("parts.stock")
    p = _part(pid)
    guard(svc.set_stock_location, g.org, g.membership, p, b)
    return qry.part_detail(g.membership, p)


@bp.delete("/parts/<pid>/stock")
@require("parts.manage")
def delete_stock(pid: str) -> dict[str, Any]:
    """?location_id=<id> (or `none`)"""
    p = _part(pid)
    guard(svc.remove_stock_location, g.org, g.membership, p, request.args.get("location_id") or None)
    return qry.part_detail(g.membership, p)


@bp.post("/parts/<pid>/restock")
@require("parts.stock")
def restock(pid: str) -> dict[str, Any]:
    """{location_id, quantity, unit_cost, note, file_ids}"""
    b = body()
    if b.get("unit_cost") not in (None, "") and not can(g.membership, "costs.view"):
        b.pop("unit_cost")
    p = _part(pid)
    guard(svc.restock, g.org, g.membership, p, b)
    return qry.part_detail(g.membership, p)


@bp.post("/parts/<pid>/adjust")
@require("parts.stock")
def adjust(pid: str) -> dict[str, Any]:
    """{location_id, quantity (the new count) | change (+/-), note (needed when removing), file_ids}"""
    p = _part(pid)
    guard(svc.adjust, g.org, g.membership, p, body())
    return qry.part_detail(g.membership, p)


@bp.post("/parts/<pid>/transfer")
@require("parts.stock")
def transfer(pid: str) -> dict[str, Any]:
    """{from_location_id, to_location_id, quantity, note}"""
    p = _part(pid)
    guard(svc.move, g.org, g.membership, p, body())
    return qry.part_detail(g.membership, p)


@bp.get("/parts/transactions")
@require("parts.view")
def transactions() -> dict[str, Any]:
    """The transactions log (r223). Query: part_id, location_id, kind (comma separated), work_order_id,
    purchase_order_id, from, to, limit, cursor (from next_cursor)."""
    return guard(qry.transactions, g.membership, _params())


EXPORTS = {
    "parts": ("parts.csv", "Parts (CSV)"),
    "transactions": ("parts.transactions.csv", "Part transactions (CSV)"),
    "valuation": ("parts.valuation.csv", "Inventory valuation (CSV)"),
    "slow_moving": ("parts.slow_moving.csv", "Slow-moving parts (CSV)"),
}


@bp.post("/parts/export")
@require("parts.view")
def export_parts() -> tuple[dict[str, Any], int]:
    """{report: parts|transactions|valuation|slow_moving, query: {list or transaction filters; days for slow_moving}}"""
    _need("exports.use")
    b = body()
    report = str(b.get("report") or "parts")
    if report not in EXPORTS:
        abort(422, message="Pick a report: parts, transactions, valuation or slow_moving.")
    if report == "valuation":
        _need("costs.view")
    qp = b.get("query") or {}
    if not isinstance(qp, dict):
        abort(422, message="query must be an object.")
    qp = {k: str(v) for k, v in qp.items() if k not in ("page", "per_page", "cursor", "limit")}
    if report == "transactions":
        guard(qry.txn_query, g.membership, qp)
    else:
        guard(qry.part_query, g.membership, qp)
    kind, title = EXPORTS[report]
    ex = guard(request_export, g.org.id, g.user.id, kind, title, {"query": qp})
    db.session.commit()
    return export_dict(ex), 202


def _export(kind: str, fn: Any, perm: str = "parts.view") -> None:
    @exporter(kind)
    def _run(ex: Any) -> tuple[str, bytes, str]:
        from mpro.core.models import utcnow
        from mpro.workorders.exports import _member

        m, _org = _member(ex)
        if not can(m, perm):
            raise PermissionError("You no longer have access to this report.")
        return (
            f"{kind.replace('.csv', '').replace('.', '-')}-{utcnow():%Y-%m-%d}.csv",
            fn(m, ex.params.get("query") or {}),
            "text/csv",
        )


_export("parts.csv", qry.parts_csv)
_export("parts.transactions.csv", qry.transactions_csv)
_export("parts.valuation.csv", qry.valuation_csv, "costs.view")
_export("parts.slow_moving.csv", qry.slow_moving_csv)


# ---------------------------------------------------------------- settings and types
@bp.get("/parts/settings")
@require("parts.view")
def get_settings() -> dict[str, Any]:
    return svc.settings(g.org.id)


@bp.patch("/parts/settings")
@require("parts.settings")
def patch_settings() -> dict[str, Any]:
    """moving_average_cost, restock_trigger (in_stock|available), prevent_negative_ordered, allow_negative_stock,
    required_fields, escalation_team_ids, auto_reserve_days, assigned_window_days"""
    return guard(svc.update_settings, g.org, body())


@bp.get("/part-types")
@require("parts.view")
def list_types() -> dict[str, Any]:
    from mpro.parts.models import PartTypeLink

    usage = dict(
        db.session.execute(
            select(PartTypeLink.type_id, func.count())
            .join(Part, Part.id == PartTypeLink.part_id)
            .where(PartTypeLink.org_id == g.org.id, Part.deleted_at.is_(None))
            .group_by(PartTypeLink.type_id)
        ).all()
    )
    return {
        "items": [
            {
                "id": str(t.id),
                "name": t.name,
                "color": t.color,
                "critical": t.critical,
                "usage": int(usage.get(t.id, 0)),
            }
            for t in db.session.scalars(scoped(PartType).order_by(func.lower(PartType.name))).all()
        ]
    }


@bp.post("/part-types")
@require("parts.settings")
def create_type() -> tuple[dict[str, Any], int]:
    t = guard(svc.save_type, g.org, body())
    return {"id": str(t.id), "name": t.name, "color": t.color, "critical": t.critical}, 201


@bp.patch("/part-types/<tid>")
@require("parts.settings")
def patch_type(tid: str) -> dict[str, Any]:
    t = guard(svc.save_type, g.org, body(), get_scoped(PartType, tid))
    return {"id": str(t.id), "name": t.name, "color": t.color, "critical": t.critical}


@bp.delete("/part-types/<tid>")
@require("parts.settings")
def delete_type(tid: str) -> tuple[str, int]:
    svc.delete_type(g.org, get_scoped(PartType, tid))
    return "", 204


# ---------------------------------------------------------------- saved filters (r226)
def _preset_dict(v: SavedView) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "name": v.name,
        "filters": v.filters or {},
        "shared": v.owner_id is None,
        "pinned": v.pinned,
    }


@bp.get("/parts/presets")
@require("parts.view")
def list_presets() -> dict[str, Any]:
    return {"items": [_preset_dict(v) for v in svc.presets_for(g.membership)]}


@bp.post("/parts/presets")
@require("parts.view")
def create_preset() -> tuple[dict[str, Any], int]:
    """{name, filters: {q, stock, type_id, location_id, …}, shared, pinned}"""
    return _preset_dict(guard(svc.save_preset, g.org, g.membership, body())), 201


def _preset(vid: str) -> SavedView:
    v = get_scoped(SavedView, vid)
    if v.entity_type != "part" or v.owner_id not in (None, g.user.id):
        abort(404)
    return v


@bp.patch("/parts/presets/<vid>")
@require("parts.view")
def patch_preset(vid: str) -> dict[str, Any]:
    return _preset_dict(guard(svc.save_preset, g.org, g.membership, body(), _preset(vid)))


@bp.delete("/parts/presets/<vid>")
@require("parts.view")
def delete_preset(vid: str) -> tuple[str, int]:
    guard(svc.delete_preset, g.membership, _preset(vid))
    return "", 204


# ---------------------------------------------------------------- parts on work orders (r029, r219, r220)
@bp.get("/work-orders/<wid>/parts")
@require("parts.view")
def wo_parts(wid: str) -> dict[str, Any]:
    return qry.work_order_parts(g.membership, _wo(wid))


@bp.post("/work-orders/<wid>/parts")
@require("parts.use")
def add_wo_part(wid: str) -> tuple[dict[str, Any], int]:
    """{part_id, quantity, location_id, status (assigned|reserved|kitted|staged|issued; default issued = used now),
    unit_cost_override, note}"""
    b = body()
    if b.get("unit_cost_override") not in (None, "") and not can(g.membership, "costs.view"):
        abort(403, message="You don't have permission to change costs.")
    wo = _wo(wid)
    guard(svc.add_to_work_order, g.org, g.membership, wo, b)
    return qry.work_order_parts(g.membership, wo), 201


@bp.patch("/work-orders/<wid>/parts/<lid>")
@require("parts.use")
def patch_wo_part(wid: str, lid: str) -> dict[str, Any]:
    """{quantity, location_id, status, unit_cost_override, note}"""
    b = body()
    if "unit_cost_override" in b and not can(g.membership, "costs.view"):
        abort(403, message="You don't have permission to change costs.")
    wo = _wo(wid)
    guard(svc.update_work_order_part, g.org, g.membership, wo, _wp(wo, lid), b)
    return qry.work_order_parts(g.membership, wo)


@bp.post("/work-orders/<wid>/parts/<lid>/return")
@require("parts.use")
def return_wo_part(wid: str, lid: str) -> dict[str, Any]:
    """{quantity} (default: everything used)"""
    wo = _wo(wid)
    guard(svc.return_parts, g.org, g.membership, wo, _wp(wo, lid), body().get("quantity"))
    return qry.work_order_parts(g.membership, wo)


@bp.delete("/work-orders/<wid>/parts/<lid>")
@require("parts.use")
def delete_wo_part(wid: str, lid: str) -> dict[str, Any]:
    wo = _wo(wid)
    guard(svc.remove_from_work_order, g.org, g.membership, wo, _wp(wo, lid))
    return qry.work_order_parts(g.membership, wo)


# ---------------------------------------------------------------- cycle counts (r222)
@bp.get("/cycle-counts")
@require("parts.view")
def list_counts() -> dict[str, Any]:
    rows = db.session.scalars(scoped(CycleCount).order_by(func.lower(CycleCount.name))).all()
    return {"items": [cc.count_dict(c) for c in rows]}


@bp.post("/cycle-counts")
@require("parts.counts")
def create_count() -> tuple[dict[str, Any], int]:
    """{name, location_id, selection: {all | part_ids | type_ids | area}, rrule, next_at, assignees, active}"""
    return cc.count_dict(guard(cc.save_count, g.org, g.membership, body())), 201


@bp.get("/cycle-counts/<cid>")
@require("parts.view")
def get_count(cid: str) -> dict[str, Any]:
    c = get_scoped(CycleCount, cid)
    runs = db.session.scalars(
        select(CycleCountRun)
        .where(CycleCountRun.cycle_count_id == c.id)
        .order_by(CycleCountRun.created_at.desc())
        .limit(50)
    ).all()
    d = cc.count_dict(c)
    d["runs"] = [
        {
            "id": str(r.id),
            "status": r.status,
            "work_order_id": str(r.work_order_id) if r.work_order_id else None,
            "created_at": iso(r.created_at),
            "completed_at": iso(r.completed_at),
        }
        for r in runs
    ]
    return d


@bp.patch("/cycle-counts/<cid>")
@require("parts.counts")
def patch_count(cid: str) -> dict[str, Any]:
    return cc.count_dict(guard(cc.save_count, g.org, g.membership, body(), get_scoped(CycleCount, cid)))


@bp.delete("/cycle-counts/<cid>")
@require("parts.counts")
def delete_count(cid: str) -> tuple[str, int]:
    cc.delete_count(g.org, get_scoped(CycleCount, cid))
    return "", 204


@bp.post("/cycle-counts/<cid>/start")
@require("parts.counts")
def start_count(cid: str) -> tuple[dict[str, Any], int]:
    if not can(g.membership, "wo.create"):
        abort(403, message="You need permission to create work orders to start a count.")
    run = guard(cc.start_run, g.org, g.membership, get_scoped(CycleCount, cid))
    return cc.run_dict(run), 201


def _run(rid: str) -> CycleCountRun:
    run = get_scoped(CycleCountRun, rid)
    if run.work_order_id is not None and not can(g.membership, "parts.counts"):
        _wo(str(run.work_order_id))  # counters see runs of work orders they can see
    return run


@bp.get("/cycle-count-runs/<rid>")
@require("parts.view")
def get_run(rid: str) -> dict[str, Any]:
    return cc.run_dict(_run(rid))


@bp.get("/work-orders/<wid>/cycle-count")
@require("parts.view")
def wo_cycle_count(wid: str) -> dict[str, Any]:
    wo = _wo(wid)
    run = db.session.scalars(select(CycleCountRun).where(CycleCountRun.work_order_id == wo.id)).first()
    return {"run": cc.run_dict(run) if run else None}


@bp.put("/cycle-count-runs/<rid>/lines/<lid>")
@require("parts.use")
def count_line(rid: str, lid: str) -> dict[str, Any]:
    """{counted, note}"""
    run = _run(rid)
    b = body()
    guard(cc.enter, g.org, g.membership, run, lid, b.get("counted"), str(b.get("note") or ""))
    return cc.run_dict(run)


@bp.post("/cycle-count-runs/<rid>/apply")
@require("parts.counts")
def apply_run(rid: str) -> dict[str, Any]:
    run = _run(rid)
    n = guard(cc.apply_run, g.org, g.membership, run)
    d = cc.run_dict(run)
    d["corrections"] = n
    return d


@bp.post("/cycle-count-runs/<rid>/export")
@require("parts.view")
def export_run(rid: str) -> tuple[dict[str, Any], int]:
    _need("exports.use")
    run = _run(rid)
    ex = guard(
        request_export,
        g.org.id,
        g.user.id,
        "parts.cycle_count.csv",
        "Cycle count result (CSV)",
        {"run_id": str(run.id)},
    )
    db.session.commit()
    return export_dict(ex), 202


@exporter("parts.cycle_count.csv")
def _count_csv(ex: Any) -> tuple[str, bytes, str]:
    from mpro.workorders.exports import _member

    m, _org = _member(ex)
    if not can(m, "parts.view"):
        raise PermissionError("You no longer have access to parts.")
    run = db.session.get(CycleCountRun, uuid.UUID(ex.params["run_id"]))
    if run is None or run.org_id != m.org_id:
        raise PermissionError("That count no longer exists.")
    return f"cycle-count-{run.created_at:%Y-%m-%d}.csv", cc.run_csv(run), "text/csv"


# ---------------------------------------------------------------- search, files, QR, hooks, jobs
@provider("parts", "Parts", "parts.view")
def _search_parts(text: str, limit: int) -> list[dict[str, Any]]:
    from mpro.parts.models import PartVendor

    pat = like(text)
    rows = db.session.scalars(
        scoped(Part)
        .where(
            or_(
                func.lower(Part.name).like(pat, escape="\\"),
                func.lower(Part.part_number).like(pat, escape="\\"),
                func.lower(Part.barcode).like(pat, escape="\\"),
                func.lower(Part.mpn).like(pat, escape="\\"),
                Part.id.in_(
                    select(PartVendor.part_id).where(
                        PartVendor.org_id == g.org.id, func.lower(PartVendor.vendor_part_number).like(pat, escape="\\")
                    )
                ),
            )
        )
        .order_by(func.lower(Part.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(p.id),
            "title": p.name,
            "subtitle": " · ".join(
                x
                for x in (p.part_number, "Non-stock" if p.non_stock else f"{svc._q(p.on_hand)} {p.unit} in stock")
                if x
            ),
            "url": f"/parts/{p.id}",
        }
        for p in rows
    ]


def _visible(perm: str, rid: uuid.UUID) -> bool:
    p = db.session.get(Part, rid)
    return p is not None and p.org_id == g.org.id and p.deleted_at is None and can(g.membership, perm)


def _touch(pid: uuid.UUID) -> None:
    """A file was added or removed: the first photo becomes the part's picture (r214)."""
    from mpro.core.files import FileLink
    from mpro.core.models import utcnow

    p = db.session.get(Part, pid)
    if p is None:
        return
    p.updated_at = utcnow()
    links = db.session.scalars(
        select(FileLink)
        .where(FileLink.entity_type == "part", FileLink.entity_id == pid)
        .order_by(FileLink.sort, FileLink.created_at)
    ).all()
    images = [link.file_id for link in links if link.file.is_image]
    if p.picture_file_id not in images:
        p.picture_file_id = images[0] if images else None


register_entity("part", lambda i: _visible("parts.view", i), lambda i: _visible("parts.manage", i), _touch)


def _register() -> None:
    from mpro.core.jobs import job, periodic
    from mpro.qr.services import register_target
    from mpro.workorders import services as wo_svc

    register_target("part", Part, lambda p: p.name, lambda p: f"/parts/{p.id}", "parts.view")
    if svc.on_wo_status not in wo_svc.STATUS_HOOKS:
        wo_svc.STATUS_HOOKS.append(svc.on_wo_status)
    if cc.on_wo_status not in wo_svc.STATUS_HOOKS:
        wo_svc.STATUS_HOOKS.append(cc.on_wo_status)
    if svc.on_wo_create not in wo_svc.CREATE_HOOKS:
        wo_svc.CREATE_HOOKS.append(svc.on_wo_create)

    @job("parts.auto_reserve")
    def _auto_reserve(_: dict[str, Any]) -> None:
        svc.auto_reserve()

    @job("parts.cycle_counts")
    def _cycle_counts(_: dict[str, Any]) -> None:
        cc.due_runs()

    periodic("parts.auto_reserve", timedelta(hours=1))
    periodic("parts.cycle_counts", timedelta(minutes=15))


_register()
