"""Purchase orders (0.5.0, MP-042–044; roadmap r227–r232, r249–r259, r268).

Flow (MaintainX):
    requested  — a full user's request; no costs shown to them (r228)
    pending    — waiting for approvers (approval rules, r230, or a budget's approval limit, r268)
    approved / rejected
    partially_fulfilled → complete   — receiving in one or more shipments (r231); stock goes in through the ledger
    canceled   — not once anything has been received (r257)
Overdue is a flag: not complete by the due date (r253).

Other modules call `create_purchase_order(org, member, data)` (suppliers: PunchOut carts, reorders; parts: low stock).
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from dateutil.relativedelta import relativedelta
from sqlalchemy import func, or_, select, update

from mpro.core.events import emit
from mpro.core.hooks import run_hooks
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can, can_on
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, TeamMember
from mpro.orgs.services import RuleError
from mpro.purchasing import approvals
from mpro.purchasing.hooks import EXEMPTION_LOOKUPS, PO_RECEIVED_HOOKS, PO_STATUS_HOOKS
from mpro.purchasing.models import (
    PO_STATUSES,
    Address,
    Approval,
    ApprovalRule,
    Budget,
    PurchaseOrder,
    PurchaseOrderCost,
    PurchaseOrderLine,
    PurchaseOrderReceipt,
    PurchaseOrderReceiptLine,
)
from mpro.vendors.common import (
    count,
    currency,
    day,
    email,
    ids_in_org,
    money,
    num,
    one_in_org,
    page_args,
    text,
    uid,
)
from mpro.vendors.models import Vendor, VendorContact

ZERO = Decimal("0")
CENT = Decimal("0.01")
OPEN = ("requested", "pending", "approved", "partially_fulfilled")
ORDERED = ("approved", "partially_fulfilled")  # counts toward a part's "ordered" quantity
DONE = ("complete", "canceled", "rejected")
STATUS_LABELS = {
    "requested": "Requested",
    "pending": "Pending approval",
    "approved": "Approved",
    "rejected": "Rejected",
    "partially_fulfilled": "Partially fulfilled",
    "complete": "Complete",
    "canceled": "Canceled",
}

register_defaults(
    "purchasing",
    {
        "number_prefix": "PO-",  # r249
        "default_title": "Purchase Order",  # r250
        "default_cc": [],  # always CC'd when a PO is sent to a vendor (r255)
        "single_address": False,  # one shared address for shipping and billing (r252)
        "requests_need_review": True,  # requested POs wait for someone with "Create, edit and send" (r228)
    },
)


def settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "purchasing")


def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    if "number_prefix" in data:
        clean["number_prefix"] = text(data.get("number_prefix"), 12, "Prefix")
    if "default_title" in data:
        clean["default_title"] = text(data.get("default_title"), 120, "Default title") or "Purchase Order"
    if "default_cc" in data:
        raw = data.get("default_cc") or []
        if not isinstance(raw, list) or len(raw) > 20:
            raise RuleError("Up to 20 CC addresses.", 422)
        clean["default_cc"] = [email(x, "CC address") for x in raw if str(x).strip()]
    for k in ("single_address", "requests_need_review"):
        if k in data:
            clean[k] = bool(data.get(k))
    if "next_number" in data:
        set_next_po_number(org, data.get("next_number"))
    out = save_settings(org.id, "purchasing", clean)
    emit(
        "purchasing.settings_updated",
        entity_type="organization",
        entity_id=org.id,
        entity_label=org.name,
        summary="Updated purchase order settings",
        data={"keys": sorted(clean)},
    )
    db.session.commit()
    return {**out, "next_number": peek_next_number(org.id)}


# ================================================================ numbering
def next_counter(org_id: uuid.UUID, key: str, floor: int = 0) -> int:
    """Next number for `key` (purchase_order, quote, customer_invoice…). Row-locked on PostgreSQL."""
    from sqlalchemy.exc import IntegrityError

    from mpro.workorders.models import Counter

    q = select(Counter).where(Counter.org_id == org_id, Counter.key == key)
    if db.engine.dialect.name == "postgresql":
        q = q.with_for_update()
    c = db.session.scalars(q).first()
    if c is None:
        try:
            with db.session.begin_nested():
                db.session.add(Counter(org_id=org_id, key=key, value=floor))
        except IntegrityError:
            pass
        c = db.session.scalars(q).first()
        assert c is not None
    res = db.session.execute(
        update(Counter).where(Counter.id == c.id).values(value=Counter.value + 1).returning(Counter.value)
    )
    return int(res.scalar_one())


def peek_next_number(org_id: uuid.UUID) -> int:
    from mpro.workorders.models import Counter

    c = db.session.scalars(select(Counter).where(Counter.org_id == org_id, Counter.key == "purchase_order")).first()
    if c is not None:
        return int(c.value) + 1
    top = db.session.scalar(select(func.max(PurchaseOrder.number)).where(PurchaseOrder.org_id == org_id)) or 0
    return int(top) + 1


def set_next_po_number(org: Organization, raw: Any) -> int:
    """Starting ID (r249): only upward, above every existing number."""
    from mpro.workorders.models import Counter

    try:
        n = int(raw)
    except (TypeError, ValueError) as e:
        raise RuleError("The next number must be a whole number.", 422) from e
    current = peek_next_number(org.id)
    if n < current:
        raise RuleError(f"The next number must be at least {current}.", 422)
    if n > 10**9:
        raise RuleError("That number is too large.", 422)
    c = db.session.scalars(select(Counter).where(Counter.org_id == org.id, Counter.key == "purchase_order")).first()
    if c is None:
        db.session.add(Counter(org_id=org.id, key="purchase_order", value=n - 1))
    else:
        c.value = n - 1
    return n


def po_number(po: PurchaseOrder, prefix: str | None = None) -> str:
    if po.custom_number:
        return po.custom_number
    if prefix is None:
        prefix = settings(po.org_id)["number_prefix"]
    return f"{prefix}{po.number}"


# ================================================================ helpers
def sees_costs(m: Membership | None) -> bool:
    return m is not None and (can(m, "costs.view") or can(m, "po.manage") or can(m, "po.manage_own"))


def _team_ids(m: Membership) -> set[str]:
    return {
        str(t)
        for t in db.session.scalars(
            select(TeamMember.team_id).where(TeamMember.user_id == m.user_id, TeamMember.org_id == m.org_id)
        )
    }


def get_po(org_id: uuid.UUID, pid: Any, include_deleted: bool = False) -> PurchaseOrder:
    po = db.session.get(PurchaseOrder, uid(pid, "purchase order"))
    if po is None or po.org_id != org_id or (po.deleted_at is not None and not include_deleted):
        raise RuleError("That purchase order doesn't exist.", 404)
    return po


def lock_po(po: PurchaseOrder) -> PurchaseOrder:
    """SELECT … FOR UPDATE the PO and its lines and reload them, so read-modify-write (receive, edit, cancel) works
    on current values. No-op locking on SQLite (writers are serialized there)."""
    db.session.execute(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == po.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    db.session.execute(
        select(PurchaseOrderLine)
        .where(PurchaseOrderLine.purchase_order_id == po.id)
        .order_by(PurchaseOrderLine.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalars().all()
    return po


def status_from_receipts(po: PurchaseOrder) -> str:
    """The status an approved PO has given what arrived: approved, partially fulfilled or complete."""
    lines = lines_of(po)
    if lines and all((ln.received or ZERO) >= ln.quantity for ln in lines):
        return "complete"
    return "partially_fulfilled" if any((ln.received or ZERO) != ZERO for ln in lines) else "approved"


def lines_of(po: PurchaseOrder) -> list[PurchaseOrderLine]:
    return list(
        db.session.scalars(
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.purchase_order_id == po.id)
            .order_by(PurchaseOrderLine.sort, PurchaseOrderLine.created_at)
        )
    )


def costs_of(po: PurchaseOrder) -> list[PurchaseOrderCost]:
    return list(
        db.session.scalars(
            select(PurchaseOrderCost)
            .where(PurchaseOrderCost.purchase_order_id == po.id)
            .order_by(PurchaseOrderCost.sort)
        )
    )


def is_overdue(po: PurchaseOrder, today: date | None = None) -> bool:
    return bool(
        po.due_on
        and po.status in ("requested", "pending", "approved", "partially_fulfilled")
        and po.due_on < (today or date.today())
    )


def _r(d: Decimal) -> Decimal:
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


def compute_totals(lines: list[PurchaseOrderLine], costs: list[PurchaseOrderCost]) -> dict[str, Any]:
    """Subtotal of lines; non-tax costs (fixed, or % of the subtotal); taxes (fixed, or % of the taxable lines plus
    taxable fixed costs such as shipping)."""
    subtotal = _r(sum(((ln.quantity or ZERO) * (ln.unit_cost or ZERO) for ln in lines), ZERO))
    taxable = sum(((ln.quantity or ZERO) * (ln.unit_cost or ZERO) for ln in lines if ln.taxable), ZERO)
    rows = []
    extra = ZERO
    for c in costs:
        if c.is_tax:
            continue
        amt = _r(c.value if c.kind == "fixed" else subtotal * c.value / 100)
        if c.taxable:
            taxable += amt
        extra += amt
        rows.append((c, amt))
    for c in costs:
        if not c.is_tax:
            continue
        amt = _r(c.value if c.kind == "fixed" else taxable * c.value / 100)
        extra += amt
        rows.append((c, amt))
    amounts = {c.id: a for c, a in rows}
    return {"subtotal": subtotal, "extra": _r(extra), "total": _r(subtotal + extra), "amounts": amounts}


def _recalc(po: PurchaseOrder) -> dict[str, Any]:
    t = compute_totals(lines_of(po), costs_of(po))
    po.subtotal, po.extra_total, po.total = t["subtotal"], t["extra"], t["total"]
    return t


def recompute_ordered(org_id: uuid.UUID, part_ids: set[uuid.UUID]) -> None:
    """Part.ordered = what approved POs still expect (r243: floored at 0 when the setting is on)."""
    from mpro.parts.models import Part

    if not part_ids:
        return
    prevent_negative = bool(get_settings(org_id, "parts").get("prevent_negative_ordered", True))
    rows = db.session.execute(
        select(PurchaseOrderLine.part_id, PurchaseOrderLine.quantity, PurchaseOrderLine.received)
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.purchase_order_id)
        .where(
            PurchaseOrderLine.org_id == org_id,
            PurchaseOrderLine.part_id.in_(part_ids),
            PurchaseOrder.status.in_(ORDERED),
            PurchaseOrder.deleted_at.is_(None),
        )
    ).all()
    per: dict[uuid.UUID, Decimal] = {pid: ZERO for pid in part_ids}
    for pid, qty, rec in rows:
        if pid is None:
            continue
        open_qty = (qty or ZERO) - (rec or ZERO)
        per[pid] = per.get(pid, ZERO) + (max(open_qty, ZERO) if prevent_negative else open_qty)
    for pid, q in per.items():
        p = db.session.get(Part, pid)
        if p is not None and p.org_id == org_id:
            p.ordered = max(q, ZERO) if prevent_negative else q


def _part_ids(po: PurchaseOrder) -> set[uuid.UUID]:
    return {ln.part_id for ln in lines_of(po) if ln.part_id}


def _set_status(org_id: uuid.UUID, po: PurchaseOrder, new: str, summary: str = "") -> None:
    old = po.status
    if old == new:
        return
    po.status = new
    now = utcnow()
    if new == "complete":
        po.completed_at = now
    elif old == "complete":
        po.completed_at = None
    if new == "canceled":
        po.canceled_at = now
    emit(
        "purchase_order.status_changed",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary=summary or f"{STATUS_LABELS[old]} → {STATUS_LABELS[new]}",
        changes={"status": (old, new)},
        org_id=org_id,
    )
    recompute_ordered(org_id, _part_ids(po))
    run_hooks(PO_STATUS_HOOKS, org_id, po, old, new, what="purchase order status hook")


# ================================================================ addresses (r252)
ADDR_FIELDS = {
    "label": 120,
    "company": 200,
    "attention": 200,
    "line1": 200,
    "line2": 200,
    "city": 120,
    "region": 120,
    "postal_code": 30,
    "phone": 60,
}


def address_dict(a: Address) -> dict[str, Any]:
    return {
        "id": str(a.id),
        "kind": a.kind,
        **{k: getattr(a, k) for k in ADDR_FIELDS},
        "country": a.country,
        "is_default": a.is_default,
        "location_id": str(a.location_id) if a.location_id else None,
    }


def list_addresses(org_id: uuid.UUID) -> list[dict[str, Any]]:
    return [
        address_dict(a)
        for a in db.session.scalars(
            select(Address)
            .where(Address.org_id == org_id, Address.deleted_at.is_(None))
            .order_by(Address.is_default.desc(), func.lower(Address.label))
        )
    ]


def save_address(org: Organization, data: dict[str, Any], a: Address | None = None) -> Address:
    from mpro.assets.models import Location

    creating = a is None
    if a is None:
        a = Address(org_id=org.id, **{k: "" for k in ADDR_FIELDS}, country="")
        db.session.add(a)
    for k, n in ADDR_FIELDS.items():
        if k in data:
            setattr(a, k, text(data.get(k), n, k.replace("_", " ").capitalize()))
    if "country" in data:
        c = text(data.get("country"), 2, "Country").upper()
        if c and len(c) != 2:
            raise RuleError("Use the two-letter country code (US, CA, GB…).", 422)
        a.country = c
    if "kind" in data or creating:
        k = data.get("kind") or "shipping"
        if k not in ("shipping", "billing", "both"):
            raise RuleError("Address kind must be shipping, billing or both.", 422)
        a.kind = k
    if "location_id" in data:
        loc = one_in_org(Location, org.id, data.get("location_id"), "location")
        a.location_id = loc.id if loc else None
    if not (a.line1 or a.company or a.label):
        raise RuleError("Give the address at least a label or a first line.", 422)
    db.session.flush()
    if data.get("is_default"):
        for other in db.session.scalars(
            select(Address).where(Address.org_id == org.id, Address.id != a.id, Address.is_default.is_(True))
        ):
            if other.kind == a.kind or a.kind == "both" or other.kind == "both":
                other.is_default = False
        a.is_default = True
    elif "is_default" in data:
        a.is_default = False
    emit(
        "address.saved",
        entity_type="address",
        entity_id=a.id,
        entity_label=a.label or a.line1,
        summary="Saved an address",
    )
    db.session.commit()
    return a


def delete_address(org: Organization, a: Address) -> None:
    a.deleted_at = utcnow()
    emit(
        "address.deleted",
        entity_type="address",
        entity_id=a.id,
        entity_label=a.label or a.line1,
        summary="Deleted an address",
    )
    db.session.commit()


def _default_address(org_id: uuid.UUID, kind: str) -> Address | None:
    rows = db.session.scalars(
        select(Address).where(Address.org_id == org_id, Address.deleted_at.is_(None), Address.is_default.is_(True))
    ).all()
    return next((a for a in rows if a.kind == kind), None) or next((a for a in rows if a.kind == "both"), None)


# ================================================================ budgets (r268)
def period_window(b: Budget, today: date | None = None) -> tuple[date, date]:
    """The budget period containing `today`: [start, end)."""
    today = today or date.today()
    step = {"month": relativedelta(months=1), "quarter": relativedelta(months=3), "year": relativedelta(years=1)}[
        b.period
    ]
    start = b.starts_on
    if today < start:
        return start, start + step
    while start + step <= today:
        start = start + step
    return start, start + step


def budget_spent(b: Budget, exclude: uuid.UUID | None = None, today: date | None = None) -> Decimal:
    start, end = period_window(b, today)
    q = select(func.coalesce(func.sum(PurchaseOrder.total), 0)).where(
        PurchaseOrder.org_id == b.org_id,
        PurchaseOrder.budget_id == b.id,
        PurchaseOrder.deleted_at.is_(None),
        PurchaseOrder.status.notin_(("canceled", "rejected")),
        func.date(PurchaseOrder.created_at) >= start,
        func.date(PurchaseOrder.created_at) < end,
    )
    if exclude:
        q = q.where(PurchaseOrder.id != exclude)
    return Decimal(str(db.session.scalar(q) or 0))


def budget_dict(b: Budget, show_costs: bool = True) -> dict[str, Any]:
    start, end = period_window(b)
    spent = budget_spent(b)
    return {
        "id": str(b.id),
        "name": b.name,
        "period": b.period,
        "starts_on": b.starts_on.isoformat(),
        "amount": num(b.amount) if show_costs else None,
        "currency": b.currency,
        "location_id": str(b.location_id) if b.location_id else None,
        "category": b.category,
        "approval_limit": num(b.approval_limit) if show_costs else None,
        "warn_at_pct": b.warn_at_pct,
        "active": b.active,
        "current_period": {"start": start.isoformat(), "end": (end - timedelta(days=1)).isoformat()},
        "spent": num(spent) if show_costs else None,
        "used_pct": int((spent / b.amount * 100).to_integral_value()) if b.amount else 0,
    }


def list_budgets(org_id: uuid.UUID, show_costs: bool = True) -> list[dict[str, Any]]:
    return [
        budget_dict(b, show_costs)
        for b in db.session.scalars(
            select(Budget).where(Budget.org_id == org_id, Budget.deleted_at.is_(None)).order_by(func.lower(Budget.name))
        )
    ]


def save_budget(org: Organization, data: dict[str, Any], b: Budget | None = None) -> Budget:
    from mpro.assets.models import Location

    creating = b is None
    if b is None:
        b = Budget(
            org_id=org.id,
            name="",
            period="month",
            starts_on=date.today().replace(day=1),
            amount=ZERO,
            currency=org.currency,
            category="",
            warn_at_pct=90,
            active=True,
        )
        db.session.add(b)
    if "name" in data or creating:
        b.name = text(data.get("name"), 200, "Name", required=True)
    if "period" in data:
        if data["period"] not in ("month", "quarter", "year"):
            raise RuleError("Budget period must be month, quarter or year.", 422)
        b.period = data["period"]
    if "starts_on" in data:
        b.starts_on = day(data.get("starts_on"), "Start date") or b.starts_on
    if "amount" in data or creating:
        b.amount = money(data.get("amount"), "Amount") or ZERO
    if "approval_limit" in data:
        b.approval_limit = money(data.get("approval_limit"), "Approval limit", required=False)
    if "currency" in data:
        b.currency = currency(data.get("currency")) or org.currency
    if "location_id" in data:
        loc = one_in_org(Location, org.id, data.get("location_id"), "location")
        b.location_id = loc.id if loc else None
    if "category" in data:
        b.category = text(data.get("category"), 80, "Category")
    if "warn_at_pct" in data:
        try:
            w = int(data.get("warn_at_pct") or 0)
        except (TypeError, ValueError) as e:
            raise RuleError("Warn at must be a percentage.", 422) from e
        if not 1 <= w <= 100:
            raise RuleError("Warn at must be between 1 and 100%.", 422)
        b.warn_at_pct = w
    if "active" in data:
        b.active = bool(data.get("active"))
    db.session.flush()
    emit(
        "budget.saved",
        entity_type="budget",
        entity_id=b.id,
        entity_label=b.name,
        summary=f"{'Created' if creating else 'Updated'} budget {b.name}",
    )
    db.session.commit()
    return b


def delete_budget(org: Organization, b: Budget) -> None:
    b.deleted_at = utcnow()
    emit(
        "budget.deleted", entity_type="budget", entity_id=b.id, entity_label=b.name, summary=f"Deleted budget {b.name}"
    )
    db.session.commit()


def budget_check(po: PurchaseOrder) -> dict[str, Any] | None:
    """How this PO sits against its budget: {level: ok|warn|over, spent, amount, remaining}."""
    if not po.budget_id:
        return None
    b = db.session.get(Budget, po.budget_id)
    if b is None or b.deleted_at is not None:
        return None
    spent = budget_spent(b, exclude=po.id) + (po.total or ZERO)
    level = "ok"
    if b.amount and spent > b.amount:
        level = "over"
    elif b.amount and spent * 100 >= b.amount * b.warn_at_pct:
        level = "warn"
    return {
        "budget_id": str(b.id),
        "name": b.name,
        "level": level,
        "spent": num(spent),
        "amount": num(b.amount),
        "remaining": num(b.amount - spent),
        "over_limit": bool(b.approval_limit is not None and (po.total or ZERO) > b.approval_limit),
    }


# ================================================================ approval rules (r230)
def rule_dict(r: ApprovalRule) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "applies_to": r.applies_to,
        "name": r.name,
        "sort": r.sort,
        "conditions": r.conditions or [],
        "action": r.action,
        "approver_user_ids": r.approver_user_ids or [],
        "approver_team_ids": r.approver_team_ids or [],
        "active": r.active,
    }


def list_rules(org_id: uuid.UUID, applies_to: str | None = None) -> list[dict[str, Any]]:
    q = select(ApprovalRule).where(ApprovalRule.org_id == org_id, ApprovalRule.deleted_at.is_(None))
    if applies_to:
        q = q.where(ApprovalRule.applies_to == applies_to)
    return [
        rule_dict(r)
        for r in db.session.scalars(q.order_by(ApprovalRule.applies_to, ApprovalRule.sort, ApprovalRule.created_at))
    ]


def save_rule(org: Organization, data: dict[str, Any], r: ApprovalRule | None = None) -> ApprovalRule:
    from mpro.assets.models import Location
    from mpro.orgs.models import Team

    creating = r is None
    if r is None:
        at = data.get("applies_to") or "purchase_order"
        if at not in ("purchase_order", "vendor_invoice"):
            raise RuleError("Rules apply to purchase orders or vendor invoices.", 422)
        nxt = (
            int(
                db.session.scalar(
                    select(func.coalesce(func.max(ApprovalRule.sort), -1)).where(ApprovalRule.org_id == org.id)
                )
                or 0
            )
            + 1
        )
        r = ApprovalRule(
            org_id=org.id,
            applies_to=at,
            name="",
            sort=int(nxt),
            conditions=[],
            action="approvers",
            approver_user_ids=[],
            approver_team_ids=[],
            active=True,
        )
        db.session.add(r)
    if "name" in data or creating:
        r.name = text(data.get("name"), 200, "Name", required=True)
    if "conditions" in data:
        conds = approvals.validate_conditions(data.get("conditions") or [])
        for c in conds:
            if c["field"] == "location":
                ids_in_org(Location, org.id, c.get("value"), "location")
            if c["field"] == "vendor":
                ids_in_org(Vendor, org.id, c.get("value"), "vendor")
        r.conditions = conds
    if "action" in data:
        if data["action"] not in ("approvers", "auto_approve"):
            raise RuleError("The action must be approvers or auto_approve.", 422)
        r.action = data["action"]
    if "approver_user_ids" in data:
        want = [uid(x, "person") for x in data.get("approver_user_ids") or []]
        members = set(
            db.session.scalars(
                select(Membership.user_id).where(
                    Membership.org_id == org.id, Membership.deleted_at.is_(None), Membership.user_id.in_(want)
                )
            )
        )
        if len(members) != len(set(want)):
            raise RuleError("One of the approvers isn't in this organization.", 422)
        r.approver_user_ids = [str(x) for x in dict.fromkeys(want)]
    if "approver_team_ids" in data:
        r.approver_team_ids = [str(x) for x in ids_in_org(Team, org.id, data.get("approver_team_ids"), "team")]
    if "sort" in data:
        try:
            r.sort = int(data["sort"])
        except (TypeError, ValueError) as e:
            raise RuleError("Order must be a number.", 422) from e
    if "active" in data:
        r.active = bool(data.get("active"))
    if r.action == "approvers" and not (r.approver_user_ids or r.approver_team_ids):
        raise RuleError("Pick at least one approver or team.", 422)
    db.session.flush()
    emit(
        "approval_rule.saved",
        entity_type="approval_rule",
        entity_id=r.id,
        entity_label=r.name,
        summary=f"{'Created' if creating else 'Updated'} approval rule {r.name}",
    )
    db.session.commit()
    return r


def delete_rule(org: Organization, r: ApprovalRule) -> None:
    r.deleted_at = utcnow()
    emit(
        "approval_rule.deleted",
        entity_type="approval_rule",
        entity_id=r.id,
        entity_label=r.name,
        summary=f"Deleted approval rule {r.name}",
    )
    db.session.commit()


def facts(po: PurchaseOrder) -> dict[str, Any]:
    from mpro.parts.models import Part

    lines = lines_of(po)
    zero_cost_part = any(ln.part_id and (ln.unit_cost or ZERO) == ZERO for ln in lines)
    loc = None
    if po.shipping_address_id:
        a = db.session.get(Address, po.shipping_address_id)
        loc = a.location_id if a else None
    bc = budget_check(po)
    _ = Part
    return {
        "total": po.total or ZERO,
        "currency": po.currency,
        "has_one_off": any(not ln.part_id for ln in lines),
        "zero_cost_part": zero_cost_part,
        "location_id": str(loc) if loc else None,
        "vendor_id": str(po.vendor_id) if po.vendor_id else None,
        "category": "",
        "custom": po.custom or {},
        "over_budget": bool(bc and bc["level"] == "over"),
    }


def _start_approval(org_id: uuid.UUID, po: PurchaseOrder) -> str:
    """Run the rules; returns the new status (pending or approved)."""
    result = approvals.start(org_id, "purchase_order", po.id, facts(po))
    bc = budget_check(po)
    if result != "pending" and bc and (bc["over_limit"] or bc["level"] == "over"):
        # above the budget's approval limit (or over budget): someone who can approve purchase orders decides
        db.session.add(
            Approval(
                org_id=org_id,
                entity_type="purchase_order",
                entity_id=po.id,
                rule_id=None,
                approver_user_ids=[],
                approver_team_ids=[],
                status="pending",
            )
        )
        db.session.flush()
        result = "pending"
    return "pending" if result == "pending" else "approved"


# ================================================================ create / update
def _clean_lines(
    org_id: uuid.UUID, raw: Any, existing: dict[uuid.UUID, PurchaseOrderLine] | None = None
) -> list[dict[str, Any]]:
    from mpro.assets.models import Location
    from mpro.parts.models import Part

    if not isinstance(raw, list) or len(raw) > 500:
        raise RuleError("A purchase order can have up to 500 lines.", 422)
    out = []
    for i, ln in enumerate(raw):
        if not isinstance(ln, dict):
            raise RuleError("Each line must be an object.", 422)
        line_id = uid(ln["id"], "line") if ln.get("id") else None
        if line_id and (existing is None or line_id not in existing):
            raise RuleError("One of the lines doesn't belong to this purchase order.", 422)
        part = one_in_org(Part, org_id, ln.get("part_id"), "part") if ln.get("part_id") else None
        desc = text(ln.get("description") or (part.name if part else ""), 500, "Description", required=True)
        qty = money(ln.get("quantity", 1), "Quantity")
        if qty is None or qty <= 0:
            raise RuleError(f"Quantity for {desc} must be more than 0.", 422)
        cost = money(
            ln.get("unit_cost") if ln.get("unit_cost") not in (None, "") else (part.unit_cost if part else 0),
            "Unit cost",
        )
        loc = one_in_org(Location, org_id, ln.get("location_id"), "location") if ln.get("location_id") else None
        out.append(
            {
                "id": line_id,
                "sort": i,
                "part_id": part.id if part else None,
                "description": desc,
                "part_number": text(ln.get("part_number"), 120, "Part number"),
                "unit": text(ln.get("unit") or (part.unit if part else "each"), 30, "Unit") or "each",
                "quantity": qty,
                "unit_cost": cost,
                "location_id": loc.id if loc else None,
                "product_link_id": _link_in_org(org_id, ln.get("product_link_id")),
                "taxable": bool(ln.get("taxable", True)),
            }
        )
    return out


def _link_in_org(org_id: uuid.UUID, raw: Any) -> uuid.UUID | None:
    """A supplier listing on a line must belong to this organization (G-15)."""
    if raw in (None, ""):
        return None
    from mpro.suppliers.models import ProductLink

    return one_in_org(ProductLink, org_id, raw, "product link").id


def _apply_lines(org_id: uuid.UUID, po: PurchaseOrder, raw: Any) -> None:
    existing = {ln.id: ln for ln in lines_of(po)}
    clean = _clean_lines(org_id, raw, existing)
    keep = {c["id"] for c in clean if c["id"]}
    for lid, old in existing.items():
        if lid not in keep:
            if (old.received or ZERO) != ZERO:
                raise RuleError(f"{old.description} has been received, so it can't be removed.", 409)
            db.session.delete(old)
    for c in clean:
        ln: PurchaseOrderLine | None = existing.get(c["id"]) if c["id"] else None
        if ln is not None and (ln.received or ZERO) != ZERO:
            # locked once received (r229): only its position may change
            if c["part_id"] != ln.part_id or c["quantity"] < ln.received or c["unit_cost"] != ln.unit_cost:
                raise RuleError(
                    f"{ln.description} has been received; its part and cost can't change"
                    " and the quantity can't go below what's received.",
                    409,
                )
            ln.sort, ln.quantity = c["sort"], c["quantity"]
            continue
        if ln is None:
            ln = PurchaseOrderLine(org_id=org_id, purchase_order_id=po.id, received=ZERO)
            db.session.add(ln)
        for k in (
            "sort",
            "part_id",
            "description",
            "part_number",
            "unit",
            "quantity",
            "unit_cost",
            "location_id",
            "product_link_id",
            "taxable",
        ):
            setattr(ln, k, c[k])
    db.session.flush()


def _apply_costs(org_id: uuid.UUID, po: PurchaseOrder, raw: Any) -> list[str]:
    if not isinstance(raw, list) or len(raw) > 30:
        raise RuleError("Up to 30 taxes and additional costs.", 422)
    for c in costs_of(po):
        db.session.delete(c)
    warnings = []
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            raise RuleError("Each cost must be an object.", 422)
        kind = c.get("kind") or "fixed"
        if kind not in ("fixed", "percent"):
            raise RuleError("A cost is a fixed amount or a percent.", 422)
        val = money(c.get("value", 0), "Amount", allow_negative=True)
        if kind == "percent" and val is not None and not (-100 <= val <= 1000):
            raise RuleError("Percentages must be between -100 and 1,000.", 422)
        is_tax = bool(c.get("is_tax"))
        db.session.add(
            PurchaseOrderCost(
                org_id=org_id,
                purchase_order_id=po.id,
                sort=i,
                label=text(c.get("label") or ("Tax" if is_tax else "Additional cost"), 120, "Label"),
                kind=kind,
                value=val,
                is_tax=is_tax,
                taxable=bool(c.get("taxable")) and not is_tax,
            )
        )
        if is_tax and po.tax_exempt:
            warnings.append("This purchase order is tax exempt, but a tax line was added.")
    db.session.flush()
    return warnings


def _apply_exemption(org_id: uuid.UUID, po: PurchaseOrder) -> None:
    """Ask finance whether a certificate on file with this vendor covers where it ships (MP-090)."""
    addr = db.session.get(Address, po.shipping_address_id) if po.shipping_address_id else None
    cert = None
    for fn in EXEMPTION_LOOKUPS:
        try:
            with db.session.begin_nested():
                cert = fn(org_id, po.vendor_id, addr, addr.location_id if addr else None)
        except Exception:  # noqa: BLE001  — a broken lookup must not block the PO
            cert = None
        if cert is not None:
            break
    po.tax_exempt = cert is not None
    po.tax_certificate_id = getattr(cert, "id", None) if cert is not None else None


def _apply_fields(org: Organization, m: Membership, po: PurchaseOrder, data: dict[str, Any], creating: bool) -> None:
    from mpro.workorders.models import WorkOrder

    if "title" in data or creating:
        po.title = text(data.get("title"), 255, "Title") or settings(org.id)["default_title"]
    if "custom_number" in data:
        cn = text(data.get("custom_number"), 60, "PO number")
        if cn and db.session.scalar(
            select(PurchaseOrder.id).where(
                PurchaseOrder.org_id == org.id,
                PurchaseOrder.custom_number == cn,
                PurchaseOrder.id != po.id,
                PurchaseOrder.deleted_at.is_(None),
            )
        ):
            raise RuleError(f"PO number {cn} is already used.", 409)
        po.custom_number = cn
    if "vendor_id" in data:
        v = one_in_org(Vendor, org.id, data.get("vendor_id"), "vendor")
        po.vendor_id = v.id if v else None
        if v and creating and not data.get("currency"):
            po.currency = v.currency or org.currency
    if "vendor_contact_ids" in data:
        ids = [uid(x, "contact") for x in data.get("vendor_contact_ids") or []]
        if ids:
            ok = set(
                db.session.scalars(
                    select(VendorContact.id).where(
                        VendorContact.org_id == org.id,
                        VendorContact.vendor_id == po.vendor_id,
                        VendorContact.id.in_(ids),
                        VendorContact.deleted_at.is_(None),
                    )
                )
            )
            if len(ok) != len(set(ids)):
                raise RuleError("One of the contacts isn't at this vendor.", 422)
        po.vendor_contact_ids = [str(x) for x in dict.fromkeys(ids)]
    if "currency" in data:
        po.currency = currency(data.get("currency")) or org.currency
    if "due_on" in data:
        po.due_on = day(data.get("due_on"), "Due date")
    for k in ("shipping_address_id", "billing_address_id"):
        if k in data:
            a = one_in_org(Address, org.id, data.get(k), "address")
            setattr(po, k, a.id if a else None)
    if "notes" in data:
        po.notes = text(data.get("notes"), 4096, "Notes")
    if "custom" in data or creating:
        from mpro.workorders.services import _clean_custom, custom_fields

        po.custom = _clean_custom(
            org.id, data.get("custom") or {}, None if creating else po.custom, entity_type="purchase_order"
        )
        for f in custom_fields(org.id, "purchase_order"):
            if f.required and (po.custom or {}).get(str(f.id)) in (None, ""):
                raise RuleError(f"Fill in {f.name}.", 422)
    if "work_order_id" in data:
        wo = one_in_org(WorkOrder, org.id, data.get("work_order_id"), "work order")
        po.work_order_id = wo.id if wo else None
    if "budget_id" in data:
        b = one_in_org(Budget, org.id, data.get("budget_id"), "budget")
        po.budget_id = b.id if b else None


def create_purchase_order(
    org: Organization, member: Membership, data: dict[str, Any], commit: bool = True
) -> PurchaseOrder:
    """Create a PO. CONTRACT (used by other modules):
    data = {vendor_id, title?, lines: [{part_id?, description, part_number?, unit?, quantity, unit_cost,
            product_link_id?, location_id?}], source?, work_order_id?, notes?, due_on?, shipping_address_id?, ...}
    People who can manage POs create them as approved (or pending, when an approval rule or budget limit applies);
    everyone else's become Requested (r228)."""
    # whoever may manage purchase orders (any, or just their own: a new PO is theirs) creates real POs
    manager = can(member, "po.manage") or can(member, "po.manage_own")
    if not can(member, "po.request") and not manager:
        raise RuleError("You don't have permission to request purchase orders.", 403)
    if not manager and any(data.get(k) for k in ("costs", "budget_id", "custom_number")):
        raise RuleError("You can't set costs, a budget or a PO number on a request.", 403)
    source = data.get("source") or ""
    if source not in ("", "low_stock", "work_order", "punchout", "reorder"):
        raise RuleError("Unknown purchase order source.", 422)
    s = settings(org.id)
    po = PurchaseOrder(
        org_id=org.id,
        number=0,
        custom_number="",
        title="",
        status="requested",
        vendor_contact_ids=[],
        currency=org.currency,
        notes="",
        custom={},
        tax_exempt=False,
        subtotal=ZERO,
        extra_total=ZERO,
        total=ZERO,
        requested_by_id=member.user_id,
        created_by_id=member.user_id,
        source=source,
        rejected_reason="",
        version=1,
    )
    _apply_fields(org, member, po, data, True)
    if not po.shipping_address_id:
        a = _default_address(org.id, "shipping")
        po.shipping_address_id = a.id if a else None
    if not po.billing_address_id:
        a = _default_address(org.id, "billing")
        po.billing_address_id = a.id if a else None
    if s.get("single_address") and po.shipping_address_id and not data.get("billing_address_id"):
        po.billing_address_id = po.shipping_address_id
    po.number = next_counter(
        org.id,
        "purchase_order",
        int(db.session.scalar(select(func.max(PurchaseOrder.number)).where(PurchaseOrder.org_id == org.id)) or 0),
    )
    db.session.add(po)
    db.session.flush()
    _apply_lines(org.id, po, data.get("lines") or [])
    if "costs" in data:
        _apply_costs(org.id, po, data.get("costs") or [])
    _apply_exemption(org.id, po)
    _recalc(po)
    if manager and not data.get("as_request"):
        po.status = _start_approval(org.id, po)
        if po.status == "approved":
            po.approved_by_id, po.approved_at = member.user_id, utcnow()
    emit(
        "purchase_order.created",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po, s["number_prefix"]),
        summary=f"Created {po_number(po, s['number_prefix'])} ({STATUS_LABELS[po.status]})",
        data={"source": source},
        org_id=org.id,
    )
    recompute_ordered(org.id, _part_ids(po))
    if commit:
        db.session.commit()
    return po


