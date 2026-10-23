"""Parts & inventory business rules (0.5.0, MP-039–041).

Every stock change goes through `mpro.parts.ledger.record()`. This module adds the catalogue (parts, types, links to
assets, teams and vendors, per-location stock settings), the stock actions people take (restock, adjust, transfer),
low-stock detection and alerts, parts on work orders with statuses and availability, and saved filter presets.
Cycle counts live in `mpro.parts.counts`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select

from mpro.core.events import emit
from mpro.core.hooks import run_hooks
from mpro.core.models import utcnow
from mpro.core.permissions import can
from mpro.core.settings import get_settings, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import RuleError
from mpro.parts import hooks
from mpro.parts.ledger import ZERO, dec, record, transfer
from mpro.parts.models import (
    RESERVATION_STATUSES,
    InventoryTransaction,
    Part,
    PartAsset,
    PartStock,
    PartTeam,
    PartType,
    PartTypeLink,
    PartVendor,
    WorkOrderPart,
)
from mpro.parts.settings import DEFAULTS as SETTING_DEFAULTS
from mpro.workorders.models import SavedView, WorkOrder

HELD = ("reserved", "kitted", "staged")  # count against availability (r220)
STATUS_LABELS = {
    "assigned": "Assigned",
    "reserved": "Reserved",
    "kitted": "Kitted",
    "staged": "Staged",
    "issued": "Issued",
    "released": "Released",
}
REQUIRABLE = (
    "description",
    "unit_cost",
    "area",
    "min_qty",
    "max_qty",
    "lead_time_days",
    "barcode",
    "part_types",
    "teams",
    "assets",
    "vendors",
    "part_number",
)


# ---------------------------------------------------------------- helpers
def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (TypeError, ValueError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _opt_dec(v: Any, field: str, *, min_zero: bool = True) -> Decimal | None:
    if v in (None, ""):
        return None
    d = dec(v, field)
    if min_zero and d < ZERO:
        raise RuleError(f"{field.capitalize()} can't be negative.", 422)
    if abs(d) >= Decimal("1e13"):
        raise RuleError(f"{field.capitalize()} is too large.", 422)
    return d


def settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "parts")


def get_part(org_id: uuid.UUID, pid: Any, include_deleted: bool = False) -> Part:
    p = db.session.get(Part, _uuid(pid, "part"))
    if p is None or p.org_id != org_id or (p.deleted_at is not None and not include_deleted):
        raise RuleError("That part doesn't exist.", 404 if include_deleted else 422)
    return p


def _location(org_id: uuid.UUID, lid: Any) -> uuid.UUID | None:
    if lid in (None, "", "none"):
        return None
    from mpro.assets.services import get_location

    return get_location(org_id, lid).id


def _check_ids(org_id: uuid.UUID, model: Any, ids: Any, what: str) -> list[uuid.UUID]:
    if ids is None:
        return []
    if not isinstance(ids, list) or len(ids) > 500:
        raise RuleError(f"{what.capitalize()}s must be a list.", 422)
    uids = list(dict.fromkeys(_uuid(i, what) for i in ids))
    if not uids:
        return []
    q = select(model.id).where(model.org_id == org_id, model.id.in_(uids))
    if hasattr(model, "deleted_at"):
        q = q.where(model.deleted_at.is_(None))
    found = set(db.session.scalars(q).all())
    if len(found) != len(uids):
        raise RuleError(f"One of the {what}s doesn't exist.", 422)
    return uids


def label(p: Part) -> str:
    return f"{p.name} ({p.part_number})" if p.part_number else p.name


# ---------------------------------------------------------------- settings
def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in SETTING_DEFAULTS:
            raise RuleError(f"Unknown setting: {k}.", 422)
        default = SETTING_DEFAULTS[k]
        if isinstance(default, bool):
            clean[k] = bool(v)
        elif k == "restock_trigger":
            if v not in ("in_stock", "available"):
                raise RuleError("Base restocking on in-stock or available quantity.", 422)
            clean[k] = v
        elif k in ("auto_reserve_days", "assigned_window_days"):
            try:
                n = int(v)
            except (TypeError, ValueError) as e:
                raise RuleError("Use a number of days.", 422) from e
            if not 0 <= n <= 365:
                raise RuleError("Use 0 to 365 days.", 422)
            clean[k] = n
        elif k == "required_fields":
            if not isinstance(v, list) or any(x not in REQUIRABLE for x in v):
                raise RuleError("Pick required fields from the list.", 422)
            clean[k] = list(dict.fromkeys(v))
        elif k == "escalation_team_ids":
            clean[k] = [str(x) for x in _check_ids(org.id, Team, v, "team")]
    before = settings(org.id)
    out = save_settings(org.id, "parts", clean)
    emit(
        "parts.settings_changed",
        entity_type="organization",
        entity_id=org.id,
        entity_label=org.name,
        summary="Changed parts and inventory settings",
        changes={k: (before.get(k), out.get(k)) for k in clean if before.get(k) != out.get(k)},
        org_id=org.id,
    )
    db.session.commit()
    return out


# ---------------------------------------------------------------- part types (r240)
def save_type(org: Organization, data: dict[str, Any], t: PartType | None = None) -> PartType:
    name = str(data.get("name", t.name if t else "")).strip()
    if not name:
        raise RuleError("The part type needs a name.", 422)
    dup = db.session.scalar(
        select(PartType.id).where(
            PartType.org_id == org.id,
            PartType.deleted_at.is_(None),
            func.lower(PartType.name) == name.lower(),
            PartType.id != (t.id if t else uuid.uuid4()),
        )
    )
    if dup:
        raise RuleError(f"There's already a part type called {name}.", 409)
    created = t is None
    if t is None:
        t = PartType(org_id=org.id)
        db.session.add(t)
    t.name = name[:80]
    if "color" in data:
        color = str(data["color"] or "")
        import re

        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise RuleError("Pick a colour.", 422)
        t.color = color
    if "critical" in data:
        t.critical = bool(data["critical"])
    db.session.flush()
    emit(
        "part_type.created" if created else "part_type.updated",
        entity_type="part_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=("Created" if created else "Changed") + f" part type {t.name}",
        org_id=org.id,
    )
    db.session.commit()
    return t


def delete_type(org: Organization, t: PartType) -> None:
    t.deleted_at = utcnow()
    for link in db.session.scalars(select(PartTypeLink).where(PartTypeLink.type_id == t.id)).all():
        db.session.delete(link)
    emit(
        "part_type.deleted",
        entity_type="part_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Deleted part type {t.name}",
        org_id=org.id,
    )
    db.session.commit()


# ---------------------------------------------------------------- parts (r214)
EDITABLE_TEXT = {
    "name": 255,
    "part_number": 120,
    "description": 20000,
    "unit": 30,
    "barcode": 200,
    "manufacturer": 200,
    "mpn": 120,
}


def duplicates(
    org_id: uuid.UUID, name: str = "", vendor_part_number: str = "", barcode: str = "", exclude: uuid.UUID | None = None
) -> list[Part]:
    """Parts that look like the same one (r237): same name, vendor part number or barcode."""
    conds = []
    if name.strip():
        conds.append(func.lower(Part.name) == name.strip().lower())
    if barcode.strip():
        conds.append(func.lower(Part.barcode) == barcode.strip().lower())
    if vendor_part_number.strip():
        conds.append(
            Part.id.in_(
                select(PartVendor.part_id).where(
                    PartVendor.org_id == org_id,
                    func.lower(PartVendor.vendor_part_number) == vendor_part_number.strip().lower(),
                )
            )
        )
    if not conds:
        return []
    q = select(Part).where(Part.org_id == org_id, Part.deleted_at.is_(None), or_(*conds))
    if exclude is not None:
        q = q.where(Part.id != exclude)
    return list(db.session.scalars(q.limit(10)).all())


def _apply_fields(org: Organization, p: Part, data: dict[str, Any]) -> dict[str, tuple[Any, Any]]:
    from mpro.workorders.services import _clean_custom

    changes: dict[str, tuple[Any, Any]] = {}
    for k, n in EDITABLE_TEXT.items():
        if k in data:
            v = str(data[k] or "").strip()
            if k == "name" and not v:
                raise RuleError("The part needs a name.", 422)
            if len(v) > n:
                raise RuleError(f"{k.replace('_', ' ').capitalize()} is too long.", 422)
            if k == "unit" and not v:
                v = "each"
            if getattr(p, k) != v:
                changes[k] = (getattr(p, k), v)
                setattr(p, k, v)
    if "unit_cost" in data:
        cost = _opt_dec(data["unit_cost"], "unit cost") or ZERO
        if p.unit_cost != cost:
            changes["unit_cost"] = (p.unit_cost, cost)
            p.unit_cost = cost
    if "lead_time_days" in data:
        raw = data["lead_time_days"]
        days: int | None = None
        if raw not in (None, ""):
            try:
                days = int(raw)
            except (TypeError, ValueError) as e:
                raise RuleError("Lead time must be a number of days.", 422) from e
            if not 0 <= days <= 3650:
                raise RuleError("Lead time must be 0 to 3,650 days.", 422)
        if p.lead_time_days != days:
            changes["lead_time_days"] = (p.lead_time_days, days)
            p.lead_time_days = days
    if "non_stock" in data:
        ns = bool(data["non_stock"])
        if ns and not p.non_stock and p.id and (p.on_hand or ZERO) != ZERO:
            raise RuleError("Use up or adjust the stock to 0 before making this a non-stock part.", 422)
        if p.non_stock != ns:
            changes["non_stock"] = (p.non_stock, ns)
            p.non_stock = ns
    if "picture_file_id" in data:
        fid = data["picture_file_id"]
        if fid:
            from mpro.core.files import FileObject

            f = db.session.get(FileObject, _uuid(fid, "picture"))
            if f is None or f.org_id != org.id or f.deleted_at is not None:
                raise RuleError("That picture doesn't exist.", 422)
            p.picture_file_id = f.id
        else:
            p.picture_file_id = None
    if "custom" in data:
        if not isinstance(data["custom"], dict):
            raise RuleError("Custom fields must be an object.", 422)
        p.custom = _clean_custom(org.id, data["custom"], p.custom or {}, "part")
    return changes


def _sync_links(org_id: uuid.UUID, model: Any, part_id: uuid.UUID, col: str, ids: list[uuid.UUID]) -> None:
    have = {getattr(x, col): x for x in db.session.scalars(select(model).where(model.part_id == part_id)).all()}
    for k, row in have.items():
        if k not in ids:
            db.session.delete(row)
    for i in ids:
        if i not in have:
            db.session.add(model(org_id=org_id, part_id=part_id, **{col: i}))


def _set_vendors(org_id: uuid.UUID, p: Part, rows: Any) -> None:
    from mpro.vendors.models import Vendor

    if not isinstance(rows, list) or len(rows) > 50:
        raise RuleError("Vendors must be a list.", 422)
    ids = _check_ids(org_id, Vendor, [r.get("vendor_id") if isinstance(r, dict) else None for r in rows], "vendor")
    have = {x.vendor_id: x for x in db.session.scalars(select(PartVendor).where(PartVendor.part_id == p.id)).all()}
    preferred_seen = False
    for vid, r in zip(ids, rows, strict=True):
        pv = have.pop(vid, None) or PartVendor(org_id=org_id, part_id=p.id, vendor_id=vid)
        db.session.add(pv)
        pv.vendor_part_number = str(r.get("vendor_part_number") or "").strip()[:120]
        if "unit_cost" in r:
            pv.unit_cost = _opt_dec(r.get("unit_cost"), "vendor unit cost")
        if "lead_time_days" in r:
            lt = r.get("lead_time_days")
            pv.lead_time_days = int(lt) if lt not in (None, "") and str(lt).isdigit() else None
        pv.preferred = bool(r.get("preferred")) and not preferred_seen
        preferred_seen = preferred_seen or pv.preferred
    for old in have.values():
        db.session.delete(old)


def _check_required(org_id: uuid.UUID, p: Part, data: dict[str, Any], creating: bool) -> None:
    req = settings(org_id)["required_fields"]
    if not req:
        return
    missing = []
    for f in req:
        if f in ("description", "barcode", "part_number"):
            if not getattr(p, f):
                missing.append(f.replace("_", " "))
        elif f == "unit_cost":
            if not p.unit_cost:
                missing.append("unit cost")
        elif f == "lead_time_days":
            if p.lead_time_days is None:
                missing.append("lead time")
        elif f in ("part_types", "teams", "assets", "vendors"):
            model: Any = {"part_types": PartTypeLink, "teams": PartTeam, "assets": PartAsset, "vendors": PartVendor}[f]
            key = {"part_types": "type_ids", "teams": "team_ids", "assets": "asset_ids", "vendors": "vendors"}[f]
            if key in data:
                if not data[key]:
                    missing.append(f.replace("_", " "))
            elif creating or not db.session.scalar(
                select(func.count()).select_from(model).where(model.part_id == p.id)
            ):
                missing.append(f.replace("_", " "))
        elif f in ("area", "min_qty", "max_qty"):
            rows = data.get("stock")
            if rows is not None:
                if not rows or any(isinstance(r, dict) and r.get(f) in (None, "") for r in rows):
                    missing.append({"area": "area", "min_qty": "minimum quantity", "max_qty": "maximum quantity"}[f])
            elif creating:
                missing.append({"area": "area", "min_qty": "minimum quantity", "max_qty": "maximum quantity"}[f])
    if missing:
        raise RuleError("Fill in the required fields: " + ", ".join(missing) + ".", 422)


def create_part(org: Organization, m: Membership, data: dict[str, Any]) -> Part:
    p = Part(
        org_id=org.id, created_by_id=m.user_id, unit="each", unit_cost=ZERO, on_hand=ZERO, reserved=ZERO, ordered=ZERO
    )
    db.session.add(p)
    _apply_fields(org, p, {"name": data.get("name", ""), **data})
    db.session.flush()
    _apply_links(org, p, data)
    _check_required(org.id, p, data, True)
    emit(
        "part.created",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary=f"Created part {p.name}",
        org_id=org.id,
    )
    for row in data.get("stock") or []:
        set_stock_location(org, m, p, row, commit=False, emit_event=False)
    db.session.commit()
    return p


def _apply_links(org: Organization, p: Part, data: dict[str, Any]) -> None:
    from mpro.assets.models import Asset

    if "type_ids" in data:
        _sync_links(org.id, PartTypeLink, p.id, "type_id", _check_ids(org.id, PartType, data["type_ids"], "part type"))
    if "team_ids" in data:
        _sync_links(org.id, PartTeam, p.id, "team_id", _check_ids(org.id, Team, data["team_ids"], "team"))
    if "asset_ids" in data:
        _sync_links(org.id, PartAsset, p.id, "asset_id", _check_ids(org.id, Asset, data["asset_ids"], "asset"))
    if "vendors" in data:
        _set_vendors(org.id, p, data["vendors"])


def update_part(org: Organization, m: Membership, p: Part, data: dict[str, Any], version: int | None = None) -> Part:
    if p.deleted_at is not None:
        raise RuleError("Restore the part before changing it.", 409)
    if version is not None and version != p.version:
        raise RuleError("Someone else changed this part. Reload to see their changes.", 409)
    changes = _apply_fields(org, p, data)
    _apply_links(org, p, data)
    _check_required(org.id, p, data, False)
    p.version += 1
    p.updated_at = utcnow()
    emit(
        "part.updated",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary=f"Changed {p.name}",
        changes=changes,
        org_id=org.id,
    )
    db.session.commit()
    return p


def delete_part(org: Organization, p: Part) -> None:
    open_uses = db.session.scalar(
        select(func.count())
        .select_from(WorkOrderPart)
        .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
        .where(
            WorkOrderPart.part_id == p.id,
            WorkOrderPart.status.in_(HELD),
            WorkOrder.status.not_in(("done", "canceled")),
            WorkOrder.deleted_at.is_(None),
        )
    )
    if open_uses:
        raise RuleError("This part is reserved on open work orders. Release it there first.", 409)
    p.deleted_at = utcnow()
    emit(
        "part.deleted",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary=f"Deleted part {p.name}",
        org_id=org.id,
    )
    db.session.commit()


def restore_part(org: Organization, p: Part) -> None:
    p.deleted_at = None
    emit(
        "part.restored",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary=f"Restored {p.name}",
        org_id=org.id,
    )
    db.session.commit()


# ---------------------------------------------------------------- stock settings per location (r218)
def _stock_row(org_id: uuid.UUID, part_id: uuid.UUID, location_id: uuid.UUID | None) -> PartStock | None:
    return db.session.scalars(
        select(PartStock).where(
            PartStock.org_id == org_id,
            PartStock.part_id == part_id,
            PartStock.location_id.is_(None) if location_id is None else PartStock.location_id == location_id,
        )
    ).first()


def set_stock_location(
    org: Organization, m: Membership, p: Part, data: dict[str, Any], *, commit: bool = True, emit_event: bool = True
) -> PartStock:
    """Add or change a stocking location: area/bin, min, max; `initial_quantity` sets opening stock."""
    if not isinstance(data, dict):
        raise RuleError("Each stock location must be an object.", 422)
    if p.non_stock:
        raise RuleError(f"{p.name} is a non-stock part, so it has no stock locations.", 422)
    loc = _location(org.id, data.get("location_id"))
    st = _stock_row(org.id, p.id, loc)
    if st is None:
        st = PartStock(org_id=org.id, part_id=p.id, location_id=loc, on_hand=ZERO, reserved=ZERO)
        db.session.add(st)
    if "area" in data:
        st.area = str(data.get("area") or "").strip()[:120]
    if "min_qty" in data:
        st.min_qty = _opt_dec(data.get("min_qty"), "minimum quantity")
    if "max_qty" in data:
        st.max_qty = _opt_dec(data.get("max_qty"), "maximum quantity")
    if st.min_qty is not None and st.max_qty is not None and st.max_qty < st.min_qty:
        raise RuleError("The maximum quantity can't be below the minimum.", 422)
    db.session.flush()
    initial = _opt_dec(data.get("initial_quantity"), "quantity")
    if initial:
        record(org.id, p.id, loc, "initial", initial, user_id=m.user_id, note="Opening stock")
    if emit_event:
        emit(
            "part.stock_location_saved",
            entity_type="part",
            entity_id=p.id,
            entity_label=label(p),
            summary="Changed stock settings" + (f" ({st.area})" if st.area else ""),
            org_id=org.id,
        )
    check_low_stock(org.id, p, st)
    if commit:
        db.session.commit()
    return st


def remove_stock_location(org: Organization, m: Membership, p: Part, location_id: Any) -> None:
    loc = _location(org.id, location_id)
    st = _stock_row(org.id, p.id, loc)
    if st is None:
        raise RuleError("This part isn't stocked there.", 404)
    if (st.on_hand or ZERO) != ZERO or (st.reserved or ZERO) != ZERO:
        raise RuleError("Move or adjust the stock to 0 before removing this location.", 409)
    db.session.delete(st)
    emit(
        "part.stock_location_removed",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary="Removed a stock location",
        org_id=org.id,
    )
    db.session.commit()


# ---------------------------------------------------------------- stock actions (r242)
def _files(org_id: uuid.UUID, ids: Any) -> list[str]:
    if not ids:
        return []
    from mpro.core.files import FileObject

    return [str(i) for i in _check_ids(org_id, FileObject, ids, "file")]


def _after_change(org_id: uuid.UUID, p: Part, location_id: uuid.UUID | None) -> None:
    st = _stock_row(org_id, p.id, location_id)
    if st is not None:
        check_low_stock(org_id, p, st)


def restock(org: Organization, m: Membership, p: Part, data: dict[str, Any]) -> InventoryTransaction:
    qty = dec(data.get("quantity"), "quantity")
    if qty <= ZERO:
        raise RuleError("Restock with a positive quantity.", 422)
    loc = _location(org.id, data.get("location_id"))
    cost = _opt_dec(data.get("unit_cost"), "unit cost")
    txn = record(
        org.id,
        p.id,
        loc,
        "restock",
        qty,
        unit_cost=cost,
        note=str(data.get("note") or ""),
        file_ids=_files(org.id, data.get("file_ids")),
        user_id=m.user_id,
        update_average_cost=bool(settings(org.id)["moving_average_cost"]),
    )
    _after_change(org.id, p, loc)
    db.session.commit()
    return txn


def adjust(org: Organization, m: Membership, p: Part, data: dict[str, Any]) -> InventoryTransaction:
    """{location_id, quantity: the new count} or {change: +/-n}, note."""
    loc = _location(org.id, data.get("location_id"))
    if "quantity" in data and data["quantity"] not in (None, ""):
        target = dec(data["quantity"], "quantity")
        if target < ZERO:
            raise RuleError("The count can't be below 0.", 422)
        st = _stock_row(org.id, p.id, loc)
        change = target - (st.on_hand if st else ZERO)
    else:
        change = dec(data.get("change"), "change")
    if change == ZERO:
        raise RuleError("That's already the quantity in stock.", 422)
    txn = record(
        org.id,
        p.id,
        loc,
        "adjust",
        change,
        note=str(data.get("note") or ""),
        file_ids=_files(org.id, data.get("file_ids")),
        user_id=m.user_id,
        allow_negative=bool(settings(org.id)["allow_negative_stock"]),
    )
    _after_change(org.id, p, loc)
    db.session.commit()
    return txn


def move(org: Organization, m: Membership, p: Part, data: dict[str, Any]) -> None:
    src, dst = _location(org.id, data.get("from_location_id")), _location(org.id, data.get("to_location_id"))
    transfer(
        org.id,
        p.id,
        src,
        dst,
        dec(data.get("quantity"), "quantity"),
        note=str(data.get("note") or ""),
        user_id=m.user_id,
        allow_negative=bool(settings(org.id)["allow_negative_stock"]),
    )
    _after_change(org.id, p, src)
    _after_change(org.id, p, dst)
    db.session.commit()


# ---------------------------------------------------------------- low stock (r216, r241)
def stock_level(org_id: uuid.UUID, st: PartStock) -> Decimal:
    """What counts against the minimum: in stock, or available (in stock − held), per settings."""
    if settings(org_id)["restock_trigger"] == "available":
        return (st.on_hand or ZERO) - (st.reserved or ZERO)
    return st.on_hand or ZERO


def needs_restock(org_id: uuid.UUID, st: PartStock, trigger: str | None = None) -> bool:
    if st.min_qty is None:
        return False
    trig = trigger or settings(org_id)["restock_trigger"]
    level = (st.on_hand or ZERO) - (st.reserved or ZERO) if trig == "available" else (st.on_hand or ZERO)
    return level < st.min_qty


def check_low_stock(org_id: uuid.UUID, p: Part, st: PartStock) -> bool:
    """Alert once when a location drops below its minimum; re-arm when it's back at or above it."""
    if p.non_stock or p.deleted_at is not None:
        return False
    low = needs_restock(org_id, st)
    if not low:
        st.low_alerted_at = None
        return False
    if st.low_alerted_at is not None:
        return True
    st.low_alerted_at = utcnow()
    emit(
        "part.low_stock",
        entity_type="part",
        entity_id=p.id,
        entity_label=label(p),
        summary=f"Below minimum: {_q(stock_level(org_id, st))} of {_q(st.min_qty or ZERO)} {p.unit}",
        data={
            "location_id": str(st.location_id) if st.location_id else None,
            "on_hand": str(st.on_hand),
            "min_qty": str(st.min_qty),
        },
        org_id=org_id,
    )
    run_hooks(hooks.LOW_STOCK_HOOKS, org_id, p, st, what="Low stock hook")
    if is_critical(p):
        _escalate(org_id, p, st)
    return True


