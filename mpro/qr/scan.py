"""Scan actions, check-ins and scan history (0.6.0, MP-097, r292, r581).

What happens after a scan depends on what was scanned and who scanned it. Every scan, and every action taken from
it (check-in, start, reading…), is a `ScanEvent`: the scan history that proves a technician was on site. Public scans
(signed out) only ever lead to the request form, are rate-limited, keep no IP address, and are off by default.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from flask import current_app
from sqlalchemy import delete, func, or_, select

from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.qr import services as qsvc
from mpro.qr.models import PublicScanHit, QrCode, ScanEvent, ScanRequirement

# ---- settings ------------------------------------------------------------------------------------------------------
ENTITY_TYPES = ("asset", "location", "part", "work_order", "procedure", "meter")
DEFAULTS: dict[str, Any] = {
    # what opens straight away after a scan; "menu" shows the choices
    "default_actions": {
        "asset": "menu",
        "location": "check_in",
        "part": "menu",
        "work_order": "open",
        "procedure": "start",
        "meter": "reading",
    },
    "role_actions": {},  # {"requester": {"asset": "report"}, "custom:<role id>": {...}}: overrides per role
    "public_scans": False,  # people who aren't signed in get the request form for assets and locations
    "public_types": ["asset", "location"],
    "record_gps": False,  # keep the phone's position with each scan (the phone asks first)
    "require_window_minutes": 120,  # how recent a scan must be to start or complete a work order that needs one
}
register_defaults("scan", DEFAULTS)

# entity type -> action -> (label, permissions: any one of them is enough)
ACTIONS: dict[str, dict[str, tuple[str, tuple[str, ...]]]] = {
    "asset": {
        "open": ("Open the asset", ("assets.view",)),
        "start_wo": ("Start or continue its work order", ("wo.status", "wo.create")),
        "log_meter": ("Log a meter reading", ("meters.read",)),
        "manuals": ("Open manuals and files", ("assets.view",)),
        "report": ("Report a problem", ("requests.create",)),
    },
    "location": {
        "check_in": ("Check in", ("locations.view",)),
        "open": ("See its assets and open work", ("locations.view",)),
        "report": ("Report a problem", ("requests.create",)),
    },
    "part": {
        "open": ("Open the part", ("parts.view",)),
        "use": ("Use parts", ("parts.use",)),
        "restock": ("Restock", ("parts.stock",)),
        "count": ("Count stock", ("parts.counts",)),
    },
    "work_order": {
        "open": ("Open the work order", ("wo.view",)),
        "complete": ("Complete it", ("wo.status",)),
    },
    "procedure": {
        "start": ("Start the inspection", ("wo.create", "wo.status")),
        "open": ("Open the procedure", ("procedures.view",)),
    },
    "meter": {
        "reading": ("Enter a reading", ("meters.read",)),
        "open": ("Open the meter", ("meters.view",)),
    },
}
# actions recorded in the history besides the scan itself
RECORDED = {"check_in", "start", "start_wo", "complete", "reading", "use", "restock", "count", "report"}

# Request forms for public scans (F1 registers its portal URL builder): fn(org_id, entity_type, entity_id) -> url
PUBLIC_REQUEST_URL: list[Callable[[uuid.UUID, str, uuid.UUID], str | None]] = []

PUBLIC_PER_MINUTE = 30
PUBLIC_FAILED_15MIN = 20


def role_key(m: Membership) -> str:
    return f"custom:{m.role_id}" if getattr(m, "role_id", None) else m.role


def settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "scan")


def save(org: Organization, m: Membership, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RuleError("Send the settings as an object.", 422)
    clean: dict[str, Any] = {}
    if "default_actions" in data:
        da = data["default_actions"]
        if not isinstance(da, dict):
            raise RuleError("default_actions must be an object.", 422)
        cur = dict(settings(org.id)["default_actions"])
        for et, act in da.items():
            if et not in ACTIONS or (act != "menu" and act not in ACTIONS[et]):
                raise RuleError(f"{act!r} isn't something a {et.replace('_', ' ')} scan can do.", 422)
            cur[et] = act
        clean["default_actions"] = cur
    if "role_actions" in data:
        ra = data["role_actions"]
        if not isinstance(ra, dict) or len(ra) > 100:
            raise RuleError("role_actions must be an object.", 422)
        out: dict[str, dict[str, str]] = {}
        for role, per in ra.items():
            if not isinstance(role, str) or not isinstance(per, dict):
                raise RuleError("role_actions must map a role to {type: action}.", 422)
            if role.startswith("custom:"):
                from mpro.orgs.models import Role

                try:
                    rid = uuid.UUID(role[7:])
                except ValueError as e:
                    raise RuleError("Unknown role.", 422) from e
                r = db.session.get(Role, rid)
                if r is None or r.org_id != org.id:
                    raise RuleError("Unknown role.", 422)
            else:
                from mpro.core.permissions import ROLES

                if role not in ROLES:
                    raise RuleError(f"Unknown role {role!r}.", 422)
            row: dict[str, str] = {}
            for et, act in per.items():
                if et not in ACTIONS or (act != "menu" and act not in ACTIONS[et]):
                    raise RuleError(f"{act!r} isn't something a {str(et).replace('_', ' ')} scan can do.", 422)
                row[et] = act
            if row:
                out[role] = row
        clean["role_actions"] = out
    for k in ("public_scans", "record_gps"):
        if k in data:
            if not isinstance(data[k], bool):
                raise RuleError(f"{k} must be true or false.", 422)
            clean[k] = data[k]
    if "public_types" in data:
        pt = data["public_types"]
        if not isinstance(pt, list) or any(t not in ("asset", "location") for t in pt):
            raise RuleError("Public scans can lead to requests for assets and locations only.", 422)
        clean["public_types"] = sorted(set(pt))
    if "require_window_minutes" in data:
        w = data["require_window_minutes"]
        if not isinstance(w, int) or isinstance(w, bool) or not 5 <= w <= 24 * 60:
            raise RuleError("The scan window is between 5 minutes and 24 hours.", 422)
        clean["require_window_minutes"] = w
    out_settings = save_settings(org.id, "scan", clean)
    emit(
        "scan.settings_changed",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary="Changed what scanning a code does",
        data={"keys": sorted(clean)},
        org_id=org.id,
    )
    db.session.commit()
    return out_settings


def available_actions(m: Membership, entity_type: str) -> list[dict[str, str]]:
    return [
        {"key": k, "label": label}
        for k, (label, perms) in ACTIONS.get(entity_type, {}).items()
        if any(can(m, p) for p in perms)
    ]


def default_action(org_id: uuid.UUID, m: Membership, entity_type: str, actions: list[dict[str, str]]) -> str:
    s = settings(org_id)
    act = (s["role_actions"].get(role_key(m)) or {}).get(entity_type) or s["default_actions"].get(entity_type, "menu")
    keys = [a["key"] for a in actions]
    if act == "menu" or act not in keys:
        return "menu" if len(keys) != 1 else keys[0]
    return str(act)


# ---- targets that 0.3.0 didn't have: work orders and procedures (r581) ----------------------------------------------
def register_targets() -> None:
    from mpro.procedures.models import Procedure
    from mpro.workorders.models import WorkOrder

    qsvc.register_target(
        "work_order", WorkOrder, lambda w: f"#{w.number} {w.title}", lambda w: f"/work-orders/{w.id}", "wo.view"
    )
    qsvc.register_target("procedure", Procedure, lambda p: p.name, lambda p: f"/procedures/{p.id}", "procedures.view")


# ---- helpers -------------------------------------------------------------------------------------------------------
def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _target(org_id: uuid.UUID, m: Membership, entity_type: str, entity_id: Any) -> Any:
    rec = qsvc._target(org_id, entity_type, entity_id)
    t = qsvc._targets[entity_type]
    if not can(m, t.view):
        raise RuleError("You don't have access to this record.", 403)
    if entity_type == "work_order":
        from mpro.workorders.services import can_see

        if not can_see(m, rec):
            raise RuleError("You don't have access to this record.", 403)
    if entity_type == "procedure" and rec.work_order_id is not None:  # one-off procedures inside a work order
        raise RuleError("That record doesn't exist.", 422)
    return rec


def _gps(data: dict[str, Any]) -> tuple[Decimal | None, Decimal | None, int | None]:
    lat, lng = data.get("latitude"), data.get("longitude")
    if lat is None or lng is None:
        return None, None, None
    try:
        la, lo = Decimal(str(lat)).quantize(Decimal("0.000001")), Decimal(str(lng)).quantize(Decimal("0.000001"))
    except (InvalidOperation, ValueError) as e:
        raise RuleError("The position isn't valid.", 422) from e
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        raise RuleError("The position isn't valid.", 422)
    acc = data.get("accuracy")
    try:
        accuracy = None if acc is None else max(0, min(int(float(acc)), 1_000_000))
    except (TypeError, ValueError) as e:
        raise RuleError("The position accuracy isn't valid.", 422) from e
    return la, lo, accuracy


def _scanned_at(v: Any) -> datetime:
    now = utcnow()
    if not v:
        return now
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError as e:
        raise RuleError("scanned_at must be a date and time.", 422) from e
    if dt.tzinfo is None:
        raise RuleError("scanned_at needs a time zone.", 422)
    if dt > now + timedelta(minutes=5) or dt < now - timedelta(days=7):
        raise RuleError("That scan is too old (or in the future) to record.", 422)
    return dt


def _event_dict(ev: ScanEvent, with_gps: bool) -> dict[str, Any]:
    from mpro.auth.models import User

    u = db.session.get(User, ev.user_id) if ev.user_id else None
    d: dict[str, Any] = {
        "id": str(ev.id),
        "entity_type": ev.entity_type,
        "entity_id": str(ev.entity_id),
        "entity_label": ev.entity_label,
        "action": ev.action,
        "action_label": "Scanned"
        if ev.action == "scan"
        else ACTIONS.get(ev.entity_type, {}).get(ev.action, (ev.action.replace("_", " ").capitalize(),))[0],
        "work_order_id": str(ev.work_order_id) if ev.work_order_id else None,
        "source": ev.source,
        "user": {"id": str(u.id), "name": u.name} if u else None,
        "public": ev.user_id is None,
        "scanned_at": iso(ev.scanned_at),
    }
    if with_gps and ev.latitude is not None:
        d["gps"] = {"latitude": str(ev.latitude), "longitude": str(ev.longitude), "accuracy_m": ev.accuracy_m}
    return d


def _record(
    org_id: uuid.UUID,
    user_id: uuid.UUID | None,
    entity_type: str,
    rec: Any,
    action: str,
    *,
    code_id: uuid.UUID | None = None,
    work_order_id: uuid.UUID | None = None,
    source: str = "camera",
    gps: tuple[Decimal | None, Decimal | None, int | None] = (None, None, None),
    scanned_at: datetime | None = None,
    client_id: str | None = None,
) -> ScanEvent:
    label = qsvc._targets[entity_type].label(rec)
    ev = ScanEvent(
        org_id=org_id,
        user_id=user_id,
        code_id=code_id,
        entity_type=entity_type,
        entity_id=rec.id,
        entity_label=label[:300],
        action=action,
        work_order_id=work_order_id,
        source=source,
        latitude=gps[0],
        longitude=gps[1],
        accuracy_m=gps[2],
        scanned_at=scanned_at or utcnow(),
        client_id=client_id,
    )
    db.session.add(ev)
    db.session.flush()
    verb = {"scan": "Scanned", "check_in": "Checked in at"}.get(action)
    de = emit(
        "scan.checked_in" if action == "check_in" else "scan.recorded" if action != "scan" else "scan.scanned",
        entity_type=entity_type,
        entity_id=rec.id,
        entity_label=label,
        summary=f"{verb} {label}" if verb else f"{ACTIONS[entity_type][action][0]} after scanning",
        data={
            "scan_id": str(ev.id),
            "action": action,
            "work_order_id": str(work_order_id) if work_order_id else None,
            "user_id": str(user_id) if user_id else None,
            "source": source,
        },
        org_id=org_id,
    )
    if user_id is None:  # public scans keep no IP address and have no person behind them
        de.ip, de.actor_id, de.actor_label = "", None, "Public scan"
    return ev


# ---- context shown after a scan ------------------------------------------------------------------------------------
def _open_wos(m: Membership, clause: Any, limit: int = 5) -> list[dict[str, Any]]:
    from mpro.workorders.models import WorkOrder, WorkOrderAssignee
    from mpro.workorders.services import visibility_filter

    if not can(m, "wo.view"):
        return []
    rows = db.session.scalars(
        select(WorkOrder)
        .where(
            WorkOrder.org_id == m.org_id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.in_(("open", "in_progress", "on_hold")),
            clause,
            visibility_filter(m),
        )
        .order_by(WorkOrder.status != "in_progress", WorkOrder.due_at.is_(None), WorkOrder.due_at, WorkOrder.number)
        .limit(limit)
    ).all()
    mine = (
        set(
            db.session.scalars(
                select(WorkOrderAssignee.work_order_id).where(
                    WorkOrderAssignee.work_order_id.in_([w.id for w in rows]), WorkOrderAssignee.user_id == m.user_id
                )
            )
        )
        if rows
        else set()
    )
    return [
        {
            "id": str(w.id),
            "number": w.number,
            "title": w.title,
            "status": w.status,
            "due_at": iso(w.due_at),
            "assigned_to_me": w.id in mine,
        }
        for w in rows
    ]


def context(m: Membership, entity_type: str, rec: Any) -> dict[str, Any]:
    from mpro.core.files import FileLink
    from mpro.workorders.models import WorkOrder, WorkOrderAsset

    if entity_type == "asset":
        from mpro.meters.models import Meter

        meters = (
            db.session.scalars(
                select(Meter).where(Meter.org_id == m.org_id, Meter.asset_id == rec.id, Meter.deleted_at.is_(None))
            ).all()
            if can(m, "meters.view")
            else []
        )
        on_wo = select(WorkOrderAsset.work_order_id).where(WorkOrderAsset.asset_id == rec.id)
        return {
            "status": rec.status,
            "location": rec.location.name if getattr(rec, "location", None) else None,
            "work_orders": _open_wos(m, or_(WorkOrder.asset_id == rec.id, WorkOrder.id.in_(on_wo))),
            "meters": [{"id": str(x.id), "name": x.name, "unit": x.unit} for x in meters],
            "files": db.session.scalar(
                select(func.count())
                .select_from(FileLink)
                .where(FileLink.org_id == m.org_id, FileLink.entity_type == "asset", FileLink.entity_id == rec.id)
            )
            or 0,
        }
    if entity_type == "location":
        from mpro.assets.models import Asset

        assets = (
            db.session.scalars(
                select(Asset)
                .where(Asset.org_id == m.org_id, Asset.location_id == rec.id, Asset.deleted_at.is_(None))
                .order_by(Asset.name)
                .limit(25)
            ).all()
            if can(m, "assets.view")
            else []
        )
        return {
            "assets": [{"id": str(a.id), "name": a.name, "status": a.status} for a in assets],
            "work_orders": _open_wos(m, WorkOrder.location_id == rec.id),
        }
    if entity_type == "part":
        return {
            "unit": rec.unit,
            "on_hand": str(rec.on_hand),
            "available": str(rec.on_hand - rec.reserved),
            "part_number": rec.part_number,
            "non_stock": rec.non_stock,
        }
    if entity_type == "work_order":
        return {"status": rec.status, "number": rec.number, "title": rec.title}
    if entity_type == "procedure":
        from mpro.procedures.models import ProcedureRun

        runs = select(ProcedureRun.work_order_id).where(ProcedureRun.procedure_id == rec.id)
        return {"work_orders": _open_wos(m, WorkOrder.id.in_(runs)), "published": rec.current_version_id is not None}
    if entity_type == "meter":
        return {
            "unit": rec.unit,
            "last_value": str(rec.last_value) if rec.last_value is not None else None,
            "last_reading_at": iso(rec.last_reading_at),
        }
    return {}


# ---- scanning ------------------------------------------------------------------------------------------------------
def _limited(m: Membership, raw: str) -> dict[str, Any] | None:
    """Someone who can't see the record (a requester) can still report a problem on an asset or location."""
    if not can(m, "requests.create"):
        return None
    match = qsvc._URL_CODE.search(raw)
    candidates = [match.group(1).upper()] if match else []
    candidates += [raw, raw.upper()]
    c = db.session.scalars(
        select(QrCode).where(
            QrCode.org_id == m.org_id, QrCode.value.in_(candidates), QrCode.retired_at.is_(None)
        )  # fmt: skip
    ).first()
    if c is None or c.entity_type not in ("asset", "location") or not c.entity_id:
        return None
    t = qsvc._targets[c.entity_type]
    rec = db.session.get(t.model, c.entity_id)
    if rec is None or rec.org_id != m.org_id or getattr(rec, "deleted_at", None) is not None:
        return None
    return {
        "status": "found",
        "limited": True,
        "entity_type": c.entity_type,
        "entity_id": str(rec.id),
        "label": t.label(rec),
        "url": request_form_url(c.entity_type, rec.id),
        "code_id": c.id,
        "rec": rec,
    }


