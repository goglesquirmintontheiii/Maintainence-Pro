"""File storage, attachments and the Download Center.

- `FileObject` is one stored file (photo, document, signature, generated export).
- `FileLink` attaches a file to any record (`entity_type`, `entity_id`, `role`), so assets, parts and
  purchase orders reuse the same table later.
- Storage goes through `Storage`. Self-hosted uses the local data folder; MPro Cloud plugs in an
  S3-compatible store (roadmap r019) without touching callers.
- Modules say who may see or change their records with `register_entity(...)`.
- Exports (PDF, CSV) run as background jobs and land in the Download Center for 14 days.
"""

from __future__ import annotations

import hashlib
import io
import logging
import mimetypes
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from flask import current_app, g
from sqlalchemy import JSON, BigInteger, Boolean, ForeignKey, Integer, String, Text, Uuid, select
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db

log = logging.getLogger(__name__)

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"}
PSD_TYPE = "image/vnd.adobe.photoshop"  # previewed as a flattened PNG (MP-107)
# MaintainX accepts .doc/.docx/.xlsx/.csv/.pdf/.gif/.jpg/.png/.mp4 (no legacy .xls). We add a few safe extras.
ALLOWED_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".pdf", ".doc", ".docx", ".xlsx", ".csv", ".txt",
    ".mp4", ".mov", ".m4a", ".mp3", ".wav", ".avif", ".psd", ".webm",
}  # fmt: skip
INLINE_TYPES = IMAGE_TYPES | {
    "application/pdf", "video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav",
}  # fmt: skip
EXPORT_RETENTION = timedelta(days=14)


class FileError(Exception):
    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.message, self.status = message, status


