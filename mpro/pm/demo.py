"""Demo maintenance plans and a repeating work order for the demo organization (0.4.0). Uses the real services."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.auth.models import User
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team

USAGE_PLAN = "Air Compressor 1 - 2,000 hour service (usage-based PM)"


def seed_pm(org: Organization, admin: User) -> None:
    """A nested monthly/quarterly/annual chiller plan, a usage plan on compressor run hours, a weekly repeat."""
    from mpro.assets.models import Asset
    from mpro.meters.models import Meter
    from mpro.pm import schedule as sch
    from mpro.pm import services as svc
    from mpro.pm.models import MaintenancePlan
    from mpro.workorders.models import WorkOrder

    if db.session.scalar(select(MaintenancePlan.id).where(MaintenancePlan.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return

    def asset(name: str) -> Asset | None:
        return db.session.scalars(select(Asset).where(Asset.org_id == org.id, Asset.name == name)).first()

    def team(name: str) -> list[dict[str, str]]:
        t = db.session.scalars(select(Team).where(Team.org_id == org.id, Team.name == name)).first()
        return [{"type": "team", "id": str(t.id)}] if t is not None else []

    def procs(*names: str) -> list[str]:
        try:
            from mpro.procedures.models import Procedure
        except ImportError:  # procedures module not installed
            return []
        rows = db.session.scalars(
            select(Procedure).where(
                Procedure.org_id == org.id,
                Procedure.name.in_(names),
                Procedure.status == "published",
                Procedure.work_order_id.is_(None),
            )
        ).all()
        return [str(p.id) for p in rows]

    tz = sch.zone(org.timezone)
    today = sch.to_local(datetime.now(tz=sch.zone("UTC")), tz).date()

    def at(day: Any, hour: int = 9) -> str:
        return sch.to_utc(datetime(day.year, day.month, day.day, hour), tz).isoformat()

    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        chiller = asset("Chiller 1")
        if chiller is not None:
            first = today + timedelta(days=5)
            svc.create_plan(
                org,
                m,
                {
                    "name": "Chiller 1 preventive maintenance",
                    "description": "Monthly checks, a quarterly inspection and the annual teardown, merged into one "
                    "work order when they fall on the same day.",
                    "asset_id": str(chiller.id),
                    "schedule_kind": "time",
                    "interval_mode": "fixed",
                    "horizon_days": 30,
                    "calendar": {"skip_weekends": True, "skip_holidays": True, "shift": "previous"},
                    "defaults": {
                        "title": "Chiller 1 PM",
                        "priority": "medium",
                        "assignees": team("HVAC"),
                        "estimated_minutes": 60,
                        "due_in_days": 3,
                    },
                    "tasks": [
                        {
                            "name": "Monthly check",
                            "anchor": at(first),
                            "spec": {"freq": "monthly", "interval": 1, "monthly": "by_date"},
                            "overrides": {"estimated_minutes": 45},
                        },
                        {
                            "name": "Quarterly inspection",
                            "anchor": at(first),
                            "spec": {"freq": "monthly", "interval": 3, "monthly": "by_date"},
                            "procedure_ids": procs("Chiller quarterly inspection"),
                            "overrides": {"priority": "high", "estimated_minutes": 120},
                        },
                        {
                            "name": "Annual teardown and eddy-current tube test",
                            "anchor": at(first + timedelta(days=60)),
                            "spec": {"freq": "yearly", "interval": 1},
                            "overrides": {"priority": "high", "estimated_minutes": 480},
                        },
                    ],
                },
                commit=True,
            )
        meter = db.session.scalars(select(Meter).where(Meter.org_id == org.id, Meter.name == "Run hours")).first()
        compressor = asset("Air Compressor 1")
        if meter is not None and compressor is not None:
            nxt = None
            if meter.last_value is not None:
                nxt = (int(meter.last_value) // 2000 + 1) * 2000
            svc.create_plan(
                org,
                m,
                {
                    "name": USAGE_PLAN,
                    "description": "Oil, separator element and intake filter every 2,000 run hours.",
                    "asset_id": str(compressor.id),
                    "schedule_kind": "usage",
                    "defaults": {
                        "title": "Air Compressor 1 - 2,000 hour service",
                        "priority": "medium",
                        "assignees": team("Mechanical"),
                        "due_in_days": 7,
                    },
                    "tasks": [
                        {
                            "name": "2,000 hour service",
                            "meter_id": str(meter.id),
                            "every_units": 2000,
                            "lead_units": 100,
                            **({"start_units": nxt} if nxt else {}),
                        }
                    ],
                },
                commit=True,
            )
        eyewash = db.session.scalars(
            select(WorkOrder).where(
                WorkOrder.org_id == org.id,
                WorkOrder.title == "Eyewash station weekly check",
                WorkOrder.deleted_at.is_(None),
            )
        ).first()
        if eyewash is not None and eyewash.status not in ("done", "canceled") and not eyewash.parent_id:
            svc.set_repeat(org, m, eyewash, {"freq": "weekly", "interval": 1})
        _history(org, tz, today)
        db.session.commit()


def _history(org: Organization, tz: Any, today: Any) -> None:
    """A few months of past visits so the compliance report and plan history have something to show."""
    from mpro.pm import schedule as sch
    from mpro.pm.models import MaintenancePlan, PMOccurrence
    from mpro.pm.services import tasks_of

    for plan in db.session.scalars(select(MaintenancePlan).where(MaintenancePlan.org_id == org.id)).all():
        weekly = plan.kind == "repeat"
        step, count = (7, 10) if weekly else (30, 5)
        tasks = tasks_of(plan)
        if not tasks or plan.schedule_kind == "usage":
            continue
        for i in range(1, count + 1):
            day = today - timedelta(days=step * i)
            due = sch.to_utc(datetime(day.year, day.month, day.day, 15), tz)
            # mostly on time; one late, one skipped, one missed
            late, skipped, missed = i == 3, i == (6 if weekly else 4), weekly and i == 8
            occ = PMOccurrence(
                org_id=org.id,
                plan_id=plan.id,
                key=f"t:{day.isoformat()}",
                task_ids=[str(tasks[0].id)],
                due_at=due,
                original_due_at=due,
                status="skipped" if skipped else "generated" if missed else "completed",
                overrides={},
                skip_reason="Line down for retooling" if skipped else "",
                generated_at=due - timedelta(days=plan.horizon_days),
                completed_at=None if skipped or missed else due + timedelta(days=2 if late else 0, hours=-3),
            )
            db.session.add(occ)
