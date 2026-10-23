"""Vendor invoices with 3-way match (MP-092).

Intake by upload, email-in or by hand. Reading fills the header and lines. Matching compares each invoice line with
its purchase order line and with what was actually received:

    price      invoice unit price above the PO price by more than the tolerance (Settings: price_tolerance_pct)
    quantity   more billed than received (+ quantity_tolerance)
    unmatched  an invoice line with no PO line
    no_po      the invoice isn't tied to any purchase order
    tax_exempt tax charged although the PO was exempt or a valid certificate covers the vendor
    duplicate  the same vendor already sent an invoice with this number

No exceptions → Matched. Exceptions put it in the exceptions queue until fixed, disputed or approved with an override.
Approval follows the approval rules (applies_to "vendor_invoice"); approved invoices are read-only in the vault.
MPro records payments; it never moves money.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select

from mpro.core.events import emit
from mpro.core.files import FileObject, attach, file_dict, save_file
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.finance import reader, vault
from mpro.finance.common import (
    ZERO,
    cents,
    get_in_org,
    money,
    org_currency,
    page_args,
    paged,
    parse_date,
    s,
    today,
    user_label,
    vendor_label,
)
from mpro.finance.models import Payment, VendorInvoice, VendorInvoiceLine
from mpro.orgs.services import RuleError
from mpro.purchasing import approvals

EXCEPTION_LABELS = {
    "price": "Price changed",
    "quantity": "More billed than received",
    "unmatched": "Line not on the PO",
    "no_po": "No purchase order",
    "tax_exempt": "Tax charged though exempt",
    "duplicate": "Possible duplicate",
}


def title(inv: VendorInvoice) -> str:
    v = vendor_label(inv.vendor_id)
    return f"{v['name'] if v else 'Vendor'} invoice {inv.number or '(no number)'}"


def create(
    org_id: uuid.UUID,
    user: Any,
    *,
    file: tuple[str, bytes] | None = None,
    data: dict[str, Any] | None = None,
    source: str = "upload",
    ocr_text: str = "",
) -> VendorInvoice:
    inv = VendorInvoice(
        org_id=org_id,
        status="received",
        source=source,
        currency=org_currency(org_id),
        created_by_id=getattr(user, "id", None),
        purchase_order_ids=[],
        exceptions=[],
        extracted={},
    )
    db.session.add(inv)
    db.session.flush()
    text = ocr_text
    if file is not None:
        name, raw = file
        f = save_file(org_id, name, raw, getattr(user, "id", None))
        if not (f.content_type.startswith("image/") or f.content_type == "application/pdf"):
            raise RuleError("Invoices must be PDFs or pictures.", 422)
        attach(f, "vendor_invoice", inv.id, "file")
        inv.file_id = f.id
        if f.content_type == "application/pdf" and not text:
            text = reader.READERS["pdf_text"](raw)
    if text.strip():
        apply_reading(inv, text)
    if data:
        update(org_id, inv, data, user, rematch=False)
    _recompute(inv)
    match(org_id, inv)
    _index(inv)
    emit(
        "vendor_invoice.created",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary=f"Invoice received ({source})",
        org_id=org_id,
    )
    return inv


def apply_reading(inv: VendorInvoice, text: str) -> dict[str, Any]:
    from mpro.finance.receipts import _vendor_by_name
    from mpro.purchasing.models import PurchaseOrder

    got = reader.parse_invoice(text)
    inv.ocr_text = text[:100_000]
    keep = {k: v for k, v in (inv.extracted or {}).items() if k in ("email_from", "sender_verified")}
    inv.extracted = {**got, **keep}  # how it arrived isn't something a re-read may change
    if not inv.number and got.get("number"):
        inv.number = got["number"][:120]
    if inv.vendor_id is None and got.get("vendor_name"):
        inv.vendor_id = _vendor_by_name(inv.org_id, got["vendor_name"])
    if inv.invoice_date is None and got.get("invoice_date"):
        inv.invoice_date = parse_date(got["invoice_date"])
    if inv.due_date is None and got.get("due_date"):
        inv.due_date = parse_date(got["due_date"])
    if not inv.terms and got.get("terms"):
        _set_terms(inv, got["terms"])
    for k in ("tax", "shipping"):
        if got.get(k) is not None and not getattr(inv, k):
            setattr(inv, k, cents(Decimal(got[k])))
    if not inv.purchase_order_ids and got.get("po_numbers"):
        ids = []
        for n in got["po_numbers"]:
            q = select(PurchaseOrder).where(PurchaseOrder.org_id == inv.org_id, PurchaseOrder.deleted_at.is_(None))
            conds = [PurchaseOrder.custom_number == n]
            if n.isdigit():
                conds.append(PurchaseOrder.number == int(n))
            po = db.session.scalars(q.where(or_(*conds))).first()
            if po is not None:
                ids.append(str(po.id))
                inv.vendor_id = inv.vendor_id or po.vendor_id
        inv.purchase_order_ids = ids
    has_lines = db.session.scalar(
        select(func.count(VendorInvoiceLine.id)).where(VendorInvoiceLine.invoice_id == inv.id)
    )
    if not has_lines and got.get("lines"):
        for i, ln in enumerate(got["lines"]):
            db.session.add(
                VendorInvoiceLine(
                    org_id=inv.org_id,
                    invoice_id=inv.id,
                    sort=i,
                    description=ln["description"],
                    part_number=ln.get("part_number", ""),
                    quantity=Decimal(ln["quantity"]),
                    unit_price=Decimal(ln["unit_price"]),
                    amount=cents(Decimal(ln["amount"])),
                )
            )
        db.session.flush()
    if got.get("total") and not got.get("lines"):
        inv.subtotal = cents(Decimal(got["subtotal"])) if got.get("subtotal") else ZERO
    return got


def _set_terms(inv: VendorInvoice, terms: str) -> None:
    inv.terms = terms.strip()[:80]
    t = reader.parse_terms(inv.terms)
    if inv.invoice_date:
        if "net_days" in t and inv.due_date is None:
            inv.due_date = inv.invoice_date + timedelta(days=t["net_days"])
        if "discount_pct" in t:
            inv.discount_pct = Decimal(t["discount_pct"])
            inv.discount_until = inv.invoice_date + timedelta(days=t["discount_days"])


def assert_editable_status(inv: VendorInvoice) -> None:
    if inv.status == "pending":
        raise RuleError("This invoice is waiting for approval and can't be changed. Dispute it to change it.", 409)
    if inv.status in ("approved", "paid", "void"):
        raise RuleError(f"This invoice is {inv.status} and can't be edited.", 409)


def lock(inv: VendorInvoice) -> VendorInvoice:
    """Row-lock the invoice and reload it, so two approvals or payments at once see each other (review #1)."""
    db.session.flush()
    db.session.execute(select(VendorInvoice.id).where(VendorInvoice.id == inv.id).with_for_update())
    db.session.refresh(inv)
    return inv


def _skip_pending_steps(org_id: uuid.UUID, inv: VendorInvoice) -> None:
    for step in approvals.pending(org_id, "vendor_invoice", inv.id):
        step.status = "skipped"


def update(
    org_id: uuid.UUID, inv: VendorInvoice, data: dict[str, Any], user: Any, *, rematch: bool = True
) -> VendorInvoice:
    vault.assert_editable(org_id, "vendor_invoice", inv.id)
    assert_editable_status(inv)
    from mpro.assets.models import Location
    from mpro.purchasing.models import PurchaseOrder
    from mpro.vendors.models import Vendor

    if "vendor_id" in data:
        v = get_in_org(Vendor, org_id, data["vendor_id"], "vendor")
        inv.vendor_id = v.id if v else None
    if "number" in data:
        inv.number = str(data["number"] or "").strip()[:120]
    for k in ("invoice_date", "due_date", "discount_until"):
        if k in data:
            setattr(inv, k, parse_date(data[k], k.replace("_", " ")))
    if "terms" in data:
        _set_terms(inv, str(data["terms"] or ""))
    if "discount_pct" in data:
        inv.discount_pct = money(data["discount_pct"], "discount", allow_none=True)
    for k in ("tax", "shipping"):
        if k in data:
            setattr(inv, k, cents(money(data[k], k, allow_none=True)))
    if "currency" in data:
        c = str(data["currency"] or "").upper()
        if len(c) != 3:
            raise RuleError("Currency must be a 3-letter code.", 422)
        inv.currency = c
    if "category" in data:
        inv.category = str(data["category"] or "").strip()[:80]
    if "location_id" in data:
        loc = get_in_org(Location, org_id, data["location_id"], "location")
        inv.location_id = loc.id if loc else None
    if "purchase_order_ids" in data:
        ids = data["purchase_order_ids"] or []
        if not isinstance(ids, list) or len(ids) > 20:
            raise RuleError("Purchase orders must be a list.", 422)
        pos = [get_in_org(PurchaseOrder, org_id, x, "purchase order", allow_none=False) for x in ids]
        inv.purchase_order_ids = [str(p.id) for p in pos]
        if inv.vendor_id is None and pos:
            inv.vendor_id = pos[0].vendor_id
    if "lines" in data:
        _set_lines(org_id, inv, data["lines"])
    _recompute(inv)
    if rematch:
        match(org_id, inv)
    _index(inv)
    emit(
        "vendor_invoice.updated",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary="Edited",
        org_id=org_id,
    )
    return inv


def _set_lines(org_id: uuid.UUID, inv: VendorInvoice, lines: Any) -> None:
    from mpro.purchasing.models import PurchaseOrderLine

    if not isinstance(lines, list) or len(lines) > 500:
        raise RuleError("Lines must be a list (at most 500).", 422)
    for old in db.session.scalars(select(VendorInvoiceLine).where(VendorInvoiceLine.invoice_id == inv.id)):
        db.session.delete(old)
    db.session.flush()
    for i, ln in enumerate(lines):
        if not isinstance(ln, dict):
            raise RuleError("Each line must be an object.", 422)
        qty = money(ln.get("quantity", 1), "quantity")
        price = money(ln.get("unit_price", 0), "unit price")
        assert qty is not None and price is not None
        amount = money(ln.get("amount"), "amount", allow_none=True)
        pol = None
        if ln.get("po_line_id"):
            pol = get_in_org(PurchaseOrderLine, org_id, ln["po_line_id"], "PO line")
        db.session.add(
            VendorInvoiceLine(
                org_id=org_id,
                invoice_id=inv.id,
                sort=i,
                po_line_id=pol.id if pol else None,
                description=str(ln.get("description") or "")[:500],
                part_number=str(ln.get("part_number") or "")[:120],
                quantity=qty,
                unit_price=price,
                amount=cents(amount if amount is not None else qty * price),
            )
        )
    db.session.flush()


def _lines(inv: VendorInvoice) -> list[VendorInvoiceLine]:
    return list(
        db.session.scalars(
            select(VendorInvoiceLine).where(VendorInvoiceLine.invoice_id == inv.id).order_by(VendorInvoiceLine.sort)
        )
    )


def _recompute(inv: VendorInvoice) -> None:
    lines = _lines(inv)
    if lines:
        inv.subtotal = cents(sum((ln.amount for ln in lines), ZERO))
    inv.total = cents((inv.subtotal or ZERO) + (inv.tax or ZERO) + (inv.shipping or ZERO))


def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def match(org_id: uuid.UUID, inv: VendorInvoice) -> list[dict[str, Any]]:
    """3-way match. Updates line match statuses, the exceptions list and the status (Received ↔ Matched)."""
    from mpro.finance.certificates import exemption_for_po
    from mpro.finance.settings import finance_settings
    from mpro.parts.models import Part
    from mpro.purchasing.models import PurchaseOrder, PurchaseOrderLine

    if inv.status in ("approved", "paid", "void", "disputed"):
        return list(inv.exceptions or [])
    cfg = finance_settings(org_id)
    price_tol = Decimal(str(cfg.get("price_tolerance_pct") or "0")) / 100
    qty_tol = Decimal(str(cfg.get("quantity_tolerance") or "0"))
    exc: list[dict[str, Any]] = []
    pos = [p for p in (db.session.get(PurchaseOrder, uuid.UUID(x)) for x in inv.purchase_order_ids or []) if p]
    po_lines = [
        ln
        for p in pos
        for ln in db.session.scalars(
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.purchase_order_id == p.id)
            .order_by(PurchaseOrderLine.sort)
        )
    ]
    if not pos:
        exc.append({"kind": "no_po", "message": "This invoice isn't tied to a purchase order."})
    # what earlier invoices of these POs already billed, so a line isn't billed twice
    billed: dict[uuid.UUID, Decimal] = {}
    if po_lines:
        for ln, qty in db.session.execute(
            select(VendorInvoiceLine.po_line_id, func.sum(VendorInvoiceLine.quantity))
            .join(VendorInvoice, VendorInvoice.id == VendorInvoiceLine.invoice_id)
            .where(
                VendorInvoiceLine.po_line_id.in_([p.id for p in po_lines]),
                VendorInvoice.id != inv.id,
                VendorInvoice.deleted_at.is_(None),
                VendorInvoice.status.notin_(("void", "disputed")),
            )
            .group_by(VendorInvoiceLine.po_line_id)
        ):
            if ln is not None:
                billed[ln] = qty or ZERO
    used: set[uuid.UUID] = set()
    for ln in _lines(inv):
        pol = next((p for p in po_lines if p.id == ln.po_line_id), None) if ln.po_line_id else None
        if pol is None and po_lines:
            pn = _norm(ln.part_number)
            for p in po_lines:
                if p.id in used:
                    continue
                part_no = ""
                if p.part_id:
                    part = db.session.get(Part, p.part_id)
                    part_no = part.part_number if part else ""
                if pn and pn in {_norm(p.part_number), _norm(part_no)}:
                    pol = p
                    break
            if pol is None:
                d = _norm(ln.description)
                pol = next(
                    (
                        p
                        for p in po_lines
                        if p.id not in used and d and (_norm(p.description) in d or d in _norm(p.description))
                    ),
                    None,
                )
            if pol is not None:
                ln.po_line_id = pol.id
        if pol is None:
            ln.match_status = "unmatched" if pos else ""
            if pos:
                exc.append(
                    {
                        "kind": "unmatched",
                        "line_id": str(ln.id),
                        "message": f"“{ln.description or ln.part_number}” isn't on the purchase order.",
                    }
                )
            continue
        used.add(pol.id)
        status = "ok"
        if pol.unit_cost is not None and ln.unit_price > pol.unit_cost * (1 + price_tol):
            status = "price"
            exc.append(
                {
                    "kind": "price",
                    "line_id": str(ln.id),
                    "message": f"{ln.description or pol.description}: billed {ln.unit_price} each, "
                    f"PO says {pol.unit_cost}.",
                }
            )
        allowed = (pol.received or ZERO) - billed.get(pol.id, ZERO) + qty_tol
        if ln.quantity > allowed:
            status = "quantity" if status == "ok" else status
            exc.append(
                {
                    "kind": "quantity",
                    "line_id": str(ln.id),
                    "message": f"{ln.description or pol.description}: billed {_q(ln.quantity)}, "
                    f"received {_q(pol.received or ZERO)}"
                    + (f" (already billed {_q(billed[pol.id])})" if billed.get(pol.id) else "")
                    + ".",
                }
            )
        ln.match_status = status
    if inv.tax and inv.tax > ZERO:
        exempt_po = next((p for p in pos if p.tax_exempt), None)
        cert = None
        if exempt_po is None and inv.vendor_id is not None:
            cert = exemption_for_po(org_id, inv.vendor_id, None, inv.location_id)
        if exempt_po is not None or cert is not None:
            exc.append(
                {
                    "kind": "tax_exempt",
                    "message": f"Tax of {inv.tax} was charged, but "
                    + (
                        "the purchase order is tax-exempt."
                        if exempt_po
                        else "a tax exemption certificate covers this vendor."
                    ),
                }
            )
    if inv.number and inv.vendor_id:
        dup = db.session.scalar(
            select(VendorInvoice.id).where(
                VendorInvoice.org_id == org_id,
                VendorInvoice.id != inv.id,
                VendorInvoice.deleted_at.is_(None),
                VendorInvoice.vendor_id == inv.vendor_id,
                func.lower(VendorInvoice.number) == inv.number.lower(),
                VendorInvoice.status != "void",
            )
        )
        if dup:
            exc.append(
                {
                    "kind": "duplicate",
                    "message": "This vendor already sent an invoice with this number.",
                    "other_id": str(dup),
                }
            )
    inv.exceptions = exc
    if inv.status in ("received", "matched"):
        if exc:
            inv.status, inv.matched_at = "received", None
        else:
            inv.status, inv.matched_at = "matched", utcnow()
    db.session.flush()
    return exc


