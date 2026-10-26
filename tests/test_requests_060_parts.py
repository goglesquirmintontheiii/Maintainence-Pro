# ruff: noqa: E501
"""Requests from 0.5 testing (0.6.0, MP-131): Planned / Reserved / Used only, Done uses up planned parts (with
shortfalls flagged), part pictures."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_assets import other_org, upload
from tests.test_parts import part, stocked
from tests.test_work_orders import create as create_wo

API = "/api/v1"


def add(admin: Api, wo: dict[str, Any], p: dict[str, Any], wh: str, qty: str, status: str) -> dict[str, Any]:
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/parts",
        {"part_id": p["id"], "quantity": qty, "location_id": wh, "status": status},
    )
    assert r.status_code == 201, r.json
    return next(x for x in r.json["items"] if x["part"]["id"] == p["id"])


def lines(admin: Api, wo: dict[str, Any]) -> list[dict[str, Any]]:
    return admin.get(f"{API}/work-orders/{wo['id']}/parts").json["items"]  # type: ignore[no-any-return]


def test_only_planned_reserved_and_used(admin: Api) -> None:
    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    for st in ("kitted", "staged"):
        r = admin.post(
            f"{API}/work-orders/{wo['id']}/parts",
            {"part_id": p["id"], "quantity": "1", "location_id": wh, "status": st},
        )
        assert r.status_code == 422, (st, r.json)
    line = add(admin, wo, p, wh, "1", "reserved")
    assert admin.patch(f"{API}/work-orders/{wo['id']}/parts/{line['id']}", {"status": "kitted"}).status_code == 422
    assert {"assigned", "reserved", "issued"} >= {x["status"] for x in lines(admin, wo)}


def test_done_uses_planned_and_reserved_and_undo_puts_them_back(admin: Api) -> None:
    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    add(admin, wo, p, wh, "3", "assigned")
    add(admin, wo, p, wh, "2", "reserved")
    assert admin.get(f"{API}/parts/{p['id']}").json["reserved"] == "2"
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "5" and d["reserved"] == "0"
    ls = lines(admin, wo)
    assert all(x["status"] == "issued" for x in ls) and sorted(x["used"] for x in ls) == ["2", "3"]
    assert all(x["shortfall"] == "0" for x in ls)
    # reopening reverses exactly what Done used, and the lines go back to Planned / Reserved
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "open"})
    assert r.status_code == 200, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["on_hand"] == "10" and d["reserved"] == "2"
    assert sorted((x["status"], x["used"]) for x in lines(admin, wo)) == [("assigned", "0"), ("reserved", "0")]


def test_parts_used_before_done_stay_used_when_reopened(admin: Api) -> None:
    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    add(admin, wo, p, wh, "4", "issued")
    admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "open"})
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "6"
    assert [(x["status"], x["used"]) for x in lines(admin, wo)] == [("issued", "4")]


def test_done_with_too_little_stock_uses_what_is_there_and_flags_it(admin: Api) -> None:
    p, wh = stocked(admin, "3")
    wo = create_wo(admin)
    add(admin, wo, p, wh, "5", "assigned")
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json  # never blocks completion
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "0"
    (x,) = lines(admin, wo)
    assert x["status"] == "issued" and x["used"] == "3" and x["shortfall"] == "2"
    feed = admin.get(f"{API}/work-orders/{wo['id']}/activity").json["items"]
    assert any(e.get("type") == "wo.parts_short" and "2" in e["summary"] for e in feed)
    # undo gives back the 3 and clears the flag
    admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "in_progress"})
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "3"
    (x,) = lines(admin, wo)
    assert x["status"] == "assigned" and x["used"] == "0" and x["shortfall"] == "0"


def test_done_with_negative_stock_allowed_uses_everything(admin: Api) -> None:
    admin.patch(f"{API}/parts/settings", {"allow_negative_stock": True})
    p, wh = stocked(admin, "3")
    wo = create_wo(admin)
    add(admin, wo, p, wh, "5", "reserved")
    admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "-2"
    assert lines(admin, wo)[0]["shortfall"] == "0"


def test_kitted_and_staged_rows_migrate_to_reserved(app: Any, admin: Api) -> None:
    """The 0011 data step: older kitted/staged lines become reserved (and still count as held)."""
    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    line = add(admin, wo, p, wh, "2", "reserved")
    with app.app_context():
        import uuid

        from sqlalchemy import text

        from mpro.extensions import db
        from mpro.parts.services import refresh_reserved

        db.session.execute(
            text("UPDATE work_order_parts SET status='kitted' WHERE id=:i"),
            {"i": uuid.UUID(line["id"]).hex if db.engine.dialect.name == "sqlite" else line["id"]},
        )
        db.session.commit()
        from importlib import import_module

        mig = import_module("mpro.migrations.versions.0011_platform")
        with db.engine.begin() as conn:
            mig.normalize_part_statuses(conn)
        refresh_reserved(
            uuid.UUID(admin.get(f"{API}/auth/session").json["org"]["id"]), uuid.UUID(p["id"]), uuid.UUID(wh)
        )
        db.session.commit()
    assert lines(admin, wo)[0]["status"] == "reserved"
    assert admin.get(f"{API}/parts/{p['id']}").json["reserved"] == "2"


# ---- pictures ----------------------------------------------------------------------------------
def test_part_picture_set_change_remove_and_shown_on_lists(admin: Api) -> None:
    p = part(admin, "Drive belt")
    fid = upload(admin)
    r = admin.patch(f"{API}/parts/{p['id']}", {"picture_file_id": fid})
    assert r.status_code == 200, r.json
    d = admin.get(f"{API}/parts/{p['id']}").json
    assert d["picture"] and d["picture"]["id"] == fid and d["picture"]["thumb_url"]
    row = next(x for x in admin.get(f"{API}/parts?q=Drive").json["items"] if x["id"] == p["id"])
    assert row["picture"] and row["picture"]["id"] == fid
    wo = create_wo(admin)
    assert (
        admin.post(
            f"{API}/work-orders/{wo['id']}/parts", {"part_id": p["id"], "quantity": "1", "status": "assigned"}
        ).status_code
        == 201
    )
    assert lines(admin, wo)[0]["part"]["picture"]["id"] == fid
    assert admin.patch(f"{API}/parts/{p['id']}", {"picture_file_id": None}).status_code == 200
    assert admin.get(f"{API}/parts/{p['id']}").json["picture"] is None


def test_part_picture_from_another_org_is_refused(app: Any, admin: Api) -> None:
    p = part(admin, "Seal kit")
    other = other_org(app)
    fid = upload(other, "theirs.png")
    r = admin.patch(f"{API}/parts/{p['id']}", {"picture_file_id": fid})
    assert r.status_code in (404, 422), r.json
