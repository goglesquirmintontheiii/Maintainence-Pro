"""Finance documents vault (MP-094): one index row per finance document, retention and legal hold, read-only once
approved, and the accountant's exports (monthly ZIP of PDFs + CSV; CSV formats for QuickBooks Online, Xero, NetSuite
and Sage) through the Download Center.
"""

from __future__ import annotations

import csv
import io
import uuid
import zipfile
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, or_, select

from mpro.core.events import emit
from mpro.core.files import Export, FileLink, FileObject, exporter, read_bytes
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.finance.common import ZERO, customer_label, paged, s, vendor_label
from mpro.finance.models import FinanceDocument
from mpro.orgs.services import RuleError

KINDS = ("certificate", "receipt", "vendor_invoice", "customer_invoice", "quote", "purchase_order", "other")


def _retain_until(org_id: uuid.UUID, d: date | None) -> date | None:
    from mpro.finance.settings import finance_settings

    years = int(finance_settings(org_id).get("retention_years") or 7)
    base = d or utcnow().date()
    try:
        return base.replace(year=base.year + years)
    except ValueError:  # 29 February
        return base.replace(year=base.year + years, day=28)


def index(
    org_id: uuid.UUID,
    kind: str,
    record_type: str,
    record_id: uuid.UUID,
    *,
    title: str,
    file_id: uuid.UUID | None = None,
    vendor_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
    work_order_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    doc_date: date | None = None,
    amount: Decimal | None = None,
    currency: str = "",
    search_text: str = "",
    user_id: uuid.UUID | None = None,
) -> FinanceDocument:
    """Create or refresh the vault row for a record (one row per record)."""
    doc = db.session.scalars(
        select(FinanceDocument).where(
            FinanceDocument.org_id == org_id,
            FinanceDocument.record_type == record_type,
            FinanceDocument.record_id == record_id,
        )
    ).first()
    if doc is None:
        doc = FinanceDocument(
            org_id=org_id, kind=kind, record_type=record_type, record_id=record_id, created_by_id=user_id
        )
        db.session.add(doc)
    if doc.locked_at is None:
        doc.title = title[:500]
        doc.file_id = file_id
        doc.vendor_id = vendor_id
        doc.customer_id = customer_id
        doc.work_order_id = work_order_id
        doc.asset_id = asset_id
        doc.doc_date = doc_date
        doc.amount = amount
        doc.currency = currency
        doc.search_text = " ".join(x for x in (title, search_text) if x)[:20000].lower()
    doc.retain_until = max(filter(None, [doc.retain_until, _retain_until(org_id, doc_date)]), default=None)
    db.session.flush()
    return doc


def doc_for(org_id: uuid.UUID, record_type: str, record_id: uuid.UUID) -> FinanceDocument | None:
    return db.session.scalars(
        select(FinanceDocument).where(
            FinanceDocument.org_id == org_id,
            FinanceDocument.record_type == record_type,
            FinanceDocument.record_id == record_id,
        )
    ).first()


def lock(org_id: uuid.UUID, record_type: str, record_id: uuid.UUID) -> None:
    """Approved documents become read-only (changes need an unlock, which is audit-logged)."""
    doc = doc_for(org_id, record_type, record_id)
    if doc is not None and doc.locked_at is None:
        doc.locked_at = utcnow()
        emit(
            "finance.document_locked",
            entity_type=record_type,
            entity_id=record_id,
            entity_label=doc.title,
            summary="Locked (approved documents are read-only)",
            org_id=org_id,
        )


def is_locked(org_id: uuid.UUID, record_type: str, record_id: uuid.UUID) -> bool:
    doc = doc_for(org_id, record_type, record_id)
    return bool(doc and doc.locked_at)


def assert_editable(org_id: uuid.UUID, record_type: str, record_id: uuid.UUID) -> None:
    if is_locked(org_id, record_type, record_id):
        raise RuleError("This document is approved and read-only.", 409)


