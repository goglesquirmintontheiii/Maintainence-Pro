# ruff: noqa: E501  (browser script: long selectors and sample text read better on one line)
"""Capture screenshots of the running app for progress.md (and catch console errors).

Usage: python scripts/screenshots.py --url http://127.0.0.1:8080 --out docs/screenshots/0.2.0
Start the server on a fresh demo database first (`mpro seed-demo` then `mpro serve`).
Needs Playwright and a Chromium (PLAYWRIGHT_BROWSERS_PATH, `playwright install chromium`, or MPRO_CHROMIUM=/path/to/chrome).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, sync_playwright

EMAIL, PASSWORD = "admin@example.com", "mpro-demo-123"


def login(page: Page, url: str) -> None:
    page.goto(url + "/login")
    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(url + "/")
    page.wait_for_timeout(700)


def api(page: Page, method: str, path: str, body: Any = None) -> Any:
    """Call the API from the signed-in page (keeps the CSRF token like the app does)."""
    return page.evaluate(
        """async ([method, path, body]) => {
            const s = await (await fetch('/api/v1/auth/session')).json();
            const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
              body: body === null ? undefined : JSON.stringify(body) });
            return r.status === 204 ? null : await r.json();
        }""",
        [method, path, body],
    )


def capture_030(ctx: Any, shot: Any, url: str) -> None:
    """0.3.0: assets, locations, meters, QR codes and labels, work-order changes and the light theme."""
    c, pg = ctx()
    login(pg, url)
    shot(pg, "01-overview-light", 1200)
    pg.goto(url + "/assets")
    shot(pg, "02-assets-tree", 1200)
    asset = api(pg, "GET", "/assets?q=Air%20Compressor%202")["items"][0]
    pg.goto(url + f"/assets/{asset['id']}")
    shot(pg, "03-asset-detail", 1200)
    for tab, name in (
        ("insights", "04-asset-insights"),
        ("downtime", "05-asset-downtime"),
        ("lifecycle", "06-asset-lifecycle"),
    ):
        pg.goto(url + f"/assets/{asset['id']}/{tab}")
        shot(pg, name, 1200)
    pg.goto(url + "/assets?view=table")
    pg.wait_for_timeout(800)
    if pg.get_by_role("tab", name="Table").count():
        pg.get_by_role("tab", name="Table").first.click()
    shot(pg, "07-assets-table", 1200)
    pg.goto(url + "/assets?new=1")
    shot(pg, "08-asset-create", 1000)
    pg.keyboard.press("Escape")
    pg.goto(url + f"/assets/{asset['id']}")
    pg.wait_for_timeout(800)
    pg.get_by_role("button", name="Change status").first.click()
    shot(pg, "09-asset-change-status", 500)
    pg.keyboard.press("Escape")
    loc = api(pg, "GET", "/locations?q=Dayton%20Plant")["items"][0]
    pg.goto(url + f"/locations/{loc['id']}")
    shot(pg, "10-location", 1200)
    meter = api(pg, "GET", "/meters?q=Bearing")["items"][0]
    pg.goto(url + f"/meters/{meter['id']}")
    shot(pg, "11-meter-chart", 1500)
    pg.goto(url + "/meters")
    shot(pg, "12-meters", 1000)
    pg.goto(url + "/settings/qr-codes")
    shot(pg, "13-qr-codes", 1000)
    pg.goto(url + "/assets")
    pg.wait_for_timeout(800)
    ids = [x["id"] for x in api(pg, "GET", "/assets?per_page=6")["items"]]
    _ = ids
    pg.goto(url + "/scan")
    shot(pg, "14-scan", 1200)
    wo = api(pg, "GET", "/work-orders?tab=all&q=Quarterly%20HVAC")["items"][0]
    pg.goto(url + f"/work-orders/{wo['id']}")
    shot(pg, "15-wo-asset-tasks", 1200)
    pg.goto(url + "/work-orders?view=todo")
    pg.wait_for_timeout(700)
    pg.keyboard.press("c")
    pg.get_by_label("What needs to be done? *").fill("Check oil level on Air Compressor 1")
    pg.get_by_label("Asset", exact=True).click()
    pg.get_by_role("listbox", name="Asset").get_by_placeholder("Search assets").fill("Air Compressor 1")
    pg.get_by_role("option", name="Air Compressor 1").click()
    pg.get_by_label("Due date").fill("2026-11-02T10:00")
    shot(pg, "16-wo-form-asset-clear-date", 500)
    pg.keyboard.press("Escape")
    pg.keyboard.press("Escape")
    pg.goto(url + "/work-orders?view=workload")
    shot(pg, "17-workload-totals", 1200)
    pg.get_by_role("button", name="Create", exact=True).click()
    shot(pg, "18-create-menu-templates", 500)
    pg.keyboard.press("Escape")
    pg.goto(url + "/settings/assets")
    shot(pg, "19-asset-settings", 1000)
    api(pg, "PATCH", "/auth/preferences", {"theme": "dark"})
    pg.goto(url + f"/assets/{asset['id']}")
    shot(pg, "20-dark-asset", 1200)
    api(pg, "PATCH", "/auth/preferences", {"theme": "light"})
    c.close()
    c, pg = ctx(mobile=True)
    login(pg, url)
    pg.goto(url + "/assets")
    shot(pg, "21-phone-assets", 1200)
    pg.goto(url + f"/meters/{meter['id']}")
    shot(pg, "22-phone-meter-reading", 1200)
    pg.goto(url + "/scan")
    shot(pg, "23-phone-scan", 1200)
    c.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default="docs/screenshots/0.3.0")
    ap.add_argument("--release", default="0.3.0", choices=("0.2.0", "0.3.0"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    url = a.url
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("MPRO_CHROMIUM") or None)

        def ctx(theme: str = "light", mobile: bool = False) -> tuple[Any, Page]:
            vp = {"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}
            c = b.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, color_scheme=theme)  # type: ignore[arg-type]
            pg = c.new_page()
            pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            return c, pg

        def shot(pg: Page, name: str, wait: int = 700, full: bool = False) -> None:
            pg.wait_for_timeout(wait)
            pg.screenshot(path=out / f"{name}.png", full_page=full)

        if a.release == "0.3.0":
            capture_030(ctx, shot, url)
            b.close()
            if errors:
                print("Console errors:\n" + "\n".join(errors))
                return 1
            print(f"Screenshots written to {out}")
            return 0
        c, pg = ctx()
        login(pg, url)
        shot(pg, "01-overview")
        # To Do + detail with a running timer and a conversation
        pg.goto(url + "/work-orders/5?view=todo")
        shot(pg, "02-todo-detail", 1000)
        pg.goto(url + "/work-orders/1")
        pg.wait_for_timeout(800)
        pg.get_by_role("button", name="Start timer").click()
        pg.wait_for_timeout(1500)
        pg.get_by_role("heading", name="Time and costs").scroll_into_view_if_needed()
        shot(pg, "03-time-and-costs")
        pg.get_by_role("heading", name="Activity").scroll_into_view_if_needed()
        box = pg.get_by_placeholder("Write a comment… use @ to mention someone")
        box.click()
        box.type("Belt replaced, tension checked. @Ri")
        shot(pg, "04-comment-mention", 500)
        pg.keyboard.press("Escape")
        box.fill("")
        # create
        pg.goto(url + "/work-orders?view=todo")
        pg.wait_for_timeout(600)
        pg.keyboard.press("c")
        pg.get_by_label("What needs to be done? *").fill("Replace door closer at shipping office")
        pg.get_by_label("Description").fill("Door slams shut. Closer arm is bent.")
        pg.get_by_role("radio", name="Medium").click()
        pg.get_by_label("Assign to").click()
        pg.get_by_role("option", name="Casey Nguyen").click()
        pg.get_by_role("option", name="Facilities").click()
        pg.keyboard.press("Escape")
        shot(pg, "05-create", 400)
        pg.get_by_role("dialog", name="New work order").get_by_role("button", name="Create").click()
        pg.wait_for_timeout(900)
        # views
        pg.goto(url + "/work-orders?view=table")
        shot(pg, "06-table", 900)
        pg.get_by_role("button", name="Add filter").click()
        pg.get_by_role("menu").get_by_role("button", name="Category").click()
        pg.get_by_role("menu").get_by_label("Safety").check()
        pg.get_by_role("button", name="Apply").click()
        pg.wait_for_timeout(600)
        pg.locator("tbody input[type=checkbox]").nth(0).check()
        pg.locator("tbody input[type=checkbox]").nth(1).check()
        shot(pg, "07-filter-and-bulk", 400)
        pg.get_by_role("button", name="Reset").click()
        for i, (view, name) in enumerate(
            (("calendar", "08-calendar"), ("workload", "09-workload"), ("board", "10-board"))
        ):
            pg.goto(url + f"/work-orders?view={view}")
            shot(pg, name, 1000)
            _ = i
        # completion with signature and approval
        api(pg, "PATCH", "/work-orders/settings", {"require_signature": True, "completion_summary": "optional"})
        pg.goto(url + "/work-orders/8?view=todo")
        pg.wait_for_timeout(900)
        pg.get_by_role("button", name="Done", exact=True).first.click()
        pg.wait_for_timeout(400)
        pg.get_by_label("Completion summary (optional)").fill(
            "Replaced the accel ramp to 6 s. No more OC2 faults over 20 starts."
        )
        canvas = pg.locator(".sigpad canvas")
        bb = canvas.bounding_box()
        assert bb
        pg.mouse.move(bb["x"] + 30, bb["y"] + 100)
        pg.mouse.down()
        for x, y in ((60, 60), (90, 110), (120, 50), (150, 105), (190, 70), (230, 95), (270, 60), (300, 90)):
            pg.mouse.move(bb["x"] + x, bb["y"] + y, steps=6)
        pg.mouse.up()
        shot(pg, "11-complete-with-signature", 300)
        pg.get_by_role("button", name="Mark as Done").click()
        pg.wait_for_timeout(900)
        api(pg, "PATCH", "/work-orders/settings", {"require_signature": False, "completion_summary": "none"})
        pg.get_by_role("button", name="More actions").click()
        pg.get_by_role("button", name="Export to PDF").click()
        shot(pg, "12-pdf-export", 400)
        pg.keyboard.press("Escape")
        # search, settings, categories, downloads
        pg.keyboard.press("Control+k")
        pg.keyboard.type("compressor")
        shot(pg, "13-search", 900)
        pg.keyboard.press("Escape")
        pg.goto(url + "/settings/work-orders")
        shot(pg, "14-settings", 900)
        pg.goto(url + "/categories")
        shot(pg, "15-categories", 800)
        api(pg, "POST", "/work-orders/export", {"format": "csv"})
        api(
            pg,
            "POST",
            "/work-orders/export",
            {"format": "pdf", "query": {"filters": [{"field": "priority", "op": "in", "value": ["high"]}]}},
        )
        pg.goto(url + "/downloads")
        shot(pg, "16-download-center", 3000)
        pg.keyboard.press("?")
        shot(pg, "17-shortcuts", 300)
        c.close()

        c, pg = ctx("dark")
        login(pg, url)
        pg.goto(url + "/work-orders/5?view=todo")
        shot(pg, "18-dark-theme", 1000)
        pg.goto(url + "/work-orders?view=calendar")
        shot(pg, "19-dark-calendar", 1000)
        c.close()

        c, pg = ctx(mobile=True)
        login(pg, url)
        pg.goto(url + "/work-orders?view=todo")
        shot(pg, "20-phone-list", 900)
        pg.goto(url + "/work-orders/1")
        shot(pg, "21-phone-detail", 900)
        c.close()
        b.close()
    if errors:
        print("Console errors:\n" + "\n".join(errors))
        return 1
    print(f"Screenshots written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
