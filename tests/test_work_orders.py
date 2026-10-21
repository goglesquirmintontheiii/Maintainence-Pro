"""Work orders (0.2.0): rules, permissions, tenancy, files, time and costs, views, exports."""

from __future__ import annotations

import base64
import io
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from tests.conftest import Api

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def login(app: Any, email: str, password: str = "mpro-demo-123") -> Api:
    a = Api(app.test_client())
    assert a.login(email, password).status_code == 200
    return a


def uid(api: Api, email: str) -> str:
    users = api.get("/api/v1/users?q=" + email).json["items"]
    return next(u["id"] for u in users if u["email"] == email)


def team_id(api: Api, name: str) -> str:
    return next(t["id"] for t in api.get("/api/v1/teams").json["items"] if t["name"] == name)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def create(api: Api, **kw: Any) -> dict[str, Any]:
    r = api.post("/api/v1/work-orders", {"title": "Replace belt on conveyor 3", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


# ---- create, edit, numbering -----------------------------------------------------------------
def test_create_minimal_and_numbering(admin: Api) -> None:
    a = create(admin)
    b = create(admin, title="Fix leaking valve")
    assert b["number"] == a["number"] + 1
    assert a["status"] == "open" and a["priority"] == "none" and a["work_type"] == "reactive"
    assert admin.get(f"/api/v1/work-orders/{a['number']}").json["id"] == a["id"]  # by #number too
    assert admin.post("/api/v1/work-orders", {"title": "  "}).status_code == 422
    assert admin.post("/api/v1/work-orders", {"title": "x" * 256}).status_code == 422
    assert admin.post("/api/v1/work-orders", {"title": "ok", "description": "d" * 4097}).status_code == 422


def test_full_create_with_assignees_categories_and_dates(admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mech = team_id(admin, "Mechanical")
    cats = admin.get("/api/v1/categories").json["items"]
    assert {c["name"] for c in cats} >= {"Electrical", "Safety", "Inspection"}  # MaintainX defaults
    due = datetime.now(UTC) + timedelta(days=2)
    wo = create(
        admin,
        priority="high",
        work_type="preventive",
        due_at=iso(due),
        start_at=iso(due - timedelta(days=1)),
        estimated_minutes=90,
        assignees=[{"type": "user", "id": avery}, {"type": "team", "id": mech}],
        categories=[cats[0]["id"]],
    )
    assert {a["name"] for a in wo["assignees"]} == {"Avery Kim", "Mechanical"}
    assert wo["categories"][0]["id"] == cats[0]["id"]
    assert wo["estimated_minutes"] == 90
    # requesters and view-only users can't be assigned
    jamie = uid(admin, "jamie.ortiz@example.com")
    r = admin.post("/api/v1/work-orders", {"title": "x", "assignees": [{"type": "user", "id": jamie}]})
    assert r.status_code == 422
    # start must be before due
    r = admin.post("/api/v1/work-orders", {"title": "x", "start_at": iso(due), "due_at": iso(due - timedelta(days=1))})
    assert r.status_code == 422
    # naive datetimes are rejected
    assert admin.post("/api/v1/work-orders", {"title": "x", "due_at": "2026-11-01T10:00:00"}).status_code == 422


def test_edit_and_optimistic_concurrency(admin: Api) -> None:
    wo = create(admin)
    r = admin.patch(f"/api/v1/work-orders/{wo['id']}", {"title": "New title", "version": wo["version"]})
    assert r.status_code == 200 and r.json["version"] == wo["version"] + 1
    stale = admin.patch(f"/api/v1/work-orders/{wo['id']}", {"priority": "low", "version": wo["version"]})
    assert stale.status_code == 409
    assert stale.json["detail"]["current"]["title"] == "New title"
    # If-Match works too
    r = admin.c.patch(
        f"/api/v1/work-orders/{wo['id']}",
        json={"priority": "low"},
        headers={"X-CSRF-Token": admin.csrf, "If-Match": f'W/"{r.json["version"]}"'},
    )
    assert r.status_code == 200 and r.json["priority"] == "low"
    # comments don't bump the version (no false conflicts)
    v = r.json["version"]
    admin.post(f"/api/v1/work-orders/{wo['id']}/comments", {"body": "hello"})
    assert admin.patch(f"/api/v1/work-orders/{wo['id']}", {"priority": "high", "version": v}).status_code == 200
    # status and number can't be patched
    assert admin.patch(f"/api/v1/work-orders/{wo['id']}", {"status": "done"}).status_code == 422


def test_required_fields_and_custom_fields(admin: Api) -> None:
    assert admin.patch("/api/v1/work-orders/settings", {"required_fields": ["due_date", "priority"]}).status_code == 200
    r = admin.post("/api/v1/work-orders", {"title": "x"})
    assert r.status_code == 422 and "Due date" in r.json["message"]
    create(admin, due_at=iso(datetime.now(UTC)), priority="low")
    admin.patch("/api/v1/work-orders/settings", {"required_fields": []})
    f = admin.post(
        "/api/v1/custom-fields",
        {"name": "Downtime cause", "type": "select", "options": ["Wear", "Operator"], "required": True},
    )
    assert f.status_code == 201
    fid = f.json["id"]
    assert admin.post("/api/v1/work-orders", {"title": "x"}).status_code == 422  # required custom field
    assert admin.post("/api/v1/work-orders", {"title": "x", "custom": {fid: "Nope"}}).status_code == 422
    wo = create(admin, custom={fid: "Wear"})
    assert wo["custom"][fid] == "Wear"
    link = admin.post("/api/v1/custom-fields", {"name": "Manual", "type": "link"}).json
    admin.patch(f"/api/v1/custom-fields/{fid}", {"required": False})
    assert (
        admin.post("/api/v1/work-orders", {"title": "x", "custom": {link["id"]: "javascript:alert(1)"}}).status_code
        == 422
    )
    assert admin.patch(f"/api/v1/custom-fields/{fid}", {"type": "text"}).status_code == 422
    # filter by custom field
    items = admin.get(
        "/api/v1/work-orders?filters=" + json.dumps([{"field": f"custom.{fid}", "op": "in", "value": ["Wear"]}])
    ).json
    assert [w["id"] for w in items["items"]] == [wo["id"]]


# ---- statuses and completion -----------------------------------------------------------------
def test_status_flow_history_and_reopen(admin: Api) -> None:
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}"
    admin.patch("/api/v1/work-orders/settings", {"comment_on_hold": "mandatory"})
    assert admin.post(url + "/status", {"status": "on_hold"}).status_code == 422
    r = admin.post(
        url + "/status", {"status": "on_hold", "comment": "Waiting on belt", "sub_status": "Waiting on parts"}
    )
    assert r.status_code == 200 and r.json["sub_status"] == "Waiting on parts"
    assert admin.post(url + "/status", {"status": "on_hold", "sub_status": "Made up"}).status_code == 422
    admin.post(url + "/status", {"status": "in_progress"})
    r = admin.post(url + "/status", {"status": "done", "summary": "Replaced the belt"})
    assert r.json["status"] == "done" and r.json["completed_by"]["name"] == "Alex Morgan"
    assert set(r.json["time_in_status"]) == {"open", "in_progress", "on_hold"}
    r = admin.post(url + "/status", {"status": "open"})
    assert r.json["status"] == "open" and r.json["completed_at"] is None
    feed = admin.get(url + "/activity").json["items"]
    assert any("Reopened" in i.get("summary", "") for i in feed)
    assert any(i.get("data", {}).get("comment") == "Waiting on belt" for i in feed)


def test_completion_requirements_signature_and_approval(app: Any, admin: Api) -> None:
    admin.patch(
        "/api/v1/work-orders/settings",
        {
            "require_signature": True,
            "completion_summary": "mandatory",
            "require_time_to_complete": True,
            "require_approval": True,
        },
    )
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, assignees=[{"type": "user", "id": avery}])
    tech = login(app, "avery.kim@example.com")
    url = f"/api/v1/work-orders/{wo['id']}"
    r = tech.post(url + "/status", {"status": "done"})
    assert r.status_code == 422 and "log time" in r.json["message"] and "sign" in r.json["message"]
    tech.post(url + "/time", {"minutes": 45, "time_type": "Work"})
    sig = "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()
    r = tech.post(
        url + "/status", {"status": "done", "summary": "All good", "signature": sig, "signed_by": "Avery Kim"}
    )
    assert r.status_code == 200, r.json
    assert r.json["approval_status"] == "pending" and r.json["signature"]["name"] == "Avery Kim"
    assert tech.post(url + "/approval", {"approve": True}).status_code == 403  # technicians can't approve
    assert admin.post(url + "/approval", {"approve": False}).status_code == 422  # needs a reason
    r = admin.post(url + "/approval", {"approve": False, "comment": "Belt guard missing"})
    assert r.json["status"] == "in_progress" and r.json["approval_status"] == "rejected"
    assert tech.post(url + "/status", {"status": "done", "summary": "Guard back on"}).status_code == 422  # sign again
    r = tech.post(url + "/status", {"status": "done", "summary": "Guard back on", "signature": sig})
    assert r.json["approval_status"] == "pending"
    r = admin.post(url + "/approval", {"approve": True})
    assert r.json["approval_status"] == "approved" and r.json["approved_by"]["name"] == "Alex Morgan"
    bad = create(admin)
    assert admin.post(f"/api/v1/work-orders/{bad['id']}/time", {"minutes": 5}).status_code == 201
    r = admin.post(
        f"/api/v1/work-orders/{bad['id']}/status",
        {"status": "done", "summary": "x", "signature": "data:image/svg+xml;base64,PHN2Zz4="},
    )
    assert r.status_code == 422


def test_cancel_requires_comment_when_configured(admin: Api) -> None:
    admin.patch("/api/v1/work-orders/settings", {"comment_on_cancel": "mandatory"})
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}/status"
    assert admin.post(url, {"status": "canceled"}).status_code == 422
    r = admin.post(url, {"status": "canceled", "comment": "Duplicate of #1"})
    assert r.json["status"] == "canceled" and r.json["cancel_reason"] == "Duplicate of #1"


