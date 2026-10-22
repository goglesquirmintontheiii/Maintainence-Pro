# ruff: noqa: E501  (long API calls read better on one line)
"""Preventive maintenance (0.4.0): maintenance plans, nested PMs, usage-based PMs, repeating work orders,
skip/postpone and compliance, calendar rules and sub-work orders."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from tests.conftest import Api
from tests.test_assets import asset, other_org
from tests.test_work_orders import login, uid

API = "/api/v1"
TZ = ZoneInfo("America/Chicago")  # the demo organization's time zone


def local_at(days: int, hour: int = 8) -> str:
    """ISO time `days` from today at hour:00 in the demo org's time zone."""
    d = datetime.now(TZ).date() + timedelta(days=days)
    return datetime(d.year, d.month, d.day, hour, 0, tzinfo=TZ).isoformat()


def plan(api: Api, **kw: Any) -> dict[str, Any]:
    body = {
        "name": "Chiller PM",
        "horizon_days": 40,
        "tasks": [{"name": "Monthly", "spec": {"freq": "monthly"}, "anchor": local_at(3)}],
        **kw,
    }
    r = api.post(f"{API}/pm/plans", body)
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def put(api: Api, url: str, json: Any) -> Any:
    return api.c.put(url, json=json, headers=api._h())


def wos_of(api: Api, q: str) -> list[dict[str, Any]]:
    return api.get(f"{API}/work-orders?tab=all&per_page=200&q={q}").json["items"]  # type: ignore[no-any-return]


# ---- recurrence maths ------------------------------------------------------------------------------
def test_schedule_is_dst_safe_and_shifts_for_calendar() -> None:
    from mpro.pm import schedule as sch

    anchor = datetime(2026, 10, 26, 13, 0, tzinfo=UTC)  # Monday 08:00 CDT
    dues = sch.expand("FREQ=WEEKLY;BYDAY=MO", anchor, TZ, anchor, anchor + timedelta(days=15))
    assert [d.astimezone(TZ).hour for d in dues] == [8, 8, 8]  # stays 08:00 after DST ends on Nov 1
    assert dues[1] == datetime(2026, 11, 2, 14, 0, tzinfo=UTC)
    sat = datetime(2026, 11, 7, 14, 0, tzinfo=UTC)
    assert sch.apply_calendar(sat, {"skip_weekends": True, "shift": "previous"}, TZ, set()).astimezone(
        TZ
    ).date() == date(2026, 11, 6)
    assert sch.apply_calendar(sat, {"skip_weekends": True, "shift": "next"}, TZ, set()).astimezone(TZ).date() == date(
        2026, 11, 9
    )
    assert sch.apply_calendar(sat, {"skip_weekends": True, "shift": "skip"}, TZ, set()) is None
    fri = datetime(2026, 11, 6, 14, 0, tzinfo=UTC)
    assert sch.apply_calendar(fri, {"skip_holidays": True, "shift": "next"}, TZ, {date(2026, 11, 6)}).astimezone(
        TZ
    ).date() == date(2026, 11, 7)
    assert sch.apply_calendar(fri, {"months": [4, 5, 6]}, TZ, set()) is None
    assert sch.describe({"freq": "weekly", "interval": 2, "weekdays": [0, 3]}) == "Every 2 weeks on Mon, Thu"
    assert (
        sch.build_rrule({"freq": "monthly", "monthly": "by_weekday"}, datetime(2026, 10, 29, 8))
        == "FREQ=MONTHLY;INTERVAL=1;BYDAY=-1TH"
    )
    assert (
        sch.build_rrule({"freq": "monthly", "monthly": "by_weekday"}, datetime(2026, 10, 15, 8))
        == "FREQ=MONTHLY;INTERVAL=1;BYDAY=3TH"
    )