def is_critical(p: Part) -> bool:
    return bool(
        db.session.scalar(
            select(func.count())
            .select_from(PartTypeLink)
            .join(PartType, PartType.id == PartTypeLink.type_id)
            .where(PartTypeLink.part_id == p.id, PartType.critical.is_(True), PartType.deleted_at.is_(None))
        )
    )


def _escalate(org_id: uuid.UUID, p: Part, st: PartStock) -> None:
    """Email the escalation teams when a Critical part runs low (r216)."""
    from flask import current_app

    from mpro.auth.models import User
    from mpro.core.mail import send_email

    team_ids = [uuid.UUID(t) for t in settings(org_id)["escalation_team_ids"]]
    if not team_ids:
        return
    emails = db.session.scalars(
        select(User.email)
        .join(TeamMember, TeamMember.user_id == User.id)
        .join(Membership, (Membership.user_id == User.id) & (Membership.org_id == org_id))
        .where(TeamMember.team_id.in_(team_ids), Membership.deleted_at.is_(None))
        .distinct()
    ).all()
    loc = _loc_name(st.location_id)
    url = current_app.config["MPRO_BASE_URL"].rstrip("/") + f"/parts/{p.id}"
    for e in emails:
        send_email(
            e,
            f"Critical part running low: {p.name}",
            f"{p.name}{f' ({p.part_number})' if p.part_number else ''} is below its minimum"
            f"{f' at {loc}' if loc else ''}: {_q(stock_level(org_id, st))} {p.unit} left, minimum "
            f"{_q(st.min_qty or ZERO)}.\n\nOpen the part: {url}\n",
            org_id=org_id,
        )


