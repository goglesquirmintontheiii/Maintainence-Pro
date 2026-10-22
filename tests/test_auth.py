from __future__ import annotations

import re
from typing import Any

from mpro.core.mail import OutboundEmail
from mpro.extensions import db


def test_session_signed_out(api: Any) -> None:
    s = api.session()
    assert s["authenticated"] is False and s["csrf"]


def test_login_and_session(admin: Any) -> None:
    s = admin.session()
    assert s["authenticated"] and s["user"]["email"] == "admin@example.com"
    assert s["role"] == "owner" and "users.manage" in s["permissions"]
    assert s["org"]["name"].startswith("Acme")


def test_wrong_password(api: Any) -> None:
    r = api.login(password="nope-nope")
    assert r.status_code == 401 and "don't match" in r.json["message"]


def test_login_rate_limited(api: Any, app: Any) -> None:
    app.config["LOGIN_MAX_FAILURES"] = 3
    for _ in range(3):
        assert api.login(password="bad-password").status_code == 401
    r = api.login()  # even the right password is refused while locked
    assert r.status_code == 429


def test_email_is_case_insensitive(api: Any) -> None:
    assert api.login(email="  ADMIN@Example.com ").status_code == 200


def test_csrf_required_for_changes(admin: Any) -> None:
    r = admin.c.patch("/api/v1/org", json={"name": "X"})
    assert r.status_code == 403
    r = admin.c.patch("/api/v1/org", json={"name": "X"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403


def test_logout(admin: Any) -> None:
    admin.post("/api/v1/auth/logout")
    assert admin.get("/api/v1/users").status_code == 401


def _last_link(app: Any, to: str) -> str:
    with app.app_context():
        m = db.session.query(OutboundEmail).filter_by(to=to).order_by(OutboundEmail.created_at.desc()).first()
        assert m is not None and m.status == "not_configured"  # no SMTP in tests; email kept in the outbox
        match = re.search(r"/reset-password/([^\s?]+)", m.body)
        assert match
        return match.group(1)


def test_password_reset_flow(api: Any, app: Any) -> None:
    api.session()
    r = api.post("/api/v1/auth/password/forgot", json={"email": "avery.kim@example.com"})
    assert r.status_code == 202
    token = _last_link(app, "avery.kim@example.com")
    assert api.post("/api/v1/auth/password/check", json={"token": token}).json["purpose"] == "reset"
    assert api.post("/api/v1/auth/password/reset", json={"token": token, "password": "short"}).status_code == 422
    r = api.post("/api/v1/auth/password/reset", json={"token": token, "password": "brand-new-pass"})
    assert r.status_code == 200 and r.json["authenticated"]
    # single use
    assert api.post("/api/v1/auth/password/reset", json={"token": token, "password": "another-pass"}).status_code == 410
    api.post("/api/v1/auth/logout")
    assert api.login("avery.kim@example.com", "brand-new-pass").status_code == 200


def test_forgot_does_not_reveal_accounts(api: Any) -> None:
    api.session()
    r = api.post("/api/v1/auth/password/forgot", json={"email": "nobody@nowhere.test"})
    assert r.status_code == 202


def test_bad_token(api: Any) -> None:
    api.session()
    assert api.post("/api/v1/auth/password/check", json={"token": "garbage"}).status_code == 400


def test_change_password(admin: Any) -> None:
    r = admin.post("/api/v1/auth/password/change", json={"current": "wrong-one", "new": "whatever-123"})
    assert r.status_code == 422
    r = admin.post("/api/v1/auth/password/change", json={"current": "mpro-demo-123", "new": "whatever-123"})
    assert r.status_code == 200


def test_theme_preference(admin: Any) -> None:
    assert admin.patch("/api/v1/auth/preferences", json={"theme": "dark"}).json["user"]["theme"] == "dark"
    assert admin.patch("/api/v1/auth/preferences", json={"theme": "purple"}).status_code == 422