# ---- maintenance plans -----------------------------------------------------------------------------
def test_nested_tasks_merge_and_generation_is_idempotent(app: Any, admin: Api) -> None:
    a = asset(admin, "Chiller 9")
    p = plan(
        admin,
        asset_id=a["id"],
        horizon_days=20,
        defaults={"priority": "medium", "description": "Lock out first."},
        tasks=[
            {
                "name": "Monthly checks",
                "spec": {"freq": "monthly"},
                "anchor": local_at(3),
                "overrides": {"estimated_minutes": 30},
            },
            {
                "name": "Quarterly belts",
                "spec": {"freq": "monthly", "interval": 3},
                "anchor": local_at(3),
                "overrides": {"priority": "high", "estimated_minutes": 60},
            },
        ],
    )
    items = wos_of(admin, "Chiller%20PM")
    assert len(items) == 1  # one visit does everything due that day
    w = admin.get(f"{API}/work-orders/{items[0]['id']}").json
    assert w["title"] == "Chiller PM: Monthly checks, Quarterly belts"
    assert w["priority"] == "high" and w["estimated_minutes"] == 90 and w["work_type"] == "preventive"
    assert w["asset"]["id"] == a["id"] and w["source_type"] == "pm_occurrence"
    assert w["recurrence"]["kind"] == "plan"
    for _ in range(3):
        admin.post(f"{API}/pm/plans/{p['id']}/generate")
    with app.app_context():
        from mpro.pm.services import generate_all

        generate_all()
    assert len(wos_of(admin, "Chiller%20PM")) == 1
    prev = admin.get(f"{API}/pm/plans/{p['id']}/preview?count=6").json["items"]
    assert prev[0]["status"] == "generated" and prev[1]["status"] == "upcoming"
    assert [t["name"] for t in prev[3]["tasks"]] == ["Monthly checks", "Quarterly belts"]  # 3 months later: both again
    assert [t["name"] for t in prev[1]["tasks"]] == ["Monthly checks"]
    listed = admin.get(f"{API}/pm/plans").json["items"]
    assert listed[0]["frequency"].startswith("Every month") and listed[0]["next_due_at"]
    # editing a plan doesn't touch generated work
    admin.patch(
        f"{API}/pm/plans/{p['id']}",
        {
            "name": "Chiller PM v2",
            "tasks": [{"name": "Monthly checks", "spec": {"freq": "monthly"}, "anchor": local_at(3)}],
        },
    )
    assert (
        admin.get(f"{API}/work-orders/{items[0]['id']}").json["title"] == "Chiller PM: Monthly checks, Quarterly belts"
    )
    # pause stops generation
    assert admin.post(f"{API}/pm/plans/{p['id']}/pause").json["active"] is False
    assert admin.post(f"{API}/pm/plans/{p['id']}/resume").json["active"] is True


def test_seasonal_months_and_holidays(admin: Api) -> None:
    today = datetime.now(TZ).date()
    other_months = [m for m in range(1, 13) if m != today.month and m != (today + timedelta(days=1)).month]
    p = plan(
        admin,
        name="Seasonal",
        calendar={"months": other_months},
        tasks=[{"name": "", "spec": {"freq": "daily"}, "anchor": local_at(1)}],
        horizon_days=3,
    )
    assert wos_of(admin, "Seasonal") == []
    prev = admin.get(f"{API}/pm/plans/{p['id']}/preview?count=5").json["items"]
    assert all(
        datetime.fromisoformat(i["due_at"].replace("Z", "+00:00")).astimezone(TZ).month in other_months for i in prev
    )
    tomorrow = (today + timedelta(days=1)).isoformat()
    assert admin.post(f"{API}/pm/holidays", {"day": tomorrow, "name": "Plant shutdown"}).status_code == 201
    p2 = plan(
        admin,
        name="Holiday aware",
        calendar={"skip_holidays": True, "shift": "skip"},
        tasks=[{"name": "", "spec": {"freq": "daily"}, "anchor": local_at(1)}],
        horizon_days=1,
    )
    dates = [i["due_at"] for i in admin.get(f"{API}/pm/plans/{p2['id']}/preview?count=3").json["items"]]
    assert all(
        datetime.fromisoformat(d.replace("Z", "+00:00")).astimezone(TZ).date().isoformat() != tomorrow for d in dates
    )
    assert (
        admin.post(
            f"{API}/pm/plans",
            {"name": "x", "calendar": {"months": [13]}, "tasks": [{"spec": {"freq": "daily"}, "anchor": local_at(1)}]},
        ).status_code
        == 422
    )


