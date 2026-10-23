"""Requests from testing 0.4 (0.5.0, MP-121 … MP-129): backend parts."""

from __future__ import annotations

from typing import Any


def test_test_build_session_shows_database_path(app: Any, admin: Any) -> None:
    """MP-122: the test-build banner names the database file; only test builds expose it."""
    app.config["MPRO_TEST_BUILD"] = False
    assert "db_path" not in admin.session()
    app.config["MPRO_TEST_BUILD"] = True
    s = admin.session()
    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    if uri.startswith("sqlite:///"):
        assert s["db_path"] and s["db_path"].endswith("test.db")
    else:
        assert s["db_path"] and "@" not in s["db_path"]  # never the password


def test_db_path_not_shown_signed_out(app: Any, api: Any) -> None:
    app.config["MPRO_TEST_BUILD"] = True
    assert "db_path" not in api.session()


# ---- MP-124: several assets on one work order ------------------------------------------------
API = "/api/v1"


def _asset(api: Any, name: str, **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/assets", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def _ids(api: Any, qs: str) -> set[str]:
    return {w["id"] for w in api.get(f"{API}/work-orders?tab=all&per_page=200&{qs}").json["items"]}


def test_work_order_with_several_assets(admin: Any) -> None:
    import json

    room = admin.post(f"{API}/locations", {"name": "Boiler room"}).json
    a = _asset(admin, "Boiler 1", location_id=room["id"])
    b = _asset(admin, "Boiler 2")
    c = _asset(admin, "Feed pump")
    wo = admin.post(
        f"{API}/work-orders", {"title": "Annual boiler service", "asset_ids": [a["id"], b["id"], a["id"]]}
    ).json
    # primary = first, location follows it, duplicates dropped
    assert wo["asset"]["id"] == a["id"] and wo["location"]["id"] == room["id"]
    assert [x["name"] for x in wo["assets"]] == ["Boiler 1", "Boiler 2"]
    # lists and filters: any of its assets counts
    flt = json.dumps([{"field": "asset", "op": "in", "value": [b["id"]]}])
    assert wo["id"] in _ids(admin, "filters=" + flt)
    listed = next(w for w in admin.get(f"{API}/work-orders?tab=all").json["items"] if w["id"] == wo["id"])
    assert [x["id"] for x in listed["assets"]] == [a["id"], b["id"]]
    assert wo["id"] in _ids(admin, "q=boiler 2")  # search by any asset's name
    flt = json.dumps([{"field": "asset", "op": "not_in", "value": [b["id"]]}])
    assert wo["id"] not in _ids(admin, "filters=" + flt)
    # the second asset's history and open-work count include it
    assert admin.get(f"{API}/assets/{b['id']}/work-orders?tab=open").json["total"] == 1
    assert admin.get(f"{API}/assets/{b['id']}").json.get("open_work_orders", 1) == 1
    # old clients send only asset_id: unchanged primary keeps the list …
    wo2 = admin.patch(
        f"{API}/work-orders/{wo['id']}", {"asset_id": a["id"], "title": "Annual boiler service (2026)"}
    ).json
    assert [x["id"] for x in wo2["assets"]] == [a["id"], b["id"]]
    # … a different one replaces it
    wo3 = admin.patch(f"{API}/work-orders/{wo['id']}", {"asset_id": c["id"]}).json
    assert [x["id"] for x in wo3["assets"]] == [c["id"]] and wo3["asset"]["id"] == c["id"]
    # reorder / set the full list; clearing removes all
    wo4 = admin.patch(f"{API}/work-orders/{wo['id']}", {"asset_ids": [b["id"], c["id"]]}).json
    assert [x["id"] for x in wo4["assets"]] == [b["id"], c["id"]] and wo4["asset"]["id"] == b["id"]
    wo5 = admin.patch(f"{API}/work-orders/{wo['id']}", {"asset_ids": []}).json
    assert wo5["assets"] == [] and wo5["asset"] is None


def test_asset_status_per_asset_from_work_order(admin: Any) -> None:
    a = _asset(admin, "Chiller A")
    b = _asset(admin, "Chiller B")
    other = _asset(admin, "Not on it")
    wo = admin.post(f"{API}/work-orders", {"title": "Chillers", "asset_ids": [a["id"], b["id"]]}).json
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/status",
        {
            "status": "in_progress",
            "asset_status": {
                "assets": [
                    {"asset_id": b["id"], "status": "offline", "reason": "Breakdown", "downtime_type": "unplanned"}
                ]
            },
        },
    )
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/assets/{b['id']}").json["status"] == "offline"
    assert admin.get(f"{API}/assets/{a['id']}").json["status"] == "online"
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/status",
        {"status": "on_hold", "asset_status": {"asset_id": other["id"], "status": "offline"}},
    )
    assert r.status_code == 422


def test_several_assets_rejects_other_org_and_limit(app: Any, admin: Any) -> None:
    import uuid

    a = _asset(admin, "Compressor")
    r = admin.post(f"{API}/work-orders", {"title": "x", "asset_ids": [a["id"], str(uuid.uuid4())]})
    assert r.status_code in (404, 422)
    many = [_asset(admin, f"Fan {i}")["id"] for i in range(51)]
    assert admin.post(f"{API}/work-orders", {"title": "x", "asset_ids": many}).status_code == 422
    assert admin.post(f"{API}/work-orders", {"title": "x", "asset_ids": "nope"}).status_code == 422


