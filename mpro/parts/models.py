"""Parts & inventory (0.5.0, MP-039–041).

Inventory is a ledger (roadmap r211): every use, restock, transfer, adjustment, receipt and count is an immutable
`InventoryTransaction`; on-hand quantity per (part, location) is a cached sum in `PartStock`, updated in the same
transaction under a row lock (`mpro.parts.ledger`) so two technicians can't both take the last one.
Quantities and money are Decimal (G-12); unit costs are in the organization's currency.

MaintainX parity: part fields (r214), multi-location stock with area/bin, min and max (r218), part statuses and
availability (r219/r220: Assigned, Reserved, Kitted, Staged, Issued), parts used on work orders (r029), cycle counts
(r222) and the transactions log (r223).
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

QTY = Numeric(18, 4)
MONEY = Numeric(18, 4)  # unit costs can be fractions of a cent (a box of 1,000 screws)

TXN_KINDS = (
    "restock",  # +Restock (r242)
    "use",  # used on a work order (r029)
    "return",  # returned from a work order
    "adjust",  # manual adjustment; removals need a note (r242)
    "transfer_out",  # between locations
    "transfer_in",
    "receive",  # purchase order receipt (r231)
    "count",  # cycle count correction (r222)
    "initial",  # opening balance when a part or location stock is created
)
RESERVATION_STATUSES = ("assigned", "reserved", "kitted", "staged", "issued", "released")


class PartType(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Custom labels; a Critical type turns on low-stock escalation emails (r240)."""

    __tablename__ = "part_types"

    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")
    critical: Mapped[bool] = mapped_column(Boolean, default=False)


class Part(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "parts"

    name: Mapped[str] = mapped_column(String(255))
    part_number: Mapped[str] = mapped_column(String(120), default="", index=True)  # the org's own ID / code
    description: Mapped[str] = mapped_column(Text, default="")
    unit: Mapped[str] = mapped_column(String(30), default="each")  # each, box, m, l…
    unit_cost: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))  # average unit cost (r238)
    barcode: Mapped[str] = mapped_column(String(200), default="", index=True)
    picture_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    lead_time_days: Mapped[int | None] = mapped_column(Integer, nullable=True)  # r244
    non_stock: Mapped[bool] = mapped_column(Boolean, default=False)  # r247: bought as needed, no stock kept
    manufacturer: Mapped[str] = mapped_column(String(200), default="")
    mpn: Mapped[str] = mapped_column(String(120), default="", index=True)  # manufacturer part number (MP-084)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # custom part fields (r245)
    # cached totals across locations, kept by the ledger
    on_hand: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))
    reserved: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))  # reserved + kitted + staged
    ordered: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))  # on open POs, not yet received
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class PartTypeLink(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "part_type_links"
    __table_args__ = (UniqueConstraint("part_id", "type_id", name="uq_part_type_links"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    type_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("part_types.id"), index=True)


class PartAsset(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Parts that fit an asset; added by hand or automatically when used on its work order (r215)."""

    __tablename__ = "part_assets"
    __table_args__ = (UniqueConstraint("part_id", "asset_id", name="uq_part_assets"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), index=True)
    auto: Mapped[bool] = mapped_column(Boolean, default=False)


class PartTeam(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "part_teams"
    __table_args__ = (UniqueConstraint("part_id", "team_id", name="uq_part_teams"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    team_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("teams.id"), index=True)


class PartVendor(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Who sells the part, and their ordering part number (r214, r233)."""

    __tablename__ = "part_vendors"
    __table_args__ = (UniqueConstraint("part_id", "vendor_id", name="uq_part_vendors"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    vendor_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("vendors.id"), index=True)
    vendor_part_number: Mapped[str] = mapped_column(String(120), default="", index=True)
    unit_cost: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)  # last price from this vendor
    lead_time_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preferred: Mapped[bool] = mapped_column(Boolean, default=False)


class PartStock(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A part at one location: area/bin, min/max and the cached on-hand sum (r218)."""

    __tablename__ = "part_stock"
    __table_args__ = (UniqueConstraint("part_id", "location_id", name="uq_part_stock_location"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    area: Mapped[str] = mapped_column(String(120), default="")  # area / bin / shelf
    on_hand: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))
    reserved: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))
    min_qty: Mapped[Decimal | None] = mapped_column(QTY, nullable=True)
    max_qty: Mapped[Decimal | None] = mapped_column(QTY, nullable=True)
    low_alerted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # last low-stock alert


class InventoryTransaction(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One immutable ledger row (r211, r223). Never updated or deleted; mistakes are corrected with a new row."""

    __tablename__ = "inventory_transactions"
    __table_args__ = (Index("ix_inventory_transactions_part_at", "part_id", "at"),)

    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16))
    quantity: Mapped[Decimal] = mapped_column(QTY)  # signed change
    before: Mapped[Decimal] = mapped_column(QTY)  # on hand at this location before / after
    after: Mapped[Decimal] = mapped_column(QTY)
    unit_cost: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    po_line_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    cycle_count_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    transfer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # pairs transfer_out with transfer_in
    file_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class WorkOrderPart(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A part on a work order: planned, reserved/kitted/staged, then issued when used (r029, r219, r239)."""

    __tablename__ = "work_order_parts"

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    quantity: Mapped[Decimal] = mapped_column(QTY, default=Decimal("1"))  # planned / needed
    used: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))  # issued so far
    status: Mapped[str] = mapped_column(String(12), default="assigned")  # RESERVATION_STATUSES
    unit_cost_override: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)  # per-WO cost (r239)
    note: Mapped[str] = mapped_column(String(500), default="")
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class CycleCount(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A scheduled stock count (r222). Each occurrence creates a cycle-count work order with one line per part."""

    __tablename__ = "cycle_counts"

    name: Mapped[str] = mapped_column(String(255))
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    # which parts: {"part_ids": [...], "type_ids": [...], "area": "A-*", "all": true}
    selection: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rrule: Mapped[str] = mapped_column(String(500), default="")  # "" = one-off
    next_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)
    assignee_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class CycleCountRun(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "cycle_count_runs"

    cycle_count_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("cycle_counts.id"), index=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(12), default="open")  # open | done | canceled
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class CycleCountLine(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "cycle_count_lines"
    __table_args__ = (UniqueConstraint("run_id", "part_id", "location_id", name="uq_cycle_count_lines"),)

    run_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("cycle_count_runs.id"), index=True)
    part_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("parts.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    expected: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))  # on hand when the count started
    counted: Mapped[Decimal | None] = mapped_column(QTY, nullable=True)
    counted_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    counted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    note: Mapped[str] = mapped_column(String(500), default="")


from mpro.parts import settings as _settings  # noqa: E402,F401  (registers the "parts" settings defaults)
