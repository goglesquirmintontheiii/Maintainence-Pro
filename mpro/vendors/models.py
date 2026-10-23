"""Vendors and customers (0.5.0, MP-045/046).

Vendors supply parts and services: profile, contacts, types, linked assets/locations/parts and purchase orders
(MaintainX "Vendors", roadmap r233, r262–r264). Customers are for service companies and internal chargebacks
(MaintainX for Service: r234, r235): customer records linking locations, assets, work orders and contacts, plus quotes.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime
from mpro.extensions import db


class VendorType(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Labels such as Manufacturer, Distributor, Contractor (r263)."""

    __tablename__ = "vendor_types"

    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")


class Vendor(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendors"

    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")
    description: Mapped[str] = mapped_column(Text, default="")
    picture_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    website: Mapped[str] = mapped_column(String(500), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    # {"line1", "line2", "city", "region", "postal_code", "country"}
    address: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    account_number: Mapped[str] = mapped_column(String(120), default="")  # the org's customer number at this vendor
    # the vendor's own tax-exemption account ids for the org, e.g. {"amazon_business": "TE-…"} (MP-090)
    exemption_accounts: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    payment_terms: Mapped[str] = mapped_column(String(80), default="")  # e.g. "Net 30", "2/10 net 30"
    currency: Mapped[str] = mapped_column(String(3), default="")  # "" = org currency
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # custom vendor fields (r264)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class VendorTypeLink(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendor_type_links"
    __table_args__ = (UniqueConstraint("vendor_id", "type_id", name="uq_vendor_type_links"),)

    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    type_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendor_types.id"), index=True)


class VendorContact(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Contact list with email, phone, extension and role (r262)."""

    __tablename__ = "vendor_contacts"

    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    extension: Mapped[str] = mapped_column(String(20), default="")
    is_po_contact: Mapped[bool] = mapped_column(Boolean, default=False)  # gets purchase orders by default
    cc_on_po: Mapped[bool] = mapped_column(Boolean, default=False)


class VendorAsset(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendor_assets"
    __table_args__ = (UniqueConstraint("vendor_id", "asset_id", name="uq_vendor_assets"),)

    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), index=True)


class VendorLocation(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "vendor_locations"
    __table_args__ = (UniqueConstraint("vendor_id", "location_id", name="uq_vendor_locations"),)

    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("locations.id"), index=True)


# ---------------------------------------------------------------- customers (service companies, r234–r235)


class Customer(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "customers"

    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")
    description: Mapped[str] = mapped_column(Text, default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    billing_address: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    billing_email: Mapped[str] = mapped_column(String(255), default="")
    tax_id: Mapped[str] = mapped_column(String(80), default="")
    payment_terms: Mapped[str] = mapped_column(String(80), default="")
    currency: Mapped[str] = mapped_column(String(3), default="")
    # billing rates for invoices built from work orders (MP-093)
    labor_rate: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    parts_markup_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 3), nullable=True)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    default_location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class CustomerContact(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "customer_contacts"

    customer_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("customers.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    is_billing: Mapped[bool] = mapped_column(Boolean, default=False)


class CustomerAsset(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "customer_assets"
    __table_args__ = (UniqueConstraint("customer_id", "asset_id", name="uq_customer_assets"),)

    customer_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("customers.id"), index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), index=True)


QUOTE_STATUSES = ("draft", "sent", "approved", "rejected", "expired", "canceled")


class Quote(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Scope/cost estimate shared by external link; the customer comments and approves or rejects (r235)."""

    __tablename__ = "quotes"

    number: Mapped[int] = mapped_column(Integer)
    customer_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("customers.id"), index=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(255))
    scope: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="draft")
    currency: Mapped[str] = mapped_column(String(3), default="")
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"))
    share_token_hash: Mapped[str] = mapped_column(String(128), default="")  # sha256 of the link token
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    decided_by_name: Mapped[str] = mapped_column(String(200), default="")
    decision_comment: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class QuoteLine(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "quote_lines"

    quote_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("quotes.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(12), default="other")  # labor | part | other
    part_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("parts.id"), nullable=True)
    description: Mapped[str] = mapped_column(String(500))
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), default=Decimal("1"))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), default=Decimal("0"))
    taxable: Mapped[bool] = mapped_column(Boolean, default=True)