def _q(d: Decimal) -> str:
    return format(d.normalize(), "f") if d != d.to_integral() else str(int(d))


def _facts(inv: VendorInvoice) -> dict[str, Any]:
    return {
        "total": inv.total or ZERO,
        "currency": inv.currency,
        "location_id": str(inv.location_id) if inv.location_id else None,
        "vendor_id": str(inv.vendor_id) if inv.vendor_id else None,
        "category": inv.category,
        "custom": {},
    }


def submit_for_approval(
    org_id: uuid.UUID, inv: VendorInvoice, user: Any, *, override: bool, can_override: bool
) -> VendorInvoice:
    """Start approval. Exceptions block it unless someone allowed to approve overrides them."""
    lock(inv)
    if inv.status not in ("received", "matched"):
        raise RuleError(f"A {inv.status} invoice can't be approved.", 409)
    if inv.exceptions and not (override and can_override):
        raise RuleError("Resolve the exceptions first, or approve with an override.", 409)
    res = approvals.start(org_id, "vendor_invoice", inv.id, _facts(inv))
    if res in ("none", "auto_approved"):
        if res == "none" and not can_override:
            raise RuleError("Only people who approve invoices can approve this one.", 403)
        _approved(org_id, inv, user)
    else:
        inv.status = "pending"
        emit(
            "vendor_invoice.approval_requested",
            entity_type="vendor_invoice",
            entity_id=inv.id,
            entity_label=title(inv),
            summary="Sent for approval",
            org_id=org_id,
        )
    return inv