def assert_deletable(org_id: uuid.UUID, record_type: str, record_id: uuid.UUID) -> None:
    doc = doc_for(org_id, record_type, record_id)
    if doc is None:
        return
    if doc.legal_hold:
        raise RuleError("This document is on legal hold and can't be deleted.", 409)
    if doc.locked_at is not None:
        raise RuleError("Approved documents can't be deleted; void them instead.", 409)


def set_hold(org_id: uuid.UUID, doc: FinanceDocument, hold: bool) -> FinanceDocument:
    doc.legal_hold = hold
    emit(
        "finance.legal_hold",
        entity_type=doc.record_type,
        entity_id=doc.record_id,
        entity_label=doc.title,
        summary="Legal hold on" if hold else "Legal hold off",
        org_id=org_id,
    )
    return doc


def doc_dict(d: FinanceDocument) -> dict[str, Any]:
    from mpro.core.files import file_dict

    f = db.session.get(FileObject, d.file_id) if d.file_id else None
    return {
        "id": str(d.id),
        "kind": d.kind,
        "title": d.title,
        "record_type": d.record_type,
        "record_id": str(d.record_id) if d.record_id else None,
        "file": file_dict(f) if f and f.deleted_at is None else None,
        "vendor": vendor_label(d.vendor_id),
        "customer": customer_label(d.customer_id),
        "work_order_id": str(d.work_order_id) if d.work_order_id else None,
        "asset_id": str(d.asset_id) if d.asset_id else None,
        "doc_date": d.doc_date.isoformat() if d.doc_date else None,
        "amount": s(d.amount),
        "currency": d.currency,
        "retain_until": d.retain_until.isoformat() if d.retain_until else None,
        "legal_hold": d.legal_hold,
        "locked_at": iso(d.locked_at),
        "locked": d.locked_at is not None,
        "created_at": iso(d.created_at),
    }


def search(org_id: uuid.UUID, args: dict[str, Any]) -> dict[str, Any]:
    q = select(FinanceDocument).where(FinanceDocument.org_id == org_id)
    if args.get("kind") in KINDS:
        q = q.where(FinanceDocument.kind == args["kind"])
    if args.get("q"):
        for word in str(args["q"]).lower().split()[:6]:
            q = q.where(FinanceDocument.search_text.contains(word, autoescape=True))
    for k in ("vendor_id", "customer_id", "work_order_id", "asset_id"):
        if args.get(k):
            try:
                q = q.where(getattr(FinanceDocument, k) == uuid.UUID(str(args[k])))
            except ValueError:
                return {"items": [], "total": 0, "page": 1, "per_page": 50}
    try:
        if args.get("from"):
            q = q.where(FinanceDocument.doc_date >= date.fromisoformat(str(args["from"])[:10]))
        if args.get("to"):
            q = q.where(FinanceDocument.doc_date <= date.fromisoformat(str(args["to"])[:10]))
    except ValueError:
        return {"items": [], "total": 0, "page": 1, "per_page": 50}
    if args.get("hold") == "1":
        q = q.where(FinanceDocument.legal_hold.is_(True))
    q = q.order_by(FinanceDocument.doc_date.desc().nulls_last(), FinanceDocument.created_at.desc())
    return paged(q, args, doc_dict)


# ---------------------------------------------------------------- accountant exports


def _month_bounds(month: str) -> tuple[date, date]:
    try:
        y, m = (int(x) for x in month.split("-")[:2])
        start = date(y, m, 1)
    except (ValueError, TypeError) as e:
        raise ValueError("Pick a month (YYYY-MM).") from e
    end = date(y + (m == 12), m % 12 + 1, 1)
    return start, end


