# ruff: noqa: E501
"""Offline sync for the phone app (0.6.0: MP-053, r270, r291), timers (r090) and deleting my account (r321)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from tests.conftest import Api
from tests.test_assets import other_org
from tests.test_work_orders import create, login, team_id, uid

API = "/api/v1"


def feed(api: Api, cursor: str | None = None, **kw: Any) -> dict[str, Any]:
    q = f"?cursor={cursor}" if cursor else ""
    r = api.get(f"{API}/sync{q}")
    assert r.status_code == 200, r.json
    return r.json  # type: ignore[no-any-return]


def items(api: Api, ids: list[str]) -> Any:
    return api.get(f"{API}/sync/items?ids={','.join(ids)}")


def idem_post(api: Api, url: str, body: Any, key: str) -> Any:
    return api.c.post(url, json=body, headers={**api._h(), "Idempotency-Key": key})


# ---------------------------------------------------------------- the change feed
def test_feed_holds_what_is_assigned_to_me_or_my_teams_soonest_due_first(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mech = team_id(admin, "Mechanical")
    soon = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    later = (datetime.now(UTC) + timedelta(days=5)).isoformat()
    a = create(admin, title="Later", assignees=[{"type": "user", "id": avery}], due_at=later)
    b = create(admin, title="Sooner, via my team", assignees=[{"type": "team", "id": mech}], due_at=soon)
    c = create(admin, title="Not mine")
    done = create(admin, title="Done long ago", assignees=[{"type": "user", "id": avery}])
    tech = login(app, "avery.kim@example.com")
    f = feed(tech)
    assert f["full"] is True and f["cursor"]
    ids = f["cache_ids"]
    assert a["id"] in ids and b["id"] in ids and c["id"] not in ids
    assert ids.index(b["id"]) < ids.index(a["id"])  # soonest due first
    assert set(f["changed_ids"]) == set(ids)
    # finished work stays a few days, then leaves the phone
    assert admin.post(f"{API}/work-orders/{done['id']}/status", {"status": "done"}).status_code == 200
    assert done["id"] in feed(tech)["cache_ids"]
    with app.app_context():
        from mpro.extensions import db
        from mpro.workorders.models import WorkOrder

        db.session.get(WorkOrder, uuid.UUID(done["id"])).completed_at = datetime.now(UTC) - timedelta(days=10)
        db.session.commit()
    assert done["id"] not in feed(tech)["cache_ids"]


def test_cursor_returns_only_what_changed(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    a = create(admin, title="A", assignees=[{"type": "user", "id": avery}])
    b = create(admin, title="B", assignees=[{"type": "user", "id": avery}])
    tech = login(app, "avery.kim@example.com")
    first = feed(tech)
    # pretend the cursor is from a while ago, after both were created
    with app.app_context():
        from mpro.extensions import db
        from mpro.workorders.models import WorkOrder

        for wid in (a["id"], b["id"]):
            db.session.get(WorkOrder, uuid.UUID(wid)).updated_at = datetime.now(UTC) - timedelta(hours=1)
        from sqlalchemy import update

        from mpro.core.events import DomainEvent

        db.session.execute(update(DomainEvent).values(created_at=datetime.now(UTC) - timedelta(hours=1)))
        db.session.commit()
        from mpro.auth.models import User
        from mpro.orgs.models import Membership
        from mpro.sync.services import make_cursor

        u = db.session.query(User).filter_by(email="avery.kim@example.com").one()
        m = db.session.query(Membership).filter_by(user_id=u.id).one()
        old = make_cursor(datetime.now(UTC) - timedelta(minutes=30), m.org_id, u.id)
    assert first["full"] is True
    quiet = feed(tech, old)
    assert quiet["full"] is False and quiet["changed_ids"] == []
    assert tech.post(f"{API}/work-orders/{b['id']}/comments", {"body": "On my way"}).status_code == 201
    later = feed(tech, old)
    assert later["changed_ids"] == [b["id"]]
    assert set(later["cache_ids"]) >= {a["id"], b["id"]}


def test_broken_foreign_or_old_cursor_means_full_sync(app: Any, admin: Api) -> None:
    f = feed(admin)
    assert feed(admin, "not-a-cursor")["full"] is True
    tech = login(app, "avery.kim@example.com")
    assert feed(tech, f["cursor"])["full"] is True  # someone else's cursor
    with app.app_context():
        from mpro.sync.services import make_cursor

        old = make_cursor(datetime.now(UTC) - timedelta(days=60), uuid.uuid4(), uuid.uuid4())
    assert feed(admin, old)["full"] is True


def test_items_give_the_screens_data_and_skip_what_i_cannot_see(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mine = create(admin, title="Mine", assignees=[{"type": "user", "id": avery}])
    assert admin.post(f"{API}/work-orders/{mine['id']}/comments", {"body": "Parts are in bay 3"}).status_code == 201
    tech = login(app, "avery.kim@example.com")
    r = items(tech, [mine["id"], str(uuid.uuid4()), "junk"])
    assert r.status_code == 200
    it = r.json["items"][0]
    assert it["id"] == mine["id"] and it["detail"]["title"] == "Mine" and it["version"] == it["detail"]["version"]
    assert any(x.get("body") == "Parts are in bay 3" for x in it["activity"]["items"])
    assert "parts" in it
    assert len(r.json["missing"]) == 2
    assert items(tech, [str(uuid.uuid4())] * 26).status_code == 422


def test_limited_visibility_and_other_orgs_stay_out(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Org A work", assignees=[{"type": "user", "id": avery}])
    other = other_org(app)
    f = feed(other)
    assert f["cache_ids"] == [] and f["changed_ids"] == []
    r = items(other, [wo["id"]])
    assert r.status_code == 200 and r.json["items"] == [] and r.json["missing"] == [wo["id"]]
    assert other.get(f"{API}/me/recent-activity").json["items"] == []
    # a requester has no work orders on the phone
    req = login(app, "jamie.ortiz@example.com")
    assert req.get(f"{API}/sync").status_code in (200, 403)
    if req.get(f"{API}/sync").status_code == 200:
        assert wo["id"] not in feed(req)["cache_ids"]


def test_recent_activity_lists_visible_work(app: Any, admin: Api) -> None:
    wo = create(admin, title="Pump seal leak")
    assert admin.post(f"{API}/work-orders/{wo['id']}/comments", {"body": "Seal ordered"}).status_code == 201
    r = admin.get(f"{API}/me/recent-activity").json["items"]
    assert r and r[0]["work_order"]["id"] == wo["id"]


# ---------------------------------------------------------------- Idempotency-Key
def test_same_key_runs_once_and_replays_the_reply(admin: Api) -> None:
    wo = create(admin)
    url = f"{API}/work-orders/{wo['id']}/comments"
    first = idem_post(admin, url, {"body": "Checked the belt"}, "phone-1234-abcd")
    again = idem_post(admin, url, {"body": "Checked the belt"}, "phone-1234-abcd")
    assert first.status_code == 201 and again.status_code == 201
    assert again.headers.get("Idempotent-Replay") == "true" and again.json["id"] == first.json["id"]
    bodies = [
        x.get("body")
        for x in admin.get(f"{API}/work-orders/{wo['id']}/activity").json["items"]
        if x["kind"] == "comment"
    ]
    assert bodies.count("Checked the belt") == 1
    # a different change can't reuse the key
    assert idem_post(admin, f"{API}/work-orders/{wo['id']}/time", {"minutes": 5}, "phone-1234-abcd").status_code == 422
    assert idem_post(admin, url, {"body": "x"}, "bad key!").status_code == 422


def test_keys_are_per_person_and_failures_run_again(app: Any, admin: Api) -> None:
    wo = create(admin)
    url = f"{API}/work-orders/{wo['id']}/comments"
    assert idem_post(admin, url, {"body": "Admin note"}, "shared-key-0001").status_code == 201
    other = other_org(app)
    # another person's key space; and they can't reach the work order anyway
    r = idem_post(other, url, {"body": "Other"}, "shared-key-0001")
    assert r.status_code == 404 and r.headers.get("Idempotent-Replay") is None
    # a rejected change (422) is stored, so a repeat gets the same answer without running
    bad = idem_post(admin, url, {"body": ""}, "empty-comment-1")
    assert bad.status_code == 422
    assert idem_post(admin, url, {"body": ""}, "empty-comment-1").headers.get("Idempotent-Replay") == "true"


def test_stale_in_progress_key_is_released(app: Any, admin: Api) -> None:
    wo = create(admin)
    url = f"{API}/work-orders/{wo['id']}/comments"
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.sync.models import IdempotentRequest

        u = db.session.query(User).filter_by(email="admin@example.com").one()
        db.session.add(IdempotentRequest(user_id=u.id, key="crashed-0001", method="POST", path=url, status_code=0))
        db.session.commit()
    assert idem_post(admin, url, {"body": "x"}, "crashed-0001").status_code == 409  # still running
    with app.app_context():
        from mpro.extensions import db
        from mpro.sync.models import IdempotentRequest

        row = db.session.query(IdempotentRequest).filter_by(key="crashed-0001").one()
        row.created_at = datetime.now(UTC) - timedelta(minutes=10)
        db.session.commit()
    assert idem_post(admin, url, {"body": "x"}, "crashed-0001").status_code == 201


# ---------------------------------------------------------------- version conflicts on replay
def test_offline_status_change_on_an_old_version_conflicts(admin: Api) -> None:
    wo = create(admin)
    v = wo["version"]
    assert (
        admin.patch(f"{API}/work-orders/{wo['id']}", {"title": "Renamed in the office", "version": v}).status_code
        == 200
    )
    r = idem_post(admin, f"{API}/work-orders/{wo['id']}/status", {"status": "done", "version": v}, "offline-done-01")
    assert r.status_code == 409 and r.json["detail"]["current"]["title"] == "Renamed in the office"
    # the conflict is remembered for that key; a fresh change on the new version goes through
    assert (
        idem_post(
            admin, f"{API}/work-orders/{wo['id']}/status", {"status": "done", "version": v}, "offline-done-01"
        ).status_code
        == 409
    )
    cur = admin.get(f"{API}/work-orders/{wo['id']}").json["version"]
    assert (
        idem_post(
            admin, f"{API}/work-orders/{wo['id']}/status", {"status": "done", "version": cur}, "offline-done-02"
        ).status_code
        == 200
    )


# ---------------------------------------------------------------- timers (r090)
def test_timers_pause_resume_and_count_only_running_time(app: Any, admin: Api) -> None:
    a = create(admin, title="Timer A")
    b = create(admin, title="Timer B")
    now = datetime.now(UTC)
    assert (
        admin.post(f"{API}/work-orders/{a['id']}/timer", {"at": (now - timedelta(minutes=30)).isoformat()}).status_code
        == 200
    )
    assert admin.post(f"{API}/work-orders/{b['id']}/timer", {}).status_code == 200  # several at once
    assert len(admin.get(f"{API}/me/timers").json["items"]) == 2
    assert (
        admin.post(
            f"{API}/work-orders/{a['id']}/timer/pause", {"at": (now - timedelta(minutes=20)).isoformat()}
        ).status_code
        == 200
    )
    t = next(x for x in admin.get(f"{API}/me/timers").json["items"] if x["work_order_id"] == a["id"])
    assert t["paused"] is True and 590 <= t["elapsed_seconds"] <= 610
    assert (
        admin.post(
            f"{API}/work-orders/{a['id']}/timer/resume", {"at": (now - timedelta(minutes=5)).isoformat()}
        ).status_code
        == 200
    )
    r = admin.delete(f"{API}/work-orders/{a['id']}/timer?at={(now).isoformat().replace('+', '%2B')}")
    assert r.status_code == 200
    entries = r.json["costs"]["time"]
    assert entries and entries[0]["minutes"] == 15  # 10 before the pause + 5 after
    # a time in the future or long ago is ignored (counts from now)
    assert (
        admin.post(f"{API}/work-orders/{a['id']}/timer", {"at": (now + timedelta(days=2)).isoformat()}).status_code
        == 200
    )
    t = next(x for x in admin.get(f"{API}/me/timers").json["items"] if x["work_order_id"] == a["id"])
    assert t["elapsed_seconds"] < 60
    assert admin.post(f"{API}/work-orders/{b['id']}/timer/pause", {}).status_code == 200
    assert admin.post(f"{API}/work-orders/{b['id']}/timer", {}).status_code == 200  # start = resume
    assert not next(x for x in admin.get(f"{API}/me/timers").json["items"] if x["work_order_id"] == b["id"])["paused"]


def test_timer_pause_needs_my_timer_and_my_org(app: Any, admin: Api) -> None:
    wo = create(admin)
    assert admin.post(f"{API}/work-orders/{wo['id']}/timer/pause", {}).status_code == 409
    other = other_org(app)
    assert other.post(f"{API}/work-orders/{wo['id']}/timer/pause", {}).status_code == 404
    assert other.post(f"{API}/work-orders/{wo['id']}/timer/resume", {}).status_code == 404


# ---------------------------------------------------------------- delete my account (r321)
def test_only_owner_hands_over_before_deleting(admin: Api) -> None:
    s = admin.get(f"{API}/me/account").json
    assert s["can_delete"] is False and s["only_owner_of"]
    r = admin.c.delete(f"{API}/me/account", json={"password": "mpro-demo-123", "confirm": "DELETE"}, headers=admin._h())
    assert r.status_code == 409 and "only Owner" in r.json["message"]


def test_delete_my_account(app: Any, admin: Api) -> None:
    wo = create(admin)
    tech = login(app, "sam.patel@example.com")
    assert tech.post(f"{API}/work-orders/{wo['id']}/comments", {"body": "Done the wiring"}).status_code == 201
    assert tech.get(f"{API}/me/account").json["can_delete"] is True
    bad = tech.c.delete(f"{API}/me/account", json={"password": "wrong", "confirm": "DELETE"}, headers=tech._h())
    assert bad.status_code == 403
    nope = tech.c.delete(f"{API}/me/account", json={"password": "mpro-demo-123", "confirm": "yes"}, headers=tech._h())
    assert nope.status_code == 422
    ok = tech.c.delete(f"{API}/me/account", json={"password": "mpro-demo-123", "confirm": "DELETE"}, headers=tech._h())
    assert ok.status_code == 204
    assert tech.get(f"{API}/auth/session").json.get("authenticated") is False
    assert Api(app.test_client()).login("sam.patel@example.com").status_code != 200
    # history stays readable, the email is free again
    names = [
        x["author"]["name"]
        for x in admin.get(f"{API}/work-orders/{wo['id']}/activity").json["items"]
        if x["kind"] == "comment" and x["author"]
    ]
    assert "Deleted user" in names
    assert all(u["email"] != "sam.patel@example.com" for u in admin.get(f"{API}/users?q=sam").json["items"])


def test_account_endpoints_need_sign_in(api: Api) -> None:
    assert api.get(f"{API}/me/account").status_code == 401
    assert api.get(f"{API}/sync").status_code == 401
