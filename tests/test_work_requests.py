"""Work requests, request portals, customer portals and the Guest role (0.6.0: MP-047, MP-048, r236, r265)."""

from __future__ import annotations

import io
import uuid
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import PNG_1PX, login, team_id, uid

API = "/api/v1"
REQUESTER = "jamie.ortiz@example.com"
REQUESTER_2 = "drew.walker@example.com"
TECH = "avery.kim@example.com"


def submit(api: Api, **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/requests", {"title": "Leaking valve", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def first_location(admin: Api, name: str = "Building A") -> dict[str, Any]:
    r = admin.post(f"{API}/locations", {"name": name})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def an_asset(admin: Api) -> dict[str, Any]:
    loc = first_location(admin, "Plant")
    r = admin.post(f"{API}/assets", {"name": "Conveyor 3", "location_id": loc["id"]})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


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


def make_guest(app: Any, email: str = "guest@customer.example") -> str:
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.models import Membership, Organization

        org = db.session.scalars(select(Organization).order_by(Organization.created_at)).first()
        assert org is not None
        u = User(email=email, name="Gina Guest")
        u.set_password("guest-pass-123")
        db.session.add(u)
        db.session.flush()
        db.session.add(Membership(org_id=org.id, user_id=u.id, role="guest"))
        db.session.commit()
        return str(u.id)


# ---- the request flow (MP-047) -------------------------------------------------------------------------
def test_requester_submits_and_sees_only_their_own(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    drew = login(app, REQUESTER_2)
    loc = first_location(admin)
    r = submit(jamie, description="Water on the floor", priority="high", location_id=loc["id"])
    assert r["number"] == 1 and r["status"] == "pending" and r["location"]["id"] == loc["id"]
    assert r["can_edit"] and not r["can_decide"]
    submit(drew, title="Office too warm")
    assert jamie.get(f"{API}/requests").json["total"] == 1
    assert drew.get(f"{API}/requests/{r['id']}").status_code == 404
    assert admin.get(f"{API}/requests").json["total"] == 2
    # requesters can't approve, and can't see work orders at all
    assert jamie.post(f"{API}/requests/{r['id']}/approve", {}).status_code == 403
    assert jamie.get(f"{API}/work-orders").status_code == 403
    # the requester edits while pending
    assert jamie.patch(f"{API}/requests/{r['id']}", {"title": "Leaking valve at wash station"}).status_code == 200
    assert jamie.patch(f"{API}/requests/{r['id']}", {"status": "approved"}).status_code == 422


def test_approve_creates_linked_work_order_and_requester_sees_number_only(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    asset = an_asset(admin)
    r = submit(jamie, asset_id=asset["id"], priority="medium", description="Grinding noise")
    # a new request shows in the approver's badge until they open it (r299)
    assert admin.get(f"{API}/requests/badge").json["new"] == 1
    assert jamie.get(f"{API}/requests/badge").json["new"] == 0
    admin.get(f"{API}/requests/{r['id']}")
    assert admin.get(f"{API}/requests/badge").json["new"] == 0
    a = admin.post(f"{API}/requests/{r['id']}/approve", {"due_at": "2030-01-02T10:00:00Z"})
    assert a.status_code == 200, a.json
    wo = a.json["work_order"]
    full = admin.get(f"{API}/work-orders/{wo['id']}").json
    assert full["title"] == "Leaking valve" and full["priority"] == "medium" and full["asset"]["id"] == asset["id"]
    # requesters see the work order's number and status, not the work order (r277)
    seen = jamie.get(f"{API}/requests/{r['id']}").json
    assert seen["status"] == "approved" and seen["work_order"]["number"] == wo["number"]
    assert seen["work_order"]["id"] is None
    assert jamie.get(f"{API}/work-orders/{wo['id']}").status_code == 403
    # approving twice is refused
    assert admin.post(f"{API}/requests/{r['id']}/approve", {}).status_code == 409
    assert admin.post(f"{API}/requests/{r['id']}/decline", {"reason": "x"}).status_code == 409
    # the request follows its work order: Done, reopen, Canceled (r273)
    st = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert st.status_code == 200, st.json
    assert jamie.get(f"{API}/requests/{r['id']}").json["status"] == "done"
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "open"}).status_code == 200
    assert jamie.get(f"{API}/requests/{r['id']}").json["status"] == "approved"
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "canceled", "comment": "dup"}).status_code == 200
    assert jamie.get(f"{API}/requests/{r['id']}").json["status"] == "canceled"
    # searching by the linked work order's number finds the request (r298)
    assert admin.get(f"{API}/requests?q=%23{wo['number']}").json["total"] == 1


