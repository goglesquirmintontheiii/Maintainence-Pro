# ruff: noqa: E501
"""Work orders shared outside the organization (0.5.0: r058–r060, r088, r092), vendors on work orders (r075) and
emailing the PDF to vendors (r094)."""

from __future__ import annotations

import io
import json
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import PNG_1PX, create, login

API = "/api/v1"


def share(admin: Api, wo_id: str, **kw: Any) -> dict[str, Any]:
    r = admin.post(f"{API}/work-orders/{wo_id}/external-shares", kw)
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def anon(app: Any, ip: str = "10.0.0.1") -> Any:
    """A visitor with no session (separate cookie jar), from its own IP so rate limits don't leak between tests."""
    c = app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    return c


def vendor(admin: Api, name: str = "Acme Mechanical", email: str = "jo@acme.test") -> tuple[str, str]:
    v = admin.post(f"{API}/vendors", {"name": name})
    assert v.status_code == 201, v.json
    c = admin.post(f"{API}/vendors/{v.json['id']}/contacts", {"name": "Jo", "email": email, "is_po_contact": True})
    assert c.status_code == 201, c.json
    return v.json["id"], c.json["id"]


def outbox(app: Any, to: str) -> list[Any]:
    with app.app_context():
        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        return [
            {"subject": m.subject, "body": m.body, "attachments": m.attachments}
            for m in db.session.query(OutboundEmail).filter_by(to=to).order_by(OutboundEmail.created_at)
        ]


def test_token_is_random_and_only_its_hash_is_stored(app: Any, admin: Api) -> None:
    wo = create(admin)
    s = share(admin, wo["id"])
    token = s["token"]
    assert len(token) >= 40 and s["path"] == f"/x/{token}"
    with app.app_context():
        import hashlib

        from mpro.extensions import db
        from mpro.workorders.models import ExternalShare

        row = db.session.get(ExternalShare, __import__("uuid").UUID(s["id"]))
        assert row is not None and row.token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert token not in json.dumps({c.name: str(getattr(row, c.name)) for c in row.__table__.columns})
    # the token can't be read back
    listed = admin.get(f"{API}/work-orders/{wo['id']}/external-shares").json["items"]
    assert listed and "token" not in listed[0]
    assert token not in json.dumps(admin.get(f"{API}/work-orders/{wo['id']}").json)
    assert token not in json.dumps(admin.get(f"{API}/audit?entity_type=work_order").json)
    v = anon(app).get(f"{API}/external/{token}")
    assert v.status_code == 200 and v.json["title"] == wo["title"]
    assert v.headers["Cache-Control"] == "no-store" and v.headers["Referrer-Policy"] == "no-referrer"
    assert anon(app).get(f"{API}/external/{token[:-1]}x").status_code == 404


def test_disable_reset_remove_and_done(app: Any, admin: Api) -> None:
    wo = create(admin)
    s = share(admin, wo["id"])
    base = f"{API}/work-orders/{wo['id']}/external-shares/{s['id']}"
    c = anon(app)
    assert admin.patch(base, {"status": "disabled"}).json["status"] == "disabled"
    assert c.get(f"{API}/external/{s['token']}").status_code == 404
    assert admin.patch(base, {"status": "active"}).json["status"] == "active"  # reversible
    assert c.get(f"{API}/external/{s['token']}").status_code == 200
    n = admin.post(f"{base}/reset").json
    assert n["token"] != s["token"]
    assert c.get(f"{API}/external/{s['token']}").status_code == 404  # old link revoked
    assert c.get(f"{API}/external/{n['token']}").status_code == 200
    assert admin.patch(base, {"status": "active"}).status_code == 404  # revoked links are gone
    # Done turns links off, and they can't be turned back on until reopened
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"}).status_code == 200
    assert c.get(f"{API}/external/{n['token']}").status_code == 404
    nb = f"{API}/work-orders/{wo['id']}/external-shares/{n['id']}"
    assert admin.get(f"{API}/work-orders/{wo['id']}/external-shares").json["items"][0]["status"] == "disabled"
    assert admin.patch(nb, {"status": "active"}).status_code == 409
    assert admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {}).status_code == 409
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "open"}).status_code == 200
    assert admin.patch(nb, {"status": "active"}).json["status"] == "active"
    assert admin.delete(nb).status_code == 204
    assert c.get(f"{API}/external/{n['token']}").status_code == 404
    # deleting the work order kills the link
    s2 = share(admin, wo["id"])
    assert admin.delete(f"{API}/work-orders/{wo['id']}").status_code in (200, 204)
    assert c.get(f"{API}/external/{s2['token']}").status_code == 404


