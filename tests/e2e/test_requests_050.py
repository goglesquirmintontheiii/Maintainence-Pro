# ruff: noqa: E501
"""Browser checks for the 0.5.0 requests from testing 0.4 (MP-121 bug fixes, MP-125/126 layout). Needs a built frontend."""

from __future__ import annotations

from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)


def _contrast_ok(pg: Any, selector: str) -> bool:
    """Text colour differs clearly from the background of the element (light or dark theme)."""
    return bool(
        pg.eval_on_selector(
            selector,
            """el => {
              const c = getComputedStyle(el).color, b = getComputedStyle(el).backgroundColor;
              const n = s => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
              const L = a => { const [r, g, bl] = a.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }); return .2126 * r + .7152 * g + .0722 * bl };
              const x = L(n(c)), y = L(n(b));
              return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) >= 4.5;
            }""",
        )
    )


def check_priority_seg_fits(pg: Any, base: str) -> None:
    """MP-121: the priority control's dark track is no wider than its buttons."""
    pg.goto(base + "/work-orders?view=todo&new=1")
    seg = pg.get_by_role("radiogroup", name="Priority")
    seg.wait_for()
    track = seg.bounding_box()
    btns = [b.bounding_box() for b in seg.get_by_role("radio").all()]
    right = max(b["x"] + b["width"] for b in btns)
    assert track["x"] + track["width"] - right < 12, (track, right)


def check_discard_dialog_readable(pg: Any, base: str) -> None:
    """MP-121: dialogs (e.g. the floor plan 'Discard unsaved changes?') use the normal text colour, not the viewer's."""
    pg.goto(base + "/work-orders?view=todo&new=1")
    pg.locator(".modal, .drawer").first.wait_for()
    pg.evaluate(
        'document.body.insertAdjacentHTML(\'beforeend\', \'<div class="viewer" id="t-viewer"><div class="modal" id="t-modal">Your drawing has changes</div></div>\')'
    )
    assert _contrast_ok(pg, "#t-modal")


def check_upcoming_and_phone_layout(pg: Any, base: str) -> None:
    """MP-125/126: Upcoming tab with a day window; on a phone Calendar – Search – Filter, then To Do · Done · Upcoming."""
    pg.set_viewport_size({"width": 375, "height": 812})
    pg.goto(base + "/work-orders?view=todo")
    for name in ("Calendar", "Filter"):
        box = pg.get_by_role("button", name=name, exact=True).bounding_box()
        assert box and box["height"] >= 44
    assert pg.get_by_role("textbox", name="Search work orders").first.is_visible()
    tabs = [pg.get_by_role("tab", name=n).bounding_box() for n in ("To Do", "Done", "Upcoming")]
    assert tabs[0]["x"] < tabs[1]["x"] < tabs[2]["x"]
    pg.get_by_role("tab", name="Upcoming").click()
    pg.get_by_role("radio", name="7 days").click()
    pg.get_by_text("in the next 7 days").wait_for()
    pg.goto(base + "/assets")
    assert not pg.get_by_role("combobox", name="Status").is_visible()  # filters fold away on a phone
    pg.get_by_role("button", name="Filter", exact=True).click()
    assert pg.get_by_role("combobox", name="Status").is_visible()


def test_priority_seg_fits(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    check_priority_seg_fits(page, server)


def test_dialog_text_readable(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    check_discard_dialog_readable(page, server)


def test_upcoming_and_phone_layout(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    check_upcoming_and_phone_layout(page, server)
