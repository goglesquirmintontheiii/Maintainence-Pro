# ruff: noqa: E501  (long API calls read better on one line)
"""Locations, assets, meters, QR codes and labels (0.3.0)."""

from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_work_orders import PNG_1PX, login, team_id

API = "/api/v1"


def loc(api: Api, name: str = "Plant 1", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/locations", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def asset(api: Api, name: str = "Conveyor 3", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/assets", {"name": name, **kw})
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


def upload(api: Api, name: str = "photo.png", data: bytes = PNG_1PX) -> str:
    r = api.c.post(
        f"{API}/files", data={"file": (io.BytesIO(data), name)}, headers=api._h(), content_type="multipart/form-data"
    )
    assert r.status_code == 201, r.json
    return r.json["id"]  # type: ignore[no-any-return]


# ---- locations -----------------------------------------------------------------------------------
def test_location_tree_and_rules(admin: Api) -> None:
    plant = loc(admin, "Plant 1", city="Dayton", latitude=39.75, longitude=-84.19, teams=[team_id(admin, "Mechanical")])
    hall = loc(admin, "Hall A", parent_id=plant["id"])
    room = loc(admin, "Compressor room", parent_id=hall["id"])
    assert [p["name"] for p in room["path"]] == ["Plant 1", "Hall A"]
    assert plant["teams"][0]["name"] == "Mechanical"
    assert plant["maps_url"].startswith("https://www.openstreetmap.org/")
    # can't move a location inside its own subtree
    r = admin.patch(f"{API}/locations/{plant['id']}", {"parent_id": room["id"]})
    assert r.status_code == 422
    # move Hall A to the top: its child moves with it
    admin.patch(f"{API}/locations/{hall['id']}", {"parent_id": None})
    assert [p["name"] for p in admin.get(f"{API}/locations/{room['id']}").json["path"]] == ["Hall A"]
    tops = admin.get(f"{API}/locations?parent_id=root").json["items"]
    assert {"Plant 1", "Hall A"} <= {x["name"] for x in tops}
    within = admin.get(f"{API}/locations?within={hall['id']}").json["items"]
    assert {x["name"] for x in within} == {"Hall A", "Compressor room"}
    # can't delete with children or assets
    assert admin.delete(f"{API}/locations/{hall['id']}").status_code == 409
    a = asset(admin, location_id=room["id"])
    assert admin.delete(f"{API}/locations/{room['id']}").status_code == 409
    admin.patch(f"{API}/assets/{a['id']}", {"location_id": None})
    assert admin.delete(f"{API}/locations/{room['id']}").status_code == 204
    assert admin.post(f"{API}/locations/{room['id']}/restore").json["deleted"] is False
    assert admin.patch(f"{API}/locations/{plant['id']}", {"latitude": 123}).status_code == 422
    hist = admin.get(f"{API}/locations/{plant['id']}/history").json["items"]
    assert hist[-1]["type"] == "location.created"