def request_form_url(entity_type: str, entity_id: uuid.UUID) -> str:
    return f"/requests/new?{entity_type}_id={entity_id}"


def scan(org: Organization, m: Membership, data: dict[str, Any]) -> dict[str, Any]:
    """Resolve a scanned value, record the scan, and say what this person can do next."""
    raw = str(data.get("value") or "")
    source = str(data.get("source") or "camera")
    if source not in ("camera", "link", "typed", "photo"):
        raise RuleError("Unknown scan source.", 422)
    s = settings(org.id)
    gps = _gps(data) if s["record_gps"] else (None, None, None)
    client_id = str(data["client_id"])[:64] if data.get("client_id") else None
    if client_id:  # a replay of this person's own scan (0.6.0 review L5: never someone else's)
        dup = db.session.scalars(
            select(ScanEvent).where(
                ScanEvent.org_id == org.id, ScanEvent.client_id == client_id, ScanEvent.user_id == m.user_id
            )
        ).first()
    else:
        dup = None
    try:
        r = qsvc.resolve(m, raw)
    except RuleError as e:
        if e.status != 403:
            raise
        lim = _limited(m, raw)
        if lim is None:
            raise
        rec, code_id = lim.pop("rec"), lim.pop("code_id")
        ev = dup or _record(
            org.id, m.user_id, lim["entity_type"], rec, "scan", code_id=code_id, source=source, gps=gps,
            scanned_at=_scanned_at(data.get("scanned_at")), client_id=client_id,
        )  # fmt: skip
        db.session.commit()
        acts = [a for a in available_actions(m, lim["entity_type"]) if a["key"] == "report"]
        return {**lim, "scan_id": str(ev.id), "actions": acts, "default_action": "report", "context": {}}
    if r.get("status") != "found":
        return r
    et = r["entity_type"]
    rec = _target(org.id, m, et, r["entity_id"])
    code_id = uuid.UUID(r["code"]["id"]) if r.get("code") else None
    ev = dup or _record(
        org.id, m.user_id, et, rec, "scan", code_id=code_id, source=source, gps=gps,
        scanned_at=_scanned_at(data.get("scanned_at")), client_id=client_id,
        work_order_id=rec.id if et == "work_order" else None,
    )  # fmt: skip
    db.session.commit()
    acts = available_actions(m, et)
    return {
        **r,
        "scan_id": str(ev.id),
        "actions": acts,
        "default_action": default_action(org.id, m, et, acts),
        "context": context(m, et, rec),
    }


