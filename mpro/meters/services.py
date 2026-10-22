"""Meters, readings and meter triggers (MP-030, MP-031)."""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import delete, func, select

from mpro.assets.services import get_asset, get_location
from mpro.core.events import emit
from mpro.core.files import FileObject, attach
from mpro.core.ids import uuid7
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.meters.models import FREQUENCIES, METER_TYPES, Meter, MeterReading, MeterTrigger, MonitoringPoint
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError

log = logging.getLogger(__name__)
PERIOD = {
    "hour": timedelta(hours=1),
    "day": timedelta(days=1),
    "week": timedelta(weeks=1),
    "month": timedelta(days=30),
    "year": timedelta(days=365),
}
MAX_ABS = Decimal("99999999999999")  # Numeric(18, 4)
WO_KEYS = ("title", "description", "priority", "assignees", "categories", "estimated_minutes", "due_in_days")


def _dec(v: Any, field: str, allow_none: bool = True) -> Decimal | None:
    if v in (None, ""):
        if allow_none:
            return None
        raise RuleError(f"{field} is required.", 422)
    if isinstance(v, bool):
        raise RuleError(f"{field} must be a number.", 422)
    try:
        d = Decimal(str(v))
    except InvalidOperation as e:
        raise RuleError(f"{field} must be a number.", 422) from e
    if not d.is_finite() or abs(d) > MAX_ABS:
        raise RuleError(f"{field} is out of range.", 422)
    return d.quantize(Decimal("0.0001"))


def _num(d: Decimal | None) -> float | int | None:
    if d is None:
        return None
    return int(d) if d == d.to_integral_value() else float(d)


def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def get_meter(org_id: uuid.UUID, mid: Any) -> Meter:
    mt = db.session.get(Meter, _uuid(mid, "meter"))
    if mt is None or mt.org_id != org_id or mt.deleted_at is not None:
        raise RuleError("That meter doesn't exist.", 404)
    return mt


# ---- meters ----------------------------------------------------------------------------------
METER_FIELDS = (
    "name",
    "description",
    "meter_type",
    "unit",
    "asset_id",
    "location_id",
    "monitoring_point_id",
    "reading_frequency",
    "frequency_interval",
    "warning_low",
    "warning_high",
    "alarm_low",
    "alarm_high",
)


def _apply(org_id: uuid.UUID, mt: Meter, data: dict[str, Any]) -> None:
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise RuleError("The meter needs a name.", 422)
        if len(name) > 255:
            raise RuleError("Names can be up to 255 characters.", 422)
        mt.name = name
    if "description" in data:
        mt.description = str(data["description"] or "")[:4096]
    if "meter_type" in data:
        if data["meter_type"] not in METER_TYPES:
            raise RuleError("Meters are manual or automated.", 422)
        mt.meter_type = data["meter_type"]
    if "unit" in data:
        unit = str(data["unit"] or "").strip()
        if not unit or len(unit) > 40:
            raise RuleError("Pick a unit of measurement.", 422)
        mt.unit = unit
    if "asset_id" in data:
        mt.asset_id = get_asset(org_id, data["asset_id"]).id if data["asset_id"] else None
        if mt.asset_id and "location_id" not in data:
            from mpro.assets.models import Asset

            mt.location_id = db.session.get(Asset, mt.asset_id).location_id  # type: ignore[union-attr]
    if "location_id" in data:
        mt.location_id = get_location(org_id, data["location_id"]).id if data["location_id"] else None
    if "monitoring_point_id" in data:
        if data["monitoring_point_id"]:
            mp = db.session.get(MonitoringPoint, _uuid(data["monitoring_point_id"], "monitoring point"))
            if mp is None or mp.org_id != org_id or mp.deleted_at is not None:
                raise RuleError("That monitoring point doesn't exist.", 422)
            mt.monitoring_point_id = mp.id
        else:
            mt.monitoring_point_id = None
    if "reading_frequency" in data:
        if data["reading_frequency"] not in FREQUENCIES:
            raise RuleError("Reading frequency is none, hourly, daily, weekly, monthly or yearly.", 422)
        mt.reading_frequency = data["reading_frequency"]
    if "frequency_interval" in data:
        try:
            n = int(data["frequency_interval"] or 1)
        except (TypeError, ValueError) as e:
            raise RuleError("The interval must be a whole number.", 422) from e
        if not 1 <= n <= 1000:
            raise RuleError("The interval must be between 1 and 1,000.", 422)
        mt.frequency_interval = n
    for k in ("warning_low", "warning_high", "alarm_low", "alarm_high"):
        if k in data:
            setattr(mt, k, _dec(data[k], k.replace("_", " ").capitalize()))
    lo = [x for x in (mt.alarm_low, mt.warning_low) if x is not None]
    hi = [x for x in (mt.warning_high, mt.alarm_high) if x is not None]
    if (mt.alarm_low is not None and mt.warning_low is not None and mt.alarm_low > mt.warning_low) or (
        mt.warning_high is not None and mt.alarm_high is not None and mt.warning_high > mt.alarm_high
    ):
        raise RuleError("Alarm limits must be outside the warning limits.", 422)
    if lo and hi and max(lo) >= min(hi):
        raise RuleError("Low limits must be below the high limits.", 422)