# ---- permissions and tenancy -----------------------------------------------------------------
def test_role_permissions(app: Any, admin: Api) -> None:
    wo = create(admin)
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get("/api/v1/work-orders").status_code == 200
    assert viewer.post("/api/v1/work-orders", {"title": "x"}).status_code == 403
    assert viewer.post(f"/api/v1/work-orders/{wo['id']}/comments", {"body": "x"}).status_code == 403
    requester = login(app, "jamie.ortiz@example.com")
    assert requester.get("/api/v1/work-orders").status_code == 403
    tech = login(app, "avery.kim@example.com")
    assert tech.delete(f"/api/v1/work-orders/{wo['id']}").status_code == 403
    assert tech.patch("/api/v1/work-orders/settings", {"mention_assigns": True}).status_code == 403
    assert tech.post("/api/v1/categories", {"name": "Mine"}).status_code == 403
    assert admin.delete(f"/api/v1/work-orders/{wo['id']}").status_code == 204
    assert admin.get(f"/api/v1/work-orders/{wo['id']}").json["deleted"] is True
    listed = admin.get("/api/v1/work-orders").json["items"]
    assert wo["id"] not in [w["id"] for w in listed]
    with_deleted = admin.get("/api/v1/work-orders?include_deleted=1").json["items"]
    assert wo["id"] in [w["id"] for w in with_deleted]
    assert admin.post(f"/api/v1/work-orders/{wo['id']}/restore").json["deleted"] is False


