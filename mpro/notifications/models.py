"""Notifications: database models (0.6.0: MP-050–MP-052)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, TimestampMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db


class Notification(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One notification for one person. The row is the in-app inbox item and tracks email and push delivery."""

    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("event_id", "user_id", "kind", name="uq_notifications_event_user_kind"),
        Index("ix_notifications_user_inbox", "user_id", "org_id", "created_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # catalogue key, e.g. "wo.assigned"
    category: Mapped[str] = mapped_column(String(20), default="work_orders")
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(500), default="")  # app path, e.g. /work-orders/<id>
    entity_type: Mapped[str] = mapped_column(String(40), default="")
    entity_id: Mapped[str] = mapped_column(String(64), default="")
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    actor_label: Mapped[str] = mapped_column(String(300), default="")
    event_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    in_app: Mapped[bool] = mapped_column(Boolean, default=True)
    # email: none (not wanted) | pending (waiting for a digest, quiet hours or a pause) | sent
    email_state: Mapped[str] = mapped_column(String(10), default="none", index=True)
    push_state: Mapped[str] = mapped_column(String(10), default="none")  # none | queued | sent | skipped | failed
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "kind": self.kind,
            "category": self.category,
            "title": self.title,
            "body": self.body,
            "link": self.link,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "actor_id": str(self.actor_id) if self.actor_id else None,
            "actor": self.actor_label,
            "created_at": iso(self.created_at),
            "read_at": iso(self.read_at),
        }


class NotificationPref(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A person's notification settings in one organization (missing keys fall back to the defaults)."""

    __tablename__ = "notification_prefs"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_notification_prefs_org_user"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    prefs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    paused_until: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_digest_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class PushSubscription(IdMixin, db.Model):  # type: ignore[name-defined]
    """A browser/device that opted in to web push (MP-051). Belongs to the person, across organizations."""

    __tablename__ = "push_subscriptions"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    endpoint: Mapped[str] = mapped_column(String(1000), unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(200), default="")  # e.g. "Chrome on Android"
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    failures: Mapped[int] = mapped_column(Integer, default=0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "label": self.label,
            "created_at": iso(self.created_at),
            "last_used_at": iso(self.last_used_at),
        }


class PushKey(IdMixin, db.Model):  # type: ignore[name-defined]
    """The server's VAPID key pair (one row). The private key is encrypted at rest (G-16)."""

    __tablename__ = "push_keys"

    public_key: Mapped[str] = mapped_column(String(200))  # base64url, uncompressed P-256 point
    private_key: Mapped[str] = mapped_column(Text)  # "enc1:…" PEM
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class EscalationRule(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Escalate open work orders (MP-052, r083): after N hours overdue (or open without being started)."""

    __tablename__ = "escalation_rules"

    name: Mapped[str] = mapped_column(String(120))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger: Mapped[str] = mapped_column(String(16), default="overdue")  # overdue | not_started
    after_hours: Mapped[int] = mapped_column(Integer, default=4)
    priorities: Mapped[list[str]] = mapped_column(JSON, default=list)  # empty = any priority
    category_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # empty = any category
    notify_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    notify_team_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    notify_admins: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_assignees: Mapped[bool] = mapped_column(Boolean, default=False)
    raise_priority: Mapped[bool] = mapped_column(Boolean, default=False)  # also set the work order to High
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class WorkOrderNotice(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Remembers time-based notices already sent (due soon, overdue, escalations) so each goes out once.

    `due_at` is part of the key: when a work order's due date changes it can become due soon or overdue again.
    """

    __tablename__ = "work_order_notices"
    __table_args__ = (UniqueConstraint("work_order_id", "kind", "ref", name="uq_work_order_notices"),)

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # due_soon | overdue | escalated
    ref: Mapped[str] = mapped_column(String(80))  # due date (ISO) or "<rule id>"
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
