"""Preventive maintenance rules: plans, nested tasks, occurrences, generation, repeating work orders (0.4.0).

See mpro/pm/models.py for the data model and mpro/pm/schedule.py for the recurrence maths.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select

from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.pm import schedule as sch
from mpro.pm.models import INTERVAL_MODES, SCHEDULE_KINDS, Holiday, MaintenancePlan, PMOccurrence, PMTask
from mpro.workorders.models import ACTIVE_STATUSES, WorkOrder

log = logging.getLogger(__name__)

MAX_TASKS = 10  # nested PMs per plan (r167)
WO_DEFAULT_KEYS = (
    "title",
    "description",
    "priority",
    "assignees",
    "categories",
    "estimated_minutes",
    "custom",
    "procedure_ids",
    "sub_work_orders",
    "due_in_days",
)
PRIORITY_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3}


# ---- helpers ---------------------------------------------------------------------------------
def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _dec(v: Any, field: str) -> Decimal | None:
    if v in (None, ""):
        return None
    if isinstance(v, bool):
        raise RuleError(f"{field} must be a number.", 422)
    try:
        d = Decimal(str(v))
    except InvalidOperation as e:
        raise RuleError(f"{field} must be a number.", 422) from e
    if not d.is_finite() or d < 0 or d > Decimal("99999999999999"):
        raise RuleError(f"{field} is out of range.", 422)
    return d.quantize(Decimal("0.0001"))


def _num(d: Decimal | None) -> float | int | None:
    if d is None:
        return None
    return int(d) if d == d.to_integral_value() else float(d)


def _dt(v: Any, field: str) -> datetime | None:
    from mpro.workorders.services import _dt as wo_dt

    return wo_dt(v, field)


def get_plan(org_id: uuid.UUID, pid: Any, include_deleted: bool = False) -> MaintenancePlan:
    p = db.session.get(MaintenancePlan, _uuid(pid, "maintenance plan"))
    if p is None or p.org_id != org_id or (p.deleted_at is not None and not include_deleted):
        raise RuleError("That maintenance plan doesn't exist.", 404)
    return p


def tasks_of(plan: MaintenancePlan) -> list[PMTask]:
    return list(
        db.session.scalars(
            select(PMTask)
            .where(PMTask.plan_id == plan.id, PMTask.deleted_at.is_(None))
            .order_by(PMTask.sort, PMTask.created_at)
        ).all()
    )


def holidays(org_id: uuid.UUID) -> set[date]:
    return set(db.session.scalars(select(Holiday.day).where(Holiday.org_id == org_id)).all())


def _tz(plan: MaintenancePlan) -> Any:
    return sch.zone(plan.timezone)


def _actor(org: Organization, plan: MaintenancePlan) -> Membership | None:
    """Work orders from a plan are created by the plan's author, or the first Owner/Administrator."""
    if plan.created_by_id:
        m = db.session.scalars(
            select(Membership).where(
                Membership.org_id == org.id, Membership.user_id == plan.created_by_id, Membership.deleted_at.is_(None)
            )
        ).first()
        if m is not None and can(m, "wo.create"):
            return m
    return db.session.scalars(
        select(Membership)
        .where(Membership.org_id == org.id, Membership.role.in_(("owner", "admin")), Membership.deleted_at.is_(None))
        .order_by(Membership.created_at)
    ).first()


# ---- validation --------------------------------------------------------------------------------
def _clean_defaults(org: Organization, raw: Any) -> dict[str, Any]:
    from mpro.workorders.services import _apply_fields, _clean_custom, _resolve_assignees, new_work_order

    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict):
        raise RuleError("Work order details must be an object.", 422)
    bad = set(raw) - set(WO_DEFAULT_KEYS)
    if bad:
        raise RuleError("Plans can't store " + ", ".join(sorted(bad)) + ".", 422)
    probe = new_work_order(org.id, title=str(raw.get("title") or "x"))
    _apply_fields(probe, {k: raw[k] for k in ("description", "priority", "estimated_minutes") if k in raw})
    out = dict(raw)
    if "assignees" in raw:
        out["assignees"] = [f"{k}:{v}" for k, v in _resolve_assignees(org.id, raw.get("assignees") or [])]
    if "categories" in raw:
        from mpro.workorders.models import Category

        cats = []
        for c in raw.get("categories") or []:
            cid = _uuid(c, "category")
            if not db.session.scalar(select(Category.id).where(Category.org_id == org.id, Category.id == cid)):
                raise RuleError("One of the categories doesn't exist.", 422)
            cats.append(str(cid))
        out["categories"] = cats
    if "custom" in raw:
        out["custom"] = _clean_custom(org.id, raw.get("custom") or {})
    if "procedure_ids" in raw:
        out["procedure_ids"] = _clean_procedures(org.id, raw.get("procedure_ids"))
    if "sub_work_orders" in raw:
        subs = raw.get("sub_work_orders") or []
        if not isinstance(subs, list) or len(subs) > 50:
            raise RuleError("Up to 50 sub-work orders.", 422)
        clean = []
        for s in subs:
            if not isinstance(s, dict) or not str(s.get("title") or "").strip():
                raise RuleError("Each sub-work order needs a title.", 422)
            clean.append(
                _clean_defaults(
                    org,
                    {k: s[k] for k in ("title", "description", "priority", "assignees", "estimated_minutes") if k in s},
                )
            )
        out["sub_work_orders"] = clean
    if raw.get("due_in_days") not in (None, ""):
        try:
            out["due_in_days"] = int(raw["due_in_days"])
        except (TypeError, ValueError) as e:
            raise RuleError("Due in days must be a whole number.", 422) from e
    return out


def _clean_procedures(org_id: uuid.UUID, ids: Any) -> list[str]:
    if not ids:
        return []
    if not isinstance(ids, list) or len(ids) > 20:
        raise RuleError("Attach up to 20 procedures.", 422)
    from mpro.procedures.models import Procedure

    out = []
    for raw in ids:
        pid = _uuid(raw, "procedure")
        p = db.session.get(Procedure, pid)
        if p is None or p.org_id != org_id or p.deleted_at is not None:
            raise RuleError("One of the procedures doesn't exist.", 422)
        if str(pid) not in out:
            out.append(str(pid))
    return out


