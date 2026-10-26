"""0.6.0 integration: things that cross two workstreams."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_scan_actions import asset, code, location

API = "/api/v1"


def test_public_scan_opens_the_most_specific_request_portal(app: Any, admin: Api) -> None:
    """A signed-out scan of an asset or location sticker leads to a request portal (MP-097 × MP-048)."""
    room = location(admin, "Boiler Room")
    a = asset(admin, "Boiler 2", location_id=room["id"])
    v = code(admin, "asset", a["id"])
    lv = code(admin, "location", room["id"])
    admin.patch(f"{API}/scan/settings", {"public_scans": True})
    anon = app.test_client()
    anon.environ_base["REMOTE_ADDR"] = "10.7.7.1"
    # no portal yet: the scan answers but there is no form to send people to
    assert anon.get(f"{API}/public/scan/{v}").json["request_url"] is None
    wide = admin.post(f"{API}/request-portals", {"name": "Report a problem"}).json
    r = anon.get(f"{API}/public/scan/{v}").json
    assert r["request_url"] == f"/portal/{wide['slug']}?asset={a['id']}"
    assert anon.get(f"{API}/public/scan/{lv}").json["request_url"] == f"/portal/{wide['slug']}?location={room['id']}"
    # a portal for that location beats the organization-wide one; a customer portal is never used
    cust = admin.post(f"{API}/customers", {"name": "Harbor Foods"}).json
    admin.post(f"{API}/request-portals", {"name": "Harbor", "customer_id": cust["id"]})
    here = admin.post(f"{API}/request-portals", {"name": "Boiler room", "location_id": room["id"]}).json
    assert anon.get(f"{API}/public/scan/{v}").json["request_url"].startswith(f"/portal/{here['slug']}?")
    # an inactive portal is skipped; the form it points to opens and names the asset
    admin.patch(f"{API}/request-portals/{here['id']}", {"active": False})
    url = anon.get(f"{API}/public/scan/{v}").json["request_url"]
    assert url.startswith(f"/portal/{wide['slug']}?")
    form = anon.get(f"{API}/portal/{wide['slug']}?asset={a['id']}")
    assert form.status_code == 200, form.json
    assert form.json["asset"]["name"] == "Boiler 2"


def test_request_events_reach_staff_live_but_not_requesters(app: Any, admin: Api) -> None:
    """The Requests list and badge update live for people who see everyone's requests (r269 × MP-047)."""
    from tests.test_messaging import _poll
    from tests.test_work_orders import login
    from tests.test_work_requests import REQUESTER, REQUESTER_2, submit

    since = admin.get(f"{API}/realtime/poll").json["cursor"]
    jamie = login(app, REQUESTER)
    r = submit(jamie, title="Leak by the dock door")
    got = {(e["topic"], e["type"]) for e in _poll(admin, since)}
    assert ("requests", "request.created") in got
    assert all(e["topic"] != "requests" for e in _poll(login(app, REQUESTER_2), since))
    # payloads carry ids only
    ev = next(e for e in _poll(admin, since) if e["topic"] == "requests")
    assert "Leak" not in str(ev) and ev["data"]["entity_id"] == r["id"]
