"""Vendors on work orders (0.5.0, roadmap r075): link one or more vendors to a work order."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from mpro.core.events import emit
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.workorders.models import WorkOrder, WorkOrderVendor

MAX_VENDORS = 20


def vendors_of(ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """{work order id: [{id, name, color}]} for lists and details."""
    if not ids:
        return {}
    from mpro.vendors.models import Vendor

    rows = db.session.execute(
        select(WorkOrderVendor.work_order_id, Vendor.id, Vendor.name, Vendor.color)
        .join(Vendor, Vendor.id == WorkOrderVendor.vendor_id)
        .where(WorkOrderVendor.work_order_id.in_(ids), Vendor.deleted_at.is_(None))
        .order_by(Vendor.name)
    ).all()
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for wid, vid, name, color in rows:
        out.setdefault(wid, []).append({"id": str(vid), "name": name, "color": color})
    return out


def _clean(org_id: uuid.UUID, raw: Any) -> list[uuid.UUID]:
    from mpro.vendors.models import Vendor

    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > MAX_VENDORS:
        raise RuleError(f"Link up to {MAX_VENDORS} vendors.", 422)
    out: list[uuid.UUID] = []
    for x in raw:
        vid = x.get("id") if isinstance(x, dict) else x
        try:
            u = uuid.UUID(str(vid))
        except ValueError as e:
            raise RuleError("One of the vendors doesn't exist.", 422) from e
        v = db.session.get(Vendor, u)
        if v is None or v.org_id != org_id or v.deleted_at is not None:
            raise RuleError("One of the vendors doesn't exist.", 422)
        if u not in out:
            out.append(u)
    return out


def set_vendors(org: Organization, m: Membership | None, wo: WorkOrder, raw: Any, emit_event: bool = True) -> bool:
    """Replace the work order's vendors. Returns True when something changed (caller commits)."""
    want = _clean(org.id, raw)
    have = db.session.scalars(select(WorkOrderVendor).where(WorkOrderVendor.work_order_id == wo.id)).all()
    have_ids = {h.vendor_id for h in have}
    if set(want) == have_ids:
        return False
    for h in have:
        if h.vendor_id not in want:
            db.session.delete(h)
    for vid in want:
        if vid not in have_ids:
            db.session.add(WorkOrderVendor(org_id=org.id, work_order_id=wo.id, vendor_id=vid))
    db.session.flush()
    if emit_event:
        names = [v["name"] for v in vendors_of([wo.id]).get(wo.id, [])]
        emit(
            "wo.vendors_changed",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=f"#{wo.number} {wo.title}",
            summary="Vendors: " + (", ".join(names) if names else "none"),
            changes={"vendors": (sorted(str(x) for x in have_ids), sorted(str(x) for x in want))},
            org_id=org.id,
        )
    return True


def _create_hook(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> None:
    if data.get("vendor_ids"):
        set_vendors(org, m, wo, data["vendor_ids"], emit_event=False)


def vendor_filter_ids(vendor_ids: list[uuid.UUID]) -> Any:
    return select(WorkOrderVendor.work_order_id).where(WorkOrderVendor.vendor_id.in_(vendor_ids))


def register() -> None:
    from mpro.workorders.services import CREATE_HOOKS

    if _create_hook not in CREATE_HOOKS:
        CREATE_HOOKS.append(_create_hook)