def test_floating_interval_counts_from_completion(admin: Api) -> None:
    plan(
        admin,
        name="Floating",
        interval_mode="floating",
        horizon_days=60,
        tasks=[{"name": "", "spec": {"freq": "every_n_days", "interval": 10}, "anchor": local_at(1)}],
    )
    items = wos_of(admin, "Floating")
    assert len(items) == 1  # only the next one exists
    admin.post(f"{API}/work-orders/{items[0]['id']}/status", {"status": "done"})
    items = wos_of(admin, "Floating")
    assert len(items) == 2
    nxt = next(i for i in items if i["status"] == "open")
    due = datetime.fromisoformat(nxt["due_at"].replace("Z", "+00:00")).astimezone(TZ).date()
    assert due == datetime.now(TZ).date() + timedelta(days=10)


def test_usage_based_plan(admin: Api) -> None:
    a = asset(admin, "Compressor X")
    m = admin.post(f"{API}/meters", {"name": "Run hours", "unit": "hours", "asset_id": a["id"]}).json
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 1000})
    p = plan(
        admin,
        name="Compressor service",
        asset_id=a["id"],
        schedule_kind="usage",
        tasks=[{"name": "500 h", "meter_id": m["id"], "every_units": 500, "lead_units": 20}],
    )
    assert p["tasks"][0]["next_units"] == 1500
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 1400})
    assert wos_of(admin, "Compressor%20service") == []
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 1485})  # within the 20-hour lead
    assert len(wos_of(admin, "Compressor%20service")) == 1
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 1510})
    assert len(wos_of(admin, "Compressor%20service")) == 1  # same milestone, no duplicate
    assert admin.get(f"{API}/pm/plans/{p['id']}").json["tasks"][0]["next_units"] == 2000
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 2600})  # a big jump creates one, not two
    assert len(wos_of(admin, "Compressor%20service")) == 2
    assert admin.get(f"{API}/pm/plans/{p['id']}").json["tasks"][0]["next_units"] == 3000
    assert (
        admin.post(
            f"{API}/pm/plans",
            {"name": "bad", "schedule_kind": "usage", "tasks": [{"spec": {"freq": "daily"}, "anchor": local_at(1)}]},
        ).status_code
        == 422
    )


def test_time_or_usage_whichever_first(admin: Api) -> None:
    m = admin.post(f"{API}/meters", {"name": "Cycles", "unit": "cycles"}).json
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 0})
    plan(
        admin,
        name="Either way",
        schedule_kind="time_or_usage",
        horizon_days=5,
        tasks=[
            {"name": "", "spec": {"freq": "monthly"}, "anchor": local_at(20), "meter_id": m["id"], "every_units": 100}
        ],
    )
    assert wos_of(admin, "Either%20way") == []
    admin.post(f"{API}/meters/{m['id']}/readings", {"value": 120})
    assert len(wos_of(admin, "Either%20way")) == 1


