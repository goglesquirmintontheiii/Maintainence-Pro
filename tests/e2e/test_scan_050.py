# ruff: noqa: E501
"""Scan actions on a phone (0.6.0, MP-097): open a printed code, act on it, see it in the scan history."""

from __future__ import annotations

import os
from typing import Any

from tests.e2e.test_ui import pytestmark, server  # noqa: F401  (fixtures)

API = """async ([method, path, body]) => {
  const s = await (await fetch('/api/v1/auth/session')).json();
  const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
    body: body === null ? undefined : JSON.stringify(body) });
  return r.json();
}"""


def test_scan_an_asset_code_on_a_phone(server: str) -> None:  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("MPRO_CHROMIUM") or None)
        ctx = b.new_context(
            viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True
        )
        pg: Any = ctx.new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(server + "/login")
        pg.get_by_label("Email").fill("admin@example.com")
        pg.get_by_label("Password").fill("mpro-demo-123")
        pg.get_by_role("button", name="Sign in").click()
        pg.wait_for_url(server + "/")
        assets = pg.evaluate(API, ["GET", "/assets?q=Air%20Compressor%201&per_page=5", None])
        asset = next(a for a in assets["items"] if a["name"] == "Air Compressor 1")
        code = pg.evaluate(API, ["POST", "/qr-codes", {"entity_type": "asset", "entity_id": asset["id"]}])["value"]

        pg.goto(f"{server}/q/{code}")
        sheet = pg.get_by_label("Scan result")
        sheet.get_by_role("heading", name="Air Compressor 1").wait_for()
        for name in ("Open the asset", "Start or continue its work order", "Report a problem"):
            assert sheet.get_by_role("button", name=name).is_visible()
        box = sheet.get_by_role("button", name="Open the asset").bounding_box()
        assert box and box["height"] >= 44  # gloves (G-18)
        sheet.get_by_role("button", name="Start or continue its work order").click()
        pg.wait_for_url("**/work-orders**")

        pg.goto(server + "/scan/history")
        pg.get_by_role("heading", name="Scan history").wait_for()
        pg.get_by_text("started work on").first.wait_for()  # the history reads in past tense (0.6.0)
        assert pg.get_by_role("link", name="Air Compressor 1").count() >= 2  # the scan and the action

        # signed out, a code only leads to the request form (off by default: sign in)
        anon = b.new_context(viewport={"width": 390, "height": 844}).new_page()
        anon.goto(f"{server}/q/{code}")
        anon.get_by_role("heading", name="Sign in to open this code").wait_for()
        b.close()
        assert not errors, errors