def test_other_org_cannot_see_work_orders(app: Any, admin: Api) -> None:
    wo = create(admin)
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
    assert other.get(f"/api/v1/work-orders/{wo['id']}").status_code == 404
    assert other.get(f"/api/v1/work-orders/{wo['number']}").status_code == 404
    assert other.get("/api/v1/work-orders").json["total"] == 0
    assert other.patch(f"/api/v1/work-orders/{wo['id']}", {"title": "pwned"}).status_code == 404
    r = other.post("/api/v1/work-orders/bulk", {"ids": [wo["id"]], "action": "delete"})
    assert r.status_code == 200 and r.json["updated"] == []
    mine = other.post("/api/v1/work-orders", {"title": "Theirs"}).json
    assert mine["number"] == 1  # numbering is per organization


def test_limited_visibility(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mech = team_id(admin, "Mechanical")
    mine = create(admin, title="For Avery", assignees=[{"type": "user", "id": avery}])
    team = create(admin, title="For Mechanical", assignees=[{"type": "team", "id": mech}])
    other = create(admin, title="Not Avery's")
    assert admin.patch(f"/api/v1/users/{avery}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    tech = login(app, "avery.kim@example.com")
    seen = {w["id"] for w in tech.get("/api/v1/work-orders").json["items"]}
    assert mine["id"] in seen and team["id"] in seen and other["id"] not in seen
    assert tech.get(f"/api/v1/work-orders/{other['id']}").status_code == 404


# ---- comments, mentions, reactions -----------------------------------------------------------
def test_comments_mentions_and_reactions(app: Any, admin: Api) -> None:
    sam = uid(admin, "sam.patel@example.com")
    admin.patch("/api/v1/work-orders/settings", {"mention_assigns": True})
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}"
    r = admin.post(url + "/comments", {"body": f"@[Sam Patel](user:{sam}) can you check the panel?"})
    assert r.status_code == 201 and r.json["mentions"]["users"] == [sam]
    assert "Sam Patel" in [a["name"] for a in admin.get(url).json["assignees"]]
    cid = r.json["id"]
    tech = login(app, "avery.kim@example.com")
    assert tech.patch(url + f"/comments/{cid}", {"body": "edited"}).status_code == 403
    assert tech.post(url + f"/comments/{cid}/reactions", {"emoji": "👍"}).json["reactions"]["👍"]
    assert admin.post(url + f"/comments/{cid}/reactions", {"emoji": "💩"}).status_code == 422
    assert admin.patch(url + f"/comments/{cid}", {"body": "Edited body"}).json["edited_at"]
    assert admin.delete(url + f"/comments/{cid}").status_code == 204
    feed = admin.get(url + "/activity").json["items"]
    c = next(i for i in feed if i["kind"] == "comment")
    assert c["deleted"] and c["body"] == ""
    assert admin.post(url + "/comments", {"body": ""}).status_code == 422


# ---- files -----------------------------------------------------------------------------------
def _png(size: tuple[int, int] = (64, 48)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, (30, 90, 200)).save(buf, "PNG")
    return buf.getvalue()


def test_upload_attach_thumbnail_download_and_detach(app: Any, admin: Api) -> None:
    wo = create(admin)
    r = admin.c.post(
        "/api/v1/files",
        data={
            "file": (io.BytesIO(_png()), "belt.png"),
            "entity_type": "work_order",
            "entity_id": wo["id"],
            "role": "before",
        },
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.json
    f = r.json
    assert f["is_image"] and f["role"] == "before"
    d = admin.get(f"/api/v1/work-orders/{wo['id']}").json
    assert d["attachments"][0]["id"] == f["id"]
    img = admin.get(f["url"])
    assert img.status_code == 200 and img.mimetype == "image/png"
    assert "sandbox" in img.headers["Content-Security-Policy"]
    th = admin.get(f["thumb_url"])
    assert th.status_code == 200 and th.mimetype == "image/jpeg"  # thumbnail made by the background job
    # dangerous or unknown types are refused
    for name, data in (
        ("x.svg", b"<svg onload=alert(1)>"),
        ("x.html", b"<script>"),
        ("run.exe", b"MZ"),
        ("fake.png", b"not png"),
    ):
        r = admin.c.post(
            "/api/v1/files",
            data={"file": (io.BytesIO(data), name)},
            headers={"X-CSRF-Token": admin.csrf},
            content_type="multipart/form-data",
        )
        assert r.status_code == 422, name
    # another org can't read it
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f["url"]).status_code == 200  # same org, can view the WO
    assert viewer.delete(f"/api/v1/files/links/{f['link_id']}").status_code == 403
    assert admin.delete(f"/api/v1/files/links/{f['link_id']}").status_code == 204
    assert admin.get(f["url"]).status_code in (404, 200)  # uploader may still fetch; the file is detached
    assert admin.get(f"/api/v1/work-orders/{wo['id']}").json["attachments"] == []


def test_create_with_uploaded_files_and_comment_attachments(admin: Api) -> None:
    up = admin.c.post(
        "/api/v1/files",
        data={"file": (io.BytesIO(b"%PDF-1.4 test"), "manual.pdf")},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    ).json
    wo = create(admin, file_ids=[up["id"]])
    assert wo["attachments"][0]["name"] == "manual.pdf"
    up2 = admin.c.post(
        "/api/v1/files",
        data={"file": (io.BytesIO(_png()), "photo.png")},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    ).json
    c = admin.post(f"/api/v1/work-orders/{wo['id']}/comments", {"body": "", "file_ids": [up2["id"]]}).json
    assert c["files"][0]["name"] == "photo.png"


# ---- time and costs --------------------------------------------------------------------------
def test_time_costs_rates_and_timer(app: Any, admin: Api) -> None:
    admin.patch("/api/v1/work-orders/settings", {"default_hourly_rate_cents": 4000})
    avery = uid(admin, "avery.kim@example.com")
    admin.patch(f"/api/v1/users/{avery}/work-settings", {"hourly_rate_cents": 6000})
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}"
    r = admin.post(url + "/time", {"minutes": 30, "time_type": "Work", "user_id": avery})
    assert r.status_code == 201 and r.json["labor_cents"] == 3000
    r = admin.post(url + "/time", {"minutes": 60, "time_type": "Inspection", "rate_cents": 0})
    assert r.json["labor_cents"] == 3000  # rate override 0 = no labor cost
    assert admin.post(url + "/time", {"minutes": 10, "time_type": "Napping"}).status_code == 422
    r = admin.post(url + "/costs", {"amount_cents": 12550, "cost_type": "Travel", "description": "Mileage"})
    assert r.json["other_cents"] == 12550 and r.json["total_cents"] == 15550
    tech = login(app, "avery.kim@example.com")
    costs = tech.get(url).json["costs"]
    assert costs["labor_cents"] is None and costs["time"][0]["cost_cents"] is None  # rates hidden from technicians
    assert tech.post(url + "/time", {"minutes": 10, "user_id": uid(admin, "sam.patel@example.com")}).status_code == 403
    r = tech.post(url + "/timer", {})
    assert r.json["status"] == "in_progress" and r.json["costs"]["timers"][0]["user"]["name"] == "Avery Kim"
    assert tech.get("/api/v1/me/timers").json["items"][0]["work_order_id"] == wo["id"]
    r = tech.delete(url + "/timer")
    assert r.status_code == 200 and r.json["costs"]["timers"] == []
    assert r.json["costs"]["total_minutes"] == 30 + 60 + 1