def create_meter(org: Organization, m: Membership, data: dict[str, Any]) -> Meter:
    mt = Meter(
        id=uuid7(),
        org_id=org.id,
        name="",
        description="",
        meter_type="manual",
        unit="hours",
        reading_frequency="none",
        frequency_interval=1,
        created_by_id=m.user_id,
    )
    _apply(
        org.id,
        mt,
        {
            "name": data.get("name", ""),
            "unit": data.get("unit", "hours"),
            **{k: data[k] for k in METER_FIELDS if k in data and k not in ("name", "unit")},
        },
    )
    db.session.add(mt)
    db.session.flush()
    emit(
        "meter.created", entity_type="meter", entity_id=mt.id, entity_label=mt.name, summary=f"Created meter {mt.name}"
    )
    db.session.commit()
    return mt


def update_meter(org: Organization, m: Membership, mt: Meter, data: dict[str, Any]) -> Meter:
    before = {k: getattr(mt, k) for k in METER_FIELDS}
    _apply(org.id, mt, {k: data[k] for k in METER_FIELDS if k in data})
    changes = {k: (before[k], getattr(mt, k)) for k in METER_FIELDS if before[k] != getattr(mt, k)}
    if changes:
        emit(
            "meter.updated",
            entity_type="meter",
            entity_id=mt.id,
            entity_label=mt.name,
            summary="Changed " + ", ".join(k.replace("_id", "").replace("_", " ") for k in changes),
            changes=changes,
        )
    db.session.commit()
    return mt


def delete_meter(org: Organization, m: Membership, mt: Meter, commit: bool = True) -> None:
    mt.deleted_at = utcnow()
    for t in db.session.scalars(
        select(MeterTrigger).where(MeterTrigger.meter_id == mt.id, MeterTrigger.deleted_at.is_(None))
    ).all():
        t.active = False
    emit(
        "meter.deleted", entity_type="meter", entity_id=mt.id, entity_label=mt.name, summary=f"Deleted meter {mt.name}"
    )
    if commit:
        db.session.commit()


def copy_meter(org: Organization, m: Membership, mt: Meter, asset_ids: list[Any] | None = None) -> list[Meter]:
    """Copy a meter (with its triggers) — optionally once onto each of several assets."""
    targets: list[Any] = list(asset_ids or [None])
    if len(targets) > 200:
        raise RuleError("Copy to up to 200 assets at a time.", 422)
    out = []
    for aid in targets:
        new = Meter(id=uuid7(), org_id=org.id, created_by_id=m.user_id, **{k: getattr(mt, k) for k in METER_FIELDS})
        new.name = (mt.name if aid else f"Copy - {mt.name}")[:255]
        if aid:
            a = get_asset(org.id, aid)
            new.asset_id, new.location_id = a.id, a.location_id
        db.session.add(new)
        db.session.flush()
        for t in db.session.scalars(
            select(MeterTrigger).where(MeterTrigger.meter_id == mt.id, MeterTrigger.deleted_at.is_(None))
        ).all():
            db.session.add(
                MeterTrigger(
                    org_id=org.id,
                    meter_id=new.id,
                    name=t.name,
                    kind=t.kind,
                    comparator=t.comparator,
                    threshold=t.threshold,
                    every_units=t.every_units,
                    next_at=((new.last_value or Decimal(0)) + t.every_units)
                    if t.kind == "every" and t.every_units
                    else None,
                    work_order=dict(t.work_order or {}),
                    active=t.active,
                    fired_count=0,
                    last_note="",
                )
            )
        emit(
            "meter.created",
            entity_type="meter",
            entity_id=new.id,
            entity_label=new.name,
            summary=f"Copied meter {mt.name}",
        )
        out.append(new)
    db.session.commit()
    return out


