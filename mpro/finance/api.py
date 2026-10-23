"""Purchasing finance (0.5.0) REST API (/api/v1): receipts, cards, vendor invoices, customer invoices, tax exemption
certificates, the documents vault, reports and finance settings (MP-090–MP-094)."""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, current_app, g, request
from sqlalchemy import func, select

from mpro.core.files import (
    Export,
    FileError,
    FileObject,
    export_dict,
    exporter,
    max_upload_bytes,
    read_bytes,
    register_entity,
    request_export,
)
from mpro.core.jobs import job, periodic
from mpro.core.permissions import can
from mpro.core.tenancy import get_scoped, require
from mpro.extensions import db
from mpro.finance import billing, certificates, inbox, invoices, receipts, vault
from mpro.finance.common import parse_date, s, today
from mpro.finance.models import (
    CardTransaction,
    CustomerInvoice,
    FinanceDocument,
    PaymentCard,
    Receipt,
    TaxCertificate,
    VendorInvoice,
)
from mpro.finance.settings import finance_settings, public_settings, update_settings
from mpro.orgs.services import RuleError

bp = APIBlueprint("finance", __name__, url_prefix="/api/v1", tag="Finance")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    if request.mimetype == "multipart/form-data":
        out: dict[str, Any] = dict(request.form)
        if out.get("fields"):
            try:
                out["fields"] = json.loads(out["fields"])
            except ValueError:
                abort(422, message="fields must be JSON.")
            if not isinstance(out["fields"], dict):
                abort(422, message="fields must be a JSON object.")
        return out
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def uploads(name: str = "files", max_files: int = 20) -> list[tuple[str, bytes]]:
    limit = max_upload_bytes(g.org)
    out = []
    for f in request.files.getlist(name)[:max_files]:
        data = f.stream.read(limit + 1)
        if len(data) > limit:
            abort(413, message=f"Files can be up to {limit // (1024 * 1024)} MB.")
        if data:
            out.append((f.filename or "file", data))
    return out


def ok(**k: Any) -> dict[str, Any]:
    db.session.commit()
    return {"ok": True, **k}


def m() -> Any:
    return g.membership


def _need(action: str) -> None:
    if not can(m(), action):
        abort(403, message="You don't have permission to do that.")


def _dates() -> tuple[date, date]:
    end = guard(parse_date, request.args.get("end"), "end date") or today()
    start = guard(parse_date, request.args.get("start"), "start date") or end.replace(month=1, day=1)
    if start > end:
        abort(422, message="The start date is after the end date.")
    return start, end


def _csv_response(name: str, rows: list[list[Any]]) -> Response:
    return Response(
        vault._csv(rows), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'}
    )


# ---------------------------------------------------------------- me / settings


@bp.get("/finance/me")
@require("finance.receipts")
def me() -> dict[str, Any]:
    """What this person can do in Finance (the UI shows only Receipts to technicians), plus email-in addresses."""
    actions = (
        "finance.view",
        "finance.receipts",
        "finance.invoices",
        "finance.invoices.approve",
        "finance.customer_invoices",
        "finance.tax_certificates",
        "finance.export",
    )
    cfg = public_settings(g.org.id)
    if can(m(), "finance.tax_certificates"):
        has_cards = 1
    else:  # exemption cards this person may show
        has_cards = certificates.list_certs(g.org.id, {}, manage=False, user_id=g.user.id)["total"]
    return {
        "can": {a: can(m(), a) for a in actions},
        "receipts_address": cfg.get("receipts_address", ""),
        "invoices_address": cfg.get("invoices_address", "") if can(m(), "finance.invoices") else "",
        "expense_categories": cfg.get("expense_categories") or [],
        "currency": g.org.currency,
        "has_certificates": bool(has_cards),
    }


@bp.get("/finance/settings")
@require("finance.view")
def get_settings() -> dict[str, Any]:
    from mpro.cloud.payments import status

    return {**public_settings(g.org.id), "payment_links": status(g.org)}


@bp.patch("/finance/settings")
@require("finance.export")
def patch_settings() -> dict[str, Any]:
    out = guard(update_settings, g.org.id, body())
    db.session.commit()
    return out


@bp.post("/finance/settings/inbox-test")
@require("finance.export")
def inbox_test() -> dict[str, Any]:
    """Check now: reads new mail in the email-in mailbox (also runs every 5 minutes)."""
    cfg = finance_settings(g.org.id)
    if not cfg.get("inbox_enabled"):
        abort(409, message="Turn email-in on first.")
    try:
        n = inbox.poll_org(g.org.id)
    except inbox.HostError as e:
        db.session.rollback()
        abort(422, message=f"{e} Set MPRO_ALLOW_PRIVATE_MAIL_HOSTS=1 to allow it.")
    except Exception as e:  # noqa: BLE001
        # never echo the server's reply: it would turn this into a probe of other hosts and ports (review #10)
        db.session.rollback()
        current_app.logger.warning("Finance email-in check for org %s failed: %s", g.org.id, e)
        abort(502, message="Couldn't read the mailbox. Check the server, port, user name and password.")
    return ok(created=n)


