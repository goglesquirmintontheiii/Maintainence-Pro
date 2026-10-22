"""In-page file previews (MP-107): what the file viewer shows instead of sending people to the raw file.

GET /api/v1/files/<id>/preview answers with a `kind` the viewer knows how to show:
- image / video / audio / pdf: `url` of our own file endpoint (same origin, permission-checked)
- text: up to 200 KB of text; table: CSV or XLSX rows (capped); html: DOCX converted with mammoth and
  sanitised with nh3 (no scripts, styles, event handlers or links to other origins; images only as data: URIs)
- image for PSD files: a flattened PNG made in the background (FileObject.preview_id), shown via /rendered
- none: download only (old .doc, HEIC, …)
"""

from __future__ import annotations

import csv
import io
import json
import logging
import uuid
import zipfile
from typing import Any

from apiflask import abort
from flask import Response, request
from sqlalchemy import select

from mpro.core.files import PSD_TYPE, FileError, FileObject, make_thumbnail, save_file, storage
from mpro.core.files_api import _file, _send, bp
from mpro.core.tenancy import require
from mpro.extensions import db

log = logging.getLogger(__name__)

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_DOC_BYTES = 25 * 1024 * 1024  # bigger documents are download-only
MAX_TEXT = 200_000
MAX_ROWS, MAX_COLS, MAX_SHEETS = 300, 40, 5
# Zip-bomb guard for DOCX/XLSX (both are zip files), checked before any parser touches the data (#3).
MAX_UNZIPPED = 50 * 1024 * 1024  # total uncompressed size
MAX_MEMBER = 50 * 1024 * 1024  # any single member
MAX_RATIO = 100  # uncompressed / compressed, for members bigger than RATIO_FLOOR
RATIO_FLOOR = 1024 * 1024
MAX_MEMBERS = 5000
BACKGROUND_BYTES = 2 * 1024 * 1024  # bigger documents are rendered by a background job
CACHE_TYPE = "application/vnd.mpro.preview+json"


class UnsafeArchive(ValueError):
    pass


