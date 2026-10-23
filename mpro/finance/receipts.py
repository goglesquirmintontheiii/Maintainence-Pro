"""Receipts: capture, read and match (MP-091), company cards and reimbursements.

A receipt arrives from the phone camera (pages photographed in the browser), an upload, or the email-in mailbox. The
browser reads it with OCR and the server parses the text into suggested fields; the person confirms or fixes them.
Then it is attached to what it was for — a work order cost, a purchase order, a part restock or a general expense —
with suggestions by vendor, amount and date. Sales tax charged although a valid exemption covered that vendor and
jurisdiction is flagged into a "tax to reclaim" list.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, or_, select

from mpro.core.events import emit
from mpro.core.files import FileObject, attach, file_dict, links_for, read_bytes, save_file
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
    paged,
    parse_date,
    s,
    today,
    user_label,
    vendor_label,
)
from mpro.finance.models import CardTransaction, PaymentCard, Receipt
from mpro.orgs.services import RuleError

EDITABLE = (
    "vendor_name",
    "purchased_on",
    "subtotal",
    "tax",
    "total",
    "currency",
    "card_last4",
    "region",
    "lines",
    "expense_category",
    "paid_personally",
    "vendor_id",
    "card_id",
)


def _hash(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def create(
    org_id: uuid.UUID,
    user: Any,
    files: list[tuple[str, bytes]],
    *,
    source: str = "upload",
    ocr_text: str = "",
    fields: dict[str, Any] | None = None,
    work_order_id: Any = None,
) -> Receipt:
    """Store the pages (first one is the receipt's main file) and read what we can."""
    if source not in ("camera", "upload", "email"):
        raise RuleError("Unknown receipt source.", 422)
    if not files and not fields:
        raise RuleError("Add a photo or file of the receipt.", 422)
    if len(files) > 20:
        raise RuleError("A receipt can have up to 20 pages.", 422)
    r = Receipt(
        org_id=org_id,
        source=source,
        status="new",
        submitted_by_id=getattr(user, "id", None),
        currency=org_currency(org_id),
        lines=[],
        extracted={},
    )
    db.session.add(r)
    db.session.flush()
    text = ocr_text or ""
    for i, (name, data) in enumerate(files):
        f = save_file(org_id, name, data, getattr(user, "id", None))
        if not (f.content_type.startswith("image/") or f.content_type == "application/pdf"):
            raise RuleError("Receipts must be pictures or PDFs.", 422)
        attach(f, "receipt", r.id, "file" if i == 0 else "page")
        if i == 0:
            r.file_id = f.id
            r.image_hash = _hash(data)
        if f.content_type == "application/pdf" and not ocr_text:
            text += "\n" + reader.READERS["pdf_text"](data)
    if text.strip():
        apply_reading(r, text, "pdf_text" if not ocr_text else "browser_ocr")
    if fields:
        update(org_id, r, fields, user, confirm=False)
    if work_order_id:
        from mpro.workorders.models import WorkOrder

        wo = get_in_org(WorkOrder, org_id, work_order_id, "work order")
        r.work_order_id = wo.id if wo else None
    check_tax(r)
    _detect_duplicate(r)
    _index(r)
    emit(
        "receipt.created",
        entity_type="receipt",
        entity_id=r.id,
        entity_label=title(r),
        summary=f"Receipt added ({source})",
        org_id=org_id,
    )
    return r


def apply_reading(r: Receipt, text: str, reader_name: str) -> dict[str, Any]:
    """Parse OCR / PDF text and fill the fields that are still empty (people's own edits win)."""
    got = reader.parse_receipt(text)
    r.ocr_text = text[:100_000]
    r.reader = reader_name
    r.extracted = got
    if not r.vendor_name and got.get("vendor_name"):
        r.vendor_name = got["vendor_name"]
        r.vendor_id = r.vendor_id or _vendor_by_name(r.org_id, got["vendor_name"])
    if r.purchased_on is None and got.get("purchased_on"):
        r.purchased_on = parse_date(got["purchased_on"])
    for k in ("subtotal", "tax", "total"):
        if getattr(r, k) is None and got.get(k) is not None:
            setattr(r, k, cents(Decimal(got[k])))
    if not r.card_last4 and got.get("card_last4"):
        r.card_last4 = got["card_last4"]
    if not r.lines and got.get("lines"):
        r.lines = got["lines"]
    if r.card_id is None and r.card_last4:
        card = db.session.scalars(
            select(PaymentCard).where(
                PaymentCard.org_id == r.org_id, PaymentCard.last4 == r.card_last4, PaymentCard.deleted_at.is_(None)
            )
        ).first()
        r.card_id = card.id if card else None
    return got


def _vendor_by_name(org_id: uuid.UUID, name: str) -> uuid.UUID | None:
    from mpro.vendors.models import Vendor

    n = name.strip().lower()
    if len(n) < 3:
        return None
    for v in db.session.scalars(select(Vendor).where(Vendor.org_id == org_id, Vendor.deleted_at.is_(None))):
        vn = v.name.strip().lower()
        if vn == n or (len(vn) >= 4 and (vn in n or n in vn)):
            return v.id
    return None


def title(r: Receipt) -> str:
    parts = [r.vendor_name or "Receipt"]
    if r.purchased_on:
        parts.append(f"{r.purchased_on:%b %d, %Y}")
    if r.total is not None:
        parts.append(f"{r.currency} {r.total}")
    return " · ".join(parts)


def update(org_id: uuid.UUID, r: Receipt, data: dict[str, Any], user: Any, *, confirm: bool | None = None) -> Receipt:
    vault.assert_editable(org_id, "receipt", r.id)
    from mpro.vendors.models import Vendor

    for k in EDITABLE:
        if k not in data:
            continue
        v = data[k]
        if k in ("subtotal", "tax", "total"):
            d = money(v, k, allow_none=True)
            setattr(r, k, cents(d) if d is not None else None)
        elif k == "purchased_on":
            r.purchased_on = parse_date(v, "purchase date")
        elif k == "vendor_id":
            vend = get_in_org(Vendor, org_id, v, "vendor")
            r.vendor_id = vend.id if vend else None
            if vend and not r.vendor_name:
                r.vendor_name = vend.name
        elif k == "card_id":
            card = get_in_org(PaymentCard, org_id, v, "card")
            r.card_id = card.id if card else None
            if card:
                r.card_last4 = card.last4
        elif k == "card_last4":
            t = str(v or "").strip()
            if t and (len(t) != 4 or not t.isdigit()):
                raise RuleError("Card: enter the last 4 digits.", 422)
            r.card_last4 = t
        elif k == "lines":
            if not isinstance(v, list) or len(v) > 200:
                raise RuleError("Lines must be a list.", 422)
            r.lines = [
                {
                    "description": str(x.get("description") or "")[:200],
                    "quantity": str(money(x.get("quantity", 1), "quantity")),
                    "unit_price": str(money(x.get("unit_price", 0), "price")),
                    "amount": str(money(x.get("amount", 0), "amount")),
                }
                for x in v
                if isinstance(x, dict)
            ]
        elif k == "paid_personally":
            r.paid_personally = bool(v)
        elif k == "currency":
            t = str(v or "").upper()
            if len(t) != 3:
                raise RuleError("Currency must be a 3-letter code.", 422)
            r.currency = t
        else:
            setattr(r, k, str(v or "").strip()[: 255 if k != "region" else 80])
    if r.subtotal is not None and r.tax is not None and r.total is None:
        r.total = r.subtotal + r.tax
    if confirm is None:
        confirm = bool(data.get("confirm"))
    if confirm:
        if r.total is None:
            raise RuleError("Enter the receipt total before confirming.", 422)
        if r.status in ("new", "duplicate"):
            r.status = "confirmed"
    if data.get("not_duplicate"):
        r.duplicate_of_id = None
        if r.status == "duplicate":
            r.status = "new"
    check_tax(r)
    _detect_duplicate(r)
    _index(r)
    emit(
        "receipt.updated", entity_type="receipt", entity_id=r.id, entity_label=title(r), summary="Edited", org_id=org_id
    )
    return r


def check_tax(r: Receipt) -> None:
    """Flag tax charged although a valid exemption covered the vendor and jurisdiction."""
    from mpro.finance.certificates import covering_certificate, norm_country

    if not r.tax or r.tax <= ZERO or r.vendor_id is None:
        if r.tax_flagged and r.tax_reclaim_status == "to_reclaim":
            r.tax_flagged, r.tax_reclaim_status, r.tax_certificate_id = False, "", None
        return
    region, country = r.region, ""
    from mpro.vendors.models import Vendor

    v = db.session.get(Vendor, r.vendor_id)
    addr = (v.address or {}) if v else {}
    region = region or str(addr.get("region") or "")
    country = norm_country(str(addr.get("country") or "")) or "US"
    cert = covering_certificate(r.org_id, vendor_id=r.vendor_id, country=country, region=region, on=r.purchased_on)
    if cert is not None:
        r.tax_flagged, r.tax_certificate_id = True, cert.id
        if r.tax_reclaim_status in ("", None):
            r.tax_reclaim_status = "to_reclaim"
    elif r.tax_reclaim_status == "to_reclaim":
        r.tax_flagged, r.tax_reclaim_status, r.tax_certificate_id = False, "", None


def _detect_duplicate(r: Receipt) -> None:
    from mpro.finance.settings import finance_settings

    window = int(finance_settings(r.org_id).get("duplicate_window_days") or 7)
    conds = []
    if r.image_hash:
        conds.append(Receipt.image_hash == r.image_hash)
    if r.total is not None and r.purchased_on is not None and (r.vendor_id or r.vendor_name):
        same_vendor = (
            Receipt.vendor_id == r.vendor_id
            if r.vendor_id
            else func.lower(Receipt.vendor_name) == r.vendor_name.lower()
        )
        conds.append(
            and_(
                same_vendor,
                Receipt.total == r.total,
                Receipt.purchased_on.between(
                    r.purchased_on - timedelta(days=window), r.purchased_on + timedelta(days=window)
                ),
            )
        )
    if not conds or (r.extracted or {}).get("not_duplicate"):
        return
    other = db.session.scalars(
        select(Receipt)
        .where(Receipt.org_id == r.org_id, Receipt.id != r.id, Receipt.deleted_at.is_(None), or_(*conds))
        .order_by(Receipt.created_at)
    ).first()
    if other is not None and r.duplicate_of_id is None and r.status in ("new",):
        r.duplicate_of_id = other.id
        r.status = "duplicate"


def _index(r: Receipt) -> None:
    vault.index(
        r.org_id,
        "receipt",
        "receipt",
        r.id,
        title=title(r),
        file_id=r.file_id,
        vendor_id=r.vendor_id,
        work_order_id=r.work_order_id,
        doc_date=r.purchased_on,
        amount=r.total,
        currency=r.currency,
        search_text=f"{r.vendor_name} {r.expense_category} {r.card_last4} {r.ocr_text[:2000]}",
    )


def attach_to(org_id: uuid.UUID, r: Receipt, data: dict[str, Any], member: Any) -> Receipt:
    """{target: work_order|purchase_order|part|expense, id, quantity?, location_id?, category?, cost_type?}"""
    from mpro.core.permissions import can

    target = data.get("target")
    if r.status == "duplicate":
        raise RuleError("This looks like a duplicate. Mark it as not a duplicate first.", 409)
    if r.total is None:
        raise RuleError("Enter the receipt total first.", 422)
    if target == "work_order":
        from mpro.workorders.models import CostEntry, WorkOrder
        from mpro.workorders.services import can_see

        wo = get_in_org(WorkOrder, org_id, data.get("id"), "work order", allow_none=False)
        if not can_see(member, wo) or not can(member, "wo.time"):
            raise RuleError("You can't add costs to that work order.", 403)
        if r.cost_entry_id:
            old = db.session.get(CostEntry, r.cost_entry_id)
            if old is not None and old.org_id == org_id:
                db.session.delete(old)
        ce = CostEntry(
            org_id=org_id,
            work_order_id=wo.id,
            user_id=member.user_id,
            amount_cents=int((cents(r.total) * 100).to_integral_value()),
            cost_type=str(data.get("cost_type") or r.expense_category or "Parts")[:60],
            description=f"Receipt: {title(r)}"[:500],
            created_by_id=member.user_id,
        )
        db.session.add(ce)
        db.session.flush()
        r.work_order_id, r.cost_entry_id = wo.id, ce.id
        fo = db.session.get(FileObject, r.file_id) if r.file_id else None
        if fo is not None:
            attach(fo, "cost", ce.id, "receipt")  # shows as the cost's receipt on the work order
        emit(
            "work_order.cost_added",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=wo.title,
            summary=f"Receipt cost {r.currency} {r.total}",
            data={"receipt_id": r.id},
            org_id=org_id,
        )
    elif target == "purchase_order":
        from mpro.purchasing.models import PurchaseOrder

        if not can(member, "po.view"):
            raise RuleError("You can't see purchase orders.", 403)
        po = get_in_org(PurchaseOrder, org_id, data.get("id"), "purchase order", allow_none=False)
        r.purchase_order_id = po.id
        r.vendor_id = r.vendor_id or po.vendor_id
    elif target == "part":
        from mpro.parts import ledger
        from mpro.parts.models import Part

        if not can(member, "parts.stock"):
            raise RuleError("You can't restock parts.", 403)
        part = get_in_org(Part, org_id, data.get("id"), "part", allow_none=False)
        qty = money(data.get("quantity", 1), "quantity")
        assert qty is not None
        if qty <= ZERO:
            raise RuleError("Enter how many were bought.", 422)
        loc_id = None
        if data.get("location_id"):
            from mpro.assets.models import Location

            loc_id = get_in_org(Location, org_id, data["location_id"], "location").id
        import mpro.parts.settings  # noqa: F401  (registers the parts defaults)
        from mpro.core.settings import get_settings

        avg = bool(get_settings(org_id, "parts").get("moving_average_cost"))
        unit = ((r.total - (r.tax or ZERO)) / qty).quantize(Decimal("0.0001"))
        ledger.record(
            org_id,
            part.id,
            loc_id,
            "restock",
            qty,
            unit_cost=unit,
            note=f"Receipt: {title(r)}",
            user_id=member.user_id,
            update_average_cost=avg,
        )
        r.part_id = part.id
    elif target == "expense":
        cat = str(data.get("category") or r.expense_category or "").strip()[:80]
        if not cat:
            raise RuleError("Pick an expense category.", 422)
        r.expense_category = cat
    else:
        raise RuleError("Attach it to a work order, purchase order, part or expense.", 422)
    if r.status in ("new", "confirmed"):
        r.status = "matched"
    _index(r)
    emit(
        "receipt.matched",
        entity_type="receipt",
        entity_id=r.id,
        entity_label=title(r),
        summary=f"Attached to {target}",
        data={"target": target, "target_id": str(data.get("id") or "")},
        org_id=org_id,
    )
    return r


def suggestions(org_id: uuid.UUID, r: Receipt, member: Any) -> dict[str, Any]:
    """Likely matches by vendor, amount and date."""
    from mpro.purchasing.models import PurchaseOrder
    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import visibility_filter

    out: dict[str, Any] = {"purchase_orders": [], "work_orders": [], "card_transactions": []}
    d = r.purchased_on or (r.created_at.date() if r.created_at else today())
    if r.total is not None:
        tol = max(Decimal("0.01"), (r.total * Decimal("0.02")).quantize(Decimal("0.01")))
        q = select(PurchaseOrder).where(
            PurchaseOrder.org_id == org_id,
            PurchaseOrder.deleted_at.is_(None),
            PurchaseOrder.status != "canceled",
            PurchaseOrder.total.between(r.total - tol, r.total + tol),
        )
        if r.vendor_id:
            q = q.where(PurchaseOrder.vendor_id == r.vendor_id)
        for po in db.session.scalars(q.order_by(PurchaseOrder.created_at.desc()).limit(5)):
            out["purchase_orders"].append(
                {
                    "id": str(po.id),
                    "number": po.custom_number or f"PO-{po.number}",
                    "total": s(po.total),
                    "vendor": vendor_label(po.vendor_id),
                }
            )
        cq = select(CardTransaction).where(
            CardTransaction.org_id == org_id,
            CardTransaction.receipt_id.is_(None),
            CardTransaction.amount == r.total,
            CardTransaction.posted_on.between(d - timedelta(days=5), d + timedelta(days=5)),
        )
        for t in db.session.scalars(cq.limit(5)):
            out["card_transactions"].append(txn_dict(t))
    wq = (
        select(WorkOrder)
        .where(
            WorkOrder.org_id == org_id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.activity_at >= utcnow() - timedelta(days=14),
            visibility_filter(member),
        )
        .order_by(WorkOrder.activity_at.desc())
        .limit(8)
    )
    for wo in db.session.scalars(wq):
        out["work_orders"].append({"id": str(wo.id), "number": wo.number, "title": wo.title, "status": wo.status})
    return out


def reclaim(org_id: uuid.UUID, r: Receipt, status: str) -> Receipt:
    if status not in ("to_reclaim", "reclaimed", "waived", ""):
        raise RuleError("Pick reclaimed, waived or to reclaim.", 422)
    r.tax_reclaim_status = status
    emit(
        "receipt.tax_reclaim",
        entity_type="receipt",
        entity_id=r.id,
        entity_label=title(r),
        summary=f"Tax reclaim: {status or 'cleared'}",
        org_id=org_id,
    )
    return r


def reimbursement(org_id: uuid.UUID, r: Receipt, action: str, user: Any, can_approve: bool) -> Receipt:
    """Personal-card purchases: request → approve / reject → exported → paid."""
    if action == "request":
        if r.submitted_by_id != user.id and not can_approve:
            raise RuleError("Only the person who paid can ask to be reimbursed.", 403)
        if r.total is None:
            raise RuleError("Enter the receipt total first.", 422)
        r.paid_personally = True
        r.reimbursement_status = "requested"
    elif action in ("approve", "reject"):
        if not can_approve:
            raise RuleError("You can't approve reimbursements.", 403)
        if r.reimbursement_status != "requested":
            raise RuleError("There's no reimbursement request to decide.", 409)
        if r.submitted_by_id == user.id:
            raise RuleError("Someone else has to approve your own reimbursement.", 403)
        r.reimbursement_status = "approved" if action == "approve" else "rejected"
        r.reimbursement_decided_by_id = user.id
        if action == "approve":
            vault.lock(org_id, "receipt", r.id)
    elif action == "paid":
        if not can_approve:
            raise RuleError("You can't mark reimbursements paid.", 403)
        if r.reimbursement_status not in ("approved", "exported"):
            raise RuleError("Approve the reimbursement first.", 409)
        r.reimbursement_status = "paid"
    else:
        raise RuleError("Unknown reimbursement action.", 422)
    emit(
        "receipt.reimbursement",
        entity_type="receipt",
        entity_id=r.id,
        entity_label=title(r),
        summary=f"Reimbursement {r.reimbursement_status}",
        org_id=org_id,
    )
    return r


def receipt_dict(r: Receipt, *, detail: bool = False) -> dict[str, Any]:
    f = db.session.get(FileObject, r.file_id) if r.file_id else None
    d: dict[str, Any] = {
        "id": str(r.id),
        "title": title(r),
        "source": r.source,
        "status": r.status,
        "file": file_dict(f) if f and f.deleted_at is None else None,
        "vendor": vendor_label(r.vendor_id),
        "vendor_name": r.vendor_name,
        "purchased_on": r.purchased_on.isoformat() if r.purchased_on else None,
        "currency": r.currency,
        "subtotal": s(r.subtotal),
        "tax": s(r.tax),
        "total": s(r.total),
        "card_last4": r.card_last4,
        "card_id": str(r.card_id) if r.card_id else None,
        "region": r.region,
        "work_order_id": str(r.work_order_id) if r.work_order_id else None,
        "purchase_order_id": str(r.purchase_order_id) if r.purchase_order_id else None,
        "part_id": str(r.part_id) if r.part_id else None,
        "expense_category": r.expense_category,
        "tax_flagged": r.tax_flagged,
        "tax_reclaim_status": r.tax_reclaim_status,
        "tax_certificate_id": str(r.tax_certificate_id) if r.tax_certificate_id else None,
        "paid_personally": r.paid_personally,
        "reimbursement_status": r.reimbursement_status,
        "duplicate_of_id": str(r.duplicate_of_id) if r.duplicate_of_id else None,
        "submitted_by": user_label(r.submitted_by_id),
        "created_at": iso(r.created_at),
        "locked": vault.is_locked(r.org_id, "receipt", r.id),
    }
    if detail:
        d["lines"] = list(r.lines or [])
        d["extracted"] = r.extracted or {}
        d["reader"] = r.reader
        d["pages"] = [file_dict(ln.file, ln.role, ln.id) for ln in links_for("receipt", r.id)]
    return d


def list_receipts(org_id: uuid.UUID, args: dict[str, Any], *, see_all: bool, user_id: uuid.UUID) -> dict[str, Any]:
    q = select(Receipt).where(Receipt.org_id == org_id, Receipt.deleted_at.is_(None))
    if not see_all or args.get("mine") == "1":
        q = q.where(Receipt.submitted_by_id == user_id)
    if args.get("status"):
        q = q.where(Receipt.status.in_(str(args["status"]).split(",")))
    if args.get("tax_reclaim"):
        q = q.where(Receipt.tax_reclaim_status == args["tax_reclaim"])
    if args.get("reimbursement"):
        q = q.where(Receipt.reimbursement_status == args["reimbursement"])
    for k in ("work_order_id", "purchase_order_id", "vendor_id", "card_id"):
        if args.get(k):
            try:
                q = q.where(getattr(Receipt, k) == uuid.UUID(str(args[k])))
            except ValueError:
                return {"items": [], "total": 0, "page": 1, "per_page": 50}
    if args.get("q"):
        like = f"%{str(args['q']).strip()[:80]}%"
        q = q.where(or_(Receipt.vendor_name.ilike(like), Receipt.expense_category.ilike(like)))
    q = q.order_by(Receipt.purchased_on.desc().nulls_first(), Receipt.created_at.desc())
    return paged(q, args, receipt_dict)


def delete(org_id: uuid.UUID, r: Receipt) -> None:
    vault.assert_deletable(org_id, "receipt", r.id)
    if r.cost_entry_id:
        from mpro.workorders.models import CostEntry

        ce = db.session.get(CostEntry, r.cost_entry_id)
        if ce is not None and ce.org_id == org_id:
            db.session.delete(ce)
    r.deleted_at = utcnow()
    emit(
        "receipt.deleted",
        entity_type="receipt",
        entity_id=r.id,
        entity_label=title(r),
        summary="Deleted",
        org_id=org_id,
    )


# ---------------------------------------------------------------- company cards and statements


def card_dict(c: PaymentCard) -> dict[str, Any]:
    unmatched = (
        db.session.scalar(
            select(func.count(CardTransaction.id)).where(
                CardTransaction.card_id == c.id, CardTransaction.status.in_(("unmatched", "chased"))
            )
        )
        or 0
    )
    return {
        "id": str(c.id),
        "name": c.name,
        "last4": c.last4,
        "holder": user_label(c.holder_user_id),
        "active": c.active,
        "unmatched": int(unmatched),
    }


def save_card(org_id: uuid.UUID, c: PaymentCard | None, data: dict[str, Any]) -> PaymentCard:
    from mpro.finance.certificates import _member_ids

    if c is None:
        c = PaymentCard(org_id=org_id, name="", last4="")
        db.session.add(c)
    if "name" in data or not c.name:
        c.name = str(data.get("name") or "").strip()[:120]
        if not c.name:
            raise RuleError("Name the card.", 422)
    if "last4" in data or not c.last4:
        t = str(data.get("last4") or "").strip()
        if len(t) != 4 or not t.isdigit():
            raise RuleError("Enter the card's last 4 digits.", 422)
        c.last4 = t
    if "holder_user_id" in data:
        ids = _member_ids(org_id, [data["holder_user_id"]] if data["holder_user_id"] else [])
        c.holder_user_id = uuid.UUID(ids[0]) if ids else None
    if "active" in data:
        c.active = bool(data["active"])
    db.session.flush()
    emit(
        "payment_card.saved",
        entity_type="payment_card",
        entity_id=c.id,
        entity_label=f"{c.name} ••{c.last4}",
        summary="Saved",
        org_id=org_id,
    )
    return c


def txn_dict(t: CardTransaction) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "card_id": str(t.card_id),
        "posted_on": t.posted_on.isoformat(),
        "merchant": t.merchant,
        "amount": s(t.amount),
        "currency": t.currency,
        "status": t.status,
        "receipt_id": str(t.receipt_id) if t.receipt_id else None,
        "chased_at": iso(t.chased_at),
    }