def is_overdue(mt: Meter, now: datetime | None = None) -> bool:
    if mt.reading_frequency == "none":
        return False
    now = now or utcnow()
    due = (mt.last_reading_at or mt.created_at) + PERIOD[mt.reading_frequency] * (mt.frequency_interval or 1)
    return due < now


def next_due(mt: Meter) -> datetime | None:
    if mt.reading_frequency == "none":
        return None
    return (mt.last_reading_at or mt.created_at) + PERIOD[mt.reading_frequency] * (mt.frequency_interval or 1)


def level_for(mt: Meter, v: Decimal) -> str:
    if (mt.alarm_low is not None and v < mt.alarm_low) or (mt.alarm_high is not None and v > mt.alarm_high):
        return "alarm"
    if (mt.warning_low is not None and v < mt.warning_low) or (mt.warning_high is not None and v > mt.warning_high):
        return "warning"
    return ""


def meter_dict(mt: Meter, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    d = {
        "id": str(mt.id),
        "name": mt.name,
        "description": mt.description,
        "meter_type": mt.meter_type,
        "unit": mt.unit,
        "asset_id": str(mt.asset_id) if mt.asset_id else None,
        "location_id": str(mt.location_id) if mt.location_id else None,
        "monitoring_point_id": str(mt.monitoring_point_id) if mt.monitoring_point_id else None,
        "reading_frequency": mt.reading_frequency,
        "frequency_interval": mt.frequency_interval,
        "warning_low": _num(mt.warning_low),
        "warning_high": _num(mt.warning_high),
        "alarm_low": _num(mt.alarm_low),
        "alarm_high": _num(mt.alarm_high),
        "last_value": _num(mt.last_value),
        "last_reading_at": iso(mt.last_reading_at),
        "level": level_for(mt, mt.last_value) if mt.last_value is not None else "",
        "overdue": is_overdue(mt),
        "next_reading_due": iso(next_due(mt)),
        "created_at": iso(mt.created_at),
        "updated_at": iso(mt.updated_at),
        "deleted": mt.deleted_at is not None,
    }
    if extra:
        d.update(extra)
    return d


# ---- readings --------------------------------------------------------------------------------
def _is_anomaly(mt: Meter, v: Decimal, at: datetime) -> bool:
    """Flag readings far outside the recent pattern (> 4 standard deviations from the last 30 readings)."""
    recent = [
        float(x)
        for x in db.session.scalars(
            select(MeterReading.value)
            .where(MeterReading.meter_id == mt.id, MeterReading.recorded_at < at)
            .order_by(MeterReading.recorded_at.desc())
            .limit(30)
        ).all()
    ]
    if len(recent) < 10:
        return False
    mean = sum(recent) / len(recent)
    sd = math.sqrt(sum((x - mean) ** 2 for x in recent) / (len(recent) - 1))
    if sd == 0:
        return abs(float(v) - mean) > max(1.0, abs(mean) * 0.5)
    return abs(float(v) - mean) > 4 * sd


def reading_dict(r: MeterReading, names: dict[uuid.UUID, str] | None = None) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "value": _num(r.value),
        "recorded_at": iso(r.recorded_at),
        "source": r.source,
        "recorded_by": (names or {}).get(r.recorded_by_id) if r.recorded_by_id else None,
        "recorded_by_id": str(r.recorded_by_id) if r.recorded_by_id else None,
        "work_order_id": str(r.work_order_id) if r.work_order_id else None,
        "file_id": str(r.file_id) if r.file_id else None,
        "file_url": f"/api/v1/files/{r.file_id}/thumb" if r.file_id else None,
        "note": r.note,
        "level": r.level,
        "anomaly": r.anomaly,
    }


