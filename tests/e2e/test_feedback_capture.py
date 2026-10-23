"""TEMPORARY: browser test for the Ctrl+Shift+F feedback capture (0.4.2). Delete with the tool, by 1.9.0."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from decode_capture import decode  # noqa: E402

NOTE = "What's the bug, feature, change or note?"


def _code(pg: Any) -> dict[str, Any]:
    box = pg.get_by_label("Capture code")
    box.wait_for()
    code = box.input_value()
    assert code.startswith("MPRO-FB2:"), code[:20]
    cap, img = decode(code)
    if cap.get("shot"):
        assert img and len(img) == cap["shot"]["bytes"]
    return cap


def test_feedback_capture_element_and_area(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    page.set_viewport_size({"width": 1280, "height": 860})
    page.goto(server + "/work-orders?view=todo")
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
    el = _code(page)
    assert el["v"] == 2 and el["kind"] == "change" and el["target"] == "element"
    assert el["text"].startswith("Rename this")
    assert el["element"]["name"] == "Forklift 3 hydraulic leak"
    assert el["element"]["within"]["href"].startswith("/work-orders/")
    assert el["page"]["path"].startswith("/work-orders") and el["app"]["version"]

    page.get_by_role("button", name="New capture").click()
    page.mouse.move(300, 120)
    page.mouse.down()
    page.mouse.move(800, 480, steps=10)
    page.mouse.up()
    page.get_by_label(NOTE).fill("Cramped rows")
    page.keyboard.press("Control+Enter")
    area = _code(page)
    assert area["target"] == "area" and area["area"]["w"] == 500
    assert area["shot"]["type"].startswith("image/") and area["shot"]["w"] > 0
    assert area["elements"] and all("box" in e and "n" in e for e in area["elements"])

    # Esc closes the panel even though focus left it when the code was made
    page.keyboard.press("Escape")
    assert page.locator("[data-mpro-feedback] .fb-panel").count() == 0


def test_feedback_capture_table_cell(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    page.goto(server + "/categories")
    cell = page.locator("table tbody tr").nth(1).locator("td").nth(2)
    cell.wait_for()
    page.keyboard.press("Control+Shift+F")
    b = cell.bounding_box()
    assert b
    page.mouse.click(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    page.get_by_label(NOTE).fill("Cell")
    page.keyboard.press("Control+Enter")
    e = _code(page)["element"]
    assert e["column"] == "Work orders"
    assert e["row"] == page.locator("table tbody tr").nth(1).locator("td").first.inner_text().strip()
