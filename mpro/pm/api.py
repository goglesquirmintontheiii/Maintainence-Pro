"""Preventive maintenance REST API (/api/v1): maintenance plans, repeating work orders, PM calendar, compliance."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, or_, select

from mpro.core.jobs import job, periodic
from mpro.core.models import iso
from mpro.core.search import like, provider
from mpro.core.tenancy import require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.pm import services as svc
from mpro.pm.models import Holiday, MaintenancePlan
from mpro.workorders import services as wo_svc

bp = APIBlueprint("pm", __name__, url_prefix="/api/v1", tag="Preventive maintenance")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except RuleError as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _plan(pid: str, include_deleted: bool = False) -> MaintenancePlan:
    return guard(svc.get_plan, g.org.id, pid, include_deleted)


def _version() -> int | None:
    m = re.search(r"\d+", request.headers.get("If-Match", ""))
    if m:
        return int(m.group())
    v = body().get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _range(default_days: int = 90, max_days: int = 400) -> tuple[datetime, datetime]:
    now = datetime.now(UTC)
    try:
        start = svc._dt(request.args.get("from"), "from") if request.args.get("from") else None
        end = svc._dt(request.args.get("to"), "to") if request.args.get("to") else None
    except RuleError as e:
        abort(422, message=e.message)
    try:
        days = max(1, min(int(request.args.get("days") or default_days), max_days))
    except ValueError:
        abort(422, message="days must be a number.")
    start = start or now - timedelta(days=days)
    end = end or (start + timedelta(days=days) if request.args.get("from") else now + timedelta(days=1))
    if end <= start or (end - start).days > max_days:
        abort(422, message=f"Pick a range up to {max_days} days.")
    return start, end


# ---- plans -------------------------------------------------------------------------------------
@bp.get("/pm/plans")
@require("pm.view")
def list_plans() -> dict[str, Any]:
    """Query: kind (plan|repeat), q, asset_id, active (1|0), include_deleted, page, per_page. Each item has frequency,
    next due date and 90-day compliance."""
    a = request.args
    q = scoped(MaintenancePlan, include_deleted=a.get("include_deleted") == "1")
    if a.get("kind") in ("plan", "repeat"):
        q = q.where(MaintenancePlan.kind == a["kind"])
    if a.get("q"):
        q = q.where(func.lower(MaintenancePlan.name).like(like(a["q"]), escape="\\"))
    if a.get("asset_id"):
        q = q.where(MaintenancePlan.asset_id == svc._uuid(a["asset_id"], "asset"))
    if a.get("active") in ("1", "0"):
        q = q.where(MaintenancePlan.active.is_(a["active"] == "1"))
    total = db.session.scalar(select(func.count()).select_from(q.subquery())) or 0
    try:
        per_page, page = max(1, min(int(a.get("per_page") or 100), 500)), max(1, int(a.get("page") or 1))
    except ValueError:
        abort(422, message="page and per_page must be numbers.")
    rows = list(
        db.session.scalars(
            q.order_by(func.lower(MaintenancePlan.name)).limit(per_page).offset((page - 1) * per_page)
        ).all()
    )
    now = datetime.now(UTC)
    comp = svc.compliance(rows, now - timedelta(days=90), now + timedelta(days=1))
    return {
        "items": [svc.plan_dict(p, {"compliance": comp["plans"].get(str(p.id))}, with_tasks=False) for p in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


@bp.post("/pm/plans")
@require("pm.manage")
def create_plan() -> tuple[dict[str, Any], int]:
    """Create a maintenance plan.

    {name, description, asset_id, location_id, schedule_kind: time|usage|time_or_usage,
    interval_mode: fixed|floating, timezone, horizon_days, start_offset_days,
    calendar: {months, skip_weekends, skip_holidays, shift},
    defaults: {title, description, priority, assignees, categories, estimated_minutes, custom, procedure_ids,
    sub_work_orders, due_in_days},
    tasks: [{name, spec: {freq, interval, weekdays, monthly} | rrule, anchor (first due), meter_id, every_units,
    lead_units, start_units, overrides, procedure_ids}] (1–10)}"""
    p = guard(svc.create_plan, g.org, g.membership, body())
    return svc.plan_dict(p), 201


@bp.get("/pm/plans/<pid>")
@require("pm.view")
def get_plan(pid: str) -> dict[str, Any]:
    p = _plan(pid, include_deleted=True)
    now = datetime.now(UTC)
    comp = svc.compliance([p], now - timedelta(days=365), now + timedelta(days=1))
    return svc.plan_dict(p, {"compliance": comp["plans"].get(str(p.id)), "upcoming": svc.upcoming(p, count=12)})


@bp.patch("/pm/plans/<pid>")
@require("pm.manage")
def patch_plan(pid: str) -> dict[str, Any]:
    p = guard(svc.update_plan, g.org, g.membership, _plan(pid), body(), _version())
    return svc.plan_dict(p, {"upcoming": svc.upcoming(p, count=12)})


@bp.post("/pm/plans/<pid>/pause")
@require("pm.manage")
def pause_plan(pid: str) -> dict[str, Any]:
    return svc.plan_dict(guard(svc.set_active, g.org, g.membership, _plan(pid), False))


@bp.post("/pm/plans/<pid>/resume")
@require("pm.manage")
def resume_plan(pid: str) -> dict[str, Any]:
    return svc.plan_dict(guard(svc.set_active, g.org, g.membership, _plan(pid), True))


@bp.delete("/pm/plans/<pid>")
@require("pm.delete")
def delete_plan(pid: str) -> tuple[str, int]:
    guard(svc.delete_plan, g.org, g.membership, _plan(pid))
    return "", 204


@bp.get("/pm/plans/<pid>/preview")
@require("pm.view")
def preview(pid: str) -> dict[str, Any]:
    """Upcoming occurrences (stored and computed). Query: count (≤200), days (≤1500)."""
    try:
        count, days = int(request.args.get("count") or 12), int(request.args.get("days") or 400)
    except ValueError:
        abort(422, message="count and days must be numbers.")
    return {"items": svc.upcoming(_plan(pid), count=count, days=days)}


@bp.post("/pm/plans/<pid>/occurrences/<path:key>")
@require("pm.manage")
def adjust(pid: str, key: str) -> dict[str, Any]:
    """Change one occurrence: {action: move|reassign|skip|postpone|unskip, due_at, assignees, reason}. Skip and
    postpone need a reason and the pm.skip permission."""
    guard(svc.adjust_occurrence, g.org, g.membership, _plan(pid), key, body())
    return {"items": svc.upcoming(_plan(pid), count=12)}


@bp.post("/pm/plans/<pid>/generate")
@require("pm.manage")
def generate_now(pid: str) -> dict[str, Any]:
    made = guard(svc.generate_plan, g.org, _plan(pid))
    db.session.commit()
    return {"created": len(made)}


@bp.get("/pm/plans/<pid>/history")
@require("pm.view")
def plan_history(pid: str) -> dict[str, Any]:
    """Past occurrences with their outcome (newest first)."""
    from mpro.pm.models import PMOccurrence
    from mpro.workorders.models import WorkOrder

    p = _plan(pid, include_deleted=True)
    occs = db.session.scalars(
        select(PMOccurrence)
        .where(PMOccurrence.plan_id == p.id, PMOccurrence.status.in_(("generated", "completed", "skipped", "canceled")))
        .order_by(PMOccurrence.due_at.desc())
        .limit(200)
    ).all()
    wos = {
        w.id: w
        for w in db.session.scalars(
            select(WorkOrder).where(WorkOrder.id.in_([o.work_order_id for o in occs if o.work_order_id]))
        ).all()
    }
    names = {str(t.id): t.name or p.name for t in svc.tasks_of(p)}
    return {
        "items": [
            svc.occurrence_dict(
                p, o, o.key, o.due_at, o.task_ids, names, wos.get(o.work_order_id) if o.work_order_id else None
            )
            for o in occs
        ]
    }


# ---- calendar and compliance ----------------------------------------------------------------------
@bp.get("/pm/calendar")
@require("pm.view")
def calendar() -> dict[str, Any]:
    """PM forecast between from and to (≤ 100 days): generated, planned and computed occurrences of active plans."""
    start, end = _range(default_days=35, max_days=100)
    now = datetime.now(UTC)
    plans = list(db.session.scalars(scoped(MaintenancePlan).where(MaintenancePlan.active.is_(True))).all())
    out = []
    for p in plans:
        days = max(1, (end - now).days + 2)
        for it in svc.upcoming(p, count=200, days=days):
            if it["due_at"] and start.isoformat() <= it["due_at"].replace("Z", "+00:00") < end.isoformat():
                out.append({**it, "plan": {"id": str(p.id), "name": p.name, "kind": p.kind}})
    from mpro.pm.models import PMOccurrence

    past = db.session.execute(
        select(PMOccurrence, MaintenancePlan)
        .join(MaintenancePlan, MaintenancePlan.id == PMOccurrence.plan_id)
        .where(
            MaintenancePlan.org_id == g.org.id,
            PMOccurrence.status.in_(("completed", "skipped", "canceled")),
            PMOccurrence.due_at >= start,
            PMOccurrence.due_at < end,
        )
    ).all()
    for o, p in past:
        out.append(
            {
                **svc.occurrence_dict(p, o, o.key, o.due_at, o.task_ids, {}),
                "plan": {"id": str(p.id), "name": p.name, "kind": p.kind},
            }
        )
    seen: set[tuple[str, str]] = set()
    items = []
    for it in sorted(out, key=lambda x: x["due_at"]):
        k = (it["plan"]["id"], it["key"])
        if k not in seen:
            seen.add(k)
            items.append(it)
    return {"from": iso(start), "to": iso(end), "items": items}


@bp.get("/pm/compliance")
@require("pm.view")
def compliance_report() -> dict[str, Any]:
    """PM compliance between from and to (default last 90 days): on time, late, missed, skipped, per plan."""
    start, end = _range()
    plans = list(db.session.scalars(scoped(MaintenancePlan, include_deleted=True)).all())
    c = svc.compliance(plans, start, end)
    names = {str(p.id): {"name": p.name, "kind": p.kind, "deleted": p.deleted_at is not None} for p in plans}
    c["plans"] = [
        {"id": k, **names[k], **v}
        for k, v in c["plans"].items()
        if sum(v[x] for x in ("on_time", "late", "missed", "skipped", "open"))
    ]
    return {"from": iso(start), "to": iso(end), **c}


# ---- holidays -------------------------------------------------------------------------------------
@bp.get("/pm/holidays")
@require("pm.view")
def list_holidays() -> dict[str, Any]:
    rows = db.session.scalars(scoped(Holiday).order_by(Holiday.day)).all()
    return {"items": [{"id": str(h.id), "day": h.day.isoformat(), "name": h.name} for h in rows]}


@bp.post("/pm/holidays")
@require("pm.manage")
def add_holiday() -> tuple[dict[str, Any], int]:
    b = body()
    h = guard(svc.add_holiday, g.org, b.get("day"), str(b.get("name") or ""))
    return {"id": str(h.id), "day": h.day.isoformat(), "name": h.name}, 201


@bp.delete("/pm/holidays/<hid>")
@require("pm.manage")
def delete_holiday(hid: str) -> tuple[str, int]:
    from mpro.core.tenancy import get_scoped

    h = get_scoped(Holiday, hid)
    db.session.delete(h)
    db.session.commit()
    return "", 204


# ---- repeating work orders and sub-work orders --------------------------------------------------------
def _wo(wo_id: str) -> Any:
    from mpro.workorders.api import _wo as fetch

    return fetch(wo_id)


@bp.get("/work-orders/<wo_id>/repeat")
@require("wo.view")
def get_repeat(wo_id: str) -> dict[str, Any]:
    return {"recurrence": svc.recurrence_summary(_wo(wo_id))}


@bp.put("/work-orders/<wo_id>/repeat")
@require("wo.edit")
def put_repeat(wo_id: str) -> dict[str, Any]:
    """Make a work order repeat: {freq: daily|weekly|monthly|yearly|every_n_days, interval, weekdays: [0-6],
    monthly: by_date|by_weekday, based_on: due|completion, days_ahead (create the next one this many days early)}.
    Without a due date the work order gets tomorrow's."""
    wo = _wo(wo_id)
    guard(svc.set_repeat, g.org, g.membership, wo, body())
    return {"recurrence": svc.recurrence_summary(wo)}