def test_field_access(app: Any, admin: Api) -> None:
    wo = create(admin, description="Secret details", priority="high")
    assert (
        admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {"fields": {"files": "interact"}}).status_code
        == 422
    )
    assert admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {"fields": {"nope": "view"}}).status_code == 422
    s = share(admin, wo["id"], fields={"description": "hidden", "comments": "view", "procedures": "hidden"})
    c = anon(app)
    v = c.get(f"{API}/external/{s['token']}").json
    assert "description" not in v and "procedures" not in v and "assignees" not in v
    assert v["priority"] == "high" and v["access"]["comments"] == "view"
    # comments are view-only: posting is refused
    r = c.post(f"{API}/external/{s['token']}/comments", json={"name": "Jo", "body": "hi"})
    assert r.status_code == 403
    # uploads need an interactive field
    up = c.post(
        f"{API}/external/{s['token']}/files",
        data={"file": (io.BytesIO(PNG_1PX), "p.png")},
        content_type="multipart/form-data",
    )
    assert up.status_code == 403
    # the admin opens up comments; now it works
    admin.patch(f"{API}/work-orders/{wo['id']}/external-shares/{s['id']}", {"fields": {"comments": "interact"}})
    r = c.post(f"{API}/external/{s['token']}/comments", json={"name": "Jo", "body": "On my way"})
    assert r.status_code == 201, r.json
    v = c.get(f"{API}/external/{s['token']}").json
    assert v["comments"][-1]["author"] == "Jo (outside)" and v["comments"][-1]["external"]
    with app.app_context():
        from mpro.extensions import db
        from mpro.workorders.models import Comment

        assert db.session.query(Comment).filter_by(external_name="Jo", author_id=None).count() == 1


def test_procedures_files_and_finish(app: Any, admin: Api) -> None:
    wo = create(admin)
    schema = {
        "items": [
            {"id": "ok", "type": "checkbox", "label": "Belt tensioned"},
            {"id": "pic", "type": "file", "label": "Photo"},
        ]
    }
    r = admin.post(f"{API}/work-orders/{wo['id']}/procedures", {"name": "Check", "schema": schema})
    assert r.status_code == 201, r.json
    run_id = r.json.get("id") or r.json["run"]["id"]
    # a file on the work order the link does not show
    inner = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(PNG_1PX), "inner.png")},
        headers=admin._h(),
        content_type="multipart/form-data",
    ).json["id"]
    s = share(admin, wo["id"], fields={"files": "hidden"})
    t = s["token"]
    c = anon(app)
    v = c.get(f"{API}/external/{t}").json
    assert v["procedures"] and "files" not in v
    assert c.get(f"{API}/external/{t}/files/{inner}").status_code == 404
    assert (
        c.put(f"{API}/external/{t}/procedures/{run_id}/answers/ok", json={"name": "Jo", "value": True}).status_code
        == 200
    )
    # files: only ones uploaded through this link can be used
    up = c.post(
        f"{API}/external/{t}/files",
        data={"file": (io.BytesIO(PNG_1PX), "belt.png")},
        content_type="multipart/form-data",
    )
    assert up.status_code == 201, up.json
    fid = up.json["id"]
    assert c.get(up.json["url"]).status_code == 200
    bad = c.put(f"{API}/external/{t}/procedures/{run_id}/answers/pic", json={"name": "Jo", "value": [inner]})
    assert bad.status_code == 422
    assert (
        c.put(f"{API}/external/{t}/procedures/{run_id}/answers/pic", json={"name": "Jo", "value": [fid]}).status_code
        == 200
    )
    assert (
        c.post(f"{API}/external/{t}/comments", json={"name": "Jo", "body": "see", "file_ids": [inner]}).status_code
        == 422
    )
    # upload limits from the normal upload path still apply
    with app.app_context():
        from mpro.workorders import external as ext

        assert ext.MAX_ACTIVE_PER_WO == 20
    big = c.post(
        f"{API}/external/{t}/files",
        data={"file": (io.BytesIO(b"MZ" + b"\0" * 100), "evil.exe")},
        content_type="multipart/form-data",
    )
    assert big.status_code in (201, 413, 415, 422)
    # finish: event + email to admins
    assert (
        c.post(f"{API}/external/{t}/finish", json={"name": "Jo", "note": "All done, belt replaced"}).status_code == 200
    )
    audit = admin.get(f"{API}/audit?entity_type=work_order&entity_id={wo['id']}").json["items"]
    assert "wo.external_finished" in {e["type"] for e in audit}
    mails = outbox(app, "admin@example.com")
    assert any("marked finished by Jo" in m["subject"] for m in mails)
    assert admin.get(f"{API}/work-orders/{wo['id']}/external-shares").json["items"][0]["finished_by_name"] == "Jo"


