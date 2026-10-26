# ruff: noqa: E501
"""0.6.0 security review fixes: public surfaces (portals, public scans, realtime, require-a-scan)."""

from __future__ import annotations

import io
import uuid
from datetime import timedelta
from typing import Any

from tests.conftest import Api
from tests.test_scan_actions import asset, code, location, procedure, scan
from tests.test_work_orders import PNG_1PX, login, uid
from tests.test_work_requests import first_location, make_guest

API = "/api/v1"


def anon(app: Any, ip: str) -> Any:
    c = app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    return c


def portal(admin: Api, **kw: Any) -> dict[str, Any]:
    r = admin.post(f"{API}/request-portals", {"name": "Report a problem", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def upload(c: Any, slug: str, data: bytes = PNG_1PX, name: str = "p.png") -> Any:
    return c.post(
        f"{API}/portal/{slug}/files", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data"
    )


# ---- M1: the realtime broker pages through bursts --------------------------------------------------------------------
def test_m1_broker_does_not_stall_after_a_burst(app: Any, admin: Api) -> None:
    with app.app_context():
        from mpro.core import realtime
        from mpro.core.models import utcnow
        from mpro.extensions import db
        from mpro.orgs.models import Organization

        org_id = db.session.query(Organization.id).first()[0]
        t0 = utcnow()
        db.session.add_all(
            [
                realtime.RealtimeEvent(org_id=org_id, topic="org:work_order", type="burst", data={}, at=t0)
                for _ in range(2500)
            ]
        )
        late = realtime.RealtimeEvent(
            org_id=org_id, topic="org:work_order", type="late", data={}, at=t0 + timedelta(seconds=1)
        )
        db.session.add(late)
        db.session.commit()
        late_id = str(late.id)
        b = realtime.Broker()
        b.last_at = t0 - timedelta(seconds=1)
        sub = realtime.Subscription(org_id)
        sub.q.maxsize = 0  # unbounded for the test
        got: set[str] = set()
        for _ in range(3):
            b.poll_once([sub])
            while not sub.q.empty():
                got.add(sub.q.get_nowait()["id"])
        burst = {
            str(i)
            for (i,) in db.session.query(realtime.RealtimeEvent.id).filter(realtime.RealtimeEvent.type == "burst")
        }
        assert late_id in got and burst <= got


def test_m1_bulk_edit_writes_one_org_row_per_topic(app: Any, admin: Api) -> None:
    ids = [admin.post(f"{API}/work-orders", {"title": f"WO {i}"}).json["id"] for i in range(12)]
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.core.realtime import RealtimeEvent
        from mpro.extensions import db

        before = db.session.scalar(
            select(func.count()).select_from(RealtimeEvent).where(RealtimeEvent.topic == "org:work_order")
        )
    r = admin.post(f"{API}/work-orders/bulk", {"ids": ids, "action": "set_priority", "value": "high"})
    assert r.status_code == 200, r.json
    with app.app_context():
        after = db.session.scalar(
            select(func.count()).select_from(RealtimeEvent).where(RealtimeEvent.topic == "org:work_order")
        )
    assert after - before == 1


# ---- M2 / L1: portal uploads ----------------------------------------------------------------------------------------
def test_m2_uploads_do_not_use_up_the_submit_limit(app: Any, admin: Api) -> None:
    p = portal(admin)
    c = anon(app, "10.20.0.1")
    fids = []
    for _ in range(10):
        r = upload(c, p["slug"])
        assert r.status_code == 201, r.json
        fids.append(r.json["id"])
    r = c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "Broken door", "name": "Sam", "file_ids": fids})
    assert r.status_code == 201, r.json