def _approved(org_id: uuid.UUID, inv: VendorInvoice, user: Any) -> None:
    inv.status = "approved"
    inv.approved_at, inv.approved_by_id = utcnow(), getattr(user, "id", None)
    vault.lock(org_id, "vendor_invoice", inv.id)
    emit(
        "vendor_invoice.approved",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary="Approved",
        org_id=org_id,
    )


def decide(
    org_id: uuid.UUID, inv: VendorInvoice, user: Any, member: Any, approve: bool, comment: str, is_admin: bool
) -> VendorInvoice:
    from mpro.workorders.services import team_ids_of

    lock(inv)
    if inv.status != "pending":
        raise RuleError("This invoice isn't waiting for approval.", 409)
    teams = {str(t) for t in team_ids_of(org_id, user.id)}
    res = approvals.decide(
        org_id, "vendor_invoice", inv.id, approve=approve, user=user, team_ids=teams, is_admin=is_admin, comment=comment
    )
    if res == "approved":
        _approved(org_id, inv, user)
    elif res == "rejected":
        inv.status, inv.dispute_note = "disputed", comment.strip()[:2000]
        emit(
            "vendor_invoice.disputed",
            entity_type="vendor_invoice",
            entity_id=inv.id,
            entity_label=title(inv),
            summary="Rejected by approver",
            org_id=org_id,
        )
    return inv