def test_floor_plan_pins(admin: Api) -> None:
    plant = loc(admin)
    a = asset(admin, location_id=plant["id"])
    fid = upload(admin, "plan.png")
    fp = admin.post(f"{API}/locations/{plant['id']}/floor-plans", {"name": "Ground floor", "file_id": fid}).json
    assert (
        admin.post(
            f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/pins", {"x": 1.5, "y": 0.2, "asset_id": a["id"]}
        ).status_code
        == 422
    )
    pin = admin.post(
        f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/pins", {"x": 0.5, "y": 0.2, "asset_id": a["id"]}
    ).json
    d = admin.get(f"{API}/locations/{plant['id']}").json
    assert d["floor_plans"][0]["pins"][0]["label"] == "Conveyor 3"
    assert all(f["role"] != "floor_plan" for f in d["files"])
    admin.patch(f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/pins/{pin['id']}", {"x": 0.1})
    assert admin.get(f"{API}/locations/{plant['id']}").json["floor_plans"][0]["pins"][0]["x"] == 0.1
    # a text file can't be a floor plan
    txt = upload(admin, "notes.txt", b"hello")
    assert admin.post(f"{API}/locations/{plant['id']}/floor-plans", {"file_id": txt}).status_code == 422


# ---- assets --------------------------------------------------------------------------------------
def test_asset_crud_tree_and_duplicate(admin: Api) -> None:
    plant = loc(admin)
    t = admin.post(f"{API}/asset-types", {"name": "Conveyor", "color": "#1b5bd4"}).json
    line = asset(admin, "Line 2", location_id=plant["id"], criticality="critical", types=[t["id"]])
    motor = asset(
        admin, "Drive motor", parent_id=line["id"], manufacturer="Baldor", model="M3711T", serial_number="SN-1"
    )
    assert motor["location"]["name"] == "Plant 1"  # follows the parent's location
    assert [p["name"] for p in motor["path"]] == ["Line 2"]
    assert admin.get(f"{API}/assets/{line['id']}").json["child_count"] == 1
    # cycles are refused
    assert admin.patch(f"{API}/assets/{line['id']}", {"parent_id": motor["id"]}).status_code == 422
    # optimistic concurrency
    r = admin.patch(f"{API}/assets/{motor['id']}", {"name": "Drive motor A", "version": 1})
    assert r.status_code == 200 and r.json["version"] == 2
    assert admin.patch(f"{API}/assets/{motor['id']}", {"name": "x", "version": 1}).status_code == 409
    dup = admin.post(f"{API}/assets/{motor['id']}/duplicate").json
    assert dup["name"] == "Copy - Drive motor A" and dup["serial_number"] == "" and dup["parent_id"] == line["id"]
    # can't delete a parent with children
    assert admin.delete(f"{API}/assets/{line['id']}").status_code == 409
    items = admin.get(f"{API}/assets?parent_id=root&q=line").json["items"]
    assert items[0]["name"] == "Line 2" and items[0]["types"][0]["name"] == "Conveyor"
    assert admin.get(f"{API}/assets?type_id={t['id']}").json["total"] == 1
    assert admin.get(f"{API}/assets?criticality=critical").json["total"] == 1
    assert admin.get(f"{API}/assets?sort=-name").status_code == 200
    assert admin.get(f"{API}/assets?sort=bogus").status_code == 422
    assert "Baldor" in admin.get(f"{API}/asset-catalog").json["manufacturers"]
    assert admin.get(f"{API}/asset-catalog?manufacturer=baldor").json["models"] == ["M3711T"]
    hist = admin.get(f"{API}/assets/{motor['id']}/history").json["items"]
    assert any(h["type"] == "asset.updated" and "name" in h["changes"] for h in hist)


def test_asset_max_depth(admin: Api) -> None:
    admin.patch(f"{API}/assets/settings", {"max_depth": 2})
    a = asset(admin, "A")
    b = asset(admin, "B", parent_id=a["id"])
    assert admin.post(f"{API}/assets", {"name": "C", "parent_id": b["id"]}).status_code == 422
    c = asset(admin, "C")
    d = asset(admin, "D", parent_id=c["id"])
    # moving C (with its child) under A would make three levels
    assert admin.patch(f"{API}/assets/{c['id']}", {"parent_id": a["id"]}).status_code == 422
    assert admin.patch(f"{API}/assets/{d['id']}", {"parent_id": a["id"]}).status_code == 200


def test_status_downtime_and_children(app: Any, admin: Api) -> None:
    line = asset(admin, "Line 2")
    motor = asset(admin, "Motor", parent_id=line["id"])
    r = admin.post(f"{API}/assets/{line['id']}/status", {"status": "offline", "reason": "Not a reason"})
    assert r.status_code == 422
    r = admin.post(
        f"{API}/assets/{line['id']}/status", {"status": "offline", "reason": "Breakdown", "apply_to_children": True}
    )
    assert r.json["status"] == "offline" and r.json["downtime_type"] == "unplanned"
    assert admin.get(f"{API}/assets/{motor['id']}").json["status"] == "offline"
    # backdate the changes so availability is measurable
    with app.app_context():
        from sqlalchemy import select

        from mpro.assets.models import AssetStatusChange
        from mpro.extensions import db

        now = datetime.now(UTC)
        rows = db.session.scalars(select(AssetStatusChange).order_by(AssetStatusChange.at)).all()
        for c in rows:
            c.at = now - timedelta(hours=10) if c.to_status == "online" else now - timedelta(hours=4)
        db.session.commit()
    admin.post(f"{API}/assets/{line['id']}/status", {"status": "online"})
    dt = admin.get(f"{API}/assets/{line['id']}/downtime?days=1").json
    assert 3.9 * 3600 < dt["offline_seconds"] < 4.1 * 3600
    assert 55 < dt["availability"] < 65  # 4h of 10h
    hist = admin.get(f"{API}/assets/{line['id']}/status-history").json["items"]
    assert [h["to"] for h in hist][:2] == ["online", "offline"]
    assert admin.get(f"{API}/assets?status=offline").json["total"] == 1  # the motor


def test_permissions_financials_and_viewer(app: Any, admin: Api) -> None:
    a = asset(
        admin,
        "Chiller",
        purchase_price_cents=1_200_000,
        purchase_date="2020-01-01",
        useful_life_years=10,
        salvage_value_cents=200_000,
    )
    dep = a["financials"]["depreciation"]
    assert dep["annual_cents"] == 100_000 and dep["schedule"][0]["book_value_cents"] == 1_100_000
    tech = login(app, "avery.kim@example.com")
    d = tech.get(f"{API}/assets/{a['id']}").json
    assert "financials" not in d
    assert tech.patch(f"{API}/assets/{a['id']}", {"purchase_price_cents": 1}).status_code == 403
    assert tech.patch(f"{API}/assets/{a['id']}", {"name": "Chiller 1"}).status_code == 200
    assert tech.delete(f"{API}/assets/{a['id']}").status_code == 403
    # a technician creating an asset can't sneak in costs
    t_asset = tech.post(f"{API}/assets", {"name": "Pump", "purchase_price_cents": 5}).json
    assert admin.get(f"{API}/assets/{t_asset['id']}").json["financials"]["purchase_price_cents"] is None
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/assets").status_code == 200
    assert viewer.post(f"{API}/assets", {"name": "x"}).status_code == 403
    assert viewer.post(f"{API}/assets/{a['id']}/status", {"status": "offline"}).status_code == 403
    requester = login(app, "jamie.ortiz@example.com")
    assert requester.get(f"{API}/assets").status_code == 403
    assert (
        admin.post(f"{API}/assets", {"name": "x", "salvage_value_cents": 10, "purchase_price_cents": 5}).status_code
        == 422
    )
    assert (
        admin.post(
            f"{API}/assets", {"name": "x", "warranty_start": "2026-02-01", "warranty_end": "2026-01-01"}
        ).status_code
        == 422
    )


def test_asset_custom_fields_scoped_by_type(admin: Api) -> None:
    t = admin.post(f"{API}/asset-types", {"name": "Pump"}).json
    f_all = admin.post(f"{API}/custom-fields", {"entity_type": "asset", "name": "Room", "type": "text"}).json
    f_pump = admin.post(
        f"{API}/custom-fields", {"entity_type": "asset", "name": "Flow rate", "type": "number", "scope_id": t["id"]}
    ).json
    assert admin.get(f"{API}/custom-fields?entity=asset").json["items"][0]["entity_type"] == "asset"
    assert all(f["entity_type"] == "work_order" for f in admin.get(f"{API}/custom-fields").json["items"])
    p = asset(admin, "Pump 1", types=[t["id"]], custom={f_all["id"]: "B2", f_pump["id"]: "12.5"})
    assert p["custom"][f_pump["id"]] == 12.5
    assert {f["name"] for f in p["custom_fields"]} == {"Room", "Flow rate"}
    other = asset(admin, "Fan")
    assert {f["name"] for f in other["custom_fields"]} == {"Room"}
    assert admin.post(f"{API}/assets", {"name": "x", "custom": {f_pump["id"]: "fast"}}).status_code == 422
    # a work-order field can't be set on an asset
    wo_field = admin.post(f"{API}/custom-fields", {"name": "PO", "type": "text"}).json
    assert wo_field["id"] not in asset(admin, "y", custom={wo_field["id"]: "1"})["custom"]


def test_cross_org_isolation(app: Any, admin: Api) -> None:
    a = asset(admin)
    plant = loc(admin)
    other = other_org(app)
    assert other.get(f"{API}/assets/{a['id']}").status_code == 404
    assert other.get(f"{API}/assets").json["total"] == 0
    assert other.post(f"{API}/work-orders", {"title": "x", "asset_id": a["id"]}).status_code == 422
    assert other.post(f"{API}/work-orders", {"title": "x", "location_id": plant["id"]}).status_code == 422
    assert other.post(f"{API}/assets", {"name": "x", "parent_id": a["id"]}).status_code == 422
    assert other.post(f"{API}/qr-codes", {"entity_type": "asset", "entity_id": a["id"]}).status_code == 422
    code = admin.post(f"{API}/qr-codes", {"entity_type": "asset", "entity_id": a["id"]}).json
    assert other.get(f"{API}/scan?value={code['value']}").json["status"] == "unknown"
    assert (
        other.post(f"{API}/labels", {"entity_type": "asset", "ids": [a["id"]], "template": "avery_5160"}).status_code
        == 422
    )
    t = admin.post(f"{API}/asset-types", {"name": "Conveyor"}).json
    assert other.post(f"{API}/assets", {"name": "x", "types": [t["id"]]}).status_code == 422
    assert (
        other.post(
            f"{API}/custom-fields", {"entity_type": "asset", "name": "x", "type": "text", "scope_id": t["id"]}
        ).status_code
        == 422
    )


def test_bulk_and_export_and_search(app: Any, admin: Api) -> None:
    plant = loc(admin)
    ids = [asset(admin, f"Pump {i}")["id"] for i in range(3)]
    r = admin.post(
        f"{API}/assets/bulk",
        {"ids": ids, "action": "edit", "patch": {"location_id": plant["id"], "criticality": "important"}},
    ).json
    assert len(r["done"]) == 3
    assert admin.get(f"{API}/assets?location_id={plant['id']}").json["total"] == 3
    assert admin.post(f"{API}/assets/bulk", {"ids": ids, "action": "edit", "patch": {"name": "x"}}).status_code == 422
    admin.post(f"{API}/assets/bulk", {"ids": ids[:1], "action": "status", "patch": {"status": "offline"}})
    assert admin.get(f"{API}/assets?status=offline").json["total"] == 1
    admin.patch(f"{API}/assets/{ids[1]}", {"description": '=HYPERLINK("x")'})
    ex = admin.post(f"{API}/assets/export", {"query": {"location_id": plant["id"]}})
    assert ex.status_code == 202
    exports = admin.get(f"{API}/exports").json["items"]
    f = next(e for e in exports if e["kind"] == "assets.csv")
    assert f["status"] == "ready", f
    data = admin.get(f"/api/v1/files/{f['file']['id']}").data.decode("utf-8-sig")
    assert data.count("\n") == 4 and "'=HYPERLINK" in data and "Purchase price" in data
    groups = admin.get(f"{API}/search?q=pump").json["groups"]
    assert any(g["type"] == "assets" and len(g["results"]) == 3 for g in groups)
    tech = login(app, "avery.kim@example.com")
    assert tech.post(f"{API}/assets/bulk", {"ids": ids, "action": "delete"}).status_code == 403


# ---- work orders with assets ----------------------------------------------------------------------
def test_work_order_asset_location_and_tasks(app: Any, admin: Api) -> None:
    plant = loc(admin)
    room = loc(admin, "Room 2", parent_id=plant["id"])
    a = asset(admin, location_id=room["id"])
    b = asset(admin, "Conveyor 4", location_id=room["id"])
    wo = admin.post(
        f"{API}/work-orders",
        {
            "title": "Belt check",
            "asset_id": a["id"],
            "asset_tasks": [a["id"], b["id"], a["id"]],
            "asset_status": {"status": "offline", "reason": "Preventive maintenance", "downtime_type": "planned"},
        },
    ).json
    assert wo["asset"]["name"] == "Conveyor 3" and wo["location"]["name"] == "Room 2"
    assert [t["asset"]["name"] for t in wo["asset_tasks"]] == ["Conveyor 3", "Conveyor 4"]
    assert admin.get(f"{API}/assets/{a['id']}").json["downtime_type"] == "planned"
    task = wo["asset_tasks"][1]
    r = admin.patch(f"{API}/work-orders/{wo['id']}/asset-tasks/{task['id']}", {"status": "done", "note": "Tension OK"})
    assert r.json["asset_tasks"][1]["status"] == "done" and r.json["asset_tasks"][1]["note"] == "Tension OK"
    assert (
        admin.patch(f"{API}/work-orders/{wo['id']}/asset-tasks/{task['id']}", {"status": "canceled"}).status_code == 422
    )
    # filters: location within the plant, asset in
    flt = '[{"field":"location","op":"within","value":["' + plant["id"] + '"]}]'
    assert admin.get(f"{API}/work-orders?tab=all&filters={flt}").json["total"] == 1
    flt = '[{"field":"asset","op":"in","value":["' + b["id"] + '"]}]'
    assert admin.get(f"{API}/work-orders?tab=all&filters={flt}").json["total"] == 0
    # closing the work order can bring the asset back online
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done", "asset_status": {"status": "online"}})
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/assets/{a['id']}").json["status"] == "online"
    assert admin.patch(f"{API}/work-orders/{wo['id']}/asset-tasks/{task['id']}", {"status": "open"}).status_code == 409
    assert admin.get(f"{API}/assets/{a['id']}/work-orders?tab=done").json["total"] == 1
    ins = admin.get(f"{API}/assets/{a['id']}/insights?days=30").json
    assert ins["created"] == 1 and ins["completed"] == 1
    # the WO change can be undone by changing the asset
    admin.post(f"{API}/work-orders", {"title": "x", "asset_id": a["id"], "location_id": plant["id"]})
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/work-orders/{wo['id']}").json["asset"]["id"] == a["id"]
    tech = login(app, "avery.kim@example.com")
    wo2 = tech.post(f"{API}/work-orders", {"title": "Check", "asset_id": a["id"]}).json
    pdf = admin.get(f"{API}/work-orders/{wo['id']}/pdf")
    assert pdf.status_code == 200 and pdf.data[:4] == b"%PDF"
    assert wo2["location"]["id"] == room["id"]


def test_template_quick_create(admin: Api) -> None:
    a = asset(admin)
    t = admin.post(
        f"{API}/work-order-templates",
        {
            "name": "Weekly belt check",
            "pinned": True,
            "data": {"title": "Belt check", "priority": "medium", "due_in_days": 7},
        },
    ).json
    assert t["pinned"] is True
    admin.post(f"{API}/work-order-templates", {"name": "Another", "data": {"title": "x"}})
    wo = admin.post(f"{API}/work-order-templates/{t['id']}/create", {"asset_id": a["id"]})
    assert wo.status_code == 201, wo.json
    d = wo.json
    assert d["title"] == "Belt check" and d["priority"] == "medium" and d["asset"]["id"] == a["id"]
    due = datetime.fromisoformat(d["due_at"].replace("Z", "+00:00"))
    assert 6 <= (due - datetime.now(UTC)).days <= 7
    assert admin.post(f"{API}/work-order-templates/{t['id']}/create", {"status": "done"}).status_code == 422
    popular = admin.get(f"{API}/work-order-templates?sort=popular").json["items"]
    assert popular[0]["id"] == t["id"] and popular[0]["use_count"] == 1


# ---- meters --------------------------------------------------------------------------------------
def test_meters_readings_levels_and_triggers(admin: Api) -> None:
    a = asset(admin)
    assert (
        admin.post(f"{API}/meters", {"name": "Temp", "unit": "°C", "warning_high": 90, "alarm_high": 80}).status_code
        == 422
    )
    m = admin.post(
        f"{API}/meters",
        {
            "name": "Bearing temp",
            "unit": "°C",
            "asset_id": a["id"],
            "warning_high": 70,
            "alarm_high": 85,
            "reading_frequency": "day",
        },
    ).json
    assert m["asset"]["name"] == "Conveyor 3" and m["overdue"] is False
    t = admin.post(
        f"{API}/meters/{m['id']}/triggers",
        {
            "kind": "threshold",
            "comparator": "gt",
            "threshold": 80,
            "work_order": {"title": "Bearing overheating", "priority": "high"},
        },
    ).json
    r = admin.post(f"{API}/meters/{m['id']}/readings", {"value": 65}).json
    assert r["reading"]["level"] == "" and r["meter"]["last_value"] == 65
    r = admin.post(f"{API}/meters/{m['id']}/readings", {"value": 75}).json
    assert r["reading"]["level"] == "warning"
    r = admin.post(f"{API}/meters/{m['id']}/readings", {"value": 88}).json
    assert r["reading"]["level"] == "alarm"
    wos = admin.get(f"{API}/work-orders?tab=all&q=Bearing").json["items"]
    assert len(wos) == 1 and wos[0]["priority"] == "high" and wos[0]["asset"]["id"] == a["id"]
    # staying hot, or crossing again while the work order is open, doesn't create another
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 89})
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 60})
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 86})
    assert admin.get(f"{API}/work-orders?tab=all&q=Bearing").json["total"] == 1
    detail = admin.get(f"{API}/meters/{m['id']}").json
    assert "still open" in detail["triggers"][0]["last_note"] and detail["triggers"][0]["fired_count"] == 1
    admin.post(f"{API}/work-orders/{wos[0]['id']}/status", {"status": "done"})
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 50})
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 95})
    assert admin.get(f"{API}/work-orders?tab=all&q=Bearing").json["total"] == 2
    # a reading in the past doesn't change the latest value or fire
    past = (datetime.now(UTC) - timedelta(days=3)).isoformat()
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 10, "recorded_at": past})
    assert admin.get(f"{API}/meters/{m['id']}").json["last_value"] == 95
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert admin.post(f"{API}/meters/{m['id']}/readings", {"value": 1, "recorded_at": future}).status_code == 422
    assert admin.post(f"{API}/meters/{m['id']}/readings", {"value": "hot"}).status_code == 422
    assert admin.post(f"{API}/meters/{m['id']}/readings", {"value": "NaN"}).status_code == 422
    items = admin.get(f"{API}/meters/{m['id']}/readings?days=7").json["items"]
    assert items[0]["value"] == 95 and len(items) == 9
    ch = admin.get(f"{API}/meters/{m['id']}/chart?days=7").json
    assert ch["limits"]["alarm_high"] == 85 and len(ch["points"]) == 9
    assert admin.get(f"{API}/meters?level=alarm").json["total"] == 1
    admin.delete(f"{API}/meters/{m['id']}/triggers/{t['id']}")