def can_edit(m: Membership, po: PurchaseOrder) -> bool:
    if po.status in ("complete", "canceled") or po.deleted_at is not None:
        return False
    if can_on(m, "po.manage", po):
        return True
    return po.status == "requested" and po.requested_by_id == m.user_id and can(m, "po.request")


def update_purchase_order(
    org: Organization, m: Membership, po: PurchaseOrder, data: dict[str, Any]
) -> tuple[PurchaseOrder, list[str]]:
    lock_po(po)
    if not can_edit(m, po):
        raise RuleError(
            "This purchase order can't be changed."
            if po.status in ("complete", "canceled")
            else "You can't change this purchase order.",
            403 if po.status not in ("complete", "canceled") else 409,
        )
    if "version" in data and str(data["version"]) != str(po.version):
        raise RuleError("Someone else changed this purchase order. Reload to see their changes.", 409)
    if not can_on(m, "po.manage", po) and any(k in data for k in ("costs", "budget_id", "custom_number")):
        raise RuleError("You can't set costs on a request.", 403)
    old_total, old_parts = po.total or ZERO, _part_ids(po)
    _apply_fields(org, m, po, data, False)
    if "lines" in data:
        _apply_lines(org.id, po, data.get("lines") or [])
    warnings: list[str] = []
    if "vendor_id" in data or "shipping_address_id" in data:
        _apply_exemption(org.id, po)
    if "costs" in data:
        warnings += _apply_costs(org.id, po, data.get("costs") or [])
    _recalc(po)
    po.version += 1
    if po.status in ("approved", "pending", "partially_fulfilled") and (po.total or ZERO) > old_total:
        # the total went up: the approval rules run again. Received quantities stay as they are; the PO shows
        # Pending until approved, and approval puts it back to what was received (partially fulfilled, …)
        if _start_approval(org.id, po) == "pending":
            _set_status(org.id, po, "pending", "Total went up; approval needed again")
        elif po.status == "pending":
            po.approved_by_id, po.approved_at = m.user_id, utcnow()
            _set_status(org.id, po, status_from_receipts(po), "Approved")
    emit(
        "purchase_order.updated",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary=f"Updated {po_number(po)}",
        data={"keys": sorted(data)},
        org_id=org.id,
    )
    recompute_ordered(org.id, old_parts | _part_ids(po))
    db.session.commit()
    return po, warnings