class FileObject(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "files"

    name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    storage_key: Mapped[str] = mapped_column(String(300))
    thumb_key: Mapped[str] = mapped_column(String(300), default="")
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    # a browser-friendly rendering made in the background (PSD -> PNG, DOCX/XLSX -> PDF, …) for the viewer (MP-107)
    preview_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    encrypted: Mapped[bool] = mapped_column(Boolean, default=False)  # stored with mpro.core.crypto (0.5.0, MP-090)

    @property
    def is_image(self) -> bool:
        return self.content_type in IMAGE_TYPES


class FileLink(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "file_links"

    file_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("files.id"), index=True)
    entity_type: Mapped[str] = mapped_column(String(40), index=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    # photo | file | before | after | receipt | comment | signature | cancel
    role: Mapped[str] = mapped_column(String(20), default="file")
    sort: Mapped[int] = mapped_column(Integer, default=0)

    file: Mapped[FileObject] = relationship(lazy="joined")


class Export(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A generated download (Download Center). Owned by the person who asked for it."""

    __tablename__ = "exports"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(300))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued | ready | failed
    error: Mapped[str] = mapped_column(Text, default="")
    file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, default=lambda: utcnow() + EXPORT_RETENTION)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    file: Mapped[FileObject | None] = relationship(lazy="joined")


# ---- storage ---------------------------------------------------------------------------------
class Storage:
    def put(self, key: str, data: bytes) -> None:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError

    def put_stream(self, key: str, stream: Any, limit: int) -> tuple[int, str]:
        """Store a file-like object; returns (size, sha256). Raises FileError past `limit` bytes."""
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise FileError(f"Files can be up to {limit // (1024 * 1024)} MB.", 413)
        self.put(key, data)
        return len(data), hashlib.sha256(data).hexdigest()


class LocalStorage(Storage):
    """Files under <data dir>/files. Keys never come from user input, but are still confined to the root."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise FileError("Invalid storage key.", 400)
        return p

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(p)

    def put_stream(self, key: str, stream: Any, limit: int) -> tuple[int, str]:
        """Copy in 1 MB chunks so large uploads never sit in memory; hash as we go."""
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        h, size = hashlib.sha256(), 0
        try:
            with tmp.open("wb") as out:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise FileError(f"Files can be up to {limit // (1024 * 1024)} MB.", 413)
                    h.update(chunk)
                    out.write(chunk)
            tmp.replace(p)
        finally:
            if tmp.exists():
                tmp.unlink()
        return size, h.hexdigest()

    def get(self, key: str) -> bytes:
        p = self._path(key)
        if not p.is_file():
            raise FileError("This file is missing from storage.", 404)
        return p.read_bytes()

    def delete(self, key: str) -> None:
        p = self._path(key)
        if p.is_file():
            p.unlink()


def storage() -> Storage:
    return LocalStorage(Path(current_app.config["MPRO_DATA_DIR"]) / "files")


# ---- entity access ---------------------------------------------------------------------------
@dataclass
class EntityAccess:
    can_view: Callable[[uuid.UUID], bool]
    can_edit: Callable[[uuid.UUID], bool]
    on_change: Callable[[uuid.UUID], None] | None = None


_entities: dict[str, EntityAccess] = {}


def register_entity(
    entity_type: str,
    can_view: Callable[[uuid.UUID], bool],
    can_edit: Callable[[uuid.UUID], bool],
    on_change: Callable[[uuid.UUID], None] | None = None,
) -> None:
    _entities[entity_type] = EntityAccess(can_view, can_edit, on_change)


def entity_access(entity_type: str) -> EntityAccess:
    acc = _entities.get(entity_type)
    if acc is None:
        raise FileError("Files can't be attached to that kind of record.", 422)
    return acc


# ---- upload / read ---------------------------------------------------------------------------
def max_upload_bytes(org: Any = None) -> int:
    """Largest single upload: MPRO_MAX_UPLOAD_MB (150 MB by default, MP-109), or the plan's file_mb on MPro Cloud."""
    limit = int(current_app.config.get("MPRO_MAX_UPLOAD_MB", 150)) * 1024 * 1024
    if org is not None:
        from mpro.core.entitlements import entitlements_for

        plan_mb = entitlements_for(org).limit("file_mb")
        if plan_mb is not None:
            limit = min(limit, int(plan_mb) * 1024 * 1024)
    return limit


def _clean_name(name: str) -> str:
    name = Path(name.replace("\\", "/")).name.strip().replace("\x00", "")
    return (name or "file")[:200]


def sniff_type(name: str, data: bytes) -> str:
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise FileError(
            f"{ext or 'That file type'} files can't be uploaded. Use photos, PDFs, Office files, CSV or video."
        )
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if ext == ".heic":
        ctype = "image/heic"
    if ctype in IMAGE_TYPES:
        from PIL import Image

        try:
            with Image.open(io.BytesIO(data)) as im:
                fmt = (im.format or "").upper()
        except Exception as e:
            raise FileError("That image looks damaged. Try saving it again.") from e
        formats = {
            "PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp", "AVIF": "image/avif",
        }  # fmt: skip
        ctype = formats.get(fmt, "")
        if not ctype:
            raise FileError("That image format isn't supported. Use PNG, JPG, GIF, WebP or AVIF.")
    elif ext == ".psd":
        if not data.startswith(b"8BPS"):
            raise FileError("That Photoshop file looks damaged. Try saving it again.")
        ctype = PSD_TYPE
    return ctype


def save_file(
    org_id: uuid.UUID,
    name: str,
    data: bytes,
    uploaded_by: uuid.UUID | None,
    content_type: str | None = None,
    encrypt: bool = False,
) -> FileObject:
    """Store bytes and create the FileObject (caller commits). Queues a thumbnail for images.

    encrypt=True stores the bytes encrypted at rest (mpro.core.crypto); they're decrypted by `read_bytes()` when sent.
    Encrypted files get no server-side thumbnails or previews (those would be stored in the clear)."""
    if len(data) == 0:
        raise FileError("That file is empty.")
    if len(data) > max_upload_bytes():
        raise FileError(f"Files can be up to {max_upload_bytes() // (1024 * 1024)} MB.", 413)
    name = _clean_name(name)
    ctype = content_type or sniff_type(name, data)
    fid = uuid.uuid4()
    key = f"{org_id}/{utcnow():%Y/%m}/{fid}"
    if encrypt:
        from mpro.core.crypto import encrypt_bytes

        storage().put(key, encrypt_bytes(data))
    else:
        storage().put(key, data)
    f = FileObject(
        id=fid,
        org_id=org_id,
        name=name,
        content_type=ctype,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        storage_key=key,
        uploaded_by_id=uploaded_by,
        encrypted=encrypt,
    )
    db.session.add(f)
    db.session.flush()
    queue_processing(f)
    return f


def read_bytes(f: FileObject, key: str | None = None) -> bytes:
    """The file's contents (or one of its derived keys), decrypted when stored encrypted."""
    data = storage().get(key or f.storage_key)
    if f.encrypted:
        from mpro.core.crypto import decrypt_bytes

        return decrypt_bytes(data)
    return data


OFFICE_PREVIEW_TYPES = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
)


def queue_processing(f: FileObject) -> None:
    """Background work after an upload: thumbnails for images, a flattened preview for PSD files (MP-107)."""
    from mpro.core.jobs import enqueue

    if f.encrypted:
        return
    if f.is_image:
        enqueue("files.thumbnail", {"file_id": str(f.id)}, org_id=f.org_id)
    elif f.content_type == PSD_TYPE or f.content_type in OFFICE_PREVIEW_TYPES and f.size > 2 * 1024 * 1024:
        enqueue("files.preview", {"file_id": str(f.id)}, org_id=f.org_id)


def save_file_stream(
    org_id: uuid.UUID,
    name: str,
    stream: Any,
    uploaded_by: uuid.UUID | None,
    org: Any = None,
    max_bytes: int | None = None,
) -> FileObject:
    """Like save_file, but reads the upload in chunks (uploads up to 150 MB, MP-109). `max_bytes` lowers the limit
    (anonymous portal uploads). Caller commits."""
    name = _clean_name(name)
    head = stream.read(256 * 1024)
    if not head:
        raise FileError("That file is empty.")
    ctype = sniff_type(name, head)
    stream.seek(0)
    fid = uuid.uuid4()
    key = f"{org_id}/{utcnow():%Y/%m}/{fid}"
    limit = max_upload_bytes(org)
    if max_bytes is not None:
        limit = min(limit, max_bytes)
    size, digest = storage().put_stream(key, stream, limit)
    f = FileObject(
        id=fid, org_id=org_id, name=name, content_type=ctype, size=size, sha256=digest, storage_key=key,
        uploaded_by_id=uploaded_by,
    )  # fmt: skip
    db.session.add(f)
    db.session.flush()
    queue_processing(f)
    return f


def attach(f: FileObject, entity_type: str, entity_id: uuid.UUID, role: str = "file") -> FileLink:
    n = len(links_for(entity_type, entity_id))
    link = FileLink(org_id=f.org_id, file_id=f.id, entity_type=entity_type, entity_id=entity_id, role=role, sort=n)
    db.session.add(link)
    return link


def links_for(entity_type: str, entity_id: uuid.UUID, roles: set[str] | None = None) -> list[FileLink]:
    q = (
        select(FileLink)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(FileLink.entity_type == entity_type, FileLink.entity_id == entity_id, FileObject.deleted_at.is_(None))
        .order_by(FileLink.sort, FileLink.created_at)
    )
    if roles:
        q = q.where(FileLink.role.in_(roles))
    return list(db.session.scalars(q).all())


def links_for_many(entity_type: str, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[FileLink]]:
    if not ids:
        return {}
    rows = db.session.scalars(
        select(FileLink)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(FileLink.entity_type == entity_type, FileLink.entity_id.in_(ids), FileObject.deleted_at.is_(None))
        .order_by(FileLink.sort, FileLink.created_at)
    ).all()
    out: dict[uuid.UUID, list[FileLink]] = {}
    for r in rows:
        out.setdefault(r.entity_id, []).append(r)
    return out


def file_dict(f: FileObject, role: str | None = None, link_id: uuid.UUID | None = None) -> dict[str, Any]:
    return {
        "id": str(f.id),
        "link_id": str(link_id) if link_id else None,
        "name": f.name,
        "content_type": f.content_type,
        "size": f.size,
        "is_image": f.is_image,
        "role": role,
        "url": f"/api/v1/files/{f.id}",
        "thumb_url": f"/api/v1/files/{f.id}/thumb" if f.is_image or f.thumb_key else None,
        "width": f.width,
        "height": f.height,
        "created_at": iso(f.created_at),
    }


def link_dict(link: FileLink) -> dict[str, Any]:
    return file_dict(link.file, link.role, link.id)


def can_view_file(f: FileObject) -> bool:
    """A file is visible if the person can see any record it's attached to (or uploaded it)."""
    if g.user is not None and f.uploaded_by_id == g.user.id:
        return True
    links = db.session.scalars(select(FileLink).where(FileLink.file_id == f.id)).all()
    for link in links:
        acc = _entities.get(link.entity_type)
        if acc and acc.can_view(link.entity_id):
            return True
    return bool(db.session.scalar(select(Export.id).where(Export.file_id == f.id, Export.user_id == g.user.id)))


# ---- thumbnails ------------------------------------------------------------------------------
def make_thumbnail(f: FileObject, size: int = 480) -> None:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 60_000_000  # refuse decompression bombs
    if f.encrypted:
        return
    data = storage().get(f.storage_key)
    with Image.open(io.BytesIO(data)) as im:
        f.width, f.height = im.size
        im2 = ImageOps.exif_transpose(im)
        im2.thumbnail((size, size))
        if im2.mode not in ("RGB", "L"):
            bg = Image.new("RGB", im2.size, (255, 255, 255))
            bg.paste(im2, mask=im2.convert("RGBA").split()[-1])
            im2 = bg
        out = io.BytesIO()
        im2.convert("RGB").save(out, "JPEG", quality=82, optimize=True)
    key = f.storage_key + ".thumb.jpg"
    storage().put(key, out.getvalue())
    f.thumb_key = key


# ---- exports (Download Center) ---------------------------------------------------------------
Exporter = Callable[[Export], tuple[str, bytes, str]]  # -> filename, data, content type
_exporters: dict[str, Exporter] = {}


def exporter(kind: str) -> Callable[[Exporter], Exporter]:
    def deco(fn: Exporter) -> Exporter:
        _exporters[kind] = fn
        return fn

    return deco


def request_export(org_id: uuid.UUID, user_id: uuid.UUID, kind: str, title: str, params: dict[str, Any]) -> Export:
    from mpro.core.jobs import enqueue

    if kind not in _exporters:
        raise FileError("Unknown export.", 400)
    ex = Export(org_id=org_id, user_id=user_id, kind=kind, title=title[:300], params=params)
    db.session.add(ex)
    db.session.flush()
    enqueue("exports.run", {"export_id": str(ex.id)}, org_id=org_id, max_attempts=2)
    return ex


def export_dict(ex: Export) -> dict[str, Any]:
    return {
        "id": str(ex.id),
        "kind": ex.kind,
        "title": ex.title,
        "status": ex.status,
        "error": ex.error,
        "file": file_dict(ex.file) if ex.file else None,
        "created_at": iso(ex.created_at),
        "finished_at": iso(ex.finished_at),
        "expires_at": iso(ex.expires_at),
    }


def _register_jobs() -> None:
    from mpro.core.jobs import job, periodic

    @job("files.thumbnail")
    def _thumb(payload: dict[str, Any]) -> None:
        f = db.session.get(FileObject, uuid.UUID(payload["file_id"]))
        if f is None or f.deleted_at is not None or not f.is_image:
            return
        try:
            make_thumbnail(f)
        except Exception:  # a broken image gets no thumbnail; the original still downloads
            log.warning("Thumbnail failed for %s", f.id, exc_info=True)
        db.session.commit()

    @job("exports.run")
    def _run_export(payload: dict[str, Any]) -> None:
        ex = db.session.get(Export, uuid.UUID(payload["export_id"]))
        if ex is None or ex.status == "ready":
            return
        try:
            name, data, ctype = _exporters[ex.kind](ex)
            f = save_file(ex.org_id, name, data, ex.user_id, content_type=ctype)
            ex.file_id, ex.status = f.id, "ready"
        except Exception as e:
            db.session.rollback()
            ex = db.session.get(Export, uuid.UUID(payload["export_id"])) or ex
            friendly = str(e) if isinstance(e, (ValueError, PermissionError, FileError)) else ""
            ex.status, ex.error = "failed", (friendly or "Something went wrong preparing this export. Try again.")[:500]
            log.exception("Export %s failed", ex.id)
        ex.finished_at = utcnow()
        db.session.commit()

    @job("exports.cleanup")
    def _cleanup(_: dict[str, Any]) -> None:
        old = db.session.scalars(select(Export).where(Export.expires_at < utcnow())).all()
        for ex in old:
            if ex.file is not None:
                storage().delete(ex.file.storage_key)
                ex.file.deleted_at = utcnow()
            db.session.delete(ex)
        db.session.commit()

    periodic("exports.cleanup", timedelta(hours=6))


_register_jobs()
