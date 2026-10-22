"""Automations (0.4.0, MP-117) and the 0.3.0 follow-ups (MP-119)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

from tests.conftest import Api
from tests.test_assets import asset, other_org
from tests.test_work_orders import login, team_id

API = "/api/v1"


def meter(api: Api, name: str = "Bearing temp", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/meters", {"name": name, "unit": "°C", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def auto(api: Api, **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/automations", {"name": "Test", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def read(api: Api, m: dict[str, Any], *values: float) -> None:
    for v in values:
        assert api.post(f"{API}/meters/{m['id']}/readings", {"value": v}).status_code == 201


def wos(api: Api, q: str) -> list[dict[str, Any]]:
    return api.get(f"{API}/work-orders?tab=all&q={q}").json["items"]  # type: ignore[no-any-return]


def wo_action(title: str, **kw: Any) -> list[dict[str, Any]]:
    return [{"type": "create_work_order", "title": title, **kw}]


def meter_trigger(cond: str, value: float, **kw: Any) -> dict[str, Any]:
    return {"type": "meter_reading", "condition": cond, "value": value, **kw}


def test_threshold_once_then_rearm_and_duplicate_guard(admin: Api) -> None:
    a = asset(admin)
    m = meter(admin, asset_id=a["id"])
    x = auto(
        admin,
        trigger=meter_trigger("above", 80),
        targets=[m["id"]],
        actions=wo_action("Hot {meter} {value}", priority="high"),
    )
    assert x["summary"].startswith("When Bearing temp is above 80 °C")
    read(admin, m, 70, 85)
    items = wos(admin, "Hot")
    assert len(items) == 1 and items[0]["title"] == "Hot Bearing temp 85" and items[0]["asset"]["id"] == a["id"]
    read(admin, m, 90)  # still hot: once mode doesn't fire again
    read(admin, m, 60, 95)  # rearmed, but the first WO is still open: skipped
    assert len(wos(admin, "Hot")) == 1
    runs = admin.get(f"{API}/automations/{x['id']}/runs").json["items"]
    assert runs[0]["status"] == "skipped" and "still open" in runs[0]["results"][0]["message"]
    assert runs[-1]["results"][0]["work_order_number"] == items[0]["number"]
    admin.post(f"{API}/work-orders/{items[0]['id']}/status", {"status": "done"})
    read(admin, m, 60, 96)
    assert len(wos(admin, "Hot")) == 2
    d = admin.get(f"{API}/automations/{x['id']}").json
    assert d["run_count"] == 2 and d["skip_count"] == 1 and d["next_expected"][0]["value"] == 80


def test_every_mode_and_rerun_interval(admin: Api) -> None:
    m = meter(admin)
    x = auto(
        admin,
        trigger=meter_trigger("below", 5),
        targets=[m["id"]],
        sensitivity={"mode": "every"},
        actions=[{"type": "send_email", "recipients": [f"team:{team_id(admin, 'HVAC')}"], "subject": "Cold {meter}"}],
        rerun_minutes=60,
    )
    read(admin, m, 2, 1)
    d = admin.get(f"{API}/automations/{x['id']}").json
    assert d["run_count"] == 1 and d["skip_count"] == 1
    emails = admin.get(f"{API}/outbox").json["items"]
    assert any(e["subject"] == "Cold Bearing temp" for e in emails)


def test_n_of_m(admin: Api) -> None:
    m = meter(admin)
    auto(
        admin,
        trigger=meter_trigger("above", 10),
        targets=[m["id"]],
        sensitivity={"mode": "n_of_m", "n": 3, "m": 5},
        actions=wo_action("Vibration"),
    )
    read(admin, m, 11, 5, 12)
    assert wos(admin, "Vibration") == []
    read(admin, m, 13)  # 3 of the last 4
    assert len(wos(admin, "Vibration")) == 1
    read(admin, m, 14)  # still enough: no new one
    assert len(wos(admin, "Vibration")) == 1


def test_duration_mode_with_periodic_check(app: Any, admin: Api) -> None:
    m = meter(admin)
    x = auto(
        admin,
        trigger=meter_trigger("above", 100),
        targets=[m["id"]],
        sensitivity={"mode": "duration", "minutes": 30},
        actions=wo_action("Long hot"),
    )
    read(admin, m, 120)
    assert wos(admin, "Long") == []
    with app.app_context():
        import uuid

        from sqlalchemy import select

        from mpro.automations.models import AutomationState
        from mpro.automations.services import check_durations
        from mpro.extensions import db

        st = db.session.scalars(
            select(AutomationState).where(AutomationState.automation_id == uuid.UUID(x["id"]))
        ).one()
        st.state = {**st.state, "since": (datetime.now(UTC) - timedelta(minutes=31)).isoformat()}
        db.session.commit()
        assert check_durations() == 1
    assert len(wos(admin, "Long")) == 1
    assert admin.get(f"{API}/automations/{x['id']}").json["run_count"] == 1


def test_increases_by_recurring_and_from_last(admin: Api) -> None:
    m = meter(admin, name="Run hours")
    auto(
        admin, trigger=meter_trigger("increases_by", 250, first_at=500), targets=[m["id"]], actions=wo_action("Service")
    )
    read(admin, m, 100, 499)
    assert wos(admin, "Service") == []
    read(admin, m, 1100)  # jumps past 500 and 750 and 1000: one work order, next milestone 1250
    assert len(wos(admin, "Service")) == 1
    m2 = meter(admin, name="Pressure")
    auto(
        admin,
        trigger=meter_trigger("decreases_from_last", 20),
        targets=[m2["id"]],
        sensitivity={"mode": "every"},
        actions=wo_action("Pressure drop"),
    )
    read(admin, m2, 100, 90, 60)
    assert len(wos(admin, "Pressure%20drop")) == 1


def test_asset_status_trigger_with_conditions_and_chain_guard(admin: Api) -> None:
    a = asset(admin, "Pump 9")
    x = auto(
        admin,
        trigger={"type": "asset_status", "to": ["offline"]},
        targets=[a["id"]],
        actions=wo_action("{asset} down", priority="high"),
    )
    assert "goes to Offline" in x["summary"]
    admin.post(f"{API}/assets/{a['id']}/status", {"status": "offline"})
    assert wos(admin, "Pump%209%20down")[0]["priority"] == "high"
    # a weekday condition that never holds today skips
    today = datetime.now(UTC).weekday()
    admin.patch(f"{API}/automations/{x['id']}", {"conditions": [{"type": "weekday", "days": [(today + 3) % 7]}]})
    admin.post(f"{API}/assets/{a['id']}/status", {"status": "online"})
    admin.post(f"{API}/assets/{a['id']}/status", {"status": "offline"})
    runs = admin.get(f"{API}/automations/{x['id']}/runs?status=skipped").json["items"]
    assert runs and "weekday" in runs[0]["message"]
    # two automations flipping the status back and forth stop after a few hops
    b = asset(admin, "Flip")
    auto(
        admin,
        trigger={"type": "asset_status", "to": ["offline"]},
        targets=[b["id"]],
        actions=[{"type": "change_asset_status", "status": "online"}],
    )
    auto(
        admin,
        trigger={"type": "asset_status", "to": ["online"]},
        targets=[b["id"]],
        actions=[{"type": "change_asset_status", "status": "offline"}],
    )
    assert admin.post(f"{API}/assets/{b['id']}/status", {"status": "offline"}).status_code == 200


def test_work_order_status_trigger(admin: Api) -> None:
    a = asset(admin, "Chiller 9")
    auto(
        admin,
        trigger={"type": "work_order_status", "to": ["done"], "priorities": ["high"]},
        targets=[a["id"]],
        actions=wo_action("Follow-up on {asset}"),
    )
    low = admin.post(f"{API}/work-orders", {"title": "Low job", "asset_id": a["id"], "priority": "low"}).json
    admin.post(f"{API}/work-orders/{low['id']}/status", {"status": "done"})
    assert wos(admin, "Follow-up") == []
    hi = admin.post(f"{API}/work-orders", {"title": "Big job", "asset_id": a["id"], "priority": "high"}).json
    admin.post(f"{API}/work-orders/{hi['id']}/status", {"status": "done"})
    f = wos(admin, "Follow-up")
    assert len(f) == 1 and f[0]["title"] == "Follow-up on Chiller 9"
    # the follow-up itself doesn't trigger the automation again
    admin.patch(f"{API}/work-orders/{f[0]['id']}", {"priority": "high"})
    admin.post(f"{API}/work-orders/{f[0]['id']}/status", {"status": "done"})
    assert len(wos(admin, "Follow-up")) == 1


def test_multi_target_state_template_action_and_copy(admin: Api) -> None:
    ms = [meter(admin, name=f"Temp {i}") for i in range(3)]
    t = admin.post(
        f"{API}/work-order-templates",
        {"name": "Hot tpl", "data": {"title": "From template", "priority": "medium", "due_in_days": 2}},
    ).json
    x = auto(
        admin,
        trigger=meter_trigger("above", 50),
        targets=[m["id"] for m in ms],
        actions=[{"type": "create_work_order", "template_id": t["id"]}],
    )
    read(admin, ms[0], 60)
    read(admin, ms[1], 70)
    items = wos(admin, "From%20template")
    assert len(items) == 2 and items[0]["priority"] == "medium" and items[0]["due_at"]
    c = admin.post(f"{API}/automations/{x['id']}/copy").json
    assert c["name"] == "Copy - Test" and c["active"] is False and len(c["targets"]) == 3
    r = admin.post(f"{API}/automations/bulk", {"ids": [x["id"], c["id"]], "action": "disable"}).json
    assert len(r["done"]) == 2
    read(admin, ms[2], 99)
    assert len(wos(admin, "From%20template")) == 2  # disabled
    assert admin.get(f"{API}/automations?meter_id={ms[2]['id']}").json["total"] == 2
    admin.post(f"{API}/automations/bulk", {"ids": [c["id"]], "action": "delete"})
    assert admin.get(f"{API}/automations").json["total"] == 1


def test_validation(admin: Api) -> None:
    m = meter(admin)
    base = {"name": "x", "trigger": meter_trigger("above", 1), "targets": [m["id"]], "actions": wo_action("t")}
    assert admin.post(f"{API}/automations", {**base, "targets": []}).status_code == 422
    assert admin.post(f"{API}/automations", {**base, "targets": [m["id"]] * 251}).status_code == 422
    assert admin.post(f"{API}/automations", {**base, "trigger": {"type": "nope"}}).status_code == 422
    assert admin.post(f"{API}/automations", {**base, "trigger": meter_trigger("above", "hot")}).status_code == 422
    assert admin.post(f"{API}/automations", {**base, "actions": []}).status_code == 422
    assert (
        admin.post(
            f"{API}/automations", {**base, "actions": [{"type": "send_email", "recipients": [], "subject": "s"}]}
        ).status_code
        == 422
    )
    assert (
        admin.post(f"{API}/automations", {**base, "sensitivity": {"mode": "n_of_m", "n": 6, "m": 5}}).status_code == 422
    )
    assert (
        admin.post(
            f"{API}/automations", {**base, "conditions": [{"type": "time_window", "from": "9", "to": "17:00"}]}
        ).status_code
        == 422
    )
    assert (
        admin.post(
            f"{API}/automations", {**base, "actions": [{"type": "change_asset_status", "status": "broken"}]}
        ).status_code
        == 422
    )
    d = admin.post(f"{API}/automations/describe", base).json
    assert d["summary"].startswith("When Bearing temp is above 1")


def test_permissions_and_tenancy(app: Any, admin: Api) -> None:
    m = meter(admin)
    x = auto(admin, trigger=meter_trigger("above", 1), targets=[m["id"]], actions=wo_action("t"))
    tech = login(app, "avery.kim@example.com")
    assert tech.get(f"{API}/automations").status_code == 200
    assert tech.post(f"{API}/automations", {"name": "x"}).status_code == 403
    assert tech.delete(f"{API}/automations/{x['id']}").status_code == 403
    requester = login(app, "jamie.ortiz@example.com")
    assert requester.get(f"{API}/automations").status_code == 403
    other = other_org(app)
    assert other.get(f"{API}/automations/{x['id']}").status_code == 404
    om = other.post(f"{API}/meters", {"name": "Theirs", "unit": "psi"}).json
    # another org's meter, template or team can't be used
    assert (
        other.post(
            f"{API}/automations",
            {"name": "x", "trigger": meter_trigger("above", 1), "targets": [m["id"]], "actions": wo_action("t")},
        ).status_code
        == 422
    )
    assert (
        other.post(
            f"{API}/automations",
            {
                "name": "x",
                "trigger": meter_trigger("above", 1),
                "targets": [om["id"]],
                "actions": [{"type": "send_email", "subject": "s", "recipients": [f"team:{team_id(admin, 'HVAC')}"]}],
            },
        ).status_code
        == 422
    )
    assert other.post(f"{API}/automations/bulk", {"ids": [x["id"]], "action": "delete"}).json["done"] == []


def test_legacy_conversion(app: Any, admin: Api) -> None:
    m = meter(admin, name="Hours")
    with app.app_context():
        import uuid
        from decimal import Decimal

        from mpro.automations.services import convert_legacy_triggers
        from mpro.extensions import db
        from mpro.meters.models import Meter, MeterTrigger

        mt = db.session.get(Meter, uuid.UUID(m["id"]))
        assert mt is not None
        db.session.add(
            MeterTrigger(
                org_id=mt.org_id,
                meter_id=mt.id,
                name="Hot",
                kind="threshold",
                comparator="gt",
                threshold=Decimal(80),
                work_order={"title": "Legacy hot"},
                active=True,
                fired_count=0,
                last_note="",
            )
        )
        db.session.add(
            MeterTrigger(
                org_id=mt.org_id,
                meter_id=mt.id,
                name="Every",
                kind="every",
                comparator="gt",
                every_units=Decimal(100),
                next_at=Decimal(200),
                work_order={"title": "Legacy every"},
                active=True,
                fired_count=0,
                last_note="",
            )
        )
        db.session.commit()
        assert convert_legacy_triggers() == 2
        assert convert_legacy_triggers() == 0  # once only
        db.session.commit()
    items = admin.get(f"{API}/automations").json["items"]
    assert {i["name"] for i in items} == {"Hot", "Every"} and all(i["legacy"] for i in items)
    read(admin, m, 150, 201, 90)
    assert len(wos(admin, "Legacy%20every")) == 1 and len(wos(admin, "Legacy%20hot")) == 1


def test_warranty_reminders(app: Any, admin: Api) -> None:
    soon = (date.today() + timedelta(days=20)).isoformat()
    a = asset(admin, "Boiler 9", warranty_end=soon, teams=[team_id(admin, "HVAC")])
    asset(admin, "Far away", warranty_end=(date.today() + timedelta(days=200)).isoformat())
    with app.app_context():
        from mpro.automations.services import warranty_reminders

        assert warranty_reminders() == 1
        assert warranty_reminders() == 0  # once per warranty end date
    emails = admin.get(f"{API}/outbox").json["items"]
    sent = [e for e in emails if e["subject"] == "Warranty ending soon: Boiler 9"]
    assert sent and all(e["to"] != "admin@example.com" for e in sent)  # the HVAC team, not the owner
    assert f"/assets/{a['id']}" in sent[0]["body"]