def test_every_n_trigger_and_batch_api(app: Any, admin: Api) -> None:
    m = admin.post(f"{API}/meters", {"name": "Run hours", "unit": "hours"}).json
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 100})
    admin.post(
        f"{API}/meters/{m['id']}/triggers",
        {"kind": "every", "every_units": 250, "work_order": {"title": "250h service"}},
    )
    r = admin.post(
        f"{API}/meter-readings",
        {
            "readings": [
                {"meter_id": m["id"], "value": 300},
                {"meter_id": m["id"], "value": 360},
                {"meter_id": "nope", "value": 1},
                {"meter_id": m["id"], "value": "x"},
            ]
        },
    ).json
    assert r["recorded"] == 2 and [f["index"] for f in r["failed"]] == [2, 3]
    wos = admin.get(f"{API}/work-orders?tab=all&q=250h").json["items"]
    assert len(wos) == 1 and wos[0]["work_type"] == "preventive"
    assert admin.get(f"{API}/meters/{m['id']}").json["triggers"][0]["next_at"] == 600
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.post(f"{API}/meters/{m['id']}/readings", {"value": 1}).status_code == 403
    tech = login(app, "avery.kim@example.com")
    assert tech.post(f"{API}/meters/{m['id']}/readings", {"value": 361}).status_code == 201
    assert tech.delete(f"{API}/meters/{m['id']}").status_code == 403
    copies = admin.post(f"{API}/meters/{m['id']}/copy", {}).json["items"]
    assert copies[0]["name"] == "Copy - Run hours"
    assert admin.get(f"{API}/meters/{copies[0]['id']}").json["triggers"][0]["kind"] == "every"


