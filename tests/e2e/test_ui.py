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
    page.goto(server + "/parts")
    page.get_by_text("Arrives in MPro 0.5.0").wait_for()


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


def test_light_theme_is_default(page: Any, server: str) -> None:
    _login(page, server)
    assert page.evaluate("document.documentElement.dataset.theme") == "light"
    bg = page.evaluate("getComputedStyle(document.querySelector('.sidebar')).backgroundColor")
    assert bg == "rgb(255, 255, 255)"  # light sidebar in the light theme


def test_work_order_with_asset_and_quick_template(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/work-orders?view=todo")
    page.get_by_role("listitem").first.wait_for()
    page.keyboard.press("c")
    page.get_by_label("What needs to be done? *").fill("E2E: check compressor oil")
    page.get_by_label("Asset", exact=True).click()
    page.get_by_role("listbox", name="Asset").get_by_placeholder("Search assets").fill("Air Compressor 1")
    page.get_by_role("option", name="Air Compressor 1").click()
    # picking the asset fills in its location
    page.get_by_role("dialog", name="New work order").get_by_text("Compressor Room").wait_for()
    due = page.get_by_label("Due date")
    due.fill("2030-01-02T10:00")
    page.get_by_role("button", name="Clear due date").click()
    assert due.input_value() == ""
    page.get_by_role("dialog", name="New work order").get_by_role("button", name="Create").click()
    page.get_by_role("heading", name="E2E: check compressor oil").wait_for()
    page.get_by_role("link", name="Air Compressor 1").wait_for()
    # one-tap create from a template in the Create menu
    page.get_by_role("button", name="Create", exact=True).click()
    page.get_by_role("menu").get_by_role("button", name="Replace HVAC filters").click()
    page.get_by_text("created from “Replace HVAC filters”").wait_for()


def test_asset_task_list(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/work-orders?view=todo")
    page.get_by_role("listitem").filter(has_text="Quarterly HVAC filter and belt check").first.click()
    page.get_by_role("heading", name="Asset tasks").wait_for()
    page.get_by_role("radiogroup", name="Status of AHU-2").get_by_role("radio", name="Done").click()
    page.get_by_text("1 of 4 done").wait_for()


def test_assets_locations_and_meters(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/assets")
    page.get_by_text("Air Compressor 2").first.click()
    page.get_by_role("heading", name="Air Compressor 2").wait_for()
    page.get_by_role("tab", name="Insights").click()
    page.get_by_text("Availability").first.wait_for()
    page.goto(server + "/assets?status=offline")
    page.get_by_text("Forklift 3").first.wait_for()
    page.goto(server + "/locations")
    page.get_by_text("Dayton Plant").first.click()
    page.get_by_role("heading", name="Dayton Plant").wait_for()
    page.goto(server + "/meters")
    page.get_by_text("Discharge pressure").first.click()
    page.get_by_role("heading", name="Discharge pressure").wait_for()
    page.get_by_placeholder("New reading").fill("104")
    page.get_by_role("button", name="Record", exact=True).click()
    page.get_by_text("104").first.wait_for()


def test_scan_resolves_a_typed_code(page: Any, server: str) -> None:
    _login(page, server)
    code = page.evaluate(
        """async () => (await (await fetch('/api/v1/qr-codes?state=assigned&per_page=1')).json()).items[0]"""
    )
    page.goto(server + "/q/" + code["value"])
    page.wait_for_url("**/assets/*")
    page.get_by_role("heading", name=code["target"]["label"]).wait_for()


def test_040_modules_load(page: Any, server: str) -> None:
    _login(page, server)
    page.goto(server + "/preventive-maintenance")
    page.get_by_text("Chiller 1").first.wait_for()
    page.goto(server + "/procedures")
    page.get_by_text("Forklift").first.wait_for()
    page.goto(server + "/automations")
    page.get_by_text("Bearing temperature").first.wait_for()
    page.goto(server + "/settings/roles")
    page.get_by_text("Operator").first.wait_for()


def test_procedure_runner_on_work_order(page: Any, server: str) -> None:
    _login(page, server)
    wos = page.evaluate(
        """async () => (await (await fetch('/api/v1/work-orders?tab=all&per_page=200')).json()).items"""
    )
    target = None
    for w in wos:
        d = page.evaluate(f"""async () => (await fetch('/api/v1/work-orders/{w["id"]}')).json()""")
        if d.get("procedures") and d["status"] not in ("done", "canceled"):
            target = d
            break
    assert target, "demo data should have an open work order with a procedure"
    page.goto(server + f"/work-orders/{target['id']}")
    page.get_by_text(target["procedures"][0]["procedure"]["name"]).first.wait_for()
