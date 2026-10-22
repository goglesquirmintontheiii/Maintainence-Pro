"""QR codes and barcodes for every kind of record (MP-095)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, TimestampMixin, UTCDateTime
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