# ================================================================ approval / status actions
def approve(org: Organization, m: Membership, po: PurchaseOrder, comment: str = "") -> PurchaseOrder:
    if po.status == "requested":
        if not can(m, "po.manage"):
            raise RuleError("You can't review purchase order requests.", 403)
        new = _start_approval(org.id, po)
        if new == "pending":
            _set_status(org.id, po, "pending", "Sent for approval")
        else:
            po.approved_by_id, po.approved_at = m.user_id, utcnow()
            _set_status(org.id, po, status_from_receipts(po), "Approved")
        db.session.commit()
        return po
    if po.status != "pending":
        raise RuleError("This purchase order isn't waiting for approval.", 409)
    res = approvals.decide(
        org.id,
        "purchase_order",
        po.id,
        approve=True,
        user=m.user,
        team_ids=_team_ids(m),
        is_admin=can(m, "po.approve"),
        comment=comment,
    )
    if res == "approved":
        po.approved_by_id, po.approved_at = m.user_id, utcnow()
        # a PO sent back for approval after items arrived keeps its receipts
        _set_status(org.id, po, status_from_receipts(po), "Approved")
    db.session.commit()
    return po


def reject(org: Organization, m: Membership, po: PurchaseOrder, reason: str) -> PurchaseOrder:
    reason = text(reason, 4000, "Reason")
    if po.status == "requested":
        if not can(m, "po.manage"):
            raise RuleError("You can't review purchase order requests.", 403)
        if not reason:
            raise RuleError("Say why it's rejected.", 422)
    elif po.status == "pending":
        approvals.decide(
            org.id,
            "purchase_order",
            po.id,
            approve=False,
            user=m.user,
            team_ids=_team_ids(m),
            is_admin=can(m, "po.approve"),
            comment=reason,
        )
    else:
        raise RuleError("Only requested or pending purchase orders can be rejected.", 409)
    po.rejected_reason = reason
    _set_status(org.id, po, "rejected", f"Rejected: {reason}"[:500])
    db.session.commit()
    return po


