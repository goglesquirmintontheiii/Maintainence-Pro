"""0.6.0 security review: MPro Management, account deletion, messaging notifications and parts (findings #1–#13).

Each test failed before its fix (G-13)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from tests.conftest import Api
from tests.test_assets import upload
from tests.test_requests_060_parts import add
from tests.test_sysadmin import PW, _make_sysadmin, _other_owner
from tests.test_work_orders import create as create_wo
from tests.test_work_orders import login, team_id, uid

API = "/api/v1"
SA = "/api/v1/sysadmin"


def _outbox(app: Any) -> None:
    with app.app_context():
        from mpro.core.events import process_outbox

        process_outbox()


# ---- #1 the email outbox never shows links that sign someone in ---------------------------------
def test_outbox_hides_sign_in_links_and_other_peoples_resets(app: Any, admin: Api) -> None:
    _make_sysadmin(app)  # the owner of the demo org is the server's sysadmin
    anon = Api(app.test_client())
    anon.post(f"{API}/auth/password/forgot", {"email": "admin@example.com"})
    # an invitation is this organization's email, but its link is hidden
    r = admin.post(f"{API}/users", {"email": "newbie@example.com", "name": "New Bie", "role": "technician"})
    assert r.status_code in (200, 201), r.json
    items = admin.get(f"{API}/outbox").json["items"]
    assert all("Reset your Maintenance Pro password" not in m["subject"] for m in items)
    bodies = " ".join(m["body"] for m in items)
    assert "/reset-password/" in bodies and "/reset-password/[Link hidden]" in bodies
    import re

    assert not re.search(r"/reset-password/(?!\[Link hidden\])", bodies)


# ---- #2 message notifications follow who can open the conversation now ---------------------------
def _message_targets(app: Any, message_id: str) -> set[str]:
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.extensions import db
        from mpro.notifications.routes_external import messages
        from mpro.notifications.services import _member

        ev = next(
            e
            for e in db.session.scalars(select(DomainEvent).where(DomainEvent.type == "message.created"))
            if (e.data or {}).get("message_id") == message_id
        )
        out = set()
        for t in messages(ev):
            m = _member(ev.org_id, t.user_id)
            if m is not None and (t.check is None or t.check(m)):
                out.add(str(t.user_id))
        return out


def test_message_notifications_respect_team_membership(app: Any, admin: Api) -> None:
    mech = team_id(admin, "Mechanical")
    me, avery, riley = (
        uid(admin, "admin@example.com"),
        uid(admin, "avery.kim@example.com"),
        uid(admin, "riley.chen@example.com"),
    )
    for u in (me, riley):
        admin.post(f"{API}/teams/{mech}/members", {"user_id": u})
    av = login(app, "avery.kim@example.com")
    tc = av.post(f"{API}/teams/{mech}/conversation").json
    assert av.post(f"{API}/conversations/{tc['id']}/read").status_code == 204  # Avery has a row now
    assert admin.delete(f"{API}/teams/{mech}/members/{avery}").status_code in (200, 204)
    msg = admin.post(f"{API}/conversations/{tc['id']}/messages", {"body": "Belt guard is off on line 2"}).json
    got = _message_targets(app, msg["id"])
    assert avery not in got  # left the team: no more excerpts on their phone
    assert riley in got  # a team member who never opened the chat still hears about it


# ---- #3, #4 deleting your own account --------------------------------------------------------------
def test_last_sysadmin_cant_delete_their_account_and_leftovers_go(app: Any, admin: Api) -> None:
    _make_sysadmin(app)
    r = admin.c.delete(f"{API}/me/account", json={"password": PW, "confirm": "DELETE"}, headers=admin._h())
    assert r.status_code == 409 and "sysadmin" in r.json["message"]
    # someone else: their devices, settings and name in history go with the account
    jordan = login(app, "jordan.reyes@example.com")
    jid = uid(admin, "jordan.reyes@example.com")
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.models import PushSubscription

        db.session.add(
            PushSubscription(
                endpoint="https://fcm.googleapis.com/fcm/send/abc", user_id=uuid.UUID(jid), p256dh="x", auth="y"
            )
        )
        db.session.commit()
    jordan.patch(f"{API}/notifications/settings", {"comments": "mentions"})
    create_wo(jordan, title="Jordan's leak")
    r = jordan.c.delete(f"{API}/me/account", json={"password": PW, "confirm": "DELETE"}, headers=jordan._h())
    assert r.status_code == 204, r.json
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.notifications.models import NotificationPref

        u = uuid.UUID(jid)
        assert db.session.scalars(select(PushSubscription).where(PushSubscription.user_id == u)).first() is None
        assert db.session.scalars(select(NotificationPref).where(NotificationPref.user_id == u)).first() is None
        labels = {e.actor_label for e in db.session.scalars(select(DomainEvent).where(DomainEvent.actor_id == u))}
        assert labels == {"Deleted user"}


# ---- #5 signing out stops this device's push notifications -------------------------------------------
def test_sign_out_drops_this_devices_push_subscription(app: Any, admin: Api) -> None:
    me = uid(admin, "admin@example.com")
    ep = "https://fcm.googleapis.com/fcm/send/kiosk"
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.models import PushSubscription

        db.session.add(PushSubscription(endpoint=ep, user_id=uuid.UUID(me), p256dh="x", auth="y"))
        db.session.add(
            PushSubscription(endpoint=ep + "-phone", user_id=uuid.UUID(me), p256dh="x", auth="y")
        )  # another device stays
        db.session.commit()
    assert admin.post(f"{API}/auth/logout", {"push_endpoint": ep}).status_code == 200
    with app.app_context():
        from sqlalchemy import select

        left = db.session.scalars(select(PushSubscription.endpoint).where(PushSubscription.user_id == uuid.UUID(me)))
        assert list(left) == [ep + "-phone"]


# ---- #6 a wrong password changes nothing ---------------------------------------------------------------
def test_wrong_password_saves_nothing(app: Any, admin: Api) -> None:
    _make_sysadmin(app)
    _make_sysadmin(app, "jordan.reyes@example.com")
    jid = uid(admin, "jordan.reyes@example.com")
    r = admin.patch(
        f"{SA}/users/{jid}", {"email": "new@x.example", "active": False, "sysadmin": False, "password": "wrong"}
    )
    assert r.status_code == 403
    d = admin.get(f"{SA}/users/{jid}").json
    assert d["email"] == "jordan.reyes@example.com" and d["active"] and d["sysadmin"]


# ---- #7 the demo account (public password) is never a real server's sysadmin ------------------------
def test_demo_admin_is_not_a_sysadmin_outside_test_builds(app: Any, capsys: Any) -> None:
    with app.app_context():
        from mpro.sysadmin.services import has_sysadmin

        assert not has_sysadmin()  # seed_demo ran without MPRO_TEST_BUILD
    _make_sysadmin(app)  # an older server where the demo admin became one
    from mpro.cli import _create_admin

    _create_admin(app, "boss@company.example", "Bea Boss", "Company", "a-long-password-1")
    assert "demo account" in capsys.readouterr().err
    with app.app_context():
        from mpro.auth.services import get_user_by_email

        u = get_user_by_email("boss@company.example")
        assert u is not None and u.is_sysadmin


def test_test_builds_still_make_the_demo_admin_a_sysadmin(app: Any) -> None:
    app.config["MPRO_TEST_BUILD"] = True
    with app.app_context():
        from mpro.auth.services import get_user_by_email
        from mpro.sysadmin.demo import seed

        admin_user = get_user_by_email("admin@example.com")
        seed(None, admin_user)
        assert get_user_by_email("admin@example.com").is_sysadmin  # type: ignore[union-attr]


# ---- #8 two "Done" at once use parts up once -------------------------------------------------------------
def test_two_done_at_once_use_parts_once(app: Any, admin: Api) -> None:
    """Two requests mark the same work order Done at the same moment (the web app and a phone replaying offline
    work). Needs real row locks, so it runs on PostgreSQL."""
    import contextlib
    import os
    import threading

    import pytest

    if not (os.environ.get("TEST_DATABASE_URL") or "").startswith("postgresql"):
        pytest.skip("row locks need PostgreSQL")
    from tests.test_parts import stocked

    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    add(admin, wo, p, wh, "3", "assigned")
    from mpro.workorders import services as wos

    barrier = threading.Barrier(2, timeout=3)

    def meet(org: Any, m: Any, w: Any) -> None:  # both requests got past the status check: now race
        # if the other one is waiting for our lock (the fix), the barrier times out and we carry on
        with contextlib.suppress(threading.BrokenBarrierError):
            barrier.wait()

    errors: list[BaseException] = []

    def done() -> None:
        try:
            with app.app_context():
                from sqlalchemy import select

                from mpro.extensions import db
                from mpro.orgs.models import Membership, Organization
                from mpro.workorders.models import WorkOrder

                w = db.session.get(WorkOrder, uuid.UUID(wo["id"]))
                assert w is not None
                org = db.session.get(Organization, w.org_id)
                m = db.session.scalars(
                    select(Membership).where(Membership.org_id == w.org_id, Membership.role == "owner")
                ).first()
                wos.set_status(org, m, w, "done")
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    wos.COMPLETION_CHECKS.append(meet)
    try:
        ts = [threading.Thread(target=done) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
    finally:
        wos.COMPLETION_CHECKS.remove(meet)
    assert not errors, errors
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "7"
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.extensions import db
        from mpro.workorders.models import StatusChange

        n = db.session.scalar(
            select(func.count())
            .select_from(StatusChange)
            .where(StatusChange.work_order_id == uuid.UUID(wo["id"]), StatusChange.to_status == "done")
        )
        assert n == 1  # one completion: one "Done" in the activity, one round of notifications


# ---- #9 pictures must be your own upload -------------------------------------------------------------------
def test_pictures_must_be_uploaded_by_the_person_setting_them(app: Any, admin: Api) -> None:
    from tests.test_parts import part

    jordan = login(app, "jordan.reyes@example.com")
    theirs = upload(jordan, "secret.png")
    mine = upload(admin, "logo.png")
    p = part(admin, "V-belt A42")
    assert admin.patch(f"{API}/parts/{p['id']}", {"picture_file_id": theirs}).status_code == 422
    assert admin.patch(f"{API}/parts/{p['id']}", {"picture_file_id": mine}).status_code == 200
    assert admin.patch(f"{API}/notifications/org-settings", {"brand_logo_file_id": theirs}).status_code == 422
    assert admin.patch(f"{API}/notifications/org-settings", {"brand_logo_file_id": mine}).status_code == 200
    g = admin.post(
        f"{API}/conversations", {"kind": "group", "name": "Crew", "user_ids": [uid(admin, "sam.patel@example.com")]}
    ).json
    assert admin.patch(f"{API}/conversations/{g['id']}", {"picture_file_id": theirs}).status_code == 422
    assert admin.patch(f"{API}/conversations/{g['id']}", {"picture_file_id": mine}).status_code == 200


# ---- #10 a deleted organization notifies no one --------------------------------------------------------------
def test_deleted_org_gets_no_due_date_notices(app: Any, admin: Api) -> None:
    from datetime import UTC, datetime

    due = (datetime.now(UTC) - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
    create_wo(admin, title="Overdue thing", due_at=due)
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.core.models import utcnow
        from mpro.extensions import db
        from mpro.notifications.services import scan_due
        from mpro.orgs.models import Organization

        for o in db.session.scalars(select(Organization)):
            o.deleted_at = utcnow()
        db.session.commit()
        scan_due()
        db.session.commit()
        assert db.session.scalars(select(DomainEvent).where(DomainEvent.type == "wo.overdue")).first() is None


# ---- #11 joining an organization yourself, or making an Owner, needs your password ---------------------------
def test_owner_or_self_membership_needs_password(app: Any, admin: Api) -> None:
    _make_sysadmin(app)
    _other_owner(app)
    other = next(o for o in admin.get(f"{SA}/orgs").json["items"] if o["name"] == "Olive Bakery")
    r = admin.post(f"{SA}/orgs/{other['id']}/members", {"email": "admin@example.com", "role": "technician"})
    assert r.status_code == 403
    r = admin.post(f"{SA}/orgs/{other['id']}/members", {"email": "x@example.com", "role": "owner"})
    assert r.status_code == 403
    r = admin.post(f"{SA}/orgs/{other['id']}/members", {"email": "x@example.com", "role": "technician"})
    assert r.status_code == 201, r.json
    xid = next(m["user_id"] for m in r.json["member_list"] if m["email"] == "x@example.com")
    assert admin.patch(f"{SA}/orgs/{other['id']}/members/{xid}", {"role": "owner"}).status_code == 403
    r = admin.patch(f"{SA}/orgs/{other['id']}/members/{xid}", {"role": "owner", "password": PW})
    assert r.status_code == 200, r.json


# ---- #12 a new password ends other sessions ----------------------------------------------------------------------
def test_new_password_ends_other_sessions(app: Any, admin: Api) -> None:
    _make_sysadmin(app)
    jordan = login(app, "jordan.reyes@example.com")
    jid = uid(admin, "jordan.reyes@example.com")
    assert jordan.get(f"{API}/work-orders").status_code == 200
    r = admin.post(
        f"{SA}/users/{jid}/reset-password", {"mode": "set", "new_password": "brand-new-pass-1", "password": PW}
    )
    assert r.status_code == 200, r.json
    assert jordan.get(f"{API}/work-orders").status_code == 401
    # changing your own password keeps you signed in here, and signs out your other sessions
    phone = login(app, "jordan.reyes@example.com", "brand-new-pass-1")
    desk = login(app, "jordan.reyes@example.com", "brand-new-pass-1")
    r = desk.post(f"{API}/auth/password/change", {"current": "brand-new-pass-1", "new": "another-pass-22"})
    assert r.status_code == 200, r.json
    assert desk.get(f"{API}/work-orders").status_code == 200
    assert phone.get(f"{API}/work-orders").status_code == 401


# ---- #13 "false" is false --------------------------------------------------------------------------------------------
def test_server_setting_false_text_is_false(app: Any, admin: Api) -> None:
    _make_sysadmin(app)
    r = admin.patch(f"{SA}/server-settings", {"smtp_tls": "false"})
    assert r.status_code == 200, r.json
    from mpro.sysadmin.server_settings import validate

    assert validate({"smtp_tls": "false"})["smtp_tls"] is False
    assert validate({"smtp_tls": "0"})["smtp_tls"] is False
    assert validate({"smtp_tls": "on"})["smtp_tls"] is True
