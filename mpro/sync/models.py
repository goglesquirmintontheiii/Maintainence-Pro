"""Offline sync for the phone app: database models."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, UTCDateTime, utcnow
from mpro.extensions import db


class IdempotentRequest(IdMixin, db.Model):  # type: ignore[name-defined]
    """A change sent with an `Idempotency-Key` header (r270).

    The phone app gives every queued offline change a key and may send it more than once (the reply was lost, the
    app was closed mid-sync). The first request runs; a repeat with the same key gets the stored reply back instead of
    running again. `status_code == 0` means the first request is still running.
    """

    __tablename__ = "idempotent_requests"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_idempotent_requests_user_key"),)

    org_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True, nullable=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    key: Mapped[str] = mapped_column(String(100))
    method: Mapped[str] = mapped_column(String(10))
    path: Mapped[str] = mapped_column(String(500))
    status_code: Mapped[int] = mapped_column(Integer, default=0)
    response: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
