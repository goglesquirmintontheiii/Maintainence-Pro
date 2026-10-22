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
import logging
import uuid
from typing import Any

from apiflask import abort
from flask import Response, request

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
        return {**base, "kind": "none", "reason": "This file is too large to preview. Download it to open it."}
    data = storage().get(f.storage_key)
    try:
        if kind == "text":
            text, truncated = _text(data)
            return {**base, "text": text, "truncated": truncated}
        if kind == "table":
            return {**base, **(_xlsx_rows(data) if f.content_type == XLSX else _csv_rows(data))}
        if kind == "html":
            return {**base, "html": _docx_html(data)}
    except Exception:  # a damaged document: offer the download instead of failing
        log.warning("Preview failed for %s", f.id, exc_info=True)
    return {**base, "kind": "none", "reason": "This file can't be previewed. Download it to open it."}


def make_psd_preview(f: FileObject) -> None:
    """Flatten a PSD to PNG (Pillow reads the merged image), store it as the file's preview and thumbnail."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 60_000_000
    with Image.open(io.BytesIO(storage().get(f.storage_key))) as im:
        im.load()
        f.width, f.height = im.size
        out = io.BytesIO()
        im.convert("RGBA" if "A" in im.mode else "RGB").save(out, "PNG", optimize=True)
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
        if f is None or f.deleted_at is not None or f.content_type != PSD_TYPE or f.preview_id:
            return
        try:
            make_psd_preview(f)
        except Exception:  # an unreadable PSD keeps working as a download
            log.warning("PSD preview failed for %s", f.id, exc_info=True)
        db.session.commit()


_register_jobs()