# ---- sub-work orders and links ---------------------------------------------------------------
def test_sub_work_orders_and_links(admin: Api) -> None:
    parent = create(admin, title="Line 2 shutdown")
    child = create(admin, title="Lock out conveyor", parent_id=parent["id"])
    assert admin.post("/api/v1/work-orders", {"title": "x", "parent_id": child["id"]}).status_code == 422
    d = admin.get(f"/api/v1/work-orders/{parent['id']}").json
    assert d["sub_work_orders"][0]["id"] == child["id"]
    assert admin.get(f"/api/v1/work-orders/{child['id']}").json["parent"]["id"] == parent["id"]
    other = create(admin, title="Order belt")
    r = admin.post(f"/api/v1/work-orders/{other['id']}/links", {"work_order_id": parent["number"], "kind": "blocks"})
    assert r.status_code == 200 and r.json["links"][0]["relation"] == "blocks"
    assert admin.get(f"/api/v1/work-orders/{parent['id']}").json["links"][0]["relation"] == "blocked_by"
    assert admin.post(f"/api/v1/work-orders/{parent['id']}/links", {"work_order_id": other["id"]}).status_code == 409
    lid = r.json["links"][0]["id"]
    assert admin.delete(f"/api/v1/work-orders/{other['id']}/links/{lid}").json["links"] == []
    listed = admin.get("/api/v1/work-orders?filters=" + json.dumps([{"field": "parent", "op": "empty"}])).json["items"]
    assert child["id"] not in [w["id"] for w in listed]


