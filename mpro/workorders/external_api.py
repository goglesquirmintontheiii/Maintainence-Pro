"""REST endpoints for sharing work orders outside the organization, vendors on work orders and emailing a work order
PDF (0.5.0: r058–r060, r075, r088, r092, r094). Routes live on the work-orders blueprint.

Public endpoints (`/api/v1/external/<token>…`) take no session: the secret link is the credential. They're exempt from
the session CSRF check for that reason, rate-limited per IP and per link, and only ever touch the shared work order.
"""

from __future__ import annotations

from typing import Any

from apiflask import abort
from flask import Response, g, request

from mpro.core.files import FileError, FileObject
from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.workorders import external as ext
from mpro.workorders import wo_vendors
from mpro.workorders.api import _wo, body, bp


def _guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


# ---------------------------------------------------------------- inside the organization


@bp.get("/external-shares/fields")
@require("wo.view")
def external_fields() -> dict[str, Any]:
    """The fields a link can show, their labels and default access."""
    return {
        "fields": [
            {"id": k, "label": label, "default": default, "interactive": k in ext.INTERACTIVE}
            for k, (label, default) in ext.FIELDS.items()
        ]
    }


@bp.get("/work-orders/<wo_id>/external-shares")
@require("wo.share_external")
def list_shares(wo_id: str) -> dict[str, Any]:
    return {"items": ext.shares_for(_wo(wo_id))}


@bp.post("/work-orders/<wo_id>/external-shares")
@require("wo.share_external")
def create_share(wo_id: str) -> tuple[dict[str, Any], int]:
    """{fields: {field: hidden|view|interact}, vendor_id?, contact_ids?, emails?, message?}. The link is returned
    once (`token`, `path`); it can't be read back later."""
    wo = _wo(wo_id)
    s, token = _guard(ext.create_share, g.org, g.membership, wo, body())
    return ext.share_dict(s, token), 201


@bp.patch("/work-orders/<wo_id>/external-shares/<share_id>")
@require("wo.share_external")
def patch_share(wo_id: str, share_id: str) -> dict[str, Any]:
    """{fields?, status?: active|disabled} — disabling is reversible (r060)."""
    wo = _wo(wo_id)
    s = _guard(ext.get_share, wo, share_id)
    _guard(ext.update_share, g.org, g.membership, wo, s, body())
    return ext.share_dict(s)


@bp.post("/work-orders/<wo_id>/external-shares/<share_id>/reset")
@require("wo.share_external")
def reset_share(wo_id: str, share_id: str) -> dict[str, Any]:
    """Revoke the link and make a new one with the same settings; returns the new link once."""
    wo = _wo(wo_id)
    s = _guard(ext.get_share, wo, share_id)
    n, token = _guard(ext.reset_share, g.org, g.membership, wo, s)
    return ext.share_dict(n, token)


@bp.delete("/work-orders/<wo_id>/external-shares/<share_id>")
@require("wo.share_external")
def delete_share(wo_id: str, share_id: str) -> tuple[str, int]:
    wo = _wo(wo_id)
    s = _guard(ext.get_share, wo, share_id)
    _guard(ext.revoke_share, g.org, g.membership, wo, s)
    return "", 204


@bp.put("/work-orders/<wo_id>/vendors")
@require("wo.edit")
def put_vendors(wo_id: str) -> dict[str, Any]:
    """{vendor_ids: [...]} replaces the work order's vendors (r075)."""
    wo = _wo(wo_id)

    def run() -> None:
        if wo_vendors.set_vendors(g.org, g.membership, wo, body().get("vendor_ids")):
            db.session.commit()

    _guard(run)
    return {"vendors": wo_vendors.vendors_of([wo.id]).get(wo.id, [])}


@bp.post("/work-orders/<wo_id>/email-pdf")
@require("wo.share_external")
def email_pdf(wo_id: str) -> dict[str, Any]:
    """Email the work order PDF (r094): {vendor_ids?, contact_ids?, emails?, message?, options?}."""
    return _guard(ext.email_pdf, g.org, g.membership, _wo(wo_id), body())


# ---------------------------------------------------------------- public (the secret link is the credential)


def _public(token: str, write: bool = False) -> tuple[Any, Any, Any]:
    s, wo, org = _guard(ext.resolve, token, write)
    g.org = org  # services scope by the shared work order's organization
    g.membership = None
    return s, wo, org


def _no_store(resp: Any) -> Any:
    if isinstance(resp, Response):
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


@bp.get("/external/<token>")
def public_view(token: str) -> Any:
    s, wo, org = _public(token)
    data = _guard(ext.public_view, token, s, wo, org)
    from flask import jsonify

    return _no_store(jsonify(data))


@bp.post("/external/<token>/comments")
def public_comment(token: str) -> tuple[dict[str, Any], int]:
    """{name, body, file_ids?} — file ids from POST /external/<token>/files."""
    s, wo, org = _public(token, write=True)
    return _guard(ext.add_comment, s, wo, org, body()), 201


@bp.put("/external/<token>/procedures/<run_id>/answers/<field_id>")
def public_answer(token: str, run_id: str, field_id: str) -> Any:
    """{name, value, note?, file_ids?, signature?, signed_by?} — like the signed-in answer endpoint."""
    s, wo, org = _public(token, write=True)
    res = _guard(ext.answer, s, wo, org, run_id, field_id, body())
    run = res.get("run") if isinstance(res, dict) else None
    return {"run_id": run_id, "status": run.get("status") if run else None}


@bp.post("/external/<token>/files")
def public_upload(token: str) -> tuple[dict[str, Any], int]:
    """Upload a file (multipart `file`) to use in a comment or a procedure answer. Same limits and checks as
    signed-in uploads."""
    s, wo, org = _public(token, write=True)
    up = request.files.get("file")
    if up is None or not up.filename:
        abort(422, message="Choose a file to upload.")
    out = _guard(ext.upload, s, wo, org, up)
    out["url"] = f"/api/v1/external/{token}/files/{out['id']}"
    return out, 201


@bp.post("/external/<token>/finish")
def public_finish(token: str) -> dict[str, Any]:
    """{name, note?} — tell the organization the work is finished (r092)."""
    s, wo, org = _public(token, write=True)
    _guard(ext.finish, s, wo, org, body())
    return {"ok": True}


def _public_file(token: str, file_id: str) -> tuple[Any, FileObject]:
    import uuid

    s, wo, _org = _public(token)
    try:
        f = db.session.get(FileObject, uuid.UUID(file_id))
    except ValueError:
        f = None
    if f is None or not ext.file_allowed(s, wo, f):
        abort(404)
    return s, f


@bp.get("/external/<token>/files/<file_id>")
def public_file(token: str, file_id: str) -> Any:
    from mpro.core.files_api import _send

    _s, f = _public_file(token, file_id)
    return _no_store(_send(f, f.storage_key, f.content_type, request.args.get("download") == "1"))


@bp.get("/external/<token>/files/<file_id>/thumb")
def public_thumb(token: str, file_id: str) -> Any:
    from mpro.core.files_api import _send

    _s, f = _public_file(token, file_id)
    if f.thumb_key:
        return _no_store(_send(f, f.thumb_key, "image/jpeg", False))
    if f.is_image:
        return _no_store(_send(f, f.storage_key, f.content_type, False))
    abort(404)


def register() -> None:
    from mpro.auth.api import CSRF_EXEMPT

    CSRF_EXEMPT.update(
        {
            "work_orders.public_comment",
            "work_orders.public_answer",
            "work_orders.public_upload",
            "work_orders.public_finish",
        }
    )
    ext.register()
    wo_vendors.register()
