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


VIEW = {"asset": "assets.view", "location": "locations.view", "meter": "meters.view"}
MANAGE = {"asset": "assets.manage", "location": "locations.manage", "meter": "meters.manage"}


def _check(entity_type: str, manage: bool = False) -> None:
    perm = (MANAGE if manage else VIEW).get(entity_type)
    if perm is None:
        abort(422, message="Codes can go on assets, locations and meters.")
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
    model: Any = {"asset": Asset, "location": Location, "meter": Meter}[et]
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
    elif et == "asset" and isinstance(b.get("query"), dict):
        from mpro.assets.queries import apply_asset_sort, asset_query

        q = {k: str(v) for k, v in b["query"].items() if k not in ("page", "per_page")}
        recs = list(
            db.session.scalars(apply_asset_sort(guard(asset_query, g.membership, q), q.get("sort")).limit(5001)).all()
        )
        if len(recs) > 5000:
            abort(422, message="That's more than 5,000 assets. Narrow the filters.")
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
                abort(403, message=f"{r.name} has no QR code yet, and you can't create one.")
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
        items.append(
            lbl.LabelItem(
                url=svc.code_url(c.value),
                title=r.name,
                subtitle=subtitle,
                code=c.value,
                barcode=(r.barcode if et == "asset" and r.barcode else c.value),
            )
        )
    db.session.commit()
    return items


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