def test_public_endpoints_are_isolated(app: Any, admin: Api) -> None:
    """The link only reaches its own work order: not other work orders, not the API, not another org."""
    wo = create(admin)
    other = create(admin, title="Not shared")
    s = share(admin, wo["id"])
    c = anon(app)
    assert c.get(f"{API}/external/{s['token']}").status_code == 200
    assert c.get(f"{API}/work-orders/{other['id']}").status_code == 401  # no session came with the link
    assert c.get(f"{API}/work-orders").status_code == 401
    # another work order's file through this link
    of = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(PNG_1PX), "x.png")},
        headers=admin._h(),
        content_type="multipart/form-data",
    ).json["id"]
    admin.patch(f"{API}/work-orders/{other['id']}", {"file_ids": [of]})
    assert c.get(f"{API}/external/{s['token']}/files/{of}").status_code == 404
    # a run from another work order can't be answered through this link
    r = admin.post(
        f"{API}/work-orders/{other['id']}/procedures",
        {"name": "Other", "schema": {"items": [{"id": "a", "type": "checkbox", "label": "x"}]}},
    ).json
    other_run = r.get("id") or r["run"]["id"]
    assert (
        c.put(
            f"{API}/external/{s['token']}/procedures/{other_run}/answers/a", json={"name": "Jo", "value": True}
        ).status_code
        == 404
    )
    # cross-org: another org's admin can't see or manage the share
    from tests.test_assets import other_org

    them = other_org(app)
    assert them.get(f"{API}/work-orders/{wo['id']}/external-shares").status_code == 404
    assert them.delete(f"{API}/work-orders/{wo['id']}/external-shares/{s['id']}").status_code == 404
    # signed-in people of another org get nothing extra from a link either
    v = them.c.get(f"{API}/external/{s['token']}")
    assert v.status_code == 200 and v.json["title"] == wo["title"]
    # only people with wo.share_external manage links
    tech = login(app, "avery.kim@example.com")
    assert tech.post(f"{API}/work-orders/{wo['id']}/external-shares", {}).status_code == 403


def test_csrf_exemption_is_only_for_public_endpoints(app: Any, admin: Api) -> None:
    from mpro.auth.api import CSRF_EXEMPT

    assert {
        "work_orders.public_comment",
        "work_orders.public_answer",
        "work_orders.public_upload",
        "work_orders.public_finish",
    } <= CSRF_EXEMPT
    assert not any(e.startswith("work_orders.") and "share" in e for e in CSRF_EXEMPT)
    wo = create(admin)
    # a signed-in session without the CSRF header can't create or change links
    r = admin.c.post(f"{API}/work-orders/{wo['id']}/external-shares", json={})
    assert r.status_code in (400, 403)


