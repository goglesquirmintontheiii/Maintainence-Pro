# ruff: noqa: E501
"""Browser checks for the 0.6.0 requests from testing 0.5: part statuses and pictures (MP-131), floor plan label
styles (MP-132), the user ID on the profile (MP-133) and the vendor's PO page (r261). Needs a built frontend."""

from __future__ import annotations

import base64
import re
from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwJfEYCY2liH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgETwADioPro9QAAAABJRU5ErkJggg=="
)


def api(pg: Any, method: str, path: str, body: Any = None) -> Any:
    return pg.evaluate(
        """async ([method, path, body]) => {
            const s = await (await fetch('/api/v1/auth/session')).json();
            const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
              body: body === null ? undefined : JSON.stringify(body) });
            return r.status === 204 ? null : await r.json();
        }""",
        [method, path, body],
    )


def upload_png(pg: Any) -> str:
    return str(
        pg.evaluate(
            """async (b64) => {
                const s = await (await fetch('/api/v1/auth/session')).json();
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'image/png' }), 'plan.png');
                const r = await fetch('/api/v1/files', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': s.csrf } });
                return (await r.json()).id;
            }""",
            base64.b64encode(PNG).decode(),
        )
    )


def test_profile_shows_user_id(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    me = api(page, "GET", "/auth/session")["user"]["id"]
    page.goto(server + "/profile")
    page.get_by_label("User ID").first.wait_for()
    assert page.get_by_label("User ID").first.inner_text() == me
    page.get_by_role("button", name="Copy user ID").first.wait_for()


def test_part_statuses_and_picture(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    parts = api(page, "GET", "/parts?per_page=50&q=Ball%20bearing%206205")["items"]
    pid = parts[0]["id"]
    page.goto(server + f"/parts/{pid}")
    page.get_by_role("button", name=re.compile("^(Add|Change) picture$")).first.wait_for()
    page.get_by_label("Choose a part picture").first.set_input_files(
        {"name": "bearing.png", "mimeType": "image/png", "buffer": PNG}
    )
    page.get_by_role("button", name="Save photo").click()
    page.get_by_text("Picture saved").wait_for()
    page.get_by_role("img", name=re.compile("^Picture of ")).wait_for()
    # the WO "Add parts" dialog only offers Used / Planned / Reserved
    wo = api(page, "POST", "/work-orders", {"title": "E2E: parts statuses"})
    page.goto(server + f"/work-orders/{wo['id']}")
    page.get_by_role("heading", name="E2E: parts statuses").wait_for()
    try:
        page.get_by_role("button", name="Add parts").first.click(timeout=15000)
    except Exception:
        page.screenshot(
            path="/tmp/claude-0/-home-claude/a6c7f219-40df-576e-87a0-bb15ad28a918/scratchpad/f6dbg.png", full_page=True
        )
        raise
    page.get_by_role("dialog", name="Add parts").wait_for()
    page.get_by_role("dialog", name="Add parts").get_by_role("button", name="Parts", exact=True).click()
    page.get_by_role("option", name=re.compile("Ball bearing 6205")).first.click()
    sel = page.get_by_role("combobox", name=re.compile("^Status of ")).first
    sel.wait_for(state="attached")
    assert sel.locator("option").all_inner_texts() == ["Used", "Planned", "Reserved"]


def test_floor_plan_label_styles_render(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    loc = api(page, "POST", "/locations", {"name": "E2E plant"})
    fid = upload_png(page)
    fp = api(page, "POST", f"/locations/{loc['id']}/floor-plans", {"name": "Ground", "file_id": fid})
    shapes = [
        {
            "id": "t1",
            "type": "text",
            "x": 0.1,
            "y": 0.1,
            "text": "Boiler",
            "font_size": 40,
            "stroke": "#334155",
            "font": "serif",
            "bold": False,
            "italic": True,
            "outline": "#d97706",
            "outline_width": 5,
        }
    ]
    r = api(
        page,
        "PUT",
        f"/locations/{loc['id']}/floor-plans/{fp['id']}/annotations",
        {"annotations": {"shapes": shapes}, "version": 0},
    )
    assert r["version"] == 1, r
    page.goto(server + f"/locations/{loc['id']}/floor-plans")
    t = page.locator(".fp-preview svg text").first
    t.wait_for()
    look = t.evaluate(
        "el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontStyle, el.getAttribute('stroke'), el.getAttribute('font-weight')]; }"
    )
    assert "Georgia" in look[0] and look[1] == "italic" and look[2] == "#d97706" and look[3] == "400", look


def test_vendor_po_page(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    v = api(page, "POST", "/vendors", {"name": "E2E Supply", "email": "orders@e2e.example"})
    po = api(
        page,
        "POST",
        "/purchase-orders",
        {
            "title": "E2E order",
            "vendor_id": v["id"],
            "lines": [{"description": "Gloves", "quantity": "2", "unit_cost": "10"}],
        },
    )
    if po["status"] != "approved":
        api(page, "POST", f"/purchase-orders/{po['id']}/approve", {})
    sent = api(page, "POST", f"/purchase-orders/{po['id']}/send", {"to": ["orders@e2e.example"]})
    assert sent.get("sent"), sent
    mails = api(page, "GET", "/outbox")["items"]
    body = next(m["body"] for m in mails if m["to"] == "orders@e2e.example")
    path = re.search(r"/v/[A-Za-z0-9_-]+", body).group(0)  # type: ignore[union-attr]
    ctx = page.context.browser.new_context()
    vp = ctx.new_page()
    vp.goto(server + path)
    vp.get_by_role("heading", name="E2E order").wait_for()
    vp.get_by_role("button", name="Propose a delivery date").click()
    vp.get_by_label("Your name").fill("Pat")
    vp.get_by_label("We can deliver by").fill("2030-01-15")
    vp.get_by_role("button", name="Send answer").click()
    vp.get_by_role("status").get_by_text("Proposed a delivery date by Pat").wait_for()
    ctx.close()
    page.goto(server + f"/purchase-orders/{po['id']}")
    page.get_by_role("region", name="Vendor's answer").get_by_text("Can deliver by").wait_for()
