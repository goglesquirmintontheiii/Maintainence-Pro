"""End-to-end UI tests (guideline G-14). Run with MPRO_E2E=1 after building the frontend.

They start a real server on a free port with a fresh SQLite database and drive Chromium.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from typing import Any
from urllib.request import urlopen

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("MPRO_E2E") != "1", reason="set MPRO_E2E=1 to run browser tests")


def _port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def server(tmp_path_factory: Any) -> Iterator[str]:
    data = tmp_path_factory.mktemp("e2e")
    port = _port()
    env = {
        **os.environ,
        "MPRO_DATA_DIR": str(data),
        "MPRO_BASE_URL": f"http://127.0.0.1:{port}",
        "MPRO_SECRET_KEY": "e2e",
    }
    subprocess.run([sys.executable, "-m", "mpro", "seed-demo"], env=env, check=True, capture_output=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "mpro", "serve", "--host", "127.0.0.1", "--port", str(port)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urlopen(url + "/healthz", timeout=1)
            break
        except OSError:
            time.sleep(0.25)
    yield url
    proc.terminate()
    proc.wait(10)


@pytest.fixture()
def page(server: str) -> Iterator[Any]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("MPRO_CHROMIUM") or None)
        pg = b.new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(server + "/login")
        yield pg
        b.close()
        assert not errors, errors


def _login(page: Any, server: str) -> None:
    page.get_by_label("Email").fill("admin@example.com")
    page.get_by_label("Password").fill("mpro-demo-123")
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(server + "/")
    page.get_by_role("button", name="Account menu").wait_for()


def test_sign_in_and_shell(page: Any, server: str) -> None:
    _login(page, server)
    assert page.get_by_role("heading", name="Good").is_visible() or page.locator("h1").first.is_visible()
    page.get_by_role("link", name="Teams & Users").click()
    page.get_by_role("listitem").filter(has_text="Avery Kim").click()
    page.get_by_text("avery.kim@example.com").wait_for()


def test_wrong_password_message(page: Any, server: str) -> None:
    page.get_by_label("Email").fill("admin@example.com")
    page.get_by_label("Password").fill("not-the-password")
    page.get_by_role("button", name="Sign in").click()
    page.get_by_text("don't match").wait_for()


def test_search_palette(page: Any, server: str) -> None:
    _login(page, server)
    page.keyboard.press("Control+k")
    page.get_by_role("combobox", name="Search").fill("riley")
    page.get_by_role("option").filter(has_text="Riley Chen").click()
    page.wait_for_url("**/people/users/*")


def test_create_team_and_see_it_in_audit_log(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/people/teams?new=1")
    page.get_by_label("Name").fill("Night Shift")
    page.get_by_role("button", name="Create team").click()
    page.get_by_role("heading", name="Night Shift").wait_for()
    page.goto(server + "/settings/audit-log")
    page.get_by_text("Created team Night Shift").wait_for()


def test_unbuilt_module_explains_itself(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/assets")
    page.get_by_text("Arrives in MPro 0.3.0").wait_for()


def test_create_comment_and_complete_work_order(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/work-orders?view=todo")
    page.get_by_role("listitem").first.wait_for()
    page.keyboard.press("c")
    page.get_by_label("What needs to be done? *").fill("E2E: replace door closer")
    page.get_by_role("radio", name="High").click()
    page.get_by_label("Assign to").click()
    page.get_by_role("option", name="Avery Kim").click()
    page.keyboard.press("Escape")  # closes the picker, not the panel
    page.get_by_role("dialog", name="New work order").get_by_role("button", name="Create").click()
    page.get_by_role("heading", name="E2E: replace door closer").wait_for()
    box = page.get_by_placeholder("Write a comment… use @ to mention someone")
    box.fill("Hinge is bent, ordering a new one")
    page.get_by_role("button", name="Send").click()
    page.get_by_text("Hinge is bent, ordering a new one").wait_for()
    page.get_by_role("button", name="Done", exact=True).first.click()
    page.get_by_text("Marked Done").wait_for()
    page.get_by_role("tab", name="Done").click()
    page.get_by_role("listitem").filter(has_text="E2E: replace door closer").wait_for()


def test_views_filters_and_bulk(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/work-orders?view=table")
    page.get_by_role("button", name="Add filter").click()
    page.get_by_role("menu").get_by_role("button", name="Priority").click()
    page.get_by_role("menu").get_by_label("High").check()
    page.get_by_role("button", name="Apply").click()
    page.get_by_text("Priority: High").wait_for()
    rows = page.locator("tbody tr")
    rows.first.wait_for()
    page.locator("tbody input[type=checkbox]").first.check()
    page.get_by_role("toolbar", name="Bulk actions").get_by_text("1 selected").wait_for()
    for view in ("Calendar", "Workload", "Board"):
        page.get_by_role("tab", name=view).click()
        page.wait_for_timeout(300)
    page.get_by_role("tab", name="Board").wait_for()
    page.locator(".board-card").first.wait_for()