def can_decide(m: Membership, po: PurchaseOrder) -> bool:
    if po.status == "requested":
        return can(m, "po.manage")
    if po.status != "pending":
        return False
    teams = _team_ids(m)
    return any(
        approvals.can_decide(s, m.user_id, teams, can(m, "po.approve"))
        for s in approvals.pending(po.org_id, "purchase_order", po.id)
    )


def cancel(org: Organization, m: Membership, po: PurchaseOrder, reason: str = "") -> PurchaseOrder:
    lock_po(po)
    if po.status in ("complete", "canceled"):
        raise RuleError("This purchase order is already closed.", 409)
    if any((ln.received or ZERO) != ZERO for ln in lines_of(po)):
        raise RuleError(
            "Items have been received on this purchase order, so it can't be canceled. Complete it instead.", 409
        )
    for s in approvals.pending(org.id, "purchase_order", po.id):
        s.status = "skipped"
    _set_status(org.id, po, "canceled", "Canceled" + (f": {text(reason, 500)}" if reason else ""))
    db.session.commit()
    return po


def delete_po(org: Organization, m: Membership, po: PurchaseOrder) -> None:
    if any((ln.received or ZERO) != ZERO for ln in lines_of(po)):
        raise RuleError("Items have been received on this purchase order, so it can't be deleted.", 409)
    po.deleted_at = utcnow()
    emit(
        "purchase_order.deleted",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary=f"Deleted {po_number(po)}",
        org_id=org.id,
    )
    recompute_ordered(org.id, _part_ids(po))
    db.session.commit()