def add_reading(
    org: Organization,
    m: Membership | None,
    mt: Meter,
    data: dict[str, Any],
    *,
    source: str = "manual",
    commit: bool = True,
) -> MeterReading:
    v = _dec(data.get("value"), "Reading", allow_none=False)
    assert v is not None
    at = utcnow()
    if data.get("recorded_at"):
        from mpro.workorders.services import _dt

        at = _dt(data["recorded_at"], "Reading time") or at
        if at > utcnow() + timedelta(minutes=5):
            raise RuleError("A reading can't be in the future.", 422)
    file_id = None
    if data.get("file_id"):
        f = db.session.get(FileObject, _uuid(data["file_id"], "file"))
        if (
            f is None
            or f.org_id != org.id
            or f.deleted_at is not None
            or (m is not None and f.uploaded_by_id != m.user_id)
        ):
            raise RuleError("The photo couldn't be found. Upload it again.", 422)
        file_id = f.id
        attach(f, "meter", mt.id, "reading")
    wo_id = None
    if data.get("work_order_id"):
        from mpro.workorders.models import WorkOrder
        from mpro.workorders.services import can_see

        wo = db.session.get(WorkOrder, _uuid(data["work_order_id"], "work order"))
        if wo is None or wo.org_id != org.id or wo.deleted_at is not None or (m is not None and not can_see(m, wo)):
            raise RuleError("That work order doesn't exist.", 422)
        wo_id = wo.id
        source = "work_order"
    r = MeterReading(
        id=uuid7(),
        org_id=org.id,
        meter_id=mt.id,
        value=v,
        recorded_at=at,
        source=source,
        recorded_by_id=m.user_id if m else None,
        work_order_id=wo_id,
        file_id=file_id,
        note=str(data.get("note") or "").strip()[:500],
        level=level_for(mt, v),
        anomaly=_is_anomaly(mt, v, at),
        created_at=utcnow(),
    )
    db.session.add(r)
    prev = mt.last_value
    if mt.last_reading_at is None or at >= mt.last_reading_at:
        mt.last_value, mt.last_reading_at = v, at
    db.session.flush()
    emit(
        "meter.reading",
        entity_type="meter",
        entity_id=mt.id,
        entity_label=mt.name,
        summary=f"Recorded {_num(v)} {mt.unit}"
        + (f" ({r.level})" if r.level else "")
        + (" — unusual" if r.anomaly else ""),
        data={"value": str(v), "level": r.level, "anomaly": r.anomaly, "reading_id": r.id},
    )
    if mt.last_reading_at == at:
        fire_triggers(org, mt, prev, v, r)
    if commit:
        db.session.commit()
    return r


def delete_reading(org: Organization, m: Membership, mt: Meter, reading_id: Any) -> None:
    rid = _uuid(reading_id, "reading")
    r = db.session.scalars(select(MeterReading).where(MeterReading.meter_id == mt.id, MeterReading.id == rid)).first()
    if r is None:
        raise RuleError("That reading doesn't exist.", 404)
    db.session.execute(delete(MeterReading).where(MeterReading.id == r.id, MeterReading.recorded_at == r.recorded_at))
    last = db.session.scalars(
        select(MeterReading).where(MeterReading.meter_id == mt.id).order_by(MeterReading.recorded_at.desc()).limit(1)
    ).first()
    mt.last_value, mt.last_reading_at = (last.value, last.recorded_at) if last else (None, None)
    emit(
        "meter.reading_deleted",
        entity_type="meter",
        entity_id=mt.id,
        entity_label=mt.name,
        summary=f"Deleted the {_num(r.value)} {mt.unit} reading from {iso(r.recorded_at)}",
    )
    db.session.commit()


def readings(
    mt: Meter, start: datetime | None, end: datetime | None, limit: int = 500, before: datetime | None = None
) -> list[MeterReading]:
    q = select(MeterReading).where(MeterReading.meter_id == mt.id)
    if start:
        q = q.where(MeterReading.recorded_at >= start)
    if end:
        q = q.where(MeterReading.recorded_at < end)
    if before:
        q = q.where(MeterReading.recorded_at < before)
    return list(db.session.scalars(q.order_by(MeterReading.recorded_at.desc()).limit(limit)).all())