def test_skip_postpone_and_compliance(app: Any, admin: Api) -> None:
    p = plan(
        admin, name="Skippy", horizon_days=8, tasks=[{"name": "", "spec": {"freq": "weekly"}, "anchor": local_at(1)}]
    )
    prev = admin.get(f"{API}/pm/plans/{p['id']}/preview?count=4").json["items"]
    first, later = prev[0], prev[2]
    tech = login(app, "avery.kim@example.com")
    assert (
        tech.post(f"{API}/pm/plans/{p['id']}/occurrences/{first['key']}", {"action": "skip", "reason": "x"}).status_code
        == 403
    )
    assert admin.post(f"{API}/pm/plans/{p['id']}/occurrences/{first['key']}", {"action": "skip"}).status_code == 422
    r = admin.post(
        f"{API}/pm/plans/{p['id']}/occurrences/{first['key']}", {"action": "skip", "reason": "Line down for retooling"}
    )
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/work-orders/{first['work_order']['id']}").json["status"] == "canceled"
    # postpone a future one (not generated yet); it's judged against its original date
    new_due = (datetime.fromisoformat(later["due_at"].replace("Z", "+00:00")) + timedelta(days=2)).isoformat()
    r = admin.post(
        f"{API}/pm/plans/{p['id']}/occurrences/{later['key']}",
        {"action": "postpone", "due_at": new_due, "reason": "Parts late"},
    )
    assert r.status_code == 200
    moved = next(i for i in r.json["items"] if i["key"] == later["key"])
    assert moved["original_due_at"] == later["due_at"]
    # reassign the second one
    second = prev[1]
    avery = uid(admin, "avery.kim@example.com")
    admin.post(
        f"{API}/pm/plans/{p['id']}/occurrences/{second['key']}", {"action": "reassign", "assignees": [f"user:{avery}"]}
    )
    wo2 = admin.get(f"{API}/work-orders/{second['work_order']['id']}").json
    assert [a["id"] for a in wo2["assignees"]] == [avery]
    # compliance: put the skipped one in the past and add an on-time and a late completion
    with app.app_context():
        from sqlalchemy import select

        from mpro.extensions import db
        from mpro.pm.models import PMOccurrence

        now = datetime.now(UTC)
        occs = db.session.scalars(
            select(PMOccurrence).where(PMOccurrence.status != "planned").order_by(PMOccurrence.due_at)
        ).all()
        o_skip, o_done = occs[0], occs[1]
        o_skip.due_at = o_skip.original_due_at = now - timedelta(days=5)
        o_done.due_at = o_done.original_due_at = now - timedelta(days=3)
        o_done.status, o_done.completed_at = "completed", now - timedelta(days=1)  # late
        db.session.add(
            PMOccurrence(
                org_id=o_skip.org_id,
                plan_id=o_skip.plan_id,
                key="t:2000-01-01",
                task_ids=[],
                due_at=now - timedelta(days=10),
                original_due_at=now - timedelta(days=10),
                status="completed",
                completed_at=now - timedelta(days=10),
                overrides={},
                skip_reason="",
            )
        )
        db.session.add(
            PMOccurrence(
                org_id=o_skip.org_id,
                plan_id=o_skip.plan_id,
                key="t:2000-01-02",
                task_ids=[],
                due_at=now - timedelta(days=7),
                original_due_at=now - timedelta(days=7),
                status="generated",
                overrides={},
                skip_reason="",
            )
        )
        db.session.commit()
    c = admin.get(f"{API}/pm/compliance?days=30").json
    assert (c["on_time"], c["late"], c["missed"], c["skipped"]) == (1, 1, 1, 1)
    assert c["percent"] == 25.0
    assert c["plans"][0]["name"] == "Skippy"
    cal = admin.get(f"{API}/pm/calendar?days=30").json["items"]
    assert any(i["status"] == "skipped" for i in cal)


def test_repeating_work_order_chain(admin: Api) -> None:
    wo = admin.post(
        f"{API}/work-orders",
        {"title": "Eyewash weekly check", "assignees": [f"user:{uid(admin, 'casey.nguyen@example.com')}"]},
    ).json
    parent_sub = admin.post(f"{API}/work-orders", {"title": "Flush station 2", "parent_id": wo["id"]}).json
    assert parent_sub["assignees"][0]["name"] == "Casey Nguyen"  # inherited
    r = put(admin, f"{API}/work-orders/{wo['id']}/repeat", {"freq": "weekly", "weekdays": [0, 3], "days_ahead": 8})
    assert r.status_code == 200, r.json
    rec = r.json["recurrence"]
    assert rec["summary"] == "Every week on Mon, Thu" and rec["kind"] == "repeat"
    d = admin.get(f"{API}/work-orders/{wo['id']}").json
    assert d["due_at"]  # no due date → tomorrow (r193)
    copies = [w for w in wos_of(admin, "Eyewash%20weekly%20check") if not w["parent_id"]]
    assert len(copies) >= 2  # this one plus the next within 8 days
    nxt = next(w for w in copies if w["id"] != wo["id"])
    subs = [w for w in wos_of(admin, "Flush%20station%202") if w["parent_id"] == nxt["id"]]
    assert len(subs) == 1  # the parent's sub-work order is recreated (r195)
    # skip the next one
    r = admin.post(f"{API}/work-orders/{wo['id']}/repeat/skip-next", {})
    assert r.status_code == 200, r.json
    assert admin.post(f"{API}/work-orders/{parent_sub['id']}/repeat", {}).status_code in (404, 405)
    assert put(admin, f"{API}/work-orders/{parent_sub['id']}/repeat", {"freq": "daily"}).status_code == 422
    assert put(admin, f"{API}/work-orders/{wo['id']}/repeat", {"freq": "hourly"}).status_code == 422
    # stop repeating
    assert admin.delete(f"{API}/work-orders/{wo['id']}/repeat").status_code == 204
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["recurrence"] is None
    plans = admin.get(f"{API}/pm/plans?kind=repeat").json["items"]
    assert plans == []


