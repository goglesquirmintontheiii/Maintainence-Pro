"""Scan actions, check-ins, scan history, require-a-scan and public scans (0.6.0, MP-097)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import login, uid

API = "/api/v1"
SIMPLE = {"items": [{"id": "ok", "type": "checkbox", "label": "Area is clear"}]}


def asset(api: Api, name: str = "Air Compressor 1", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/assets", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def location(api: Api, name: str = "Compressor Room") -> dict[str, Any]:
    r = api.post(f"{API}/locations", {"name": name})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def code(api: Api, et: str, eid: str) -> str:
    r = api.post(f"{API}/qr-codes", {"entity_type": et, "entity_id": eid})
    assert r.status_code == 201, r.json
    return str(r.json["value"])


def procedure(api: Api, name: str = "Boiler round") -> dict[str, Any]:
    r = api.post(f"{API}/procedures", {"name": name, "schema": SIMPLE})
    assert r.status_code == 201, r.json
    assert api.post(f"{API}/procedures/{r.json['id']}/publish").status_code == 200
    return r.json  # type: ignore[no-any-return]


def scan(api: Api, value: str, **kw: Any) -> Any:
    return api.post(f"{API}/scan", {"value": value, **kw})


def other_org(app: Any) -> Api:
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.services import create_org

        u = User(email="other@example.com", name="Other Owner")
        u.set_password("other-pass-123")
        db.session.add(u)
        db.session.flush()
        create_org("Other Co", u)
        db.session.commit()
    return login(app, "other@example.com", "other-pass-123")


# ---- actions by type and role ---------------------------------------------------------------------------------------
def test_asset_scan_actions_by_role_and_default_action(app: Any, admin: Api) -> None:
    a = asset(admin)
    v = code(admin, "asset", a["id"])
    r = scan(admin, f"http://mpro.test/q/{v}")
    assert r.status_code == 200, r.json
    assert r.json["status"] == "found" and r.json["entity_id"] == a["id"]
    keys = [x["key"] for x in r.json["actions"]]
    assert keys == ["open", "start_wo", "log_meter", "manuals", "report"]
    assert r.json["default_action"] == "menu" and r.json["scan_id"]
    assert r.json["context"]["work_orders"] == []
    # viewers can only look
    viewer = login(app, "quinn.foster@example.com")
    r = scan(viewer, v)
    assert [x["key"] for x in r.json["actions"]] == ["open", "manuals"]
    # requesters can't see assets, but can report a problem on one
    req = login(app, "jamie.ortiz@example.com")
    r = scan(req, v)
    assert r.status_code == 200, r.json
    assert r.json["limited"] is True and r.json["label"] == "Air Compressor 1"
    assert [x["key"] for x in r.json["actions"]] == ["report"]
    assert r.json["url"] == f"/requests/new?asset_id={a['id']}"
    assert "context" in r.json and r.json["context"] == {}
    # admins pick the default per type and per role
    s = admin.patch(
        f"{API}/scan/settings",
        {"default_actions": {"asset": "start_wo"}, "role_actions": {"viewer": {"asset": "manuals"}}},
    )
    assert s.status_code == 200, s.json
    assert scan(admin, v).json["default_action"] == "start_wo"
    assert scan(viewer, v).json["default_action"] == "manuals"
    tech = login(app, "avery.kim@example.com")
    assert admin.patch(f"{API}/scan/settings", {"default_actions": {"asset": "bogus"}}).status_code == 422
    assert admin.patch(f"{API}/scan/settings", {"role_actions": {"nobody": {"asset": "open"}}}).status_code == 422
    assert tech.patch(f"{API}/scan/settings", {"record_gps": True}).status_code == 403
    assert tech.get(f"{API}/scan/settings").status_code == 403


def test_location_check_in_and_context(app: Any, admin: Api) -> None:
    loc = location(admin)
    a = asset(admin, location_id=loc["id"])
    wo = admin.post(f"{API}/work-orders", {"title": "Leak check", "location_id": loc["id"]}).json
    v = code(admin, "location", loc["id"])
    r = scan(admin, v)
    assert r.json["default_action"] == "check_in"
    assert [x["name"] for x in r.json["context"]["assets"]] == [a["name"]]
    assert [w["id"] for w in r.json["context"]["work_orders"]] == [wo["id"]]
    ev = admin.post(
        f"{API}/scan/events", {"entity_type": "location", "entity_id": loc["id"], "action": "check_in", "code": v}
    )
    assert ev.status_code == 201, ev.json
    assert ev.json["action"] == "check_in" and ev.json["action_label"] == "Check in"
    hist = admin.get(f"{API}/scan/history?entity_type=location&entity_id={loc['id']}").json
    assert [h["action"] for h in hist["items"]] == ["check_in", "scan"]
    # the audit log shows the check-in
    log = admin.get(f"{API}/audit?q=scan.checked_in").json
    assert any("Checked in at Compressor Room" in e["summary"] for e in log["items"])


def test_action_permissions_and_validation(app: Any, admin: Api) -> None:
    a = asset(admin)
    viewer = login(app, "quinn.foster@example.com")
    r = viewer.post(f"{API}/scan/events", {"entity_type": "asset", "entity_id": a["id"], "action": "start_wo"})
    assert r.status_code == 403
    r = admin.post(f"{API}/scan/events", {"entity_type": "asset", "entity_id": a["id"], "action": "restock"})
    assert r.status_code == 422  # not an asset action
    r = admin.post(f"{API}/scan/events", {"entity_type": "asset", "entity_id": a["id"], "action": "open"})
    assert r.status_code == 422  # opening isn't kept in the history
    future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    r = admin.post(f"{API}/scan/events", {"entity_type": "asset", "entity_id": a["id"], "scanned_at": future})
    assert r.status_code == 422


def test_work_order_and_meter_and_part_codes(app: Any, admin: Api) -> None:
    wo = admin.post(f"{API}/work-orders", {"title": "Fix door"}).json
    v = code(admin, "work_order", wo["id"])
    r = scan(admin, v)
    assert r.json["entity_type"] == "work_order" and r.json["default_action"] == "open"
    assert [x["key"] for x in r.json["actions"]] == ["open", "complete"]
    hist = admin.get(f"{API}/scan/history?work_order_id={wo['id']}").json
    assert len(hist["items"]) == 1
    # labels for work orders print with their number
    pdf = admin.post(
        f"{API}/labels", {"entity_type": "work_order", "ids": [wo["id"]], "format": "zpl", "template": "zebra_2x1"}
    )
    assert pdf.status_code == 200 and f"#{wo['number']}".encode() in pdf.data
    # limited-visibility technicians can't scan work orders they can't see
    avery = uid(admin, "avery.kim@example.com")
    assert admin.patch(f"{API}/users/{avery}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    tech = login(app, "avery.kim@example.com")
    assert scan(tech, v).status_code == 403


# ---- procedures: start an inspection, require a scan ----------------------------------------------------------------
def test_procedure_code_starts_or_continues_an_inspection(app: Any, admin: Api) -> None:
    p = procedure(admin)
    v = code(admin, "procedure", p["id"])
    r = scan(admin, v)
    assert r.json["default_action"] == "start"
    s1 = admin.post(f"{API}/scan/start-procedure", {"procedure_id": p["id"]})
    assert s1.status_code == 200, s1.json
    assert s1.json["created"] is True
    wo = admin.get(f"{API}/work-orders/{s1.json['work_order_id']}").json
    assert wo["title"] == "Boiler round"
    s2 = admin.post(f"{API}/scan/start-procedure", {"procedure_id": p["id"]}).json
    assert s2["created"] is False and s2["work_order_id"] == s1.json["work_order_id"]
    req = login(app, "jamie.ortiz@example.com")
    assert req.post(f"{API}/scan/start-procedure", {"procedure_id": p["id"]}).status_code == 403


def test_require_scan_to_start_and_complete(app: Any, admin: Api) -> None:
    loc = location(admin)
    a = asset(admin, location_id=loc["id"])
    p = procedure(admin)
    tech = login(app, "avery.kim@example.com")
    r = tech.c.put(
        f"{API}/procedures/{p['id']}/scan-requirement", json={"on_start": True}, headers={"X-CSRF-Token": tech.csrf}
    )
    assert r.status_code == 200  # technicians manage procedures
    r = admin.c.put(f"{API}/procedures/{p['id']}/scan-requirement", json={"on_start": True, "on_complete": True},
                    headers={"X-CSRF-Token": admin.csrf})  # fmt: skip
    assert r.status_code == 200 and r.json == {"on_start": True, "on_complete": True}
    assert admin.get(f"{API}/procedures/{p['id']}/scan-requirement").json["on_start"] is True
    avery = uid(admin, "avery.kim@example.com")
    wo = admin.post(
        f"{API}/work-orders",
        {"title": "Round", "asset_id": a["id"], "procedures": [p["id"]], "assignees": [{"type": "user", "id": avery}]},
    ).json
    r = tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"})
    assert r.status_code == 422 and "Scan the QR code on Air Compressor 1" in r.json["message"]
    # someone else's scan doesn't count
    v = code(admin, "asset", a["id"])
    scan(admin, v)
    assert tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 422
    assert scan(tech, v).status_code == 200
    r = tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"})
    assert r.status_code == 200, r.json
    r = tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json  # the scan is still within the window
    # proof of visit on the work order
    visits = admin.get(f"{API}/work-orders/{wo['id']}/visits").json
    assert {x["user"]["name"] for x in visits["items"]} == {"Avery Kim", "Alex Morgan"}
    mine = tech.get(f"{API}/work-orders/{wo['id']}/visits").json
    assert mine["everyone"] is True  # technicians have scan.history
    # an old scan (beyond the window) doesn't count
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "open"})
    assert r.status_code == 200
    with app.app_context():
        from sqlalchemy import update

        from mpro.extensions import db
        from mpro.qr.models import ScanEvent

        db.session.execute(update(ScanEvent).values(scanned_at=datetime.now(UTC) - timedelta(hours=5)))
        db.session.commit()
    assert tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 422


# ---- history privacy, GPS, offline replays --------------------------------------------------------------------------
def test_history_privacy_gps_and_offline_replay(app: Any, admin: Api) -> None:
    a = asset(admin)
    v = code(admin, "asset", a["id"])
    # GPS is kept only when the organization turns it on
    assert scan(admin, v, latitude=40.1, longitude=-88.2, accuracy=12).status_code == 200
    h = admin.get(f"{API}/scan/history?entity_type=asset&entity_id={a['id']}").json["items"][0]
    assert "gps" not in h
    admin.patch(f"{API}/scan/settings", {"record_gps": True})
    assert admin.get(f"{API}/scan/config").json["record_gps"] is True
    scan(admin, v, latitude=40.1, longitude=-88.2, accuracy=12)
    h = admin.get(f"{API}/scan/history?entity_type=asset&entity_id={a['id']}").json["items"][0]
    assert h["gps"] == {"latitude": "40.100000", "longitude": "-88.200000", "accuracy_m": 12}
    assert scan(admin, v, latitude=99, longitude=0).status_code == 422
    # requesters (no scan.history) only see their own scans, without other people's positions
    req = login(app, "jamie.ortiz@example.com")
    scan(req, v)
    mine = req.get(f"{API}/scan/history").json
    assert mine["everyone"] is False and len(mine["items"]) == 1
    assert mine["items"][0]["user"]["name"] == "Jamie Ortiz"
    # offline scans replay safely with the same client id
    when = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    body = {
        "entity_type": "asset",
        "entity_id": a["id"],
        "client_id": "phone-1-abc",
        "scanned_at": when,
        "source": "offline",
    }
    tech = login(app, "avery.kim@example.com")
    first = tech.post(f"{API}/scan/events", body)
    again = tech.post(f"{API}/scan/events", body)
    assert first.status_code == 201 and again.status_code == 200 and first.json["id"] == again.json["id"]
    assert admin.post(f"{API}/scan/events", body).status_code == 409  # someone else's id
    old = (datetime.now(UTC) - timedelta(days=9)).isoformat()
    assert tech.post(f"{API}/scan/events", {**body, "client_id": "x2", "scanned_at": old}).status_code == 422


# ---- cross-org (G-15) -----------------------------------------------------------------------------------------------
def test_other_org_cannot_scan_or_read_history(app: Any, admin: Api) -> None:
    a = asset(admin)
    v = code(admin, "asset", a["id"])
    wo = admin.post(f"{API}/work-orders", {"title": "Mine"}).json
    p = procedure(admin)
    scan(admin, v)
    other = other_org(app)
    assert scan(other, v).json["status"] == "unknown"
    assert other.post(f"{API}/scan/events", {"entity_type": "asset", "entity_id": a["id"]}).status_code == 422
    assert other.get(f"{API}/scan/history").json["items"] == []
    assert other.get(f"{API}/scan/history?entity_type=asset&entity_id={a['id']}").json["items"] == []
    assert other.get(f"{API}/work-orders/{wo['id']}/visits").status_code == 404
    assert other.get(f"{API}/procedures/{p['id']}/scan-requirement").status_code == 404
    assert other.post(f"{API}/scan/start-procedure", {"procedure_id": p["id"]}).status_code == 422
    r = other.post(f"{API}/scan/events", {"entity_type": "location", "entity_id": a["id"], "work_order_id": wo["id"]})
    assert r.status_code == 422


# ---- public scans ---------------------------------------------------------------------------------------------------
def test_public_scans_only_lead_to_the_request_form(app: Any, admin: Api) -> None:
    a = asset(admin)
    v = code(admin, "asset", a["id"])
    anon = app.test_client()
    anon.environ_base["REMOTE_ADDR"] = "10.9.9.1"
    assert anon.get(f"{API}/public/scan/{v}").status_code == 404  # off by default
    admin.patch(f"{API}/scan/settings", {"public_scans": True})
    from mpro.qr import scan as scan_svc

    saved = list(scan_svc.PUBLIC_REQUEST_URL)
    scan_svc.PUBLIC_REQUEST_URL[:] = [lambda org_id, et, eid: f"/portal/demo?{et}_id={eid}"]
    try:
        r = anon.get(f"{API}/public/scan/{v}")
    finally:
        scan_svc.PUBLIC_REQUEST_URL[:] = saved
    assert r.status_code == 200, r.json
    assert set(r.json) == {"organization", "entity_type", "label", "request_url"}
    assert r.json["request_url"] == f"/portal/demo?asset_id={a['id']}"
    # a public scan is in the history, with no person and no IP address
    h = admin.get(f"{API}/scan/history?entity_type=asset&entity_id={a['id']}").json["items"][0]
    assert h["public"] is True and h["user"] is None
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.extensions import db

        ev = db.session.scalars(select(DomainEvent).where(DomainEvent.type == "scan.scanned")).all()[-1]
        assert ev.ip == "" and ev.actor_label == "Public scan"
    # parts, meters and work orders never show publicly; retired codes stop working
    wo = admin.post(f"{API}/work-orders", {"title": "x"}).json
    assert anon.get(f"{API}/public/scan/{code(admin, 'work_order', wo['id'])}").status_code == 404
    admin.patch(f"{API}/scan/settings", {"public_types": ["location"]})
    assert anon.get(f"{API}/public/scan/{v}").status_code == 404
    admin.patch(f"{API}/scan/settings", {"public_types": ["asset", "location"]})
    cid = admin.get(f"{API}/qr-codes/for/asset/{a['id']}").json["items"][0]["id"]
    admin.post(f"{API}/qr-codes/{cid}/retire")
    assert anon.get(f"{API}/public/scan/{v}").status_code == 404
    assert admin.patch(f"{API}/scan/settings", {"public_types": ["part"]}).status_code == 422


def test_public_scan_rate_limits(app: Any, admin: Api) -> None:
    anon = app.test_client()
    anon.environ_base["REMOTE_ADDR"] = "10.9.9.2"
    codes = [anon.get(f"{API}/public/scan/ZZZZZZZ{i:03d}").status_code for i in range(25)]
    assert codes[:20] == [404] * 20 and codes[-1] == 429
    other_ip = app.test_client()
    other_ip.environ_base["REMOTE_ADDR"] = "10.9.9.3"
    assert other_ip.get(f"{API}/public/scan/ZZZZZZZ999").status_code == 404
