"""Supplier product links and product cards (0.5.0, MP-084–089, roadmap r213/r267).

A `ProductLink` ties a part or asset to a listing on a supplier's site (Amazon, Grainger, McMaster-Carr…). Links that
point at the same listing share one cached `Product` (title, brand, image, price, stock), refreshed by a background job
from the supplier's API where one is connected, otherwise from the page's schema.org JSON-LD / Open Graph data.
Built-in supplier recognition patterns live in `mpro/suppliers/suppliers.json`; organizations add their own as
`SupplierSite` rows, so adding a supplier needs no code.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

MONEY = Numeric(18, 4)


class SupplierSite(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """An organization's own supplier pattern (in addition to the built-in list)."""

    __tablename__ = "supplier_sites"
    __table_args__ = (UniqueConstraint("org_id", "key", name="uq_supplier_sites_key"),)

    key: Mapped[str] = mapped_column(String(60))  # e.g. "acme_supply"
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(60), default="")
    domains: Mapped[list[str]] = mapped_column(JSON, default=list)  # ["acmesupply.com"]
    # regexes with one named group "id" matched against the URL path+query, e.g. "/item/(?P<id>[A-Z0-9]+)"
    id_patterns: Mapped[list[str]] = mapped_column(JSON, default=list)
    id_label: Mapped[str] = mapped_column(String(60), default="Item #")
    product_url: Mapped[str] = mapped_column(String(500), default="")  # template with {id}
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Product(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Cached details of one supplier listing (MP-085)."""

    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("org_id", "supplier_key", "external_id", name="uq_products_listing"),)

    supplier_key: Mapped[str] = mapped_column(String(60))
    external_id: Mapped[str] = mapped_column(String(120))  # ASIN, Grainger item #, McMaster part #…
    url: Mapped[str] = mapped_column(String(1000))
    title: Mapped[str] = mapped_column(String(500), default="")
    brand: Mapped[str] = mapped_column(String(200), default="")
    image_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    image_url: Mapped[str] = mapped_column(String(1000), default="")  # where it came from
    price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    price_unit: Mapped[str] = mapped_column(String(60), default="")  # "each", "pack of 10"
    # in_stock | out_of_stock | limited | discontinued
    availability: Mapped[str] = mapped_column(String(20), default="")
    sku: Mapped[str] = mapped_column(String(120), default="")
    mpn: Mapped[str] = mapped_column(String(120), default="")
    replacement_url: Mapped[str] = mapped_column(String(1000), default="")  # suggested replacement when discontinued
    specs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(20), default="")  # api | jsonld | opengraph | title | manual
    fetched_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    fetch_status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | ok | blocked | failed
    fetch_error: Mapped[str] = mapped_column(Text, default="")
    next_refresh_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)


class ProductLink(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A part or asset linked to a supplier listing (MP-084, MP-089)."""

    __tablename__ = "product_links"
    __table_args__ = (Index("ix_product_links_entity", "entity_type", "entity_id"),)

    entity_type: Mapped[str] = mapped_column(String(12))  # part | asset
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    role: Mapped[str] = mapped_column(String(16), default="listing")  # listing | spare_part | purchased_from
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("products.id"), index=True)
    url: Mapped[str] = mapped_column(String(1000))
    supplier_key: Mapped[str] = mapped_column(String(60))
    external_id: Mapped[str] = mapped_column(String(120), default="")
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("vendors.id"), nullable=True)
    supplier_sku: Mapped[str] = mapped_column(String(120), default="", index=True)
    mpn: Mapped[str] = mapped_column(String(120), default="", index=True)
    pack_size: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    unit: Mapped[str] = mapped_column(String(30), default="")
    preferred: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(String(500), default="")
    # typed by the user, shown when the site can't be read
    manual_title: Mapped[str] = mapped_column(String(500), default="")
    manual_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    last_paid_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)  # from received POs (MP-088)
    # price / stock alerts (MP-087)
    alert_price_change_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 3), nullable=True)
    alert_out_of_stock: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class ProductPrice(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Price and availability history for the chart (MP-087)."""

    __tablename__ = "product_prices"
    __table_args__ = (Index("ix_product_prices_product_at", "product_id", "at"),)

    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("products.id"))
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    availability: Mapped[str] = mapped_column(String(20), default="")


class SupplierConnection(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Credentials for an official supplier API or PunchOut catalog (MP-086, MP-088). Secrets are encrypted at rest."""

    __tablename__ = "supplier_connections"

    connector: Mapped[str] = mapped_column(String(40))  # amazon_creators | mcmaster | punchout_cxml | punchout_oci
    supplier_key: Mapped[str] = mapped_column(String(60), default="")
    name: Mapped[str] = mapped_column(String(120), default="")
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # non-secret settings (URLs, identities)
    secrets: Mapped[str] = mapped_column(Text, default="")  # mpro.core.crypto.encrypt_json(...)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_success_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    calls_today: Mapped[int] = mapped_column(Integer, default=0)


class PunchOutSession(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A buyer shopping on a supplier's site; the returned cart becomes a PO (MP-088)."""

    __tablename__ = "punchout_sessions"

    connection_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("supplier_connections.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    buyer_cookie: Mapped[str] = mapped_column(String(120), index=True)  # our session id echoed back by the supplier
    status: Mapped[str] = mapped_column(String(12), default="started")  # started | returned | converted | expired
    start_url: Mapped[str] = mapped_column(String(1000), default="")
    cart: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    returned_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    raw: Mapped[str] = mapped_column(Text, default="")
