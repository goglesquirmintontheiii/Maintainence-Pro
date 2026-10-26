# ruff: noqa: E501  (long API calls read better on one line)
"""Parts and inventory (0.5.0, MP-039–041): parts, stock, transactions, WO parts, cycle counts, exports."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_assets import asset, loc, other_org
from tests.test_roles import member
from tests.test_work_orders import create as create_wo
from tests.test_work_orders import team_id

API = "/api/v1"


def part(api: Api, name: str = "Ball bearing 6205", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/parts", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def stocked(
    api: Api, qty: str = "10", min_qty: str = "4", max_qty: str = "20", **kw: Any
) -> tuple[dict[str, Any], str]:
    wh = loc(api, "Storeroom")
    p = part(
        api,
        unit_cost="2.50",
        stock=[
            {"location_id": wh["id"], "area": "Bin 4", "min_qty": min_qty, "max_qty": max_qty, "initial_quantity": qty}
        ],
        **kw,
    )
    return p, wh["id"]


def stock_at(p: dict[str, Any], lid: str) -> dict[str, Any]:
    return next(s for s in p["stock"] if s["location"] and s["location"]["id"] == lid)


# ---- parts ------------------------------------------------------------------------------------------
def test_create_edit_types_vendors_and_required_fields(admin: Api) -> None:
    t = admin.post(f"{API}/part-types", {"name": "Electrical", "critical": True}).json
    team = team_id(admin, "Mechanical")
    a = asset(admin, "Pump 1")
    p, wh = stocked(
        admin, type_ids=[t["id"]], team_ids=[team], asset_ids=[a["id"]], barcode="0123456789012", part_number="BRG-1"
    )
    assert p["on_hand"] == "10" and p["available"] == "10" and p["unit_cost"] == "2.50"
    assert p["critical"] and p["types"][0]["name"] == "Electrical"
    assert stock_at(p, wh)["area"] == "Bin 4" and stock_at(p, wh)["min_qty"] == "4"
    assert [x["name"] for x in p["assets"]] == ["Pump 1"] and p["teams"][0]["id"] == team
    assert p["order_link"].startswith(f"/purchase-orders?new=1&part_id={p['id']}") and p["order_link"].endswith(
        "&quantity=10"
    )
    # duplicates are flagged before saving (r237)
    dup = admin.get(f"{API}/parts/duplicates?name=ball%20bearing%206205").json["items"]
    assert [d["id"] for d in dup] == [p["id"]]
    assert admin.get(f"{API}/parts/duplicates?barcode=0123456789012&exclude={p['id']}").json["items"] == []
    # edit with version check
    r = admin.patch(f"{API}/parts/{p['id']}", {"description": "Sealed", "version": p["version"]})
    assert r.status_code == 200 and r.json["description"] == "Sealed"
    assert admin.patch(f"{API}/parts/{p['id']}", {"description": "Old", "version": p["version"]}).status_code == 409
    # required fields are enforced on the API too (r221)
    assert admin.patch(f"{API}/parts/settings", {"required_fields": ["part_number", "part_types"]}).status_code == 200
    r = admin.post(f"{API}/parts", {"name": "No number"})
    assert r.status_code == 422
    assert (
        admin.post(f"{API}/parts", {"name": "With number", "part_number": "X-1", "type_ids": [t["id"]]}).status_code
        == 201
    )
    assert admin.post(f"{API}/parts", {"name": ""}).status_code == 422
    hist = admin.get(f"{API}/parts/{p['id']}/history").json["items"]
    assert hist[-1]["type"] == "part.created"


def test_files_and_picture(admin: Api) -> None:
    import io

    from tests.test_work_orders import PNG_1PX

    p = part(admin, "Pump seal")
    r = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(PNG_1PX), "seal.png"), "entity_type": "part", "entity_id": p["id"]},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 201, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert len(d["files"]) == 1 and d["picture_file_id"] == r.json["id"] and d["thumb_url"]


def test_list_filters_search_sort_and_presets(admin: Api) -> None:
    p, wh = stocked(admin, "2", part_number="LOW-1")  # below min 4
    part(admin, "Grease tube", non_stock=True)
    ok, _ = stocked(admin, "15")
    body = admin.get(f"{API}/parts?stock=needs_restock").json
    assert [x["id"] for x in body["items"]] == [p["id"]]
    assert admin.get(f"{API}/parts?q=low-1").json["items"][0]["id"] == p["id"]
    assert {x["name"] for x in admin.get(f"{API}/parts?non_stock=1").json["items"]} == {"Grease tube"}
    names = [x["on_hand"] for x in admin.get(f"{API}/parts?sort=-on_hand&non_stock=0").json["items"]]
    assert names == sorted(names, key=float, reverse=True)
    rows = admin.get(f"{API}/parts?per_location=1&location_id={wh}").json
    assert rows["total"] >= 1
    # saved filter presets (r226)
    pr = admin.post(f"{API}/parts/presets", {"name": "Restock", "filters": {"stock": "needs_restock"}})
    assert pr.status_code == 201, pr.json
    assert [x["name"] for x in admin.get(f"{API}/parts/presets").json["items"]] == ["Restock"]
    assert admin.delete(f"{API}/parts/presets/{pr.json['id']}").status_code == 204
    # global search provider (r225)
    hits = admin.get(f"{API}/search?q=low-1").json
    assert any(i["url"] == f"/parts/{p['id']}" for grp in hits["groups"] for i in grp["results"])


def test_restock_adjust_transfer_and_transactions(admin: Api) -> None:
    p, wh = stocked(admin)
    van = loc(admin, "Van 1")
    r = admin.post(f"{API}/parts/{p['id']}/restock", {"location_id": wh, "quantity": "5", "unit_cost": "4.00"})
    assert r.status_code == 200 and r.json["on_hand"] == "15"
    r = admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "quantity": "12", "note": "Recount"})
    assert r.json["on_hand"] == "12"
    assert admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "quantity": "abc"}).status_code == 422
    r = admin.post(
        f"{API}/parts/{p['id']}/transfer", {"from_location_id": wh, "to_location_id": van["id"], "quantity": "2"}
    )
    assert r.status_code == 200, r.json
    assert (
        stock_at(r.json, wh)["on_hand"] == "10"
        and stock_at(r.json, van["id"])["on_hand"] == "2"
        and r.json["on_hand"] == "12"
    )
    txns = admin.get(f"{API}/parts/transactions?part_id={p['id']}&limit=2").json
    assert len(txns["items"]) == 2 and txns["next_cursor"]
    more = admin.get(f"{API}/parts/transactions?part_id={p['id']}&limit=50&cursor={txns['next_cursor']}").json["items"]
    kinds = [t["kind"] for t in txns["items"] + more]
    assert set(kinds) == {"initial", "restock", "adjust", "transfer_out", "transfer_in"}
    # ledger and cached sums agree
    with admin.c.application.app_context():
        import uuid

        from mpro.extensions import db
        from mpro.parts import ledger
        from mpro.parts.models import Part

        pp = db.session.get(Part, uuid.UUID(p["id"]))
        assert pp is not None and ledger.recompute(pp.org_id, pp.id) == 12


def test_negative_stock_rules(admin: Api) -> None:
    p, wh = stocked(admin, "1")
    wo = create_wo(admin)
    # not allowed by default
    r = admin.post(f"{API}/work-orders/{wo['id']}/parts", {"part_id": p["id"], "quantity": "3", "location_id": wh})
    assert r.status_code == 409
    assert (
        admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "change": "-2", "note": "x"}).status_code == 409
    )
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "1"
    # when allowed, stock goes negative and is flagged
    admin.patch(f"{API}/parts/settings", {"allow_negative_stock": True})
    r = admin.post(f"{API}/work-orders/{wo['id']}/parts", {"part_id": p["id"], "quantity": "3", "location_id": wh})
    assert r.status_code == 201, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "-2" and stock_at(d, wh)["negative"] and d["negative"]


def test_work_order_parts_reserve_issue_return_and_done(admin: Api) -> None:
    a = asset(admin, "Conveyor 9")
    p, wh = stocked(admin, "10")
    wo = create_wo(admin, asset_id=a["id"])
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/parts",
        {"part_id": p["id"], "quantity": "4", "location_id": wh, "status": "reserved"},
    )
    assert r.status_code == 201, r.json
    line = r.json["items"][0]
    assert line["status"] == "reserved" and line["availability"]["state"] == "available"
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "10" and d["reserved"] == "4" and d["available"] == "6"
    # costs show with costs.view
    assert r.json["total_cost"] == "10.00"
    # use 1 now, then complete: the rest is issued (r042) and the part links to the asset (r215)
    r = admin.patch(f"{API}/work-orders/{wo['id']}/parts/{line['id']}", {"quantity": "4", "status": "issued"})
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "6"
    r = admin.post(f"{API}/work-orders/{wo['id']}/parts/{line['id']}/return", {"quantity": "1"})
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "7"
    wo2 = create_wo(admin, asset_id=a["id"])
    admin.post(
        f"{API}/work-orders/{wo2['id']}/parts",
        {"part_id": p["id"], "quantity": "2", "location_id": wh, "status": "reserved"},
    )
    r = admin.post(f"{API}/work-orders/{wo2['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "5" and d["reserved"] == "0"
    assert a["id"] in {x["id"] for x in d["assets"]}
    costs = admin.get(f"{API}/work-orders/{wo2['id']}").json["costs"]
    assert costs.get("parts_cents") == 500
    # can't delete a part held on an open work order
    wo3 = create_wo(admin)
    admin.post(
        f"{API}/work-orders/{wo3['id']}/parts",
        {"part_id": p["id"], "quantity": "1", "location_id": wh, "status": "reserved"},
    )
    assert admin.delete(f"{API}/parts/{p['id']}").status_code == 409
    admin.post(f"{API}/work-orders/{wo3['id']}/status", {"status": "canceled", "comment": "Not needed"})
    assert admin.get(f"{API}/parts/{p['id']}").json["reserved"] == "0"


def test_create_work_order_with_parts(admin: Api) -> None:
    p, wh = stocked(admin, "3")
    wo = create_wo(admin, parts=[{"part_id": p["id"], "quantity": "5"}])
    items = admin.get(f"{API}/work-orders/{wo['id']}/parts").json["items"]
    assert len(items) == 1 and items[0]["status"] == "assigned" and items[0]["quantity"] == "5"


def test_low_stock_alert_hooks_and_escalation(app: Any, admin: Api) -> None:
    from mpro.parts import hooks

    seen: list[str] = []
    hooks.LOW_STOCK_HOOKS.append(lambda org_id, p, st: seen.append(p.name))
    try:
        crit = admin.post(f"{API}/part-types", {"name": "Critical spares", "critical": True}).json
        team = team_id(admin, "Mechanical")
        admin.patch(f"{API}/parts/settings", {"escalation_team_ids": [team]})
        p, wh = stocked(admin, "5", type_ids=[crit["id"]])
        admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "quantity": "3", "note": "used"})
        admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "quantity": "2", "note": "used"})
        assert seen == [p["name"]]  # alerts once until stock recovers
        admin.post(f"{API}/parts/{p['id']}/restock", {"location_id": wh, "quantity": "10"})
        admin.post(f"{API}/parts/{p['id']}/adjust", {"location_id": wh, "quantity": "1", "note": "used"})
        assert seen == [p["name"], p["name"]]
        with app.app_context():
            from sqlalchemy import select

            from mpro.core.mail import OutboundEmail
            from mpro.extensions import db

            subjects = db.session.scalars(select(OutboundEmail.subject)).all()
            assert any("Critical part running low" in s for s in subjects)
    finally:
        hooks.LOW_STOCK_HOOKS.pop()


def test_cycle_count_creates_wo_and_applies_corrections(admin: Api) -> None:
    p, wh = stocked(admin, "10")
    c = admin.post(
        f"{API}/cycle-counts",
        {"name": "Storeroom weekly", "location_id": wh, "selection": {"all": True}, "rrule": "FREQ=WEEKLY;BYDAY=MO"},
    )
    assert c.status_code == 201, c.json
    assert admin.post(f"{API}/cycle-counts", {"name": "Bad", "rrule": "nonsense"}).status_code == 422
    run = admin.post(f"{API}/cycle-counts/{c.json['id']}/start")
    assert run.status_code == 201, run.json
    run = run.json
    assert run["work_order_id"] and run["progress"] == {"counted": 0, "total": 1}
    line = run["lines"][0]
    r = (
        admin.put(
            f"{API}/cycle-count-runs/{run['id']}/lines/{line['id']}", json={"counted": "8", "note": "two missing"}
        )
        if hasattr(admin, "put")
        else admin.c.put(
            f"{API}/cycle-count-runs/{run['id']}/lines/{line['id']}",
            json={"counted": "8", "note": "two missing"},
            headers=admin._h(),
        )
    )
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/work-orders/{run['work_order_id']}/cycle-count").json["run"]["progress"]["counted"] == 1
    # finishing the work order applies the count as a "count" correction (r222)
    assert admin.post(f"{API}/work-orders/{run['work_order_id']}/status", {"status": "done"}).status_code == 200
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "8"
    kinds = [t["kind"] for t in admin.get(f"{API}/parts/transactions?part_id={p['id']}").json["items"]]
    assert "count" in kinds


def test_exports(admin: Api) -> None:
    stocked(admin, "3")
    for report in ("parts", "transactions", "valuation", "slow_moving"):
        r = admin.post(f"{API}/parts/export", {"report": report, "query": {}})
        assert r.status_code == 202, (report, r.json)
        got = admin.get(f"{API}/exports/{r.json['id']}").json
        assert got["status"] == "ready", (report, got)
        body = admin.get(got["file"]["url"]).data.decode("utf-8-sig")
        assert body.count("\n") >= 2, (report, body)
    assert admin.post(f"{API}/parts/export", {"report": "nope"}).status_code == 422


def test_qr_label_and_barcode_scan(admin: Api) -> None:
    p, _ = stocked(admin, barcode="4006381333931")
    r = admin.get(f"{API}/scan?value=4006381333931").json
    assert r["status"] == "found" and r["entity_type"] == "part" and r["entity_id"] == p["id"]
    r = admin.post(f"{API}/qr-codes", {"entity_type": "part", "entity_id": p["id"]})
    assert r.status_code in (200, 201), r.json
    assert admin.get(f"{API}/qr-codes/for/part/{p['id']}").json["items"]
    r = admin.c.post(
        f"{API}/labels",
        json={"entity_type": "part", "query": {"q": p["name"]}, "format": "sheet", "template": "avery_5160"},
        headers=admin._h(),
    )
    assert r.status_code == 200 and r.data[:5] == b"%PDF-", r.data[:200]


def test_roles_and_cost_visibility(app: Any, admin: Api) -> None:
    p, wh = stocked(admin)
    tech = member(app, "tech@example.com", "technician", admin)
    d = tech.get(f"{API}/parts/{p['id']}").json
    assert d["unit_cost"] is None and d["on_hand"] == "10"
    assert tech.post(f"{API}/parts/{p['id']}/restock", {"location_id": wh, "quantity": "1"}).status_code == 200
    assert tech.post(f"{API}/parts/export", {"report": "valuation"}).status_code == 403
    assert tech.delete(f"{API}/parts/{p['id']}").status_code == 403
    assert tech.patch(f"{API}/parts/settings", {"allow_negative_stock": False}).status_code == 403
    viewer = member(app, "viewer@example.com", "viewer", admin)
    assert viewer.get(f"{API}/parts").status_code == 200
    assert viewer.post(f"{API}/parts", {"name": "x"}).status_code == 403
    assert viewer.post(f"{API}/parts/{p['id']}/restock", {"location_id": wh, "quantity": "1"}).status_code == 403


def test_other_org_cannot_reach_parts(app: Any, admin: Api) -> None:
    p, wh = stocked(admin)
    wo = create_wo(admin)
    line = admin.post(
        f"{API}/work-orders/{wo['id']}/parts", {"part_id": p["id"], "quantity": "1", "location_id": wh}
    ).json["items"][0]
    c = admin.post(f"{API}/cycle-counts", {"name": "C", "location_id": wh, "selection": {"all": True}}).json
    t = admin.post(f"{API}/part-types", {"name": "Mine"}).json
    other = other_org(app)
    pid = p["id"]
    assert other.get(f"{API}/parts/{pid}").status_code == 404
    assert other.patch(f"{API}/parts/{pid}", {"name": "x"}).status_code == 404
    assert other.delete(f"{API}/parts/{pid}").status_code == 404
    assert other.post(f"{API}/parts/{pid}/restock", {"quantity": "1"}).status_code == 404
    assert other.post(f"{API}/parts/{pid}/adjust", {"quantity": "1"}).status_code == 404
    assert other.post(f"{API}/parts/{pid}/transfer", {"quantity": "1"}).status_code == 404
    assert other.get(f"{API}/parts/{pid}/history").status_code == 404
    assert other.get(f"{API}/parts").json["items"] == []
    assert other.get(f"{API}/parts/transactions?part_id={pid}").json["items"] == []
    assert other.get(f"{API}/work-orders/{wo['id']}/parts").status_code == 404
    assert other.patch(f"{API}/work-orders/{wo['id']}/parts/{line['id']}", {"quantity": "2"}).status_code == 404
    assert other.get(f"{API}/cycle-counts/{c['id']}").status_code == 404
    assert other.post(f"{API}/cycle-counts/{c['id']}/start").status_code == 404
    assert other.patch(f"{API}/part-types/{t['id']}", {"name": "x"}).status_code == 404
    # ids from another org in request bodies are rejected (G-15)
    mine = other.post(f"{API}/parts", {"name": "Theirs"}).json
    assert other.post(f"{API}/parts", {"name": "Bad", "type_ids": [t["id"]]}).status_code == 422
    assert other.post(f"{API}/parts/{mine['id']}/restock", {"location_id": wh, "quantity": "1"}).status_code in (
        404,
        422,
    )
    own_wo = create_wo(other)
    assert other.post(f"{API}/work-orders/{own_wo['id']}/parts", {"part_id": pid, "quantity": "1"}).status_code in (
        404,
        422,
    )
    assert other.get(f"{API}/scan?value=x").status_code == 200


def test_demo_seed(app: Any) -> None:
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.auth.models import User
        from mpro.demo import DEMO_EMAIL
        from mpro.extensions import db
        from mpro.orgs.models import Organization
        from mpro.parts.demo import seed_parts
        from mpro.parts.models import Part

        admin = db.session.scalars(select(User).where(User.email == DEMO_EMAIL)).one()
        org = db.session.scalars(select(Organization)).first()
        seed_parts(org, admin)
        assert db.session.scalar(select(func.count()).select_from(Part).where(Part.org_id == org.id)) >= 10
        seed_parts(org, admin)  # idempotent