def _csv(rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(["" if v is None else (format(v, "f") if isinstance(v, Decimal) else _safe_cell(v)) for v in r])
    return buf.getvalue().encode("utf-8-sig")


def _safe_cell(v: Any) -> Any:
    """Stop spreadsheet formula injection (text starting with = + - @), keeping negative numbers as numbers."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        if len(v) < 20 and v.lstrip("-").replace(".", "", 1).isdigit():
            return v
        return "'" + v
    return v


def _safe(text: str) -> str:
    return "".join(c if c.isalnum() or c in "-_. " else "_" for c in text)[:80].strip() or "document"


def accounting_rows(org_id: uuid.UUID, start: date, end: date) -> dict[str, list[dict[str, Any]]]:
    """Plain data for the month: vendor bills (approved/paid), customer invoices, expenses (receipts), payments."""
    from mpro.finance.models import (
        CustomerInvoice,
        CustomerInvoiceLine,
        Payment,
        Receipt,
        VendorInvoice,
        VendorInvoiceLine,
    )

    bills = []
    for inv in db.session.scalars(
        select(VendorInvoice).where(
            VendorInvoice.org_id == org_id,
            VendorInvoice.deleted_at.is_(None),
            VendorInvoice.status.in_(("approved", "paid")),
            VendorInvoice.invoice_date >= start,
            VendorInvoice.invoice_date < end,
        )
    ):
        lines = db.session.scalars(select(VendorInvoiceLine).where(VendorInvoiceLine.invoice_id == inv.id)).all()
        v = vendor_label(inv.vendor_id)
        bills.append({"record": inv, "vendor": v["name"] if v else "", "lines": lines})
    sales = []
    for ci in db.session.scalars(
        select(CustomerInvoice).where(
            CustomerInvoice.org_id == org_id,
            CustomerInvoice.deleted_at.is_(None),
            CustomerInvoice.status != "draft",
            CustomerInvoice.issue_date >= start,
            CustomerInvoice.issue_date < end,
        )
    ):
        lines = db.session.scalars(select(CustomerInvoiceLine).where(CustomerInvoiceLine.invoice_id == ci.id)).all()
        c = customer_label(ci.customer_id)
        sales.append({"record": ci, "customer": c["name"] if c else "", "lines": lines})
    expenses = [
        {"record": r}
        for r in db.session.scalars(
            select(Receipt).where(
                Receipt.org_id == org_id,
                Receipt.deleted_at.is_(None),
                Receipt.status.in_(("confirmed", "matched")),
                Receipt.purchased_on >= start,
                Receipt.purchased_on < end,
            )
        )
    ]
    payments = list(
        db.session.scalars(
            select(Payment).where(Payment.org_id == org_id, Payment.paid_on >= start, Payment.paid_on < end)
        )
    )
    return {"bills": bills, "sales": sales, "expenses": expenses, "payments": payments}  # type: ignore[dict-item]


def _format_csvs(fmt: str, data: dict[str, Any], prefix: str) -> dict[str, bytes]:
    bills, sales, expenses = data["bills"], data["sales"], data["expenses"]
    out: dict[str, bytes] = {}
    d = lambda x: x.isoformat() if x else ""  # noqa: E731
    if fmt == "qbo":  # QuickBooks Online: Bills import and Invoices import
        rows: list[list[Any]] = [
            [
                "Bill No",
                "Supplier",
                "Bill Date",
                "Due Date",
                "Terms",
                "Memo",
                "Account",
                "Line Description",
                "Line Amount",
            ]
        ]
        for b in bills:
            inv = b["record"]
            for ln in b["lines"] or [None]:
                rows.append(
                    [
                        inv.number,
                        b["vendor"],
                        d(inv.invoice_date),
                        d(inv.due_date),
                        inv.terms,
                        inv.category,
                        "Repairs and Maintenance",
                        ln.description if ln else "Invoice total",
                        ln.amount if ln else inv.total,
                    ]
                )
            if inv.tax:
                rows.append(
                    [
                        inv.number,
                        b["vendor"],
                        d(inv.invoice_date),
                        d(inv.due_date),
                        inv.terms,
                        "",
                        "Sales Tax",
                        "Sales tax",
                        inv.tax,
                    ]
                )
        out["quickbooks_bills.csv"] = _csv(rows)
        rows = [
            [
                "InvoiceNo",
                "Customer",
                "InvoiceDate",
                "DueDate",
                "Item(Product/Service)",
                "ItemDescription",
                "ItemQuantity",
                "ItemRate",
                "ItemAmount",
                "ItemTaxAmount",
            ]
        ]
        for x in sales:
            ci = x["record"]
            for ln in x["lines"]:
                rows.append(
                    [
                        f"{prefix}{ci.number}",
                        x["customer"],
                        d(ci.issue_date),
                        d(ci.due_date),
                        ln.kind.capitalize(),
                        ln.description,
                        ln.quantity,
                        ln.unit_price,
                        ln.amount,
                        "",
                    ]
                )
            if ci.tax:
                rows.append(
                    [
                        f"{prefix}{ci.number}",
                        x["customer"],
                        d(ci.issue_date),
                        d(ci.due_date),
                        "Sales tax",
                        "",
                        1,
                        ci.tax,
                        ci.tax,
                        ci.tax,
                    ]
                )
        out["quickbooks_invoices.csv"] = _csv(rows)
    elif fmt == "xero":  # Xero: Bills (AccPay) and Sales invoices (AccRec) CSV templates
        head = [
            "*ContactName",
            "*InvoiceNumber",
            "*InvoiceDate",
            "*DueDate",
            "*Description",
            "*Quantity",
            "*UnitAmount",
            "*AccountCode",
            "*TaxType",
            "Currency",
        ]
        rows = [head]
        for b in bills:
            inv = b["record"]
            for ln in b["lines"] or [None]:
                rows.append(
                    [
                        b["vendor"],
                        inv.number,
                        d(inv.invoice_date),
                        d(inv.due_date),
                        ln.description if ln else "Invoice total",
                        ln.quantity if ln else 1,
                        ln.unit_price if ln else inv.subtotal,
                        "473",
                        "Tax on Purchases" if inv.tax else "No Tax",
                        inv.currency,
                    ]
                )
        out["xero_bills.csv"] = _csv(rows)
        rows = [head]
        for x in sales:
            ci = x["record"]
            for ln in x["lines"]:
                rows.append(
                    [
                        x["customer"],
                        f"{prefix}{ci.number}",
                        d(ci.issue_date),
                        d(ci.due_date),
                        ln.description,
                        ln.quantity,
                        ln.unit_price,
                        "200",
                        "Tax on Sales" if (ci.tax and ln.taxable) else "Tax Exempt",
                        ci.currency,
                    ]
                )
        out["xero_invoices.csv"] = _csv(rows)
    elif fmt == "netsuite":  # NetSuite CSV import: Vendor Bill and Invoice records
        rows = [
            [
                "External ID",
                "Vendor",
                "Date",
                "Due Date",
                "Reference No.",
                "Memo",
                "Account",
                "Amount",
                "Tax Amount",
                "Currency",
            ]
        ]
        for b in bills:
            inv = b["record"]
            rows.append(
                [
                    f"mpro-bill-{inv.id}",
                    b["vendor"],
                    d(inv.invoice_date),
                    d(inv.due_date),
                    inv.number,
                    inv.category,
                    "Maintenance Expense",
                    inv.subtotal,
                    inv.tax,
                    inv.currency,
                ]
            )
        out["netsuite_vendor_bills.csv"] = _csv(rows)
        rows = [
            [
                "External ID",
                "Customer",
                "Date",
                "Due Date",
                "Invoice #",
                "Item",
                "Description",
                "Quantity",
                "Rate",
                "Amount",
                "Tax Amount",
                "Currency",
            ]
        ]
        for x in sales:
            ci = x["record"]
            for ln in x["lines"]:
                rows.append(
                    [
                        f"mpro-inv-{ci.id}",
                        x["customer"],
                        d(ci.issue_date),
                        d(ci.due_date),
                        f"{prefix}{ci.number}",
                        ln.kind.capitalize(),
                        ln.description,
                        ln.quantity,
                        ln.unit_price,
                        ln.amount,
                        "",
                        ci.currency,
                    ]
                )
        out["netsuite_invoices.csv"] = _csv(rows)
    elif fmt == "sage":  # Sage (50 / Accounting) audit-trail transactions import
        rows = [
            [
                "Type",
                "Account Reference",
                "Nominal A/C Ref",
                "Date",
                "Reference",
                "Details",
                "Net Amount",
                "Tax Code",
                "Tax Amount",
            ]
        ]
        for b in bills:
            inv = b["record"]
            rows.append(
                [
                    "PI",
                    b["vendor"][:8].upper(),
                    "7800",
                    d(inv.invoice_date),
                    inv.number,
                    inv.category or "Maintenance",
                    inv.subtotal + (inv.shipping or ZERO),
                    "T1" if inv.tax else "T0",
                    inv.tax,
                ]
            )
        for x in sales:
            ci = x["record"]
            rows.append(
                [
                    "SI",
                    x["customer"][:8].upper(),
                    "4000",
                    d(ci.issue_date),
                    f"{prefix}{ci.number}",
                    "Service work",
                    ci.subtotal,
                    "T1" if ci.tax else "T0",
                    ci.tax,
                ]
            )
        for e in expenses:
            r = e["record"]
            rows.append(
                [
                    "BP",
                    "",
                    "7800",
                    d(r.purchased_on),
                    r.vendor_name[:30],
                    r.expense_category or "Expense",
                    (r.total or ZERO) - (r.tax or ZERO),
                    "T1" if r.tax else "T0",
                    r.tax or ZERO,
                ]
            )
        out["sage_transactions.csv"] = _csv(rows)
    return out


def _plain_csvs(data: dict[str, Any], prefix: str) -> dict[str, bytes]:
    d = lambda x: x.isoformat() if x else ""  # noqa: E731
    out = {
        "vendor_bills.csv": _csv(
            [
                [
                    "Invoice number",
                    "Vendor",
                    "Invoice date",
                    "Due date",
                    "Status",
                    "Subtotal",
                    "Tax",
                    "Shipping",
                    "Total",
                    "Currency",
                    "Paid on",
                ]
            ]
            + [
                [
                    b["record"].number,
                    b["vendor"],
                    d(b["record"].invoice_date),
                    d(b["record"].due_date),
                    b["record"].status,
                    b["record"].subtotal,
                    b["record"].tax,
                    b["record"].shipping,
                    b["record"].total,
                    b["record"].currency,
                    d(b["record"].paid_at.date() if b["record"].paid_at else None),
                ]
                for b in data["bills"]
            ]
        ),
        "customer_invoices.csv": _csv(
            [
                [
                    "Invoice number",
                    "Customer",
                    "Kind",
                    "Issue date",
                    "Due date",
                    "Status",
                    "Subtotal",
                    "Tax",
                    "Total",
                    "Paid",
                    "Currency",
                ]
            ]
            + [
                [
                    f"{prefix}{x['record'].number}",
                    x["customer"],
                    x["record"].kind,
                    d(x["record"].issue_date),
                    d(x["record"].due_date),
                    x["record"].status,
                    x["record"].subtotal,
                    x["record"].tax,
                    x["record"].total,
                    x["record"].paid,
                    x["record"].currency,
                ]
                for x in data["sales"]
            ]
        ),
        "expenses.csv": _csv(
            [
                [
                    "Date",
                    "Vendor",
                    "Category",
                    "Subtotal",
                    "Tax",
                    "Total",
                    "Currency",
                    "Card",
                    "Paid personally",
                    "Work order",
                    "Tax to reclaim",
                ]
            ]
            + [
                [
                    d(e["record"].purchased_on),
                    e["record"].vendor_name,
                    e["record"].expense_category,
                    e["record"].subtotal,
                    e["record"].tax,
                    e["record"].total,
                    e["record"].currency,
                    e["record"].card_last4,
                    "yes" if e["record"].paid_personally else "",
                    str(e["record"].work_order_id or ""),
                    e["record"].tax_reclaim_status,
                ]
                for e in data["expenses"]
            ]
        ),
        "payments.csv": _csv(
            [["Date", "Direction", "Amount", "Currency", "Method", "Reference", "Vendor invoice", "Customer invoice"]]
            + [
                [
                    d(p.paid_on),
                    "paid" if p.direction == "out" else "received",
                    p.amount,
                    p.currency,
                    p.method,
                    p.reference,
                    str(p.vendor_invoice_id or ""),
                    str(p.customer_invoice_id or ""),
                ]
                for p in data["payments"]
            ]
        ),
    }
    return out


def _doc_files(org_id: uuid.UUID, data: dict[str, Any]) -> list[tuple[str, FileObject]]:
    from mpro.finance.models import CustomerInvoice

    files: list[tuple[str, FileObject]] = []

    def add(folder: str, label: str, file_id: uuid.UUID | None) -> None:
        if file_id:
            f = db.session.get(FileObject, file_id)
            if f is not None and f.org_id == org_id and f.deleted_at is None:
                ext = f.name.rsplit(".", 1)[-1] if "." in f.name else "bin"
                files.append((f"{folder}/{_safe(label)}.{ext}", f))

    for b in data["bills"]:
        add("vendor_bills", f"{b['vendor']} {b['record'].number}", b["record"].file_id)
    for e in data["expenses"]:
        r = e["record"]
        add("receipts", f"{r.purchased_on} {r.vendor_name} {r.total}", r.file_id)
    for x in data["sales"]:
        ci: CustomerInvoice = x["record"]
        link = db.session.scalars(
            select(FileLink)
            .where(FileLink.entity_type == "customer_invoice", FileLink.entity_id == ci.id, FileLink.role == "pdf")
            .order_by(FileLink.created_at.desc())
        ).first()
        add("customer_invoices", f"invoice {ci.number}", link.file_id if link else None)
    return files


@exporter("finance.accounting")
def _accounting_export(ex: Export) -> tuple[str, bytes, str]:
    """params: {month: "YYYY-MM", format: "zip" | "qbo" | "xero" | "netsuite" | "sage"}"""
    from mpro.finance.settings import finance_settings

    month = str(ex.params.get("month") or "")
    fmt = str(ex.params.get("format") or "zip")
    start, end = _month_bounds(month)
    data = accounting_rows(ex.org_id, start, end)
    prefix = str(finance_settings(ex.org_id).get("invoice_prefix") or "")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        if fmt == "zip":
            for name, content in _plain_csvs(data, prefix).items():
                z.writestr(name, content)
            seen: set[str] = set()
            for path, f in _doc_files(ex.org_id, data):
                n, i = path, 1
                while n in seen:
                    i += 1
                    n = path.replace(".", f" ({i}).", 1) if "." in path else f"{path} ({i})"
                seen.add(n)
                try:
                    z.writestr(n, read_bytes(f))
                except Exception:  # noqa: BLE001  a missing file is skipped, the rest still exports
                    continue
        elif fmt in ("qbo", "xero", "netsuite", "sage"):
            for name, content in _format_csvs(fmt, data, prefix).items():
                z.writestr(name, content)
        else:
            raise ValueError("Unknown export format.")
    label = {"zip": "documents", "qbo": "quickbooks", "xero": "xero", "netsuite": "netsuite", "sage": "sage"}[fmt]
    return f"mpro-finance-{month}-{label}.zip", buf.getvalue(), "application/zip"


def overdue_retention(org_id: uuid.UUID) -> int:
    """Documents past their retention date and not on hold (listed for review; MPro never deletes them on its own)."""
    from sqlalchemy import func

    return int(
        db.session.scalar(
            select(func.count(FinanceDocument.id)).where(
                FinanceDocument.org_id == org_id,
                FinanceDocument.legal_hold.is_(False),
                and_(FinanceDocument.retain_until.is_not(None), FinanceDocument.retain_until < utcnow().date()),
            )
        )
        or 0
    )


__all__ = ["or_"]
