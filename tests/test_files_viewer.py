# ruff: noqa: E501  (OOXML fixtures read better on one line)
"""File viewer previews, floor plan drawings and work order cover pictures (0.4.0: MP-107, MP-110, MP-112)."""

from __future__ import annotations

import io
import struct
import zipfile
from typing import Any

from tests.conftest import Api
from tests.test_assets import loc, other_org, upload
from tests.test_work_orders import PNG_1PX, login

API = "/api/v1"


def _psd(w: int = 4, h: int = 3) -> bytes:
    """A minimal RGB Photoshop file with only the merged image (what Pillow flattens)."""
    head = b"8BPS" + struct.pack(">H", 1) + b"\0" * 6 + struct.pack(">HIIHH", 3, h, w, 8, 3)
    return head + struct.pack(">I", 0) * 3 + struct.pack(">H", 0) + bytes([255] * w * h) + bytes(w * h) + bytes(w * h)


def _docx(body_xml: str, rels: str = "") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        z.writestr(
            "word/_rels/document.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + rels
            + "</Relationships>",
        )
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
            + body_xml
            + "</w:body></w:document>",
        )
    return buf.getvalue()


def _xlsx() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Parts"
    ws.append(["Part", "Qty"])
    ws.append(["Belt", 4])
    ws.append(['=HYPERLINK("https://evil.example")', None])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _preview(api: Api, fid: str) -> dict[str, Any]:
    r = api.get(f"{API}/files/{fid}/preview")
    assert r.status_code == 200, r.json
    return r.json  # type: ignore[no-any-return]


def test_previews_by_kind(admin: Api) -> None:
    assert _preview(admin, upload(admin))["kind"] == "image"
    p = _preview(admin, upload(admin, "manual.pdf", b"%PDF-1.4\n%%EOF\n"))
    assert p["kind"] == "pdf" and p["url"].startswith("/api/v1/files/")
    assert _preview(admin, upload(admin, "clip.mp4", b"\0\0\0\x18ftypmp42"))["kind"] == "video"
    assert _preview(admin, upload(admin, "clip.webm", b"\x1aE\xdf\xa3"))["kind"] == "video"
    t = _preview(admin, upload(admin, "notes.txt", b"Torque 45 Nm\nCheck belt"))
    assert t["kind"] == "text" and "Torque" in t["text"]
    c = _preview(admin, upload(admin, "parts.csv", b"Part;Qty\nBelt;4\nFilter;2\n"))
    assert c["kind"] == "table" and c["sheets"][0]["rows"][1] == ["Belt", "4"]
    x = _preview(admin, upload(admin, "parts.xlsx", _xlsx()))
    assert x["kind"] == "table" and x["sheets"][0]["name"] == "Parts" and x["sheets"][0]["rows"][1] == ["Belt", "4"]
    assert _preview(admin, upload(admin, "old.doc", b"\xd0\xcf\x11\xe0junk"))["kind"] == "none"
    broken = _preview(admin, upload(admin, "broken.docx", b"not a zip"))
    assert broken["kind"] == "none" and "Download" in broken["reason"]


def test_docx_preview_is_sanitised(admin: Api) -> None:
    body = (
        "<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; Lockout steps</w:t></w:r></w:p>"
        '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>'
        '<w:p><w:hyperlink r:id="rId10"><w:r><w:t>vendor site</w:t></w:r></w:hyperlink></w:p>'
    )
    rels = (
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        'Target="javascript:alert(document.cookie)" TargetMode="External"/>'
        '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        'Target="https://vendor.example/manual" TargetMode="External"/>'
    )
    p = _preview(admin, upload(admin, "sop.docx", _docx(body, rels)))
    assert p["kind"] == "html"
    html = p["html"]
    assert "Lockout steps" in html and "<script" not in html and "javascript:" not in html
    assert 'href="https://vendor.example/manual"' in html and "noopener" in html


def test_sanitizer_strips_dangerous_markup() -> None:
    from mpro.core.previews import sanitize_html

    dirty = (
        '<p onclick="x()" style="color:red">Hi<img src="https://tracker.example/p.gif" onerror="x()">'
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok"><img src="data:text/html;base64,PHNjcmlwdD4=">'
        '<a href="javascript:x()">bad</a><iframe src="https://evil.example"></iframe><style>*{}</style></p>'
    )
    clean = sanitize_html(dirty)
    for bad in ("onclick", "style", "tracker.example", "onerror", "javascript:", "<iframe", "<style", "data:text/html"):
        assert bad not in clean, bad
    assert 'src="data:image/png;base64' in clean


def test_psd_preview_and_avif(app: Any, admin: Api) -> None:
    fid = upload(admin, "plan.psd", _psd())
    p = _preview(admin, fid)
    assert p["kind"] == "image" and p["url"].endswith("/rendered")  # jobs run inline in tests
    r = admin.get(p["url"])
    assert r.status_code == 200 and r.data[:8] == b"\x89PNG\r\n\x1a\n"
    assert admin.get(f"{API}/files/{fid}/thumb").status_code == 200
    assert admin.post(f"{API}/files", None).status_code in (400, 422)
    bad = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(b"nope"), "x.psd")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert bad.status_code == 422
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "blue").save(buf, "AVIF")
    aid = upload(admin, "photo.avif", buf.getvalue())
    a = _preview(admin, aid)
    assert a["kind"] == "image"
    assert admin.get(f"{API}/files/{aid}").headers["Content-Type"] == "image/avif"
    t = admin.get(f"{API}/files/{aid}/thumb")
    assert t.status_code == 200 and t.headers["Content-Type"] == "image/jpeg"