_DATE_H = ("date", "transaction date", "posted date", "post date", "posting date", "trans. date")
_DESC_H = ("description", "merchant", "payee", "details", "name", "merchant name")
_AMT_H = ("amount", "debit", "charge", "amount (usd)", "transaction amount")


def import_statement(org_id: uuid.UUID, card: PaymentCard, data: bytes) -> dict[str, Any]:
    """CSV with date, description/merchant and amount columns (most bank exports work). Matches receipts."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise RuleError("That file is empty.", 422)
    head = [h.strip().lower() for h in rows[0]]

    def col(names: tuple[str, ...]) -> int:
        for n in names:
            if n in head:
                return head.index(n)
        return -1

    di, mi, ai = col(_DATE_H), col(_DESC_H), col(_AMT_H)
    ci = col(("credit",))
    if di < 0 or ai < 0:
        raise RuleError("The CSV needs a Date column and an Amount (or Debit) column.", 422)
    import_id = utcnow().strftime("%Y%m%d%H%M%S")
    added = skipped = 0
    cur = org_currency(org_id)
    for row in rows[1:5001]:
        if len(row) <= max(di, ai):
            continue
        dt = None
        from mpro.finance.reader import parse_date as pd

        dt = pd(row[di])
        raw = row[ai].strip() or (row[ci].strip() if ci >= 0 and len(row) > ci else "")
        if dt is None or not raw:
            skipped += 1
            continue
        try:
            amt = money(raw.replace("(", "-").replace(")", ""), "amount", allow_negative=True)
        except RuleError:
            skipped += 1
            continue
        assert amt is not None
        amt = abs(amt)  # charges are positive in MPro whichever sign the bank uses
        merchant = row[mi].strip()[:255] if mi >= 0 and len(row) > mi else ""
        exists = db.session.scalar(
            select(CardTransaction.id).where(
                CardTransaction.card_id == card.id,
                CardTransaction.posted_on == dt,
                CardTransaction.amount == cents(amt),
                CardTransaction.merchant == merchant,
            )
        )
        if exists:
            skipped += 1
            continue
        db.session.add(
            CardTransaction(
                org_id=org_id,
                card_id=card.id,
                import_id=import_id,
                posted_on=dt,
                merchant=merchant,
                amount=cents(amt),
                currency=cur,
                status="unmatched",
            )
        )
        added += 1
    db.session.flush()
    matched = reconcile(org_id, card)
    emit(
        "payment_card.statement_imported",
        entity_type="payment_card",
        entity_id=card.id,
        entity_label=f"{card.name} ••{card.last4}",
        summary=f"Imported {added} transactions, matched {matched}",
        org_id=org_id,
    )
    return {"added": added, "skipped": skipped, "matched": matched}


def reconcile(org_id: uuid.UUID, card: PaymentCard) -> int:
    """Match unmatched transactions to receipts on the same card: same amount, within 4 days."""
    n = 0
    for t in db.session.scalars(
        select(CardTransaction).where(
            CardTransaction.card_id == card.id, CardTransaction.status.in_(("unmatched", "chased"))
        )
    ):
        r = db.session.scalars(
            select(Receipt).where(
                Receipt.org_id == org_id,
                Receipt.deleted_at.is_(None),
                or_(Receipt.card_id == card.id, Receipt.card_last4 == card.last4),
                Receipt.total == t.amount,
                or_(
                    Receipt.purchased_on.is_(None),
                    Receipt.purchased_on.between(t.posted_on - timedelta(days=4), t.posted_on + timedelta(days=1)),
                ),
                ~Receipt.id.in_(select(CardTransaction.receipt_id).where(CardTransaction.receipt_id.is_not(None))),
            )
        ).first()
        if r is not None:
            t.receipt_id, t.status = r.id, "matched"
            r.card_id = card.id
            n += 1
    db.session.flush()
    return n


def set_txn(org_id: uuid.UUID, t: CardTransaction, data: dict[str, Any]) -> CardTransaction:
    if "receipt_id" in data:
        r = get_in_org(Receipt, org_id, data["receipt_id"], "receipt")
        t.receipt_id = r.id if r else None
        t.status = "matched" if r else "unmatched"
    if data.get("status") in ("ignored", "unmatched"):
        t.status = data["status"]
        if t.status == "unmatched":
            t.receipt_id = None
    emit(
        "card_transaction.updated",
        entity_type="payment_card",
        entity_id=t.card_id,
        summary=f"Transaction {t.status}",
        data={"transaction_id": t.id},
        org_id=org_id,
    )
    return t


def chase(org_id: uuid.UUID, card: PaymentCard) -> int:
    """Email the card holder the charges that still have no receipt."""
    from mpro.auth.models import User

    missing = db.session.scalars(
        select(CardTransaction)
        .where(CardTransaction.card_id == card.id, CardTransaction.status.in_(("unmatched", "chased")))
        .order_by(CardTransaction.posted_on)
    ).all()
    if not missing:
        return 0
    holder = db.session.get(User, card.holder_user_id) if card.holder_user_id else None
    if holder is None:
        raise RuleError("Set the card holder first; they get the reminder.", 422)
    lines = "\n".join(
        f"- {t.posted_on:%b %d}  {t.merchant or 'Unknown merchant'}  {t.currency} {t.amount}" for t in missing
    )
    send_email(
        holder.email,
        f"Receipts needed for {card.name} ••{card.last4}",
        f"Hello {holder.name},\n\n"
        f"These charges on {card.name} (ending {card.last4}) have no receipt yet:\n\n{lines}\n\n"
        "Add the receipts in MPro (Finance → Receipts), or forward them to the receipts email address.",
        org_id=org_id,
    )
    now = utcnow()
    for t in missing:
        t.status, t.chased_at = "chased", now
    emit(
        "payment_card.chased",
        entity_type="payment_card",
        entity_id=card.id,
        entity_label=card.name,
        summary=f"Asked {holder.name} for {len(missing)} receipts",
        org_id=org_id,
    )
    return len(missing)


def reimbursement_csv(org_id: uuid.UUID) -> tuple[bytes, list[Receipt]]:
    rows = db.session.scalars(
        select(Receipt)
        .where(Receipt.org_id == org_id, Receipt.deleted_at.is_(None), Receipt.reimbursement_status == "approved")
        .order_by(Receipt.purchased_on)
    ).all()
    from mpro.auth.models import User

    out: list[list[Any]] = [["Employee", "Email", "Date", "Vendor", "Category", "Amount", "Currency", "Receipt id"]]
    for r in rows:
        u = db.session.get(User, r.submitted_by_id) if r.submitted_by_id else None
        out.append(
            [
                u.name if u else "",
                u.email if u else "",
                r.purchased_on.isoformat() if r.purchased_on else "",
                r.vendor_name,
                r.expense_category,
                r.total or ZERO,
                r.currency,
                str(r.id),
            ]
        )
    return vault._csv(out), list(rows)


def read_page(f: FileObject) -> bytes:
    return read_bytes(f)
