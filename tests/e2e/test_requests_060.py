# ruff: noqa: E501, F811
"""Browser check for work requests (0.6.0, MP-047/MP-048): a portal request, then a requester's request approved
into a work order. Needs a built frontend."""

from __future__ import annotations

from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)


def test_request_to_work_order(page: Any, server: str) -> None:
    # a requester reports a problem
    page.goto(server + "/login")
    page.get_by_label("Email").fill("jamie.ortiz@example.com")
    page.get_by_label("Password").fill("mpro-demo-123")
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(server + "/")
    page.goto(server + "/requests/new")
    page.get_by_label("What's the problem? *").fill("E2E: door closer broken")
    page.get_by_label("Description").fill("Back door slams shut")
    page.get_by_role("radio", name="High").click()
    page.get_by_role("button", name="Submit request").click()
    page.get_by_role("heading", name="E2E: door closer broken").wait_for()
    page.get_by_text("Pending").first.wait_for()
    # sign out, an admin approves it
    page.context.clear_cookies()
    page.goto(server + "/login")
    _login(page, server)
    page.goto(server + "/requests")
    page.get_by_role("link").filter(has_text="E2E: door closer broken").first.click()
    page.get_by_role("button", name="Approve").first.click()
    page.get_by_role("button", name="Create work order").click()
    page.get_by_text("Work order #").first.wait_for()
    page.get_by_role("link", name="Open").click()
    page.get_by_role("heading", name="E2E: door closer broken").wait_for()
    assert "/work-orders/" in page.url


def test_public_portal_submit_and_status(page: Any, server: str) -> None:
    page.goto(server + "/login")
    _login(page, server)
    slug = page.evaluate(
        "fetch('/api/v1/request-portals').then(r => r.json()).then(d => d.items.find(x => x.name === 'Report a problem').slug)"
    )
    page.context.clear_cookies()
    page.goto(server + f"/portal/{slug}")
    page.get_by_label("What's wrong? *").fill("E2E: lobby light flickering")
    page.get_by_label("Your name *").fill("Pat Visitor")
    page.get_by_role("button", name="Send request").click()
    page.get_by_role("heading", name="Thanks, we got it").wait_for()
    page.locator("a", has_text="request-status").first.click()
    page.get_by_role("heading", name="E2E: lobby light flickering").wait_for()
    page.get_by_text("Waiting for review").wait_for()
