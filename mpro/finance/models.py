"""Purchasing finance (0.5.0, MP-090–094): tax exemption certificates, receipts, company cards, vendor invoices with
3-way match, customer invoices, payments and the finance documents vault.

MPro records and checks money; it never moves it. Amounts are Decimal with a currency (G-12). Certificate scans and
other sensitive documents are stored encrypted (G-16, `FileObject.encrypted`).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

QTY = Numeric(18, 4)
MONEY = Numeric(18, 4)
TOTAL = Numeric(14, 2)

CERTIFICATE_TYPES = (
    "resale",
    "exempt_organization",  # e.g. 501(c)(3)
    "government",
    "manufacturing",  # manufacturing / industrial processing
    "agricultural",
    "direct_pay",
    "ca_pst_gst",  # Canadian PST/GST exemptions
    "eu_vat",  # EU VAT ID (reverse charge)
    "custom",
)


# ---------------------------------------------------------------- tax exemption certificates (MP-090)


class TaxCertificate(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A tax exemption held by the organization, or by one of its customers (customer_id set)."""

    __tablename__ = "tax_certificates"

    customer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customers.id"), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(30), default="resale")
    type_label: Mapped[str] = mapped_column(String(120), default="")  # for "custom"
    country: Mapped[str] = mapped_column(String(2), default="US")
    region: Mapped[str] = mapped_column(String(80), default="")  # state / province; "" = whole country
    multistate_form: Mapped[str] = mapped_column(String(20), default="")  # "", "sst", "mtc"
    covered_regions: Mapped[list[str]] = mapped_column(JSON, default=list)  # for multistate forms
    number: Mapped[str] = mapped_column(String(120), default="")
    legal_entity: Mapped[str] = mapped_column(String(255), default="")
    location_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # sites it covers; [] = all
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    scope_notes: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | retired
    renewed_from_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("tax_certificates.id"), nullable=True)
    reminder_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    reminders_sent: Mapped[list[int]] = mapped_column(JSON, default=list)  # [60, 30, 7] already sent for this expiry
    card_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)  # mobile card
    card_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # technicians allowed to show the card
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class CertificateVendor(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Which vendors have which certificate on file (the vendor registry)."""

    __tablename__ = "certificate_vendors"
    __table_args__ = (UniqueConstraint("certificate_id", "vendor_id", name="uq_certificate_vendors"),)

    certificate_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tax_certificates.id"), index=True)
    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    status: Mapped[str] = mapped_column(String(12), default="on_file")  # not_sent | sent | on_file | rejected
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    sent_to: Mapped[str] = mapped_column(String(255), default="")
    vendor_account_id: Mapped[str] = mapped_column(String(120), default="")  # e.g. Amazon Business exemption id
    auto_resend: Mapped[bool] = mapped_column(Boolean, default=True)  # resend on renewal


class CertificateAccess(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Access log for certificates and the mobile exemption card."""

    __tablename__ = "certificate_access"

    certificate_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tax_certificates.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(20))  # view | download | show_card | send
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(60), default="")


# ---------------------------------------------------------------- receipts and company cards (MP-091)


