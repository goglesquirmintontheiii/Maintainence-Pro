"""Browser check for Messages (0.6.0, MP-049) and live updates (r269): a message sent in one browser shows up in
another without reloading. Needs a built frontend."""

from __future__ import annotations

import os
from typing import Any

from tests.e2e.test_ui import pytestmark, server  # noqa: F401  (fixtures)


def _sign_in(b: Any, base: str, email: str) -> Any:
    ctx = b.new_context(viewport={"width": 1280, "height": 860})
    pg = ctx.new_page()
    pg.goto(base + "/login")
    pg.wait_for_load_state("networkidle")  # the form re-renders once the session check returns
    pg.get_by_label("Email").fill(email)
    pg.get_by_label("Password").fill("mpro-demo-123")
    pg.get_by_role("button", name="Sign in").click()
    pg.wait_for_url(base + "/")
    return pg


def test_message_arrives_live_in_another_browser(server: str) -> None:  # noqa: F811
    from playwright.sync_api import expect, sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("MPRO_CHROMIUM") or None)
        errors: list[str] = []
        alex = _sign_in(b, server, "admin@example.com")
        alex.on("pageerror", lambda e: errors.append(str(e)))
        jordan_id = alex.evaluate("async () => (await (await fetch('/api/v1/users?q=jordan')).json()).items[0].id")
        alex.goto(f"{server}/people/users/{jordan_id}")
        alex.get_by_role("button", name="Message").click()
        alex.wait_for_url(f"{server}/messages/**")
        cid = alex.url.rstrip("/").split("/messages/")[1].split("?")[0]
        box = alex.get_by_role("textbox", name="Message Jordan Reyes…")
        box.fill("Hello from the browser test")
        alex.get_by_role("button", name="Send").click()
        expect(alex.get_by_role("log").get_by_text("Hello from the browser test")).to_be_visible()

        jordan = _sign_in(b, server, "jordan.reyes@example.com")
        jordan.on("pageerror", lambda e: errors.append(str(e)))
        jordan.goto(f"{server}/messages/{cid}")
        log = jordan.get_by_role("log")
        expect(log.get_by_text("Hello from the browser test")).to_be_visible()
        jordan.wait_for_timeout(1500)  # the live stream is open

        box.fill("Live check 4711")
        alex.get_by_role("button", name="Send").click()
        expect(log.get_by_text("Live check 4711")).to_be_visible(timeout=10_000)  # no reload

        # a thread reply and a reaction from Jordan show up for Alex too
        msg = log.locator(".msg", has_text="Live check 4711")
        msg.hover()
        msg.get_by_role("button", name="Reply in thread").click()
        jordan.get_by_role("textbox", name="Reply in thread…").fill("Seen it")
        jordan.get_by_role("complementary", name="Thread").get_by_role("button", name="Send").click()
        expect(alex.get_by_role("log").get_by_role("button", name="1 reply")).to_be_visible(timeout=10_000)
        b.close()
        assert not errors, errors
