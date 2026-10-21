"""Uploads, downloads, attachments and the Download Center."""

from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request
from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.files import (
    INLINE_TYPES,
    Export,
    FileError,
    FileLink,
    FileObject,
    attach,
    can_view_file,
    entity_access,
    export_dict,
    file_dict,
    link_dict,
    save_file,
    storage,
)
from mpro.core.models import utcnow
from mpro.core.tenancy import require
from mpro.extensions import db

bp = APIBlueprint("files", __name__, url_prefix="/api/v1", tag="Files")
ROLES = ("photo", "file", "before", "after", "comment", "receipt", "cancel")


def _uuid(v: str) -> uuid.UUID:
    try:
        return uuid.UUID(v)
    except ValueError:
        abort(404)


def _file(file_id: str) -> FileObject:
    f = db.session.get(FileObject, _uuid(file_id))
    if f is None or f.org_id != g.org.id or f.deleted_at is not None or not can_view_file(f):
        abort(404)
    return f


@bp.post("/files")
@require("org.view")
def upload() -> tuple[dict[str, Any], int]:
    """Upload a file (multipart field `file`). Optionally attach it with `entity_type`, `entity_id`, `role`."""
    up = request.files.get("file")
    if up is None or not up.filename:
        abort(422, message="Choose a file to upload.")
    entity_type = request.form.get("entity_type") or ""
    entity_id = request.form.get("entity_id") or ""
    role = request.form.get("role") or "file"
    if role not in ROLES:
        abort(422, message="Unknown attachment role.")
    try:
        acc = None
        eid = None
        if entity_type:
            acc = entity_access(entity_type)
            eid = _uuid(entity_id)
            if not acc.can_edit(eid):
                abort(403, message="You can't add files to that record.")
        data = up.read()
        f = save_file(g.org.id, up.filename, data, g.user.id)
        link = None
        if acc is not None and eid is not None:
            link = attach(f, entity_type, eid, role)
            if acc.on_change:
                acc.on_change(eid)
            emit(
                "file.attached",
                entity_type=entity_type,
                entity_id=eid,
                summary=f"Attached {f.name}",
                data={"file_id": f.id, "role": role},
            )
        db.session.commit()
    except FileError as e:
        db.session.rollback()
        abort(e.status, message=e.message)
    return (link_dict(link) if link else file_dict(f)), 201


def _send(f: FileObject, key: str, ctype: str, download: bool) -> Response:
    try:
        data = storage().get(key)
    except FileError as e:
        abort(e.status, message=e.message)
    inline = ctype in INLINE_TYPES and not download
    resp = Response(data, mimetype=ctype)
    disp = "inline" if inline else "attachment"
    safe = f.name.replace('"', "").replace("\r", "").replace("\n", "")
    from urllib.parse import quote

    resp.headers["Content-Disposition"] = (
        f"{disp}; filename=\"{safe.encode('ascii', 'ignore').decode() or 'file'}\"; filename*=UTF-8''{quote(safe)}"
    )
    resp.headers["Content-Security-Policy"] = (
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@bp.get("/files/<file_id>")
@require("org.view")
def download(file_id: str) -> Response:
    f = _file(file_id)
    return _send(f, f.storage_key, f.content_type, request.args.get("download") == "1")


@bp.get("/files/<file_id>/thumb")
@require("org.view")
def thumb(file_id: str) -> Response:
    f = _file(file_id)
    if f.thumb_key:
        return _send(f, f.thumb_key, "image/jpeg", False)
    if f.is_image:
        return _send(f, f.storage_key, f.content_type, False)
    abort(404)


@bp.delete("/files/links/<link_id>")
@require("org.view")
def detach(link_id: str) -> tuple[str, int]:
    link = db.session.get(FileLink, _uuid(link_id))
    if link is None or link.org_id != g.org.id:
        abort(404)
    acc = entity_access(link.entity_type)
    if not acc.can_edit(link.entity_id) and link.file.uploaded_by_id != g.user.id:
        abort(403, message="You can't remove files from that record.")
    if link.role == "signature":
        abort(409, message="Signatures can't be removed.")
    name, et, eid = link.file.name, link.entity_type, link.entity_id
    others = db.session.scalar(select(FileLink.id).where(FileLink.file_id == link.file_id, FileLink.id != link.id))
    if not others:
        link.file.deleted_at = utcnow()
    db.session.delete(link)
    if acc.on_change:
        acc.on_change(eid)
    emit("file.detached", entity_type=et, entity_id=eid, summary=f"Removed {name}")
    db.session.commit()
    return "", 204


# ---- Download Center -------------------------------------------------------------------------
@bp.get("/exports")
@require("exports.use")
def list_exports() -> dict[str, Any]:
    rows = db.session.scalars(
        select(Export)
        .where(Export.org_id == g.org.id, Export.user_id == g.user.id, Export.expires_at > utcnow())
        .order_by(Export.created_at.desc())
        .limit(100)
    ).all()
    return {"items": [export_dict(x) for x in rows]}


def _export(export_id: str) -> Export:
    ex = db.session.get(Export, _uuid(export_id))
    if ex is None or ex.org_id != g.org.id or ex.user_id != g.user.id:
        abort(404)
    return ex


@bp.get("/exports/<export_id>")
@require("exports.use")
def get_export(export_id: str) -> dict[str, Any]:
    return export_dict(_export(export_id))


@bp.delete("/exports/<export_id>")
@require("exports.use")
def delete_export(export_id: str) -> tuple[str, int]:
    ex = _export(export_id)
    if ex.file is not None:
        storage().delete(ex.file.storage_key)
        ex.file.deleted_at = utcnow()
    db.session.delete(ex)
    db.session.commit()
    return "", 204