@bp.post("/finance/settings/inbox-secret")
@require("finance.export")
def regenerate_inbox_secret() -> dict[str, Any]:
    """New email-in addresses; the old ones stop working."""
    from mpro.finance.settings import regenerate_inbox_secret as regen

    out = regen(g.org.id)
    db.session.commit()
    return out


@bp.get("/finance/summary")
@require("finance.view")
def summary() -> dict[str, Any]:
    oid = g.org.id

    def count(q: Any) -> int:
        return int(db.session.scalar(q) or 0)

    soon = today() + timedelta(days=60)
    return {
        "receipts_new": count(
            select(func.count(Receipt.id)).where(
                Receipt.org_id == oid, Receipt.deleted_at.is_(None), Receipt.status.in_(("new", "duplicate"))
            )
        ),
        "tax_to_reclaim": count(
            select(func.count(Receipt.id)).where(
                Receipt.org_id == oid, Receipt.deleted_at.is_(None), Receipt.tax_reclaim_status == "to_reclaim"
            )
        ),
        "reimbursements_requested": count(
            select(func.count(Receipt.id)).where(
                Receipt.org_id == oid, Receipt.deleted_at.is_(None), Receipt.reimbursement_status == "requested"
            )
        ),
        "invoice_exceptions": len(invoices.list_invoices(oid, {"status": "exceptions", "per_page": 200})["items"]),
        "invoices_unpaid": count(
            select(func.count(VendorInvoice.id)).where(
                VendorInvoice.org_id == oid,
                VendorInvoice.deleted_at.is_(None),
                VendorInvoice.status.in_(("received", "matched", "pending", "approved")),
            )
        ),
        "customer_overdue": count(
            select(func.count(CustomerInvoice.id)).where(
                CustomerInvoice.org_id == oid, CustomerInvoice.deleted_at.is_(None), CustomerInvoice.status == "overdue"
            )
        ),
        "certificates_expiring": count(
            select(func.count(TaxCertificate.id)).where(
                TaxCertificate.org_id == oid,
                TaxCertificate.deleted_at.is_(None),
                TaxCertificate.status == "active",
                TaxCertificate.expires_on.is_not(None),
                TaxCertificate.expires_on <= soon,
            )
        ),
        "unmatched_card_charges": count(
            select(func.count(CardTransaction.id)).where(
                CardTransaction.org_id == oid, CardTransaction.status.in_(("unmatched", "chased"))
            )
        ),
    }


# ---------------------------------------------------------------- receipts


def _receipt(rid: str) -> Receipt:
    r = get_scoped(Receipt, rid)
    if r.submitted_by_id != g.user.id and not can(m(), "finance.view"):
        abort(404)
    return r


@bp.get("/finance/receipts")
@require("finance.receipts")
def list_receipts() -> dict[str, Any]:
    return receipts.list_receipts(g.org.id, dict(request.args), see_all=can(m(), "finance.view"), user_id=g.user.id)


@bp.post("/finance/receipts")
@require("finance.receipts")
def create_receipt() -> dict[str, Any]:
    """Multipart: files (pages, first is the receipt), source camera|upload, ocr_text, fields (JSON), work_order_id.
    JSON: {fields, work_order_id} for a receipt typed in by hand."""
    data = body()
    files = uploads() if request.mimetype == "multipart/form-data" else []
    wo_id = data.get("work_order_id")
    if wo_id:
        _visible_wo(wo_id)
    r = guard(
        receipts.create,
        g.org.id,
        g.user,
        files,
        source=str(data.get("source") or "upload"),
        ocr_text=str(data.get("ocr_text") or "")[:100_000],
        fields=data.get("fields") or None,
        work_order_id=wo_id,
    )
    db.session.commit()
    return receipts.receipt_dict(r, detail=True)


@bp.get("/finance/receipts/<rid>")
@require("finance.receipts")
def get_receipt(rid: str) -> dict[str, Any]:
    return receipts.receipt_dict(_receipt(rid), detail=True)


@bp.patch("/finance/receipts/<rid>")
@require("finance.receipts")
def patch_receipt(rid: str) -> dict[str, Any]:
    r = _receipt(rid)
    data = body()
    guard(receipts.update, g.org.id, r, data, g.user, confirm=data.get("confirm"))
    db.session.commit()
    return receipts.receipt_dict(r, detail=True)


@bp.post("/finance/receipts/<rid>/read")
@require("finance.receipts")
def read_receipt(rid: str) -> dict[str, Any]:
    """{text}: OCR text read in the browser. Fills the fields that are still empty."""
    r = _receipt(rid)
    guard(vault.assert_editable, g.org.id, "receipt", r.id)
    text = str(body().get("text") or "")[:100_000]
    got = receipts.apply_reading(r, text, "browser_ocr")
    guard(receipts.check_tax, r)
    db.session.commit()
    return {**receipts.receipt_dict(r, detail=True), "found": got}


@bp.get("/finance/receipts/<rid>/suggestions")
@require("finance.receipts")
def receipt_suggestions(rid: str) -> dict[str, Any]:
    return receipts.suggestions(g.org.id, _receipt(rid), m())