def test_l1_ipv6_addresses_share_a_bucket_per_64() -> None:
    from mpro.core.ratelimit import ip_key

    assert ip_key("2001:db8:1:2:aaaa::1") == ip_key("2001:db8:1:2:bbbb::9")
    assert ip_key("2001:db8:1:3::1") != ip_key("2001:db8:1:2::1")
    assert ip_key("10.0.0.1") == "10.0.0.1" and ip_key("10.0.0.1") != ip_key("10.0.0.2")
    assert ip_key("::ffff:10.0.0.1") == "10.0.0.1"
    assert ip_key("") == "?" and ip_key("not an ip")[:10] == "not an ip"[:10]


def test_l1_portal_failed_attempts_bucket_ipv6(app: Any, admin: Api) -> None:
    from mpro.workrequests import services as svc

    for i in range(svc.LIMIT_FAILED_15MIN):
        anon(app, f"2001:db8:9:9::{i + 1:x}").get(f"{API}/portal/nope-{i}")
    assert anon(app, "2001:db8:9:9::ffff").get(f"{API}/portal/nope-x").status_code == 429


def test_l1_anonymous_upload_size_type_and_portal_caps(app: Any, admin: Api) -> None:
    from mpro.workrequests import services as svc

    p = portal(admin)
    app.config["MPRO_PUBLIC_UPLOAD_MB"] = 1
    big = PNG_1PX + b"\0" * (1024 * 1024 + 10)
    assert upload(anon(app, "10.21.0.1"), p["slug"], big).status_code == 413
    # the name says PDF / MP4 but the bytes aren't
    assert upload(anon(app, "10.21.0.2"), p["slug"], b"MZ\x90\x00not a pdf", "x.pdf").status_code == 422
    assert upload(anon(app, "10.21.0.2"), p["slug"], b"\x00\x00\x00\x18notmp4", "x.mp4").status_code == 422
    assert upload(anon(app, "10.21.0.2"), p["slug"], b"%PDF-1.7\n%%EOF\n", "ok.pdf").status_code == 201
    # a portal takes only so many anonymous uploads an hour, whatever the IPs
    p2 = portal(admin, name="Second form")
    old = svc.LIMIT_UPLOADS_PER_HOUR_PORTAL
    svc.LIMIT_UPLOADS_PER_HOUR_PORTAL = 3
    try:
        codes = [upload(anon(app, f"10.22.0.{i}"), p2["slug"]).status_code for i in range(5)]
    finally:
        svc.LIMIT_UPLOADS_PER_HOUR_PORTAL = old
    assert codes[:2] == [201, 201] and codes[-1] == 429


# ---- L2: confirmation emails ----------------------------------------------------------------------------------------
def test_l2_confirmation_has_no_submitter_text_and_a_recipient_cap(app: Any, admin: Api) -> None:
    p = portal(admin)
    victim = "victim@example.net"
    for i in range(5):
        r = anon(app, f"10.23.0.{i}").post(f"{API}/portal/{p['slug']}/requests",
                                            json={"title": "BUY CHEAP PILLS http://spam.example", "name": "Click here http://x.example", "email": victim})  # fmt: skip
        assert r.status_code == 201, r.json
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        mails = db.session.scalars(select(OutboundEmail).where(OutboundEmail.to == victim)).all()
    assert 1 <= len(mails) <= 3
    for m in mails:
        assert "PILLS" not in m.body and "spam.example" not in m.body and "x.example" not in m.body
        assert "/request-status/" in m.body