def complete(org: Organization, m: Membership, po: PurchaseOrder) -> PurchaseOrder:
    """Close a PO even if not everything arrived (MaintainX "Complete")."""
    if po.status not in ("approved", "partially_fulfilled"):
        raise RuleError("Only approved or partially fulfilled purchase orders can be completed.", 409)
    _set_status(org.id, po, "complete", "Completed")
    db.session.commit()
    return po


def reopen(org: Organization, m: Membership, po: PurchaseOrder) -> PurchaseOrder:
    """Undo completion (r256)."""
    if po.status != "complete":
        raise RuleError("Only completed purchase orders can be reopened.", 409)
    received = any((ln.received or ZERO) != ZERO for ln in lines_of(po))
    _set_status(org.id, po, "partially_fulfilled" if received else "approved", "Reopened")
    db.session.commit()
    return po


def duplicate(org: Organization, m: Membership, po: PurchaseOrder) -> PurchaseOrder:
    data = {
        "vendor_id": po.vendor_id,
        "title": po.title,
        "currency": po.currency,
        "notes": po.notes,
        "custom": po.custom,
        "shipping_address_id": po.shipping_address_id,
        "billing_address_id": po.billing_address_id,
        "vendor_contact_ids": po.vendor_contact_ids,
        "budget_id": po.budget_id,
        "lines": [
            {
                "part_id": ln.part_id,
                "description": ln.description,
                "part_number": ln.part_number,
                "unit": ln.unit,
                "quantity": ln.quantity,
                "unit_cost": ln.unit_cost,
                "location_id": ln.location_id,
                "product_link_id": ln.product_link_id,
                "taxable": ln.taxable,
            }
            for ln in lines_of(po)
        ],
        "costs": [
            {"label": c.label, "kind": c.kind, "value": c.value, "is_tax": c.is_tax, "taxable": c.taxable}
            for c in costs_of(po)
        ],
    }
    new = create_purchase_order(org, m, data, commit=False)
    emit(
        "purchase_order.duplicated",
        entity_type="purchase_order",
        entity_id=new.id,
        entity_label=po_number(new),
        summary=f"Copied from {po_number(po)}",
        org_id=org.id,
    )
    db.session.commit()
    return new