def _clean_calendar(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise RuleError("Calendar rules must be an object.", 422)
    months = raw.get("months") or []
    if not isinstance(months, list) or not all(isinstance(x, int) and 1 <= x <= 12 for x in months):
        raise RuleError("Months are 1 to 12.", 422)
    shift = raw.get("shift") or "previous"
    if shift not in ("previous", "next", "skip"):
        raise RuleError("Shift to the previous or next workday, or skip.", 422)
    return {
        "months": sorted(set(months)),
        "skip_weekends": bool(raw.get("skip_weekends")),
        "skip_holidays": bool(raw.get("skip_holidays")),
        "shift": shift,
    }


def _apply_task(org: Organization, plan: MaintenancePlan, t: PMTask, data: dict[str, Any]) -> None:
    from mpro.meters.models import Meter

    t.name = str(data.get("name", t.name) or "").strip()[:255]
    tz = _tz(plan)
    if "anchor" in data or "spec" in data or "rrule" in data:
        anchor = _dt(data.get("anchor"), "First due date") if data.get("anchor") else t.anchor
        if anchor is None and (data.get("spec") or data.get("rrule")):
            raise RuleError("Pick the first due date.", 422)
        t.anchor = anchor
        if data.get("spec"):
            assert anchor is not None
            t.spec = dict(data["spec"])
            t.rrule = sch.build_rrule(t.spec, sch.to_local(anchor, tz))
        elif data.get("rrule"):
            t.rrule, t.spec = sch.validate_rrule(str(data["rrule"])), {}
        elif "spec" in data or "rrule" in data:
            t.rrule, t.spec = "", {}
    if "meter_id" in data:
        if data["meter_id"]:
            mt = db.session.get(Meter, _uuid(data["meter_id"], "meter"))
            if mt is None or mt.org_id != org.id or mt.deleted_at is not None:
                raise RuleError("That meter doesn't exist.", 422)
            t.meter_id = mt.id
        else:
            t.meter_id = None
    if "every_units" in data:
        t.every_units = _dec(data["every_units"], "Interval")
        if t.every_units is not None and t.every_units <= 0:
            raise RuleError("The meter interval must be more than zero.", 422)
    if "lead_units" in data:
        t.lead_units = _dec(data["lead_units"], "Create ahead")
    if "start_units" in data and data["start_units"] not in (None, ""):
        t.next_units = _dec(data["start_units"], "First reading")
    if "overrides" in data:
        o = _clean_defaults(org, data["overrides"] or {})
        o.pop("procedure_ids", None)
        t.overrides = o
    if "procedure_ids" in data:
        t.procedure_ids = _clean_procedures(org.id, data["procedure_ids"])
    timed = bool(t.rrule)
    usage = bool(t.meter_id and t.every_units)
    kind = plan.schedule_kind
    if kind == "time" and not timed:
        raise RuleError("Each task needs how often it repeats.", 422)
    if kind == "usage" and not usage:
        raise RuleError("Each task needs a meter and how many units between visits.", 422)
    if kind == "time_or_usage" and not (timed and usage):
        raise RuleError("Each task needs both a time interval and a meter interval.", 422)
    if usage and t.next_units is None:
        mt = db.session.get(Meter, t.meter_id)
        base = mt.last_value if mt is not None and mt.last_value is not None else Decimal(0)
        assert t.every_units is not None
        t.next_units = base + t.every_units


def _apply_plan(org: Organization, plan: MaintenancePlan, data: dict[str, Any]) -> None:
    from mpro.assets.services import get_asset, get_location

    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise RuleError("The plan needs a name.", 422)
        plan.name = name[:255]
    if "description" in data:
        plan.description = str(data["description"] or "")[:4096]
    if "asset_id" in data:
        plan.asset_id = get_asset(org.id, data["asset_id"]).id if data["asset_id"] else None
        if plan.asset_id and "location_id" not in data:
            from mpro.assets.models import Asset

            plan.location_id = db.session.get(Asset, plan.asset_id).location_id  # type: ignore[union-attr]
    if "location_id" in data:
        plan.location_id = get_location(org.id, data["location_id"]).id if data["location_id"] else None
    if "schedule_kind" in data:
        if data["schedule_kind"] not in SCHEDULE_KINDS:
            raise RuleError("Schedules are time-based, usage-based, or whichever comes first.", 422)
        plan.schedule_kind = data["schedule_kind"]
    if "interval_mode" in data:
        if data["interval_mode"] not in INTERVAL_MODES:
            raise RuleError("Intervals are fixed (original schedule) or floating (from last completion).", 422)
        plan.interval_mode = data["interval_mode"]
    if "timezone" in data:
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(str(data["timezone"]))
        except Exception as e:
            raise RuleError("Unknown time zone.", 422) from e
        plan.timezone = str(data["timezone"])
    for k, lo, hi, label in (
        ("horizon_days", 0, 365, "Scheduling horizon"),
        ("start_offset_days", 0, 365, "Start date offset"),
    ):
        if k in data:
            try:
                n = int(data[k])
            except (TypeError, ValueError) as e:
                raise RuleError(f"{label} must be a whole number of days.", 422) from e
            if not lo <= n <= hi:
                raise RuleError(f"{label} must be between {lo} and {hi} days.", 422)
            setattr(plan, k, n)
    if "defaults" in data:
        plan.defaults = _clean_defaults(org, data["defaults"])
    if "calendar" in data:
        plan.calendar = _clean_calendar(data["calendar"])


def _save_tasks(org: Organization, plan: MaintenancePlan, items: Any) -> None:
    if not isinstance(items, list) or not items:
        raise RuleError("A plan needs at least one task.", 422)
    if len(items) > MAX_TASKS:
        raise RuleError(f"A plan can have up to {MAX_TASKS} nested tasks.", 422)
    existing = {str(t.id): t for t in tasks_of(plan)}
    keep: set[str] = set()
    for n, raw in enumerate(items):
        if not isinstance(raw, dict):
            raise RuleError("Each task must be an object.", 422)
        t = existing.get(str(raw.get("id") or ""))
        if t is None:
            t = PMTask(org_id=org.id, plan_id=plan.id, name="", rrule="", spec={}, overrides={}, procedure_ids=[])
            db.session.add(t)
            data = {"anchor": None, "spec": None, "rrule": None, "meter_id": None, "every_units": None, **raw}
        else:
            data = raw
        t.sort = n
        _apply_task(org, plan, t, data)
        db.session.flush()
        keep.add(str(t.id))
    for tid, t in existing.items():
        if tid not in keep:
            t.deleted_at = utcnow()


def create_plan(
    org: Organization, m: Membership, data: dict[str, Any], kind: str = "plan", commit: bool = True
) -> MaintenancePlan:
    plan = MaintenancePlan(
        org_id=org.id,
        kind=kind,
        name="",
        description="",
        active=True,
        schedule_kind="time",
        interval_mode="fixed",
        timezone=org.timezone or "UTC",
        horizon_days=14 if kind == "plan" else 7,
        start_offset_days=0,
        defaults={},
        calendar={},
        created_by_id=m.user_id,
        version=1,
    )
    _apply_plan(
        org,
        plan,
        {"name": data.get("name", ""), **{k: v for k, v in data.items() if k not in ("name", "tasks", "kind")}},
    )
    db.session.add(plan)
    db.session.flush()
    _save_tasks(org, plan, data.get("tasks"))
    emit(
        "pm.plan_created",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        summary=f"Created {'repeating work order' if kind == 'repeat' else 'maintenance plan'} {plan.name}",
    )
    db.session.flush()
    generate_plan(org, plan)
    if commit:
        db.session.commit()
    return plan


def update_plan(
    org: Organization, m: Membership, plan: MaintenancePlan, data: dict[str, Any], expected_version: int | None = None
) -> MaintenancePlan:
    """Editing a plan changes future occurrences only: generated work orders and history stay as they are."""
    if expected_version is not None and expected_version != plan.version:
        raise RuleError("Someone else changed this plan. Reload and try again.", 409)
    before = {
        k: getattr(plan, k)
        for k in ("name", "schedule_kind", "interval_mode", "horizon_days", "start_offset_days", "active")
    }
    _apply_plan(org, plan, {k: v for k, v in data.items() if k not in ("tasks", "kind", "version")})
    if "tasks" in data:
        _save_tasks(org, plan, data["tasks"])
        # drop future occurrences that were only planned (not generated, not edited by a person) so they re-plan
        for occ in db.session.scalars(
            select(PMOccurrence).where(
                PMOccurrence.plan_id == plan.id, PMOccurrence.status == "planned", PMOccurrence.overrides == {}
            )
        ).all():
            db.session.delete(occ)
    plan.version += 1
    after = {k: getattr(plan, k) for k in before}
    emit(
        "pm.plan_updated",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        summary="Changed the plan",
        changes={k: (before[k], after[k]) for k in after if before[k] != after[k]},
    )
    db.session.flush()
    generate_plan(org, plan)
    db.session.commit()
    return plan


def set_active(org: Organization, m: Membership, plan: MaintenancePlan, active: bool) -> MaintenancePlan:
    if plan.active != active:
        plan.active = active
        plan.version += 1
        emit(
            "pm.plan_resumed" if active else "pm.plan_paused",
            entity_type="maintenance_plan",
            entity_id=plan.id,
            entity_label=plan.name,
            summary="Resumed the plan" if active else "Paused the plan",
        )
        if active:
            db.session.flush()
            generate_plan(org, plan)
    db.session.commit()
    return plan


def delete_plan(org: Organization, m: Membership, plan: MaintenancePlan, commit: bool = True) -> None:
    """Deleting stops future work; generated work orders and their history stay."""
    plan.deleted_at, plan.active = utcnow(), False
    for occ in db.session.scalars(
        select(PMOccurrence).where(PMOccurrence.plan_id == plan.id, PMOccurrence.status == "planned")
    ).all():
        db.session.delete(occ)
    emit(
        "pm.plan_deleted",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        summary=f"Deleted {plan.name}",
    )
    if commit:
        db.session.commit()


# ---- schedule computation ---------------------------------------------------------------------
def _time_dues(
    org_id: uuid.UUID, plan: MaintenancePlan, tasks: list[PMTask], start: datetime, end: datetime, hol: set[date]
) -> dict[str, tuple[datetime, list[PMTask]]]:
    """Time-based due dates in [start, end), merged by local day (nested PMs: one visit does everything due)."""
    tz = _tz(plan)
    groups: dict[str, tuple[datetime, list[PMTask]]] = {}
    floating = plan.interval_mode == "floating"
    for t in tasks:
        if not t.rrule or t.anchor is None:
            continue
        if floating:
            base = t.last_completed_at
            dues = [t.anchor] if base is None else [d for d in [sch.next_after(t.rrule, base, t.anchor, tz)] if d]
            dues = [d for d in dues if start <= d < end]
        else:
            dues = sch.expand(t.rrule, t.anchor, tz, max(start, t.anchor), end)
        for d in dues:
            shifted = sch.apply_calendar(d, plan.calendar or {}, tz, hol)
            if shifted is None:
                continue
            key = "t:" + sch.to_local(shifted, tz).date().isoformat()
            if key in groups:
                due, ts = groups[key]
                groups[key] = (min(due, shifted), [*ts, t])
            else:
                groups[key] = (shifted, [t])
    return groups


def _occurrences(plan: MaintenancePlan) -> dict[str, PMOccurrence]:
    return {o.key: o for o in db.session.scalars(select(PMOccurrence).where(PMOccurrence.plan_id == plan.id)).all()}


def generate_plan(org: Organization, plan: MaintenancePlan, now: datetime | None = None) -> list[PMOccurrence]:
    """Create occurrences and work orders due within the plan's horizon. Safe to run again (idempotent)."""
    if not plan.active or plan.deleted_at is not None:
        return []
    now = now or utcnow()
    tz = _tz(plan)
    tasks = tasks_of(plan)
    have = _occurrences(plan)
    made: list[PMOccurrence] = []
    if plan.interval_mode == "floating" and any(o.status == "generated" for o in have.values()):
        pass  # floating: the next one is scheduled when the open one is completed
    else:
        day_start = sch.to_utc(sch.to_local(now, tz).replace(hour=0, minute=0, second=0, microsecond=0), tz)
        end = now + timedelta(days=plan.horizon_days, seconds=1)
        for key, (due, ts) in sorted(_time_dues(org.id, plan, tasks, day_start, end, holidays(org.id)).items()):
            if key in have:
                continue
            occ = PMOccurrence(
                org_id=org.id,
                plan_id=plan.id,
                key=key,
                task_ids=[str(t.id) for t in ts],
                due_at=due,
                original_due_at=due,
                status="planned",
                overrides={},
                skip_reason="",
            )
            db.session.add(occ)
            have[key] = occ
            if plan.interval_mode == "floating":
                break
    db.session.flush()
    horizon_end = now + timedelta(days=plan.horizon_days, seconds=1)
    for occ in sorted(have.values(), key=lambda o: o.due_at or now):
        due_soon = occ.status == "planned" and occ.due_at is not None and occ.due_at <= horizon_end
        if due_soon and _generate_wo(org, plan, occ, tasks):
            made.append(occ)
    return made


def _merged_details(plan: MaintenancePlan, tasks: list[PMTask], occ: PMOccurrence) -> dict[str, Any]:
    d = dict(plan.defaults or {})
    mine = [t for t in tasks if str(t.id) in (occ.task_ids or [])]
    names = [t.name for t in mine if t.name]
    title = d.get("title") or plan.name
    if plan.kind == "plan" and names:
        title = f"{plan.name}: {', '.join(names)}"
    desc = [d.get("description") or ""]
    prio = d.get("priority", "none")
    est = d.get("estimated_minutes") or 0
    assignees = list(d.get("assignees") or [])
    cats = list(d.get("categories") or [])
    procs = list(d.get("procedure_ids") or [])
    for t in mine:
        o = t.overrides or {}
        if o.get("description"):
            desc.append(f"{t.name or 'Task'}: {o['description']}" if len(mine) > 1 else o["description"])
        if PRIORITY_RANK.get(o.get("priority", "none"), 0) > PRIORITY_RANK.get(prio, 0):
            prio = o["priority"]
        if o.get("estimated_minutes"):
            est = (est or 0) + int(o["estimated_minutes"])
        assignees += [a for a in o.get("assignees") or [] if a not in assignees]
        cats += [c for c in o.get("categories") or [] if c not in cats]
        procs += [p for p in t.procedure_ids or [] if p not in procs]
    ov = occ.overrides or {}
    if "assignees" in ov:
        assignees = list(ov["assignees"])
    return {
        "title": title[:255],
        "description": "\n\n".join(x for x in desc if x)[:4096],
        "priority": prio,
        "estimated_minutes": est or None,
        "assignees": assignees,
        "categories": cats,
        "custom": d.get("custom") or {},
        "procedure_ids": procs,
        "sub_work_orders": d.get("sub_work_orders") or [],
    }


def _generate_wo(org: Organization, plan: MaintenancePlan, occ: PMOccurrence, tasks: list[PMTask]) -> bool:
    from mpro.workorders.services import create_work_order

    actor = _actor(org, plan)
    if actor is None:  # pragma: no cover
        return False
    det = _merged_details(plan, tasks, occ)
    due = occ.due_at or utcnow()
    data: dict[str, Any] = {
        "title": det["title"],
        "description": det["description"],
        "priority": det["priority"],
        "work_type": "preventive",
        "estimated_minutes": det["estimated_minutes"],
        "assignees": det["assignees"],
        "categories": det["categories"],
        "custom": det["custom"],
        "due_at": due.isoformat(),
    }
    if plan.start_offset_days:
        data["start_at"] = (due - timedelta(days=plan.start_offset_days)).isoformat()
    if plan.asset_id:
        data["asset_id"] = str(plan.asset_id)
    if plan.location_id:
        data["location_id"] = str(plan.location_id)
    from mpro.workorders.services import ensure_default_categories

    ensure_default_categories(org.id)  # may commit, so before the savepoint
    try:
        with db.session.begin_nested():
            wo = create_work_order(org, actor, data, commit=False, check_required=False)
            wo.source_type, wo.source_id = "pm_occurrence", occ.id
            _attach_procedures(org, actor, wo, det["procedure_ids"])
            for sub in det["sub_work_orders"]:
                sd = {
                    **{
                        k: v
                        for k, v in sub.items()
                        if k in ("title", "description", "priority", "assignees", "estimated_minutes")
                    },
                    "parent_id": str(wo.id),
                    "due_at": data["due_at"],
                    "work_type": "preventive",
                }
                if plan.asset_id:
                    sd["asset_id"] = str(plan.asset_id)
                create_work_order(org, actor, sd, commit=False, check_required=False)
    except RuleError as e:
        log.warning("PM %s: couldn't create the work order for %s: %s", plan.id, occ.key, e.message)
        return False
    occ.status, occ.work_order_id, occ.generated_at = "generated", wo.id, utcnow()
    _reset_other_schedule(plan, tasks, occ, via="time" if occ.key.startswith("t:") else "usage")
    emit(
        "pm.generated",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        org_id=org.id,
        summary=f"Created work order #{wo.number} due {sch.to_local(due, _tz(plan)):%Y-%m-%d}",
        data={"occurrence_id": occ.id, "work_order_id": wo.id},
    )
    return True


def _attach_procedures(org: Organization, m: Membership, wo: WorkOrder, ids: list[str]) -> None:
    if not ids:
        return
    try:
        from mpro.procedures.services import attach_procedures
    except ImportError:  # pragma: no cover - procedures module not built yet
        log.warning("Procedures aren't available; skipped attaching %s", ids)
        return
    attach_procedures(org, m, wo, ids, commit=False)


def _reset_other_schedule(plan: MaintenancePlan, tasks: list[PMTask], occ: PMOccurrence, via: str) -> None:
    """Whichever comes first (r164): when one trigger fires, the other counts again from now."""
    if plan.schedule_kind != "time_or_usage":
        return
    from mpro.meters.models import Meter

    for t in tasks:
        if str(t.id) not in (occ.task_ids or []):
            continue
        if via == "time" and t.meter_id and t.every_units:
            mt = db.session.get(Meter, t.meter_id)
            t.next_units = (mt.last_value if mt and mt.last_value is not None else Decimal(0)) + t.every_units
        elif via == "usage" and t.anchor is not None and t.rrule:
            tz = _tz(plan)
            a = sch.to_local(t.anchor, tz)
            today = sch.to_local(utcnow(), tz).replace(hour=a.hour, minute=a.minute, second=0, microsecond=0)
            nxt = sch.next_after(t.rrule, sch.to_utc(today, tz), t.anchor, tz)
            if nxt:
                t.anchor = nxt
                for o in db.session.scalars(
                    select(PMOccurrence).where(
                        PMOccurrence.plan_id == plan.id,
                        PMOccurrence.status == "planned",
                        PMOccurrence.key.startswith("t:"),
                        PMOccurrence.overrides == {},
                    )
                ).all():
                    db.session.delete(o)


# ---- usage-based (meter readings) -----------------------------------------------------------------
def on_meter_reading(org: Organization, mt: Any, prev: Decimal | None, v: Decimal, r: Any) -> None:
    """Registered in meters READING_HOOKS: create PM work orders when a meter reaches the next milestone."""
    rows = db.session.execute(
        select(PMTask, MaintenancePlan)
        .join(MaintenancePlan, MaintenancePlan.id == PMTask.plan_id)
        .where(
            PMTask.meter_id == mt.id,
            PMTask.deleted_at.is_(None),
            MaintenancePlan.deleted_at.is_(None),
            MaintenancePlan.active.is_(True),
            MaintenancePlan.schedule_kind.in_(("usage", "time_or_usage")),
        )
        .with_for_update(of=PMTask)
    ).all()
    for t, plan in rows:
        if not t.every_units or t.next_units is None:
            continue
        lead = t.lead_units or Decimal(0)
        if v < t.next_units - lead:
            continue
        key = f"u:{t.id}:{_num(t.next_units)}"
        if db.session.scalar(select(PMOccurrence.id).where(PMOccurrence.plan_id == plan.id, PMOccurrence.key == key)):
            continue
        due_days = int((plan.defaults or {}).get("due_in_days") or 0)
        occ = PMOccurrence(
            org_id=org.id,
            plan_id=plan.id,
            key=key,
            task_ids=[str(t.id)],
            due_units=t.next_units,
            due_at=utcnow() + timedelta(days=due_days),
            original_due_at=None,
            status="planned",
            overrides={},
            skip_reason="",
        )
        db.session.add(occ)
        db.session.flush()
        occ.original_due_at = occ.due_at
        _generate_wo(org, plan, occ, tasks_of(plan))
        if plan.interval_mode == "floating":
            t.next_units = None  # set again from the reading at completion
        else:
            while t.next_units is not None and t.next_units <= v:
                t.next_units += t.every_units
            if t.next_units is not None and t.next_units - lead <= v:  # created early via lead: next milestone
                t.next_units += t.every_units


# ---- work order lifecycle hooks ------------------------------------------------------------------
def on_status_change(org: Organization, m: Membership, wo: WorkOrder, before: str, after: str) -> None:
    """Registered in workorders STATUS_HOOKS: occurrence completion, floating intervals, sub-WO reopening."""
    if wo.source_type == "pm_occurrence" and wo.source_id:
        occ = db.session.get(PMOccurrence, wo.source_id)
        if occ is not None and occ.work_order_id == wo.id:
            plan = db.session.get(MaintenancePlan, occ.plan_id)
            if after == "done":
                occ.status, occ.completed_at = "completed", wo.completed_at or utcnow()
                if plan is not None:
                    for t in tasks_of(plan):
                        if str(t.id) in (occ.task_ids or []):
                            t.last_completed_at = occ.completed_at
                            if plan.interval_mode == "floating" and t.meter_id and t.every_units:
                                from mpro.meters.models import Meter

                                mt = db.session.get(Meter, t.meter_id)
                                base = mt.last_value if mt and mt.last_value is not None else Decimal(0)
                                t.next_units = base + t.every_units
                    db.session.flush()
                    generate_plan(org, plan)
            elif after == "canceled":
                occ.status = "canceled" if occ.status != "skipped" else occ.status
            elif before in ("done", "canceled") and after in ACTIVE_STATUSES:
                occ.status, occ.completed_at = "generated", None
    # reopening a sub-work order reopens its parent (r160)
    if wo.parent_id and before in ("done", "canceled") and after in ACTIVE_STATUSES:
        from mpro.workorders.services import set_status

        parent = db.session.get(WorkOrder, wo.parent_id)
        if parent is not None and parent.deleted_at is None and parent.status == "done":
            set_status(
                org,
                m,
                parent,
                "open",
                comment=f"Reopened because sub-work order #{wo.number} was reopened.",
                commit=False,
            )


def inherit_from_parent(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> None:
    """Registered in workorders CREATE_HOOKS: new sub-work orders inherit the parent's details (r159)."""
    if not wo.parent_id:
        return
    from mpro.workorders.services import _set_assignees, _set_categories

    parent = db.session.get(WorkOrder, wo.parent_id)
    if parent is None:
        return
    if not data.get("assignees") and parent.assignees:
        _set_assignees(wo, [("user", a.user_id) if a.user_id else ("team", a.team_id) for a in parent.assignees])  # type: ignore[misc]
    if "categories" not in data and parent.category_links:
        _set_categories(wo, [str(c.category_id) for c in parent.category_links])
    if "work_type" not in data:
        wo.work_type = parent.work_type
    if "priority" not in data:
        wo.priority = parent.priority
    if "due_at" not in data and parent.due_at:
        wo.due_at = parent.due_at
    if "start_at" not in data and parent.start_at:
        wo.start_at = parent.start_at
    if wo.start_at and wo.due_at and wo.start_at > wo.due_at:
        wo.start_at = None


# ---- occurrences: preview and per-occurrence changes ------------------------------------------------
def occurrence_dict(
    plan: MaintenancePlan,
    occ: PMOccurrence | None,
    key: str,
    due: datetime | None,
    task_ids: list[str],
    names: dict[str, str],
    wo: WorkOrder | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "id": str(occ.id) if occ else None,
        "due_at": iso(occ.due_at if occ else due),
        "original_due_at": iso(occ.original_due_at)
        if occ and occ.original_due_at and occ.original_due_at != occ.due_at
        else None,
        "due_units": _num(occ.due_units) if occ else None,
        "status": occ.status if occ else "upcoming",
        "tasks": [{"id": t, "name": names.get(t, "")} for t in (occ.task_ids if occ else task_ids)],
        "skip_reason": occ.skip_reason if occ else "",
        "overrides": occ.overrides if occ else {},
        "work_order": {"id": str(wo.id), "number": wo.number, "status": wo.status, "title": wo.title} if wo else None,
        "completed_at": iso(occ.completed_at) if occ else None,
    }


def upcoming(
    plan: MaintenancePlan, count: int = 12, days: int = 400, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Stored and computed occurrences from today on (plan preview, r168)."""
    now = now or utcnow()
    tz = _tz(plan)
    tasks = tasks_of(plan)
    names = {str(t.id): t.name or plan.name for t in tasks}
    have = _occurrences(plan)
    start = sch.to_utc(sch.to_local(now, tz).replace(hour=0, minute=0, second=0, microsecond=0), tz)
    end = now + timedelta(days=max(1, min(days, 1500)))
    items: dict[str, dict[str, Any]] = {}
    wos = {
        w.id: w
        for w in db.session.scalars(
            select(WorkOrder).where(WorkOrder.id.in_([o.work_order_id for o in have.values() if o.work_order_id]))
        ).all()
    }
    for o in have.values():
        if o.status in ("planned", "generated", "skipped") and (
            o.due_at is None or o.due_at >= start or o.status == "generated"
        ):
            items[o.key] = occurrence_dict(
                plan, o, o.key, o.due_at, o.task_ids, names, wos.get(o.work_order_id) if o.work_order_id else None
            )
    if plan.interval_mode == "floating":
        # assume on-time completion to preview the chain
        sim = [PMTask(id=t.id, rrule=t.rrule, anchor=t.anchor, last_completed_at=t.last_completed_at) for t in tasks]
        cursor_items = 0
        open_occ = [o for o in have.values() if o.status in ("generated", "planned") and o.due_at]
        base = max([o.due_at for o in open_occ if o.due_at], default=None)
        for _ in range(count):
            dues = []
            for t in sim:
                if not t.rrule or t.anchor is None:
                    continue
                b = base or t.last_completed_at
                d = t.anchor if b is None else sch.next_after(t.rrule, b, t.anchor, tz)
                if d and d >= start:
                    dues.append(d)
            if not dues:
                break
            d = min(dues)
            key = "t:" + sch.to_local(d, tz).date().isoformat()
            if key not in items:
                items[key] = occurrence_dict(plan, None, key, d, [str(t.id) for t in tasks if t.rrule], names)
                cursor_items += 1
            base = d
            if d > end:
                break
    else:
        for key, (due, ts) in _time_dues(plan.org_id, plan, tasks, start, end, holidays(plan.org_id)).items():
            if key not in items and key not in have:
                items[key] = occurrence_dict(plan, None, key, due, [str(t.id) for t in ts], names)
    out = sorted(items.values(), key=lambda x: (x["due_at"] or "9999", x["key"]))
    for t in tasks:  # usage milestones have no date until the meter gets there
        if t.meter_id and t.every_units and t.next_units is not None:
            out.append(
                {
                    "key": f"u:{t.id}:{_num(t.next_units)}",
                    "id": None,
                    "due_at": None,
                    "original_due_at": None,
                    "due_units": _num(t.next_units),
                    "status": "upcoming",
                    "tasks": [{"id": str(t.id), "name": names[str(t.id)]}],
                    "skip_reason": "",
                    "overrides": {},
                    "work_order": None,
                    "completed_at": None,
                }
            )
    return out[: max(1, min(count, 200))]


def _materialize(plan: MaintenancePlan, key: str) -> PMOccurrence:
    occ = db.session.scalars(
        select(PMOccurrence).where(PMOccurrence.plan_id == plan.id, PMOccurrence.key == key)
    ).first()
    if occ is not None:
        return occ
    for it in upcoming(plan, count=200, days=1500):
        if it["key"] == key and it["due_at"]:
            due = datetime.fromisoformat(it["due_at"].replace("Z", "+00:00"))
            occ = PMOccurrence(
                org_id=plan.org_id,
                plan_id=plan.id,
                key=key,
                task_ids=[t["id"] for t in it["tasks"]],
                due_at=due,
                original_due_at=due,
                status="planned",
                overrides={},
                skip_reason="",
            )
            db.session.add(occ)
            db.session.flush()
            return occ
    raise RuleError("That occurrence isn't on this plan's schedule.", 404)


def adjust_occurrence(
    org: Organization, m: Membership, plan: MaintenancePlan, key: str, data: dict[str, Any]
) -> PMOccurrence:
    """Per-occurrence changes (r169, r597): move, reassign, skip or postpone one date without changing the series."""
    from mpro.workorders.services import _resolve_assignees, _set_assignees, set_status, touch

    action = data.get("action")
    if action not in ("move", "reassign", "skip", "postpone", "unskip"):
        raise RuleError("Move, reassign, skip, postpone or unskip.", 422)
    reason = str(data.get("reason") or "").strip()[:2000]
    if action in ("skip", "postpone") and not can(m, "pm.skip"):
        raise RuleError("You can't skip or postpone scheduled maintenance.", 403)
    if action in ("skip", "postpone") and not reason:
        raise RuleError("Add a reason. It's kept with the PM compliance record.", 422)
    occ = _materialize(plan, key)
    wo = db.session.get(WorkOrder, occ.work_order_id) if occ.work_order_id else None
    if occ.status == "completed":
        raise RuleError("This one is already done.", 409)
    if action in ("move", "postpone"):
        new = _dt(data.get("due_at"), "New due date")
        if new is None:
            raise RuleError("Pick the new due date.", 422)
        if action == "postpone" and occ.due_at and new <= occ.due_at:
            raise RuleError("Postpone moves it later. Use Move to bring it forward.", 422)
        occ.original_due_at = occ.original_due_at or occ.due_at
        occ.due_at = new
        if action == "postpone":
            occ.skip_reason = reason
            occ.skipped_by_id = m.user_id
        occ.overrides = {**(occ.overrides or {}), "moved": True}
        if wo is not None and wo.status in ACTIVE_STATUSES:
            wo.due_at = new
            if wo.start_at and wo.start_at > new:
                wo.start_at = None
            wo.version += 1
            touch(wo, m.user_id)
    elif action == "reassign":
        pairs = _resolve_assignees(org.id, data.get("assignees") or [])
        occ.overrides = {**(occ.overrides or {}), "assignees": [f"{k}:{v}" for k, v in pairs]}
        if wo is not None and wo.status in ACTIVE_STATUSES:
            _set_assignees(wo, pairs)
            wo.version += 1
            touch(wo, m.user_id)
    elif action == "skip":
        return _skip(org, m, plan, key, reason)
    elif action == "unskip":
        if occ.status != "skipped":
            raise RuleError("This one isn't skipped.", 409)
        occ.status, occ.skip_reason = ("generated" if wo is not None else "planned"), ""
        if wo is not None and wo.status == "canceled":
            set_status(org, m, wo, "open", commit=False)
            occ.status = "generated"
    emit(
        f"pm.occurrence_{action}",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        summary={"move": "Moved", "reassign": "Reassigned", "postpone": "Postponed", "unskip": "Restored"}[action]
        + f" the {occ.key[2:] if occ.key.startswith('t:') else occ.key} visit"
        + (f": {reason}" if reason else ""),
        data={"occurrence_id": occ.id, "reason": reason},
    )
    db.session.flush()
    generate_plan(org, plan)
    db.session.commit()
    return occ


# ---- compliance (r200) ---------------------------------------------------------------------------
def compliance(
    plans: list[MaintenancePlan], start: datetime, end: datetime, now: datetime | None = None
) -> dict[str, Any]:
    """On time vs late vs missed vs skipped. Postponed visits are judged against their original date."""
    now = now or utcnow()
    ids = [p.id for p in plans]
    out: dict[str, Any] = {"on_time": 0, "late": 0, "missed": 0, "skipped": 0, "open": 0}
    per: dict[uuid.UUID, dict[str, int]] = {p.id: {k: 0 for k in out} for p in plans}
    tzs = {p.id: _tz(p) for p in plans}
    if not ids:
        return {**out, "percent": None, "plans": {}}
    occs = db.session.scalars(
        select(PMOccurrence).where(
            PMOccurrence.plan_id.in_(ids),
            PMOccurrence.status != "planned",
            func.coalesce(PMOccurrence.original_due_at, PMOccurrence.due_at) >= start,
            func.coalesce(PMOccurrence.original_due_at, PMOccurrence.due_at) < end,
        )
    ).all()
    for o in occs:
        due = o.original_due_at or o.due_at
        if due is None:
            continue
        tz = tzs[o.plan_id]
        end_of_day = sch.to_utc(sch.to_local(due, tz).replace(hour=23, minute=59, second=59, microsecond=0), tz)
        if o.status == "skipped" or (
            o.skip_reason and o.original_due_at and o.status != "completed" and end_of_day < now
        ):
            k = "skipped" if o.status == "skipped" else "missed"
        elif o.status == "completed" and o.completed_at:
            k = "on_time" if o.completed_at <= end_of_day else "late"
        elif end_of_day < now:
            k = "missed"
        else:
            k = "open"
        out[k] += 1
        per[o.plan_id][k] += 1

    def pct(d: dict[str, int]) -> float | None:
        denom = d["on_time"] + d["late"] + d["missed"] + d["skipped"]
        return round(100 * d["on_time"] / denom, 1) if denom else None

    return {**out, "percent": pct(out), "plans": {str(k): {**v, "percent": pct(v)} for k, v in per.items()}}


# ---- repeating work orders (MP-032) ------------------------------------------------------------------
def plan_of(wo: WorkOrder) -> tuple[MaintenancePlan | None, PMOccurrence | None]:
    if wo.source_type != "pm_occurrence" or not wo.source_id:
        return None, None
    occ = db.session.get(PMOccurrence, wo.source_id)
    if occ is None:
        return None, None
    return db.session.get(MaintenancePlan, occ.plan_id), occ


def recurrence_summary(wo: WorkOrder) -> dict[str, Any] | None:
    plan, occ = plan_of(wo)
    if plan is None or plan.deleted_at is not None:
        return None
    tz = _tz(plan)
    tasks = tasks_of(plan)
    t = tasks[0] if tasks else None
    if plan.kind == "repeat" and t is not None:
        text = sch.describe(
            t.spec, sch.to_local(t.anchor, tz) if t.anchor else None, plan.interval_mode == "floating"
        ) or sch.describe_rrule(t.rrule)
    else:
        text = f"Maintenance plan · {plan.name}"
    nxt = db.session.scalars(
        select(PMOccurrence)
        .where(
            PMOccurrence.plan_id == plan.id,
            PMOccurrence.status.in_(("planned", "generated")),
            PMOccurrence.id != (occ.id if occ else None),
            PMOccurrence.due_at > (occ.due_at if occ and occ.due_at else utcnow()),
        )
        .order_by(PMOccurrence.due_at)
    ).first()
    preview = None
    if nxt is None and plan.active:
        future = [
            x
            for x in upcoming(plan, count=5)
            if x["due_at"] and (not occ or x["key"] != occ.key) and x["status"] == "upcoming"
        ]
        preview = future[0] if future else None
    return {
        "plan_id": str(plan.id),
        "kind": plan.kind,
        "name": plan.name,
        "summary": text,
        "active": plan.active,
        "interval_mode": plan.interval_mode,
        "spec": t.spec if t else {},
        "horizon_days": plan.horizon_days,
        "next_due_at": iso(nxt.due_at) if nxt else (preview["due_at"] if preview else None),
        "next_key": nxt.key if nxt else (preview["key"] if preview else None),
    }


def _snapshot_defaults(wo: WorkOrder) -> dict[str, Any]:
    subs = db.session.scalars(
        select(WorkOrder).where(WorkOrder.parent_id == wo.id, WorkOrder.deleted_at.is_(None)).order_by(WorkOrder.number)
    ).all()
    d: dict[str, Any] = {
        "title": wo.title,
        "description": wo.description,
        "priority": wo.priority,
        "assignees": [f"user:{a.user_id}" if a.user_id else f"team:{a.team_id}" for a in wo.assignees],
        "categories": [str(c.category_id) for c in wo.category_links],
        "estimated_minutes": wo.estimated_minutes,
        "custom": dict(wo.custom or {}),
        "sub_work_orders": [
            {
                "title": s.title,
                "description": s.description,
                "priority": s.priority,
                "estimated_minutes": s.estimated_minutes,
                "assignees": [f"user:{a.user_id}" if a.user_id else f"team:{a.team_id}" for a in s.assignees],
            }
            for s in subs
        ],
    }
    try:
        from mpro.procedures.models import ProcedureRun

        d["procedure_ids"] = list(
            dict.fromkeys(
                str(r.procedure_id)
                for r in db.session.scalars(
                    select(ProcedureRun).where(ProcedureRun.work_order_id == wo.id).order_by(ProcedureRun.sort)
                ).all()
            )
        )
    except Exception:  # pragma: no cover
        d["procedure_ids"] = []
    return {k: v for k, v in d.items() if v not in (None, [], {}, "")}


def set_repeat(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> MaintenancePlan:
    """Make a work order repeat (or change how it repeats). Recurrence on a parent recreates its subs (r195)."""
    from mpro.workorders.services import touch, wo_settings

    if wo.deleted_at is not None or wo.parent_id:
        raise RuleError("Sub-work orders repeat with their parent. Set the repeat on the parent.", 422)
    based_on = data.get("based_on") or "due"
    if based_on not in ("due", "completion"):
        raise RuleError("Repeat from the due date or from completion.", 422)
    plan, occ = plan_of(wo)
    if plan is not None and plan.kind != "repeat":
        raise RuleError("This work order comes from a maintenance plan. Change the plan instead.", 409)
    tz = sch.zone(org.timezone)
    if wo.due_at is None:  # MaintainX fills in tomorrow (r193)
        s = wo_settings(org.id)
        tomorrow = (sch.to_local(utcnow(), tz) + timedelta(days=1)).date()
        hh, mm = (s.get("default_due_time") or "12:00").split(":")[:2]
        wo.due_at = sch.to_utc(datetime(tomorrow.year, tomorrow.month, tomorrow.day, int(hh), int(mm)), tz)
        wo.version += 1
    days_ahead = data.get("days_ahead", 7 if plan is None else plan.horizon_days)
    task_data = {
        "spec": data.get("spec")
        or {k: data[k] for k in ("freq", "interval", "weekdays", "monthly", "last") if k in data},
        "anchor": wo.due_at.isoformat(),
        "name": "",
    }
    if plan is None:
        plan = create_plan(
            org,
            m,
            {
                "name": wo.title,
                "asset_id": str(wo.asset_id) if wo.asset_id else None,
                "location_id": str(wo.location_id) if wo.location_id else None,
                "schedule_kind": "time",
                "interval_mode": "floating" if based_on == "completion" else "fixed",
                "horizon_days": days_ahead,
                "defaults": _snapshot_defaults(wo),
                "tasks": [task_data],
                "timezone": org.timezone or "UTC",
            },
            kind="repeat",
            commit=False,
        )
        plan.source_work_order_id = wo.id
        t = tasks_of(plan)[0]
        key = "t:" + sch.to_local(wo.due_at, tz).date().isoformat()
        occ = db.session.scalars(
            select(PMOccurrence).where(PMOccurrence.plan_id == plan.id, PMOccurrence.key == key)
        ).first()
        if occ is None:
            occ = PMOccurrence(
                org_id=org.id,
                plan_id=plan.id,
                key=key,
                task_ids=[str(t.id)],
                due_at=wo.due_at,
                original_due_at=wo.due_at,
                overrides={},
                skip_reason="",
            )
            db.session.add(occ)
        elif occ.work_order_id and occ.work_order_id != wo.id:  # generated already in create_plan: drop that copy
            dup = db.session.get(WorkOrder, occ.work_order_id)
            if dup is not None:
                dup.deleted_at = utcnow()
        occ.status, occ.work_order_id, occ.generated_at = "generated", wo.id, utcnow()
        if wo.status == "done":
            occ.status, occ.completed_at = "completed", wo.completed_at
        db.session.flush()
        wo.source_type, wo.source_id = "pm_occurrence", occ.id
        if based_on == "completion" and wo.status != "done":
            pass  # the next one is planned when this one is completed
        db.session.flush()
        generate_plan(org, plan)
    else:
        update_plan(
            org,
            m,
            plan,
            {
                "interval_mode": "floating" if based_on == "completion" else "fixed",
                "horizon_days": days_ahead,
                "tasks": [{"id": str(tasks_of(plan)[0].id), **task_data}],
                "defaults": _snapshot_defaults(wo),
            },
        )
        if not plan.active:
            plan.active = True
    touch(wo, m.user_id)
    emit(
        "wo.repeat_set",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Set to repeat " + (recurrence_summary(wo) or {}).get("summary", "").lower(),
        data={"plan_id": plan.id},
    )
    db.session.commit()
    return plan


def stop_repeat(org: Organization, m: Membership, wo: WorkOrder) -> None:
    plan, _occ = plan_of(wo)
    if plan is None or plan.kind != "repeat":
        raise RuleError("This work order doesn't repeat.", 404)
    for o in db.session.scalars(
        select(PMOccurrence).where(PMOccurrence.plan_id == plan.id, PMOccurrence.status == "generated")
    ).all():
        other = db.session.get(WorkOrder, o.work_order_id) if o.work_order_id else None
        if (
            other is not None
            and other.id != wo.id
            and other.status == "open"
            and other.due_at
            and other.due_at > utcnow()
        ):
            other.deleted_at = utcnow()  # future copies that nobody started go away with the series
    emit(
        "wo.repeat_stopped",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Stopped repeating",
    )
    delete_plan(org, m, plan, commit=False)
    db.session.commit()


def skip_next(org: Organization, m: Membership, wo: WorkOrder, reason: str = "") -> PMOccurrence:
    """Skip the next occurrence of a repeating work order (r082); the one after is still generated."""
    plan, occ = plan_of(wo)
    if plan is None:
        raise RuleError("This work order doesn't repeat.", 404)
    rec = recurrence_summary(wo)
    if not rec or not rec.get("next_key"):
        raise RuleError("There's no upcoming occurrence to skip.", 409)
    if not can(m, "pm.skip") and not (plan.kind == "repeat" and can(m, "wo.edit")):
        # repeating work orders: anyone who can edit the work order can skip its next copy
        raise RuleError("You can't skip scheduled maintenance.", 403)
    return _skip(org, m, plan, rec["next_key"], reason.strip() or "Skipped from the work order")


def _skip(org: Organization, m: Membership, plan: MaintenancePlan, key: str, reason: str) -> PMOccurrence:
    from mpro.workorders.services import set_status

    occ = _materialize(plan, key)
    if occ.status == "completed":
        raise RuleError("This one is already done.", 409)
    occ.status, occ.skip_reason, occ.skipped_by_id = "skipped", reason, m.user_id
    wo = db.session.get(WorkOrder, occ.work_order_id) if occ.work_order_id else None
    if wo is not None and wo.status in ACTIVE_STATUSES:
        set_status(org, m, wo, "canceled", comment=f"Skipped: {reason}", commit=False, undo=True)
        occ.status = "skipped"
    emit(
        "pm.occurrence_skip",
        entity_type="maintenance_plan",
        entity_id=plan.id,
        entity_label=plan.name,
        summary=f"Skipped the {key[2:] if key.startswith('t:') else key} visit: {reason}",
        data={"occurrence_id": occ.id},
    )
    db.session.flush()
    generate_plan(org, plan)
    db.session.commit()
    return occ


# ---- sub-work orders (MP-118) ------------------------------------------------------------------------
def rollup(m: Membership, wo: WorkOrder) -> dict[str, Any]:
    """Time and costs of a parent plus its sub-work orders, with drill-down per sub (r194)."""
    from mpro.workorders.activity import costs_summary
    from mpro.workorders.services import can_see

    subs = [
        s
        for s in db.session.scalars(
            select(WorkOrder)
            .where(WorkOrder.parent_id == wo.id, WorkOrder.deleted_at.is_(None))
            .order_by(WorkOrder.number)
        ).all()
        if can_see(m, s)
    ]

    def tot(w: WorkOrder) -> dict[str, Any]:
        c = costs_summary(m, w)
        return {
            "minutes": c["total_minutes"],
            "labor_cents": c["labor_cents"],
            "other_cents": c["other_cents"],
            "total_cents": c["total_cents"],
        }

    own = tot(wo)
    rows = [{"id": str(s.id), "number": s.number, "title": s.title, "status": s.status, **tot(s)} for s in subs]
    total = dict(own)
    for r in rows:
        for k in ("minutes", "other_cents"):
            total[k] += r[k]
        for k in ("labor_cents", "total_cents"):
            total[k] = None if total[k] is None or r[k] is None else total[k] + r[k]
    return {"own": own, "subs": rows, "total": total}


def close_subs(org: Organization, m: Membership, wo: WorkOrder, status: str = "done") -> dict[str, Any]:
    """Close a parent's open sub-work orders (offered when the parent is marked Done, r160)."""
    from mpro.workorders.services import can_see, set_status

    if status not in ("done", "canceled"):
        raise RuleError("Close as Done or Canceled.", 422)
    done, failed = [], []
    for s in db.session.scalars(
        select(WorkOrder).where(
            WorkOrder.parent_id == wo.id, WorkOrder.deleted_at.is_(None), WorkOrder.status.in_(ACTIVE_STATUSES)
        )
    ).all():
        if not can_see(m, s):
            continue
        try:
            with db.session.begin_nested():
                set_status(org, m, s, status, comment="Closed with the parent work order.", commit=False, undo=True)
            done.append(s.number)
        except RuleError as e:
            failed.append({"number": s.number, "message": e.message})
    db.session.commit()
    return {"closed": done, "failed": failed}


# ---- holidays (MP-038) -------------------------------------------------------------------------------
def add_holiday(org: Organization, day: Any, name: str) -> Holiday:
    try:
        d = day if isinstance(day, date) else date.fromisoformat(str(day)[:10])
    except ValueError as e:
        raise RuleError("Pick a date (YYYY-MM-DD).", 422) from e
    h = db.session.scalars(select(Holiday).where(Holiday.org_id == org.id, Holiday.day == d)).first()
    if h is None:
        h = Holiday(org_id=org.id, day=d, name="")
        db.session.add(h)
    h.name = (name or "").strip()[:120]
    emit(
        "pm.holiday_saved",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary=f"Added holiday {d} {h.name}".strip(),
        org_id=org.id,
    )
    db.session.commit()
    return h


# ---- plan serialization --------------------------------------------------------------------------------
def task_dict(plan: MaintenancePlan, t: PMTask) -> dict[str, Any]:
    tz = _tz(plan)
    local = sch.to_local(t.anchor, tz) if t.anchor else None
    return {
        "id": str(t.id),
        "name": t.name,
        "rrule": t.rrule,
        "spec": t.spec or {},
        "anchor": iso(t.anchor),
        "summary": (sch.describe(t.spec, local, plan.interval_mode == "floating") or sch.describe_rrule(t.rrule))
        if t.rrule
        else "",
        "meter_id": str(t.meter_id) if t.meter_id else None,
        "every_units": _num(t.every_units),
        "next_units": _num(t.next_units),
        "lead_units": _num(t.lead_units),
        "overrides": t.overrides or {},
        "procedure_ids": t.procedure_ids or [],
        "last_completed_at": iso(t.last_completed_at),
    }


def plan_dict(plan: MaintenancePlan, extra: dict[str, Any] | None = None, with_tasks: bool = True) -> dict[str, Any]:
    from mpro.assets.models import Asset, Location

    a = db.session.get(Asset, plan.asset_id) if plan.asset_id else None
    loc = db.session.get(Location, plan.location_id) if plan.location_id else None
    tasks = tasks_of(plan)
    nxt = db.session.scalars(
        select(PMOccurrence)
        .where(
            PMOccurrence.plan_id == plan.id,
            PMOccurrence.status.in_(("planned", "generated")),
            PMOccurrence.due_at >= utcnow() - timedelta(days=1),
        )
        .order_by(PMOccurrence.due_at)
    ).first()
    next_due = iso(nxt.due_at) if nxt else None
    if next_due is None and plan.active:
        up = [x for x in upcoming(plan, count=3) if x["due_at"]]
        next_due = up[0]["due_at"] if up else None
    tz = _tz(plan)
    summaries = [task_dict(plan, t)["summary"] for t in tasks]
    usage = [f"every {_num(t.every_units):,} units" for t in tasks if t.every_units]
    d: dict[str, Any] = {
        "id": str(plan.id),
        "kind": plan.kind,
        "name": plan.name,
        "description": plan.description,
        "active": plan.active,
        "asset": {"id": str(a.id), "name": a.name, "status": a.status} if a and a.deleted_at is None else None,
        "location": {"id": str(loc.id), "name": loc.name} if loc and loc.deleted_at is None else None,
        "schedule_kind": plan.schedule_kind,
        "interval_mode": plan.interval_mode,
        "timezone": plan.timezone,
        "horizon_days": plan.horizon_days,
        "start_offset_days": plan.start_offset_days,
        "defaults": plan.defaults or {},
        "calendar": plan.calendar or {},
        "frequency": "; ".join(x for x in [*summaries, *usage] if x),
        "next_due_at": next_due,
        "task_count": len(tasks),
        "version": plan.version,
        "deleted": plan.deleted_at is not None,
        "source_work_order_id": str(plan.source_work_order_id) if plan.source_work_order_id else None,
        "created_at": iso(plan.created_at),
        "updated_at": iso(plan.updated_at),
    }
    _ = tz
    if with_tasks:
        d["tasks"] = [task_dict(plan, t) for t in tasks]
    if extra:
        d.update(extra)
    return d


def generate_all(now: datetime | None = None) -> int:
    """The `pm.generate` job: every active plan in every organization."""
    n = 0
    plans = db.session.scalars(
        select(MaintenancePlan).where(MaintenancePlan.active.is_(True), MaintenancePlan.deleted_at.is_(None))
    ).all()
    for plan in plans:
        org = db.session.get(Organization, plan.org_id)
        if org is None or org.deleted_at is not None:
            continue
        try:
            n += len(generate_plan(org, plan, now))
            db.session.commit()
        except Exception:  # keep going; the failure is logged and the job runs again later
            db.session.rollback()
            log.exception("PM generation failed for plan %s", plan.id)
    return n


_ = UTC