def test_chart_buckets_many_readings(app: Any, admin: Api) -> None:
    m = admin.post(f"{API}/meters", {"name": "Pressure", "unit": "psi"}).json
    with app.app_context():
        import uuid as _uuid
        from decimal import Decimal

        from mpro.extensions import db
        from mpro.meters.models import MeterReading

        now = datetime.now(UTC)
        org_id = _uuid.UUID(admin.session()["org"]["id"])
        for i in range(600):
            db.session.add(
                MeterReading(
                    org_id=org_id,
                    meter_id=_uuid.UUID(m["id"]),
                    value=Decimal(i % 50),
                    recorded_at=now - timedelta(minutes=i * 10),
                    source="api",
                    note="",
                    level="",
                    anomaly=False,
                )
            )
        db.session.commit()
    ch = admin.get(f"{API}/meters/{m['id']}/chart?days=7").json
    assert ch["bucketed"] is True and len(ch["points"]) <= 200 and "max" in ch["points"][0]


def test_anomaly_flag(admin: Api) -> None:
    m = admin.post(f"{API}/meters", {"name": "Vibration", "unit": "mm/s"}).json
    for v in (2.0, 2.1, 1.9, 2.2, 2.0, 2.1, 1.8, 2.0, 2.1, 2.0):
        admin.post(f"{API}/meters/{m['id']}/readings", {"value": v})
    assert admin.post(f"{API}/meters/{m['id']}/readings", {"value": 2.05}).json["reading"]["anomaly"] is False
    assert admin.post(f"{API}/meters/{m['id']}/readings", {"value": 9.5}).json["reading"]["anomaly"] is True