# ================================================================ receiving (r231)
def receive(
    org: Organization, m: Membership, po: PurchaseOrder, data: dict[str, Any]
) -> tuple[PurchaseOrderReceipt, list[str]]:
    """{lines: [{line_id, quantity, unit_cost?, location_id?}], note?, packing_slip?}
    Several entries per line split it across locations. Negative quantities correct an earlier receipt."""
    from mpro.assets.models import Location
    from mpro.parts import ledger

    lock_po(po)  # two people receiving the same line at once both count, from the current quantities
    if po.status not in ("approved", "partially_fulfilled") or approvals.pending(org.id, "purchase_order", po.id):
        raise RuleError(
            "This purchase order is closed."
            if po.status in ("complete", "canceled", "rejected")
            else "Only approved purchase orders can be received.",
            409,
        )
    raw = data.get("lines") or []
    if not isinstance(raw, list) or not raw or len(raw) > 1000:
        raise RuleError("Say how many of each item arrived.", 422)
    lines = {ln.id: ln for ln in lines_of(po)}
    moving_avg = bool(get_settings(org.id, "parts").get("moving_average_cost"))
    rec = PurchaseOrderReceipt(
        org_id=org.id,
        purchase_order_id=po.id,
        received_at=utcnow(),
        received_by_id=m.user_id,
        note=text(data.get("note"), 4000, "Note"),
        packing_slip=text(data.get("packing_slip"), 120, "Packing slip"),
    )
    db.session.add(rec)
    db.session.flush()
    warnings: list[str] = []
    out_lines: list[PurchaseOrderReceiptLine] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise RuleError("Each received line must be an object.", 422)
        ln = lines.get(uid(entry.get("line_id"), "line"))
        if ln is None:
            raise RuleError("One of the lines isn't on this purchase order.", 422)
        qty = money(entry.get("quantity"), "Quantity received", allow_negative=True)
        if qty is None or qty == 0:
            continue
        if (ln.received or ZERO) + qty < 0:
            raise RuleError(f"You can't take back more {ln.description} than was received.", 422)
        cost = money(entry.get("unit_cost"), "Unit cost", required=False)
        if cost is None:
            cost = ln.unit_cost or ZERO
        elif cost != (ln.unit_cost or ZERO):
            warnings.append(f"{ln.description}: received at {num(cost)} instead of {num(ln.unit_cost)} per {ln.unit}.")
        loc_raw = entry.get("location_id") if "location_id" in entry else ln.location_id
        loc = one_in_org(Location, org.id, loc_raw, "location") if loc_raw else None
        txn_id = None
        if ln.part_id:
            txn = ledger.record(
                org.id,
                ln.part_id,
                loc.id if loc else None,
                "receive" if qty > 0 else "adjust",
                qty,
                unit_cost=cost,
                note=f"{po_number(po)}" + (" (correction)" if qty < 0 else ""),
                purchase_order_id=po.id,
                po_line_id=ln.id,
                user_id=m.user_id,
                allow_negative=True,
                update_average_cost=moving_avg and qty > 0,
            )
            txn_id = txn.id
        ln.received = (ln.received or ZERO) + qty
        rl = PurchaseOrderReceiptLine(
            org_id=org.id,
            receipt_id=rec.id,
            line_id=ln.id,
            quantity=qty,
            unit_cost=cost,
            location_id=loc.id if loc else None,
            transaction_id=txn_id,
        )
        db.session.add(rl)
        out_lines.append(rl)
        if ln.received > ln.quantity:
            warnings.append(f"{ln.description}: {num(ln.received)} received but {num(ln.quantity)} were ordered.")
    if not out_lines:
        raise RuleError("Enter a quantity for at least one line.", 422)
    db.session.flush()
    all_in = all((ln.received or ZERO) >= ln.quantity for ln in lines.values())
    any_in = any((ln.received or ZERO) != ZERO for ln in lines.values())
    new = "complete" if all_in else ("partially_fulfilled" if any_in else "approved")
    emit(
        "purchase_order.received",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary=f"Received {len(out_lines)} line{'s' if len(out_lines) != 1 else ''}"
        + (f" (slip {rec.packing_slip})" if rec.packing_slip else ""),
        data={"receipt_id": rec.id},
        org_id=org.id,
    )
    if new != po.status:
        _set_status(org.id, po, new)
    else:
        recompute_ordered(org.id, _part_ids(po))
    run_hooks(PO_RECEIVED_HOOKS, org.id, po, rec, out_lines, what="purchase order received hook")
    db.session.commit()
    return rec, warnings


def receipts_of(po: PurchaseOrder, show_costs: bool) -> list[dict[str, Any]]:
    from mpro.auth.models import User

    recs = db.session.scalars(
        select(PurchaseOrderReceipt)
        .where(PurchaseOrderReceipt.purchase_order_id == po.id)
        .order_by(PurchaseOrderReceipt.received_at)
    ).all()
    out = []
    for r in recs:
        u = db.session.get(User, r.received_by_id) if r.received_by_id else None
        rls = db.session.scalars(
            select(PurchaseOrderReceiptLine).where(PurchaseOrderReceiptLine.receipt_id == r.id)
        ).all()
        out.append(
            {
                "id": str(r.id),
                "received_at": iso(r.received_at),
                "received_by": u.name if u else None,
                "note": r.note,
                "packing_slip": r.packing_slip,
                "lines": [
                    {
                        "line_id": str(x.line_id),
                        "quantity": num(x.quantity),
                        "unit_cost": num(x.unit_cost) if show_costs else None,
                        "location_id": str(x.location_id) if x.location_id else None,
                    }
                    for x in rls
                ],
                "total": num(_r(sum((x.quantity * x.unit_cost for x in rls), ZERO))) if show_costs else None,
            }
        )
    return out


# ================================================================ serialization
def po_dict(
    po: PurchaseOrder, m: Membership | None, vendor_names: dict[uuid.UUID, str] | None = None, prefix: str | None = None
) -> dict[str, Any]:
    costs = sees_costs(m)
    vname = (vendor_names or {}).get(po.vendor_id) if po.vendor_id else None
    if po.vendor_id and vname is None:
        v = db.session.get(Vendor, po.vendor_id)
        vname = v.name if v else None
    return {
        "id": str(po.id),
        "number": po.number,
        "display_number": po_number(po, prefix),
        "custom_number": po.custom_number,
        "title": po.title,
        "status": po.status,
        "status_label": STATUS_LABELS[po.status],
        "overdue": is_overdue(po),
        "vendor": {"id": str(po.vendor_id), "name": vname} if po.vendor_id else None,
        "currency": po.currency,
        "due_on": po.due_on.isoformat() if po.due_on else None,
        "subtotal": num(po.subtotal) if costs else None,
        "extra_total": num(po.extra_total) if costs else None,
        "total": num(po.total) if costs else None,
        "tax_exempt": po.tax_exempt,
        "source": po.source,
        "work_order_id": str(po.work_order_id) if po.work_order_id else None,
        "requested_by_id": str(po.requested_by_id) if po.requested_by_id else None,
        "created_at": iso(po.created_at),
        "approved_at": iso(po.approved_at),
        "completed_at": iso(po.completed_at),
        "sent_at": iso(po.sent_at),
        "version": po.version,
    }