def set_status(org_id: uuid.UUID, inv: VendorInvoice, action: str, note: str = "") -> VendorInvoice:
    lock(inv)
    if action == "dispute":
        if inv.status in ("paid", "void"):
            raise RuleError(f"A {inv.status} invoice can't be disputed.", 409)
        if not note.strip():
            raise RuleError("Say what's disputed.", 422)
        inv.status, inv.dispute_note = "disputed", note.strip()[:2000]
        _skip_pending_steps(org_id, inv)
    elif action == "reopen":
        if inv.status != "disputed":
            raise RuleError("Only disputed invoices can be reopened.", 409)
        inv.status = "received"
        match(org_id, inv)
    elif action == "void":
        if inv.status == "paid":
            raise RuleError("A paid invoice can't be voided.", 409)
        if inv.status == "approved" and paid_total(inv.id) > ZERO:
            raise RuleError("Payments are recorded on this invoice, so it can't be voided.", 409)
        inv.status = "void"
        _skip_pending_steps(org_id, inv)
    else:
        raise RuleError("Unknown action.", 422)
    emit(
        f"vendor_invoice.{inv.status}",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary=inv.status.capitalize() + (f": {note.strip()[:200]}" if note.strip() else ""),
        org_id=org_id,
    )
    return inv


def paid_total(inv_id: uuid.UUID) -> Decimal:
    return (
        db.session.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.vendor_invoice_id == inv_id))
        or ZERO
    )