def test_approve_from_template_routes_to_team_and_copies_photos(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    up = jamie.c.post(
        f"{API}/files", data={"file": (io.BytesIO(PNG_1PX), "leak.png")}, headers=jamie._h(),
        content_type="multipart/form-data",
    )  # fmt: skip
    assert up.status_code == 201, up.json
    mech = team_id(admin, "Mechanical")
    r = submit(jamie, team_id=mech, file_ids=[up.json["id"]])
    assert len(r["files"]) == 1 and r["team"]["id"] == mech
    t = admin.post(f"{API}/work-order-templates", {"name": "Leak check", "data": {"description": "Check for leaks"}})
    assert t.status_code == 201, t.json
    a = admin.post(f"{API}/requests/{r['id']}/approve", {"template_id": t.json["id"]})
    assert a.status_code == 200, a.json
    wo = admin.get(f"{API}/work-orders/{a.json['work_order']['id']}").json
    assert any(x["type"] == "team" and x["id"] == mech for x in wo["assignees"])
    assert any(f["name"] == "leak.png" for f in wo["attachments"])


def test_decline_needs_reason_and_requester_sees_it(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    r = submit(jamie)
    assert admin.post(f"{API}/requests/{r['id']}/decline", {"reason": " "}).status_code == 422
    d = admin.post(f"{API}/requests/{r['id']}/decline", {"reason": "Duplicate of #12"})
    assert d.status_code == 200 and d.json["status"] == "declined"
    seen = jamie.get(f"{API}/requests/{r['id']}").json
    assert seen["decline_reason"] == "Duplicate of #12"
    # declined requests can be duplicated (r296), approved/done ones can't be changed
    dup = jamie.post(f"{API}/requests/{r['id']}/duplicate")
    assert dup.status_code == 201 and dup.json["status"] == "pending" and dup.json["number"] == 2
    assert jamie.patch(f"{API}/requests/{r['id']}", {"title": "again"}).status_code == 409
    # requesters cancel their own pending request
    assert jamie.post(f"{API}/requests/{dup.json['id']}/cancel").status_code == 200


def test_field_settings_required_hidden_and_routing(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    s = admin.patch(
        f"{API}/request-settings",
        {"fields": {"location": "required", "priority": "hidden"}, "assign_to": "required", "allow_other": True},
    )
    assert s.status_code == 200, s.json
    assert jamie.patch(f"{API}/request-settings", {"assign_to": "hidden"}).status_code == 403
    cfg = jamie.get(f"{API}/requests/form").json
    assert cfg["fields"]["location"] == "required" and cfg["assign_to"] == "required" and cfg["teams"]
    bad = jamie.post(f"{API}/requests", {"title": "No location"})
    assert bad.status_code == 422 and "Location" in bad.json["message"] and "Assign to" in bad.json["message"]
    loc = first_location(admin)
    r = submit(jamie, location_id=loc["id"], route_other=True, priority="high")
    assert r["priority"] == "none"  # hidden fields are ignored
    assert r["route_other"] is True
    # the form's own pickers work for requesters (who can't browse assets or locations)
    assert jamie.get(f"{API}/requests/form/locations").json["items"]
    assert jamie.get(f"{API}/assets").status_code == 403
    assert admin.patch(f"{API}/request-settings", {"fields": {"location": "maybe"}}).status_code == 422


def test_custom_request_fields(app: Any, admin: Api) -> None:
    f = admin.post(f"{API}/custom-fields", {"name": "Room number", "type": "text", "required": True,
                                           "on_request_form": True})  # fmt: skip
    assert f.status_code == 201, f.json
    secret = admin.post(f"{API}/custom-fields", {"name": "Internal code", "type": "text"}).json
    jamie = login(app, REQUESTER)
    assert [x["name"] for x in jamie.get(f"{API}/requests/form").json["custom_fields"]] == ["Room number"]
    assert jamie.post(f"{API}/requests", {"title": "x"}).status_code == 422
    r = submit(jamie, custom={f.json["id"]: "B-12", secret["id"]: "sneaky"})
    assert r["custom"] == {f.json["id"]: "B-12"}  # fields not on the form are dropped
    a = admin.post(f"{API}/requests/{r['id']}/approve", {})
    assert a.status_code == 200, a.json
    wo = admin.get(f"{API}/work-orders/{a.json['work_order']['id']}").json
    assert wo["custom"][f.json["id"]] == "B-12"


def test_comments_on_requests(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    r = submit(jamie)
    assert admin.post(f"{API}/requests/{r['id']}/comments", {"body": "On it today"}).status_code == 201
    assert jamie.post(f"{API}/requests/{r['id']}/comments", {"body": "Thanks"}).status_code == 201
    drew = login(app, REQUESTER_2)
    assert drew.post(f"{API}/requests/{r['id']}/comments", {"body": "me too"}).status_code == 404
    assert [c["body"] for c in jamie.get(f"{API}/requests/{r['id']}").json["comments"]] == ["On it today", "Thanks"]


def test_events_for_notifications(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    r = submit(jamie)
    admin.post(f"{API}/requests/{r['id']}/decline", {"reason": "No"})
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.extensions import db

        evs = db.session.scalars(select(DomainEvent).where(DomainEvent.entity_id == r["id"])).all()
        types = [e.type for e in evs]
        assert "request.created" in types and "request.declined" in types
        dec = next(e for e in evs if e.type == "request.declined")
        assert dec.data["reason"] == "No" and dec.data["created_by_id"] == uid(admin, REQUESTER)


def test_other_org_cannot_touch_requests(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    r = submit(jamie)
    other = other_org(app)
    assert other.get(f"{API}/requests/{r['id']}").status_code == 404
    assert other.get(f"{API}/requests").json["total"] == 0
    assert other.post(f"{API}/requests/{r['id']}/approve", {}).status_code == 404
    assert other.post(f"{API}/requests/{r['id']}/decline", {"reason": "x"}).status_code == 404
    assert other.post(f"{API}/requests/{r['id']}/comments", {"body": "x"}).status_code == 404
    # ids from another organization are refused in the form
    loc = first_location(admin)
    bad = other.post(f"{API}/requests", {"title": "x", "location_id": loc["id"]})
    assert bad.status_code == 422
    team = team_id(admin, "Mechanical")
    assert other.post(f"{API}/requests", {"title": "x", "team_id": team}).status_code == 422
    portal = admin.post(f"{API}/request-portals", {"name": "Front desk"}).json
    assert other.patch(f"{API}/request-portals/{portal['id']}", {"name": "mine"}).status_code == 404
    assert other.post(f"{API}/request-portals", {"name": "x", "location_id": loc["id"]}).status_code == 422


# ---- portals (MP-048, r279, r280, r300, r603, r265) ------------------------------------------------------
def anon(app: Any, ip: str = "10.1.0.1") -> Any:
    c = app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    return c


def test_portal_submit_status_link_and_emails(app: Any, admin: Api) -> None:
    p = admin.post(f"{API}/request-portals", {"name": "Report a problem", "intro": "Tell us"}).json
    assert p["path"].startswith("/portal/")
    c = anon(app)
    view = c.get(f"{API}/portal/{p['slug']}")
    assert view.status_code == 200 and view.json["name"] == "Report a problem"
    assert view.headers["Cache-Control"] == "no-store"
    assert "assets" not in view.json and "locations" not in view.json  # no lists of the org's data
    up = c.post(f"{API}/portal/{p['slug']}/files", data={"file": (io.BytesIO(PNG_1PX), "dryer.png")},
                content_type="multipart/form-data")  # fmt: skip
    assert up.status_code == 201, up.json
    s = c.post(f"{API}/portal/{p['slug']}/requests", json={
        "title": "Hand dryer broken", "name": "Sam", "email": "sam@example.com", "notify_email": True,
        "file_ids": [up.json["id"]],
    })  # fmt: skip
    assert s.status_code == 201, s.json
    token = s.json["status_token"]
    st = c.get(f"{API}/request-status/{token}").json
    assert st["status"] == "pending" and st["title"] == "Hand dryer broken"
    # staff see who sent it; approve → the submitter gets an email
    items = admin.get(f"{API}/requests").json["items"]
    req = next(x for x in items if x["title"] == "Hand dryer broken")
    assert req["submitter"]["email"] == "sam@example.com" and req["source"] == "portal" and len(req["files"]) == 1
    assert admin.post(f"{API}/requests/{req['id']}/approve", {}).status_code == 200
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import process_outbox
        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        process_outbox()
        subjects = [m.subject for m in db.session.scalars(select(OutboundEmail).filter_by(to="sam@example.com"))]
    assert any("we got your request" in s for s in subjects)
    assert any("approved" in s for s in subjects)
    st = c.get(f"{API}/request-status/{token}").json
    assert st["status"] == "approved" and st["work_order"]["number"] >= 1
    # the status page doesn't leak the submitter, files or anything else
    assert "email" not in str(st) and "files" not in st
    assert c.get(f"{API}/request-status/not-a-real-token-123").status_code == 404


def test_portal_upload_must_belong_to_that_portal(app: Any, admin: Api) -> None:
    a = admin.post(f"{API}/request-portals", {"name": "A"}).json
    b = admin.post(f"{API}/request-portals", {"name": "B"}).json
    c = anon(app, "10.1.0.2")
    up = c.post(f"{API}/portal/{a['slug']}/files", data={"file": (io.BytesIO(PNG_1PX), "x.png")},
                content_type="multipart/form-data")  # fmt: skip
    r = c.post(f"{API}/portal/{b['slug']}/requests", json={"title": "x", "name": "S", "file_ids": [up.json["id"]]})
    assert r.status_code == 422
    # a staff member's own file can't be claimed through a portal either
    mine = admin.c.post(f"{API}/files", data={"file": (io.BytesIO(PNG_1PX), "mine.png")}, headers=admin._h(),
                        content_type="multipart/form-data").json  # fmt: skip
    r = c.post(f"{API}/portal/{a['slug']}/requests", json={"title": "x", "name": "S", "file_ids": [mine["id"]]})
    assert r.status_code == 422


def test_portal_fields_targeting_and_inactive(app: Any, admin: Api) -> None:
    loc = first_location(admin)
    p = admin.post(
        f"{API}/request-portals",
        {"name": "Site form", "location_id": loc["id"], "require_email": True,
         "fields": {"description": "required", "priority": "hidden"}},
    ).json  # fmt: skip
    c = anon(app, "10.1.0.3")
    v = c.get(f"{API}/portal/{p['slug']}").json
    assert v["location"]["id"] == loc["id"] and v["fields"]["priority"] == "hidden"
    r = c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "x", "name": "S"})
    assert r.status_code == 422  # description and email are required
    r = c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "x", "name": "S", "email": "s@example.com",
                                                          "description": "d", "priority": "high"})  # fmt: skip
    assert r.status_code == 201, r.json
    req = next(x for x in admin.get(f"{API}/requests").json["items"] if x["source"] == "portal")
    assert req["location"]["id"] == loc["id"] and req["priority"] == "none"
    # turning the portal off makes the form disappear
    admin.patch(f"{API}/request-portals/{p['id']}", {"active": False})
    assert c.get(f"{API}/portal/{p['slug']}").status_code == 404
    # QR code for printing (r279)
    qr = admin.get(f"{API}/request-portals/{p['id']}/qr.svg")
    assert qr.status_code == 200 and qr.data.startswith(b"<?xml") or b"<svg" in qr.data


def test_portal_rate_limits_and_bot_field(app: Any, admin: Api) -> None:
    p = admin.post(f"{API}/request-portals", {"name": "Busy"}).json
    c = anon(app, "10.1.0.4")
    assert c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "x", "name": "B", "website": "spam"}).status_code == 422
    codes = [
        c.post(f"{API}/portal/{p['slug']}/requests", json={"title": f"r{i}", "name": "S"}).status_code for i in range(12)
    ]
    assert codes.count(201) <= 10 and 429 in codes
    # guessing slugs is limited too
    g = anon(app, "10.1.0.5")
    codes = [g.get(f"{API}/portal/guess-{i}").status_code for i in range(25)]
    assert 429 in codes


