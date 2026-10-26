"""QR codes, scanning and label printing API (/api/v1)."""

from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request
from sqlalchemy import select

from mpro.core.permissions import can
from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.qr import labels as lbl
from mpro.qr import services as svc
from mpro.qr.models import QrCode

bp = APIBlueprint("qr", __name__, url_prefix="/api/v1", tag="QR codes and labels")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except RuleError as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


VIEW = {
    "asset": "assets.view",
    "location": "locations.view",
    "meter": "meters.view",
    "part": "parts.view",
    "work_order": "wo.view",  # 0.6.0: codes on work orders and inspection rounds (MP-097)
    "procedure": "procedures.view",
}
MANAGE = {
    "asset": "assets.manage",
    "location": "locations.manage",
    "meter": "meters.manage",
    "part": "parts.manage",
    "work_order": "wo.edit",
    "procedure": "procedures.manage",
}


def _check(entity_type: str, manage: bool = False) -> None:
    perm = (MANAGE if manage else VIEW).get(entity_type)
    if perm is None:
        abort(422, message="Codes can go on assets, locations, meters, parts, work orders and procedures.")
    if not can(g.membership, perm):
        abort(403, message="You don't have permission to do that.")


@bp.get("/scan")
@require("org.view")
def scan() -> dict[str, Any]:
    """Resolve a scanned value: ?value=… (an MPro URL or code, an external barcode, or a serial number)."""
    return guard(svc.resolve, g.membership, request.args.get("value") or "")


@bp.get("/qr-codes")
@require("qr.manage")
def list_codes() -> dict[str, Any]:
    """Query: state (all|unassigned|assigned|retired), batch, page, per_page."""
    return guard(svc.list_codes, g.org.id, dict(request.args.items()))


@bp.get("/qr-codes/for/<entity_type>/<eid>")
@require("org.view")
def codes_for(entity_type: str, eid: str) -> dict[str, Any]:
    _check(entity_type)
    try:
        uid = uuid.UUID(eid)
    except ValueError:
        abort(404)
    if entity_type == "work_order":  # limited visibility (0.6.0 review L3)
        from mpro.workorders.models import WorkOrder
        from mpro.workorders.services import can_see

        wo = db.session.get(WorkOrder, uid)
        if wo is None or wo.org_id != g.org.id or not can_see(g.membership, wo):
            abort(404)
    return {"items": svc.codes_for(g.org.id, entity_type, uid, include_retired=request.args.get("retired") == "1")}


@bp.post("/qr-codes")
@require("qr.manage")
def create_code() -> tuple[dict[str, Any], int]:
    """{entity_type, entity_id} makes (or returns) the record's MPro code; add {value, symbology} to link an existing
    barcode instead; {count, note} without a record makes blank codes to assign later."""
    b = body()
    if b.get("count") is not None and not b.get("entity_type"):
        codes = guard(svc.generate_batch, g.org, g.membership, b.get("count"), str(b.get("note") or ""))
        return {"items": [svc.code_dict(c) for c in codes], "batch": codes[0].batch}, 201
    et = str(b.get("entity_type") or "")
    _check(et, manage=True)
    if b.get("value"):
        c = guard(
            svc.add_external,
            g.org,
            g.membership,
            et,
            b.get("entity_id"),
            str(b["value"]),
            str(b.get("symbology") or "other"),
        )
    else:
        c = guard(svc.ensure_code, g.org, g.membership, et, b.get("entity_id"))
    return svc.code_dict(c, with_target=True), 201


def _code(cid: str) -> QrCode:
    return guard(svc.get_code, g.org.id, cid)


@bp.post("/qr-codes/<cid>/assign")
@require("qr.manage")
def assign(cid: str) -> dict[str, Any]:
    """{entity_type, entity_id, move: true to move a code from another record}"""
    b = body()
    et = str(b.get("entity_type") or "")
    _check(et, manage=True)
    c = guard(svc.assign, g.org, g.membership, _code(cid), et, b.get("entity_id"), bool(b.get("move")))
    return svc.code_dict(c, with_target=True)


@bp.post("/qr-codes/<cid>/retire")
@require("qr.manage")
def retire(cid: str) -> dict[str, Any]:
    return svc.code_dict(guard(svc.retire, g.org, g.membership, _code(cid)), with_target=True)


# ---- labels ------------------------------------------------------------------------------------
@bp.get("/labels/templates")
@require("org.view")
def label_templates() -> dict[str, Any]:
    return lbl.templates()


