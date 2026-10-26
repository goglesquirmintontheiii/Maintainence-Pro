"""Messaging (0.6.0, MP-049) and the realtime service (r269)."""

from __future__ import annotations

import http.client
import io
import json
import socket
import threading
import time
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import _png, create, login, team_id, uid

API = "/api/v1"


def conv_with(api: Api, user_id: str) -> dict[str, Any]:
    r = api.post(f"{API}/conversations", {"kind": "direct", "user_id": user_id})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def send(api: Api, cid: str, text: str, **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/conversations/{cid}/messages", {"body": text, **kw})
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


def outbox(app: Any) -> None:
    with app.app_context():
        from mpro.core.events import process_outbox

        process_outbox()


# ---- conversations ---------------------------------------------------------------------------------------
def test_direct_conversation_unread_and_read(app: Any, admin: Api) -> None:
    jordan_id = uid(admin, "jordan.reyes@example.com")
    c = conv_with(admin, jordan_id)
    assert c["kind"] == "direct" and c["title"] == "Jordan Reyes"
    assert conv_with(admin, jordan_id)["id"] == c["id"]  # one per pair
    send(admin, c["id"], "Can we move the review to Thursday?")
    jordan = login(app, "jordan.reyes@example.com")
    lst = jordan.get(f"{API}/conversations").json
    mine = next(i for i in lst["items"] if i["id"] == c["id"])
    assert mine["unread"] == 1 and mine["title"] == "Alex Morgan" and lst["unread_total"] >= 1
    assert jordan.get(f"{API}/messages/unread").json["total"] >= 1
    msgs = jordan.get(f"{API}/conversations/{c['id']}/messages").json["items"]
    assert [m["body"] for m in msgs] == ["Can we move the review to Thursday?"]
    assert jordan.post(f"{API}/conversations/{c['id']}/read").status_code == 204
    mine = next(i for i in jordan.get(f"{API}/conversations").json["items"] if i["id"] == c["id"])
    assert mine["unread"] == 0
    # read receipts: the sender sees when the other person read it
    detail = admin.get(f"{API}/conversations/{c['id']}").json
    jr = next(p for p in detail["members"] if p["id"] == jordan_id)
    assert jr["last_read_at"] is not None
    assert admin.post(f"{API}/conversations", {"kind": "direct", "user_id": detail["members"][0]["id"]}).status_code in (
        201,
        422,
    )


def test_group_members_leave_and_non_members(app: Any, admin: Api) -> None:
    sam, avery, riley = (uid(admin, f"{n}@example.com") for n in ("sam.patel", "avery.kim", "riley.chen"))
    r = admin.post(f"{API}/conversations", {"kind": "group", "name": "Line 2 shutdown", "user_ids": [sam, avery]})
    assert r.status_code == 201, r.json
    g = r.json
    assert g["member_count"] == 3 and g["can"]["leave"]
    send(admin, g["id"], "Kickoff Thursday 10am")
    outsider = login(app, "riley.chen@example.com")
    assert outsider.get(f"{API}/conversations/{g['id']}").status_code == 404
    assert outsider.get(f"{API}/conversations/{g['id']}/messages").status_code == 404
    assert outsider.post(f"{API}/conversations/{g['id']}/messages", {"body": "hi"}).status_code == 404
    assert admin.post(f"{API}/conversations/{g['id']}/members", {"user_ids": [riley]}).status_code == 200
    assert outsider.get(f"{API}/conversations/{g['id']}/messages").status_code == 200
    # Riley can't remove Sam (only the creator can), but can leave
    assert outsider.delete(f"{API}/conversations/{g['id']}/members/{sam}").status_code == 403
    assert outsider.delete(f"{API}/conversations/{g['id']}/members/{riley}").status_code == 204
    assert outsider.get(f"{API}/conversations/{g['id']}").status_code == 404
    assert admin.patch(f"{API}/conversations/{g['id']}", {"name": "Line 2 shutdown crew"}).json["title"] == (
        "Line 2 shutdown crew"
    )
    # direct conversations can't be left
    d = conv_with(admin, sam)
    me = admin.session()["user"]["id"]
    assert admin.delete(f"{API}/conversations/{d['id']}/members/{me}").status_code == 422


def test_team_chats_and_all_team(app: Any, admin: Api) -> None:
    lst = admin.get(f"{API}/conversations").json["items"]
    assert any(i["kind"] == "all" for i in lst)
    mech = team_id(admin, "Mechanical")
    avery = login(app, "avery.kim@example.com")  # Mechanical
    sam = login(app, "sam.patel@example.com")  # Electrical
    tc = avery.post(f"{API}/teams/{mech}/conversation")
    assert tc.status_code == 200 and tc.json["kind"] == "team" and tc.json["title"] == "Mechanical"
    assert sam.post(f"{API}/teams/{mech}/conversation").status_code == 403
    assert sam.get(f"{API}/conversations/{tc.json['id']}").status_code == 404
    assert avery.patch(f"{API}/conversations/{tc.json['id']}", {"name": "x"}).status_code in (403, 422)
    assert avery.delete(f"{API}/conversations/{tc.json['id']}/members/{uid(admin, 'avery.kim@example.com')}").status_code == 422
    # All Team: everyone sees it; only admins can hide it for everyone
    all_id = next(i["id"] for i in avery.get(f"{API}/conversations").json["items"] if i["kind"] == "all")
    assert avery.patch(f"{API}/conversations/{all_id}", {"hidden_for_all": True}).status_code == 403
    assert admin.patch(f"{API}/conversations/{all_id}", {"hidden_for_all": True}).status_code == 200
    assert all(i["kind"] != "all" for i in avery.get(f"{API}/conversations").json["items"])
    assert avery.get(f"{API}/conversations/{all_id}").status_code == 404
    # renaming the team renames its chat (event consumer)
    assert admin.patch(f"{API}/teams/{mech}", {"name": "Mechanical Crew"}).status_code == 200
    outbox(app)
    assert avery.get(f"{API}/conversations/{tc.json['id']}").json["title"] == "Mechanical Crew"


def test_my_settings_mute_pin_hide(admin: Api) -> None:
    c = conv_with(admin, uid(admin, "sam.patel@example.com"))
    r = admin.patch(f"{API}/conversations/{c['id']}/me", {"pinned": True, "notify": "mentions", "mute_hours": 8})
    assert r.status_code == 200, r.json
    assert r.json["me"]["pinned"] and r.json["me"]["muted"] and r.json["me"]["notify"] == "mentions"
    assert admin.get(f"{API}/conversations").json["items"][0]["id"] == c["id"]  # pinned first
    assert admin.patch(f"{API}/conversations/{c['id']}/me", {"notify": "loud"}).status_code == 422
    admin.patch(f"{API}/conversations/{c['id']}/me", {"hidden": True})
    assert all(i["id"] != c["id"] for i in admin.get(f"{API}/conversations").json["items"])


def test_hidden_conversation_comes_back_with_a_new_message(app: Any, admin: Api) -> None:
    c = conv_with(admin, uid(admin, "sam.patel@example.com"))
    admin.patch(f"{API}/conversations/{c['id']}/me", {"hidden": True})
    sam = login(app, "sam.patel@example.com")
    send(sam, c["id"], "Back again")
    assert any(i["id"] == c["id"] for i in admin.get(f"{API}/conversations").json["items"])


# ---- messages ------------------------------------------------------------------------------------------------
def test_threads_edit_delete_reactions_and_permalink(app: Any, admin: Api) -> None:
    jordan_id = uid(admin, "sam.patel@example.com")  # a technician: no moderation rights
    c = conv_with(admin, jordan_id)
    root = send(admin, c["id"], "Who can check the belt?")
    jordan = login(app, "sam.patel@example.com")
    reply = send(jordan, c["id"], "On it", parent_id=root["id"])
    assert reply["parent_id"] == root["id"]
    send(jordan, c["id"], "Done", parent_id=reply["id"])  # a reply to a reply stays in the thread
    top = admin.get(f"{API}/conversations/{c['id']}/messages").json["items"]
    assert len(top) == 1 and top[0]["reply_count"] == 2
    thread = admin.get(f"{API}/conversations/{c['id']}/messages?thread={root['id']}").json["items"]
    assert [m["body"] for m in thread] == ["On it", "Done"]
    th = admin.get(f"{API}/threads").json["items"]
    assert th and th[0]["id"] == root["id"] and th[0]["unread"] == 2
    assert admin.patch(f"{API}/messages/{root['id']}/thread", {"level": "none"}).status_code == 200
    assert admin.get(f"{API}/threads").json["items"] == []
    # edit / delete: own only
    assert jordan.patch(f"{API}/messages/{root['id']}", {"body": "hacked"}).status_code == 403
    e = admin.patch(f"{API}/messages/{root['id']}", {"body": "Who can check the belt on Line 3?"})
    assert e.status_code == 200 and e.json["edited"]
    assert jordan.delete(f"{API}/messages/{root['id']}").status_code == 403
    # reactions toggle
    r1 = jordan.post(f"{API}/messages/{root['id']}/reactions", {"emoji": "👍"}).json
    assert r1["reactions"] == {"👍": [jordan_id]}
    assert jordan.post(f"{API}/messages/{root['id']}/reactions", {"emoji": "👍"}).json["reactions"] == {}
    assert jordan.post(f"{API}/messages/{root['id']}/reactions", {"emoji": "<script>"}).status_code == 422
    # permalink
    p = jordan.get(f"{API}/messages/{reply['id']}").json
    assert p["link"] == f"/messages/{c['id']}?m={reply['id']}"
    around = jordan.get(f"{API}/conversations/{c['id']}/messages?around={reply['id']}").json["items"]
    assert any(m["id"] == root["id"] for m in around)
    assert admin.delete(f"{API}/messages/{root['id']}").status_code == 204
    gone = admin.get(f"{API}/messages/{root['id']}").json
    assert gone["deleted"] and gone["body"] == ""
    assert admin.post(f"{API}/conversations/{c['id']}/messages", {"body": ""}).status_code == 422
    assert admin.post(f"{API}/conversations/{c['id']}/messages", {"body": "x" * 10001}).status_code == 422


def test_files_on_messages(app: Any, admin: Api) -> None:
    sam_id = uid(admin, "sam.patel@example.com")
    c = conv_with(admin, sam_id)
    up = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(_png()), "panel.png")},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    )
    assert up.status_code == 201, up.json
    msg = send(admin, c["id"], "Panel photo", file_ids=[up.json["id"]])
    assert msg["files"][0]["name"] == "panel.png"
    sam = login(app, "sam.patel@example.com")
    assert sam.get(msg["files"][0]["url"]).status_code == 200
    riley = login(app, "riley.chen@example.com")
    assert riley.get(msg["files"][0]["url"]).status_code in (403, 404)
    # someone else's upload can't be attached
    assert sam.post(f"{API}/conversations/{c['id']}/messages", {"body": "x", "file_ids": [up.json["id"]]}).status_code == 422


