"""Meters REST API (/api/v1)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, or_, select

from mpro.core.files import FileError, register_entity
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.meters import services as svc
from mpro.meters.models import UNITS, Meter, MeterTrigger, MonitoringPoint
from mpro.orgs.services import RuleError

bp = APIBlueprint("meters", __name__, url_prefix="/api/v1", tag="Meters")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _meter(mid: str) -> Meter:
    return get_scoped(Meter, mid)


def _range() -> tuple[datetime, datetime]:
    from mpro.workorders.services import _dt

    now = datetime.now(UTC)
    try:
        start = (
            guard(_dt, request.args.get("from"), "from")
            if request.args.get("from")
            else now - timedelta(days=max(1, min(int(request.args.get("days") or 30), 3660)))
        )
        end = guard(_dt, request.args.get("to"), "to") if request.args.get("to") else now + timedelta(minutes=1)
    except (ValueError, OverflowError):
        abort(422, message="days must be a number.")
    if end <= start or (end - start).days > 3660:
        abort(422, message="Pick a range up to 10 years.")
    return start, end


def _detail(mt: Meter) -> dict[str, Any]:
    from mpro.assets.models import Asset, Location

    a = db.session.get(Asset, mt.asset_id) if mt.asset_id else None
    loc = db.session.get(Location, mt.location_id) if mt.location_id else None
    mp = db.session.get(MonitoringPoint, mt.monitoring_point_id) if mt.monitoring_point_id else None
    triggers = db.session.scalars(
        select(MeterTrigger)
        .where(MeterTrigger.meter_id == mt.id, MeterTrigger.deleted_at.is_(None))
        .order_by(MeterTrigger.created_at)
    ).all()
    return svc.meter_dict(
        mt,
        {
            "asset": {"id": str(a.id), "name": a.name, "status": a.status} if a and a.deleted_at is None else None,
            "location": {"id": str(loc.id), "name": loc.name} if loc and loc.deleted_at is None else None,
            "monitoring_point": {"id": str(mp.id), "name": mp.name} if mp and mp.deleted_at is None else None,
            "triggers": [svc.trigger_dict(t) for t in triggers],
        },
    )


@bp.get("/meters")
@require("meters.view")
def list_meters() -> dict[str, Any]:
    """Query: q, asset_id, location_id, monitoring_point_id, overdue (1), level (warning|alarm), page, per_page."""
    from mpro.assets.models import Asset, Location

    q = scoped(Meter)
    a = request.args
    if a.get("q"):
        q = q.where(
            or_(
                func.lower(Meter.name).like(like(a["q"]), escape="\\"),
                func.lower(Meter.unit).like(like(a["q"]), escape="\\"),
            )
        )
    for key, col in (
        ("asset_id", Meter.asset_id),
        ("location_id", Meter.location_id),
        ("monitoring_point_id", Meter.monitoring_point_id),
    ):
        if a.get(key):
            try:
                q = q.where(col == uuid.UUID(a[key]))
            except ValueError:
                abort(422, message=f"Unknown {key}.")
    rows = list(db.session.scalars(q.order_by(func.lower(Meter.name), Meter.id)).all())
    if a.get("overdue") == "1":
        rows = [m for m in rows if svc.is_overdue(m)]
    if a.get("level") in ("warning", "alarm"):
        rows = [m for m in rows if m.last_value is not None and svc.level_for(m, m.last_value) == a["level"]]
    total = len(rows)
    try:
        per_page, page = max(1, min(int(a.get("per_page") or 50), 500)), max(1, int(a.get("page") or 1))
    except ValueError:
        abort(422, message="page and per_page must be numbers.")
    rows = rows[(page - 1) * per_page : page * per_page]
    assets = dict(
        db.session.execute(
            select(Asset.id, Asset.name).where(Asset.id.in_([m.asset_id for m in rows if m.asset_id]))
        ).all()
    )
    locs = dict(
        db.session.execute(
            select(Location.id, Location.name).where(Location.id.in_([m.location_id for m in rows if m.location_id]))
        ).all()
    )
    return {
        "items": [
            svc.meter_dict(
                m,
                {
                    "asset": {"id": str(m.asset_id), "name": assets[m.asset_id]} if m.asset_id in assets else None,
                    "location": {"id": str(m.location_id), "name": locs[m.location_id]}
                    if m.location_id in locs
                    else None,
                },
            )
            for m in rows
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


@bp.get("/meters/options")
@require("meters.view")
def meter_options() -> dict[str, Any]:
    points = db.session.scalars(scoped(MonitoringPoint).order_by(func.lower(MonitoringPoint.name))).all()
    return {
        "units": UNITS,
        "frequencies": [
            {"id": k, "label": v}
            for k, v in (
                ("none", "None"),
                ("hour", "Hours"),
                ("day", "Days"),
                ("week", "Weeks"),
                ("month", "Months"),
                ("year", "Years"),
            )
        ],
        "monitoring_points": [
            {"id": str(p.id), "name": p.name, "asset_id": str(p.asset_id) if p.asset_id else None} for p in points
        ],
        "can": {k: can(g.membership, f"meters.{k}") for k in ("read", "manage", "delete")},
    }


@bp.post("/meters")
@require("meters.manage")
def create_meter() -> tuple[dict[str, Any], int]:
    """{name, unit, description, meter_type, asset_id, location_id, monitoring_point_id,
    reading_frequency (none|hour|day|
    week|month|year), frequency_interval, warning_low, warning_high, alarm_low, alarm_high}"""
    return _detail(guard(svc.create_meter, g.org, g.membership, body())), 201


@bp.get("/meters/<mid>")
@require("meters.view")
def get_meter(mid: str) -> dict[str, Any]:
    return _detail(_meter(mid))


@bp.patch("/meters/<mid>")
@require("meters.manage")
def patch_meter(mid: str) -> dict[str, Any]:
    return _detail(guard(svc.update_meter, g.org, g.membership, _meter(mid), body()))


@bp.delete("/meters/<mid>")
@require("meters.delete")
def delete_meter(mid: str) -> tuple[str, int]:
    svc.delete_meter(g.org, g.membership, _meter(mid))
    return "", 204


@bp.post("/meters/<mid>/copy")
@require("meters.manage")
def copy_meter(mid: str) -> tuple[dict[str, Any], int]:
    """{asset_ids?: [...]} — no ids makes one copy; ids put a copy on each asset."""
    new = guard(svc.copy_meter, g.org, g.membership, _meter(mid), body().get("asset_ids"))
    return {"items": [svc.meter_dict(m) for m in new]}, 201


@bp.post("/meters/bulk")
@require("meters.manage")
def bulk_meters() -> dict[str, Any]:
    """{ids, action: edit|delete, patch: {reading_frequency, frequency_interval, unit, location_id,
    monitoring_point_id, limits}}"""
    b = body()
    ids = b.get("ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500:
        abort(422, message="Pick 1 to 500 meters.")
    action = b.get("action")
    if action == "delete" and not can(g.membership, "meters.delete"):
        abort(403, message="You don't have permission to do that.")
    if action not in ("edit", "delete"):
        abort(422, message="Action is edit or delete.")
    patch = b.get("patch") or {}
    allowed = {
        "reading_frequency",
        "frequency_interval",
        "unit",
        "location_id",
        "monitoring_point_id",
        "warning_low",
        "warning_high",
        "alarm_low",
        "alarm_high",
    }
    if action == "edit" and (not isinstance(patch, dict) or not patch or set(patch) - allowed):
        abort(422, message="Bulk edit can change " + ", ".join(sorted(allowed)) + ".")
    meters = [_meter(str(i)) for i in ids]
    done, failed = [], []
    for mt in meters:
        try:
            if action == "edit":
                svc.update_meter(g.org, g.membership, mt, patch)
            else:
                svc.delete_meter(g.org, g.membership, mt)
            done.append(str(mt.id))
        except RuleError as e:
            db.session.rollback()
            failed.append({"id": str(mt.id), "name": mt.name, "message": e.message})
    return {"done": done, "failed": failed}


@bp.get("/meters/<mid>/readings")
@require("meters.view")
def list_readings(mid: str) -> dict[str, Any]:
    """Query: from, to (ISO) or days (default 30); limit (≤1000)."""
    from mpro.auth.models import User

    mt = _meter(mid)
    start, end = _range()
    try:
        limit = max(1, min(int(request.args.get("limit") or 200), 1000))
    except ValueError:
        abort(422, message="limit must be a number.")
    rows = svc.readings(mt, start, end, limit)
    names = dict(
        db.session.execute(
            select(User.id, User.name).where(User.id.in_({r.recorded_by_id for r in rows if r.recorded_by_id}))
        ).all()
    )
    return {"items": [svc.reading_dict(r, names) for r in rows]}


@bp.get("/meters/<mid>/chart")
@require("meters.view")
def meter_chart(mid: str) -> dict[str, Any]:
    start, end = _range()
    return svc.chart(_meter(mid), start, end)


@bp.post("/meters/<mid>/readings")
@require("meters.read")
def add_reading(mid: str) -> tuple[dict[str, Any], int]:
    """{value, recorded_at?, note?, file_id? (a photo uploaded with POST /files), work_order_id?}"""
    mt = _meter(mid)
    r = guard(svc.add_reading, g.org, g.membership, mt, body())
    return {"reading": svc.reading_dict(r), "meter": _detail(mt)}, 201


@bp.post("/meter-readings")
@require("meters.read")
def add_readings_batch() -> dict[str, Any]:
    """Readings API for sensors and integrations: {readings: [{meter_id, value, recorded_at?, note?}]} (≤1000)."""
    items = body().get("readings")
    if not isinstance(items, list) or not 1 <= len(items) <= 1000:
        abort(422, message="Send 1 to 1,000 readings.")
    ok, failed = 0, []
    for n, it in enumerate(items):
        if not isinstance(it, dict):
            failed.append({"index": n, "message": "Each reading is an object."})
            continue
        try:
            mt = svc.get_meter(g.org.id, it.get("meter_id"))
            svc.add_reading(
                g.org, g.membership, mt, {k: it.get(k) for k in ("value", "recorded_at", "note")}, source="api"
            )
            ok += 1
        except RuleError as e:
            db.session.rollback()
            failed.append({"index": n, "message": e.message})
    return {"recorded": ok, "failed": failed}


@bp.delete("/meters/<mid>/readings/<rid>")
@require("meters.manage")
def delete_reading(mid: str, rid: str) -> tuple[str, int]:
    guard(svc.delete_reading, g.org, g.membership, _meter(mid), rid)
    return "", 204


@bp.post("/meters/<mid>/triggers")
@require("meters.manage")
def add_trigger(mid: str) -> tuple[dict[str, Any], int]:
    """{name, kind: threshold|every, comparator: gt|lt, threshold, every_units, start_at, active,
    work_order: {title, description, priority, assignees, categories, estimated_minutes, due_in_days}}"""
    t = guard(svc.save_trigger, g.org, g.membership, _meter(mid), body())
    return svc.trigger_dict(t), 201


def _trigger(mt: Meter, tid: str) -> MeterTrigger:
    t = get_scoped(MeterTrigger, tid)
    if t.meter_id != mt.id:
        abort(404)
    return t


@bp.patch("/meters/<mid>/triggers/<tid>")
@require("meters.manage")
def patch_trigger(mid: str, tid: str) -> dict[str, Any]:
    mt = _meter(mid)
    return svc.trigger_dict(guard(svc.save_trigger, g.org, g.membership, mt, body(), _trigger(mt, tid)))


@bp.delete("/meters/<mid>/triggers/<tid>")
@require("meters.manage")
def delete_trigger(mid: str, tid: str) -> tuple[str, int]:
    from mpro.core.models import utcnow

    mt = _meter(mid)
    t = _trigger(mt, tid)
    t.deleted_at, t.active = utcnow(), False
    from mpro.core.events import emit

    emit(
        "meter.trigger_deleted",
        entity_type="meter",
        entity_id=mt.id,
        entity_label=mt.name,
        summary=f"Deleted trigger {t.name}",
    )
    db.session.commit()
    return "", 204


@bp.get("/monitoring-points")
@require("meters.view")
def list_points() -> dict[str, Any]:
    ps = db.session.scalars(scoped(MonitoringPoint).order_by(func.lower(MonitoringPoint.name))).all()
    return {
        "items": [
            {
                "id": str(p.id),
                "name": p.name,
                "description": p.description,
                "asset_id": str(p.asset_id) if p.asset_id else None,
            }
            for p in ps
        ]
    }


@bp.post("/monitoring-points")
@require("meters.manage")
def create_point() -> tuple[dict[str, Any], int]:
    p = guard(svc.save_point, g.org, body())
    return {"id": str(p.id), "name": p.name}, 201


@bp.patch("/monitoring-points/<pid>")
@require("meters.manage")
def patch_point(pid: str) -> dict[str, Any]:
    p = guard(svc.save_point, g.org, body(), get_scoped(MonitoringPoint, pid))
    return {"id": str(p.id), "name": p.name}


@bp.delete("/monitoring-points/<pid>")
@require("meters.delete")
def delete_point(pid: str) -> tuple[str, int]:
    from mpro.core.models import utcnow

    p = get_scoped(MonitoringPoint, pid)
    p.deleted_at = utcnow()
    from mpro.core.events import emit

    emit(
        "monitoring_point.deleted",
        entity_type="monitoring_point",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Deleted monitoring point {p.name}",
    )
    for mt in db.session.scalars(scoped(Meter).where(Meter.monitoring_point_id == p.id)).all():
        mt.monitoring_point_id = None
    db.session.commit()
    return "", 204


@provider("meters", "Meters", "meters.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        scoped(Meter)
        .where(func.lower(Meter.name).like(like(q), escape="\\"))
        .order_by(func.lower(Meter.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(m.id),
            "title": m.name,
            "subtitle": f"{svc._num(m.last_value)} {m.unit}" if m.last_value is not None else m.unit,
            "url": f"/meters/{m.id}",
        }
        for m in rows
    ]


def _visible(mid: uuid.UUID, perm: str) -> bool:
    m = db.session.get(Meter, mid)
    return m is not None and m.org_id == g.org.id and m.deleted_at is None and can(g.membership, perm)


register_entity("meter", lambda i: _visible(i, "meters.view"), lambda i: _visible(i, "meters.read"))


def _register() -> None:
    from mpro.core.jobs import job, periodic
    from mpro.qr.services import register_target

    register_target("meter", Meter, lambda m: m.name, lambda m: f"/meters/{m.id}", "meters.view")

    @job("meters.partitions")
    def _partitions(_: dict[str, Any]) -> None:
        svc.ensure_partitions()

    periodic("meters.partitions", timedelta(days=1))


_register()