def record_payment(org_id: uuid.UUID, inv: VendorInvoice, data: dict[str, Any], user: Any) -> Payment:
    lock(inv)
    if inv.status != "approved":
        raise RuleError("Approve the invoice before recording a payment.", 409)
    amount = money(data.get("amount"), "amount")
    assert amount is not None
    if amount <= ZERO:
        raise RuleError("Enter the amount paid.", 422)
    left = (inv.total or ZERO) - paid_total(inv.id)
    if cents(amount) > left:
        raise RuleError(f"Only {inv.currency} {left} is left to pay on this invoice.", 422)
    method = str(data.get("method") or "").lower()
    if method not in ("ach", "check", "card", "wire", "cash", "other", ""):
        raise RuleError("Pick a payment method.", 422)
    p = Payment(
        org_id=org_id,
        direction="out",
        vendor_invoice_id=inv.id,
        paid_on=parse_date(data.get("paid_on"), "payment date") or today(),
        amount=cents(amount),
        currency=inv.currency,
        method=method,
        reference=str(data.get("reference") or "")[:120],
        recorded_by_id=user.id,
    )
    db.session.add(p)
    db.session.flush()
    if paid_total(inv.id) >= (inv.total or ZERO):
        inv.status, inv.paid_at = "paid", utcnow()
    emit(
        "vendor_invoice.payment",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary=f"Payment recorded: {inv.currency} {p.amount}",
        org_id=org_id,
    )
    return p