def check_zip(data: bytes) -> None:
    """Refuse archives that would expand to more than we are willing to parse."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise UnsafeArchive("not a zip file") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MEMBERS:
            raise UnsafeArchive("too many members")
        total = 0
        for i in infos:
            if i.file_size > MAX_MEMBER:
                raise UnsafeArchive("member too large")
            if i.file_size > RATIO_FLOOR and i.file_size > MAX_RATIO * max(i.compress_size, 1):
                raise UnsafeArchive("compression ratio too high")
            total += i.file_size
            if total > MAX_UNZIPPED:
                raise UnsafeArchive("archive too large when unpacked")


ALLOWED_TAGS = {
    "p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "img", "a", "hr",
}  # fmt: skip
ALLOWED_ATTRS = {"img": {"src", "alt"}, "a": {"href"}, "td": {"colspan", "rowspan"}, "th": {"colspan", "rowspan"}}


def preview_kind(f: FileObject) -> str:
    ct = f.content_type
    if f.is_image:
        return "image"
    if ct == PSD_TYPE:
        return "image" if f.preview_id else "pending"
    if ct.startswith("video/"):
        return "video"
    if ct.startswith("audio/"):
        return "audio"
    if ct == "application/pdf":
        return "pdf"
    if ct == "text/csv" or f.name.lower().endswith(".csv"):
        return "table"
    if ct.startswith("text/"):
        return "text"
    if ct == DOCX:
        return "html"
    if ct == XLSX:
        return "table"
    return "none"


def sanitize_html(html: str) -> str:
    """Allow only simple document markup. Links must be http(s) or mailto; images must be inline data: URIs."""
    import nh3

    def attr_filter(tag: str, attr: str, value: str) -> str | None:
        v = value.strip()
        if tag == "img" and attr == "src":
            return (
                v
                if v.lower().startswith(("data:image/png", "data:image/jpeg", "data:image/gif", "data:image/webp"))
                else None
            )
        if tag == "a" and attr == "href":
            return v if v.lower().startswith(("https://", "http://", "mailto:")) else None
        return v

    return nh3.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        url_schemes={"http", "https", "mailto", "data"},
        attribute_filter=attr_filter,
        link_rel="noopener noreferrer nofollow",
        strip_comments=True,
    )


def _text(data: bytes) -> tuple[str, bool]:
    truncated = len(data) > MAX_TEXT
    chunk = data[:MAX_TEXT]
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return chunk.decode(enc), truncated
        except UnicodeDecodeError:
            continue
    return chunk.decode("utf-8", "replace"), truncated  # pragma: no cover


def _csv_rows(data: bytes) -> dict[str, Any]:
    text, truncated = _text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows: list[list[str]] = []
    for i, row in enumerate(csv.reader(io.StringIO(text), dialect)):
        if i >= MAX_ROWS:
            truncated = True
            break
        if len(row) > MAX_COLS:
            truncated = True
        rows.append([c[:500] for c in row[:MAX_COLS]])
    return {"sheets": [{"name": "", "rows": rows}], "truncated": truncated}


def _xlsx_rows(data: bytes) -> dict[str, Any]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheets, truncated = [], len(wb.sheetnames) > MAX_SHEETS
    try:
        for ws in wb.worksheets[:MAX_SHEETS]:
            rows: list[list[str]] = []
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i >= MAX_ROWS:
                    truncated = True
                    break
                if len(row) > MAX_COLS:
                    truncated = True
                rows.append(["" if v is None else str(v)[:500] for v in row[:MAX_COLS]])
            while rows and not any(rows[-1]):
                rows.pop()
            sheets.append({"name": ws.title, "rows": rows})
    finally:
        wb.close()
    return {"sheets": sheets, "truncated": truncated}


def _docx_html(data: bytes) -> str:
    import mammoth

    result = mammoth.convert_to_html(io.BytesIO(data))
    return sanitize_html(result.value)


CANT_PREVIEW = {"kind": "none", "reason": "This file can't be previewed. Download it to open it."}
TOO_LARGE = {"kind": "none", "reason": "This file is too large to preview. Download it to open it."}


def is_office(f: FileObject) -> bool:
    return f.content_type in (DOCX, XLSX)


def office_preview(f: FileObject, data: bytes) -> dict[str, Any]:
    """Render a DOCX/XLSX to what the viewer shows (zip-bomb checked first). Never raises."""
    try:
        check_zip(data)
    except UnsafeArchive as e:
        log.warning("Preview refused for %s: %s", f.id, e)
        return dict(TOO_LARGE)
    try:
        if f.content_type == XLSX:
            return {"kind": "table", **_xlsx_rows(data)}
        return {"kind": "html", "html": _docx_html(data)}
    except Exception:  # a damaged document: offer the download instead of failing
        log.warning("Preview failed for %s", f.id, exc_info=True)
        return dict(CANT_PREVIEW)


def cache_office_preview(f: FileObject) -> dict[str, Any]:
    """Render once and keep the result as the file's preview (like a PSD's PNG). Caller commits."""
    out = office_preview(f, storage().get(f.storage_key))
    p = save_file(
        f.org_id, f.name.rsplit(".", 1)[0] + ".preview.json", json.dumps(out).encode(), f.uploaded_by_id,
        content_type=CACHE_TYPE,
    )  # fmt: skip
    f.preview_id = p.id
    return out


def _cached(f: FileObject) -> dict[str, Any] | None:
    p = db.session.get(FileObject, f.preview_id) if f.preview_id else None
    if p is None or p.org_id != f.org_id or p.content_type != CACHE_TYPE:
        return None
    try:
        got = json.loads(storage().get(p.storage_key))
    except Exception:
        log.warning("Cached preview unreadable for %s", f.id, exc_info=True)
        return None
    return got if isinstance(got, dict) else None


def _queue_office_preview(f: FileObject) -> None:
    """Queue the background render unless one is already waiting for this file."""
    from mpro.core.jobs import Job, enqueue

    waiting = db.session.scalars(
        select(Job).where(Job.kind == "files.preview", Job.org_id == f.org_id, Job.status.in_(("queued", "running")))
    ).all()
    if any((j.payload or {}).get("file_id") == str(f.id) for j in waiting):
        return
    enqueue("files.preview", {"file_id": str(f.id)}, org_id=f.org_id)
    db.session.commit()


def render_preview(f: FileObject) -> dict[str, Any]:
    kind = preview_kind(f)
    base = {"id": str(f.id), "name": f.name, "content_type": f.content_type, "size": f.size, "kind": kind}
    url = f"/api/v1/files/{f.id}"
    if kind in ("video", "audio", "pdf"):
        return {**base, "url": url}
    if kind == "image":
        return {**base, "url": f"{url}/rendered" if f.content_type == PSD_TYPE else url}
    if kind in ("none", "pending"):
        return base
    if f.size > MAX_DOC_BYTES:
        return {**base, **TOO_LARGE}
    if is_office(f):
        cached = _cached(f)
        if cached is not None:
            return {**base, **cached}
        if f.size > BACKGROUND_BYTES:
            _queue_office_preview(f)
            cached = _cached(f)  # inline jobs (tests, desktop) finish right away
            if cached is not None:
                return {**base, **cached}
            return {**base, "kind": "pending", "reason": "Preparing a preview… This takes a few seconds."}
        out = cache_office_preview(f)
        db.session.commit()
        return {**base, **out}
    data = storage().get(f.storage_key)
    try:
        if kind == "text":
            text, truncated = _text(data)
            return {**base, "text": text, "truncated": truncated}
        if kind == "table":
            return {**base, **_csv_rows(data)}
    except Exception:  # a damaged document: offer the download instead of failing
        log.warning("Preview failed for %s", f.id, exc_info=True)
    return {**base, **CANT_PREVIEW}


MAX_PSD_PIXELS = 60_000_000


def make_psd_preview(f: FileObject) -> None:
    """Flatten a PSD to PNG (Pillow reads the merged image), store it as the file's preview and thumbnail."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_PSD_PIXELS
    with Image.open(io.BytesIO(storage().get(f.storage_key))) as im:
        w, h = im.size
        if w * h > MAX_PSD_PIXELS:  # refuse before decoding (Pillow only warns up to 2x the limit)
            raise ValueError(f"PSD too large to preview: {w}x{h}")
        im.load()
        f.width, f.height = w, h
        out = io.BytesIO()
        im.convert("RGBA" if "A" in im.mode else "RGB").save(out, "PNG")  # optimize=True is very slow
    p = save_file(
        f.org_id, f.name.rsplit(".", 1)[0] + ".png", out.getvalue(), f.uploaded_by_id, content_type="image/png"
    )
    make_thumbnail(p)
    f.preview_id, f.thumb_key = p.id, p.thumb_key