def _loc_name(lid: uuid.UUID | None) -> str:
    if lid is None:
        return ""
    from mpro.assets.models import Location

    loc = db.session.get(Location, lid)
    return loc.name if loc else ""


def _q(d: Decimal) -> str:
    return format(d.normalize(), "f") if d != d.to_integral() else str(int(d))


def restock_quantity(st: PartStock) -> Decimal:
    """Suggested order quantity: up to max, else up to min (r217)."""
    target = st.max_qty if st.max_qty is not None else st.min_qty
    if target is None:
        return ZERO
    return max(ZERO, target - (st.on_hand or ZERO))


# ---------------------------------------------------------------- parts on work orders (r029, r219, r220, r239)
def _held_sum(org_id: uuid.UUID, part_id: uuid.UUID, location_id: uuid.UUID | None) -> Decimal:
    rows = db.session.execute(
        select(WorkOrderPart.quantity, WorkOrderPart.used)
        .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
        .where(
            WorkOrderPart.org_id == org_id,
            WorkOrderPart.part_id == part_id,
            WorkOrderPart.location_id.is_(None) if location_id is None else WorkOrderPart.location_id == location_id,
            WorkOrderPart.status.in_(HELD),
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.not_in(("done", "canceled")),
        )
    ).all()
    return sum((max(ZERO, (q or ZERO) - (u or ZERO)) for q, u in rows), ZERO)