@bp.post("/finance/receipts/<rid>/attach")
@require("finance.receipts")
def attach_receipt(rid: str) -> dict[str, Any]:
    r = _receipt(rid)
    guard(vault.assert_editable, g.org.id, "receipt", r.id)
    guard(receipts.attach_to, g.org.id, r, body(), m())
    db.session.commit()
    return receipts.receipt_dict(r, detail=True)


@bp.post("/finance/receipts/<rid>/not-duplicate")
@require("finance.receipts")
def not_duplicate(rid: str) -> dict[str, Any]:
    r = _receipt(rid)
    if r.status == "duplicate":
        r.status, r.duplicate_of_id = "new", None
    db.session.commit()
    return receipts.receipt_dict(r, detail=True)


@bp.post("/finance/receipts/<rid>/reclaim")
@require("finance.view")
def reclaim_receipt(rid: str) -> dict[str, Any]:
    r = _receipt(rid)
    guard(receipts.reclaim, g.org.id, r, str(body().get("status") or ""))
    db.session.commit()
    return receipts.receipt_dict(r)


@bp.post("/finance/receipts/<rid>/reimbursement")
@require("finance.receipts")
def receipt_reimbursement(rid: str) -> dict[str, Any]:
    """{action: request | approve | reject | paid}"""
    r = _receipt(rid)
    guard(
        receipts.reimbursement,
        g.org.id,
        r,
        str(body().get("action") or ""),
        g.user,
        can(m(), "finance.invoices.approve"),
    )
    db.session.commit()
    return receipts.receipt_dict(r)


@bp.delete("/finance/receipts/<rid>")
@require("finance.receipts")
def delete_receipt(rid: str) -> dict[str, Any]:
    r = _receipt(rid)
    if r.submitted_by_id != g.user.id and not can(m(), "finance.invoices"):
        abort(403, message="You can delete only your own receipts.")
    guard(receipts.delete, g.org.id, r)
    return ok()


def _visible_wo(wo_id: Any) -> Any:
    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import can_see

    wo = get_scoped(WorkOrder, str(wo_id))
    if not can_see(m(), wo):
        abort(404)
    return wo


@bp.get("/finance/work-orders/<wid>/receipts")
@require("finance.receipts")
def wo_receipts(wid: str) -> dict[str, Any]:
    """The Receipts section on a work order: receipts attached to it (all of them for finance, else your own)."""
    wo = _visible_wo(wid)
    q = select(Receipt).where(Receipt.org_id == g.org.id, Receipt.deleted_at.is_(None), Receipt.work_order_id == wo.id)
    if not can(m(), "finance.view"):
        q = q.where(Receipt.submitted_by_id == g.user.id)
    rows = db.session.scalars(q.order_by(Receipt.created_at.desc()).limit(100)).all()
    return {"items": [receipts.receipt_dict(r) for r in rows]}


# ---------------------------------------------------------------- company cards


@bp.get("/finance/cards")
@require("finance.view")
def list_cards() -> dict[str, Any]:
    rows = db.session.scalars(
        select(PaymentCard)
        .where(PaymentCard.org_id == g.org.id, PaymentCard.deleted_at.is_(None))
        .order_by(PaymentCard.name)
    ).all()
    return {"items": [receipts.card_dict(c) for c in rows]}


@bp.post("/finance/cards")
@require("finance.invoices")
def create_card() -> dict[str, Any]:
    c = guard(receipts.save_card, g.org.id, None, body())
    db.session.commit()
    return receipts.card_dict(c)


@bp.patch("/finance/cards/<cid>")
@require("finance.invoices")
def patch_card(cid: str) -> dict[str, Any]:
    c = guard(receipts.save_card, g.org.id, get_scoped(PaymentCard, cid), body())
    db.session.commit()
    return receipts.card_dict(c)


@bp.delete("/finance/cards/<cid>")
@require("finance.invoices")
def delete_card(cid: str) -> dict[str, Any]:
    from mpro.core.models import utcnow

    get_scoped(PaymentCard, cid).deleted_at = utcnow()
    return ok()


@bp.get("/finance/cards/<cid>/transactions")
@require("finance.view")
def card_transactions(cid: str) -> dict[str, Any]:
    c = get_scoped(PaymentCard, cid)
    q = select(CardTransaction).where(CardTransaction.card_id == c.id)
    st = request.args.get("status")
    if st == "missing":
        q = q.where(CardTransaction.status.in_(("unmatched", "chased")))
    elif st:
        q = q.where(CardTransaction.status == st)
    rows = db.session.scalars(q.order_by(CardTransaction.posted_on.desc()).limit(1000)).all()
    return {"card": receipts.card_dict(c), "items": [receipts.txn_dict(t) for t in rows]}


@bp.post("/finance/cards/<cid>/statement")
@require("finance.invoices")
def import_statement(cid: str) -> dict[str, Any]:
    c = get_scoped(PaymentCard, cid)
    files = uploads("file", 1)
    if not files:
        abort(422, message="Choose the statement CSV.")
    res = guard(receipts.import_statement, g.org.id, c, files[0][1])
    return ok(**res)


