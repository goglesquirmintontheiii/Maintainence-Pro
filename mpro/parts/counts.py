"""Cycle counts (roadmap r222).

A cycle count picks parts (all, by type, by area, or a list) at a location and repeats on a schedule (an RFC 5545
RRULE, like preventive maintenance). Each occurrence creates a work order "Cycle count: <name>" assigned to the
counters, plus one line per part with the expected quantity. Counters enter what they find; applying the count
writes ledger rows of kind "count" for the differences (measured against the stock at that moment, so parts used
while counting aren't double-counted). Marking the work order Done applies the count.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.parts.ledger import ZERO, dec, record
from mpro.parts.models import CycleCount, CycleCountLine, CycleCountRun, Part, PartStock, PartTypeLink
from mpro.workorders.models import WorkOrder

MAX_LINES = 2000


def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (TypeError, ValueError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _next(rrule: str, after: datetime, tz_name: str | None = None) -> datetime | None:
    """The next date after `after` on the rule, keeping `after`'s time of day (in the org's time zone)."""
    if not rrule:
        return None
    from mpro.pm import schedule as sch

    return sch.next_after(rrule, after, after, sch.zone(tz_name))


def save_count(org: Organization, m: Membership, data: dict[str, Any], c: CycleCount | None = None) -> CycleCount:
    from mpro.parts.models import PartType
    from mpro.parts.services import _check_ids, _location
    from mpro.workorders.services import _resolve_assignees

    name = str(data.get("name", c.name if c else "")).strip()
    if not name:
        raise RuleError("Name the cycle count.", 422)
    created = c is None
    if c is None:
        c = CycleCount(org_id=org.id, created_by_id=m.user_id, selection={"all": True})
        db.session.add(c)
    c.name = name[:255]
    if "location_id" in data:
        c.location_id = _location(org.id, data.get("location_id"))
    if "selection" in data:
        sel = data["selection"]
        if not isinstance(sel, dict):
            raise RuleError("Pick which parts to count.", 422)
        clean: dict[str, Any] = {}
        if sel.get("part_ids"):
            clean["part_ids"] = [str(x) for x in _check_ids(org.id, Part, sel["part_ids"], "part")]
        if sel.get("type_ids"):
            clean["type_ids"] = [str(x) for x in _check_ids(org.id, PartType, sel["type_ids"], "part type")]
        if sel.get("area"):
            clean["area"] = str(sel["area"]).strip()[:120]
        if not clean:
            clean["all"] = True
        c.selection = clean
    if "rrule" in data:
        rr = str(data.get("rrule") or "").strip()
        if rr:
            from mpro.pm import schedule as sch

            rr = sch.validate_rrule(rr)
        c.rrule = rr
    if "next_at" in data:
        v = data.get("next_at")
        if v:
            from mpro.workorders.services import _dt

            c.next_at = _dt(v, "start")
        else:
            c.next_at = None
    if "assignees" in data:
        pairs = _resolve_assignees(org.id, data.get("assignees") or [])
        c.assignee_ids = [f"{k}:{i}" for k, i in pairs]
    if "active" in data:
        c.active = bool(data["active"])
    if c.rrule and c.next_at is None and c.active:
        c.next_at = _next(c.rrule, utcnow(), org.timezone)
    db.session.flush()
    emit(
        "cycle_count.created" if created else "cycle_count.updated",
        entity_type="cycle_count",
        entity_id=c.id,
        entity_label=c.name,
        summary=("Scheduled" if created else "Changed") + f" cycle count {c.name}",
        org_id=org.id,
    )
    db.session.commit()
    return c


def delete_count(org: Organization, c: CycleCount) -> None:
    c.deleted_at = utcnow()
    emit(
        "cycle_count.deleted",
        entity_type="cycle_count",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Deleted cycle count {c.name}",
        org_id=org.id,
    )
    db.session.commit()


def _selected_stock(org_id: uuid.UUID, c: CycleCount) -> list[PartStock]:
    sel = c.selection or {}
    q = (
        select(PartStock)
        .join(Part, Part.id == PartStock.part_id)
        .where(PartStock.org_id == org_id, Part.deleted_at.is_(None), Part.non_stock.is_(False))
    )
    q = q.where(PartStock.location_id.is_(None) if c.location_id is None else PartStock.location_id == c.location_id)
    if sel.get("part_ids"):
        q = q.where(PartStock.part_id.in_([uuid.UUID(x) for x in sel["part_ids"]]))
    if sel.get("type_ids"):
        q = q.where(
            PartStock.part_id.in_(
                select(PartTypeLink.part_id).where(PartTypeLink.type_id.in_([uuid.UUID(x) for x in sel["type_ids"]]))
            )
        )
    if sel.get("area"):
        area = str(sel["area"])
        q = q.where(PartStock.area.like(area.replace("*", "%")) if "*" in area else PartStock.area == area)
    return list(db.session.scalars(q.order_by(PartStock.area, Part.name).limit(MAX_LINES + 1)).all())


def start_run(org: Organization, m: Membership, c: CycleCount, due_at: datetime | None = None) -> CycleCountRun:
    from mpro.workorders.services import create_work_order

    stocks = _selected_stock(org.id, c)
    if not stocks:
        raise RuleError("No stocked parts match this count.", 422)
    if len(stocks) > MAX_LINES:
        raise RuleError(f"Count at most {MAX_LINES:,} parts at a time. Narrow the selection.", 422)
    wo = create_work_order(
        org,
        m,
        {
            "title": f"Cycle count: {c.name}",
            "description": f"Count {len(stocks)} part{'s' if len(stocks) != 1 else ''} and enter what you find in "
            "the Cycle count section. Marking this work order Done applies the count.",
            "work_type": "other",
            "location_id": str(c.location_id) if c.location_id else None,
            "due_at": (due_at or utcnow() + timedelta(days=1)).isoformat(),
            "assignees": list(c.assignee_ids or []),
        },
        commit=False,
        check_required=False,
    )
    run = CycleCountRun(org_id=org.id, cycle_count_id=c.id, work_order_id=wo.id, status="open", due_at=wo.due_at)
    db.session.add(run)
    db.session.flush()
    for st in stocks:
        db.session.add(
            CycleCountLine(
                org_id=org.id,
                run_id=run.id,
                part_id=st.part_id,
                location_id=st.location_id,
                expected=st.on_hand or ZERO,
            )
        )
    emit(
        "cycle_count.started",
        entity_type="cycle_count",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Started a count of {len(stocks)} parts (work order #{wo.number})",
        data={"run_id": run.id, "work_order_id": wo.id},
        org_id=org.id,
    )
    db.session.commit()
    return run


def enter(
    org: Organization, m: Membership, run: CycleCountRun, line_id: Any, counted: Any, note: str = ""
) -> CycleCountLine:
    if run.status != "open":
        raise RuleError("This count is finished.", 409)
    line = db.session.get(CycleCountLine, _uuid(line_id, "line"))
    if line is None or line.run_id != run.id:
        raise RuleError("That line isn't part of this count.", 404)
    if counted in (None, ""):
        line.counted = None
        line.counted_by_id = line.counted_at = None
    else:
        v = dec(counted, "count")
        if v < ZERO:
            raise RuleError("A count can't be negative.", 422)
        line.counted = v
        line.counted_by_id = m.user_id
        line.counted_at = utcnow()
    line.note = str(note or line.note or "")[:500]
    db.session.commit()
    return line


def apply_run(org: Organization, m: Membership, run: CycleCountRun, *, commit: bool = True) -> int:
    """Write the differences to the ledger and finish the run. Uncounted lines are left alone. Idempotent: the run
    row is locked and re-read, so applying twice (a double click, a retried request) writes the corrections once."""
    from mpro.parts.ledger import lock_part, lock_stock
    from mpro.parts.services import _after_change

    db.session.execute(
        select(CycleCountRun)
        .where(CycleCountRun.id == run.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    if run.status != "open":
        return 0
    n = 0
    for line in db.session.scalars(select(CycleCountLine).where(CycleCountLine.run_id == run.id)).all():
        if line.counted is None:
            continue
        p = db.session.get(Part, line.part_id)
        if p is None or p.deleted_at is not None or p.non_stock:
            continue
        # lock (part, then stock, like the ledger) before reading on-hand, so a concurrent change can't be lost
        lock_part(org.id, line.part_id)
        st = lock_stock(org.id, line.part_id, line.location_id)
        diff = line.counted - (st.on_hand or ZERO)
        if diff != ZERO:
            record(
                org.id,
                line.part_id,
                line.location_id,
                "count",
                diff,
                cycle_count_id=run.cycle_count_id,
                user_id=m.user_id,
                note=f"Cycle count: counted {line.counted}" + (f" ({line.note})" if line.note else ""),
            )
            _after_change(org.id, p, line.location_id)
            n += 1
    run.status = "done"
    run.completed_at = utcnow()
    c = db.session.get(CycleCount, run.cycle_count_id)
    emit(
        "cycle_count.applied",
        entity_type="cycle_count",
        entity_id=run.cycle_count_id,
        entity_label=c.name if c else "",
        summary=f"Applied a count: {n} correction{'s' if n != 1 else ''}",
        data={"run_id": run.id},
        org_id=org.id,
    )
    if commit:
        db.session.commit()
    return n


def on_wo_status(org: Organization, m: Membership, wo: WorkOrder, from_status: str, to_status: str) -> None:
    run = db.session.scalars(select(CycleCountRun).where(CycleCountRun.work_order_id == wo.id)).first()
    if run is None:
        return
    if to_status == "done":
        apply_run(org, m, run, commit=False)
    elif to_status == "canceled" and run.status == "open":
        run.status = "canceled"


def run_dict(run: CycleCountRun, show_expected: bool = True) -> dict[str, Any]:
    from mpro.core.models import iso
    from mpro.parts.services import _loc_name, _q

    lines = db.session.execute(
        select(CycleCountLine, Part)
        .join(Part, Part.id == CycleCountLine.part_id)
        .where(CycleCountLine.run_id == run.id)
        .order_by(Part.name)
    ).all()
    stock = {
        (s.part_id, s.location_id): s
        for s in db.session.scalars(
            select(PartStock).where(PartStock.part_id.in_([ln.part_id for ln, _p in lines]))
        ).all()
    }
    counted = sum(1 for ln, _p in lines if ln.counted is not None)
    return {
        "id": str(run.id),
        "cycle_count_id": str(run.cycle_count_id),
        "work_order_id": str(run.work_order_id) if run.work_order_id else None,
        "status": run.status,
        "due_at": iso(run.due_at),
        "completed_at": iso(run.completed_at),
        "progress": {"counted": counted, "total": len(lines)},
        "lines": [
            {
                "id": str(ln.id),
                "part": {"id": str(p.id), "name": p.name, "part_number": p.part_number, "unit": p.unit},
                "location": {"id": str(ln.location_id), "name": _loc_name(ln.location_id)} if ln.location_id else None,
                "area": getattr(stock.get((ln.part_id, ln.location_id)), "area", "") or "",
                "expected": _q(ln.expected) if show_expected else None,
                "counted": _q(ln.counted) if ln.counted is not None else None,
                "difference": _q(ln.counted - ln.expected) if ln.counted is not None and show_expected else None,
                "note": ln.note,
                "counted_at": iso(ln.counted_at),
            }
            for ln, p in lines
        ],
    }


def count_dict(c: CycleCount) -> dict[str, Any]:
    from mpro.core.models import iso
    from mpro.parts.services import _loc_name

    last = db.session.scalars(
        select(CycleCountRun).where(CycleCountRun.cycle_count_id == c.id).order_by(CycleCountRun.created_at.desc())
    ).first()
    return {
        "id": str(c.id),
        "name": c.name,
        "location": {"id": str(c.location_id), "name": _loc_name(c.location_id)} if c.location_id else None,
        "selection": c.selection or {},
        "rrule": c.rrule,
        "next_at": iso(c.next_at),
        "assignees": list(c.assignee_ids or []),
        "active": c.active,
        "last_run": {
            "id": str(last.id),
            "status": last.status,
            "work_order_id": str(last.work_order_id) if last.work_order_id else None,
            "created_at": iso(last.created_at),
        }
        if last
        else None,
    }


def run_csv(run: CycleCountRun) -> bytes:
    d = run_dict(run)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Part", "Part number", "Location", "Area", "Expected", "Counted", "Difference", "Note", "Counted at"])
    for ln in d["lines"]:
        w.writerow(
            [
                _safe(ln["part"]["name"]),
                _safe(ln["part"]["part_number"]),
                _safe(ln["location"]["name"] if ln["location"] else ""),
                _safe(ln["area"]),
                ln["expected"],
                ln["counted"] or "",
                ln["difference"] or "",
                _safe(ln["note"]),
                ln["counted_at"] or "",
            ]
        )
    return buf.getvalue().encode("utf-8-sig")


def _safe(v: Any) -> str:
    s = str(v or "")
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def due_runs(now: datetime | None = None) -> int:
    """The `parts.cycle_counts` job: start counts whose next date has come, then move next_at along the rule."""
    from mpro.orgs.models import Organization as Org

    now = now or utcnow()
    n = 0
    for c in db.session.scalars(
        select(CycleCount).where(
            CycleCount.active.is_(True),
            CycleCount.deleted_at.is_(None),
            CycleCount.next_at.is_not(None),
            CycleCount.next_at <= now,
        )
    ).all():
        org = db.session.get(Org, c.org_id)
        m = _runner(c)
        if org is None or m is None:
            continue
        due = c.next_at
        try:
            start_run(org, m, c, due_at=(due or now) + timedelta(days=1))
            c.next_at = _next(c.rrule, max(due or now, now), org.timezone)
            db.session.commit()
            n += 1
        except RuleError:
            db.session.rollback()
            c = db.session.get(CycleCount, c.id)  # type: ignore[assignment]
            if c is not None:
                c.next_at = _next(c.rrule, max(due or now, now), org.timezone)
                db.session.commit()
    return n


def _runner(c: CycleCount) -> Membership | None:
    """Who the scheduled work order is created by: the count's author, else an Owner."""
    m = None
    if c.created_by_id:
        m = db.session.scalars(
            select(Membership).where(
                Membership.org_id == c.org_id, Membership.user_id == c.created_by_id, Membership.deleted_at.is_(None)
            )
        ).first()
    if m is None:
        m = db.session.scalars(
            select(Membership).where(
                Membership.org_id == c.org_id, Membership.role == "owner", Membership.deleted_at.is_(None)
            )
        ).first()
    return m