# ---- QR codes and labels -------------------------------------------------------------------------
def test_qr_codes_scan_assign_move_retire(app: Any, admin: Api) -> None:
    a = asset(admin, serial_number="AB-1234", barcode="0012345")
    b = asset(admin, "Conveyor 4")
    c = admin.post(f"{API}/qr-codes", {"entity_type": "asset", "entity_id": a["id"]}).json
    assert len(c["value"]) == 10 and c["url"] == f"http://mpro.test/q/{c['value']}"
    assert (
        admin.post(f"{API}/qr-codes", {"entity_type": "asset", "entity_id": a["id"]}).json["id"] == c["id"]
    )  # one per record
    s = admin.get(f"{API}/scan?value={c['url']}").json
    assert s["status"] == "found" and s["url"] == f"/assets/{a['id']}"
    assert admin.get(f"{API}/scan?value={c['value'].lower()}").json["status"] == "found"
    assert admin.get(f"{API}/scan?value=ab-1234").json["matched"] == "serial_number"
    assert admin.get(f"{API}/scan?value=0012345").json["matched"] == "barcode"
    assert admin.get(f"{API}/scan?value=zzz").json["status"] == "unknown"
    # an existing MaintainX label
    ext = admin.post(
        f"{API}/qr-codes",
        {
            "entity_type": "asset",
            "entity_id": b["id"],
            "value": "https://app.getmaintainx.com/a/xyz",
            "symbology": "qr",
        },
    ).json
    assert admin.get(f"{API}/scan?value=https://app.getmaintainx.com/a/xyz").json["entity_id"] == b["id"]
    assert (
        admin.post(
            f"{API}/qr-codes",
            {"entity_type": "asset", "entity_id": a["id"], "value": "https://app.getmaintainx.com/a/xyz"},
        ).status_code
        == 409
    )
    # tag first, assign later
    batch = admin.post(f"{API}/qr-codes", {"count": 3, "note": "Line 2 walk"}).json
    blank = batch["items"][0]
    assert admin.get(f"{API}/scan?value={blank['value']}").json["status"] == "unassigned"
    admin.post(f"{API}/qr-codes/{blank['id']}/assign", {"entity_type": "asset", "entity_id": b["id"]})
    assert admin.get(f"{API}/scan?value={blank['value']}").json["entity_id"] == b["id"]
    assert (
        admin.post(f"{API}/qr-codes/{blank['id']}/assign", {"entity_type": "asset", "entity_id": a["id"]}).status_code
        == 409
    )
    admin.post(f"{API}/qr-codes/{blank['id']}/assign", {"entity_type": "asset", "entity_id": a["id"], "move": True})
    assert admin.get(f"{API}/scan?value={blank['value']}").json["entity_id"] == a["id"]
    admin.post(f"{API}/qr-codes/{blank['id']}/retire")
    assert admin.get(f"{API}/scan?value={blank['value']}").json["status"] == "retired"
    assert admin.get(f"{API}/qr-codes?state=unassigned").json["total"] == 2
    assert {x["value"] for x in admin.get(f"{API}/qr-codes/for/asset/{b['id']}").json["items"]} == {ext["value"]}
    assert admin.get(f"{API}/assets?label=none").json["total"] == 0
    assert admin.post(f"{API}/qr-codes", {"count": 5000}).status_code == 422
    requester = login(app, "jamie.ortiz@example.com")
    assert requester.get(f"{API}/scan?value={c['value']}").status_code == 403