def record_action(org: Organization, m: Membership, data: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """An action taken after a scan (check in, start, reading…), or a scan made offline and synced later.
    Returns (event, created). Replays with the same client_id return the first one."""
    et = str(data.get("entity_type") or "")
    action = str(data.get("action") or "scan")
    if et not in ACTIONS:
        raise RuleError("Scans can be of assets, locations, parts, work orders, procedures and meters.", 422)
    if action != "scan" and action not in RECORDED:
        raise RuleError("That action isn't kept in the scan history.", 422)
    if action != "scan" and action not in ACTIONS[et]:
        raise RuleError(f"A {et.replace('_', ' ')} scan can't do that.", 422)
    client_id = str(data["client_id"])[:64] if data.get("client_id") else None
    if client_id:
        dup = db.session.scalars(
            select(ScanEvent).where(ScanEvent.org_id == org.id, ScanEvent.client_id == client_id)
        ).first()
        if dup is not None:
            if dup.user_id != m.user_id:
                raise RuleError("That scan id is already used.", 409)
            return _event_dict(dup, True), False
    if action != "scan" and not any(can(m, p) for p in ACTIONS[et][action][1]):
        raise RuleError("You don't have permission to do that.", 403)
    if action == "report" or (action == "scan" and not can(m, qsvc._targets[et].view)):
        if not can(m, "requests.create") or et not in ("asset", "location"):
            raise RuleError("You don't have access to this record.", 403)
        rec = qsvc._target(org.id, et, data.get("entity_id"))
    else:
        rec = _target(org.id, m, et, data.get("entity_id"))
    wo_id = None
    if data.get("work_order_id"):
        from mpro.workorders.models import WorkOrder
        from mpro.workorders.services import can_see

        wo = db.session.get(WorkOrder, _uuid(data["work_order_id"], "work order"))
        if wo is None or wo.org_id != org.id or wo.deleted_at is not None or not can_see(m, wo):
            raise RuleError("That work order doesn't exist.", 422)
        wo_id = wo.id
    elif et == "work_order":
        wo_id = rec.id
    code_id = None
    if data.get("code"):
        c = db.session.scalars(
            select(QrCode).where(QrCode.org_id == org.id, QrCode.value == str(data["code"]).upper()[:200])
        ).first()
        code_id = c.id if c is not None and c.entity_id == rec.id else None
    source = str(data.get("source") or "camera")
    if source not in ("camera", "link", "typed", "photo", "offline"):
        raise RuleError("Unknown scan source.", 422)
    gps = _gps(data) if settings(org.id)["record_gps"] else (None, None, None)
    ev = _record(
        org.id, m.user_id, et, rec, action, code_id=code_id, work_order_id=wo_id, source=source, gps=gps,
        scanned_at=_scanned_at(data.get("scanned_at")), client_id=client_id,
    )  # fmt: skip
    db.session.commit()
    return _event_dict(ev, True), True


def start_procedure(org: Organization, m: Membership, data: dict[str, Any]) -> dict[str, Any]:
    """Scanning a procedure / inspection-round code: continue my open work order with it, or start a new one."""
    from mpro.procedures.models import Procedure, ProcedureRun
    from mpro.workorders.models import WorkOrder, WorkOrderAssignee
    from mpro.workorders.services import create_work_order, visibility_filter

    p: Procedure = _target(org.id, m, "procedure", data.get("procedure_id"))
    runs = select(ProcedureRun.work_order_id).where(ProcedureRun.procedure_id == p.id)
    mine = select(WorkOrderAssignee.work_order_id).where(WorkOrderAssignee.user_id == m.user_id)
    existing = None
    if can(m, "wo.view"):
        existing = db.session.scalars(
            select(WorkOrder)
            .where(
                WorkOrder.org_id == org.id,
                WorkOrder.deleted_at.is_(None),
                WorkOrder.status.in_(("open", "in_progress", "on_hold")),
                WorkOrder.id.in_(runs),
                WorkOrder.id.in_(mine),
                visibility_filter(m),
            )
            .order_by(WorkOrder.status != "in_progress", WorkOrder.created_at.desc())
        ).first()
    created = False
    if existing is None:
        if not can(m, "wo.create"):
            raise RuleError("There's no open work order for you with this procedure, and you can't create one.", 403)
        if p.current_version_id is None:
            raise RuleError(f"{p.name} is a draft. Publish it first.", 422)
        existing = create_work_order(
            org,
            m,
            {"title": p.name, "procedures": [str(p.id)], "assignees": [f"user:{m.user_id}"]},
            commit=False,
            check_required=False,
        )
        created = True
    ev = _record(org.id, m.user_id, "procedure", p, "start", work_order_id=existing.id, source="camera")
    db.session.commit()
    return {"work_order_id": str(existing.id), "number": existing.number, "created": created, "scan_id": str(ev.id)}


# ---- history and proof of visit ------------------------------------------------------------------------------------
def history(org: Organization, m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    """Everyone sees their own scans; scan.history sees everyone's."""
    q = select(ScanEvent).where(ScanEvent.org_id == org.id)
    everyone = can(m, "scan.history")
    if not everyone:
        q = q.where(ScanEvent.user_id == m.user_id)
    elif params.get("user_id"):
        q = q.where(ScanEvent.user_id == _uuid(params["user_id"], "person"))
    if params.get("entity_type"):
        et = str(params["entity_type"])
        if et not in ACTIONS:
            raise RuleError("Unknown record type.", 422)
        q = q.where(ScanEvent.entity_type == et)
        if params.get("entity_id"):
            q = q.where(ScanEvent.entity_id == _uuid(params["entity_id"], "record"))
    if params.get("work_order_id"):
        q = q.where(ScanEvent.work_order_id == _uuid(params["work_order_id"], "work order"))
    if params.get("action"):
        q = q.where(ScanEvent.action == str(params["action"]))
    if params.get("public") == "0":
        q = q.where(ScanEvent.user_id.is_not(None))
    try:
        per_page = max(1, min(int(params.get("per_page") or 50), 200))
        page = max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("page and per_page must be numbers.", 422) from e
    if everyone:  # count and page only what this person may see (0.6.0 review L5)
        q = q.where(or_(ScanEvent.user_id == m.user_id, _visible_clause(org, m)))
    total = db.session.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.session.scalars(
        q.order_by(ScanEvent.scanned_at.desc(), ScanEvent.id.desc()).limit(per_page).offset((page - 1) * per_page)
    ).all()
    # a record's history only lists scans of records this person may see
    visible = [ev for ev in rows if _may_see_entity(m, ev)]
    return {
        "items": [_event_dict(ev, everyone or ev.user_id == m.user_id) for ev in visible],
        "total": total,
        "page": page,
        "per_page": per_page,
        "everyone": everyone,
    }


def _visible_clause(org: Organization, m: Membership) -> Any:
    """SQL twin of _may_see_entity for other people's scans: record types this person may view, and for work
    orders only the ones they may see."""
    from sqlalchemy import false

    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import visibility_filter

    types = [et for et, t in qsvc._targets.items() if can(m, t.view)]
    if not types:
        return false()
    wo_ok = ScanEvent.entity_id.in_(select(WorkOrder.id).where(WorkOrder.org_id == org.id, visibility_filter(m)))
    return ScanEvent.entity_type.in_(types) & or_(ScanEvent.entity_type != "work_order", wo_ok)


def _may_see_entity(m: Membership, ev: ScanEvent) -> bool:
    if ev.user_id == m.user_id:
        return True
    t = qsvc._targets.get(ev.entity_type)
    if t is None or not can(m, t.view):
        return False
    if ev.entity_type == "work_order":
        from mpro.workorders.models import WorkOrder
        from mpro.workorders.services import can_see

        wo = db.session.get(WorkOrder, ev.entity_id)
        return wo is not None and can_see(m, wo)
    return True


def _wo_targets(wo: Any) -> list[tuple[str, uuid.UUID]]:
    from mpro.workorders.models import WorkOrderAsset

    out: list[tuple[str, uuid.UUID]] = [("work_order", wo.id)]
    asset_ids = set(
        db.session.scalars(select(WorkOrderAsset.asset_id).where(WorkOrderAsset.work_order_id == wo.id)).all()
    )
    if wo.asset_id:
        asset_ids.add(wo.asset_id)
    out += [("asset", a) for a in asset_ids]
    if wo.location_id:
        out.append(("location", wo.location_id))
    return out


def _target_clause(targets: list[tuple[str, uuid.UUID]]) -> Any:
    return or_(*[(ScanEvent.entity_type == et) & (ScanEvent.entity_id == eid) for et, eid in targets])


def visits(org: Organization, m: Membership, wo: Any) -> dict[str, Any]:
    """Proof of visit on a work order: scans linked to it, plus scans of its assets and location while it was open."""
    from mpro.workorders.services import can_see

    if not can_see(m, wo):
        raise RuleError("That work order doesn't exist.", 404)
    end = wo.completed_at or utcnow()
    q = select(ScanEvent).where(
        ScanEvent.org_id == org.id,
        ScanEvent.user_id.is_not(None),
        or_(
            ScanEvent.work_order_id == wo.id,
            _target_clause(_wo_targets(wo)) & (ScanEvent.scanned_at >= wo.created_at) & (ScanEvent.scanned_at <= end),
        ),
    )
    everyone = can(m, "scan.history")
    if not everyone:
        q = q.where(ScanEvent.user_id == m.user_id)
    rows = db.session.scalars(q.order_by(ScanEvent.scanned_at).limit(200)).all()
    return {"items": [_event_dict(ev, everyone or ev.user_id == m.user_id) for ev in rows], "everyone": everyone}


# ---- require a scan to start or complete (like MaintainX location check-in) ------------------------------------------
def requirement(org_id: uuid.UUID, procedure_id: uuid.UUID) -> dict[str, Any]:
    r = db.session.scalars(
        select(ScanRequirement).where(ScanRequirement.org_id == org_id, ScanRequirement.procedure_id == procedure_id)
    ).first()
    return {"on_start": bool(r and r.on_start), "on_complete": bool(r and r.on_complete)}


def set_requirement(org: Organization, m: Membership, p: Any, data: dict[str, Any]) -> dict[str, Any]:
    for k in ("on_start", "on_complete"):
        if k in data and not isinstance(data[k], bool):
            raise RuleError(f"{k} must be true or false.", 422)
    r = db.session.scalars(
        select(ScanRequirement).where(ScanRequirement.org_id == org.id, ScanRequirement.procedure_id == p.id)
    ).first()
    if r is None:
        r = ScanRequirement(org_id=org.id, procedure_id=p.id, on_start=False, on_complete=False)
        db.session.add(r)
    before = {"on_start": r.on_start, "on_complete": r.on_complete}
    r.on_start = bool(data.get("on_start", r.on_start))
    r.on_complete = bool(data.get("on_complete", r.on_complete))
    after = {"on_start": r.on_start, "on_complete": r.on_complete}
    emit(
        "scan.requirement_changed",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary="Changed the scan needed to start or complete work orders",
        changes={k: [before[k], after[k]] for k in after if before[k] != after[k]},
        org_id=org.id,
    )
    db.session.commit()
    return after


def _needs(org_id: uuid.UUID, wo: Any, column: Any) -> bool:
    from mpro.procedures.models import ProcedureRun

    return (
        db.session.scalar(
            select(func.count())
            .select_from(ScanRequirement)
            .join(ProcedureRun, ProcedureRun.procedure_id == ScanRequirement.procedure_id)
            .where(ScanRequirement.org_id == org_id, ProcedureRun.work_order_id == wo.id, column.is_(True))
        )
        or 0
    ) > 0


def _scan_problem(org: Organization, m: Membership, wo: Any, verb: str) -> str | None:
    targets = _wo_targets(wo)
    window = timedelta(minutes=int(settings(org.id)["require_window_minutes"]))
    since = utcnow() - window
    # only a scan of a real code on the record counts, and only by the server's clock: a manual check-in or a
    # phone's clock can't stand in for being there (0.6.0 review M4). Codes are only ever linked to their own record.
    linked = select(QrCode.id).where(
        QrCode.org_id == org.id,
        QrCode.id == ScanEvent.code_id,
        QrCode.entity_type == ScanEvent.entity_type,
        QrCode.entity_id == ScanEvent.entity_id,
    )
    hit = db.session.scalar(
        select(ScanEvent.id)
        .where(
            ScanEvent.org_id == org.id,
            ScanEvent.user_id == m.user_id,
            ScanEvent.code_id.is_not(None),
            linked.exists(),
            ScanEvent.created_at >= since,
            or_(_target_clause(targets), ScanEvent.work_order_id == wo.id),
        )
        .limit(1)
    )
    if hit is not None:
        return None
    names = [qsvc._targets[et].label(rec) for et, eid in targets[1:] if (rec := _get(et, eid)) is not None]
    where = " or ".join(names) if names else "this work order"
    return f"Scan the QR code on {where} to {verb} this work order."


def _get(et: str, eid: uuid.UUID) -> Any:
    t = qsvc._targets.get(et)
    rec = db.session.get(t.model, eid) if t else None
    return None if rec is None or getattr(rec, "deleted_at", None) is not None else rec


def start_check(org: Organization, m: Membership, wo: Any) -> str | None:
    if not _needs(org.id, wo, ScanRequirement.on_start):
        return None
    return _scan_problem(org, m, wo, "start")


def completion_check(org: Organization, m: Membership, wo: Any) -> str | None:
    if not _needs(org.id, wo, ScanRequirement.on_complete):
        return None
    return _scan_problem(org, m, wo, "complete")


def register_hooks() -> None:
    from mpro.workorders import services as wo_svc

    if start_check not in wo_svc.START_CHECKS:
        wo_svc.START_CHECKS.append(start_check)
    if completion_check not in wo_svc.COMPLETION_CHECKS:
        wo_svc.COMPLETION_CHECKS.append(completion_check)


# ---- public scans (signed out) --------------------------------------------------------------------------------------
def _ip_hash(ip: str) -> str:
    secret = str(current_app.config.get("SECRET_KEY") or "")
    return hashlib.sha256(f"{secret}:{ip}".encode()).hexdigest()


def _throttle(ip: str, ok: bool | None) -> None:
    from mpro.core.ratelimit import ip_key

    h, now = _ip_hash(ip_key(ip)), utcnow()
    per_min = (
        db.session.scalar(
            select(func.count())
            .select_from(PublicScanHit)
            .where(PublicScanHit.ip_hash == h, PublicScanHit.at >= now - timedelta(minutes=1))
        )
        or 0
    )
    failed = (
        db.session.scalar(
            select(func.count())
            .select_from(PublicScanHit)
            .where(
                PublicScanHit.ip_hash == h,
                PublicScanHit.ok.is_(False),
                PublicScanHit.at >= now - timedelta(minutes=15),
            )
        )
        or 0
    )
    if per_min >= PUBLIC_PER_MINUTE or failed >= PUBLIC_FAILED_15MIN:
        raise RuleError("Too many scans. Wait a few minutes and try again.", 429)
    if ok is not None:
        db.session.add(PublicScanHit(ip_hash=h, ok=ok, at=now))
        db.session.execute(delete(PublicScanHit).where(PublicScanHit.at < now - timedelta(days=1)))
        db.session.commit()


NOT_AVAILABLE = "This code can't be used without signing in."


def public_scan(code: str, ip: str) -> dict[str, Any]:
    """What a signed-out phone sees after scanning a printed MPro label: only the way to report a problem."""
    _throttle(ip, None)
    value = (code or "").strip().upper()[:20]
    codes = (
        db.session.scalars(
            select(QrCode).where(QrCode.value == value, QrCode.kind == "mpro", QrCode.retired_at.is_(None)).limit(2)
        ).all()
        if value.isalnum() and 6 <= len(value) <= 20
        else []
    )
    c = codes[0] if len(codes) == 1 else None
    rec, org = None, None
    if c is not None and c.entity_id and c.entity_type in ("asset", "location"):
        s = settings(c.org_id)
        if s["public_scans"] and c.entity_type in s["public_types"]:
            rec = _get(c.entity_type, c.entity_id)
            org = db.session.get(Organization, c.org_id)
    if c is None or rec is None or org is None or rec.org_id != c.org_id:
        _throttle(ip, False)
        raise RuleError(NOT_AVAILABLE, 404)
    url = None
    for fn in PUBLIC_REQUEST_URL:
        try:
            url = fn(org.id, str(c.entity_type), rec.id)
        except Exception:  # noqa: BLE001 - another module's URL builder must not break scanning
            current_app.logger.exception("public request URL builder failed")
            url = None
        if url:
            break
    _record(org.id, None, str(c.entity_type), rec, "scan", code_id=c.id, source="public")
    db.session.commit()
    _throttle(ip, True)
    return {
        "organization": org.name,
        "entity_type": c.entity_type,
        "label": qsvc._targets[str(c.entity_type)].label(rec),
        "request_url": url,
    }