@bp.delete("/work-orders/<wo_id>/repeat")
@require("wo.edit")
def delete_repeat(wo_id: str) -> tuple[str, int]:
    guard(svc.stop_repeat, g.org, g.membership, _wo(wo_id))
    return "", 204


@bp.post("/work-orders/<wo_id>/repeat/skip-next")
@require("wo.edit")
def skip_next(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    guard(svc.skip_next, g.org, g.membership, wo, str(body().get("reason") or ""))
    return {"recurrence": svc.recurrence_summary(wo)}


@bp.get("/work-orders/<wo_id>/rollup")
@require("wo.view")
def rollup(wo_id: str) -> dict[str, Any]:
    """Time and costs of a work order and its sub-work orders, with a row per sub."""
    return svc.rollup(g.membership, _wo(wo_id))


@bp.post("/work-orders/<wo_id>/close-subs")
@require("wo.edit")
def close_subs(wo_id: str) -> dict[str, Any]:
    """Close the open sub-work orders: {status: done|canceled}."""
    return guard(svc.close_subs, g.org, g.membership, _wo(wo_id), str(body().get("status") or "done"))


@provider("pm", "Maintenance plans", "pm.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        scoped(MaintenancePlan)
        .where(or_(func.lower(MaintenancePlan.name).like(like(q), escape="\\")))
        .order_by(func.lower(MaintenancePlan.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(p.id),
            "title": p.name,
            "subtitle": "Repeating work order" if p.kind == "repeat" else "Maintenance plan",
            "url": f"/preventive-maintenance/{p.id}",
        }
        for p in rows
    ]


def _register() -> None:
    from mpro.meters.services import READING_HOOKS

    if svc.on_status_change not in wo_svc.STATUS_HOOKS:
        wo_svc.STATUS_HOOKS.append(svc.on_status_change)
    if svc.inherit_from_parent not in wo_svc.CREATE_HOOKS:
        wo_svc.CREATE_HOOKS.append(svc.inherit_from_parent)
    if svc.on_meter_reading not in READING_HOOKS:
        READING_HOOKS.append(svc.on_meter_reading)

    @job("pm.generate")
    def _generate(_: dict[str, Any]) -> None:
        svc.generate_all()

    periodic("pm.generate", timedelta(minutes=15))


_register()