def chart(mt: Meter, start: datetime, end: datetime, points: int = 200) -> dict[str, Any]:
    """Readings for a chart; long ranges are bucketed to min/avg/max so the chart stays fast."""
    rows = db.session.execute(
        select(MeterReading.recorded_at, MeterReading.value)
        .where(MeterReading.meter_id == mt.id, MeterReading.recorded_at >= start, MeterReading.recorded_at < end)
        .order_by(MeterReading.recorded_at)
    ).all()
    limits = {k: _num(getattr(mt, k)) for k in ("warning_low", "warning_high", "alarm_low", "alarm_high")}
    if len(rows) <= points:
        return {
            "bucketed": False,
            "points": [{"at": iso(t), "value": _num(v)} for t, v in rows],
            "limits": limits,
            "unit": mt.unit,
        }
    span = (end - start).total_seconds() / points
    buckets: dict[int, list[float]] = {}
    for t, v in rows:
        buckets.setdefault(int((t - start).total_seconds() // span), []).append(float(v))
    return {
        "bucketed": True,
        "points": [
            {
                "at": iso(start + timedelta(seconds=(i + 0.5) * span)),
                "value": round(sum(vs) / len(vs), 4),
                "min": min(vs),
                "max": max(vs),
                "count": len(vs),
            }
            for i, vs in sorted(buckets.items())
        ],
        "limits": limits,
        "unit": mt.unit,
    }


# ---- triggers --------------------------------------------------------------------------------
def trigger_dict(t: MeterTrigger) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "meter_id": str(t.meter_id),
        "name": t.name,
        "kind": t.kind,
        "comparator": t.comparator,
        "threshold": _num(t.threshold),
        "every_units": _num(t.every_units),
        "next_at": _num(t.next_at),
        "work_order": t.work_order or {},
        "active": t.active,
        "fired_count": t.fired_count,
        "last_fired_at": iso(t.last_fired_at),
        "last_note": t.last_note,
    }


def save_trigger(
    org: Organization, m: Membership, mt: Meter, data: dict[str, Any], t: MeterTrigger | None = None
) -> MeterTrigger:
    from mpro.workorders.services import _apply_fields, _resolve_assignees, new_work_order

    created = t is None
    if t is None:
        t = MeterTrigger(
            org_id=org.id,
            meter_id=mt.id,
            name="",
            kind="threshold",
            comparator="gt",
            work_order={},
            active=True,
            fired_count=0,
            last_note="",
        )
    kind = data.get("kind", t.kind)
    if kind not in ("threshold", "every"):
        raise RuleError("Trigger when a reading crosses a value, or every N units.", 422)
    t.kind = kind
    if "name" in data or created:
        t.name = str(data.get("name") or "").strip()[:120] or (
            "Reading " + ("above" if data.get("comparator", "gt") == "gt" else "below")
            if kind == "threshold"
            else "Every interval"
        )
    if kind == "threshold":
        if "comparator" in data:
            if data["comparator"] not in ("gt", "lt"):
                raise RuleError("Pick above or below.", 422)
            t.comparator = data["comparator"]
        if "threshold" in data or created or t.threshold is None:
            t.threshold = _dec(data.get("threshold"), "Threshold", allow_none=False)
        t.every_units, t.next_at = None, None
    else:
        if "every_units" in data or created or t.every_units is None:
            every = _dec(data.get("every_units"), "Interval", allow_none=False)
            assert every is not None
            if every <= 0:
                raise RuleError("The interval must be more than zero.", 422)
            t.every_units = every
            base = (
                _dec(data.get("start_at"), "Start")
                if data.get("start_at") not in (None, "")
                else (mt.last_value or Decimal(0))
            )
            t.next_at = (base or Decimal(0)) + every
        t.threshold = None
    if "work_order" in data or created:
        wo = data.get("work_order") or {}
        if not isinstance(wo, dict) or set(wo) - set(WO_KEYS):
            raise RuleError("The work order can have " + ", ".join(WO_KEYS) + ".", 422)
        probe = new_work_order(org.id)
        _apply_fields(
            probe,
            {
                "title": wo.get("title") or mt.name,
                **{k: wo[k] for k in ("description", "priority", "estimated_minutes") if k in wo},
            },
        )
        _resolve_assignees(org.id, wo.get("assignees") or [])
        if wo.get("due_in_days") in ("", None):
            wo.pop("due_in_days", None)
        else:
            try:
                due = int(wo["due_in_days"])
            except (TypeError, ValueError, OverflowError) as e:
                raise RuleError("Due in days must be a whole number.", 422) from e
            if not 0 <= due <= 3650:
                raise RuleError("Due in days must be between 0 and 3,650.", 422)
            wo["due_in_days"] = due
        t.work_order = dict(wo)
    if "active" in data:
        t.active = bool(data["active"])
    db.session.add(t)
    db.session.flush()
    emit(
        "meter.trigger_saved",
        entity_type="meter",
        entity_id=mt.id,
        entity_label=mt.name,
        summary=("Added" if created else "Changed") + f" trigger {t.name}",
    )
    db.session.commit()
    return t


def _meets(t: MeterTrigger, x: Decimal) -> bool:
    assert t.threshold is not None
    return x > t.threshold if t.comparator == "gt" else x < t.threshold


def fire_triggers(org: Organization, mt: Meter, prev: Decimal | None, v: Decimal, r: MeterReading) -> list[uuid.UUID]:
    """Create work orders for triggers this reading meets. A trigger never opens a second work order while its
    previous one is still open."""
    from mpro.workorders.models import ACTIVE_STATUSES, WorkOrder

    created: list[uuid.UUID] = []
    triggers = db.session.scalars(
        select(MeterTrigger)
        .where(MeterTrigger.meter_id == mt.id, MeterTrigger.active.is_(True), MeterTrigger.deleted_at.is_(None))
        .with_for_update()  # two readings at once must not both open a work order or both advance next_at
    ).all()
    for t in triggers:
        hit = False
        if t.kind == "threshold" and t.threshold is not None:
            # fire when the value crosses the threshold, not on every reading that stays past it
            hit = _meets(t, v) and (prev is None or not _meets(t, prev))
        elif t.kind == "every" and t.every_units and t.next_at is not None and v >= t.next_at:
            hit = True
            while t.next_at <= v:  # skip milestones that a big jump passed
                t.next_at += t.every_units
        if not hit:
            continue
        open_wo = db.session.scalar(
            select(WorkOrder.id).where(
                WorkOrder.source_type == "meter_trigger",
                WorkOrder.source_id == t.id,
                WorkOrder.status.in_(ACTIVE_STATUSES),
                WorkOrder.deleted_at.is_(None),
            )
        )
        if open_wo:
            t.last_note = f"Skipped at {_num(v)} {mt.unit}: work order still open"
            continue
        wo = _create_wo(org, mt, t, v, r)
        if wo is not None:
            created.append(wo)
    return created


def _create_wo(org: Organization, mt: Meter, t: MeterTrigger, v: Decimal, r: MeterReading) -> uuid.UUID | None:
    from mpro.orgs.models import Membership as M
    from mpro.workorders.services import create_work_order

    # Work orders from triggers are created by the person who recorded the reading, or by the meter's creator.
    actor_id = r.recorded_by_id or mt.created_by_id
    m = (
        db.session.scalars(select(M).where(M.org_id == org.id, M.user_id == actor_id, M.deleted_at.is_(None))).first()
        if actor_id
        else None
    )
    if m is None:
        m = db.session.scalars(
            select(M)
            .where(M.org_id == org.id, M.role.in_(("owner", "admin")), M.deleted_at.is_(None))
            .order_by(M.created_at)
        ).first()
    if m is None:  # pragma: no cover
        return None
    spec = dict(t.work_order or {})
    due_in = spec.pop("due_in_days", None)
    data: dict[str, Any] = {
        k: spec[k]
        for k in ("title", "description", "priority", "assignees", "categories", "estimated_minutes")
        if k in spec
    }
    data.setdefault("title", f"{mt.name}: {t.name}")
    data["description"] = (data.get("description") or "") + (
        ("\n\n" if data.get("description") else "")
        + f"Created by the meter trigger “{t.name}”: {mt.name} read {_num(v)} {mt.unit} "
        + f"on {r.recorded_at:%Y-%m-%d %H:%M} UTC."
    )
    data["description"] = data["description"][:4096]
    if due_in not in (None, ""):
        try:
            data["due_at"] = (utcnow() + timedelta(days=int(due_in))).isoformat()
        except (TypeError, ValueError, OverflowError):
            t.last_note = "The trigger's due date setting is invalid; created without a due date."
    if mt.asset_id:
        data["asset_id"] = str(mt.asset_id)
    if mt.location_id:
        data["location_id"] = str(mt.location_id)
    data["work_type"] = "preventive" if t.kind == "every" else "reactive"
    try:
        wo = create_work_order(org, m, data, commit=False, check_required=False)
    except RuleError as e:
        t.last_note = f"Couldn't create the work order: {e.message}"
        return None
    wo.source_type, wo.source_id = "meter_trigger", t.id
    t.fired_count += 1
    t.last_fired_at = utcnow()
    t.last_note = f"Created #{wo.number} at {_num(v)} {mt.unit}"
    emit(
        "meter.trigger_fired",
        entity_type="meter",
        entity_id=mt.id,
        entity_label=mt.name,
        summary=f"Trigger {t.name} created work order #{wo.number}",
        data={"work_order_id": wo.id, "trigger_id": t.id},
        org_id=org.id,
    )
    return wo.id


# ---- monitoring points -----------------------------------------------------------------------
def save_point(org: Organization, data: dict[str, Any], p: MonitoringPoint | None = None) -> MonitoringPoint:
    if p is None:
        p = MonitoringPoint(org_id=org.id, name="", description="")
        db.session.add(p)
    if "name" in data or not p.name:
        name = str(data.get("name") or "").strip()
        if not name:
            raise RuleError("The monitoring point needs a name.", 422)
        p.name = name[:120]
    if "description" in data:
        p.description = str(data["description"] or "")[:4096]
    if "asset_id" in data:
        p.asset_id = get_asset(org.id, data["asset_id"]).id if data["asset_id"] else None
    db.session.flush()
    emit(
        "monitoring_point.saved",
        entity_type="monitoring_point",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Saved monitoring point {p.name}",
    )
    db.session.commit()
    return p


# ---- jobs ------------------------------------------------------------------------------------
def _month_bounds(y: int, mo: int) -> tuple[str, str, str]:
    ny, nmo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return f"meter_readings_{y:04d}{mo:02d}", f"{y:04d}-{mo:02d}-01", f"{ny:04d}-{nmo:02d}-01"


def ensure_partitions(months_ahead: int = 3) -> list[str]:
    """PostgreSQL: create monthly partitions of meter_readings ahead of time (roadmap r105).

    Each month is its own transaction. Rows that already landed in the DEFAULT partition for a month (before
    the job first ran) are moved into the new month: detach default, create the month, move rows, re-attach.
    """
    from sqlalchemy import text

    if db.engine.dialect.name != "postgresql":
        return []
    db.session.commit()
    is_part = db.session.scalar(text("SELECT relkind = 'p' FROM pg_class WHERE relname = 'meter_readings'"))
    if not is_part:
        return []
    made = []
    now = utcnow()
    months: list[tuple[int, int]] = []
    y, mo = now.year, now.month
    for _ in range(months_ahead + 1):
        months.append((y, mo))
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    # earlier months that only exist in the default partition (readings back-dated or imported)
    for (d,) in db.session.execute(
        text("SELECT DISTINCT date_trunc('month', recorded_at AT TIME ZONE 'UTC') FROM meter_readings_default")
    ).all():
        if (d.year, d.month) not in months:
            months.append((d.year, d.month))
    for y, mo in months:
        name, lo, hi = _month_bounds(y, mo)
        if db.session.scalar(text("SELECT 1 FROM pg_class WHERE relname = :n"), {"n": name}):
            continue
        try:
            stray = db.session.scalar(
                text("SELECT 1 FROM meter_readings_default WHERE recorded_at >= :lo AND recorded_at < :hi LIMIT 1"),
                {"lo": lo, "hi": hi},
            )
            if stray:
                db.session.execute(text("ALTER TABLE meter_readings DETACH PARTITION meter_readings_default"))
                db.session.execute(
                    text(f"CREATE TABLE {name} PARTITION OF meter_readings FOR VALUES FROM ('{lo}') TO ('{hi}')")
                )
                db.session.execute(
                    text(
                        f"WITH moved AS (DELETE FROM meter_readings_default WHERE recorded_at >= '{lo}' "
                        f"AND recorded_at < '{hi}' RETURNING *) INSERT INTO meter_readings SELECT * FROM moved"
                    )
                )
                db.session.execute(text("ALTER TABLE meter_readings ATTACH PARTITION meter_readings_default DEFAULT"))
            else:
                db.session.execute(
                    text(f"CREATE TABLE {name} PARTITION OF meter_readings FOR VALUES FROM ('{lo}') TO ('{hi}')")
                )
            db.session.commit()
            made.append(name)
        except Exception:  # keep going with later months; the job logs and retries tomorrow
            db.session.rollback()
            log.exception("Couldn't create partition %s", name)
    return made


def overdue_meters(org_id: uuid.UUID) -> list[Meter]:
    rows = db.session.scalars(
        select(Meter).where(Meter.org_id == org_id, Meter.deleted_at.is_(None), Meter.reading_frequency != "none")
    ).all()
    return [mt for mt in rows if is_overdue(mt)]


_ = func
