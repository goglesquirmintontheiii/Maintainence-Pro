"""Sysadmins and MPro Management (0.6.0: MP-134, MP-135, MP-136)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from tests.conftest import Api

API = "/api/v1/sysadmin"
PW = "mpro-demo-123"


def _make_sysadmin(app: Any, email: str = "admin@example.com") -> None:
    with app.app_context():
        from mpro.sysadmin.services import add_sysadmin

        add_sysadmin(email)


def _other_owner(app: Any, email: str = "owner2@example.com") -> None:
    """An Owner of another organization: not a sysadmin."""
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.services import create_org

        u = User(email=email, name="Olive Owner")
        u.set_password(PW)
        db.session.add(u)
        db.session.flush()
        create_org("Olive Bakery", u)
        db.session.commit()


@pytest.fixture()
def sa(app: Any, admin: Api) -> Api:
    _make_sysadmin(app)
    return admin


def _events(app: Any, prefix: str) -> list[Any]:
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent
        from mpro.extensions import db

        return list(
            db.session.scalars(
                select(DomainEvent).where(DomainEvent.type.like(prefix + "%")).order_by(DomainEvent.created_at)
            )
        )


# ---- MP-135: terminal ---------------------------------------------------------------------------
def test_cli_add_list_remove_and_last_sysadmin(app: Any, capsys: Any) -> None:
    from mpro.cli import _sysadmin

    assert _sysadmin(app, "list", None, False) == 0
    assert "no sysadmins" in capsys.readouterr().out
    assert _sysadmin(app, "add", "nobody@example.com", False) == 1
    assert "No one has the email" in capsys.readouterr().err
    assert _sysadmin(app, "add", "ADMIN@example.com", False) == 0
    assert _sysadmin(app, "add", "admin@example.com", False) == 1  # already one
    capsys.readouterr()
    assert _sysadmin(app, "list", None, False) == 0
    assert "admin@example.com" in capsys.readouterr().out
    # the last sysadmin can't be removed by accident
    assert _sysadmin(app, "remove", "admin@example.com", False) == 1
    assert "last sysadmin" in capsys.readouterr().err
    assert _sysadmin(app, "remove", "admin@example.com", True) == 0
    assert "no sysadmins" in capsys.readouterr().err
    evs = _events(app, "sysadmin.")
    assert [e.type for e in evs] == ["sysadmin.added", "sysadmin.removed"]
    assert all(e.org_id is None for e in evs)  # the server's audit log, not an organization's
    assert evs[1].data["forced"] is True


def test_create_admin_makes_the_first_sysadmin_only(app: Any) -> None:
    from mpro.cli import _create_admin

    _create_admin(app, "first@example.com", "First", "First Org", "a-long-password-1")
    _create_admin(app, "second@example.com", "Second", "Second Org", "a-long-password-2")
    with app.app_context():
        from mpro.sysadmin.services import list_sysadmins

        assert [u.email for u in list_sysadmins()] == ["first@example.com"]


def test_demo_data_makes_the_demo_admin_sysadmin_on_a_new_server(app: Any) -> None:
    app.config["MPRO_TEST_BUILD"] = True  # only in test builds: the demo password is public (0.6.0 review #7)
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.sysadmin.demo import seed

        admin = db.session.query(User).filter_by(email="admin@example.com").one()
        seed(None, admin)
        assert admin.is_sysadmin
        other = db.session.query(User).filter(User.email != "admin@example.com").first()
        seed(None, other)  # a server that has one doesn't get another
        assert not other.is_sysadmin


# ---- MP-136: access --------------------------------------------------------------------------------
ENDPOINTS = [
    ("get", "/overview"),
    ("get", "/audit"),
    ("get", "/server-settings"),
    ("patch", "/server-settings"),
    ("get", "/api-keys"),
    ("post", "/api-keys"),
    ("get", "/users"),
    ("get", "/orgs"),
]


def test_only_sysadmins_get_in(app: Any, api: Api) -> None:
    for method, path in ENDPOINTS:
        r = getattr(api, method)(API + path) if method == "get" else getattr(api, method)(API + path, {})
        assert r.status_code in (401, 403), (path, r.status_code)
    _other_owner(app)
    assert api.login("owner2@example.com", PW).status_code == 200
    assert api.session()["user"]["sysadmin"] is False
    for method, path in ENDPOINTS:
        r = getattr(api, method)(API + path) if method == "get" else getattr(api, method)(API + path, {"x": 1})
        assert r.status_code == 403, (path, r.status_code)
        assert "sysadmins" in r.json["message"]
    # nor with someone's id
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db

        uid = str(db.session.query(User).filter_by(email="admin@example.com").one().id)
    assert api.get(f"{API}/users/{uid}").status_code == 403
    assert api.patch(f"{API}/users/{uid}", {"name": "Hacked"}).status_code == 403


def test_locked_sysadmin_is_out(app: Any, sa: Api) -> None:
    assert sa.session()["user"]["sysadmin"] is True
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db

        u = db.session.query(User).filter_by(email="admin@example.com").one()
        u.active = False
        db.session.commit()
    assert sa.get(API + "/overview").status_code == 401


# ---- users -----------------------------------------------------------------------------------------
def test_user_database_and_management(app: Any, sa: Api) -> None:
    r = sa.get(API + "/users?q=avery")
    assert r.status_code == 200 and r.json["total"] >= 1
    avery = r.json["items"][0]
    assert avery["email"].startswith("avery")
    assert set(avery) >= {"id", "name", "email", "phone", "active", "sysadmin", "org_count"}
    # by id
    assert sa.get(API + "/users?q=" + avery["id"]).json["total"] == 1
    d = sa.get(f"{API}/users/{avery['id']}").json
    assert d["orgs"][0]["org_name"].startswith("Acme")
    r = sa.patch(f"{API}/users/{avery['id']}", {"name": "Avery K.", "phone": "+1 (555) 010-2000"})
    assert r.status_code == 200 and r.json["name"] == "Avery K." and r.json["phone"] == "+1 (555) 010-2000"
    assert sa.patch(f"{API}/users/{avery['id']}", {"email": "admin@example.com"}).status_code == 409
    assert sa.patch(f"{API}/users/{avery['id']}", {"phone": "<script>"}).status_code == 422
    # lock: they can't sign in
    assert sa.patch(f"{API}/users/{avery['id']}", {"active": False}).json["active"] is False
    other = Api(app.test_client())
    assert other.login(avery["email"], PW).status_code != 200
    assert sa.patch(f"{API}/users/{avery['id']}", {"active": True}).json["active"] is True
    assert other.login(avery["email"], PW).status_code == 200
    me = sa.session()["user"]["id"]
    assert sa.patch(f"{API}/users/{me}", {"active": False}).status_code == 409
    types = [e.type for e in _events(app, "sysadmin.user_")]
    assert types == ["sysadmin.user_updated", "sysadmin.user_locked", "sysadmin.user_unlocked"]


def test_sysadmin_changes_and_password_reset_need_the_password(app: Any, sa: Api) -> None:
    avery = sa.get(API + "/users?q=avery").json["items"][0]
    url = f"{API}/users/{avery['id']}"
    assert sa.patch(url, {"sysadmin": True}).status_code == 403
    assert sa.patch(url, {"sysadmin": True, "password": "wrong"}).status_code == 403
    assert sa.patch(url, {"sysadmin": True, "password": PW}).json["sysadmin"] is True
    # the last sysadmin can't step down
    me = sa.session()["user"]["id"]
    assert sa.patch(url, {"sysadmin": False, "password": PW}).json["sysadmin"] is False
    r = sa.patch(f"{API}/users/{me}", {"sysadmin": False, "password": PW})
    assert r.status_code == 409 and "last sysadmin" in r.json["message"]
    # password reset
    reset = f"{url}/reset-password"
    assert sa.post(reset, {"mode": "set", "new_password": "a-brand-new-pass-1"}).status_code == 403
    assert sa.post(reset, {"mode": "set", "new_password": "short", "password": PW}).status_code == 422
    assert sa.post(reset, {"mode": "set", "new_password": "a-brand-new-pass-1", "password": PW}).status_code == 200
    assert Api(app.test_client()).login(avery["email"], "a-brand-new-pass-1").status_code == 200
    assert sa.post(reset, {"mode": "email", "password": PW}).status_code == 200
    with app.app_context():
        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        m = (
            db.session.query(OutboundEmail)
            .filter_by(to=avery["email"])
            .order_by(OutboundEmail.created_at.desc())
            .first()
        )
        assert m is not None and "/reset-password/" in m.body
    assert len(_events(app, "sysadmin.password_check_failed")) == 3
    assert len(_events(app, "sysadmin.user_password_reset")) == 2


# ---- organizations ----------------------------------------------------------------------------------
FORBIDDEN_KEYS = {"work_orders", "assets", "files", "parts", "invoices", "purchase_orders", "money", "costs", "budget"}


def _keys(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | {k for v in obj.values() for k in _keys(v)}
    if isinstance(obj, list):
        return {k for v in obj for k in _keys(v)}
    return set()


def test_org_database_and_management_show_no_org_data(app: Any, sa: Api) -> None:
    _other_owner(app)
    r = sa.get(API + "/orgs?q=bakery")
    assert r.status_code == 200 and r.json["total"] == 1
    org = r.json["items"][0]
    assert org["owners"][0]["email"] == "owner2@example.com" and org["members"] == 1
    d = sa.get(f"{API}/orgs/{org['id']}").json
    assert not (_keys(d) & FORBIDDEN_KEYS)
    assert not (_keys(r.json) & FORBIDDEN_KEYS)
    text = json.dumps(d).lower()
    assert "work order" not in text and "invoice" not in text
    # edit
    r = sa.patch(f"{API}/orgs/{org['id']}", {"name": "Olive's Bakery", "email": "hi@olive.example", "plan": "pro"})
    assert r.status_code == 200 and r.json["name"] == "Olive's Bakery" and r.json["plan"] == "pro"
    assert sa.patch(f"{API}/orgs/{org['id']}", {"plan": "platinum"}).status_code == 422
    assert sa.patch(f"{API}/orgs/{org['id']}", {"email": "nope"}).status_code == 422
    # members: add, change role, the last owner stays
    r = sa.post(
        f"{API}/orgs/{org['id']}/members", {"email": "newbie@example.com", "name": "Newbie", "role": "technician"}
    )
    assert r.status_code == 201
    newbie = next(m for m in r.json["member_list"] if m["email"] == "newbie@example.com")
    assert newbie["role"] == "technician"
    assert sa.post(f"{API}/orgs/{org['id']}/members", {"email": "newbie@example.com"}).status_code == 409
    owner = next(m for m in r.json["member_list"] if m["role"] == "owner")
    r = sa.patch(f"{API}/orgs/{org['id']}/members/{owner['user_id']}", {"role": "technician"})
    assert r.status_code == 409 and "Owner" in r.json["message"]
    assert sa.delete(f"{API}/orgs/{org['id']}/members/{owner['user_id']}").status_code == 409
    # making an Owner opens all of the organization's data: the sysadmin's password again (0.6.0 review #11)
    assert sa.patch(f"{API}/orgs/{org['id']}/members/{newbie['user_id']}", {"role": "owner"}).status_code == 403
    r = sa.patch(f"{API}/orgs/{org['id']}/members/{newbie['user_id']}", {"role": "owner", "password": PW})
    assert r.status_code == 200
    r = sa.patch(f"{API}/orgs/{org['id']}/members/{owner['user_id']}", {"role": "viewer", "password": PW})
    assert r.status_code == 200
    assert sa.delete(f"{API}/orgs/{org['id']}/members/{owner['user_id']}").status_code == 200
    assert sa.patch(f"{API}/orgs/{org['id']}/members/{owner['user_id']}", {"role": "bogus"}).status_code == 404
    # these show in the organization's own audit log too
    evs = _events(app, "sysadmin.")
    assert any(e.type == "sysadmin.org_updated" and str(e.org_id) == org["id"] for e in evs)
    assert any(e.type == "sysadmin.membership_removed" and str(e.org_id) == org["id"] for e in evs)


def test_delete_and_restore_org(app: Any, sa: Api) -> None:
    _other_owner(app)
    org = sa.get(API + "/orgs?q=bakery").json["items"][0]
    url = f"{API}/orgs/{org['id']}/delete"
    assert sa.post(url, {"confirm_name": "Olive Bakery"}).status_code == 403
    assert sa.post(url, {"confirm_name": "Olive", "password": PW}).status_code == 422
    assert sa.post(url, {"confirm_name": "Olive Bakery", "password": PW}).status_code == 200
    owner = Api(app.test_client())
    assert owner.login("owner2@example.com", PW).status_code == 200
    assert owner.session()["org"] is None  # members lose access straight away
    assert sa.get(API + "/orgs?q=bakery").json["total"] == 0
    assert sa.get(API + "/orgs?q=bakery&deleted=1").json["items"][0]["deleted"] is True
    assert sa.post(f"{API}/orgs/{org['id']}/restore", {}).status_code == 200
    assert owner.session()["org"]["name"] == "Olive Bakery"


# ---- server settings and API keys ------------------------------------------------------------------
def test_server_settings_saved_validated_and_applied(app: Any, sa: Api, tmp_path: Any, monkeypatch: Any) -> None:
    monkeypatch.delenv("MPRO_SMTP_HOST", raising=False)
    monkeypatch.delenv("MPRO_HOST", raising=False)
    r = sa.get(API + "/server-settings")
    assert r.status_code == 200
    keys = {i["key"] for i in r.json["items"]}
    assert {"host", "port", "base_url", "smtp_host", "smtp_password"} <= keys
    assert sa.patch(API + "/server-settings", {"port": 70000}).status_code == 422
    assert sa.patch(API + "/server-settings", {"host": "not a host!"}).status_code == 422
    assert sa.patch(API + "/server-settings", {"base_url": "ftp://x"}).status_code == 422
    assert sa.patch(API + "/server-settings", {"nope": 1}).status_code == 422
    r = sa.patch(
        API + "/server-settings",
        {"host": "0.0.0.0", "port": 9090, "smtp_host": "smtp.example.com", "smtp_password": "s3cret-pass"},
    )
    assert r.status_code == 200, r.json
    assert r.json["warning"] and "every network" in r.json["warning"]
    assert "Address to listen on" in r.json["restart_needed"]
    pw = next(i for i in r.json["items"] if i["key"] == "smtp_password")
    assert pw["value"] is None and pw["has_value"] is True
    saved = json.loads((tmp_path / "server.json").read_text())
    assert saved["host"] == "0.0.0.0" and saved["port"] == 9090
    assert saved["smtp_password"].startswith("enc1:") and "s3cret" not in json.dumps(saved)
    assert app.config["MAIL_SERVER"] == "smtp.example.com"  # applies now
    # a fresh start reads it back (decrypted)
    from mpro.config import load_config

    cfg = load_config()
    assert cfg["MAIL_PASSWORD"] == "s3cret-pass" and cfg["MAIL_SERVER"] == "smtp.example.com"
    from mpro.sysadmin.server_settings import listen_address

    assert listen_address(tmp_path, None, None, "0.0.0.0") == ("0.0.0.0", 9090)
    assert listen_address(tmp_path, "127.0.0.1", 8000, "0.0.0.0") == ("127.0.0.1", 8000)
    monkeypatch.setenv("MPRO_PORT", "8181")
    assert listen_address(tmp_path, None, None, "0.0.0.0") == ("0.0.0.0", 8181)
    # settings fixed by the environment are locked
    monkeypatch.setenv("MPRO_SMTP_HOST", "env.example.com")
    item = next(i for i in sa.get(API + "/server-settings").json["items"] if i["key"] == "smtp_host")
    assert item["locked"] and item["source"] == "environment"
    assert sa.patch(API + "/server-settings", {"smtp_host": "x.example.com"}).status_code == 409
    ev = _events(app, "sysadmin.server_settings_changed")[0]
    assert ev.org_id is None and "s3cret" not in json.dumps(ev.changes)


def test_api_keys_encrypted_and_masked(app: Any, sa: Api) -> None:
    assert sa.post(API + "/api-keys", {"name": "AI", "service": "openai", "secret": "short"}).status_code == 422
    assert sa.post(API + "/api-keys", {"name": "AI", "service": "nope", "secret": "sk-1234567890"}).status_code == 422
    r = sa.post(API + "/api-keys", {"name": "OpenAI for MPro", "service": "openai", "secret": "sk-test-abcdef123456"})
    assert r.status_code == 201
    k = r.json
    assert k["masked"] == "••••3456" and "sk-test" not in json.dumps(k)
    listed = sa.get(API + "/api-keys").json
    assert "sk-test" not in json.dumps(listed) and listed["items"][0]["id"] == k["id"]
    with app.app_context():
        from mpro.extensions import db
        from mpro.sysadmin.models import ApiKey
        from mpro.sysadmin.services import secret_for

        row = db.session.get(ApiKey, __import__("uuid").UUID(k["id"]))
        assert row is not None and row.secret.startswith("enc1:") and "abcdef" not in row.secret
        assert secret_for("openai") == "sk-test-abcdef123456"
    r = sa.patch(f"{API}/api-keys/{k['id']}", {"secret": "sk-test-zzzzzz999999", "note": "rotated"})
    assert r.json["masked"] == "••••9999"
    assert sa.delete(f"{API}/api-keys/{k['id']}").status_code == 204
    assert sa.get(API + "/api-keys").json["items"] == []
    types = [e.type for e in _events(app, "sysadmin.api_key")]
    assert types == ["sysadmin.api_key_created", "sysadmin.api_key_updated", "sysadmin.api_key_deleted"]
    assert all("sk-test" not in json.dumps(e.to_dict()) for e in _events(app, "sysadmin."))


def test_server_audit_log(app: Any, sa: Api) -> None:
    sa.post(API + "/api-keys", {"name": "Gemini", "service": "google", "secret": "AIza-1234567890"})
    r = sa.get(API + "/audit?q=gemini")
    assert r.status_code == 200 and r.json["items"][0]["type"] == "sysadmin.api_key_created"
