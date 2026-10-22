"""Automations REST API (/api/v1). Built in 0.4.0 (MP-117)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, select

from mpro.automations import services as svc
from mpro.automations.models import Automation, AutomationRun
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError

bp = APIBlueprint("automations", __name__, url_prefix="/api/v1", tag="Automations")


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


@bp.get("/automations")
@require("automations.view")
def list_automations() -> dict[str, Any]:
    """Query: q, asset_id, meter_id (automations watching it), type (meter_reading|asset_status|work_order_status),
    active (1|0), page, per_page."""
    a = request.args
    rows = list(db.session.scalars(scoped(Automation).order_by(func.lower(Automation.name), Automation.id)).all())
    if a.get("q"):
        q = a["q"].lower()
        rows = [x for x in rows if q in x.name.lower() or q in (x.description or "").lower()]
    for key in ("asset_id", "meter_id"):
        if a.get(key):
            try:
                tid = str(uuid.UUID(a[key]))
            except ValueError:
                abort(422, message=f"Unknown {key}.")
            if key == "asset_id":
                from mpro.meters.models import Meter

                meter_ids = {
                    str(i)
                    for i in db.session.scalars(
                        select(Meter.id).where(Meter.org_id == g.org.id, Meter.asset_id == uuid.UUID(tid))
                    ).all()
                }
                rows = [x for x in rows if tid in (x.targets or []) or meter_ids & set(x.targets or [])]
            else:
                rows = [x for x in rows if tid in (x.targets or [])]
    if a.get("type"):
        rows = [x for x in rows if (x.trigger or {}).get("type") == a["type"]]
    if a.get("active") in ("0", "1"):
        rows = [x for x in rows if x.active == (a["active"] == "1")]
    try:
        per_page, page = max(1, min(int(a.get("per_page") or 100), 500)), max(1, int(a.get("page") or 1))
    except ValueError:
        abort(422, message="page and per_page must be numbers.")
    total = len(rows)
    rows = rows[(page - 1) * per_page : page * per_page]
    return {"items": [svc.automation_dict(x) for x in rows], "total": total, "page": page, "per_page": per_page}


@bp.post("/automations")
@require("automations.manage")
def create_automation() -> tuple[dict[str, Any], int]:
    """{name, description, active, trigger, targets, conditions, actions, sensitivity, rerun_minutes}"""
    a = guard(svc.save_automation, g.org, g.membership, body())
    return svc.automation_dict(a, detail=True), 201


@bp.post("/automations/describe")
@require("automations.view")
def describe_automation() -> dict[str, Any]:
    """Plain-language summary of an automation document (for the builder's live preview)."""
    b = body()
    try:
        return {"summary": svc.describe(g.org.id, b)}
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return {"summary": ""}


@bp.post("/automations/bulk")
@require("automations.manage")
def bulk_automations() -> dict[str, Any]:
    """{ids, action: enable|disable|delete}"""
    b = body()
    return {"done": guard(svc.bulk, g.org, b.get("ids"), str(b.get("action") or ""))}


@bp.get("/automations/<aid>")
@require("automations.view")
def get_automation(aid: str) -> dict[str, Any]:
    return svc.automation_dict(get_scoped(Automation, aid), detail=True)


@bp.patch("/automations/<aid>")
@require("automations.manage")
def patch_automation(aid: str) -> dict[str, Any]:
    a = guard(svc.save_automation, g.org, g.membership, body(), get_scoped(Automation, aid))
    return svc.automation_dict(a, detail=True)


@bp.delete("/automations/<aid>")
@require("automations.manage")
def delete_automation(aid: str) -> tuple[str, int]:
    svc.delete_automation(g.org, get_scoped(Automation, aid))
    return "", 204


@bp.post("/automations/<aid>/copy")
@require("automations.manage")
def copy_automation(aid: str) -> tuple[dict[str, Any], int]:
    return svc.automation_dict(svc.copy_automation(g.org, g.membership, get_scoped(Automation, aid)), detail=True), 201


@bp.get("/automations/<aid>/runs")
@require("automations.view")
def automation_runs(aid: str) -> dict[str, Any]:
    """Action history, newest first. Query: status (ok|failed|skipped), page, per_page."""
    from mpro.workorders.models import WorkOrder

    a = get_scoped(Automation, aid)
    q = select(AutomationRun).where(AutomationRun.automation_id == a.id)
    if request.args.get("status") in ("ok", "failed", "skipped"):
        q = q.where(AutomationRun.status == request.args["status"])
    try:
        per_page = max(1, min(int(request.args.get("per_page") or 50), 200))
        page = max(1, int(request.args.get("page") or 1))
    except ValueError:
        abort(422, message="page and per_page must be numbers.")
    total = db.session.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.session.scalars(q.order_by(AutomationRun.at.desc()).limit(per_page).offset((page - 1) * per_page)).all()
    wo_ids = {uuid.UUID(x["work_order_id"]) for r in rows for x in (r.results or []) if x.get("work_order_id")}
    nums = (
        dict(db.session.execute(select(WorkOrder.id, WorkOrder.number).where(WorkOrder.id.in_(wo_ids))).all())
        if wo_ids
        else {}
    )
    return {"items": [svc.run_dict(r, nums) for r in rows], "total": total, "page": page, "per_page": per_page}


@provider("automations", "Automations", "automations.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        scoped(Automation)
        .where(func.lower(Automation.name).like(like(q), escape="\\"))
        .order_by(func.lower(Automation.name))
        .limit(limit)
    ).all()
    return [
        {"id": str(a.id), "title": a.name, "subtitle": "On" if a.active else "Off", "url": f"/automations/{a.id}"}
        for a in rows
    ]


def _register() -> None:
    from mpro.assets.services import ASSET_STATUS_HOOKS
    from mpro.core.jobs import job, periodic
    from mpro.meters.services import READING_HOOKS
    from mpro.workorders.services import STATUS_HOOKS

    if svc.on_meter_reading not in READING_HOOKS:
        READING_HOOKS.append(svc.on_meter_reading)
    if svc.on_work_order_status not in STATUS_HOOKS:
        STATUS_HOOKS.append(svc.on_work_order_status)
    if svc.on_asset_status not in ASSET_STATUS_HOOKS:
        ASSET_STATUS_HOOKS.append(svc.on_asset_status)

    @job("automations.check")
    def _check(_: dict[str, Any]) -> None:
        svc.check_durations()

    @job("assets.warranty_reminders")
    def _warranty(_: dict[str, Any]) -> None:
        svc.warranty_reminders()

    periodic("automations.check", timedelta(minutes=5))
    periodic("assets.warranty_reminders", timedelta(days=1))


_register()
