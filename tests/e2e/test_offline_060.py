# ruff: noqa: E501
"""Phone app offline (0.6.0, MP-053): at phone size, go offline, complete a work order and comment, come back online
and see it synced. Run with MPRO_E2E=1 after building the frontend (the service worker only exists in a build)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import pytest

from tests.e2e.test_ui import server  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(os.environ.get("MPRO_E2E") != "1", reason="set MPRO_E2E=1 to run browser tests")


@pytest.fixture()
def phone(server: str) -> Iterator[tuple[Any, Any]]:  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("MPRO_CHROMIUM") or None)
        ctx = b.new_context(
            viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True
        )
        pg = ctx.new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        yield ctx, pg
        b.close()
        assert not errors, errors


def _api(pg: Any, method: str, path: str, body: Any = None) -> Any:
    return pg.evaluate(
        """async ([method, path, body]) => {
            const s = await (await fetch('/api/v1/auth/session')).json();
            const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
              body: body === null ? undefined : JSON.stringify(body) });
            return r.status === 204 ? null : await r.json();
        }""",
        [method, path, body],
    )


def _saved_count(pg: Any) -> int:
    return int(
        pg.evaluate(
            """() => new Promise((resolve) => {
                const o = indexedDB.open('mpro-offline');
                o.onsuccess = () => { const db = o.result; if (!db.objectStoreNames.contains('wo')) { resolve(0); return; }
                  const r = db.transaction('wo').objectStore('wo').count(); r.onsuccess = () => resolve(r.result); };
                o.onerror = () => resolve(0);
            })"""
        )
    )


def test_complete_and_comment_offline_then_sync(phone: tuple[Any, Any], server: str) -> None:  # noqa: F811
    ctx, pg = phone
    pg.goto(server + "/login")
    pg.get_by_label("Email").fill("avery.kim@example.com")
    pg.get_by_label("Password").fill("mpro-demo-123")
    pg.get_by_role("button", name="Sign in").click()
    pg.wait_for_url(server + "/")
    # the phone Overview (r290)
    pg.get_by_role("button", name="Scan Code").wait_for()
    pg.get_by_role("navigation", name="Quick navigation").get_by_role("link", name="Work Orders").wait_for()
    # the service worker installs and takes over; the person's work orders are saved for offline
    pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)")
    pg.reload()
    pg.wait_for_function("!!navigator.serviceWorker.controller", timeout=15000)
    for _ in range(60):
        if _saved_count(pg) > 0:
            break
        pg.wait_for_timeout(500)
    feed = _api(pg, "GET", "/sync")
    open_ids = [
        i
        for i in feed["cache_ids"]
        if _api(pg, "GET", f"/work-orders/{i}?mark_read=0")["status"] in ("open", "in_progress")
    ]
    assert open_ids, "Avery should have open work assigned in the demo"
    wid = open_ids[0]
    wo = _api(pg, "GET", f"/work-orders/{wid}?mark_read=0")
    assert _saved_count(pg) >= len(feed["cache_ids"]) > 0

    # ---- offline: the app still opens, the work order is there, and changes are kept on the phone
    ctx.set_offline(True)
    pg.goto(server + f"/work-orders/{wid}")
    pg.get_by_role("heading", name=wo["title"]).first.wait_for()
    pg.get_by_role("status").filter(has_text="You're offline").wait_for()
    box = pg.get_by_placeholder("Write a comment", exact=False).first
    box.fill("Checked offline, all good")
    pg.get_by_role("button", name="Send", exact=False).first.click()
    pg.get_by_text("Checked offline, all good").first.wait_for()
    pg.locator(".wo-sticky-complete").get_by_role("button", name="Complete").click()
    dialog = pg.get_by_role("dialog")
    if dialog.count():  # completion summary / signature settings
        dialog.get_by_role("button", name="Done", exact=False).last.click()
    pg.get_by_role("button", name="changes waiting to sync", exact=False).wait_for()
    # survives a reload while offline
    pg.reload()
    pg.get_by_role("button", name="changes waiting to sync", exact=False).wait_for()

    # ---- back online: the queue is sent in order and the server has both changes
    ctx.set_offline(False)
    pg.wait_for_timeout(8000)
    print("DBG", pg.evaluate("""() => new Promise((resolve) => { const o = indexedDB.open('mpro-offline'); o.onsuccess = () => { const r = o.result.transaction('queue').objectStore('queue').getAll(); r.onsuccess = () => resolve(JSON.stringify(r.result.map(q => [q.status, q.error, q.path, q.method]))); }; })"""))  # DBG
    pg.get_by_role("button", name="changes waiting to sync", exact=False).wait_for(state="detached", timeout=30000)
    after = _api(pg, "GET", f"/work-orders/{wid}?mark_read=0")
    assert after["status"] == "done"
    acts = _api(pg, "GET", f"/work-orders/{wid}/activity")["items"]
    bodies = [a.get("body") for a in acts if a["kind"] == "comment"]
    assert bodies.count("Checked offline, all good") == 1