@bp.post("/finance/cards/<cid>/reconcile")
@require("finance.invoices")
def reconcile_card(cid: str) -> dict[str, Any]:
    return ok(matched=guard(receipts.reconcile, g.org.id, get_scoped(PaymentCard, cid)))


@bp.post("/finance/cards/<cid>/chase")
@require("finance.invoices")
def chase_card(cid: str) -> dict[str, Any]:
    return ok(chased=guard(receipts.chase, g.org.id, get_scoped(PaymentCard, cid)))


@bp.patch("/finance/card-transactions/<tid>")
@require("finance.invoices")
def patch_txn(tid: str) -> dict[str, Any]:
    t = guard(receipts.set_txn, g.org.id, get_scoped(CardTransaction, tid), body())
    db.session.commit()
    return receipts.txn_dict(t)


@bp.post("/finance/reimbursements/export")
@require("finance.invoices.approve")
def export_reimbursements() -> dict[str, Any]:
    ex = guard(request_export, g.org.id, g.user.id, "finance.reimbursements", "Approved reimbursements", {})
    db.session.commit()
    return export_dict(ex)


# ---------------------------------------------------------------- vendor invoices


@bp.get("/finance/vendor-invoices")
@require("finance.view")
def list_vendor_invoices() -> dict[str, Any]:
    return invoices.list_invoices(g.org.id, dict(request.args))


@bp.post("/finance/vendor-invoices")
@require("finance.invoices")
def create_vendor_invoice() -> dict[str, Any]:
    """Multipart: file, ocr_text, fields (JSON). JSON: the invoice typed in (number, vendor_id, lines, …)."""
    data = body()
    files = uploads("file", 1) if request.mimetype == "multipart/form-data" else []
    fields = data.get("fields") if request.mimetype == "multipart/form-data" else data
    inv = guard(
        invoices.create,
        g.org.id,
        g.user,
        file=files[0] if files else None,
        data=fields or None,
        source="upload" if files else "manual",
        ocr_text=str(data.get("ocr_text") or "")[:100_000],
    )
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.get("/finance/vendor-invoices/<iid>")
@require("finance.view")
def get_vendor_invoice(iid: str) -> dict[str, Any]:
    return invoices.invoice_dict(get_scoped(VendorInvoice, iid), detail=True)


@bp.patch("/finance/vendor-invoices/<iid>")
@require("finance.invoices")
def patch_vendor_invoice(iid: str) -> dict[str, Any]:
    inv = get_scoped(VendorInvoice, iid)
    guard(invoices.update, g.org.id, inv, body(), g.user)
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.post("/finance/vendor-invoices/<iid>/read")
@require("finance.invoices")
def read_vendor_invoice(iid: str) -> dict[str, Any]:
    inv = get_scoped(VendorInvoice, iid)
    guard(vault.assert_editable, g.org.id, "vendor_invoice", inv.id)
    guard(invoices.assert_editable_status, inv)
    got = invoices.apply_reading(inv, str(body().get("text") or "")[:100_000])
    invoices._recompute(inv)
    invoices.match(g.org.id, inv)
    db.session.commit()
    return {**invoices.invoice_dict(inv, detail=True), "found": got}


@bp.post("/finance/vendor-invoices/<iid>/match")
@require("finance.invoices")
def match_vendor_invoice(iid: str) -> dict[str, Any]:
    inv = get_scoped(VendorInvoice, iid)
    if inv.status not in ("received", "matched"):
        abort(409, message=f"A {inv.status} invoice isn't matched again.")
    guard(invoices.match, g.org.id, inv)
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.post("/finance/vendor-invoices/<iid>/submit")
@require("finance.invoices")
def submit_vendor_invoice(iid: str) -> dict[str, Any]:
    """{override?: true} approves despite exceptions (people who approve invoices only)."""
    inv = get_scoped(VendorInvoice, iid)
    guard(
        invoices.submit_for_approval,
        g.org.id,
        inv,
        g.user,
        override=bool(body().get("override")),
        can_override=can(m(), "finance.invoices.approve"),
    )
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.post("/finance/vendor-invoices/<iid>/decide")
@require("finance.view")
def decide_vendor_invoice(iid: str) -> dict[str, Any]:
    """{approve: bool, comment}. The approval rule decides who may (purchasing approvals, applies_to vendor_invoice)."""
    inv = get_scoped(VendorInvoice, iid)
    data = body()
    guard(
        invoices.decide,
        g.org.id,
        inv,
        g.user,
        m(),
        bool(data.get("approve")),
        str(data.get("comment") or ""),
        m().role in ("owner", "admin"),
    )
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.post("/finance/vendor-invoices/<iid>/status")
@require("finance.invoices")
def vendor_invoice_status(iid: str) -> dict[str, Any]:
    """{action: dispute | reopen | void, note}"""
    inv = get_scoped(VendorInvoice, iid)
    data = body()
    guard(invoices.set_status, g.org.id, inv, str(data.get("action") or ""), str(data.get("note") or ""))
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.post("/finance/vendor-invoices/<iid>/payments")
@require("finance.invoices")
def pay_vendor_invoice(iid: str) -> dict[str, Any]:
    inv = get_scoped(VendorInvoice, iid)
    guard(invoices.record_payment, g.org.id, inv, body(), g.user)
    db.session.commit()
    return invoices.invoice_dict(inv, detail=True)