def test_customer_portal_carries_the_customer(app: Any, admin: Api) -> None:
    cust = admin.post(f"{API}/customers", {"name": "Harbor Foods"}).json
    p = admin.post(f"{API}/request-portals", {"name": "Harbor", "customer_id": cust["id"]}).json
    assert p["customer"]["id"] == cust["id"]
    assert [x["id"] for x in admin.get(f"{API}/request-portals?customer_id={cust['id']}").json["items"]] == [p["id"]]
    c = anon(app, "10.1.0.6")
    assert c.post(f"{API}/portal/{p['slug']}/requests", json={"title": "Freezer", "name": "Pat"}).status_code == 201
    assert admin.get(f"{API}/requests?customer_id={cust['id']}").json["total"] == 1


# ---- guests (r236) ------------------------------------------------------------------------------------------
def test_guest_sees_only_their_sites(app: Any, admin: Api) -> None:
    gid = make_guest(app)
    mine, other = first_location(admin, "Their site"), first_location(admin, "Our site")
    locs = [mine, other]
    cust = admin.post(f"{API}/customers", {"name": "Guest Co"}).json
    s = admin.c.put(f"{API}/guests/{gid}", json={"location_ids": [mine["id"]], "customer_id": cust["id"]},
                    headers=admin._h())  # fmt: skip
    assert s.status_code == 200, s.json
    here = admin.post(f"{API}/work-orders", {"title": "At their site", "location_id": mine["id"]}).json
    there = admin.post(f"{API}/work-orders", {"title": "Elsewhere", "location_id": other["id"]}).json
    guest = login(app, "guest@customer.example", "guest-pass-123")
    titles = [w["title"] for w in guest.get(f"{API}/work-orders").json["items"]]
    assert "At their site" in titles and "Elsewhere" not in titles
    assert guest.get(f"{API}/work-orders/{there['id']}").status_code in (403, 404)
    assert guest.get(f"{API}/work-orders/{here['id']}").status_code == 200
    # guests complete work and comment, but can't edit or create work orders
    assert guest.post(f"{API}/work-orders/{here['id']}/status", {"status": "done"}).status_code == 200
    assert guest.post(f"{API}/work-orders", {"title": "x"}).status_code == 403
    assert guest.get(f"{API}/assets").status_code == 403
    assert guest.get(f"{API}/users").status_code == 403
    # requests only at their locations; the form pickers only show their sites
    assert guest.post(f"{API}/requests", {"title": "x", "location_id": other["id"]}).status_code == 422
    r = submit(guest, location_id=mine["id"])
    assert {x["id"] for x in guest.get(f"{API}/requests/form/locations").json["items"]} <= {
        x["id"] for x in locs
    } and other["id"] not in {x["id"] for x in guest.get(f"{API}/requests/form/locations").json["items"]}
    # what they see of their requests: their own only, even with view-all-like data around
    assert guest.get(f"{API}/requests").json["total"] == 1 and r["status"] == "pending"
    home = guest.get(f"{API}/guest/home")
    assert home.status_code == 200 and home.json["access"]["customer"]["id"] == cust["id"]
    assert admin.get(f"{API}/guest/home").status_code == 403


