"""Capture screenshots of the running app for progress.md (and catch console errors).

Usage: python scripts/screenshots.py --url http://127.0.0.1:8080 --out docs/screenshots/0.1.0
Needs `pip install playwright` and a Chromium (PLAYWRIGHT_BROWSERS_PATH or `playwright install chromium`).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

EMAIL, PASSWORD = "admin@example.com", "mpro-demo-123"


def login(page: Page, url: str) -> None:
    page.goto(url + "/login")
    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(url + "/")
    page.wait_for_timeout(600)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default="docs/screenshots/0.1.0")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as p:
        b = p.chromium.launch()

        def ctx(theme: str = "light", mobile: bool = False):  # type: ignore[no-untyped-def]
            vp = {"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}
            c = b.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, color_scheme=theme)
            pg = c.new_page()
            pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            return c, pg

        c, pg = ctx()
        pg.goto(a.url + "/login")
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "01-sign-in.png")
        login(pg, a.url)
        pg.screenshot(path=out / "02-overview.png")
        pg.goto(a.url + "/people/users")
        pg.wait_for_timeout(500)
        pg.get_by_role("listitem").filter(has_text="Avery Kim").click()
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "03-teams-users.png")
        pg.goto(a.url + "/people/teams")
        pg.wait_for_timeout(400)
        pg.get_by_role("listitem").filter(has_text="HVAC").click()
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "04-team-detail.png")
        pg.keyboard.press("Control+k")
        pg.wait_for_timeout(200)
        pg.keyboard.type("ri")
        pg.wait_for_timeout(700)
        pg.screenshot(path=out / "05-global-search.png")
        pg.keyboard.press("Escape")
        pg.goto(a.url + "/people/users?invite=1")
        pg.wait_for_timeout(400)
        pg.get_by_label("Email").fill("new.planner@example.com")
        pg.get_by_label("Name").fill("Pat Planner")
        pg.screenshot(path=out / "06-invite.png")
        pg.get_by_role("button", name="Send invitation").click()
        pg.wait_for_timeout(800)
        pg.goto(a.url + "/settings/audit-log")
        pg.wait_for_timeout(700)
        pg.screenshot(path=out / "07-audit-log.png")
        pg.goto(a.url + "/settings/email")
        pg.wait_for_timeout(600)
        pg.screenshot(path=out / "08-email-outbox.png")
        pg.goto(a.url + "/settings/jobs")
        pg.wait_for_timeout(600)
        pg.screenshot(path=out / "09-background-jobs.png")
        pg.goto(a.url + "/settings/design-system")
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "10-design-system.png", full_page=True)
        pg.goto(a.url + "/work-orders")
        pg.wait_for_timeout(400)
        pg.screenshot(path=out / "11-coming-soon.png")
        c.close()

        c, pg = ctx("dark")
        login(pg, a.url)
        pg.goto(a.url + "/people/users")
        pg.wait_for_timeout(400)
        pg.get_by_role("listitem").filter(has_text="Riley Chen").click()
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "12-dark-theme.png")
        c.close()

        c, pg = ctx(mobile=True)
        login(pg, a.url)
        pg.screenshot(path=out / "13-phone-overview.png")
        pg.get_by_role("button", name="Open menu").click()
        pg.wait_for_timeout(400)
        pg.screenshot(path=out / "14-phone-menu.png")
        pg.goto(a.url + "/people/users")
        pg.wait_for_timeout(500)
        pg.screenshot(path=out / "15-phone-people.png")
        c.close()
        b.close()
    if errors:
        print("Console errors:\n" + "\n".join(errors))
        return 1
    print(f"Screenshots written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
