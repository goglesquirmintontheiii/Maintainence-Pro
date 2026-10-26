"""Notifications in the browser (0.6.0, MP-050): an assignment reaches the other person's bell."""

from __future__ import annotations

import time
from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)


def _api(pg: Any, method: str, path: str, body: Any = None) -> Any:
    return pg.evaluate(
        """async ([method, path, body]) => {
            const s = await (await fetch('/api/v1/auth/session')).json();
            const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf };
            const r = await fetch('/api/v1' + path, { method, headers,
              body: body === null ? undefined : JSON.stringify(body) });
            return r.status === 204 ? null : await r.json();
        }""",
        [method, path, body],
    )


def test_assignment_shows_in_the_other_persons_bell(page: Any, server: str) -> None:  # noqa: F811
    from playwright.sync_api import expect

    # Avery signs in in a second window
    other = page.context.browser.new_context()
    avery = other.new_page()
    avery.goto(server + "/login")
    avery.get_by_label("Email").fill("avery.kim@example.com")
    avery.get_by_label("Password").fill("mpro-demo-123")
    avery.get_by_role("button", name="Sign in").click()
    avery.wait_for_url(server + "/")
    bell = avery.get_by_role("button", name="Notifications", exact=False)
    bell.wait_for()
    before = _api(avery, "GET", "/notifications/unread-count")["unread"]

    _login(page, server)
    users = _api(page, "GET", "/users?q=avery")["items"]
    avery_id = next(u["id"] for u in users if u["email"] == "avery.kim@example.com")
    wo = _api(
        page, "POST", "/work-orders", {"title": "E2E: check the bell", "assignees": [{"type": "user", "id": avery_id}]}
    )
    assert wo.get("id"), wo

    # the background worker routes the event within a few seconds; the bell refreshes on focus or live
    # (due-date scans of the demo's work orders can add notices too, so look for this one by title)
    def mine() -> list[Any]:
        items = _api(avery, "GET", "/notifications?unread=1")["items"]
        return [i for i in items if "E2E: check the bell" in i["title"]]

    deadline = time.time() + 40
    while time.time() < deadline and not mine():
        time.sleep(1)
    assert mine()
    now = _api(avery, "GET", "/notifications/unread-count")["unread"]
    assert now > before
    avery.reload()
    expect(avery.get_by_role("button", name=f"Notifications, {now} unread")).to_be_visible(timeout=15000)
    avery.get_by_role("button", name="Notifications", exact=False).click()
    item = avery.locator(".notif-panel").get_by_role("listitem").filter(has_text="E2E: check the bell")
    item.wait_for()
    item.click()
    avery.wait_for_url(f"**/work-orders/{wo['id']}")
    deadline = time.time() + 10
    while time.time() < deadline and mine():
        time.sleep(0.5)
    assert not mine()  # opening it marked it read
    other.close()


def test_notification_settings_page(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    page.goto(server + "/notifications?tab=settings")
    page.get_by_role("heading", name="What you hear about").wait_for()
    page.get_by_label("Send emails").select_option("daily")
    page.get_by_label("Daily digest at").wait_for()
    page.goto(server + "/settings/notifications")
    page.get_by_role("button", name="New rule").click()
    page.get_by_label("Name").fill("Overdue high priority")
    page.get_by_role("button", name="Save rule").click()
    page.get_by_text("Overdue high priority").wait_for()