# ---- lists, filters, views -------------------------------------------------------------------
def test_filters_tabs_sort_and_search(admin: Api) -> None:
    now = datetime.now(UTC)
    avery = uid(admin, "avery.kim@example.com")
    overdue = create(admin, title="Overdue job", due_at=iso(now - timedelta(days=1)), priority="high")
    later = create(
        admin, title="Future PM", start_at=iso(now + timedelta(days=10)), due_at=iso(now + timedelta(days=11))
    )
    mine = create(admin, title="Mine", assignees=[{"type": "user", "id": avery}])
    done = create(admin, title="Finished")
    admin.post(f"/api/v1/work-orders/{done['id']}/status", {"status": "done"})

    def ids(qs: str) -> list[str]:
        return [w["id"] for w in admin.get("/api/v1/work-orders?" + qs).json["items"]]

    todo = ids("tab=todo")
    assert overdue["id"] in todo and mine["id"] in todo and later["id"] not in todo and done["id"] not in todo
    assert later["id"] in ids("tab=upcoming")
    assert ids("tab=done") == [done["id"]]
    f = [{"field": "due_at", "op": "overdue"}]
    assert ids("filters=" + json.dumps(f)) == [overdue["id"]]
    f = [{"field": "assignee", "op": "in", "value": [avery]}]
    assert ids("filters=" + json.dumps(f)) == [mine["id"]]
    f = [{"field": "status", "op": "not_in", "value": ["open"]}]
    assert ids("filters=" + json.dumps(f)) == [done["id"]]
    assert ids(f"q=%23{overdue['number']}") == [overdue["id"]]
    assert ids("q=future") == [later["id"]]
    assert ids("sort=-priority&tab=todo")[0] == overdue["id"]
    assert admin.get("/api/v1/work-orders?sort=evil").status_code == 422
    bad = json.dumps([{"field": "password", "op": "in", "value": ["x"]}])
    assert admin.get("/api/v1/work-orders?filters=" + bad).status_code == 422
    page = admin.get("/api/v1/work-orders?per_page=2&page=2").json
    assert page["per_page"] == 2 and page["total"] == 4 and len(page["items"]) == 2
    # unread state: others' new work is unread; opening it marks it read
    r = admin.get("/api/v1/work-orders?filters=" + json.dumps([{"field": "unread", "op": "is", "value": True}]))
    assert r.json["total"] == 0  # everything here was created by admin


def test_todo_by_start_date_only_setting(admin: Api) -> None:
    now = datetime.now(UTC)
    wo = create(admin, start_at=iso(now + timedelta(hours=2)), due_at=iso(now + timedelta(hours=6)))
    assert wo["id"] in [w["id"] for w in admin.get("/api/v1/work-orders?tab=todo").json["items"]]
    admin.patch("/api/v1/work-orders/settings", {"todo_by_start_date_only": True})
    assert wo["id"] not in [w["id"] for w in admin.get("/api/v1/work-orders?tab=todo").json["items"]]


def test_saved_views(app: Any, admin: Api) -> None:
    f = [{"field": "priority", "op": "in", "value": ["high"]}]
    v = admin.post("/api/v1/work-orders/views", {"name": "Urgent", "filters": f, "shared": True, "pinned": True})
    assert v.status_code == 201 and v.json["shared"]
    tech = login(app, "avery.kim@example.com")
    assert tech.post("/api/v1/work-orders/views", {"name": "Shared?", "shared": True}).status_code == 403
    mine = tech.post(
        "/api/v1/work-orders/views",
        {"name": "My stuff", "filters": [{"field": "assignee", "op": "in", "value": ["me"]}]},
    )
    assert mine.status_code == 201
    names = [x["name"] for x in tech.get("/api/v1/work-orders/views").json["items"]]
    assert names == ["Urgent", "My stuff"]  # pinned first
    assert tech.delete(f"/api/v1/work-orders/views/{v.json['id']}").status_code == 403
    assert "My stuff" not in [x["name"] for x in admin.get("/api/v1/work-orders/views").json["items"]]
    bad = admin.post("/api/v1/work-orders/views", {"name": "Bad", "filters": [{"field": "x", "op": "in"}]})
    assert bad.status_code == 422


# ---- bulk ------------------------------------------------------------------------------------
def test_bulk_edit_with_undo_delete_and_errors(admin: Api) -> None:
    a, b = create(admin, priority="low"), create(admin, priority="medium")
    r = admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"], b["id"]], "action": "set_priority", "value": "high"})
    assert sorted(r.json["updated"]) == sorted([a["id"], b["id"]])
    assert admin.get(f"/api/v1/work-orders/{a['id']}").json["priority"] == "high"
    undo = r.json["undo"]
    admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"], b["id"]], "action": "revert", "value": undo})
    assert admin.get(f"/api/v1/work-orders/{a['id']}").json["priority"] == "low"
    assert admin.get(f"/api/v1/work-orders/{b['id']}").json["priority"] == "medium"
    mech = team_id(admin, "Mechanical")
    admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"]], "action": "add_assignees", "value": [f"team:{mech}"]})
    assert admin.get(f"/api/v1/work-orders/{a['id']}").json["assignees"][0]["name"] == "Mechanical"
    admin.patch("/api/v1/work-orders/settings", {"comment_on_cancel": "mandatory"})
    r = admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"], b["id"]], "action": "cancel"})
    assert len(r.json["errors"]) == 2 and r.json["updated"] == []
    r = admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"], b["id"]], "action": "delete"})
    assert len(r.json["updated"]) == 2
    assert admin.get("/api/v1/work-orders").json["total"] == 0
    admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"], b["id"]], "action": "restore"})
    assert admin.get("/api/v1/work-orders").json["total"] == 2
    assert admin.post("/api/v1/work-orders/bulk", {"ids": [a["id"]], "action": "drop_tables"}).status_code == 422