def _items(b: dict[str, Any]) -> list[lbl.LabelItem]:
    from mpro.assets.models import Asset, Location
    from mpro.meters.models import Meter
    from mpro.parts.models import Part
    from mpro.procedures.models import Procedure
    from mpro.workorders.models import WorkOrder

    code_ids = b.get("code_ids")
    if code_ids:  # blank codes (tag first, assign later)
        if not can(g.membership, "qr.manage"):
            abort(403, message="You don't have permission to do that.")
        if not isinstance(code_ids, list) or len(code_ids) > 5000:
            abort(422, message="code_ids must be a list.")
        codes = [_code(str(i)) for i in code_ids]
        return [
            lbl.LabelItem(url=svc.code_url(c.value), title=str(b.get("blank_title") or ""), code=c.value) for c in codes
        ]
    et = str(b.get("entity_type") or "")
    _check(et)
    ids = b.get("ids")
    model: Any = {
        "asset": Asset,
        "location": Location,
        "meter": Meter,
        "part": Part,
        "work_order": WorkOrder,
        "procedure": Procedure,
    }[et]
    if isinstance(ids, list) and ids:
        if len(ids) > 5000:
            abort(422, message="Print up to 5,000 labels at a time.")
        try:
            uids = [uuid.UUID(str(i)) for i in ids]
        except ValueError:
            abort(422, message="One of the ids isn't valid.")
        found = {
            r.id: r
            for r in db.session.scalars(
                select(model).where(model.org_id == g.org.id, model.id.in_(uids), model.deleted_at.is_(None))
            ).all()
        }
        recs = [found[i] for i in uids if i in found]
        if et == "work_order":
            from mpro.workorders.services import can_see

            recs = [r for r in recs if can_see(g.membership, r)]
    elif et == "asset" and isinstance(b.get("query"), dict):
        from mpro.assets.queries import apply_asset_sort, asset_query

        q = {k: str(v) for k, v in b["query"].items() if k not in ("page", "per_page")}
        recs = list(
            db.session.scalars(apply_asset_sort(guard(asset_query, g.membership, q), q.get("sort")).limit(5001)).all()
        )
        if len(recs) > 5000:
            abort(422, message="That's more than 5,000 assets. Narrow the filters.")
    elif et == "part" and isinstance(b.get("query"), dict):  # 0.5.0: labels for the filtered parts list
        from mpro.parts.queries import apply_sort, part_query

        q = {k: str(v) for k, v in b["query"].items() if k not in ("page", "per_page")}
        recs = list(db.session.scalars(apply_sort(guard(part_query, g.membership, q), q.get("sort")).limit(5001)).all())
        if len(recs) > 5000:
            abort(422, message="That's more than 5,000 parts. Narrow the filters.")
    else:
        abort(422, message="Pick what to print.")
    if not recs:
        abort(422, message="There's nothing to print.")
    # Printing a label gives the record a code if it has none (needs permission to change the record).
    may_create = can(g.membership, "qr.manage") and can(g.membership, MANAGE[et])
    existing = {
        c.entity_id: c
        for c in db.session.scalars(
            select(QrCode)
            .where(
                QrCode.org_id == g.org.id,
                QrCode.entity_type == et,
                QrCode.kind == "mpro",
                QrCode.retired_at.is_(None),
                QrCode.entity_id.in_([r.id for r in recs]),
            )
            .order_by(QrCode.created_at.desc())
        ).all()
    }
    items = []
    for r in recs:
        c = existing.get(r.id)
        if c is None:
            if not may_create:
                abort(403, message=f"{_rec_name(et, r)} has no QR code yet, and you can't create one.")
            c = svc.ensure_code(g.org, g.membership, et, r.id, commit=False)
        subtitle = ""
        if et == "asset":
            subtitle = " · ".join(
                x for x in (r.location.name if r.location else "", r.serial_number and f"S/N {r.serial_number}") if x
            )
        elif et == "location":
            subtitle = r.city or ""
        elif et == "meter":
            subtitle = r.unit
        elif et == "part":
            subtitle = r.part_number or ""
        elif et == "work_order":
            subtitle = r.location.name if r.location else ""
        items.append(
            lbl.LabelItem(
                url=svc.code_url(c.value),
                title=_rec_name(et, r),
                subtitle=subtitle,
                code=c.value,
                barcode=(r.barcode if et in ("asset", "part") and r.barcode else c.value),
            )
        )
    db.session.commit()
    return items


def _rec_name(et: str, r: Any) -> str:
    return f"#{r.number} {r.title}" if et == "work_order" else str(r.name)


@bp.post("/labels")
@require("org.view")
def print_labels() -> Response:
    """Make labels. {entity_type, ids | query (assets) | code_ids (blank codes), format: sheet|thermal|zpl,
    template (see /labels/templates), start (first free position on a part-used sheet), copies,
    options: {show_name, show_subtitle, show_code, barcode, outline}}"""
    b = body()
    fmt = b.get("format") or "sheet"
    template = str(b.get("template") or "")
    opts = b.get("options") if isinstance(b.get("options"), dict) else {}
    try:
        start, copies = int(b.get("start") or 1), int(b.get("copies") or 1)
    except (TypeError, ValueError):
        abort(422, message="start and copies must be numbers.")
    items = _items(b)
    if fmt == "sheet":
        data, mime, ext = guard(lbl.sheet_pdf, items, template, start, copies, opts), "application/pdf", "pdf"
    elif fmt == "thermal":
        data, mime, ext = guard(lbl.thermal_pdf, items, template, copies, opts), "application/pdf", "pdf"
    elif fmt == "zpl":
        data, mime, ext = guard(lbl.zpl, items, template, copies, opts).encode(), "text/plain", "zpl"
    else:
        abort(422, message="Format is sheet, thermal or zpl.")
    resp = Response(data, mimetype=mime)
    disp = "attachment" if fmt == "zpl" or request.args.get("download") == "1" else "inline"
    resp.headers["Content-Disposition"] = f'{disp}; filename="labels.{ext}"'
    return resp