class PaymentCard(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "payment_cards"

    name: Mapped[str] = mapped_column(String(120))
    last4: Mapped[str] = mapped_column(String(4))
    holder_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class CardTransaction(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A line from an imported card statement (CSV), reconciled against receipts."""

    __tablename__ = "card_transactions"
    __table_args__ = (Index("ix_card_transactions_card_date", "card_id", "posted_on"),)

    card_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("payment_cards.id"))
    import_id: Mapped[str] = mapped_column(String(40), default="")  # one statement import
    posted_on: Mapped[date] = mapped_column(Date)
    merchant: Mapped[str] = mapped_column(String(255), default="")
    amount: Mapped[Decimal] = mapped_column(TOTAL)
    currency: Mapped[str] = mapped_column(String(3), default="")
    receipt_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(12), default="unmatched")  # unmatched | matched | ignored | chased
    chased_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


RECEIPT_STATUSES = ("new", "confirmed", "matched", "duplicate", "rejected")


class Receipt(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "receipts"

    source: Mapped[str] = mapped_column(String(10), default="upload")  # camera | upload | email
    status: Mapped[str] = mapped_column(String(12), default="new", index=True)
    file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    image_hash: Mapped[str] = mapped_column(String(64), default="", index=True)  # duplicate detection
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True, index=True)
    vendor_name: Mapped[str] = mapped_column(String(255), default="")
    purchased_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    subtotal: Mapped[Decimal | None] = mapped_column(TOTAL, nullable=True)
    tax: Mapped[Decimal | None] = mapped_column(TOTAL, nullable=True)
    total: Mapped[Decimal | None] = mapped_column(TOTAL, nullable=True)
    card_last4: Mapped[str] = mapped_column(String(4), default="")
    region: Mapped[str] = mapped_column(String(80), default="")  # where it was bought (state / province)
    lines: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{description, qty, unit_price, amount}]
    ocr_text: Mapped[str] = mapped_column(Text, default="")
    extracted: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # what the reader found, with confidences
    reader: Mapped[str] = mapped_column(String(20), default="")  # browser_ocr | server_ocr | ai | manual
    # what it's for
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("purchase_orders.id"), nullable=True)
    part_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("parts.id"), nullable=True)  # restock
    expense_category: Mapped[str] = mapped_column(String(80), default="")
    cost_entry_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # work order cost it created
    # tax that shouldn't have been charged (a valid exemption covered the vendor and jurisdiction)
    tax_flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    tax_certificate_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("tax_certificates.id"), nullable=True)
    tax_reclaim_status: Mapped[str] = mapped_column(String(12), default="")  # "" | to_reclaim | reclaimed | waived
    # how it was paid
    card_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("payment_cards.id"), nullable=True)
    paid_personally: Mapped[bool] = mapped_column(Boolean, default=False)
    # "" | requested | approved | rejected | exported | paid
    reimbursement_status: Mapped[str] = mapped_column(String(12), default="")
    reimbursement_decided_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("receipts.id"), nullable=True)
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


# ---------------------------------------------------------------- vendor invoices with 3-way match (MP-092)

# "pending" = sent for approval; locked against edits until the approvers decide (0.5.0 review #1)
VENDOR_INVOICE_STATUSES = ("received", "matched", "pending", "approved", "paid", "disputed", "void")


class VendorInvoice(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendor_invoices"

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True, index=True)
    number: Mapped[str] = mapped_column(String(120), default="")  # the vendor's invoice number
    status: Mapped[str] = mapped_column(String(12), default="received", index=True)
    source: Mapped[str] = mapped_column(String(10), default="upload")  # upload | email | portal | manual
    file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    terms: Mapped[str] = mapped_column(String(80), default="")  # "2/10 net 30"
    discount_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 3), nullable=True)  # early-payment discount
    discount_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    subtotal: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    shipping: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    purchase_order_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    category: Mapped[str] = mapped_column(String(80), default="")
    # [{"kind": "price"|"quantity"|"no_po"|"tax_exempt"|"duplicate", "line_id": "...", "message": "..."}]
    exceptions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    matched_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    dispute_note: Mapped[str] = mapped_column(Text, default="")
    ocr_text: Mapped[str] = mapped_column(Text, default="")
    extracted: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class VendorInvoiceLine(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendor_invoice_lines"

    invoice_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendor_invoices.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    po_line_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("purchase_order_lines.id"), nullable=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    part_number: Mapped[str] = mapped_column(String(120), default="")
    quantity: Mapped[Decimal] = mapped_column(QTY, default=Decimal("1"))
    unit_price: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    amount: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    match_status: Mapped[str] = mapped_column(String(12), default="")  # "" | ok | price | quantity | unmatched


# ---------------------------------------------------------------- customer invoices (MP-093)

CUSTOMER_INVOICE_STATUSES = ("draft", "sent", "partially_paid", "paid", "overdue", "void")


class CustomerInvoice(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "customer_invoices"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_customer_invoices_number"),)

    number: Mapped[int] = mapped_column(Integer)
    customer_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("customers.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)
    kind: Mapped[str] = mapped_column(String(12), default="invoice")  # invoice | credit_note
    credit_for_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customer_invoices.id"), nullable=True)
    issue_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    work_order_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    subtotal: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    paid: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    tax_rate_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 3), nullable=True)
    tax_certificate_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("tax_certificates.id"), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    reminders_sent: Mapped[list[str]] = mapped_column(JSON, default=list)
    payment_link_url: Mapped[str] = mapped_column(String(1000), default="")  # MPro Cloud (Stripe)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class CustomerInvoiceLine(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "customer_invoice_lines"

    invoice_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("customer_invoices.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(10), default="other")  # labor | part | cost | other
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # time entry / WO part / cost entry
    description: Mapped[str] = mapped_column(String(500))
    quantity: Mapped[Decimal] = mapped_column(QTY, default=Decimal("1"))
    unit_price: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    amount: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    taxable: Mapped[bool] = mapped_column(Boolean, default=True)


class Payment(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A payment recorded against a vendor invoice (paid out) or a customer invoice (received). MPro moves no money."""

    __tablename__ = "payments"

    direction: Mapped[str] = mapped_column(String(4))  # out | in
    vendor_invoice_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendor_invoices.id"), nullable=True)
    customer_invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("customer_invoices.id"), nullable=True
    )
    paid_on: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(TOTAL)
    currency: Mapped[str] = mapped_column(String(3), default="")
    method: Mapped[str] = mapped_column(String(30), default="")  # ach | check | card | wire | cash | other
    reference: Mapped[str] = mapped_column(String(120), default="")
    recorded_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


# ---------------------------------------------------------------- finance documents vault (MP-094)


class FinanceDocument(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Index row for every finance document (certificate, receipt, invoice, quote, PO PDF…) for search and retention."""

    __tablename__ = "finance_documents"
    __table_args__ = (Index("ix_finance_documents_record", "record_type", "record_id"),)

    # certificate | receipt | vendor_invoice | customer_invoice | quote | purchase_order | other
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(500), default="")
    record_type: Mapped[str] = mapped_column(String(30), default="")
    record_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True, index=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customers.id"), nullable=True, index=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True)
    doc_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    amount: Mapped[Decimal | None] = mapped_column(TOTAL, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    search_text: Mapped[str] = mapped_column(Text, default="")
    retain_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    legal_hold: Mapped[bool] = mapped_column(Boolean, default=False)
    locked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # read-only once approved
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