def refresh_reserved(org_id: uuid.UUID, part_id: uuid.UUID, location_id: uuid.UUID | None) -> None:
    """Recompute the held quantity for a part at a location from its work-order lines (locks the stock row)."""
    from mpro.parts.ledger import lock_part, lock_stock

    part = lock_part(org_id, part_id)
    if part.non_stock:
        return
    st = lock_stock(org_id, part_id, location_id)
    st.reserved = _held_sum(org_id, part_id, location_id)
    db.session.flush()
    part.reserved = (
        db.session.scalar(
            select(func.coalesce(func.sum(PartStock.reserved), 0)).where(
                PartStock.org_id == org_id, PartStock.part_id == part_id
            )
        )
        or ZERO
    )
    check_low_stock(org_id, part, st)


def _wo_label(wo: WorkOrder) -> str:
    return f"#{wo.number} {wo.title}"


def add_to_work_order(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> WorkOrderPart:
    """{part_id, quantity, location_id, status (default issued = used now), unit_cost_override, note}"""
    p = get_part(org.id, data.get("part_id"))
    qty = dec(data.get("quantity", 1), "quantity")
    if qty <= ZERO:
        raise RuleError("Use a positive quantity.", 422)
    loc = _location(org.id, data.get("location_id")) if "location_id" in data else _default_location(org.id, p, wo)
    status = str(data.get("status") or "issued")
    if status not in RESERVATION_STATUSES or status == "released":
        raise RuleError("Unknown part status.", 422)
    wp = WorkOrderPart(
        org_id=org.id,
        work_order_id=wo.id,
        part_id=p.id,
        location_id=loc,
        quantity=qty,
        used=ZERO,
        status="assigned",
        added_by_id=m.user_id,
        unit_cost_override=_opt_dec(data.get("unit_cost_override"), "unit cost"),
        note=str(data.get("note") or "")[:500],
    )
    db.session.add(wp)
    db.session.flush()
    emit(
        "wo.part_added",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=_wo_label(wo),
        summary=f"Added {_q(qty)} {p.unit} of {p.name}",
        data={"part_id": p.id, "work_order_part_id": wp.id},
        org_id=org.id,
    )
    _set_status(org, m, wo, wp, p, status)
    db.session.commit()
    return wp


def _default_location(org_id: uuid.UUID, p: Part, wo: WorkOrder) -> uuid.UUID | None:
    """Where the part comes from: the work order's location if it's stocked there, else where most stock is."""
    rows = db.session.scalars(
        select(PartStock)
        .where(PartStock.org_id == org_id, PartStock.part_id == p.id)
        .order_by(PartStock.on_hand.desc())
    ).all()
    for st in rows:
        if wo.location_id is not None and st.location_id == wo.location_id:
            return st.location_id
    return rows[0].location_id if rows else None


def _set_status(org: Organization, m: Membership, wo: WorkOrder, wp: WorkOrderPart, p: Part, status: str) -> None:
    allow_neg = bool(settings(org.id)["allow_negative_stock"])
    if status == "issued":
        remaining = (wp.quantity or ZERO) - (wp.used or ZERO)
        if remaining > ZERO:
            record(
                org.id,
                p.id,
                wp.location_id,
                "use",
                remaining,
                work_order_id=wo.id,
                user_id=m.user_id,
                allow_negative=allow_neg,
                unit_cost=wp.unit_cost_override,
                note=f"Work order #{wo.number}",
            )
            wp.used = wp.quantity
    elif wp.status == "issued" and status != "issued" and (wp.used or ZERO) > ZERO:
        raise RuleError("These parts were already used. Return them first.", 409)
    old = wp.status
    wp.status = status
    db.session.flush()
    if old != status and not p.non_stock:
        refresh_reserved(org.id, p.id, wp.location_id)
    if old != status and status != "issued":
        emit(
            "wo.part_status",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=_wo_label(wo),
            summary=f"{p.name}: {STATUS_LABELS[status]}",
            org_id=org.id,
        )
    if status == "issued" and not p.non_stock:
        _after_change(org.id, p, wp.location_id)


def update_work_order_part(
    org: Organization, m: Membership, wo: WorkOrder, wp: WorkOrderPart, data: dict[str, Any]
) -> WorkOrderPart:
    p = get_part(org.id, wp.part_id, include_deleted=True)
    if "quantity" in data:
        qty = dec(data["quantity"], "quantity")
        if qty <= ZERO:
            raise RuleError("Use a positive quantity.", 422)
        if wp.status == "issued" and qty != wp.quantity:
            diff = qty - (wp.quantity or ZERO)
            if diff > ZERO:  # used more
                record(
                    org.id,
                    p.id,
                    wp.location_id,
                    "use",
                    diff,
                    work_order_id=wo.id,
                    user_id=m.user_id,
                    allow_negative=bool(settings(org.id)["allow_negative_stock"]),
                    unit_cost=wp.unit_cost_override,
                    note=f"Work order #{wo.number}",
                )
            else:  # gave some back
                record(
                    org.id,
                    p.id,
                    wp.location_id,
                    "return",
                    -diff,
                    work_order_id=wo.id,
                    user_id=m.user_id,
                    note=f"Returned from work order #{wo.number}",
                )
            wp.used = qty
            _after_change(org.id, p, wp.location_id)
        wp.quantity = qty
    if "unit_cost_override" in data:
        wp.unit_cost_override = _opt_dec(data["unit_cost_override"], "unit cost")
    if "note" in data:
        wp.note = str(data["note"] or "")[:500]
    if "location_id" in data:
        loc = _location(org.id, data["location_id"])
        if loc != wp.location_id:
            if (wp.used or ZERO) > ZERO:
                raise RuleError("These parts were already taken from a location. Return them first.", 409)
            old = wp.location_id
            wp.location_id = loc
            db.session.flush()
            if not p.non_stock:
                refresh_reserved(org.id, p.id, old)
    if "status" in data:
        st = str(data["status"])
        if st not in RESERVATION_STATUSES:
            raise RuleError("Unknown part status.", 422)
        _set_status(org, m, wo, wp, p, st)
    elif not p.non_stock:
        db.session.flush()
        refresh_reserved(org.id, p.id, wp.location_id)
    emit(
        "wo.part_updated",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=_wo_label(wo),
        summary=f"Changed {p.name}",
        org_id=org.id,
    )
    db.session.commit()
    return wp


def return_parts(org: Organization, m: Membership, wo: WorkOrder, wp: WorkOrderPart, qty_raw: Any) -> WorkOrderPart:
    p = get_part(org.id, wp.part_id, include_deleted=True)
    qty = dec(qty_raw if qty_raw not in (None, "") else wp.used, "quantity")
    if qty <= ZERO or qty > (wp.used or ZERO):
        raise RuleError(f"Return between 1 and {_q(wp.used or ZERO)}.", 422)
    record(
        org.id,
        p.id,
        wp.location_id,
        "return",
        qty,
        work_order_id=wo.id,
        user_id=m.user_id,
        note=f"Returned from work order #{wo.number}",
    )
    wp.used = (wp.used or ZERO) - qty
    if wp.used == ZERO:
        wp.status = "released" if wp.quantity == qty else "assigned"
        if wp.status == "assigned":
            wp.quantity = wp.quantity - qty
    else:
        wp.quantity = wp.used
    _after_change(org.id, p, wp.location_id)
    db.session.commit()
    return wp


def remove_from_work_order(org: Organization, m: Membership, wo: WorkOrder, wp: WorkOrderPart) -> None:
    p = get_part(org.id, wp.part_id, include_deleted=True)
    if (wp.used or ZERO) > ZERO:
        record(
            org.id,
            p.id,
            wp.location_id,
            "return",
            wp.used,
            work_order_id=wo.id,
            user_id=m.user_id,
            note=f"Removed from work order #{wo.number}",
        )
        _after_change(org.id, p, wp.location_id)
    loc = wp.location_id
    db.session.delete(wp)
    db.session.flush()
    if not p.non_stock:
        refresh_reserved(org.id, p.id, loc)
    emit(
        "wo.part_removed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=_wo_label(wo),
        summary=f"Removed {p.name}",
        org_id=org.id,
    )
    db.session.commit()


def availability(org_id: uuid.UUID, wp: WorkOrderPart, p: Part) -> dict[str, Any]:
    """Available / Partial / Unavailable for what this line still needs (r220)."""
    need = max(ZERO, (wp.quantity or ZERO) - (wp.used or ZERO))
    if p.non_stock or wp.status in ("issued", "released") or need == ZERO:
        return {"state": "issued" if wp.status == "issued" else "none", "available": None, "overcommitted": False}
    st = _stock_row(org_id, p.id, wp.location_id)
    on_hand = st.on_hand if st else ZERO
    held = st.reserved if st else ZERO
    # this line's own hold doesn't count against itself
    own = need if wp.status in HELD else ZERO
    avail = (on_hand or ZERO) - (held or ZERO) + own
    state = "available" if avail >= need else "partial" if avail > ZERO else "unavailable"
    demand = _open_demand(org_id, p.id, wp.location_id)
    return {"state": state, "available": str(max(ZERO, avail)), "overcommitted": demand > (on_hand or ZERO)}


def _open_demand(org_id: uuid.UUID, part_id: uuid.UUID, location_id: uuid.UUID | None) -> Decimal:
    rows = db.session.execute(
        select(WorkOrderPart.quantity, WorkOrderPart.used)
        .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
        .where(
            WorkOrderPart.org_id == org_id,
            WorkOrderPart.part_id == part_id,
            WorkOrderPart.location_id.is_(None) if location_id is None else WorkOrderPart.location_id == location_id,
            WorkOrderPart.status.in_(("assigned", *HELD)),
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.not_in(("done", "canceled")),
        )
    ).all()
    return sum((max(ZERO, (q or ZERO) - (u or ZERO)) for q, u in rows), ZERO)


def parts_cost(wo_id: uuid.UUID) -> Decimal:
    """Cost of the parts used on a work order (per-WO override, else the part's unit cost)."""
    rows = db.session.execute(
        select(WorkOrderPart.used, WorkOrderPart.unit_cost_override, Part.unit_cost)
        .join(Part, Part.id == WorkOrderPart.part_id)
        .where(WorkOrderPart.work_order_id == wo_id)
    ).all()
    return sum(((u or ZERO) * (o if o is not None else (c or ZERO)) for u, o, c in rows), ZERO)


# ---------------------------------------------------------------- work-order hooks (r042, r215, create with parts)
def on_wo_status(org: Organization, m: Membership, wo: WorkOrder, from_status: str, to_status: str) -> None:
    """Done issues what's still reserved/kitted/staged (r042) and links used parts to the asset(s) (r215).
    Canceling releases held parts."""
    if to_status == "done":
        for wp in db.session.scalars(
            select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id, WorkOrderPart.status.in_(HELD))
        ).all():
            p = db.session.get(Part, wp.part_id)
            if p is not None:
                _set_status(org, m, wo, wp, p, "issued")
        _auto_link_assets(org.id, wo)
    elif to_status == "canceled":
        for wp in db.session.scalars(
            select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id, WorkOrderPart.status.in_(HELD))
        ).all():
            wp.status = "assigned"
            db.session.flush()
            refresh_reserved(org.id, wp.part_id, wp.location_id)
    elif from_status in ("done", "canceled"):
        for wp in db.session.scalars(
            select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id, WorkOrderPart.status.in_(HELD))
        ).all():
            refresh_reserved(org.id, wp.part_id, wp.location_id)


