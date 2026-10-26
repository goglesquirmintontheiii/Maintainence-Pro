"""MPro Management in the browser (0.6.0, MP-136): a sysadmin opens it from the organization menu and finds a user."""

from __future__ import annotations

from typing import Any

from tests.e2e.test_ui import _login, page, pytestmark, server  # noqa: F401  (fixtures)


def test_sysadmin_opens_mpro_management_and_finds_a_user(page: Any, server: str) -> None:  # noqa: F811
    _login(page, server)
    page.get_by_role("button", name="Organization").click()
    page.get_by_role("link", name="MPro Management").click()
    page.wait_for_url("**/mpro-management")
    page.get_by_role("heading", name="MPro Management", exact=True).wait_for()
    page.get_by_role("navigation").get_by_role("link", name="User Database").click()
    page.get_by_role("textbox", name="Search people").fill("riley")
    page.get_by_role("link", name="Riley Chen").click()
    page.get_by_role("heading", name="Riley Chen").wait_for()
    page.get_by_text("User ID").wait_for()
    # the organization's own sidebar is replaced by MPro Management's
    assert page.get_by_role("navigation").get_by_role("link", name="Work Orders").count() == 0
    page.get_by_role("link", name="Org Database").click()
    page.get_by_role("link", name="Acme Manufacturing (Demo)").click()
    page.get_by_role("heading", name="Members").wait_for()
    page.get_by_text("work orders, assets, files and money stay private").wait_for()