def test_preview_permissions(app: Any, admin: Api) -> None:
    fid = upload(admin, "notes.txt", b"secret")
    other = other_org(app)
    assert other.get(f"{API}/files/{fid}/preview").status_code == 404
    assert other.get(f"{API}/files/{fid}/rendered").status_code == 404


# ---- floor plan drawings ---------------------------------------------------------------------------
def _plan(admin: Api) -> tuple[dict[str, Any], dict[str, Any]]:
    plant = loc(admin)
    fid = upload(admin, "plan.png")
    fp = admin.post(f"{API}/locations/{plant['id']}/floor-plans", {"name": "Ground floor", "file_id": fid}).json
    return plant, fp


def test_floor_plan_annotations(app: Any, admin: Api) -> None:
    plant, fp = _plan(admin)
    room = loc(admin, "Room 2", parent_id=plant["id"])
    url = f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/annotations"
    assert admin.get(url).json == {"annotations": {"shapes": []}, "version": 0}
    shapes = [
        {
            "id": "r1",
            "type": "rect",
            "x": 0.1,
            "y": 0.1,
            "w": 0.2,
            "h": 0.1,
            "stroke": "#1b5bd4",
            "fill": "#1b5bd4",
            "fill_opacity": 0.2,
            "location_id": room["id"],
            "label": "Room 2",
        },
        {"id": "l1", "type": "arrow", "points": [[0.1, 0.5], [0.4, 0.5]], "stroke": "#c4302b", "stroke_width": 3},
        {"id": "t1", "type": "text", "x": 0.5, "y": 0.5, "text": "Exit", "font_size": 18},
        {"id": "g1", "type": "group", "children": ["l1", "t1"]},
    ]
    r = admin.put(url, {"annotations": {"shapes": shapes}, "version": 0}) if hasattr(admin, "put") else None
    if r is None:
        r = admin.c.put(url, json={"annotations": {"shapes": shapes}, "version": 0}, headers=admin._h())
    assert r.status_code == 200, r.json
    assert r.json["version"] == 1 and r.json["annotations"]["shapes"][0]["location_id"] == room["id"]
    stale = admin.c.put(url, json={"annotations": {"shapes": []}, "version": 0}, headers=admin._h())
    assert stale.status_code == 409
    detail = admin.get(f"{API}/locations/{plant['id']}").json
    assert detail["floor_plans"][0]["annotations_version"] == 1
    for bad in (
        [{"id": "x", "type": "blob"}],
        [{"id": "x", "type": "rect", "x": 9, "y": 0, "w": 0.1, "h": 0.1}],
        [{"id": "x", "type": "rect", "x": 0, "y": 0, "w": 0.1, "h": 0.1, "stroke": "red;background:url(x)"}],
        [{"id": "x", "type": "group", "children": ["nope", "x"]}],
        [{"id": "x", "type": "line", "points": [[0, 0]]}],
    ):
        assert (
            admin.c.put(url, json={"annotations": {"shapes": bad}, "version": 1}, headers=admin._h()).status_code == 422
        )
    # links must point at this organization's records
    other = other_org(app)
    theirs = other.post(f"{API}/locations", {"name": "Their site"}).json
    link = [{"id": "x", "type": "rect", "x": 0, "y": 0, "w": 0.1, "h": 0.1, "location_id": theirs["id"]}]
    assert admin.c.put(url, json={"annotations": {"shapes": link}, "version": 1}, headers=admin._h()).status_code == 422
    assert other.get(url).status_code == 404
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(url).status_code == 200
    assert viewer.c.put(url, json={"annotations": {"shapes": []}, "version": 1}, headers=viewer._h()).status_code == 403
    hist = admin.get(f"{API}/locations/{plant['id']}/history").json["items"]
    assert any(h["type"] == "location.floor_plan_edited" for h in hist)


# ---- work order cover pictures ---------------------------------------------------------------------
def test_work_order_cover(app: Any, admin: Api) -> None:
    first = upload(admin, "first.png")
    second = upload(admin, "second.png", PNG_1PX)
    manual = upload(admin, "manual.pdf", b"%PDF-1.4\n%%EOF\n")
    wo = admin.post(f"{API}/work-orders", {"title": "Fix door", "file_ids": [first, second, manual]}).json
    assert wo["cover_url"] == f"/api/v1/files/{first}/thumb"
    listed = admin.get(f"{API}/work-orders?tab=all&q=Fix%20door").json["items"][0]
    assert listed["cover_url"] == f"/api/v1/files/{first}/thumb"
    put = lambda body: admin.c.put(f"{API}/work-orders/{wo['id']}/cover", json=body, headers=admin._h())  # noqa: E731
    r = put({"file_id": second})
    assert r.status_code == 200 and r.json["cover_url"] == f"/api/v1/files/{second}/thumb"
    assert put({"file_id": manual}).status_code == 422  # not a picture
    elsewhere = upload(admin, "elsewhere.png")
    assert put({"file_id": elsewhere}).status_code == 422  # not on this work order
    assert put({"file_id": None}).json["cover_url"] == f"/api/v1/files/{first}/thumb"
    bare = admin.post(f"{API}/work-orders", {"title": "No pictures"}).json
    assert bare["cover_url"] is None
    viewer = login(app, "quinn.foster@example.com")
    assert (
        viewer.c.put(f"{API}/work-orders/{wo['id']}/cover", json={"file_id": second}, headers=viewer._h()).status_code
        == 403
    )