@bp.delete("/finance/vendor-invoices/<iid>")
@require("finance.invoices")
def delete_vendor_invoice(iid: str) -> dict[str, Any]:
    guard(invoices.delete, g.org.id, get_scoped(VendorInvoice, iid))
    return ok()


# ---------------------------------------------------------------- customer invoices


@bp.get("/finance/customer-invoices")
@require("finance.view")
def list_customer_invoices() -> dict[str, Any]:
    return billing.list_invoices(g.org.id, dict(request.args))


@bp.get("/finance/billable-work-orders")
@require("finance.customer_invoices")
def billable_work_orders() -> dict[str, Any]:
    """Done work orders for a customer that aren't on an invoice yet."""
    from mpro.vendors.models import Customer
    from mpro.workorders.models import WorkOrder

    cust = get_scoped(Customer, request.args.get("customer_id") or "")
    billed = billing.billed_work_order_ids(g.org.id)
    rows = db.session.scalars(
        select(WorkOrder)
        .where(
            WorkOrder.org_id == g.org.id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status == "done",
            WorkOrder.customer_id == cust.id,
        )
        .order_by(WorkOrder.number.desc())
        .limit(200)
    ).all()
    return {"items": [{"id": str(w.id), "number": w.number, "title": w.title} for w in rows if str(w.id) not in billed]}


@bp.post("/finance/customer-invoices")
@require("finance.customer_invoices")
def create_customer_invoice() -> dict[str, Any]:
    ci = guard(billing.create, g.org.id, g.user, body())
    db.session.commit()
    return billing.invoice_dict(ci, detail=True)


@bp.get("/finance/customer-invoices/<iid>")
@require("finance.view")
def get_customer_invoice(iid: str) -> dict[str, Any]:
    return billing.invoice_dict(get_scoped(CustomerInvoice, iid), detail=True)


@bp.patch("/finance/customer-invoices/<iid>")
@require("finance.customer_invoices")
def patch_customer_invoice(iid: str) -> dict[str, Any]:
    ci = get_scoped(CustomerInvoice, iid)
    guard(billing.update, g.org.id, ci, body())
    db.session.commit()
    return billing.invoice_dict(ci, detail=True)


@bp.get("/finance/customer-invoices/<iid>/pdf")
@require("finance.view")
def customer_invoice_pdf(iid: str) -> Response:
    ci = get_scoped(CustomerInvoice, iid)
    data = billing.render_pdf(g.org.id, ci)
    return Response(
        data,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{billing.number_label(g.org.id, ci)}.pdf"'},
    )


@bp.post("/finance/customer-invoices/<iid>/send")
@require("finance.customer_invoices")
def send_customer_invoice(iid: str) -> dict[str, Any]:
    ci = get_scoped(CustomerInvoice, iid)
    data = body()
    guard(billing.send, g.org.id, ci, g.user, str(data.get("to") or ""), str(data.get("message") or "")[:4000])
    db.session.commit()
    return billing.invoice_dict(ci, detail=True)


@bp.post("/finance/customer-invoices/<iid>/payments")
@require("finance.customer_invoices")
def pay_customer_invoice(iid: str) -> dict[str, Any]:
    ci = get_scoped(CustomerInvoice, iid)
    guard(billing.record_payment, g.org.id, ci, body(), g.user)
    db.session.commit()
    return billing.invoice_dict(ci, detail=True)


@bp.post("/finance/customer-invoices/<iid>/void")
@require("finance.customer_invoices")
def void_customer_invoice(iid: str) -> dict[str, Any]:
    ci = get_scoped(CustomerInvoice, iid)
    guard(billing.void, g.org.id, ci)
    db.session.commit()
    return billing.invoice_dict(ci, detail=True)


@bp.post("/finance/customer-invoices/<iid>/credit-note")
@require("finance.customer_invoices")
def credit_customer_invoice(iid: str) -> dict[str, Any]:
    """{reason, lines?}: a draft credit note (send it to apply it)."""
    cn = guard(billing.credit_note, g.org.id, get_scoped(CustomerInvoice, iid), g.user, body())
    db.session.commit()
    return billing.invoice_dict(cn, detail=True)


@bp.delete("/finance/customer-invoices/<iid>")
@require("finance.customer_invoices")
def delete_customer_invoice(iid: str) -> dict[str, Any]:
    guard(billing.delete, g.org.id, get_scoped(CustomerInvoice, iid))
    return ok()


@bp.get("/finance/customers/<cid>/statement")
@require("finance.view")
def customer_statement(cid: str) -> Any:
    from mpro.vendors.models import Customer

    st = billing.statement(g.org.id, get_scoped(Customer, cid))
    if request.args.get("format") == "csv":
        rows: list[list[Any]] = [["Date", "Type", "Reference", "Amount", "Balance"]]
        rows += [[e["date"], e["kind"], e["reference"], e["amount"], e["balance"]] for e in st["entries"]]
        return _csv_response(f"statement-{st['as_of']}.csv", rows)
    return st


# ---------------------------------------------------------------- tax exemption certificates