def test_announcements_and_acknowledgements(app: Any, admin: Api) -> None:
    all_id = next(i["id"] for i in admin.get(f"{API}/conversations").json["items"] if i["kind"] == "all")
    avery = login(app, "avery.kim@example.com")
    assert avery.post(f"{API}/conversations/{all_id}/messages", {"body": "x", "announcement": True}).status_code == 403
    a = send(admin, all_id, "North dock closed Thursday. Please confirm.", announcement=True)
    assert a["requires_ack"] and a["kind"] == "announcement"
    r = avery.post(f"{API}/messages/{a['id']}/ack")
    assert r.status_code == 200 and r.json["acknowledged"] and r.json["ack_count"] == 1
    assert avery.post(f"{API}/messages/{a['id']}/ack").json["ack_count"] == 1  # once per person
    assert avery.get(f"{API}/messages/{a['id']}/acks").status_code == 403
    rep = admin.get(f"{API}/messages/{a['id']}/acks").json
    assert rep["acknowledged"] == 1 and rep["total"] >= 10
    assert any(p["name"] == "Avery Kim" and p["acknowledged_at"] for p in rep["people"])
    plain = send(admin, all_id, "No need to confirm")
    assert avery.post(f"{API}/messages/{plain['id']}/ack").status_code == 422


