from __future__ import annotations

from typing import Any

from mpro.auth.models import User
from mpro.extensions import db
from mpro.orgs.services import create_org


def _user_id(admin: Any, email: str) -> str:
    users = admin.get("/api/v1/users").json["items"]
    return next(u["id"] for u in users if u["email"] == email)


def test_list_and_filter_users(admin: Any) -> None:
    r = admin.get("/api/v1/users").json
    assert r["total"] == 12
    assert any(u["teams"] for u in r["items"])
    assert {u["email"] for u in admin.get("/api/v1/users?q=elec").json["items"]} == {
        "sam.patel@example.com",
        "taylor.brooks@example.com",
    }
    assert all(u["role"] == "requester" for u in admin.get("/api/v1/users?role=requester").json["items"])


def test_update_org(admin: Any) -> None:
    r = admin.patch("/api/v1/org", json={"name": "Acme Plant 2", "timezone": "Europe/Berlin", "units": "metric"})
    assert r.status_code == 200 and r.json["timezone"] == "Europe/Berlin"
    assert admin.patch("/api/v1/org", json={"timezone": "Mars/Base"}).status_code == 422
    audit = admin.get("/api/v1/audit?entity_type=org").json["items"]
    assert audit[0]["changes"]["name"] == ["Acme Manufacturing (Demo)", "Acme Plant 2"]


def test_invite_member_sends_set_password_email(admin: Any, app: Any) -> None:
    r = admin.post("/api/v1/users", json={"email": "New.Tech@Example.com", "name": "New Tech", "role": "technician"})
    assert r.status_code == 201 and r.json["email"] == "new.tech@example.com" and not r.json["has_password"]
    assert admin.post("/api/v1/users", json={"email": "new.tech@example.com", "role": "technician"}).status_code == 409
    outbox = admin.get("/api/v1/outbox").json["items"]
    assert "/reset-password/" in outbox[0]["body"] and "invite=1" in outbox[0]["body"]


def test_role_changes_and_last_admin(admin: Any) -> None:
    jid = _user_id(admin, "jordan.reyes@example.com")
    assert admin.patch(f"/api/v1/users/{jid}", json={"role": "technician"}).json["role"] == "technician"
    me = admin.session()["user"]["id"]
    r = admin.patch(f"/api/v1/users/{me}", json={"role": "technician"})
    assert r.status_code == 409 and "at least one Owner" in r.json["message"]
    assert admin.delete(f"/api/v1/users/{me}").status_code == 409


def test_limited_admin_cannot_make_admins(api: Any) -> None:
    api.login("jordan.reyes@example.com")
    r = api.post("/api/v1/users", json={"email": "boss@example.com", "role": "admin"})
    assert r.status_code == 403
    assert api.patch("/api/v1/org", json={"name": "nope"}).status_code == 403
    assert api.post("/api/v1/users", json={"email": "tech2@example.com", "role": "technician"}).status_code == 201


def test_technician_permissions(api: Any) -> None:
    api.login("avery.kim@example.com")
    assert api.get("/api/v1/users").status_code == 200
    assert api.post("/api/v1/teams", json={"name": "Mine"}).status_code == 403
    assert api.get("/api/v1/audit").status_code == 403
    me = api.session()["user"]["id"]
    assert api.patch(f"/api/v1/users/{me}", json={"name": "Avery K."}).status_code == 200
    assert api.patch(f"/api/v1/users/{me}", json={"role": "admin"}).status_code == 403


def test_requester_cannot_list_people(api: Any) -> None:
    api.login("jamie.ortiz@example.com")
    assert api.get("/api/v1/users").status_code == 403
    assert api.get("/api/v1/teams").status_code == 200


def test_remove_member(admin: Any) -> None:
    uid = _user_id(admin, "drew.walker@example.com")
    assert admin.delete(f"/api/v1/users/{uid}").status_code == 204
    assert admin.get(f"/api/v1/users/{uid}").status_code == 404
    admin.post("/api/v1/auth/logout")
    r = admin.login("drew.walker@example.com")  # can sign in, but has no organization
    assert r.status_code == 200 and r.json["org"] is None


def test_teams_crud(admin: Any) -> None:
    t = admin.post("/api/v1/teams", json={"name": "Grounds", "color": "#19804f"}).json
    assert admin.post("/api/v1/teams", json={"name": "grounds"}).status_code == 409
    uid = _user_id(admin, "avery.kim@example.com")
    assert admin.post(f"/api/v1/teams/{t['id']}/members", json={"user_id": uid}).json["member_count"] == 1
    assert admin.patch(f"/api/v1/teams/{t['id']}", json={"color": "red"}).status_code == 422
    assert admin.delete(f"/api/v1/teams/{t['id']}/members/{uid}").json["member_count"] == 0
    assert admin.delete(f"/api/v1/teams/{t['id']}").status_code == 204
    assert admin.get(f"/api/v1/teams/{t['id']}").status_code == 404


def test_tenant_isolation(admin: Any, app: Any) -> None:
    """Records of another organization are invisible and untouchable (guideline G-15)."""
    with app.app_context():
        other_admin = User(email="owner@other.test", name="Other Owner")
        other_admin.set_password("other-password")
        db.session.add(other_admin)
        db.session.flush()
        other = create_org("Other Co", other_admin)
        db.session.flush()
        from mpro.orgs.models import Team

        t = Team(org_id=other.id, name="Secret team")
        db.session.add(t)
        db.session.commit()
        other_team, other_user = str(t.id), str(other_admin.id)
    assert admin.get(f"/api/v1/teams/{other_team}").status_code == 404
    assert admin.patch(f"/api/v1/teams/{other_team}", json={"name": "pwned"}).status_code == 404
    assert admin.delete(f"/api/v1/teams/{other_team}").status_code == 404
    assert admin.get(f"/api/v1/users/{other_user}").status_code == 404
    assert "Secret team" not in str(admin.get("/api/v1/teams").json)
    assert admin.get("/api/v1/search?q=secret").json["groups"] == []
    assert all(e["entity_label"] != "Secret team" for e in admin.get("/api/v1/audit").json["items"])
    # switching to an org you're not a member of is refused
    from mpro.extensions import db as _db  # noqa: F401

    assert admin.post("/api/v1/auth/switch-org", json={"org_id": other_team}).status_code == 404


def test_org_switch(api: Any, app: Any) -> None:
    with app.app_context():
        u = db.session.query(User).filter_by(email="admin@example.com").one()
        second = create_org("Second Site", u)
        db.session.commit()
        sid = str(second.id)
    api.login()
    s = api.session()
    assert len(s["orgs"]) == 2
    s = api.post("/api/v1/auth/switch-org", json={"org_id": sid}).json
    assert s["org"]["name"] == "Second Site"
    assert api.get("/api/v1/users").json["total"] == 1