def _manage_certs() -> bool:
    return can(m(), "finance.tax_certificates")


def _cert(cid: str) -> TaxCertificate:
    c = get_scoped(TaxCertificate, cid)
    if not _manage_certs():
        abort(403, message="You don't have permission to do that.")
    return c


@bp.get("/finance/tax-certificates")
@require("org.view")
def list_certificates() -> dict[str, Any]:
    """Managers see all; people named on a card see only the certificates whose card they may show."""
    return certificates.list_certs(g.org.id, dict(request.args), manage=_manage_certs(), user_id=g.user.id)


@bp.post("/finance/tax-certificates")
@require("finance.tax_certificates")
def create_certificate() -> dict[str, Any]:
    c = guard(certificates.create, g.org.id, g.user, body())
    db.session.commit()
    return certificates.cert_dict(c)


@bp.get("/finance/tax-certificates/<cid>")
@require("finance.tax_certificates")
def get_certificate(cid: str) -> dict[str, Any]:
    c = _cert(cid)
    certificates.log_access(g.org.id, c, g.user, "view")
    db.session.commit()
    return {**certificates.cert_dict(c), "access_log": certificates.access_log(c, 20)}


@bp.patch("/finance/tax-certificates/<cid>")
@require("finance.tax_certificates")
def patch_certificate(cid: str) -> dict[str, Any]:
    c = guard(certificates.update, g.org.id, _cert(cid), body(), g.user)
    db.session.commit()
    return certificates.cert_dict(c)


@bp.delete("/finance/tax-certificates/<cid>")
@require("finance.tax_certificates")
def delete_certificate(cid: str) -> dict[str, Any]:
    guard(certificates.delete, g.org.id, _cert(cid))
    return ok()


@bp.post("/finance/tax-certificates/<cid>/retire")
@require("finance.tax_certificates")
def retire_certificate(cid: str) -> dict[str, Any]:
    c = guard(certificates.retire, g.org.id, _cert(cid))
    db.session.commit()
    return certificates.cert_dict(c)


@bp.post("/finance/tax-certificates/<cid>/renew")
@require("finance.tax_certificates")
def renew_certificate(cid: str) -> dict[str, Any]:
    """{issued_on, expires_on, number?, …}. Vendors set to auto-resend get the new one when its scan is added."""
    new = guard(certificates.renew, g.org.id, _cert(cid), body(), g.user)
    db.session.commit()
    return certificates.cert_dict(new)


@bp.post("/finance/tax-certificates/<cid>/files")
@require("finance.tax_certificates")
def upload_certificate_file(cid: str) -> dict[str, Any]:
    """Multipart: file, role file|card. Stored encrypted. Adding the scan to a renewal re-sends it to vendors."""
    c = _cert(cid)
    files = uploads("file", 1)
    if not files:
        abort(422, message="Choose the scan.")
    role = "card" if request.form.get("role") == "card" else "file"
    guard(certificates.add_scan, g.org.id, c, files[0][0], files[0][1], g.user, role)
    resent = 0
    if role == "file" and c.renewed_from_id:
        resent = guard(certificates.resend_after_renewal, g.org.id, c, g.user)
    db.session.commit()
    return {**certificates.cert_dict(c), "resent": resent}


@bp.get("/finance/tax-certificates/<cid>/files/<fid>")
@require("finance.tax_certificates")
def download_certificate_file(cid: str, fid: str) -> Response:
    c = _cert(cid)
    f = get_scoped(FileObject, fid)
    if f.id != c.card_file_id and not any(ln.file_id == f.id for ln in certificates._scan_links(c)):
        abort(404)
    certificates.log_access(g.org.id, c, g.user, "download")
    db.session.commit()
    from urllib.parse import quote

    from mpro.core.files import INLINE_TYPES

    ctype = f.content_type or "application/octet-stream"
    # the name is whatever was uploaded: strip quotes and line breaks so it can't break the header (review #12)
    safe = (f.name or "file").replace('"', "").replace("\r", "").replace("\n", "")
    ascii_name = safe.encode("ascii", "ignore").decode() or "file"
    disp = "inline" if ctype in INLINE_TYPES else "attachment"
    resp = Response(read_bytes(f), mimetype=ctype)
    resp.headers["Content-Disposition"] = f"{disp}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(safe)}"
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    if ctype != "application/pdf":
        resp.headers["Content-Security-Policy"] = (
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
        )
    return resp


@bp.get("/finance/tax-certificates/<cid>/access-log")
@require("finance.tax_certificates")
def certificate_access_log(cid: str) -> dict[str, Any]:
    return {"items": certificates.access_log(_cert(cid), 500)}


@bp.put("/finance/tax-certificates/<cid>/vendors")
@require("finance.tax_certificates")
def set_certificate_vendor(cid: str) -> dict[str, Any]:
    """{vendor_id, status?, vendor_account_id?, auto_resend?}"""
    c = _cert(cid)
    cv = guard(certificates.set_vendor, g.org.id, c, body())
    db.session.commit()
    return certificates.registry_dict(cv)


