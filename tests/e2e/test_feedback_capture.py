"""TEMPORARY: browser test for the Ctrl+Shift+F feedback capture (0.4.2). Delete with the tool, by 1.9.0."""

from __future__ import annotations

import base64
import gzip
import json
from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)

NOTE = "What's the bug, feature, change or note?"


def _decode(code: str) -> dict[str, Any]:
    assert code.startswith("MPRO-FB1:"), code[:20]
    return json.loads(gzip.decompress(base64.b64decode(code[len("MPRO-FB1:") :])))  # type: ignore[no-any-return]


def test_feedback_capture_element_and_area(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    page.set_viewport_size({"width": 1280, "height": 860})
    page.goto(server + "/work-orders")
    title = page.get_by_text("Forklift 3 hydraulic leak").first
    title.wait_for()
    page.keyboard.press("Control+Shift+F")
    page.get_by_text("Feedback mode").wait_for()

    box = title.bounding_box()
    assert box
    page.mouse.move(box["x"] + 8, box["y"] + 6)
    page.mouse.click(box["x"] + 8, box["y"] + 6)
    page.get_by_label(NOTE).fill("Rename this\n\nDetails")
    page.get_by_role("radio", name="Change").click()
    page.get_by_role("button", name="Create code").click()
    el = _decode(page.get_by_label("Capture code").input_value())
    assert el["kind"] == "change" and el["target"] == "element" and el["text"].startswith("Rename this")
    assert el["element"]["name"] == "Forklift 3 hydraulic leak"
    assert el["element"]["within"]["href"].startswith("/work-orders/")
    assert el["page"]["path"] == "/work-orders" and el["app"]["version"]

    page.get_by_role("button", name="New capture").click()
    page.mouse.move(300, 120)
    page.mouse.down()
    page.mouse.move(800, 480, steps=10)
    page.mouse.up()
    page.get_by_label(NOTE).fill("Cramped rows")
    page.keyboard.press("Control+Enter")
    area = _decode(page.get_by_label("Capture code").input_value())
    assert area["target"] == "area" and area["area"]["w"] == 500
    assert area["shot"]["data"].startswith("data:image/") and area["shot"]["w"] > 0
    assert area["elements"] and all("box" in e and "n" in e for e in area["elements"])

    page.keyboard.press("Escape")
    assert page.locator("[data-mpro-feedback] .fb-panel").count() == 0