@pytest.mark.parametrize("template", ["avery_94107", "avery_5160", "avery_94202", "avery_5163"])
def test_label_sheets(admin: Api, template: str) -> None:
    ids = [asset(admin, f"Pump {i} with a rather long name that has to be shortened to fit")["id"] for i in range(3)]
    r = admin.post(
        f"{API}/labels",
        {
            "entity_type": "asset",
            "ids": ids,
            "format": "sheet",
            "template": template,
            "start": 2,
            "copies": 2,
            "options": {"barcode": True, "outline": True},
        },
    )
    assert r.status_code == 200 and r.data[:4] == b"%PDF"
    # printing gave every asset a code
    assert admin.get(f"{API}/assets?label=none").json["total"] == 0


def test_label_thermal_zpl_and_limits(app: Any, admin: Api) -> None:
    a = asset(admin, "Air compressor ^XA~JR")
    for tpl in ("zebra_2x1", "zebra_4x6", "brother_62x29"):
        r = admin.post(
            f"{API}/labels", {"entity_type": "asset", "ids": [a["id"]], "format": "thermal", "template": tpl}
        )
        assert r.status_code == 200 and r.data[:4] == b"%PDF"
    z = admin.post(
        f"{API}/labels",
        {"entity_type": "asset", "ids": [a["id"]], "format": "zpl", "template": "zebra_2x1", "copies": 3},
    )
    text = z.data.decode()
    assert (
        text.startswith("^XA") and "^BQN" in text and "^PQ3" in text and "^XA~JR" not in text and "_5EXA_7EJR" in text
    )
    assert (
        admin.post(
            f"{API}/labels", {"entity_type": "asset", "ids": [a["id"]], "format": "zpl", "template": "brother_62x29"}
        ).status_code
        == 422
    )
    assert (
        admin.post(
            f"{API}/labels",
            {"entity_type": "asset", "ids": [a["id"]], "format": "sheet", "template": "avery_5160", "start": 31},
        ).status_code
        == 422
    )
    blank = admin.post(f"{API}/qr-codes", {"count": 2}).json["items"]
    r = admin.post(
        f"{API}/labels", {"code_ids": [b["id"] for b in blank], "format": "sheet", "template": "avery_94107"}
    )
    assert r.status_code == 200
    assert (
        admin.post(
            f"{API}/labels", {"entity_type": "asset", "query": {"q": "compressor"}, "template": "avery_5160"}
        ).status_code
        == 200
    )
    # a viewer can print existing codes but can't create new ones
    b = asset(admin, "No code yet")
    viewer = login(app, "quinn.foster@example.com")
    assert (
        viewer.post(f"{API}/labels", {"entity_type": "asset", "ids": [a["id"]], "template": "avery_5160"}).status_code
        == 200
    )
    assert (
        viewer.post(f"{API}/labels", {"entity_type": "asset", "ids": [b["id"]], "template": "avery_5160"}).status_code
        == 403
    )