def delete(org_id: uuid.UUID, inv: VendorInvoice) -> None:
    vault.assert_deletable(org_id, "vendor_invoice", inv.id)
    if inv.status in ("approved", "paid"):
        raise RuleError("Approved invoices can't be deleted; void them instead.", 409)
    inv.deleted_at = utcnow()
    emit(
        "vendor_invoice.deleted",
        entity_type="vendor_invoice",
        entity_id=inv.id,
        entity_label=title(inv),
        summary="Deleted",
        org_id=org_id,
    )


def _index(inv: VendorInvoice) -> None:
    vault.index(
        inv.org_id,
        "vendor_invoice",
        "vendor_invoice",
        inv.id,
        title=title(inv),
        file_id=inv.file_id,
        vendor_id=inv.vendor_id,
        doc_date=inv.invoice_date,
        amount=inv.total,
        currency=inv.currency,
        search_text=f"{inv.number} {inv.terms} {inv.category}",
    )


def line_dict(ln: VendorInvoiceLine) -> dict[str, Any]:
    from mpro.purchasing.models import PurchaseOrderLine

    pol = db.session.get(PurchaseOrderLine, ln.po_line_id) if ln.po_line_id else None
    return {
        "id": str(ln.id),
        "description": ln.description,
        "part_number": ln.part_number,
        "quantity": s(ln.quantity),
        "unit_price": s(ln.unit_price),
        "amount": s(ln.amount),
        "match_status": ln.match_status,
        "po_line": {
            "id": str(pol.id),
            "description": pol.description,
            "quantity": s(pol.quantity),
            "unit_cost": s(pol.unit_cost),
            "received": s(pol.received),
        }
        if pol
        else None,
    }


