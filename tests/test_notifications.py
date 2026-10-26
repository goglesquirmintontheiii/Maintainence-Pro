"""Notifications (0.6.0: MP-050–MP-052): routing, preferences, quiet hours, digests, push, escalations."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from tests.conftest import Api
from tests.test_work_orders import create, login, team_id, uid

API = "/api/v1"


def flush(app: Any) -> None:
    """Run the outbox (event consumers) and queued jobs, like the background worker does."""
    with app.app_context():
        from mpro.core.events import process_outbox
        from mpro.core.jobs import run_pending

        while process_outbox():
            pass
        run_pending()


def inbox(api: Api, **q: Any) -> list[dict[str, Any]]:
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    r = api.get(f"{API}/notifications?{qs}")
    assert r.status_code == 200, r.json
    return r.json["items"]  # type: ignore[no-any-return]


def emails_to(app: Any, to: str) -> list[Any]:
    with app.app_context():
        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        return [
            {"subject": m.subject, "body": m.body, "html": m.html}
            for m in db.session.query(OutboundEmail).filter_by(to=to).order_by(OutboundEmail.created_at)
        ]


def assign(api: Api, wo_id: str, *people: tuple[str, str]) -> None:
    r = api.patch(f"{API}/work-orders/{wo_id}", {"assignees": [{"type": t, "id": i} for t, i in people]})
    assert r.status_code == 200, r.json


# ---- routing ---------------------------------------------------------------------------------------
def test_assignment_reaches_assignee_not_actor_and_bell_counts(app: Any, admin: Api) -> None:
    flush(app)  # demo events
    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    before = tech.get(f"{API}/notifications/unread-count").json["unread"]
    wo = create(admin, title="Grease bearings", assignees=[{"type": "user", "id": avery}])
    flush(app)
    items = inbox(tech)
    n = next(i for i in items if i["entity_id"] == wo["id"])
    assert n["kind"] == "wo.assigned" and "Grease bearings" in n["title"] and n["link"] == f"/work-orders/{wo['id']}"
    assert n["actor"] == "Alex Morgan"
    assert tech.get(f"{API}/notifications/unread-count").json["unread"] == before + 1
    # the person who did it isn't notified
    assert not [i for i in inbox(admin) if i["entity_id"] == wo["id"]]
    # read / unread / all
    assert tech.post(f"{API}/notifications/read", {"ids": [n["id"]]}).json["unread"] == before
    assert tech.post(f"{API}/notifications/read", {"ids": [n["id"]], "unread": True}).json["unread"] == before + 1
    assert tech.post(f"{API}/notifications/read", {"all": True}).json["unread"] == 0
    assert tech.post(f"{API}/notifications/read", {}).status_code == 422
    # instant email by default for assignments, with the HTML version
    mail = [m for m in emails_to(app, "avery.kim@example.com") if "Grease bearings" in m["subject"]]
    assert mail and "http://mpro.test/work-orders/" in mail[0]["body"] and "<table" in mail[0]["html"]


def test_team_assignment_and_groups_preference(app: Any, admin: Api) -> None:
    mech = team_id(admin, "Mechanical")
    tech = login(app, "avery.kim@example.com")
    morgan = login(app, "morgan.diaz@example.com")
    r = morgan.patch(f"{API}/notifications/settings", {"groups": {"my_teams": False}})
    assert r.status_code == 200 and r.json["prefs"]["groups"]["my_teams"] is False
    wo = create(admin, title="Team job", assignees=[{"type": "team", "id": mech}])
    flush(app)
    assert [i for i in inbox(tech) if i["entity_id"] == wo["id"] and i["kind"] == "wo.assigned"]
    assert not [i for i in inbox(morgan) if i["entity_id"] == wo["id"]]
    # status changes reach watchers too
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"}).status_code == 200
    flush(app)
    assert [i for i in inbox(tech) if i["entity_id"] == wo["id"] and i["kind"] == "wo.status_changed"]


def test_comments_mentions_and_mentions_only_setting(app: Any, admin: Api) -> None:
    avery, sam = uid(admin, "avery.kim@example.com"), uid(admin, "sam.patel@example.com")
    tech, sam_api = login(app, "avery.kim@example.com"), login(app, "sam.patel@example.com")
    wo = create(admin, title="Panel check", assignees=[{"type": "user", "id": avery}])
    url = f"{API}/work-orders/{wo['id']}/comments"
    assert admin.post(url, {"body": "Parts are on the shelf"}).status_code == 201
    assert admin.post(url, {"body": f"@[Sam Patel](user:{sam}) can you look?"}).status_code == 201
    flush(app)
    kinds = [i["kind"] for i in inbox(tech) if i["entity_id"] == wo["id"]]
    assert kinds.count("wo.commented") == 2
    sam_items = [i for i in inbox(sam_api) if i["entity_id"] == wo["id"]]
    assert [i["kind"] for i in sam_items] == ["wo.mentioned"] and "can you look" in sam_items[0]["body"]
    tech.patch(f"{API}/notifications/settings", {"comments": "mentions"})
    admin.post(url, {"body": "Another note"})
    admin.post(url, {"body": f"@[Avery Kim](user:{avery}) please confirm"})
    flush(app)
    kinds = [i["kind"] for i in inbox(tech) if i["entity_id"] == wo["id"]]
    assert kinds.count("wo.commented") == 2 and kinds.count("wo.mentioned") == 1


def test_people_who_cant_see_the_work_order_get_nothing(app: Any, admin: Api) -> None:
    sam = uid(admin, "sam.patel@example.com")
    elec = team_id(admin, "Electrical")
    assert admin.patch(f"{API}/users/{sam}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    assert admin.patch(f"{API}/notifications/org-settings", {"overdue_team_ids": [elec]}).status_code == 200
    due = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    wo = create(admin, title="Not for Sam", due_at=due)
    with app.app_context():
        from mpro.notifications.services import scan_due

        assert scan_due()["overdue"] >= 1
    flush(app)
    taylor = login(app, "taylor.brooks@example.com")  # Electrical, sees everything
    assert [i for i in inbox(taylor) if i["entity_id"] == wo["id"] and i["kind"] == "wo.overdue"]
    assert not [i for i in inbox(login(app, "sam.patel@example.com")) if i["entity_id"] == wo["id"]]


# ---- preferences, quiet hours, pause, digests ------------------------------------------------------
def test_settings_validation_and_catalogue(app: Any, admin: Api) -> None:
    s = admin.get(f"{API}/notifications/settings").json
    assert {c["key"] for c in s["catalogue"]} >= {"wo.assigned", "wo.overdue", "po.needs_approval", "message.direct"}
    assert s["push"]["public_key"] and s["prefs"]["email_frequency"] == "instant"
    bad = [
        {"email_frequency": "weekly"},
        {"messages": "some"},
        {"digest_hour": 30},
        {"quiet": {"start": "25:00"}},
        {"comments": "few"},
    ]
    for b in bad:
        assert admin.patch(f"{API}/notifications/settings", b).status_code == 422, b
    r = admin.patch(
        f"{API}/notifications/settings", {"channels": {"wo.assigned": {"push": False}, "nope": {"email": True}}}
    )
    assert r.json["prefs"]["channels"]["wo.assigned"] == {"in_app": True, "email": True, "push": False}
    p = admin.post(f"{API}/notifications/pause", {"minutes": 60}).json
    assert p["paused_until"]
    assert admin.post(f"{API}/notifications/pause", {"minutes": 0}).json["paused_until"] is None
    assert admin.post(f"{API}/notifications/pause", {"minutes": 99999}).status_code == 422


def _quiet_now(app: Any) -> dict[str, Any]:
    with app.app_context():
        from mpro.extensions import db
        from mpro.orgs.models import Organization

        tz = ZoneInfo(db.session.query(Organization).first().timezone or "UTC")  # type: ignore[union-attr]
    local = datetime.now(UTC).astimezone(tz)
    start, end = local - timedelta(hours=1), local + timedelta(hours=1)
    return {"enabled": True, "start": start.strftime("%H:%M"), "end": end.strftime("%H:%M")}


def test_quiet_hours_hold_email_and_skip_push(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    assert tech.patch(f"{API}/notifications/settings", {"quiet": _quiet_now(app)}).status_code == 200
    wo = create(admin, title="Quiet job", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert [i for i in inbox(tech) if i["entity_id"] == wo["id"]]  # still in the inbox
    assert not [m for m in emails_to(app, "avery.kim@example.com") if "Quiet job" in m["subject"]]
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.models import Notification
        from mpro.notifications.services import deliver_pending

        n = db.session.query(Notification).filter_by(entity_id=wo["id"], user_id=uuid.UUID(avery)).one()
        assert n.email_state == "pending"
        assert deliver_pending() == 0  # still quiet
        assert deliver_pending(datetime.now(UTC) + timedelta(hours=2)) == 1  # after quiet hours
    assert [m for m in emails_to(app, "avery.kim@example.com") if "Quiet job" in m["subject"]]


def test_quiet_hours_logic() -> None:
    from mpro.notifications.services import in_quiet_hours

    tz = ZoneInfo("UTC")
    night = {"quiet": {"enabled": True, "start": "22:00", "end": "07:00", "weekends": False}}
    assert in_quiet_hours(night, tz, datetime(2026, 10, 27, 23, 30, tzinfo=UTC))
    assert in_quiet_hours(night, tz, datetime(2026, 10, 27, 6, 59, tzinfo=UTC))
    assert not in_quiet_hours(night, tz, datetime(2026, 10, 27, 7, 0, tzinfo=UTC))
    assert not in_quiet_hours(
        {"quiet": {**night["quiet"], "enabled": False}}, tz, datetime(2026, 10, 27, 23, 0, tzinfo=UTC)
    )
    weekend = {"quiet": {"enabled": False, "weekends": True}}
    assert in_quiet_hours(weekend, tz, datetime(2026, 10, 31, 12, 0, tzinfo=UTC))  # Saturday
    assert not in_quiet_hours(weekend, tz, datetime(2026, 10, 30, 12, 0, tzinfo=UTC))


def test_hourly_digest_batches_emails(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    tech.patch(f"{API}/notifications/settings", {"email_frequency": "hourly"})
    for t in ("Digest one", "Digest two"):
        create(admin, title=t, assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert not [m for m in emails_to(app, "avery.kim@example.com") if "Digest" in m["subject"]]
    now = datetime.now(UTC)
    with app.app_context():
        from mpro.notifications.services import deliver_pending

        assert deliver_pending(now) == 1
    digest = [m for m in emails_to(app, "avery.kim@example.com") if "updates in" in m["subject"]]
    assert len(digest) == 1 and "Digest one" in digest[0]["body"] and "Digest two" in digest[0]["body"]
    create(admin, title="Digest three", assignees=[{"type": "user", "id": avery}])
    flush(app)
    with app.app_context():
        from mpro.notifications.services import deliver_pending

        assert deliver_pending(now + timedelta(minutes=30)) == 0
        assert deliver_pending(now + timedelta(minutes=61)) == 1


def test_daily_digest_waits_for_the_hour(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    tech.patch(f"{API}/notifications/settings", {"email_frequency": "daily", "digest_hour": 7})
    create(admin, title="Daily one", assignees=[{"type": "user", "id": avery}])
    flush(app)
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.services import deliver_pending
        from mpro.orgs.models import Organization

        tz = ZoneInfo(db.session.query(Organization).first().timezone or "UTC")  # type: ignore[union-attr]
        day = datetime.now(UTC).astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        assert deliver_pending(day.replace(hour=6).astimezone(UTC)) == 0
        assert deliver_pending(day.replace(hour=7, minute=5).astimezone(UTC)) == 1
        assert deliver_pending(day.replace(hour=9).astimezone(UTC)) == 0


def test_channels_off_means_no_notification(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    tech.patch(
        f"{API}/notifications/settings", {"channels": {"wo.assigned": {"in_app": False, "email": False, "push": False}}}
    )
    wo = create(admin, title="Silent", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert not [i for i in inbox(tech) if i["entity_id"] == wo["id"]]


# ---- escalations and due dates ---------------------------------------------------------------------
def test_escalation_rule_fires_once_and_raises_priority(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    jordan = uid(admin, "jordan.reyes@example.com")
    r = admin.post(
        f"{API}/escalation-rules",
        {
            "name": "High overdue 2h",
            "priorities": ["high"],
            "after_hours": 2,
            "notify_user_ids": [jordan],
            "raise_priority": True,
        },
    )
    assert r.status_code == 201, r.json
    low = admin.post(
        f"{API}/escalation-rules",
        {"name": "Low", "priorities": ["low"], "after_hours": 1, "notify_admins": True},
    ).json
    due = (datetime.now(UTC) - timedelta(hours=3)).isoformat()
    hot = create(admin, title="Hot", priority="high", due_at=due, assignees=[{"type": "user", "id": avery}])
    recent = create(admin, title="Recent", priority="high", due_at=(datetime.now(UTC) - timedelta(hours=1)).isoformat())
    with app.app_context():
        from mpro.notifications.services import scan_due

        c = scan_due()
        assert c["escalated"] == 1 and c["overdue"] >= 2
        assert scan_due() == {"due_soon": 0, "overdue": 0, "escalated": 0}  # each fires once
    flush(app)
    jordan_api = login(app, "jordan.reyes@example.com")
    esc = [i for i in inbox(jordan_api) if i["kind"] == "wo.escalated"]
    assert [i["entity_id"] for i in esc] == [hot["id"]] and "rule: High overdue 2h" in esc[0]["body"]
    assert not [i for i in inbox(jordan_api) if i["kind"] == "wo.escalated" and i["entity_id"] == recent["id"]]
    tech = login(app, "avery.kim@example.com")
    assert [i for i in inbox(tech) if i["entity_id"] == hot["id"] and i["kind"] == "wo.overdue"]
    assert admin.get(f"{API}/work-orders/{hot['id']}").json["priority"] == "high"
    assert admin.delete(f"{API}/escalation-rules/{low['id']}").status_code == 204
    assert len(admin.get(f"{API}/escalation-rules").json["items"]) == 1


def test_not_started_escalation_and_due_soon(app: Any, admin: Api) -> None:
    admin.post(
        f"{API}/escalation-rules",
        {"name": "Not started", "trigger": "not_started", "after_hours": 4, "notify_admins": True},
    )
    wo = create(admin, title="Waiting", due_at=(datetime.now(UTC) + timedelta(hours=3)).isoformat())
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.services import scan_due
        from mpro.workorders.models import WorkOrder

        assert scan_due()["due_soon"] == 1
        w = db.session.get(WorkOrder, uuid.UUID(wo["id"]))
        assert w is not None
        w.created_at = datetime.now(UTC) - timedelta(hours=5)
        db.session.commit()
        assert scan_due()["escalated"] == 1
    flush(app)
    jordan_api = login(app, "jordan.reyes@example.com")  # limited admin, not an "admin": no escalation
    assert not [i for i in inbox(jordan_api) if i["kind"] == "wo.escalated"]


def test_escalation_rule_validation(admin: Api) -> None:
    base = {"name": "X", "notify_admins": True}
    assert admin.post(f"{API}/escalation-rules", {"notify_admins": True}).status_code == 422
    assert admin.post(f"{API}/escalation-rules", {"name": "No one"}).status_code == 422
    assert admin.post(f"{API}/escalation-rules", {**base, "trigger": "sometime"}).status_code == 422
    assert admin.post(f"{API}/escalation-rules", {**base, "priorities": ["urgent"]}).status_code == 422
    assert admin.post(f"{API}/escalation-rules", {**base, "notify_team_ids": [str(uuid.uuid4())]}).status_code == 422


def test_technicians_cant_manage_rules(app: Any) -> None:
    tech = login(app, "avery.kim@example.com")
    assert tech.get(f"{API}/escalation-rules").status_code == 403
    assert tech.post(f"{API}/escalation-rules", {"name": "X", "notify_admins": True}).status_code == 403
    assert tech.patch(f"{API}/notifications/org-settings", {"weekly_report": True}).status_code == 403


# ---- purchase orders (r287) ------------------------------------------------------------------------
def test_po_request_and_decision_notifications(app: Any, admin: Api) -> None:
    tech = login(app, "avery.kim@example.com")
    r = tech.post(f"{API}/purchase-orders", {"title": "Gloves", "lines": [{"description": "Gloves", "quantity": "2"}]})
    assert r.status_code == 201, r.json
    po = r.json
    flush(app)
    mine = [i for i in inbox(admin) if i["entity_id"] == po["id"]]
    assert mine and mine[0]["kind"] == "po.needs_approval" and mine[0]["link"] == f"/purchase-orders/{po['id']}"
    assert admin.post(f"{API}/purchase-orders/{po['id']}/approve", {}).status_code == 200
    flush(app)
    decided = [i for i in inbox(tech) if i["entity_id"] == po["id"] and i["kind"] == "po.decided"]
    assert decided and "approved" in decided[0]["title"]
    assert [m for m in emails_to(app, "avery.kim@example.com") if "approved" in m["subject"]]


# ---- web push --------------------------------------------------------------------------------------
def _browser_keys() -> tuple[Any, str, str]:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from mpro.notifications.webpush import b64u

    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, b64u(pub), b64u(b"0123456789abcdef")


def test_push_subscribe_send_decrypt_and_cleanup(app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpro.notifications import services as svc
    from mpro.notifications.webpush import decrypt, unb64u

    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    key, p256dh, auth = _browser_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/abc123"
    # only real push services
    for bad in ("http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://evil.example.com/push"):
        r = tech.post(
            f"{API}/notifications/push/subscriptions", {"endpoint": bad, "keys": {"p256dh": p256dh, "auth": auth}}
        )
        assert r.status_code == 422, bad
    r = tech.post(
        f"{API}/notifications/push/subscriptions",
        {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": "short"}},
    )
    assert r.status_code == 422
    r = tech.post(
        f"{API}/notifications/push/subscriptions", {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
    )
    assert r.status_code == 201
    sent: list[Any] = []
    status = {"code": 201}

    def fake_post(req: Any) -> int:
        sent.append(req)
        return status["code"]

    monkeypatch.setattr(svc, "_post", fake_post)
    create(admin, title="Push me", priority="high", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert len(sent) == 1
    req = sent[0]
    assert req.url == endpoint and req.headers["Content-Encoding"] == "aes128gcm"
    assert req.headers["Authorization"].startswith("vapid t=")
    msg = json.loads(decrypt(req.body, key, auth))
    assert "Push me" in msg["title"] and msg["url"].startswith("/work-orders/")
    # the VAPID token is signed by the server's key and aimed at the push service
    _verify_vapid(req.headers["Authorization"], tech.get(f"{API}/notifications/push/key").json["public_key"])
    assert len(unb64u(tech.get(f"{API}/notifications/push/key").json["public_key"])) == 65
    # test button
    assert tech.post(f"{API}/notifications/push/test", {}).json["sent"] == 1
    # the browser unsubscribed: the device is forgotten
    status["code"] = 410
    create(admin, title="Gone", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert tech.get(f"{API}/notifications/settings").json["push"]["devices"] == []
    assert tech.post(f"{API}/notifications/push/test", {}).status_code == 409


def _verify_vapid(header: str, public_b64: str) -> None:
    import base64

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    from mpro.notifications.webpush import unb64u

    token = header.split("t=", 1)[1].split(",", 1)[0]
    h, c, s = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(c + "=" * (-len(c) % 4)))
    assert claims["aud"] == "https://fcm.googleapis.com" and claims["exp"] > datetime.now(UTC).timestamp()
    sig = unb64u(s)
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64u(public_b64))
    der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    pub.verify(der, f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))


def test_quiet_hours_skip_push(app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpro.notifications import services as svc

    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    _, p256dh, auth = _browser_keys()
    tech.post(
        f"{API}/notifications/push/subscriptions",
        {
            "endpoint": "https://updates.push.services.mozilla.com/wpush/v2/xyz",
            "keys": {"p256dh": p256dh, "auth": auth},
        },
    )
    sent: list[Any] = []
    monkeypatch.setattr(svc, "_post", lambda req: sent.append(req) or 201)
    tech.post(f"{API}/notifications/pause", {"minutes": 30})
    create(admin, title="Paused", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert sent == []
    tech.post(f"{API}/notifications/pause", {"minutes": 0})
    create(admin, title="Resumed", assignees=[{"type": "user", "id": avery}])
    flush(app)
    assert len(sent) == 1


def test_push_subscription_moves_to_the_new_signed_in_person(app: Any, admin: Api) -> None:
    _, p256dh, auth = _browser_keys()
    body = {"endpoint": "https://web.push.apple.com/QGx", "keys": {"p256dh": p256dh, "auth": auth}}
    tech = login(app, "avery.kim@example.com")
    assert tech.post(f"{API}/notifications/push/subscriptions", body).status_code == 201
    assert admin.post(f"{API}/notifications/push/subscriptions", body).status_code == 201
    assert tech.get(f"{API}/notifications/settings").json["push"]["devices"] == []
    assert len(admin.get(f"{API}/notifications/settings").json["push"]["devices"]) == 1
    # someone else can't remove your device by id
    dev = admin.get(f"{API}/notifications/settings").json["push"]["devices"][0]["id"]
    r = tech.c.delete(f"{API}/notifications/push/subscriptions", json={"id": dev}, headers={"X-CSRF-Token": tech.csrf})
    assert r.json["removed"] == 0
    r = admin.c.delete(
        f"{API}/notifications/push/subscriptions", json={"id": dev}, headers={"X-CSRF-Token": admin.csrf}
    )
    assert r.json["removed"] == 1


# ---- email branding and weekly report --------------------------------------------------------------
def test_email_branding_and_escaping(app: Any, admin: Api) -> None:
    import io

    from tests.test_work_orders import PNG_1PX

    r = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(PNG_1PX), "logo.png")},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.json
    logo = r.json["id"]
    assert admin.patch(f"{API}/notifications/org-settings", {"brand_color": "red"}).status_code == 422
    assert (
        admin.patch(f"{API}/notifications/org-settings", {"brand_logo_file_id": str(uuid.uuid4())}).status_code == 422
    )
    s = admin.patch(
        f"{API}/notifications/org-settings",
        {"brand_color": "#aa3300", "brand_logo_file_id": logo, "brand_info": "1 Industrial Pkwy"},
    ).json
    assert s["brand_color"] == "#aa3300"
    with app.app_context():
        from mpro.extensions import db
        from mpro.orgs.models import Organization

        org_id = db.session.query(Organization).first().id  # type: ignore[union-attr]
    # the logo is public (emails load it), but only the chosen file
    assert app.test_client().get(f"{API}/notifications/brand-logo/{org_id}").status_code == 200
    assert app.test_client().get(f"{API}/notifications/brand-logo/{uuid.uuid4()}").status_code == 404
    avery = uid(admin, "avery.kim@example.com")
    create(admin, title="<script>alert(1)</script>", assignees=[{"type": "user", "id": avery}])
    flush(app)
    m = [m for m in emails_to(app, "avery.kim@example.com") if "alert(1)" in m["subject"]][0]
    assert "#aa3300" in m["html"] and "<script>" not in m["html"] and "&lt;script&gt;" in m["html"]
    assert "1 Industrial Pkwy" in m["html"] and f"brand-logo/{org_id}" in m["html"]


def test_weekly_report_monday_once(app: Any, admin: Api) -> None:
    assert admin.patch(f"{API}/notifications/org-settings", {"weekly_report": True}).status_code == 200
    with app.app_context():
        from mpro.extensions import db
        from mpro.notifications.services import send_weekly_reports
        from mpro.orgs.models import Organization

        tz = ZoneInfo(db.session.query(Organization).first().timezone or "UTC")  # type: ignore[union-attr]
        monday = datetime(2026, 11, 2, 7, 30, tzinfo=tz).astimezone(UTC)
        assert send_weekly_reports(monday - timedelta(hours=1)) == 0  # 06:30
        assert send_weekly_reports(datetime(2026, 11, 3, 9, 0, tzinfo=tz).astimezone(UTC)) == 0  # Tuesday
        assert send_weekly_reports(monday) >= 1
        assert send_weekly_reports(monday + timedelta(hours=2)) == 0  # once a week
    mail = [m for m in emails_to(app, "admin@example.com") if "Weekly work order report" in m["subject"]]
    assert mail and "created" in mail[0]["body"]
    assert admin.get(f"{API}/notifications/weekly-report").json.keys() >= {"created", "completed", "overdue"}


# ---- cross-organization (G-15) ---------------------------------------------------------------------
def test_other_org_cannot_touch_notifications(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Ours", assignees=[{"type": "user", "id": avery}])
    flush(app)
    tech = login(app, "avery.kim@example.com")
    nid = next(i["id"] for i in inbox(tech) if i["entity_id"] == wo["id"])
    rule = admin.post(f"{API}/escalation-rules", {"name": "R", "notify_admins": True}).json
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
    other = login(app, "other@example.com", "other-pass-123")
    assert inbox(other) == []
    assert other.post(f"{API}/notifications/read", {"ids": [nid]}).json["updated"] == 0
    assert tech.get(f"{API}/notifications/unread-count").json["unread"] >= 1
    assert other.patch(f"{API}/escalation-rules/{rule['id']}", {"name": "x"}).status_code == 404
    assert other.delete(f"{API}/escalation-rules/{rule['id']}").status_code == 404
    assert other.get(f"{API}/escalation-rules").json["items"] == []
    mech = team_id(admin, "Mechanical")
    r = other.post(f"{API}/escalation-rules", {"name": "Steal", "notify_team_ids": [mech]})
    assert r.status_code == 422
    r = other.post(f"{API}/escalation-rules", {"name": "Steal", "notify_user_ids": [avery]})
    assert r.status_code == 422
    assert other.patch(f"{API}/notifications/org-settings", {"overdue_team_ids": [mech]}).status_code == 422


def test_external_comment_notifies_watchers(app: Any, admin: Api) -> None:
    """Comments from a shared work-order link (no actor) still reach the people on the work order."""
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Shared", assignees=[{"type": "user", "id": avery}])
    s = admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {"fields": {"comments": "interact"}}).json
    c = app.test_client()
    c.environ_base["REMOTE_ADDR"] = "10.9.9.9"
    assert c.post(f"{API}/external/{s['token']}/comments", json={"name": "Jo", "body": "On my way"}).status_code == 201
    flush(app)
    tech = login(app, "avery.kim@example.com")
    got = [i for i in inbox(tech) if i["entity_id"] == wo["id"] and i["kind"] == "wo.commented"]
    assert got and "On my way" in got[0]["body"]
    assert [i for i in inbox(admin) if i["entity_id"] == wo["id"] and i["kind"] == "wo.commented"]


# ---- events from the other 0.6.0 modules -----------------------------------------------------------
def test_request_new_and_update_notifications(app: Any, admin: Api) -> None:
    jamie = login(app, "jamie.ortiz@example.com")  # requester
    r = jamie.post(f"{API}/requests", {"title": "Leaking sink in the break room"})
    assert r.status_code == 201, r.json
    rid = r.json["id"]
    flush(app)
    assert [i for i in inbox(admin) if i["entity_id"] == rid and i["kind"] == "request.new"]
    assert not [i for i in inbox(login(app, "avery.kim@example.com")) if i["entity_id"] == rid]  # can't approve
    assert admin.post(f"{API}/requests/{rid}/decline", {"reason": "Facilities handles sinks"}).status_code == 200
    flush(app)
    got = [i for i in inbox(jamie) if i["entity_id"] == rid and i["kind"] == "request.update"]
    assert got and "declined" in got[0]["title"] and "Facilities handles sinks" in got[0]["body"]


def test_direct_message_push_only_by_default(app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpro.notifications import services as svc

    avery = uid(admin, "avery.kim@example.com")
    tech = login(app, "avery.kim@example.com")
    _, p256dh, auth = _browser_keys()
    tech.post(
        f"{API}/notifications/push/subscriptions",
        {"endpoint": "https://fcm.googleapis.com/fcm/send/dm", "keys": {"p256dh": p256dh, "auth": auth}},
    )
    sent: list[Any] = []
    monkeypatch.setattr(svc, "_post", lambda req: sent.append(req) or 201)
    conv = admin.post(f"{API}/conversations", {"kind": "direct", "user_id": avery})
    assert conv.status_code == 201, conv.json
    assert admin.post(f"{API}/conversations/{conv.json['id']}/messages", {"body": "Got a minute?"}).status_code == 201
    flush(app)
    assert len(sent) == 1  # pushed, but not in the bell (Messages has its own unread count)
    assert not [i for i in inbox(tech) if i["entity_type"] == "conversation"]
    tech.patch(f"{API}/notifications/settings", {"messages": "none"})
    admin.post(f"{API}/conversations/{conv.json['id']}/messages", {"body": "Hello?"})
    flush(app)
    assert len(sent) == 1


def test_parts_short_and_vendor_reply_events(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Short", assignees=[{"type": "user", "id": avery}])
    tech = login(app, "avery.kim@example.com")
    po = tech.post(
        f"{API}/purchase-orders", {"title": "Belts", "lines": [{"description": "Belt", "quantity": "1"}]}
    ).json
    with app.app_context():
        from mpro.core.events import emit
        from mpro.extensions import db
        from mpro.orgs.models import Organization

        org_id = db.session.query(Organization).first().id  # type: ignore[union-attr]
        emit("wo.parts_short", entity_type="work_order", entity_id=wo["id"], entity_label="x",
             data={"lines": ["V-belt: used 1 of 2 each (1 short)"]}, org_id=org_id)  # fmt: skip
        emit("purchase_order.vendor_declined", entity_type="purchase_order", entity_id=po["id"], entity_label="PO-9",
             data={"responder_name": "Luis", "note": "Out of stock"}, org_id=org_id)  # fmt: skip
        db.session.commit()
    flush(app)
    items = inbox(tech)
    short = [i for i in items if i["kind"] == "wo.parts_short"]
    assert short and "1 short" in short[0]["body"]
    vend = [i for i in items if i["kind"] == "po.vendor"]
    assert vend and vend[0]["title"] == "Luis declined PO-9" and vend[0]["body"] == "Out of stock"


def test_opening_a_record_marks_its_notifications_read(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Open me", assignees=[{"type": "user", "id": avery}])
    admin.post(f"{API}/work-orders/{wo['id']}/comments", {"body": "Note"})
    flush(app)
    tech = login(app, "avery.kim@example.com")
    assert len([i for i in inbox(tech, unread=1) if i["entity_id"] == wo["id"]]) == 2
    r = tech.post(f"{API}/notifications/read-entity", {"entity_type": "work_order", "entity_id": wo["id"]})
    assert r.json["updated"] == 2
    assert not [i for i in inbox(tech, unread=1) if i["entity_id"] == wo["id"]]
    assert tech.post(f"{API}/notifications/read-entity", {}).status_code == 422