def _auto_link_assets(org_id: uuid.UUID, wo: WorkOrder) -> None:
    asset_ids: set[uuid.UUID] = set()
    if wo.asset_id:
        asset_ids.add(wo.asset_id)
    try:
        from mpro.workorders.models import WorkOrderAsset

        asset_ids |= set(
            db.session.scalars(select(WorkOrderAsset.asset_id).where(WorkOrderAsset.work_order_id == wo.id)).all()
        )
    except ImportError:  # pragma: no cover
        pass
    if not asset_ids:
        return
    used = set(
        db.session.scalars(
            select(WorkOrderPart.part_id).where(WorkOrderPart.work_order_id == wo.id, WorkOrderPart.used > 0)
        ).all()
    )
    for pid in used:
        have = set(db.session.scalars(select(PartAsset.asset_id).where(PartAsset.part_id == pid)).all())
        for aid in asset_ids - have:
            db.session.add(PartAsset(org_id=org_id, part_id=pid, asset_id=aid, auto=True))
    db.session.flush()


def on_wo_create(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> None:
    """Parts chosen on the new-work-order form: {"parts": [{part_id, quantity, location_id}]} start as Assigned."""
    rows = data.get("parts")
    if not rows:
        return
    if not can(m, "parts.use"):
        raise RuleError("You don't have permission to add parts to work orders.", 403)
    if not isinstance(rows, list) or len(rows) > 100:
        raise RuleError("Parts must be a list.", 422)
    for r in rows:
        if not isinstance(r, dict):
            raise RuleError("Each part must be an object.", 422)
        p = get_part(org.id, r.get("part_id"))
        qty = dec(r.get("quantity", 1), "quantity")
        if qty <= ZERO:
            raise RuleError("Use a positive quantity.", 422)
        loc = _location(org.id, r.get("location_id")) if r.get("location_id") else _default_location(org.id, p, wo)
        db.session.add(
            WorkOrderPart(
                org_id=org.id,
                work_order_id=wo.id,
                part_id=p.id,
                location_id=loc,
                quantity=qty,
                used=ZERO,
                status="assigned",
                added_by_id=m.user_id,
            )
        )
    db.session.flush()


def auto_reserve(now: datetime | None = None) -> int:
    """Reserve Assigned parts on open work orders due within the org's auto-reserve window (r219)."""
    from mpro.core.settings import OrgSetting

    now = now or utcnow()
    n = 0
    org_ids = db.session.scalars(select(OrgSetting.org_id).where(OrgSetting.key == "parts")).all()
    for org_id in org_ids:
        days = int(settings(org_id)["auto_reserve_days"] or 0)
        if days <= 0:
            continue
        rows = db.session.execute(
            select(WorkOrderPart, WorkOrder)
            .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
            .where(
                WorkOrderPart.org_id == org_id,
                WorkOrderPart.status == "assigned",
                WorkOrder.deleted_at.is_(None),
                WorkOrder.status.not_in(("done", "canceled")),
                WorkOrder.due_at.is_not(None),
                WorkOrder.due_at <= now + timedelta(days=days),
            )
        ).all()
        touched: set[tuple[uuid.UUID, uuid.UUID | None]] = set()
        for wp, wo in rows:
            wp.status = "reserved"
            touched.add((wp.part_id, wp.location_id))
            emit(
                "wo.part_status",
                entity_type="work_order",
                entity_id=wo.id,
                entity_label=_wo_label(wo),
                summary="Parts reserved automatically",
                org_id=org_id,
            )
            n += 1
        db.session.flush()
        for pid, loc in touched:
            refresh_reserved(org_id, pid, loc)
        db.session.commit()
    return n


def assigned_in_window(org_id: uuid.UUID, part_id: uuid.UUID) -> Decimal:
    """Quantity Assigned on open work orders due within the assigned window (shown on the part, r219)."""
    days = int(settings(org_id)["assigned_window_days"] or 0)
    q = (
        select(WorkOrderPart.quantity, WorkOrderPart.used)
        .join(WorkOrder, WorkOrder.id == WorkOrderPart.work_order_id)
        .where(
            WorkOrderPart.org_id == org_id,
            WorkOrderPart.part_id == part_id,
            WorkOrderPart.status == "assigned",
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.not_in(("done", "canceled")),
        )
    )
    if days > 0:
        q = q.where(or_(WorkOrder.due_at.is_(None), WorkOrder.due_at <= utcnow() + timedelta(days=days)))
    return sum((max(ZERO, (a or ZERO) - (b or ZERO)) for a, b in db.session.execute(q).all()), ZERO)


# ---------------------------------------------------------------- saved filter presets (r226)
PRESET_KEYS = (
    "q",
    "stock",
    "type_id",
    "location_id",
    "vendor_id",
    "asset_id",
    "team_id",
    "critical",
    "non_stock",
    "sort",
)


def presets_for(m: Membership) -> list[SavedView]:
    return list(
        db.session.scalars(
            select(SavedView)
            .where(
                SavedView.org_id == m.org_id,
                SavedView.entity_type == "part",
                SavedView.deleted_at.is_(None),
                (SavedView.owner_id == m.user_id) | SavedView.owner_id.is_(None),
            )
            .order_by(SavedView.pinned.desc(), func.lower(SavedView.name))
        ).all()
    )


def save_preset(org: Organization, m: Membership, data: dict[str, Any], v: SavedView | None = None) -> SavedView:
    name = str(data.get("name", v.name if v else "")).strip()
    if not name:
        raise RuleError("Give the filter a name.", 422)
    shared = bool(data.get("shared", v.owner_id is None if v else False))
    if shared and not can(m, "views.share"):
        raise RuleError("Only administrators can share filters with the whole organization.", 403)
    if v is not None and (v.owner_id not in (None, m.user_id) or (v.owner_id is None and not can(m, "views.share"))):
        raise RuleError("You can't change this filter.", 403)
    filters = data.get("filters", v.filters if v else {})
    if not isinstance(filters, dict) or any(k not in PRESET_KEYS for k in filters):
        raise RuleError("Unknown filter.", 422)
    if v is None:
        v = SavedView(org_id=org.id, entity_type="part")
        db.session.add(v)
    v.owner_id = None if shared else m.user_id
    v.name = name[:120]
    v.filters = {k: str(val)[:200] for k, val in filters.items() if val not in (None, "")}  # type: ignore[assignment]
    v.pinned = bool(data.get("pinned", v.pinned or False))
    db.session.commit()
    return v


def delete_preset(m: Membership, v: SavedView) -> None:
    if v.owner_id not in (None, m.user_id) or (v.owner_id is None and not can(m, "views.share")):
        raise RuleError("You can't delete this filter.", 403)
    v.deleted_at = utcnow()
    db.session.commit()