def test_photo_timeline(app: Any, admin: Api) -> None:
    a = asset(admin, file_ids=[upload(admin)])
    wo = admin.post(
        f"{API}/work-orders", {"title": "Inspect", "asset_id": a["id"], "file_ids": [upload(admin, "wo.png")]}
    ).json
    admin.post(
        f"{API}/work-orders/{wo['id']}/comments", {"body": "Rust on the frame", "file_ids": [upload(admin, "c.png")]}
    )
    items = admin.get(f"{API}/assets/{a['id']}/photos").json["items"]
    assert len(items) == 3
    assert {i["source"]["type"] for i in items} == {"asset", "work_order", "comment"}


def test_theme_defaults_to_light(app: Any) -> None:
    with app.app_context():
        from mpro.auth.models import User
        from mpro.extensions import db

        u = User(email="new@example.com", name="New Person")
        u.set_password("a-long-password-1")
        db.session.add(u)
        db.session.commit()
        assert u.theme == "light"


def test_entitlement_storage_pool(app: Any) -> None:
    with app.app_context():
        app.config["MPRO_EDITION"] = "cloud"
        from mpro.core.entitlements import entitlements_for

        class Org:
            plan = "pro"

        e = entitlements_for(Org())
        assert e.storage_quota_bytes(3) == 3 * 4 * 1024**3
        Org.plan = "expert_unlimited"
        assert entitlements_for(Org()).storage_quota_bytes(100) == 300 * 1024**3
        Org.plan = "expert_lifetime"
        assert entitlements_for(Org()).storage_quota_bytes(10) == 80 * 1024**3
        Org.plan = "free"
        assert entitlements_for(Org()).storage_quota_bytes(2) == 1000 * 1024**2
        app.config["MPRO_EDITION"] = "selfhosted"
        assert entitlements_for(Org()).storage_quota_bytes(2) is None


def test_workload_respects_filters(admin: Api) -> None:
    a = asset(admin)
    due = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    admin.post(
        f"{API}/work-orders", {"title": "On the asset", "asset_id": a["id"], "due_at": due, "estimated_minutes": 60}
    )
    admin.post(f"{API}/work-orders", {"title": "Elsewhere", "due_at": due, "estimated_minutes": 30})
    start = datetime.now(UTC).date().isoformat()
    flt = '[{"field":"asset","op":"in","value":["' + a["id"] + '"]}]'
    w = admin.get(f"{API}/work-orders/workload?start={start}&days=7&filters={flt}").json
    titles = [i["title"] for r in w["unassigned"] for c in r["days"].values() for i in c["items"]]
    assert titles == ["On the asset"]
    assert admin.get(f"{API}/work-orders/options").json["assets"][0]["name"] == "Conveyor 3"