# ---- 0.6.0 scan actions, check-ins and scan history (MP-097) --------------------------------------------------------
from mpro.qr import scan as scan_svc  # noqa: E402

scan_svc.register_targets()
scan_svc.register_hooks()


@bp.post("/scan")
@require("org.view")
def scan_and_record() -> dict[str, Any]:
    """Scan a code: {value, source: camera|link|typed|photo, latitude, longitude, accuracy, client_id, scanned_at}.
    Records the scan and returns the record with the actions this person can take and the default one."""
    return guard(scan_svc.scan, g.org, g.membership, body())


@bp.get("/scan/config")
@require("org.view")
def scan_config() -> dict[str, Any]:
    s = scan_svc.settings(g.org.id)
    return {"record_gps": s["record_gps"], "require_window_minutes": s["require_window_minutes"]}


@bp.get("/scan/settings")
@require("scan.settings")
def get_scan_settings() -> dict[str, Any]:
    return {
        **scan_svc.settings(g.org.id),
        "actions": {
            et: [{"key": k, "label": label} for k, (label, _) in acts.items()] for et, acts in scan_svc.ACTIONS.items()
        },
    }


@bp.patch("/scan/settings")
@require("scan.settings")
def patch_scan_settings() -> dict[str, Any]:
    return guard(scan_svc.save, g.org, g.membership, body())


@bp.post("/scan/events")
@require("org.view")
def record_scan_event() -> tuple[dict[str, Any], int]:
    """An action after a scan, or an offline scan synced later: {entity_type, entity_id, action, work_order_id,
    code, source, latitude, longitude, accuracy, scanned_at, client_id}. Replays with the same client_id are ignored."""
    ev, created = guard(scan_svc.record_action, g.org, g.membership, body())
    return ev, 201 if created else 200


@bp.post("/scan/start-procedure")
@require("org.view")
def scan_start_procedure() -> dict[str, Any]:
    """{procedure_id}: continue my open work order with this procedure, or start a new one."""
    return guard(scan_svc.start_procedure, g.org, g.membership, body())


@bp.get("/scan/history")
@require("org.view")
def scan_history() -> dict[str, Any]:
    """Query: entity_type, entity_id, work_order_id, user_id, action, page, per_page. Without scan.history only your
    own scans are listed."""
    return guard(scan_svc.history, g.org, g.membership, dict(request.args.items()))


@bp.get("/work-orders/<wo_id>/visits")
@require("wo.view")
def work_order_visits(wo_id: str) -> dict[str, Any]:
    """Proof of visit: scans linked to the work order, and of its assets and location while it was open."""
    from mpro.workorders.models import WorkOrder

    try:
        wid = uuid.UUID(wo_id)
    except ValueError:
        abort(404)
    wo = db.session.get(WorkOrder, wid)
    if wo is None or wo.org_id != g.org.id or wo.deleted_at is not None:
        abort(404)
    return guard(scan_svc.visits, g.org, g.membership, wo)


def _procedure(pid: str) -> Any:
    from mpro.procedures.services import get_procedure

    p = guard(get_procedure, g.org.id, pid)
    if p.work_order_id is not None:
        abort(404)
    return p


@bp.get("/procedures/<pid>/scan-requirement")
@require("procedures.view")
def get_scan_requirement(pid: str) -> dict[str, Any]:
    return scan_svc.requirement(g.org.id, _procedure(pid).id)


@bp.put("/procedures/<pid>/scan-requirement")
@require("procedures.manage")
def put_scan_requirement(pid: str) -> dict[str, Any]:
    """{on_start, on_complete}: work orders with this procedure need a scan of their asset, location or own code."""
    p = _procedure(pid)
    from mpro.core.permissions import can_on

    if not can_on(g.membership, "procedures.manage", p):
        abort(403, message="You don't have permission to do that.")
    return guard(scan_svc.set_requirement, g.org, g.membership, p, body())


@bp.get("/public/scan/<code>")
def public_scan(code: str) -> dict[str, Any]:
    """Signed out: a printed MPro code on an asset or location leads only to the request form (if allowed)."""
    return guard(scan_svc.public_scan, code, (request.remote_addr or "")[:64])