# ---- endpoints (on the files blueprint) -------------------------------------------------------
@bp.get("/files/<file_id>/preview")
@require("org.view")
def preview(file_id: str) -> dict[str, Any]:
    """What the in-page viewer should show for this file (kind + URL, text, table rows or sanitised HTML)."""
    try:
        return render_preview(_file(file_id))
    except FileError as e:
        abort(e.status, message=e.message)


@bp.get("/files/<file_id>/rendered")
@require("org.view")
def rendered(file_id: str) -> Response:
    """The browser-friendly rendering of a file (e.g. a PSD's flattened PNG)."""
    f = _file(file_id)
    p = db.session.get(FileObject, f.preview_id) if f.preview_id else None
    if p is None or p.org_id != f.org_id:
        abort(404)
    return _send(p, p.storage_key, p.content_type, request.args.get("download") == "1")


def _register_jobs() -> None:
    from mpro.core.jobs import job

    @job("files.preview")
    def _preview(payload: dict[str, Any]) -> None:
        f = db.session.get(FileObject, uuid.UUID(payload["file_id"]))
        if f is None or f.deleted_at is not None or f.preview_id:
            return
        if is_office(f):
            cache_office_preview(f)  # never raises; failures are cached as "can't preview"
        elif f.content_type == PSD_TYPE:
            try:
                make_psd_preview(f)
            except Exception:  # an unreadable PSD keeps working as a download
                log.warning("PSD preview failed for %s", f.id, exc_info=True)
        db.session.commit()


_register_jobs()