def invoice_dict(inv: VendorInvoice, *, detail: bool = False) -> dict[str, Any]:
    from mpro.purchasing.models import PurchaseOrder

    f = db.session.get(FileObject, inv.file_id) if inv.file_id else None
    paid = paid_total(inv.id)
    on = today()
    d: dict[str, Any] = {
        "id": str(inv.id),
        "title": title(inv),
        "vendor": vendor_label(inv.vendor_id),
        "number": inv.number,
        "status": inv.status,
        "source": inv.source,
        # email-in: From can be faked; only a DKIM pass for the From domain counts as verified (review #10)
        "sender_verified": inv.source != "email" or bool((inv.extracted or {}).get("sender_verified")),
        "email_from": (inv.extracted or {}).get("email_from", "") if inv.source == "email" else "",
        "file": file_dict(f) if f and f.deleted_at is None else None,
        "invoice_date": inv.invoice_date.isoformat() if inv.invoice_date else None,
        "due_date": inv.due_date.isoformat() if inv.due_date else None,
        "overdue": bool(inv.due_date and inv.due_date < on and inv.status not in ("paid", "void")),
        "terms": inv.terms,
        "discount_pct": s(inv.discount_pct),
        "discount_until": inv.discount_until.isoformat() if inv.discount_until else None,
        "currency": inv.currency,
        "subtotal": s(inv.subtotal),
        "tax": s(inv.tax),
        "shipping": s(inv.shipping),
        "total": s(inv.total),
        "paid": s(paid),
        "balance": s((inv.total or ZERO) - paid),
        "exceptions": [
            {**e, "label": EXCEPTION_LABELS.get(e.get("kind", ""), e.get("kind"))} for e in inv.exceptions or []
        ],
        "category": inv.category,
        "location_id": str(inv.location_id) if inv.location_id else None,
        "purchase_orders": [
            {
                "id": str(p.id),
                "number": p.custom_number or f"PO-{p.number}",
                "status": p.status,
                "total": s(p.total),
                "tax_exempt": p.tax_exempt,
            }
            for p in (db.session.get(PurchaseOrder, uuid.UUID(x)) for x in inv.purchase_order_ids or [])
            if p
        ],
        "approved_at": iso(inv.approved_at),
        "approved_by": user_label(inv.approved_by_id),
        "paid_at": iso(inv.paid_at),
        "dispute_note": inv.dispute_note,
        "created_at": iso(inv.created_at),
        "locked": vault.is_locked(inv.org_id, "vendor_invoice", inv.id),
    }
    if detail:
        d["lines"] = [line_dict(ln) for ln in _lines(inv)]
        d["approvals"] = [
            {
                "id": str(a.id),
                "status": a.status,
                "approver_user_ids": a.approver_user_ids,
                "approver_team_ids": a.approver_team_ids,
                "decided_by": user_label(a.decided_by_id),
                "decided_at": iso(a.decided_at),
                "comment": a.comment,
            }
            for a in approvals_for(inv)
        ]
        d["payments"] = [
            {
                "id": str(p.id),
                "paid_on": p.paid_on.isoformat(),
                "amount": s(p.amount),
                "method": p.method,
                "reference": p.reference,
                "recorded_by": user_label(p.recorded_by_id),
            }
            for p in db.session.scalars(
                select(Payment).where(Payment.vendor_invoice_id == inv.id).order_by(Payment.paid_on)
            )
        ]
        d["extracted"] = inv.extracted or {}
    return d


def approvals_for(inv: VendorInvoice) -> list[Any]:
    from mpro.purchasing.models import Approval

    return list(
        db.session.scalars(
            select(Approval)
            .where(
                Approval.org_id == inv.org_id, Approval.entity_type == "vendor_invoice", Approval.entity_id == inv.id
            )
            .order_by(Approval.created_at)
        )
    )


def list_invoices(org_id: uuid.UUID, args: dict[str, Any]) -> dict[str, Any]:
    q = select(VendorInvoice).where(VendorInvoice.org_id == org_id, VendorInvoice.deleted_at.is_(None))
    st = args.get("status")
    if st == "exceptions":
        q = q.where(VendorInvoice.status == "received")
    elif st == "unpaid":
        q = q.where(VendorInvoice.status.in_(("received", "matched", "pending", "approved")))
    elif st == "overdue":
        q = q.where(VendorInvoice.status.notin_(("paid", "void")), VendorInvoice.due_date < today())
    elif st:
        q = q.where(VendorInvoice.status.in_(str(st).split(",")))
    for k in ("vendor_id",):
        if args.get(k):
            try:
                q = q.where(VendorInvoice.vendor_id == uuid.UUID(str(args[k])))
            except ValueError:
                return {"items": [], "total": 0, "page": 1, "per_page": 50}
    if args.get("q"):
        q = q.where(VendorInvoice.number.ilike(f"%{str(args['q']).strip()[:80]}%"))
    q = q.order_by(VendorInvoice.due_date.asc().nulls_last(), VendorInvoice.created_at.desc())
    if st == "exceptions":  # comparing JSON isn't portable (PostgreSQL json has no "="): filter in Python
        page, per = page_args(args)
        rows = [i for i in db.session.scalars(q.limit(5000)) if i.exceptions]
        items = [invoice_dict(i) for i in rows[(page - 1) * per : page * per]]
        return {"items": items, "total": len(rows), "page": page, "per_page": per}
    return paged(q, args, invoice_dict)