@bp.delete("/finance/tax-certificates/<cid>/vendors/<vid>")
@require("finance.tax_certificates")
def remove_certificate_vendor(cid: str, vid: str) -> dict[str, Any]:
    guard(certificates.remove_vendor, g.org.id, _cert(cid), vid)
    return ok()


@bp.post("/finance/tax-certificates/<cid>/send")
@require("finance.tax_certificates")
def send_certificate(cid: str) -> dict[str, Any]:
    """{vendor_id, to?, message?}: email the certificate with its scan attached."""
    c = _cert(cid)
    data = body()
    cv = guard(
        certificates.send_to_vendor,
        g.org.id,
        c,
        data.get("vendor_id"),
        g.user,
        str(data.get("to") or ""),
        str(data.get("message") or "")[:4000],
    )
    db.session.commit()
    return certificates.registry_dict(cv)


@bp.get("/finance/tax-certificates/<cid>/card")
@require("org.view")
def certificate_card(cid: str) -> dict[str, Any]:
    """The mobile exemption card (people named on it, or certificate managers). The app keeps it for offline use."""
    c = get_scoped(TaxCertificate, cid)
    if not certificates.can_show_card(c, g.user.id, _manage_certs()):
        abort(404)
    out = guard(certificates.card, g.org.id, c, g.user)
    db.session.commit()
    return out


# ---------------------------------------------------------------- documents vault and exports


@bp.get("/finance/documents")
@require("finance.view")
def search_documents() -> dict[str, Any]:
    return vault.search(g.org.id, dict(request.args))


@bp.post("/finance/documents/<did>/hold")
@require("finance.export")
def hold_document(did: str) -> dict[str, Any]:
    """{hold: bool}: legal hold stops deletion and retention clean-up."""
    d = guard(vault.set_hold, g.org.id, get_scoped(FinanceDocument, did), bool(body().get("hold")))
    db.session.commit()
    return vault.doc_dict(d)


EXPORTS = {
    "accounting": ("finance.accounting", "Accountant export"),
    "exempt_purchases": ("finance.exempt_purchases", "Exempt purchases"),
    "vendor_spend": ("finance.vendor_spend", "Vendor spend"),
    "ageing": ("finance.ageing", "Receivables ageing"),
    "reimbursements": ("finance.reimbursements", "Approved reimbursements"),
}


@bp.post("/finance/exports")
@require("finance.export")
def finance_export() -> dict[str, Any]:
    """{kind: accounting|exempt_purchases|vendor_spend|ageing|reimbursements, month?: YYYY-MM,
    format?: zip|qbo|xero|netsuite|sage, start?, end?}. The file lands in the Download Center."""
    data = body()
    kind = str(data.get("kind") or "")
    if kind not in EXPORTS:
        abort(422, message="Unknown export.")
    params: dict[str, Any] = {}
    if kind == "accounting":
        month = str(data.get("month") or "")
        fmt = str(data.get("format") or "zip")
        try:
            vault._month_bounds(month)
        except ValueError:
            abort(422, message="Pick a month (YYYY-MM).")
        if fmt not in ("zip", "qbo", "xero", "netsuite", "sage"):
            abort(422, message="Pick ZIP, QuickBooks Online, Xero, NetSuite or Sage.")
        params = {"month": month, "format": fmt}
    elif kind in ("exempt_purchases", "vendor_spend"):
        for k in ("start", "end"):
            d = guard(parse_date, data.get(k), f"{k} date")
            params[k] = d.isoformat() if d else None
    ex_kind, title = EXPORTS[kind]
    suffix = f" {params['month']} ({params['format']})" if kind == "accounting" else ""
    ex = guard(request_export, g.org.id, g.user.id, ex_kind, title + suffix, params)
    db.session.commit()
    return export_dict(ex)


# ---------------------------------------------------------------- reports


@bp.get("/finance/reports/vendor-spend")
@require("finance.view")
def report_vendor_spend() -> Any:
    start, end = _dates()
    rows = invoices.vendor_spend(g.org.id, start, end)
    if request.args.get("format") == "csv":
        return Response(
            invoices.spend_csv(rows),
            mimetype="text/csv",
            headers={"Content-Disposition": 'attachment; filename="vendor-spend.csv"'},
        )
    return {"start": start.isoformat(), "end": end.isoformat(), "items": rows}


@bp.get("/finance/reports/ageing")
@require("finance.view")
def report_ageing() -> dict[str, Any]:
    on = guard(parse_date, request.args.get("on"), "date") or today()
    return {"as_of": on.isoformat(), "items": billing.ageing(g.org.id, on)}


@bp.get("/finance/reports/exempt-purchases")
@require("finance.tax_certificates")
def report_exempt() -> dict[str, Any]:
    start, end = _dates()
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "items": certificates.exempt_purchases(g.org.id, start, end),
    }


@bp.get("/finance/reports/tax-reclaim")
@require("finance.view")
def report_tax_reclaim() -> dict[str, Any]:
    args = {**dict(request.args), "tax_reclaim": request.args.get("status") or "to_reclaim"}
    args.pop("status", None)
    res = receipts.list_receipts(g.org.id, args, see_all=True, user_id=g.user.id)
    total = sum((Decimal(i["tax"] or "0") for i in res["items"]), Decimal("0"))
    return {**res, "tax_total": s(total)}