# ---- M3 / customer portals: places outside someone's scope ----------------------------------------------------------
def test_m3_guest_cannot_file_against_an_asset_elsewhere(app: Any, admin: Api) -> None:
    gid = make_guest(app, "g9@customer.example")
    mine, other = first_location(admin, "Their site"), first_location(admin, "Our site")
    secret = admin.post(f"{API}/assets", {"name": "Secret Chiller", "location_id": other["id"]}).json
    loose = admin.post(f"{API}/assets", {"name": "Loose Pump"}).json  # no location
    admin.c.put(f"{API}/guests/{gid}", json={"location_ids": [mine["id"]]}, headers=admin._h())
    guest = login(app, "g9@customer.example", "guest-pass-123")
    r = guest.post(f"{API}/requests", {"title": "x", "location_id": mine["id"], "asset_id": secret["id"]})
    assert r.status_code == 422 and "Secret" not in str(r.json)
    assert guest.post(f"{API}/requests", {"title": "x", "asset_id": secret["id"]}).status_code == 422
    assert guest.post(f"{API}/requests", {"title": "x", "asset_id": loose["id"]}).status_code == 422
    ok = guest.post(f"{API}/requests", {"title": "fine", "location_id": mine["id"]})
    assert ok.status_code == 201, ok.json
    r = guest.patch(f"{API}/requests/{ok.json['id']}", {"asset_id": secret["id"]})
    assert r.status_code == 422


def test_customer_portal_only_takes_the_customers_places(app: Any, admin: Api) -> None:
    theirs = first_location(admin, "Harbor store")
    cust = admin.post(f"{API}/customers", {"name": "Harbor Foods", "location_ids": [theirs["id"]]}).json
    ours = first_location(admin, "Our plant")
    our_asset = admin.post(f"{API}/assets", {"name": "Our Press", "location_id": ours["id"]}).json
    p = portal(admin, name="Harbor", customer_id=cust["id"])
    c = anon(app, "10.24.0.1")
    send = lambda **kw: c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "x", "name": "Sam", **kw})  # noqa: E731
    assert send(location_id=ours["id"]).status_code == 422
    assert send(asset_id=our_asset["id"]).status_code == 422
    assert send(location_id=theirs["id"]).status_code == 201


# ---- L7: asset-only portals keep their asset ------------------------------------------------------------------------
def test_l7_asset_portal_ignores_another_asset_in_the_link(app: Any, admin: Api) -> None:
    a = admin.post(f"{API}/assets", {"name": "Lobby Door"}).json
    b = admin.post(f"{API}/assets", {"name": "Server Rack"}).json
    p = portal(admin, name="Door", asset_id=a["id"])
    form = anon(app, "10.25.0.1").get(f"{API}/portal/{p['slug']}?asset={b['id']}")
    assert form.status_code == 200 and form.json["asset"]["name"] == "Lobby Door"


# ---- M4: require-a-scan needs a real code scan ----------------------------------------------------------------------
def test_m4_a_manual_scan_event_does_not_satisfy_require_a_scan(app: Any, admin: Api) -> None:
    loc = location(admin)
    a = asset(admin, location_id=loc["id"])
    p = procedure(admin)
    admin.c.put(
        f"{API}/procedures/{p['id']}/scan-requirement", json={"on_start": True}, headers={"X-CSRF-Token": admin.csrf}
    )
    avery = uid(admin, "avery.kim@example.com")
    wo = admin.post(f"{API}/work-orders", {"title": "Round", "asset_id": a["id"], "procedures": [p["id"]],
                                           "assignees": [{"type": "user", "id": avery}]}).json  # fmt: skip
    tech = login(app, "avery.kim@example.com")
    for action in ("scan", "check_in"):
        et, eid = ("asset", a["id"]) if action == "scan" else ("location", loc["id"])
        r = tech.post(
            f"{API}/scan/events", {"entity_type": et, "entity_id": eid, "action": action, "client_id": f"c-{action}"}
        )
        assert r.status_code == 201, r.json
    assert (
        tech.post(
            f"{API}/scan/events", {"entity_type": "work_order", "entity_id": wo["id"], "action": "scan"}
        ).status_code
        == 201
    )
    assert tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 422
    # an offline scan synced later with the code value counts
    v = code(admin, "asset", a["id"])
    r = tech.post(
        f"{API}/scan/events",
        {"entity_type": "asset", "entity_id": a["id"], "code": v, "source": "offline", "client_id": "c-code"},
    )
    assert r.status_code == 201
    assert tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 200