def test_search_ranks_results(app: Any, admin: Api) -> None:
    c = conv_with(admin, uid(admin, "sam.patel@example.com"))
    send(admin, c["id"], "The belt on conveyor 3 is slipping")
    send(admin, c["id"], "Lunch is at noon")
    send(admin, c["id"], "conveyor belt conveyor belt replaced, conveyor belt tension set")
    r = admin.get(f"{API}/messages/search?q=conveyor belt").json
    bodies = [m["body"] for m in r["messages"]]
    assert len(bodies) == 2 and bodies[0].startswith("conveyor belt conveyor belt")
    assert admin.get(f"{API}/messages/search?q=a").json == {"conversations": [], "messages": []}
    riley = login(app, "riley.chen@example.com")
    assert riley.get(f"{API}/messages/search?q=conveyor").json["messages"] == []


# ---- work orders --------------------------------------------------------------------------------------------
def test_work_order_thread_and_create_wo_from_message(app: Any, admin: Api) -> None:
    avery_id = uid(admin, "avery.kim@example.com")
    wo = create(admin, title="Hidden from Avery")
    t = admin.post(f"{API}/work-orders/{wo['id']}/conversation")
    assert t.status_code == 200 and t.json["kind"] == "work_order" and t.json["work_order_id"] == wo["id"]
    assert admin.post(f"{API}/work-orders/{wo['id']}/conversation").json["id"] == t.json["id"]
    send(admin, t.json["id"], "Parts are on order")
    assert admin.patch(f"{API}/users/{avery_id}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    avery = login(app, "avery.kim@example.com")
    assert avery.post(f"{API}/work-orders/{wo['id']}/conversation").status_code == 404
    assert avery.get(f"{API}/conversations/{t.json['id']}/messages").status_code == 404
    # create a work order from a message (r080)
    c = conv_with(admin, uid(admin, "sam.patel@example.com"))
    msg = send(admin, c["id"], f"@[Sam Patel](user:{uid(admin, 'sam.patel@example.com')}) Panel 4 breaker trips\nWhen the press starts")
    r = admin.post(f"{API}/messages/{msg['id']}/work-order")
    assert r.status_code == 201, r.json
    new = admin.get(f"{API}/work-orders/{r.json['id']}").json
    assert new["title"] == "@Sam Patel Panel 4 breaker trips" and "When the press starts" in new["description"]
    last = admin.get(f"{API}/conversations/{c['id']}/messages").json["items"][-1]
    assert last["kind"] == "work_order" and last["data"]["number"] == r.json["number"]
    requester = login(app, "jamie.ortiz@example.com")
    rc = conv_with(requester, uid(admin, "admin@example.com"))
    rm = send(requester, rc["id"], "Leak by Line 2")
    assert requester.post(f"{API}/messages/{rm['id']}/work-order").status_code == 403


def test_assigning_a_work_order_to_a_team_posts_in_the_team_chat(app: Any, admin: Api) -> None:
    mech = team_id(admin, "Mechanical")
    avery = login(app, "avery.kim@example.com")
    tc = avery.post(f"{API}/teams/{mech}/conversation").json
    wo = create(admin, title="Grease conveyor bearings", assignees=[{"type": "team", "id": mech}])
    outbox(app)
    msgs = avery.get(f"{API}/conversations/{tc['id']}/messages").json["items"]
    link = [m for m in msgs if m["kind"] == "work_order"]
    assert link and link[-1]["data"]["work_order_id"] == wo["id"] and "Mechanical" in link[-1]["body"]


def test_notification_targets(app: Any, admin: Api) -> None:
    sam_id, avery_id = uid(admin, "sam.patel@example.com"), uid(admin, "avery.kim@example.com")
    g = admin.post(f"{API}/conversations", {"kind": "group", "name": "Crew", "user_ids": [sam_id, avery_id]}).json
    sam = login(app, "sam.patel@example.com")
    sam.patch(f"{API}/conversations/{g['id']}/me", {"mute_hours": 4})
    plain = send(admin, g["id"], "Morning all")
    mention = send(admin, g["id"], f"@[Sam Patel](user:{sam_id}) can you check panel 4?")
    with app.app_context():
        from mpro.messaging.services import notification_targets

        t1 = {str(t["user_id"]): t["reason"] for t in notification_targets(plain["id"])}
        t2 = {str(t["user_id"]): t["reason"] for t in notification_targets(mention["id"])}
    assert t1 == {avery_id: "message"}  # muted Sam left out; the author is never notified
    assert t2[sam_id] == "mention" and t2[avery_id] == "message"


def test_other_org_cannot_reach_anything(app: Any, admin: Api) -> None:
    c = conv_with(admin, uid(admin, "sam.patel@example.com"))
    m = send(admin, c["id"], "Private")
    mech = team_id(admin, "Mechanical")
    other = other_org(app)
    assert other.get(f"{API}/conversations/{c['id']}").status_code == 404
    assert other.get(f"{API}/conversations/{c['id']}/messages").status_code == 404
    assert other.post(f"{API}/conversations/{c['id']}/messages", {"body": "x"}).status_code == 404
    assert other.get(f"{API}/messages/{m['id']}").status_code == 404
    assert other.patch(f"{API}/messages/{m['id']}", {"body": "x"}).status_code == 404
    assert other.post(f"{API}/messages/{m['id']}/reactions", {"emoji": "👍"}).status_code == 404
    assert other.post(f"{API}/teams/{mech}/conversation").status_code == 404
    assert other.post(f"{API}/conversations", {"kind": "direct", "user_id": uid(admin, "sam.patel@example.com")}).status_code == 422
    assert other.get(f"{API}/messages/search?q=Private").json["messages"] == []
    assert all(i["id"] != c["id"] for i in other.get(f"{API}/conversations").json["items"])
    wo = create(admin)
    assert other.post(f"{API}/work-orders/{wo['id']}/conversation").status_code == 404


def test_viewers_cannot_message(app: Any, admin: Api) -> None:
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/conversations").status_code == 403
    assert admin.get(f"{API}/realtime/poll").status_code == 200
    assert Api(app.test_client()).get(f"{API}/realtime/poll").status_code == 401


# ---- realtime -------------------------------------------------------------------------------------------------
def _poll(api: Api, since: str) -> list[dict[str, Any]]:
    r = api.get(f"{API}/realtime/poll?since={since}")
    assert r.status_code == 200
    return r.json["items"]  # type: ignore[no-any-return]


def test_realtime_poll_delivers_only_what_people_may_see(app: Any, admin: Api) -> None:
    since = admin.get(f"{API}/realtime/poll").json["cursor"]
    sam_id = uid(admin, "sam.patel@example.com")
    c = conv_with(admin, sam_id)
    send(admin, c["id"], "hello")
    wo = create(admin, title="Limited test")
    sam = login(app, "sam.patel@example.com")
    riley = login(app, "riley.chen@example.com")
    got = {(e["topic"], e["type"]) for e in _poll(sam, since)}
    assert (f"conv:{c['id']}", "message.created") in got and (f"wo:{wo['id']}", "wo.created") in got
    rgot = {(e["topic"], e["type"]) for e in _poll(riley, since)}
    assert all(not t.startswith(f"conv:{c['id']}") for t, _ in rgot)
    assert (f"wo:{wo['id']}", "wo.created") in rgot
    # limited visibility: Riley stops getting that work order's topic
    assert admin.patch(f"{API}/users/{uid(admin, 'riley.chen@example.com')}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    assert all(t != f"wo:{wo['id']}" for t, _ in {(e["topic"], e["type"]) for e in _poll(riley, since)})
    # another organization sees nothing of ours
    other = other_org(app)
    assert _poll(other, since) == []
    # payloads carry ids and types only
    ev = next(e for e in _poll(sam, since) if e["topic"] == f"conv:{c['id']}")
    assert "hello" not in json.dumps(ev)


def test_realtime_authorization_rules(app: Any, admin: Api) -> None:
    sam_id = uid(admin, "sam.patel@example.com")
    with app.app_context():
        import uuid

        from mpro.core import realtime
        from mpro.messaging.services import membership_of
        from mpro.orgs.models import Organization

        org = Organization.query.filter_by(slug="acme-demo").one()
        sam = membership_of(org.id, uuid.UUID(sam_id))
        assert sam is not None
        row = {"org_id": org.id, "topic": f"user:{sam_id}", "user_ids": None}
        assert realtime.may_receive(sam, row)
        assert not realtime.may_receive(sam, {**row, "topic": f"user:{uuid.uuid4()}"})
        assert not realtime.may_receive(sam, {**row, "org_id": uuid.uuid4()})
        assert not realtime.may_receive(sam, {**row, "topic": "secret:thing"})  # unknown topics are denied
        assert realtime.may_receive(sam, {**row, "topic": "secret:thing", "user_ids": [sam_id]})
        assert not realtime.may_receive(sam, {**row, "topic": "org", "user_ids": [str(uuid.uuid4())]})
        assert not realtime.may_receive(None, row)


def test_realtime_stream_flushes_under_waitress(app: Any, admin: Api) -> None:
    """A real server: open the SSE stream, send a message from another session, see it arrive within seconds."""
    from waitress.server import create_server

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = create_server(app, host="127.0.0.1", port=port, threads=4)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    try:
        sam_id = uid(admin, "sam.patel@example.com")
        c = conv_with(admin, sam_id)
        # sign Sam in over HTTP to get a real session cookie
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request(
            "POST",
            f"{API}/auth/login",
            body=json.dumps({"email": "sam.patel@example.com", "password": "mpro-demo-123"}),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 200
        cookie = "; ".join(h.split(";")[0] for k, h in resp.getheaders() if k.lower() == "set-cookie")
        resp.read()
        conn.close()
        stream = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        stream.request("GET", f"{API}/realtime/stream", headers={"Cookie": cookie, "Accept": "text/event-stream"})
        sresp = stream.getresponse()
        assert sresp.status == 200 and sresp.getheader("Content-Type", "").startswith("text/event-stream")
        buf = b""
        t0 = time.monotonic()
        while b"event: hello" not in buf and time.monotonic() - t0 < 5:
            buf += sresp.read1(4096)
        assert b"event: hello" in buf
        sent_at = time.monotonic()
        send(admin, c["id"], "live!")
        want = f'"topic":"conv:{c["id"]}"'.encode()
        while want not in buf and time.monotonic() - t0 < 10:
            buf += sresp.read1(4096)
        assert want in buf, buf[-500:]
        assert time.monotonic() - sent_at < 5
        stream.close()
    finally:
        server.close()


def test_stream_budget_falls_back_to_polling(app: Any, admin: Api) -> None:
    app.config["MPRO_REALTIME_MAX_STREAMS"] = 0
    r = admin.get(f"{API}/realtime/stream")
    assert r.status_code == 429 and r.json["mode"] == "poll"