def test_sub_work_orders_rollup_close_and_reopen(admin: Api) -> None:
    team = admin.get(f"{API}/teams").json["items"][0]
    parent = admin.post(
        f"{API}/work-orders",
        {
            "title": "Shutdown",
            "priority": "high",
            "work_type": "other",
            "assignees": [f"team:{team['id']}"],
            "due_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
        },
    ).json
    s1 = admin.post(f"{API}/work-orders", {"title": "Drain", "parent_id": parent["id"]}).json
    s2 = admin.post(f"{API}/work-orders", {"title": "Rollers", "parent_id": parent["id"], "priority": "low"}).json
    assert (
        s1["priority"] == "high"
        and s1["work_type"] == "other"
        and s1["due_at"] == parent["due_at"]
        and s1["assignees"][0]["id"] == team["id"]
    )
    assert s2["priority"] == "low"  # given explicitly
    admin.post(f"{API}/work-orders/{s1['id']}/time", {"minutes": 30})
    admin.post(f"{API}/work-orders/{parent['id']}/costs", {"amount_cents": 1000, "description": "Gasket"})
    admin.post(f"{API}/work-orders/{s2['id']}/costs", {"amount_cents": 500, "description": "Bearing"})
    r = admin.get(f"{API}/work-orders/{parent['id']}/rollup").json
    assert r["total"]["minutes"] == 30 and r["total"]["other_cents"] == 1500 and len(r["subs"]) == 2
    table = admin.get(f"{API}/work-orders?tab=all&q=Drain").json["items"]
    assert table[0]["parent"]["title"] == "Shutdown"
    admin.post(f"{API}/work-orders/{parent['id']}/status", {"status": "done"})
    res = admin.post(f"{API}/work-orders/{parent['id']}/close-subs", {"status": "done"}).json
    assert sorted(res["closed"]) == sorted([s1["number"], s2["number"]])
    admin.post(f"{API}/work-orders/{s1['id']}/status", {"status": "open"})
    assert admin.get(f"{API}/work-orders/{parent['id']}").json["status"] == "open"  # reopening a sub reopens the parent


def test_tenancy_and_permissions(app: Any, admin: Api) -> None:
    a = asset(admin, "Mine")
    p = plan(admin)
    other = other_org(app)
    assert other.get(f"{API}/pm/plans/{p['id']}").status_code == 404
    assert other.get(f"{API}/pm/plans").json["total"] == 0
    assert (
        other.post(
            f"{API}/pm/plans",
            {"name": "x", "asset_id": a["id"], "tasks": [{"spec": {"freq": "daily"}, "anchor": local_at(1)}]},
        ).status_code
        == 422
    )
    assert other.patch(f"{API}/pm/plans/{p['id']}", {"name": "pwned"}).status_code == 404
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/pm/plans").status_code == 200
    assert viewer.post(f"{API}/pm/plans", {"name": "x"}).status_code == 403
    tech = login(app, "avery.kim@example.com")
    assert tech.delete(f"{API}/pm/plans/{p['id']}").status_code == 403
    before = len(wos_of(admin, "Chiller%20PM"))
    assert admin.delete(f"{API}/pm/plans/{p['id']}").status_code == 204
    assert admin.get(f"{API}/pm/plans").json["total"] == 0
    assert len(wos_of(admin, "Chiller%20PM")) == before  # history stays