def test_guest_role_not_assignable_and_quotes(app: Any, admin: Api) -> None:
    gid = make_guest(app, "g2@customer.example")
    wo = admin.post(f"{API}/work-orders", {"title": "x"}).json
    r = admin.patch(f"{API}/work-orders/{wo['id']}", {"assignees": [{"type": "user", "id": gid}]})
    assert r.status_code == 422
    cust = admin.post(f"{API}/customers", {"name": "Quote Co"}).json
    other_cust = admin.post(f"{API}/customers", {"name": "Not theirs"}).json
    admin.c.put(f"{API}/guests/{gid}", json={"location_ids": [], "customer_id": cust["id"]}, headers=admin._h())
    q = admin.post(f"{API}/quotes", {"customer_id": cust["id"], "title": "Freezer repair",
                                     "lines": [{"description": "Labor", "quantity": "2", "unit_price": "80"}]})  # fmt: skip
    assert q.status_code == 201, q.json
    admin.post(f"{API}/quotes/{q.json['id']}/send", {"emails": ["buyer@example.com"]})
    q2 = admin.post(f"{API}/quotes", {"customer_id": other_cust["id"], "title": "Nope",
                                      "lines": [{"description": "x", "quantity": "1", "unit_price": "1"}]}).json  # fmt: skip
    guest = login(app, "g2@customer.example", "guest-pass-123")
    quotes = guest.get(f"{API}/guest/home").json["quotes"]
    assert [x["title"] for x in quotes] == ["Freezer repair"]
    assert guest.post(f"{API}/guest/quotes/{q2['id']}/decide", {"approve": True}).status_code == 404
    d = guest.post(f"{API}/guest/quotes/{q.json['id']}/decide", {"approve": True})
    assert d.status_code == 200, d.json
    assert d.json["status"] == "approved"


def test_guest_access_settings_validated(app: Any, admin: Api) -> None:
    gid = make_guest(app, "g3@customer.example")
    tech = uid(admin, TECH)
    bad = admin.c.put(f"{API}/guests/{tech}", json={"location_ids": []}, headers=admin._h())
    assert bad.status_code == 422  # not a guest
    bad = admin.c.put(f"{API}/guests/{gid}", json={"location_ids": [str(uuid.uuid4())]}, headers=admin._h())
    assert bad.status_code == 422
    assert [g["user_id"] for g in admin.get(f"{API}/guests").json["items"]] == [gid]
    jamie = login(app, REQUESTER)
    assert jamie.get(f"{API}/guests").status_code == 403


def test_deleting_the_work_order_cancels_the_request(app: Any, admin: Api) -> None:
    jamie = login(app, REQUESTER)
    r = submit(jamie)
    wo = admin.post(f"{API}/requests/{r['id']}/approve", {}).json["work_order"]
    assert admin.delete(f"{API}/work-orders/{wo['id']}").status_code == 204
    with app.app_context():
        from mpro.core.events import process_outbox

        process_outbox()
    seen = jamie.get(f"{API}/requests/{r['id']}").json
    assert seen["status"] == "canceled"
