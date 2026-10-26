"""Purchase orders (0.5.0, MP-042–044).

MaintainX workflow (r227–r232, r249–r259): Requested (by a full user, no cost visibility) → Pending approval →
Approved / Rejected → Partially fulfilled → Complete, plus Canceled and an Overdue indicator. Line items are inventory
parts or one-off items; receiving can happen in several shipments and updates stock through the parts ledger.
Approval rules (r230) also apply to vendor invoices (MP-092), so they carry `applies_to`. Budgets (r268) are MPro's own.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

QTY = Numeric(18, 4)
MONEY = Numeric(18, 4)
TOTAL = Numeric(14, 2)

PO_STATUSES = ("requested", "pending", "approved", "rejected", "partially_fulfilled", "complete", "canceled")


class Address(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Saved shipping and billing addresses with defaults (r252)."""

    __tablename__ = "addresses"

    kind: Mapped[str] = mapped_column(String(10), default="shipping")  # shipping | billing | both
    label: Mapped[str] = mapped_column(String(120), default="")
    company: Mapped[str] = mapped_column(String(200), default="")
    attention: Mapped[str] = mapped_column(String(200), default="")
    line1: Mapped[str] = mapped_column(String(200), default="")
    line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(120), default="")
    region: Mapped[str] = mapped_column(String(120), default="")  # state / province
    postal_code: Mapped[str] = mapped_column(String(30), default="")
    country: Mapped[str] = mapped_column(String(2), default="")  # ISO 3166-1 alpha-2
    phone: Mapped[str] = mapped_column(String(60), default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)


class Budget(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Maintenance budget per site / category and period, with an approval limit (r268)."""

    __tablename__ = "budgets"

    name: Mapped[str] = mapped_column(String(200))
    period: Mapped[str] = mapped_column(String(10), default="month")  # month | quarter | year
    starts_on: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(TOTAL)
    currency: Mapped[str] = mapped_column(String(3), default="")
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    category: Mapped[str] = mapped_column(String(80), default="")  # free label, e.g. "Spare parts", "Contractors"
    approval_limit: Mapped[Decimal | None] = mapped_column(TOTAL, nullable=True)  # POs above this need approval
    warn_at_pct: Mapped[int] = mapped_column(Integer, default=90)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class PurchaseOrder(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "purchase_orders"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_purchase_orders_number"),)

    number: Mapped[int] = mapped_column(Integer)  # auto number (r249)
    custom_number: Mapped[str] = mapped_column(String(60), default="")  # shown instead when set
    title: Mapped[str] = mapped_column(String(255), default="")  # defaults to "Purchase Order" (r250)
    status: Mapped[str] = mapped_column(String(20), default="requested", index=True)
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True, index=True)
    vendor_contact_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    currency: Mapped[str] = mapped_column(String(3), default="")
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)  # Overdue when not complete by then (r253)
    shipping_address_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("addresses.id"), nullable=True)
    billing_address_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("addresses.id"), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")  # up to 4,096 characters (r254)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)  # r258
    budget_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("budgets.id"), nullable=True)
    # tax exemption (MP-090): set when the vendor holds a certificate for the shipping jurisdiction
    tax_exempt: Mapped[bool] = mapped_column(Boolean, default=False)
    tax_certificate_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    # cached totals
    subtotal: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    extra_total: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))  # taxes + additional costs
    total: Mapped[Decimal] = mapped_column(TOTAL, default=Decimal("0"))
    requested_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    rejected_reason: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    canceled_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="")  # "" | low_stock | work_order | punchout | reorder
    punchout_session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class PurchaseOrderLine(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """An inventory part or a one-off item (r229). Locked once anything has been received."""

    __tablename__ = "purchase_order_lines"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_orders.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    part_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("parts.id"), nullable=True, index=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    part_number: Mapped[str] = mapped_column(String(120), default="")  # vendor's ordering part number
    unit: Mapped[str] = mapped_column(String(30), default="each")
    quantity: Mapped[Decimal] = mapped_column(QTY, default=Decimal("1"))
    unit_cost: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    received: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))
    # receive into
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    product_link_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # supplier listing (MP-088)
    taxable: Mapped[bool] = mapped_column(Boolean, default=True)


class PurchaseOrderCost(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Taxes and additional costs: labelled fixed amounts or percentages (r251)."""

    __tablename__ = "purchase_order_costs"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_orders.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    label: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(8), default="fixed")  # fixed | percent
    value: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    is_tax: Mapped[bool] = mapped_column(Boolean, default=False)
    taxable: Mapped[bool] = mapped_column(Boolean, default=False)  # a fixed cost (shipping) that is itself taxed


class PurchaseOrderReceipt(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One shipment confirmation (r231). Negative quantities correct mistakes."""

    __tablename__ = "purchase_order_receipts"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_orders.id"), index=True)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    received_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    packing_slip: Mapped[str] = mapped_column(String(120), default="")


class PurchaseOrderReceiptLine(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "purchase_order_receipt_lines"

    receipt_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_order_receipts.id"), index=True)
    line_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_order_lines.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(QTY)
    unit_cost: Mapped[Decimal] = mapped_column(MONEY)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # inventory ledger row


class ApprovalRule(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """When a PO (or vendor invoice) needs approval and from whom (r230).

    conditions: [{"field": "total", "op": ">=", "value": "500"}, {"field": "has_one_off"}, {"field": "zero_cost_part"},
                 {"field": "custom:<id>", "op": "=", "value": "…"}, {"field": "location", "op": "in", "value": [...]}]
    action: "approvers" (any one of approver_user_ids / approver_team_ids approves) or "auto_approve".
    """

    __tablename__ = "approval_rules"

    applies_to: Mapped[str] = mapped_column(String(20), default="purchase_order")  # purchase_order | vendor_invoice
    name: Mapped[str] = mapped_column(String(200))
    sort: Mapped[int] = mapped_column(Integer, default=0)
    conditions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    action: Mapped[str] = mapped_column(String(16), default="approvers")
    approver_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    approver_team_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Approval(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One approval step on a PO or vendor invoice."""

    __tablename__ = "approvals"

    entity_type: Mapped[str] = mapped_column(String(20))  # purchase_order | vendor_invoice
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    rule_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("approval_rules.id"), nullable=True)
    approver_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    approver_team_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | approved | rejected | skipped
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    comment: Mapped[str] = mapped_column(Text, default="")


class PurchaseOrderVendorLink(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """The no-login link in the email that sends a PO to the vendor (r261). The vendor sees the PO and can acknowledge
    it, propose a delivery date or decline it with a note. Only the token's sha256 is stored; a new send replaces the
    previous link, and links stop working once the PO is complete or canceled."""

    __tablename__ = "purchase_order_vendor_links"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("purchase_orders.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | replaced
    recipients: Mapped[list[str]] = mapped_column(JSON, default=list)
    response: Mapped[str] = mapped_column(String(16), default="")  # "" | acknowledged | proposed_date | declined
    responder_name: Mapped[str] = mapped_column(String(200), default="")
    proposed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    responded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_viewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