def test_csv_export_lists_every_asset(admin: Any) -> None:
    a = _asset(admin, "Line 1 press")
    b = _asset(admin, "Line 1 conveyor")
    admin.post(f"{API}/work-orders", {"title": "Line 1 shutdown", "asset_ids": [a["id"], b["id"]]})
    ex = admin.post(f"{API}/work-orders/export", {"format": "csv"})
    got = admin.get(f"{API}/exports/{ex.json['id']}").json
    text = admin.get(got["file"]["url"]).data.decode("utf-8-sig")
    assert "Line 1 press, Line 1 conveyor" in text


# ---- MP-125: Upcoming tab ---------------------------------------------------------------------
def test_upcoming_window_and_remembered_days(admin: Any) -> None:
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)

    def wo(title: str, **kw: Any) -> str:
        r = admin.post(f"{API}/work-orders", {"title": title, **kw})
        assert r.status_code == 201, r.json
        return r.json["id"]  # type: ignore[no-any-return]

    soon = wo("Due in 3 days", due_at=(now + timedelta(days=3)).isoformat())
    starts = wo("Starts in 10 days", start_at=(now + timedelta(days=10)).isoformat())
    later = wo("Due in 50 days", due_at=(now + timedelta(days=50)).isoformat())
    wo("No dates")
    frm = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    week = {w["id"] for w in admin.get(f"{API}/work-orders?tab=upcoming&days=7&from={frm}&per_page=100").json["items"]}
    assert week == {soon}
    month = {w["id"] for w in admin.get(f"{API}/work-orders?tab=upcoming&days=30&from={frm}").json["items"]}
    assert month == {soon, starts}
    assert later in {w["id"] for w in admin.get(f"{API}/work-orders?tab=upcoming&days=60").json["items"]}
    assert admin.get(f"{API}/work-orders?tab=upcoming&days=900").status_code == 422
    assert admin.get(f"{API}/work-orders?tab=upcoming&days=7&from=2001-01-01T00:00:00Z").status_code == 422

    # the window is remembered per person (follows them between devices)
    r = admin.patch(f"{API}/auth/preferences", {"prefs": {"upcoming_days": 14}})
    assert r.status_code == 200, r.json
    assert admin.session()["user"]["prefs"]["upcoming_days"] == 14
    assert admin.patch(f"{API}/auth/preferences", {"prefs": {"upcoming_days": 0}}).status_code == 422
    assert admin.patch(f"{API}/auth/preferences", {"prefs": {"nope": 1}}).status_code == 422
    assert admin.session()["user"]["theme"]  # theme untouched when only prefs change


def test_pm_calendar_covers_a_year(admin: Any) -> None:
    assert admin.get(f"{API}/pm/calendar?days=365").status_code == 200
    assert admin.get(f"{API}/pm/calendar?days=400").status_code in (200, 422)


# ---- MP-128: merged shapes with holes and pinned parts lists on floor plans -----------------------
def test_floor_plan_merged_rings_and_parts_lists(admin: Any) -> None:
    from tests.test_assets import upload

    plant = admin.post(f"{API}/locations", {"name": "Plant R"}).json
    fid = upload(admin, "plan.png")
    fp = admin.post(f"{API}/locations/{plant['id']}/floor-plans", {"name": "Ground", "file_id": fid}).json
    url = f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/annotations"
    part = admin.post(f"{API}/parts", {"name": "V-belt"}).json
    gone = admin.post(f"{API}/parts", {"name": "Old filter"}).json
    outer = [[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]]
    hole = [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5], [0.2, 0.5]]
    shapes = [
        {"id": "m1", "type": "polygon", "points": outer, "rings": [outer, hole], "fill": "#1b5bd4"},
        {"id": "p1", "type": "parts", "x": 0.7, "y": 0.2, "w": 0.14, "h": 0.04, "part_ids": [part["id"]], "open": True},
        {"id": "p2", "type": "parts", "x": 0.7, "y": 0.5, "part_ids": [gone["id"]]},
    ]

    def put(body: Any, version: int) -> Any:
        return admin.c.put(url, json={"annotations": {"shapes": body}, "version": version}, headers=admin._h())

    admin.delete(f"{API}/parts/{gone['id']}")
    r = put(shapes, 0)
    assert r.status_code == 200, r.json
    saved = {s["id"]: s for s in r.json["annotations"]["shapes"]}
    assert saved["m1"]["rings"] == [outer, hole] and saved["m1"]["points"] == outer
    assert saved["p1"]["part_ids"] == [part["id"]] and saved["p1"]["open"] is True
    assert "p2" not in saved  # its only part was deleted: the list is dropped so the drawing still saves
    # another org's / unknown parts are dropped too; bad rings are refused
    import uuid

    r = put([{"id": "p3", "type": "parts", "x": 0.1, "y": 0.1, "part_ids": [str(uuid.uuid4())]}], 1)
    assert r.status_code == 200 and r.json["annotations"]["shapes"] == []
    assert put([{"id": "m2", "type": "polygon", "points": outer, "rings": [[[0, 0], [1, 1]]]}], 2).status_code == 422
    assert put([{"id": "p4", "type": "parts", "x": 0.1, "y": 0.1, "part_ids": []}], 2).status_code == 422