def test_m4_the_window_uses_the_server_clock(app: Any, admin: Api) -> None:
    a = asset(admin)
    p = procedure(admin)
    admin.c.put(
        f"{API}/procedures/{p['id']}/scan-requirement", json={"on_start": True}, headers={"X-CSRF-Token": admin.csrf}
    )
    avery = uid(admin, "avery.kim@example.com")
    wo = admin.post(f"{API}/work-orders", {"title": "Round", "asset_id": a["id"], "procedures": [p["id"]],
                                           "assignees": [{"type": "user", "id": avery}]}).json  # fmt: skip
    tech = login(app, "avery.kim@example.com")
    v = code(admin, "asset", a["id"])
    assert scan(tech, v).status_code == 200
    with app.app_context():
        from datetime import UTC, datetime

        from sqlalchemy import update

        from mpro.extensions import db
        from mpro.qr.models import ScanEvent

        # a phone clock running ahead can't stretch the window: only the server's time counts
        db.session.execute(
            update(ScanEvent).values(created_at=datetime.now(UTC) - timedelta(hours=5), scanned_at=datetime.now(UTC))
        )
        db.session.commit()
    assert tech.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 422


# ---- L3: work order codes and limited visibility --------------------------------------------------------------------
def test_l3_scanning_a_hidden_work_order_reveals_nothing(app: Any, admin: Api) -> None:
    wo = admin.post(f"{API}/work-orders", {"title": "Executive office leak"}).json
    v = code(admin, "work_order", wo["id"])
    riley = uid(admin, "riley.chen@example.com")
    assert admin.patch(f"{API}/users/{riley}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    r_api = login(app, "riley.chen@example.com")
    r = r_api.get(f"{API}/scan?value={v}")
    assert r.status_code in (403, 404) and "Executive" not in str(r.json)
    r = r_api.get(f"{API}/qr-codes/for/work_order/{wo['id']}")
    assert r.status_code in (403, 404)


# ---- L4: one person can't take every live stream --------------------------------------------------------------------
def test_l4_streams_are_capped_per_person(app: Any, admin: Api) -> None:
    with app.app_context():
        from mpro.core import realtime

        b = realtime.Broker()
        org, alex, sam = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        subs = [b.try_subscribe(app, org, alex, max_total=16, max_per_user=3) for _ in range(5)]
        assert sum(s is not None for s in subs) == 3
        assert b.try_subscribe(app, org, sam, max_total=16, max_per_user=3) is not None
        for s in subs:
            if s is not None:
                b.unsubscribe(s)
        assert b.try_subscribe(app, org, alex, max_total=16, max_per_user=3) is not None
        b.generation += 1  # stop the test broker's thread


# ---- L5: scan replays and history counts ----------------------------------------------------------------------------
def test_l5_client_ids_are_per_person_and_history_total_matches(app: Any, admin: Api) -> None:
    a = asset(admin)
    v = code(admin, "asset", a["id"])
    tech = login(app, "avery.kim@example.com")
    first = scan(admin, v, client_id="same-id").json
    second = scan(tech, v, client_id="same-id").json
    assert first["scan_id"] != second["scan_id"]
    mine = tech.get(f"{API}/scan/history").json
    assert any(x["id"] == second["scan_id"] for x in mine["items"])
    # a requester without scan.history: the total counts only what they get to see
    req = login(app, "jamie.ortiz@example.com")
    h = req.get(f"{API}/scan/history").json
    assert h["total"] == len(h["items"]) == 0
    # someone with scan.history but limited work orders: hidden work order scans aren't counted
    wo = admin.post(f"{API}/work-orders", {"title": "Hidden"}).json
    scan(admin, code(admin, "work_order", wo["id"]))
    riley = uid(admin, "riley.chen@example.com")
    admin.patch(f"{API}/users/{riley}/work-settings", {"wo_visibility": "limited"})
    h = login(app, "riley.chen@example.com").get(f"{API}/scan/history?per_page=200").json
    assert h["total"] == len(h["items"])