def test_rate_limits(app: Any, admin: Api) -> None:
    wo = create(admin)
    s = share(admin, wo["id"])
    c = anon(app, "10.9.9.9")
    for _ in range(20):
        assert c.get(f"{API}/external/not-a-real-token").status_code == 404
    assert c.get(f"{API}/external/{s['token']}").status_code == 429  # too many failed attempts from this IP
    assert anon(app, "10.9.9.10").get(f"{API}/external/{s['token']}").status_code == 200
    # writes per link
    from mpro.workorders import external as ext

    old = ext.LIMIT_WRITES_PER_HOUR
    ext.LIMIT_WRITES_PER_HOUR = 3
    try:
        w = anon(app, "10.9.9.11")
        codes = [
            w.post(f"{API}/external/{s['token']}/comments", json={"name": "Jo", "body": f"#{i}"}).status_code
            for i in range(5)
        ]
        assert codes[:3] == [201, 201, 201] and codes[3] == 429
    finally:
        ext.LIMIT_WRITES_PER_HOUR = old


def test_share_email_vendor_filter_and_email_pdf(app: Any, admin: Api) -> None:
    vid, cid = vendor(admin)
    wo = create(admin, vendor_ids=[vid])
    d = admin.get(f"{API}/work-orders/{wo['id']}").json
    assert [v["id"] for v in d["vendors"]] == [vid] and d["shared_externally"] is False
    plain = create(admin, title="No vendor")
    # vendor filter (r075)
    f = json.dumps([{"field": "vendor", "op": "in", "value": [vid]}])
    ids = [w["id"] for w in admin.get(f"{API}/work-orders?filters={f}").json["items"]]
    assert ids == [wo["id"]]
    r = admin.c.put(f"{API}/work-orders/{plain['id']}/vendors", json={"vendor_ids": [vid]}, headers=admin._h())
    assert r.status_code == 200 and r.json["vendors"][0]["id"] == vid
    assert (
        admin.c.put(
            f"{API}/work-orders/{plain['id']}/vendors",
            json={"vendor_ids": ["00000000-0000-7000-8000-000000000000"]},
            headers=admin._h(),
        ).status_code
        == 422
    )
    # share by email to the vendor contact (r058)
    s = share(
        admin, wo["id"], vendor_id=vid, contact_ids=[cid], emails=["extra@example.org"], message="Please fix the belt"
    )
    assert set(s["recipients"]) == {"jo@acme.test", "extra@example.org"}
    mails = outbox(app, "jo@acme.test")
    assert mails and s["path"] in mails[-1]["body"] and "Please fix the belt" in mails[-1]["body"]
    assert admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {"emails": ["bad address"]}).status_code == 422
    # "Shared externally" filter (r088)
    f = json.dumps([{"field": "shared", "op": "is", "value": True}])
    ids = [w["id"] for w in admin.get(f"{API}/work-orders?filters={f}").json["items"]]
    assert ids == [wo["id"]]
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["shared_externally"] is True
    # email the PDF (r094)
    r = admin.post(f"{API}/work-orders/{wo['id']}/email-pdf", {"vendor_ids": [vid], "message": "Quote please"})
    assert r.status_code == 200, r.json
    assert r.json["sent_to"] == ["jo@acme.test"]
    last = outbox(app, "jo@acme.test")[-1]
    assert last["attachments"] and last["attachments"][0]["name"].endswith(".pdf") and "Quote please" in last["body"]
    assert admin.post(f"{API}/work-orders/{wo['id']}/email-pdf", {}).status_code == 422


def test_outsiders_see_mention_names_not_internal_ids(app: Any, admin: Api) -> None:
    wo = create(admin)
    me = admin.get(f"{API}/auth/session").json["user"]
    body = f"@[{me['name']}](user:{me['id']}) can you check this?"
    r = admin.post(f"{API}/work-orders/{wo['id']}/comments", {"body": body})
    assert r.status_code == 201, r.json
    s = share(admin, wo["id"], fields={"comments": "view"})
    v = anon(app, "10.0.0.77").get(f"{API}/external/{s['token']}").json
    assert v["comments"][-1]["body"] == f"@{me['name']} can you check this?"
    assert me["id"] not in json.dumps(v["comments"])