def po_detail(po: PurchaseOrder, m: Membership) -> dict[str, Any]:
    from mpro.auth.models import User
    from mpro.parts.models import Part

    costs = sees_costs(m)
    d = po_dict(po, m)
    t = compute_totals(lines_of(po), costs_of(po))
    part_names = {}
    pids = [ln.part_id for ln in lines_of(po) if ln.part_id]
    if pids:
        part_names = {p.id: p for p in db.session.scalars(select(Part).where(Part.id.in_(pids)))}
    d["lines"] = []
    for ln in lines_of(po):
        p = part_names.get(ln.part_id) if ln.part_id else None
        d["lines"].append(
            {
                "id": str(ln.id),
                "part": {"id": str(p.id), "name": p.name, "part_number": p.part_number} if p else None,
                "description": ln.description,
                "part_number": ln.part_number,
                "unit": ln.unit,
                "quantity": num(ln.quantity),
                "unit_cost": num(ln.unit_cost) if costs else None,
                "amount": num(_r(ln.quantity * ln.unit_cost)) if costs else None,
                "received": num(ln.received),
                "location_id": str(ln.location_id) if ln.location_id else None,
                "product_link_id": str(ln.product_link_id) if ln.product_link_id else None,
                "taxable": ln.taxable,
                "locked": (ln.received or ZERO) != ZERO,
            }
        )
    d["costs"] = (
        [
            {
                "id": str(c.id),
                "label": c.label,
                "kind": c.kind,
                "value": num(c.value),
                "is_tax": c.is_tax,
                "taxable": c.taxable,
                "amount": num(t["amounts"].get(c.id)),
            }
            for c in costs_of(po)
        ]
        if costs
        else []
    )
    d["notes"], d["custom"] = po.notes, po.custom or {}
    d["vendor_contact_ids"] = po.vendor_contact_ids or []
    d["shipping_address"] = (
        address_dict(a) if po.shipping_address_id and (a := db.session.get(Address, po.shipping_address_id)) else None
    )
    d["billing_address"] = (
        address_dict(b) if po.billing_address_id and (b := db.session.get(Address, po.billing_address_id)) else None
    )
    d["budget"] = budget_check(po) if costs else None
    d["tax_certificate_id"] = str(po.tax_certificate_id) if po.tax_certificate_id else None
    d["rejected_reason"] = po.rejected_reason
    d["receipts"] = receipts_of(po, costs)
    users = {}

    def uname(i: Any) -> str | None:
        if not i:
            return None
        if i not in users:
            u = db.session.get(User, i if isinstance(i, uuid.UUID) else uuid.UUID(str(i)))
            users[i] = u.name if u else None
        return users[i]

    d["requested_by"] = uname(po.requested_by_id)
    d["approved_by"] = uname(po.approved_by_id)
    d["approvals"] = [
        {
            "id": str(s.id),
            "status": s.status,
            "approvers": [uname(x) for x in s.approver_user_ids or []],
            "team_ids": s.approver_team_ids or [],
            "decided_by": uname(s.decided_by_id),
            "decided_at": iso(s.decided_at),
            "comment": s.comment,
        }
        for s in db.session.scalars(
            select(Approval)
            .where(Approval.entity_type == "purchase_order", Approval.entity_id == po.id, Approval.status != "skipped")
            .order_by(Approval.created_at)
        )
    ]
    d["can"] = {
        "edit": can_edit(m, po),
        "decide": can_decide(m, po),
        "receive": can(m, "po.receive") and po.status in ("approved", "partially_fulfilled"),
        "send": can_on(m, "po.manage", po) and po.status in ("approved", "partially_fulfilled", "complete"),
        "cancel": can(m, "po.delete") and po.status not in ("complete", "canceled"),
        "delete": can(m, "po.delete"),
        "complete": can_on(m, "po.manage", po) and po.status in ("approved", "partially_fulfilled"),
        "reopen": can_on(m, "po.manage", po) and po.status == "complete",
        "costs": costs,
    }
    from mpro.core.files import file_dict, links_for

    d["files"] = [file_dict(link.file, link.role, link.id) for link in links_for("purchase_order", po.id) if link.file]
    return d