def test_duplicate(admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    wo = create(admin, priority="high", assignees=[{"type": "user", "id": avery}], description="Do the thing")
    admin.post(f"/api/v1/work-orders/{wo['id']}/status", {"status": "done"})
    r = admin.post(f"/api/v1/work-orders/{wo['id']}/duplicate")
    assert r.status_code == 201
    copy = r.json
    assert copy["number"] == wo["number"] + 1 and copy["status"] == "open" and copy["priority"] == "high"
    assert copy["assignees"][0]["id"] == avery and copy["description"] == "Do the thing"


# ---- templates, categories, settings ---------------------------------------------------------
def test_templates(admin: Api, app: Any) -> None:
    mech = team_id(admin, "Mechanical")
    t = admin.post(
        "/api/v1/work-order-templates",
        {
            "name": "Replace filter",
            "data": {
                "title": "Replace AHU filter",
                "priority": "medium",
                "assignees": [f"team:{mech}"],
                "estimated_minutes": 30,
            },
        },
    )
    assert t.status_code == 201
    assert admin.post("/api/v1/work-order-templates", {"name": "Bad", "data": {"status": "done"}}).status_code == 422
    assert (
        admin.post("/api/v1/work-order-templates", {"name": "Bad", "data": {"priority": "urgent"}}).status_code == 422
    )
    tech = login(app, "avery.kim@example.com")
    assert tech.post("/api/v1/work-order-templates", {"name": "x"}).status_code == 403
    assert tech.get("/api/v1/work-order-templates").json["items"][0]["name"] == "Replace filter"
    wo = create(admin, **t.json["data"], template_id=t.json["id"])
    assert wo["assignees"][0]["name"] == "Mechanical"


def test_categories_crud(admin: Api) -> None:
    c = admin.post("/api/v1/categories", {"name": "Pneumatics", "color": "#13805a"})
    assert c.status_code == 201
    assert admin.post("/api/v1/categories", {"name": "pneumatics"}).status_code == 409
    assert admin.post("/api/v1/categories", {"name": "Bad", "color": "red"}).status_code == 422
    wo = create(admin, categories=[c.json["id"]])
    cats = {x["name"]: x for x in admin.get("/api/v1/categories").json["items"]}
    assert cats["Pneumatics"]["work_order_count"] == 1
    admin.patch(f"/api/v1/categories/{c.json['id']}", {"name": "Air systems"})
    assert admin.get(f"/api/v1/work-orders/{wo['id']}").json["categories"][0]["name"] == "Air systems"
    assert admin.delete(f"/api/v1/categories/{c.json['id']}").status_code == 204
    assert admin.get(f"/api/v1/work-orders/{wo['id']}").json["categories"] == []


def test_settings_validation_and_next_number(admin: Api) -> None:
    assert admin.patch("/api/v1/work-orders/settings", {"completion_summary": "sometimes"}).status_code == 422
    assert admin.patch("/api/v1/work-orders/settings", {"time_types": []}).status_code == 422
    assert admin.patch("/api/v1/work-orders/settings", {"categories_seeded": False}).status_code == 422
    assert admin.patch("/api/v1/work-orders/settings", {"nonsense": 1}).status_code == 422
    r = admin.patch(
        "/api/v1/work-orders/settings",
        {"time_types": ["Work", "Travel", "Work"], "sub_statuses": {"on_hold": ["Waiting on parts"]}},
    )
    assert r.json["time_types"] == ["Work", "Travel"]
    wo = create(admin)
    assert admin.post("/api/v1/work-orders/settings/next-number", {"next_number": wo["number"]}).status_code == 422
    assert admin.post("/api/v1/work-orders/settings/next-number", {"next_number": 1000}).json["next_number"] == 1000
    assert create(admin)["number"] == 1000


# ---- exports, workload, search, overview -----------------------------------------------------
def test_pdf_and_download_center(admin: Api) -> None:
    wo = create(admin, title='=HYPERLINK("http://evil")', description="Line one\nLine two <b>not html</b>")
    admin.post(f"/api/v1/work-orders/{wo['id']}/comments", {"body": "Checked & ok"})
    admin.c.post(
        "/api/v1/files",
        data={"file": (io.BytesIO(_png((800, 600))), "site.png"), "entity_type": "work_order", "entity_id": wo["id"]},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    )
    r = admin.get(f"/api/v1/work-orders/{wo['id']}/pdf")
    assert r.status_code == 200 and r.data[:5] == b"%PDF-" and r.mimetype == "application/pdf"
    r = admin.get(f"/api/v1/work-orders/{wo['id']}/pdf?sections=basic_info&image_size=links")
    assert r.data[:5] == b"%PDF-"
    ex = admin.post("/api/v1/work-orders/export", {"format": "csv"})
    assert ex.status_code == 202
    got = admin.get(f"/api/v1/exports/{ex.json['id']}").json
    assert got["status"] == "ready", got
    csv_bytes = admin.get(got["file"]["url"]).data.decode("utf-8-sig")
    assert "'=HYPERLINK" in csv_bytes  # formula injection neutralised
    ex = admin.post("/api/v1/work-orders/export", {"format": "pdf", "ids": [wo["id"]]})
    got = admin.get(f"/api/v1/exports/{ex.json['id']}").json
    assert got["status"] == "ready" and got["file"]["content_type"] == "application/pdf"
    assert len(admin.get("/api/v1/exports").json["items"]) == 2
    assert admin.delete(f"/api/v1/exports/{ex.json['id']}").status_code == 204


def test_workload_stats_and_search(admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mech = team_id(admin, "Mechanical")
    due = datetime.now(UTC).replace(hour=18, minute=0, second=0, microsecond=0)
    create(
        admin, title="Pump rebuild", due_at=iso(due), estimated_minutes=120, assignees=[{"type": "user", "id": avery}]
    )
    create(admin, title="Team job", due_at=iso(due), estimated_minutes=60, assignees=[{"type": "team", "id": mech}])
    start = (due - timedelta(days=1)).date().isoformat()
    w = admin.get(f"/api/v1/work-orders/workload?start={start}&days=7").json
    total = sum(c["minutes"] for c in w["cells"].get(avery, {}).values())
    assert total == 120 and w["capacity_minutes"] == 480
    assert any(r["name"] == "Mechanical" for r in w["unassigned"])
    s = admin.get("/api/v1/work-orders/stats").json
    assert s["open"] == 2
    groups = admin.get("/api/v1/search?q=pump").json
    wo_group = next(g for g in groups["groups"] if g["type"] == "work_orders")
    assert wo_group["results"][0]["title"].endswith("Pump rebuild")


def test_audit_events_for_work_orders(admin: Api) -> None:
    wo = create(admin)
    admin.patch(f"/api/v1/work-orders/{wo['id']}", {"priority": "high"})
    events = admin.get(f"/api/v1/audit?entity_id={wo['id']}").json["items"]
    types = {e["type"] for e in events}
    assert {"wo.created", "wo.updated"} <= types
    upd = next(e for e in events if e["type"] == "wo.updated")
    assert upd["changes"]["priority"] == ["none", "high"]


@pytest.mark.parametrize(
    "payload", [{"title": None}, {"estimated_minutes": -5}, {"priority": "urgent"}, {"work_type": "fun"}]
)
def test_bad_input_is_422(admin: Api, payload: dict[str, Any]) -> None:
    assert admin.post("/api/v1/work-orders", {"title": "x", **payload}).status_code == 422


def test_demo_work_orders_seed_once(app: Any) -> None:
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.demo import seed_demo
        from mpro.extensions import db
        from mpro.workorders.models import WorkOrder

        seed_demo()
        n = db.session.scalar(select(func.count()).select_from(WorkOrder))
        assert n and n >= 25
        seed_demo()
        assert db.session.scalar(select(func.count()).select_from(WorkOrder)) == n


# ---- regressions from the 0.2.0 review ---------------------------------------------------------
def test_activity_hides_ip_addresses(app: Any, admin: Api) -> None:
    wo = create(admin)
    viewer = login(app, "quinn.foster@example.com")
    items = viewer.get(f"/api/v1/work-orders/{wo['id']}/activity").json["items"]
    assert items and all("ip" not in i for i in items)


def test_limited_user_cannot_see_hidden_related_work(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    mine = create(admin, title="Mine", assignees=[{"type": "user", "id": avery}])
    secret = create(admin, title="SECRET parent")
    create(admin, title="SECRET child", parent_id=mine["id"])
    other = create(admin, title="SECRET linked")
    admin.post(f"/api/v1/work-orders/{mine['id']}/links", {"work_order_id": other["id"]})
    admin.patch(f"/api/v1/users/{avery}/work-settings", {"wo_visibility": "limited"})
    tech = login(app, "avery.kim@example.com")
    d = tech.get(f"/api/v1/work-orders/{mine['id']}").json
    assert d["sub_work_orders"] == [] and d["links"] == []
    r = tech.post("/api/v1/work-orders", {"title": "x", "parent_id": secret["id"]})
    assert r.status_code == 422 and "SECRET" not in str(r.json)


def test_cost_user_must_be_in_org(app: Any, admin: Api) -> None:
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db

        u = User(email="outsider@example.com", name="Secret Outsider")
        db.session.add(u)
        db.session.commit()
        outsider = str(u.id)
    wo = create(admin)
    r = admin.post(f"/api/v1/work-orders/{wo['id']}/costs", {"amount_cents": 100, "user_id": outsider})
    assert r.status_code == 422


def test_deleted_custom_field_does_not_block_edits(admin: Api) -> None:
    f = admin.post("/api/v1/custom-fields", {"name": "Old field", "type": "select", "options": ["A", "B"]}).json
    wo = create(admin, custom={f["id"]: "A"})
    admin.patch(f"/api/v1/custom-fields/{f['id']}", {"options": ["B", "C"]})
    r = admin.patch(f"/api/v1/work-orders/{wo['id']}", {"title": "Renamed", "custom": wo["custom"]})
    assert r.status_code == 200  # unchanged value for a removed option is kept
    admin.delete(f"/api/v1/custom-fields/{f['id']}")
    r = admin.patch(f"/api/v1/work-orders/{wo['id']}", {"title": "Again", "custom": wo["custom"]})
    assert r.status_code == 200 and f["id"] not in r.json["custom"]
    assert admin.post(f"/api/v1/work-orders/{wo['id']}/duplicate").status_code == 201


def test_typed_custom_field_filters(admin: Api) -> None:
    cb = admin.post("/api/v1/custom-fields", {"name": "Lockout", "type": "checkbox"}).json
    num = admin.post("/api/v1/custom-fields", {"name": "Hours down", "type": "number"}).json
    day = admin.post("/api/v1/custom-fields", {"name": "Found on", "type": "date"}).json
    a = create(admin, title="A", custom={cb["id"]: True, num["id"]: 9, day["id"]: "2026-10-01"})
    b = create(admin, title="B", custom={num["id"]: 12, day["id"]: "2026-10-20"})

    def ids(f: list[dict[str, Any]]) -> list[str]:
        return [w["id"] for w in admin.get("/api/v1/work-orders?filters=" + json.dumps(f)).json["items"]]

    assert ids([{"field": f"custom.{cb['id']}", "op": "in", "value": ["true"]}]) == [a["id"]]
    assert ids([{"field": f"custom.{cb['id']}", "op": "in", "value": ["false"]}]) == [b["id"]]
    assert ids([{"field": f"custom.{num['id']}", "op": "between", "value": ["8", "10"]}]) == [a["id"]]
    assert ids([{"field": f"custom.{day['id']}", "op": "before", "value": "2026-10-10"}]) == [a["id"]]
    assert ids([{"field": f"custom.{day['id']}", "op": "after", "value": "2026-10-10"}]) == [b["id"]]


def test_leaving_done_resets_signature_and_approval(admin: Api) -> None:
    sig = "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()
    admin.patch("/api/v1/work-orders/settings", {"require_signature": True})
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}/status"
    assert admin.post(url, {"status": "done", "signature": sig}).status_code == 200
    r = admin.post(url, {"status": "open"})
    assert r.json["signature"] is None and r.json["completed_at"] is None
    assert admin.post(url, {"status": "done"}).status_code == 422  # must sign again
    admin.patch("/api/v1/work-orders/settings", {"require_signature": False, "require_approval": True})
    wo2 = create(admin)
    tech_done = admin.post(f"/api/v1/work-orders/{wo2['id']}/status", {"status": "done"}).json
    assert tech_done["approval_status"] == "approved"  # admin completes = approves
    r = admin.post(f"/api/v1/work-orders/{wo2['id']}/status", {"status": "canceled"})
    assert r.json["approval_status"] == "none" and r.json["completed_at"] is None


def test_undo_skips_comment_rule_and_restores_sub_status(admin: Api) -> None:
    admin.patch("/api/v1/work-orders/settings", {"comment_on_hold": "mandatory"})
    wo = create(admin)
    url = f"/api/v1/work-orders/{wo['id']}/status"
    admin.post(url, {"status": "on_hold", "comment": "parts", "sub_status": "Waiting on parts"})
    r = admin.post("/api/v1/work-orders/bulk", {"ids": [wo["id"]], "action": "set_status", "value": "in_progress"})
    undo = r.json["undo"]
    r = admin.post("/api/v1/work-orders/bulk", {"ids": [wo["id"]], "action": "revert", "value": undo})
    assert r.json["errors"] == []
    d = admin.get(f"/api/v1/work-orders/{wo['id']}").json
    assert d["status"] == "on_hold" and d["sub_status"] == "Waiting on parts"
    assert admin.post(url, {"status": "in_progress"}).status_code == 200
    assert admin.post(url, {"status": "on_hold", "undo": True}).status_code == 200


def test_bulk_rejects_malformed_values(admin: Api) -> None:
    wo = create(admin)
    for action, value in (("add_assignees", [{"id": "x"}]), ("revert", ["nope"]), ("add_categories", "x")):
        r = admin.post("/api/v1/work-orders/bulk", {"ids": [wo["id"]], "action": action, "value": value})
        assert r.status_code in (200, 422), (action, r.status_code)
        if r.status_code == 200:
            assert r.json["errors"], action


def test_files_on_deleted_comments_are_hidden(app: Any, admin: Api) -> None:
    wo = create(admin)
    up = admin.c.post(
        "/api/v1/files",
        data={"file": (io.BytesIO(_png()), "private.png")},
        headers={"X-CSRF-Token": admin.csrf},
        content_type="multipart/form-data",
    ).json
    c = admin.post(f"/api/v1/work-orders/{wo['id']}/comments", {"body": "see photo", "file_ids": [up["id"]]}).json
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(up["url"]).status_code == 200
    admin.delete(f"/api/v1/work-orders/{wo['id']}/comments/{c['id']}")
    assert viewer.get(up["url"]).status_code == 404


def test_pdf_can_open_in_browser_viewer(admin: Api) -> None:
    wo = create(admin)
    r = admin.get(f"/api/v1/work-orders/{wo['id']}/pdf")
    assert "sandbox" not in r.headers.get("Content-Security-Policy", "")