def reminders(on: date | None = None) -> int:
    """Daily: due-date reminders (3 days before) and early-payment discount deadlines (2 days before)."""
    from mpro.auth.models import User
    from mpro.orgs.models import Membership

    on = on or today()
    n = 0
    rows = db.session.scalars(
        select(VendorInvoice).where(
            VendorInvoice.deleted_at.is_(None),
            VendorInvoice.status.in_(("matched", "pending", "approved")),
            or_(
                VendorInvoice.due_date == on + timedelta(days=3), VendorInvoice.discount_until == on + timedelta(days=2)
            ),
        )
    ).all()
    for inv in rows:
        emails = sorted(
            set(
                db.session.scalars(
                    select(User.email)
                    .join(Membership, Membership.user_id == User.id)
                    .where(
                        Membership.org_id == inv.org_id,
                        Membership.role.in_(("owner", "admin")),
                        Membership.deleted_at.is_(None),
                    )
                )
            )
        )
        if inv.discount_until == on + timedelta(days=2) and inv.discount_pct:
            subject = f"Pay by {inv.discount_until:%b %d} for a {inv.discount_pct}% discount: {title(inv)}"
        else:
            subject = f"Invoice due {inv.due_date:%b %d}: {title(inv)}"
        body = (
            f"{title(inv)} for {inv.currency} {inv.total} is {inv.status}.\n\n"
            "Open Finance → Vendor invoices to pay or approve it."
        )
        for e in emails:
            send_email(e, subject, body, org_id=inv.org_id)
            n += 1
    db.session.commit()
    return n


# ---------------------------------------------------------------- reports


def vendor_spend(org_id: uuid.UUID, start: date, end: date) -> list[dict[str, Any]]:
    from mpro.purchasing.models import PurchaseOrder

    rows = db.session.execute(
        select(VendorInvoice.vendor_id, func.count(VendorInvoice.id), func.sum(VendorInvoice.total))
        .where(
            VendorInvoice.org_id == org_id,
            VendorInvoice.deleted_at.is_(None),
            VendorInvoice.status.in_(("approved", "paid")),
            VendorInvoice.invoice_date >= start,
            VendorInvoice.invoice_date <= end,
        )
        .group_by(VendorInvoice.vendor_id)
    ).all()
    out = []
    for vid, count, total in rows:
        paid = db.session.scalars(
            select(VendorInvoice).where(
                VendorInvoice.org_id == org_id,
                VendorInvoice.vendor_id == vid,
                VendorInvoice.status == "paid",
                VendorInvoice.invoice_date >= start,
                VendorInvoice.invoice_date <= end,
            )
        ).all()
        on_time_pay = sum(1 for p in paid if p.due_date is None or (p.paid_at and p.paid_at.date() <= p.due_date))
        pos = (
            db.session.scalars(
                select(PurchaseOrder).where(
                    PurchaseOrder.org_id == org_id,
                    PurchaseOrder.vendor_id == vid,
                    PurchaseOrder.completed_at.is_not(None),
                    PurchaseOrder.due_on.is_not(None),
                )
            ).all()
            if vid
            else []
        )
        delivered = [p for p in pos if p.completed_at and start <= p.completed_at.date() <= end]
        on_time_del = sum(1 for p in delivered if p.completed_at and p.due_on and p.completed_at.date() <= p.due_on)
        out.append(
            {
                "vendor": vendor_label(vid),
                "invoices": int(count),
                "spend": s(cents(total or ZERO)),
                "paid_on_time_pct": round(100 * on_time_pay / len(paid)) if paid else None,
                "delivered_on_time_pct": round(100 * on_time_del / len(delivered)) if delivered else None,
                "deliveries": len(delivered),
            }
        )
    out.sort(key=lambda x: Decimal(str(x["spend"] or "0")), reverse=True)
    return out


def spend_csv(rows: list[dict[str, Any]]) -> bytes:
    out: list[list[Any]] = [["Vendor", "Invoices", "Spend", "Paid on time %", "Delivered on time %", "Deliveries"]]
    for r in rows:
        out.append(
            [
                (r["vendor"] or {}).get("name", "(no vendor)"),
                r["invoices"],
                r["spend"],
                r["paid_on_time_pct"] or "",
                r["delivered_on_time_pct"] or "",
                r["deliveries"],
            ]
        )
    return vault._csv(out)
