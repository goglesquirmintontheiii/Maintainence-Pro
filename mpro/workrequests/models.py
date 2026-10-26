"""Work requests and request portals: database models (0.6.0: MP-047, MP-048, r236, r265, r273–r300)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

# MaintainX request statuses (r273). Done / Canceled follow the linked work order; Skipped is kept for imports.
STATUSES = ("pending", "approved", "declined", "done", "canceled", "skipped")
STATUS_LABELS = {
    "pending": "Pending",
    "approved": "Approved",
    "declined": "Declined",
    "done": "Done",
    "canceled": "Canceled",
    "skipped": "Skipped",
}
SOURCES = ("app", "portal", "qr")


class WorkRequest(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "work_requests"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_work_requests_org_number"),)

    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[str] = mapped_column(String(10), default="none")
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    asset_status: Mapped[str] = mapped_column(String(16), default="")  # "" | online | offline (reported with it)
    # "Assign to" routing (r278): a team, or route_other = every administrator
    team_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("teams.id"), nullable=True, index=True)
    route_other: Mapped[bool] = mapped_column(Boolean, default=False)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(10), default="app")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True, index=True)
    portal_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("request_portals.id"), nullable=True, index=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customers.id"), nullable=True, index=True)
    # people outside the organization (portals): who sent it and whether they want status emails (r280)
    submitter_name: Mapped[str] = mapped_column(String(200), default="")
    submitter_email: Mapped[str] = mapped_column(String(320), default="")
    submitter_phone: Mapped[str] = mapped_column(String(60), default="")
    notify_email: Mapped[bool] = mapped_column(Boolean, default=False)
    status_token_hash: Mapped[str] = mapped_column(String(64), default="", index=True)  # no-login status link (r603)
    # decision
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_orders.id"), nullable=True, index=True
    )
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    decline_reason: Mapped[str] = mapped_column(Text, default="")
    seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # first opened by an approver (r299)
    status_changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class RequestPortal(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A public request form with its own URL and QR code (r279), optionally for one customer (r265)."""

    __tablename__ = "request_portals"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    intro: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # field -> optional | required | hidden (title is always required)
    fields: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    custom_field_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # WO custom fields shown (r295)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("teams.id"), nullable=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customers.id"), nullable=True, index=True)
    require_email: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class PortalHit(IdMixin, db.Model):  # type: ignore[name-defined]
    """Recent public portal requests, for rate limits (kept for a day)."""

    __tablename__ = "request_portal_hits"

    ip: Mapped[str] = mapped_column(String(64), index=True)
    portal_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    write: Mapped[bool] = mapped_column(Boolean, default=False)
    kind: Mapped[str] = mapped_column(String(10), default="")  # "" (a read), "submit" or "upload": counted apart
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class GuestAccess(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """What a Guest (r236) may see: work at these locations (and below), quotes of this customer."""

    __tablename__ = "guest_access"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_guest_access_org_user"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    location_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("customers.id"), nullable=True)