# ---------------------------------------------------------------- exporters (Download Center)


def _rows_csv(rows: list[list[Any]]) -> bytes:
    return vault._csv(rows)


@exporter("finance.exempt_purchases")
def _exempt_export(ex: Export) -> tuple[str, bytes, str]:
    p = ex.params or {}
    start = date.fromisoformat(p["start"]) if p.get("start") else None
    end = date.fromisoformat(p["end"]) if p.get("end") else None
    rows: list[list[Any]] = [
        ["Certificate", "Jurisdiction", "Type", "Reference", "Vendor", "Date", "Amount", "Tax charged", "Currency"]
    ]
    for r in certificates.exempt_purchases(ex.org_id, start, end):
        rows.append(
            [
                r["certificate"],
                r["jurisdiction"],
                r["kind"],
                r["reference"],
                r["vendor"],
                r["date"],
                r["amount"],
                r["tax_charged"],
                r["currency"],
            ]
        )
    return "exempt-purchases.csv", _rows_csv(rows), "text/csv"


@exporter("finance.vendor_spend")
def _spend_export(ex: Export) -> tuple[str, bytes, str]:
    p = ex.params or {}
    end = date.fromisoformat(p["end"]) if p.get("end") else today()
    start = date.fromisoformat(p["start"]) if p.get("start") else end.replace(month=1, day=1)
    return "vendor-spend.csv", invoices.spend_csv(invoices.vendor_spend(ex.org_id, start, end)), "text/csv"


@exporter("finance.ageing")
def _ageing_export(ex: Export) -> tuple[str, bytes, str]:
    rows: list[list[Any]] = [["Customer", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]]
    for r in billing.ageing(ex.org_id):
        rows.append(
            [
                (r["customer"] or {}).get("name", ""),
                r["current"],
                r["d1_30"],
                r["d31_60"],
                r["d61_90"],
                r["d90_plus"],
                r["total"],
            ]
        )
    return "receivables-ageing.csv", _rows_csv(rows), "text/csv"


@exporter("finance.reimbursements")
def _reimbursements_export(ex: Export) -> tuple[str, bytes, str]:
    data, rows = receipts.reimbursement_csv(ex.org_id)
    for r in rows:
        r.reimbursement_status = "exported"
    return f"reimbursements-{today().isoformat()}.csv", data, "text/csv"


# ---------------------------------------------------------------- file access for records (core/files)


def _org_record(model: Any, rid: uuid.UUID) -> Any:
    r = db.session.get(model, rid)
    if r is None or r.org_id != g.org.id or r.deleted_at is not None:
        return None
    return r


def _receipt_ok(rid: uuid.UUID, edit: bool) -> bool:
    r = _org_record(Receipt, rid)
    if r is None:
        return False
    if can(m(), "finance.view"):
        return not edit or not vault.is_locked(g.org.id, "receipt", r.id)
    return (
        r.submitted_by_id == g.user.id
        and can(m(), "finance.receipts")
        and (not edit or not vault.is_locked(g.org.id, "receipt", r.id))
    )


def _simple_ok(model: Any, record_type: str, view: str, edit_action: str) -> tuple[Any, Any]:
    def view_ok(rid: uuid.UUID) -> bool:
        return _org_record(model, rid) is not None and can(m(), view)

    def edit_ok(rid: uuid.UUID) -> bool:
        return view_ok(rid) and can(m(), edit_action) and not vault.is_locked(g.org.id, record_type, rid)

    return view_ok, edit_ok


register_entity("receipt", lambda rid: _receipt_ok(rid, False), lambda rid: _receipt_ok(rid, True))
register_entity("vendor_invoice", *_simple_ok(VendorInvoice, "vendor_invoice", "finance.view", "finance.invoices"))
register_entity(
    "customer_invoice", *_simple_ok(CustomerInvoice, "customer_invoice", "finance.view", "finance.customer_invoices")
)
# certificate scans are encrypted and go through the endpoints above (access log); the generic file routes only
# let certificate managers in
register_entity(
    "tax_certificate",
    *_simple_ok(TaxCertificate, "tax_certificate", "finance.tax_certificates", "finance.tax_certificates"),
)


# ---------------------------------------------------------------- jobs and hooks


@job("finance.certificate_reminders")
def _cert_reminders(_: dict[str, Any]) -> None:
    certificates.reminders()


@job("finance.invoice_reminders")
def _invoice_reminders(_: dict[str, Any]) -> None:
    invoices.reminders()
    billing.mark_overdue_and_remind()


@job("finance.inbox")
def _inbox(_: dict[str, Any]) -> None:
    inbox.poll_all()


periodic("finance.certificate_reminders", timedelta(hours=24))
periodic("finance.invoice_reminders", timedelta(hours=24))
periodic("finance.inbox", timedelta(minutes=5))


def _register_hooks() -> None:
    from mpro.purchasing import hooks

    if certificates.exemption_for_po not in hooks.EXEMPTION_LOOKUPS:
        hooks.EXEMPTION_LOOKUPS.append(certificates.exemption_for_po)


_register_hooks()