def list_pos(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    org_id = m.org_id
    q = select(PurchaseOrder).where(PurchaseOrder.org_id == org_id, PurchaseOrder.deleted_at.is_(None))
    st = params.get("status") or ""
    if st == "open":
        q = q.where(PurchaseOrder.status.in_(OPEN))
    elif st == "overdue":
        q = q.where(PurchaseOrder.status.in_(OPEN), PurchaseOrder.due_on < date.today())
    elif st == "awaiting_me":
        q = q.where(PurchaseOrder.status.in_(("requested", "pending")))
    elif st:
        wanted = [x for x in st.split(",") if x in PO_STATUSES]
        if wanted:
            q = q.where(PurchaseOrder.status.in_(wanted))
    if params.get("vendor_id"):
        q = q.where(PurchaseOrder.vendor_id == uid(params["vendor_id"], "vendor"))
    if params.get("work_order_id"):
        q = q.where(PurchaseOrder.work_order_id == uid(params["work_order_id"], "work order"))
    if params.get("part_id"):
        q = q.where(
            PurchaseOrder.id.in_(
                select(PurchaseOrderLine.purchase_order_id).where(
                    PurchaseOrderLine.part_id == uid(params["part_id"], "part")
                )
            )
        )
    if params.get("mine"):
        q = q.where(PurchaseOrder.requested_by_id == m.user_id)
    s = text(params.get("q"), 200)
    if s:
        pat = f"%{s.lower()}%"
        conds: list[Any] = [
            func.lower(PurchaseOrder.title).like(pat),
            func.lower(PurchaseOrder.custom_number).like(pat),
            PurchaseOrder.vendor_id.in_(
                select(Vendor.id).where(Vendor.org_id == org_id, func.lower(Vendor.name).like(pat))
            ),
            PurchaseOrder.id.in_(
                select(PurchaseOrderLine.purchase_order_id).where(
                    PurchaseOrderLine.org_id == org_id,
                    or_(
                        func.lower(PurchaseOrderLine.description).like(pat),
                        func.lower(PurchaseOrderLine.part_number).like(pat),
                    ),
                )
            ),
        ]
        digits = s.lstrip("#").removeprefix(settings(org_id)["number_prefix"])
        if digits.isdigit():
            conds.append(PurchaseOrder.number == int(digits))
        q = q.where(or_(*conds))
    rows_q = q
    if st == "awaiting_me":
        rows_all = [
            p for p in db.session.scalars(q.order_by(PurchaseOrder.created_at.desc()).limit(500)) if can_decide(m, p)
        ]
        total = len(rows_all)
        page, per_page = page_args(params, 50, 200)
        rows = rows_all[(page - 1) * per_page : page * per_page]
    else:
        total = count(rows_q)
        page, per_page = page_args(params, 50, 200)
        order = {
            "due": (PurchaseOrder.due_on.is_(None), PurchaseOrder.due_on),
            "number": (PurchaseOrder.number.desc(),),
        }.get(params.get("sort") or "", (PurchaseOrder.created_at.desc(),))
        rows = list(db.session.scalars(rows_q.order_by(*order).limit(per_page).offset((page - 1) * per_page)))
    vids = {p.vendor_id for p in rows if p.vendor_id}
    names = dict(db.session.execute(select(Vendor.id, Vendor.name).where(Vendor.id.in_(vids))).all()) if vids else {}
    prefix = settings(org_id)["number_prefix"]
    counts = dict(
        db.session.execute(
            select(PurchaseOrder.status, func.count())
            .where(PurchaseOrder.org_id == org_id, PurchaseOrder.deleted_at.is_(None))
            .group_by(PurchaseOrder.status)
        ).all()
    )
    return {
        "items": [po_dict(p, m, names, prefix) for p in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
        "counts": {k: int(v) for k, v in counts.items()},
    }


# ================================================================ comments (r259)
def comments(po: PurchaseOrder) -> list[dict[str, Any]]:
    from mpro.workorders.activity import comment_dict
    from mpro.workorders.models import Comment

    return [
        comment_dict(c)
        for c in db.session.scalars(
            select(Comment)
            .where(Comment.entity_type == "purchase_order", Comment.entity_id == po.id, Comment.deleted_at.is_(None))
            .order_by(Comment.created_at)
        )
    ]


def add_comment(org: Organization, m: Membership, po: PurchaseOrder, body: str) -> Any:
    from mpro.workorders.models import Comment

    body = text(body, 10000, "Comment", required=True)
    c = Comment(
        org_id=org.id,
        entity_type="purchase_order",
        entity_id=po.id,
        author_id=m.user_id,
        body=body,
        mentions={},
        reactions={},
    )
    db.session.add(c)
    db.session.flush()
    emit(
        "purchase_order.commented",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary="Commented",
    )
    db.session.commit()
    return c


def delete_comment(org: Organization, m: Membership, po: PurchaseOrder, cid: Any) -> None:
    from mpro.workorders.models import Comment

    c = db.session.get(Comment, uid(cid, "comment"))
    if (
        c is None
        or c.org_id != org.id
        or c.entity_type != "purchase_order"
        or c.entity_id != po.id
        or c.deleted_at is not None
    ):
        raise RuleError("That comment doesn't exist.", 404)
    if c.author_id != m.user_id and not can(m, "po.manage"):
        raise RuleError("You can only delete your own comments.", 403)
    c.deleted_at = utcnow()
    emit(
        "purchase_order.comment_deleted",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary="Deleted a comment",
    )
    db.session.commit()


# ================================================================ send to vendor (MP-043, r255)
def send_to_vendor(org: Organization, m: Membership, po: PurchaseOrder, data: dict[str, Any]) -> dict[str, Any]:
    from mpro.core.files import attach, save_file
    from mpro.core.mail import send_email
    from mpro.purchasing.pdf import po_pdf

    if po.status not in ("approved", "partially_fulfilled", "complete") or approvals.pending(
        org.id, "purchase_order", po.id
    ):
        raise RuleError("Only approved purchase orders can be sent to the vendor.", 409)
    contacts = (
        db.session.scalars(
            select(VendorContact).where(VendorContact.vendor_id == po.vendor_id, VendorContact.deleted_at.is_(None))
        ).all()
        if po.vendor_id
        else []
    )
    to = [email(x, "Recipient") for x in data.get("to") or [] if str(x).strip()]
    if not to:
        chosen = [c for c in contacts if str(c.id) in (po.vendor_contact_ids or [])] or [
            c for c in contacts if c.is_po_contact
        ]
        to = [c.email for c in chosen if c.email]
        if not to and po.vendor_id:
            v = db.session.get(Vendor, po.vendor_id)
            to = [v.email] if v and v.email else []
    if not to:
        raise RuleError("Add an email address for the vendor, or pick a contact to send it to.", 422)
    cc = (
        [email(x, "CC") for x in data.get("cc") or [] if str(x).strip()]
        if "cc" in data
        else (
            [c.email for c in contacts if c.cc_on_po and c.email and c.email not in to]
            + list(settings(org.id).get("default_cc") or [])
        )
    )
    pdf = po_pdf(po)
    name = f"{po_number(po)}.pdf"
    f = save_file(org.id, name, pdf, m.user_id, "application/pdf")
    attach(f, "purchase_order", po.id, "pdf")
    msg = text(data.get("message"), 4000, "Message")
    body = (msg + "\n\n" if msg else "") + f"Please find purchase order {po_number(po)} attached.\n\n{org.name}"
    for addr in to:
        send_email(
            addr,
            f"Purchase order {po_number(po)} from {org.name}",
            body,
            org_id=org.id,
            cc=cc,
            attachments=[{"file_id": f.id, "name": name}],
        )
        cc = []  # CC once
    po.sent_at = utcnow()
    emit(
        "purchase_order.sent",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=po_number(po),
        summary=f"Sent {po_number(po)} to {', '.join(to)}",
    )
    db.session.commit()
    return {"sent_to": to, "file_id": str(f.id)}


# ================================================================ low stock → POs (MP-044, r217)
def suggestions(org_id: uuid.UUID) -> list[dict[str, Any]]:
    """Parts under their minimum, grouped by preferred vendor, with a quantity that reaches the maximum (or minimum)."""
    from mpro.assets.models import Location
    from mpro.parts.models import Part, PartStock, PartVendor

    trig = get_settings(org_id, "parts").get("restock_trigger", "in_stock")
    rows = db.session.execute(
        select(PartStock, Part)
        .join(Part, Part.id == PartStock.part_id)
        .where(
            PartStock.org_id == org_id,
            Part.deleted_at.is_(None),
            Part.non_stock.is_(False),
            PartStock.min_qty.is_not(None),
        )
    ).all()
    groups: dict[str, dict[str, Any]] = {}
    loc_names = dict(db.session.execute(select(Location.id, Location.name).where(Location.org_id == org_id)).all())
    for stock, part in rows:
        level = (stock.on_hand or ZERO) - ((stock.reserved or ZERO) if trig == "available" else ZERO)
        mn = stock.min_qty
        if mn is None or level >= mn:
            continue
        pv = db.session.scalars(
            select(PartVendor)
            .where(PartVendor.part_id == part.id)
            .order_by(PartVendor.preferred.desc(), PartVendor.created_at)
        ).first()
        target = stock.max_qty if stock.max_qty is not None else mn
        # what's already on order counts (part-wide; per-location order tracking isn't kept)
        qty = target - level - (part.ordered or ZERO)
        if qty <= 0:
            continue
        key = str(pv.vendor_id) if pv else ""
        g = groups.setdefault(key, {"vendor_id": key or None, "vendor_name": None, "lines": []})
        g["lines"].append(
            {
                "part_id": str(part.id),
                "name": part.name,
                "part_number": part.part_number,
                "vendor_part_number": pv.vendor_part_number if pv else "",
                "location_id": str(stock.location_id) if stock.location_id else None,
                "location_name": loc_names.get(stock.location_id) if stock.location_id else None,
                "on_hand": num(stock.on_hand),
                "min_qty": num(stock.min_qty),
                "max_qty": num(stock.max_qty),
                "ordered": num(part.ordered),
                "quantity": num(qty),
                "unit": part.unit,
                "unit_cost": num(pv.unit_cost if pv and pv.unit_cost is not None else part.unit_cost),
            }
        )
    vids = [uid(k, "vendor") for k in groups if k]
    names = (
        dict(
            db.session.execute(
                select(Vendor.id, Vendor.name).where(Vendor.id.in_(vids), Vendor.deleted_at.is_(None))
            ).all()
        )
        if vids
        else {}
    )
    for k, g in groups.items():
        g["vendor_name"] = names.get(uid(k, "vendor")) if k else None
    return sorted(groups.values(), key=lambda g: (g["vendor_name"] is None, (g["vendor_name"] or "").lower()))


def po_from_suggestion(org: Organization, m: Membership, data: dict[str, Any]) -> PurchaseOrder:
    """{vendor_id (or null for no vendor), part_ids?: [...] } — one PO with those suggested lines."""
    want_vendor = str(data.get("vendor_id") or "")
    group = next((g for g in suggestions(org.id) if (g["vendor_id"] or "") == want_vendor), None)
    if group is None:
        raise RuleError("Nothing needs restocking from that vendor.", 404)
    only = {str(x) for x in data.get("part_ids") or []}
    lines = [
        {
            "part_id": ln["part_id"],
            "description": ln["name"],
            "part_number": ln["vendor_part_number"],
            "unit": ln["unit"],
            "quantity": ln["quantity"],
            "unit_cost": ln["unit_cost"] or "0",
            "location_id": ln["location_id"],
        }
        for ln in group["lines"]
        if not only or ln["part_id"] in only
    ]
    if not lines:
        raise RuleError("Pick at least one part.", 422)
    return create_purchase_order(org, m, {"vendor_id": group["vendor_id"], "lines": lines, "source": "low_stock"})


def po_from_work_order(org: Organization, m: Membership, wo: Any, data: dict[str, Any]) -> PurchaseOrder:
    """PO from a WO that uses parts (r258): its parts that aren't fully available, unless lines are given."""
    from mpro.parts.models import Part, PartVendor, WorkOrderPart

    lines = data.get("lines")
    vendor_id = data.get("vendor_id")
    if not lines:
        lines = []
        for wp in db.session.scalars(select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id)):
            part = db.session.get(Part, wp.part_id)
            if part is None or part.deleted_at is not None:
                continue
            need = (wp.quantity or ZERO) - (wp.used or ZERO)
            if need <= 0:
                continue
            pv = db.session.scalars(
                select(PartVendor).where(PartVendor.part_id == part.id).order_by(PartVendor.preferred.desc())
            ).first()
            if vendor_id is None and pv is not None:
                vendor_id = pv.vendor_id
            lines.append(
                {
                    "part_id": part.id,
                    "description": part.name,
                    "part_number": pv.vendor_part_number if pv else "",
                    "unit": part.unit,
                    "quantity": need,
                    "unit_cost": pv.unit_cost if pv and pv.unit_cost is not None else part.unit_cost,
                    "location_id": wp.location_id,
                }
            )
    if not lines:
        raise RuleError("This work order has no parts to order. Add lines to the purchase order instead.", 422)
    return create_purchase_order(
        org, m, {**data, "vendor_id": vendor_id, "lines": lines, "work_order_id": wo.id, "source": "work_order"}
    )


# ================================================================ export (CSV)
def export_csv(org_id: uuid.UUID, show_costs: bool) -> bytes:
    prefix = settings(org_id)["number_prefix"]
    names = dict(db.session.execute(select(Vendor.id, Vendor.name).where(Vendor.org_id == org_id)).all())
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "PO number",
            "Title",
            "Status",
            "Overdue",
            "Vendor",
            "Due date",
            "Currency",
            "Subtotal",
            "Taxes and costs",
            "Total",
            "Tax exempt",
            "Created",
            "Approved",
            "Completed",
            "Line",
            "Part number",
            "Quantity",
            "Received",
            "Unit cost",
        ]
    )
    for po in db.session.scalars(
        select(PurchaseOrder)
        .where(PurchaseOrder.org_id == org_id, PurchaseOrder.deleted_at.is_(None))
        .order_by(PurchaseOrder.number)
    ):
        head = [
            po_number(po, prefix),
            po.title,
            STATUS_LABELS[po.status],
            "yes" if is_overdue(po) else "",
            names.get(po.vendor_id, "") if po.vendor_id else "",
            po.due_on.isoformat() if po.due_on else "",
            po.currency,
            num(po.subtotal) if show_costs else "",
            num(po.extra_total) if show_costs else "",
            num(po.total) if show_costs else "",
            "yes" if po.tax_exempt else "",
            iso(po.created_at),
            iso(po.approved_at) or "",
            iso(po.completed_at) or "",
        ]
        lines: list[PurchaseOrderLine | None] = [*lines_of(po)] or [None]
        for ln in lines:
            w.writerow(
                [
                    _safe(x)
                    for x in head
                    + (
                        [
                            ln.description,
                            ln.part_number,
                            num(ln.quantity),
                            num(ln.received),
                            num(ln.unit_cost) if show_costs else "",
                        ]
                        if ln
                        else ["", "", "", "", ""]
                    )
                ]
            )
    return buf.getvalue().encode("utf-8-sig")


def _safe(v: Any) -> Any:
    """CSV injection guard: cells starting with = + - @ are prefixed with '."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v
