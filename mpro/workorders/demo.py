# ruff: noqa: E501  (sample data rows read better on one line)
"""Demo work orders for the demo organization (test builds, `./start.sh --demo`, screenshots, browser tests).

Goes through the real services so numbering, history, events and costs are exactly what users would get.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.auth.models import User
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team
from mpro.workorders import activity as act
from mpro.workorders import services as svc
from mpro.workorders.models import Category, StatusChange, WorkOrder

# title, priority, work type, team, person, categories, estimate (min), due offset (days), status, description
WORK = [
    (
        "Conveyor 3 drive belt slipping",
        "high",
        "reactive",
        "Mechanical",
        "avery",
        ["Mechanical"],
        120,
        0,
        "in_progress",
        "Belt is slipping under load on Line 3. Operators report product bunching at the transfer.",
    ),
    (
        "Replace AHU-2 filters",
        "medium",
        "preventive",
        "HVAC",
        "riley",
        ["Preventive", "Inspection"],
        45,
        1,
        "open",
        "MERV 13, 24x24x2 (qty 8). Note pressure drop before and after.",
    ),
    (
        "Emergency lighting monthly test - Building A",
        "medium",
        "preventive",
        "Electrical",
        "sam",
        ["Safety", "Inspection"],
        60,
        2,
        "open",
        "30-second test on every fixture. Record any failed units.",
    ),
    (
        "Leak at compressor 2 discharge line",
        "high",
        "reactive",
        "Mechanical",
        "morgan",
        ["Mechanical", "Damage"],
        90,
        -1,
        "open",
        "Hissing at the union after the aftercooler. Tag out before work.",
    ),
    (
        "Dock door 4 won't close",
        "high",
        "reactive",
        "Facilities",
        "casey",
        ["Damage"],
        60,
        0,
        "on_hold",
        "Photo eye realigned, still reverses. Waiting on a new safety edge.",
    ),
    (
        "Chiller 1 quarterly inspection",
        "medium",
        "preventive",
        "HVAC",
        "admin",
        ["Preventive", "Refrigeration"],
        180,
        4,
        "open",
        "Condenser approach, oil level, refrigerant pressures, vibration readings.",
    ),
    ("Re-lamp parking lot pole 6", "low", "reactive", "Electrical", "taylor", ["Electrical"], 45, 6, "open", ""),
    (
        "VFD fault on mixer M-2 (OC2)",
        "high",
        "reactive",
        "Electrical",
        "sam",
        ["Electrical"],
        90,
        0,
        "in_progress",
        "Overcurrent during accel. Check accel time and motor insulation.",
    ),
    (
        "Grease line 2 bearings",
        "low",
        "preventive",
        "Mechanical",
        "morgan",
        ["Preventive", "Mechanical"],
        30,
        3,
        "open",
        "Two pumps of EP2 per bearing. Don't over-grease the motor bearings.",
    ),
    ("Restroom 2B faucet dripping", "low", "reactive", "Facilities", None, ["Damage"], 30, 5, "open", ""),
    (
        "Eyewash station weekly check",
        "medium",
        "preventive",
        "Facilities",
        "casey",
        ["Safety", "Inspection"],
        15,
        1,
        "open",
        "Flush 3 minutes, check water is clear and temperature is tepid.",
    ),
    (
        "Install guard on new bandsaw",
        "medium",
        "other",
        "Mechanical",
        "admin",
        ["Safety", "Project"],
        240,
        8,
        "open",
        "",
    ),
    (
        "RTU-4 short cycling",
        "medium",
        "reactive",
        "HVAC",
        "casey",
        ["Refrigeration"],
        120,
        -2,
        "on_hold",
        "Suspect low charge. Waiting on vendor leak check.",
    ),
    (
        "Forklift 3 hydraulic leak",
        "high",
        "reactive",
        "Mechanical",
        None,
        ["Mechanical", "Safety"],
        60,
        0,
        "open",
        "Puddle under the mast. Forklift tagged out of service.",
    ),
    (
        "Annual arc-flash label review",
        "low",
        "other",
        "Electrical",
        "admin",
        ["Safety", "Electrical"],
        300,
        21,
        "open",
        "",
    ),
    (
        "Paint line booth exhaust fan noisy",
        "medium",
        "reactive",
        "Mechanical",
        "morgan",
        ["Mechanical"],
        90,
        9,
        "open",
        "",
    ),
    ("Boiler blowdown and log", "medium", "preventive", "HVAC", "riley", ["Preventive"], 30, -6, "done", ""),
    ("Replace ballast in office 114", "low", "reactive", "Electrical", "taylor", ["Electrical"], 30, -4, "done", ""),
    ("Clear jam at palletizer infeed", "high", "reactive", "Mechanical", "avery", ["Mechanical"], 45, -3, "done", ""),
    (
        "Fire extinguisher monthly walk",
        "medium",
        "preventive",
        "Facilities",
        "casey",
        ["Safety", "Inspection"],
        60,
        -2,
        "done",
        "",
    ),
    (
        "Air compressor 1 oil change",
        "medium",
        "preventive",
        "Mechanical",
        "morgan",
        ["Preventive", "Mechanical"],
        60,
        -1,
        "done",
        "",
    ),
    ("Thermostat in break room reads high", "low", "reactive", "HVAC", None, ["Refrigeration"], 30, -5, "canceled", ""),
    ("Line 2 changeover support", "medium", "other", "Mechanical", "jordan", ["Project"], 240, 12, "open", ""),
    (
        "Roof drain inspection before storm",
        "medium",
        "preventive",
        "Facilities",
        "casey",
        ["Inspection"],
        90,
        2,
        "open",
        "",
    ),
    (
        "Weld crack on hopper support",
        "high",
        "reactive",
        "Mechanical",
        "avery",
        ["Damage", "Safety"],
        180,
        1,
        "open",
        "Crack about 3 in. long at the gusset. Hopper emptied and locked out.",
    ),
]

COMMENTS = [
    ("jordan", "@[{who}](user:{uid}) can you take a look before second shift?"),
    ("avery", "Checked it. Ordering parts now."),
    ("sam", "Done on my end. Leaving it open for the follow-up."),
]


def _people(org: Organization) -> dict[str, Membership]:
    ms = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.deleted_at.is_(None))
    ).all()
    return {m.user.email.split(".")[0].split("@")[0]: m for m in ms}


def seed_work_orders(org: Organization, admin: User) -> None:
    if db.session.scalar(select(WorkOrder.id).where(WorkOrder.org_id == org.id).limit(1)):
        return
    rnd = random.Random(42)
    people = _people(org)
    admin_m = people["admin"]
    teams = {t.name: t for t in db.session.scalars(select(Team).where(Team.org_id == org.id)).all()}
    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, admin_m
        svc.ensure_default_categories(org.id)
        cats = {c.name: c for c in db.session.scalars(select(Category).where(Category.org_id == org.id)).all()}
        svc.update_settings(
            org,
            {
                "default_hourly_rate_cents": 4500,
                "sub_statuses": {"on_hold": ["Waiting on parts", "Waiting on vendor", "Waiting on production"]},
            },
        )
        for key, rate in (("avery", 5200), ("sam", 5600), ("riley", 5400)):
            if key in people:
                svc.set_member_work_settings(org, people[key], {"hourly_rate_cents": rate})
        field = svc.save_custom_field(
            org,
            {
                "name": "Downtime cause",
                "type": "select",
                "options": ["Wear", "Operator", "Electrical", "Material", "Unknown"],
            },
        )
        svc.save_custom_field(org, {"name": "Cost center", "type": "text"})
        tz_now = utcnow()
        today_noon = tz_now.replace(hour=17, minute=0, second=0, microsecond=0)  # 12:00 in America/Chicago
        created: list[WorkOrder] = []
        for title, prio, wtype, team, person, cnames, est, due_off, status, desc in WORK:
            assignees: list[str] = []
            if person and person in people:
                assignees.append(f"user:{people[person].user_id}")
            if team and (not person or rnd.random() < 0.35):
                assignees.append(f"team:{teams[team].id}")
            creator = people[rnd.choice(["admin", "jordan", "harper", "jordan"])]
            g.user, g.membership = creator.user, creator
            data: dict[str, Any] = {
                "title": title,
                "description": desc,
                "priority": prio,
                "work_type": wtype,
                "estimated_minutes": est,
                "due_at": (today_noon + timedelta(days=due_off, hours=rnd.choice([-3, 0, 0, 2, 4]))).isoformat(),
                "assignees": assignees,
                "categories": [str(cats[c].id) for c in cnames if c in cats],
            }
            if wtype == "reactive" and rnd.random() < 0.6:
                data["custom"] = {str(field.id): rnd.choice(["Wear", "Operator", "Electrical", "Material"])}
            wo = svc.create_work_order(org, creator, data)
            age = timedelta(days=rnd.randint(1, 9), hours=rnd.randint(0, 8))
            wo.created_at = tz_now - age
            first = db.session.scalars(select(StatusChange).where(StatusChange.work_order_id == wo.id)).first()
            if first:
                first.at = wo.created_at
            created.append(wo)
            worker = people.get(person or "", admin_m)
            g.user, g.membership = worker.user, worker
            if status in ("in_progress", "on_hold", "done"):
                svc.set_status(org, worker, wo, "in_progress")
            if status == "on_hold":
                svc.set_status(
                    org,
                    worker,
                    wo,
                    "on_hold",
                    comment="Waiting on parts from the vendor.",
                    sub_status="Waiting on parts",
                )
            if status in ("in_progress", "done") and person:
                act.add_time(org, worker, wo, {"minutes": rnd.choice([20, 35, 50, 75, 90]), "time_type": "Work"})
            if status == "done":
                svc.set_status(org, worker, wo, "done", summary="Work completed and tested. Area cleaned up.")
                wo.completed_at = tz_now - timedelta(days=-due_off, hours=rnd.randint(1, 6)) if due_off < 0 else tz_now
            if status == "canceled":
                svc.set_status(org, worker, wo, "canceled", comment="Duplicate of an existing work order.")
        # conversation on a few work orders
        g.user, g.membership = admin, admin_m
        for wo in created[:6]:
            for who, text in COMMENTS[: rnd.randint(1, 3)]:
                m = people.get(who, admin_m)
                target = people.get("avery", admin_m)
                g.user, g.membership = m.user, m
                act.add_comment(org, m, wo, text.format(who=target.user.name, uid=target.user_id))
        # a parent with sub-work orders and a blocking link
        g.user, g.membership = admin, admin_m
        parent = svc.create_work_order(org, admin_m, {
            "title": "Line 2 summer shutdown", "priority": "medium", "work_type": "other",
            "due_at": (today_noon + timedelta(days=14)).isoformat(), "categories": [str(cats["Project"].id)],
            "description": "Planned three-day shutdown. Each task is a sub-work order.",
        })  # fmt: skip
        for t, who in (
            ("Lock out and drain Line 2", "morgan"),
            ("Replace conveyor 2 rollers", "avery"),
            ("Inspect and clean motor terminations", "sam"),
        ):
            svc.create_work_order(org, admin_m, {"title": t, "parent_id": str(parent.id), "priority": "medium",
                                                 "due_at": (today_noon + timedelta(days=14)).isoformat(),
                                                 "assignees": [f"user:{people[who].user_id}"] if who in people else []})  # fmt: skip
        svc.add_link(org, admin_m, created[13], created[0], "related")
        # templates
        svc.save_template(org, admin_m, {"name": "Replace HVAC filters", "description": "Monthly or when pressure drop is high", "data": {
            "title": "Replace filters on ", "priority": "medium", "work_type": "preventive", "estimated_minutes": 45,
            "assignees": [f"team:{teams['HVAC'].id}"], "categories": [str(cats["Preventive"].id)]}})  # fmt: skip
        svc.save_template(org, admin_m, {"name": "Lamp out", "data": {
            "title": "Lamp out at ", "priority": "low", "estimated_minutes": 30, "assignees": [f"team:{teams['Electrical'].id}"],
            "categories": [str(cats["Electrical"].id)]}})  # fmt: skip
        svc.save_view(org, admin_m, {"name": "Urgent", "shared": True, "pinned": True,
                                     "filters": [{"field": "priority", "op": "in", "value": ["high"]}, {"field": "status", "op": "in", "value": ["open", "on_hold", "in_progress"]}]})  # fmt: skip
        db.session.commit()
    _ = datetime, UTC
