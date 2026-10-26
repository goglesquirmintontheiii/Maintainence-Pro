"""QR codes and barcodes for every kind of record (MP-095)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db


class QrCode(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A label code. `kind="mpro"` codes are random and resolve at /q/<code>. `kind="external"` holds an
    existing barcode value (Code 128, Data Matrix, a MaintainX QR value…) so scanning it finds the record.
    A code can be unassigned (tag first, assign later), retired, or moved to another record."""

    __tablename__ = "qr_codes"
    __table_args__ = (UniqueConstraint("org_id", "value", name="uq_qr_codes_org_value"),)

    kind: Mapped[str] = mapped_column(String(10), default="mpro")
    value: Mapped[str] = mapped_column(String(200), index=True)  # the code for mpro, the raw value for external
    symbology: Mapped[str] = mapped_column(String(20), default="qr")
    entity_type: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    note: Mapped[str] = mapped_column(String(200), default="")
    retired_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    assigned_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    batch: Mapped[str] = mapped_column(String(40), default="")


# ---- 0.6.0 scan actions, check-ins and scan history (MP-097) -------------------------------------------------------
class ScanEvent(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One scan, or one action taken after a scan (check-in, start, reading…). The scan history is proof of visit:
    who was where, when, and (if the organization turned it on and the phone allowed it) where on the map.
    Public scans (no sign-in) have no user and keep no IP address."""

    __tablename__ = "scan_events"
    __table_args__ = (
        UniqueConstraint("org_id", "client_id", name="uq_scan_events_org_client"),
        Index("ix_scan_events_org_entity", "org_id", "entity_type", "entity_id", "scanned_at"),
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True, index=True)
    code_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("qr_codes.id"), nullable=True)
    entity_type: Mapped[str] = mapped_column(String(20))
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    entity_label: Mapped[str] = mapped_column(String(300), default="")
    action: Mapped[str] = mapped_column(String(20), default="scan")  # scan | check_in | start | complete | …
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    source: Mapped[str] = mapped_column(String(12), default="camera")  # camera | link | typed | photo | public
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6), nullable=True)
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6), nullable=True)
    accuracy_m: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scanned_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # on the phone (offline scans sync later)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # idempotency for offline replays


class ScanRequirement(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Optional per procedure: work orders using it need a scan of their asset, location or own code by the person
    starting or completing them (like MaintainX's location check-in)."""

    __tablename__ = "scan_requirements"
    __table_args__ = (UniqueConstraint("org_id", "procedure_id", name="uq_scan_requirements_procedure"),)

    procedure_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedures.id"), index=True)
    on_start: Mapped[bool] = mapped_column(Boolean, default=False)
    on_complete: Mapped[bool] = mapped_column(Boolean, default=False)


class PublicScanHit(IdMixin, db.Model):  # type: ignore[name-defined]
    """Public (signed-out) scan lookups, for rate limiting only. The IP is stored hashed and kept for a day."""

    __tablename__ = "public_scan_hits"

    ip_hash: Mapped[str] = mapped_column(String(64), index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
