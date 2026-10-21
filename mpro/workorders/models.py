"""Work-order data model (0.2.0).

Asset, location, procedure, part and vendor links arrive with their modules (0.3.0–0.5.0) as extra
nullable columns or link tables; nothing here needs to change shape for them.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

if TYPE_CHECKING:
    from mpro.auth.models import User
    from mpro.orgs.models import Team

STATUSES = ("open", "on_hold", "in_progress", "done", "canceled")
ACTIVE_STATUSES = ("open", "on_hold", "in_progress")
CLOSED_STATUSES = ("done", "canceled")
STATUS_LABELS = {
    "open": "Open",
    "on_hold": "On Hold",
    "in_progress": "In Progress",
    "done": "Done",
    "canceled": "Canceled",
}
PRIORITIES = ("none", "low", "medium", "high")
PRIORITY_LABELS = {"none": "None", "low": "Low", "medium": "Medium", "high": "High"}
PRIORITY_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3}
WORK_TYPES = ("reactive", "preventive", "other")
WORK_TYPE_LABELS = {"reactive": "Reactive", "preventive": "Preventive", "other": "Other"}
LINK_KINDS = ("blocks", "related")
FIELD_TYPES = ("text", "textarea", "number", "select", "date", "datetime", "link", "checkbox")


class Counter(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Per-organization sequences, e.g. the next work-order number (#1042). Locked on PostgreSQL."""

    __tablename__ = "counters"
    __table_args__ = (UniqueConstraint("org_id", "key", name="uq_counters_org_key"),)

    key: Mapped[str] = mapped_column(String(40))
    value: Mapped[int] = mapped_column(BigInteger, default=0)  # last number handed out


class Category(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")
    description: Mapped[str] = mapped_column(String(500), default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)


class WorkOrder(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "work_orders"
    __table_args__ = (
        UniqueConstraint("org_id", "number", name="uq_work_orders_org_number"),
        Index("ix_work_orders_org_status_due", "org_id", "status", "due_at"),
        CheckConstraint("estimated_minutes IS NULL OR estimated_minutes >= 0", name="estimate_nonneg"),
    )

    number: Mapped[int] = mapped_column(BigInteger)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    sub_status: Mapped[str] = mapped_column(String(60), default="")
    priority: Mapped[str] = mapped_column(String(10), default="none")
    work_type: Mapped[str] = mapped_column(String(16), default="reactive")
    start_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True, index=True)
    template_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # custom field id -> value

    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True, index=True)
    status_changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    activity_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # drives unread state
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)
    completed_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    completion_summary: Mapped[str] = mapped_column(Text, default="")
    cancel_reason: Mapped[str] = mapped_column(Text, default="")
    signature_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    signed_by_name: Mapped[str] = mapped_column(String(200), default="")
    signed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    approval_status: Mapped[str] = mapped_column(String(16), default="none")  # none|pending|approved|rejected
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    # Optimistic concurrency (r018): bumped on field and status edits (not on comments), checked on save.
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    assignees: Mapped[list[WorkOrderAssignee]] = relationship(
        back_populates="work_order", lazy="selectin", cascade="all, delete-orphan"
    )
    category_links: Mapped[list[WorkOrderCategory]] = relationship(
        back_populates="work_order", lazy="selectin", cascade="all, delete-orphan"
    )
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="joined")
    completed_by: Mapped[User | None] = relationship(foreign_keys=[completed_by_id], lazy="joined")
    approved_by: Mapped[User | None] = relationship(foreign_keys=[approved_by_id], lazy="joined")


class WorkOrderAssignee(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "work_order_assignees"
    __table_args__ = (
        CheckConstraint("(user_id IS NULL) <> (team_id IS NULL)", name="user_xor_team"),
        UniqueConstraint("work_order_id", "user_id", "team_id", name="uq_wo_assignees_wo_user_team"),
    )

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True, index=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("teams.id"), nullable=True, index=True)

    work_order: Mapped[WorkOrder] = relationship(back_populates="assignees")
    user: Mapped[User | None] = relationship(lazy="joined")
    team: Mapped[Team | None] = relationship(lazy="joined")


class WorkOrderCategory(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "work_order_categories"
    __table_args__ = (UniqueConstraint("work_order_id", "category_id", name="uq_wo_categories_wo_category"),)

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    category_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("categories.id"), index=True)

    work_order: Mapped[WorkOrder] = relationship(back_populates="category_links")
    category: Mapped[Category] = relationship(lazy="joined")


class WorkOrderLink(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """`from` blocks `to`, or the two are related."""

    __tablename__ = "work_order_links"
    __table_args__ = (UniqueConstraint("from_id", "to_id", name="uq_wo_links_from_to"),)

    from_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    to_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="related")


class StatusChange(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Every status change, for history and time-in-status reports (r057)."""

    __tablename__ = "work_order_status_changes"

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    from_status: Mapped[str] = mapped_column(String(16), default="")
    to_status: Mapped[str] = mapped_column(String(16))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    comment: Mapped[str] = mapped_column(Text, default="")


class Comment(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "comments"

    entity_type: Mapped[str] = mapped_column(String(40), default="work_order")
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    body: Mapped[str] = mapped_column(Text, default="")
    mentions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {"users": [...], "teams": [...]}
    reactions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # emoji -> [user ids]
    edited_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    author: Mapped[User | None] = relationship(lazy="joined")


class TimeEntry(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "time_entries"

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    minutes: Mapped[int] = mapped_column(Integer)
    time_type: Mapped[str] = mapped_column(String(60), default="Work")
    rate_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)  # override; None = user/org rate
    effective_rate_cents: Mapped[int] = mapped_column(Integer, default=0)  # rate used when logged
    note: Mapped[str] = mapped_column(String(500), default="")
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)

    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="joined")


class Timer(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A running timer. Stopping it creates a TimeEntry. Several people can time the same WO."""

    __tablename__ = "timers"
    __table_args__ = (UniqueConstraint("work_order_id", "user_id", name="uq_timers_wo_user"),)

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    time_type: Mapped[str] = mapped_column(String(60), default="Work")


class CostEntry(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "cost_entries"

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    amount_cents: Mapped[int] = mapped_column(BigInteger)
    cost_type: Mapped[str] = mapped_column(String(60), default="Other")
    description: Mapped[str] = mapped_column(String(500), default="")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)

    user: Mapped[User | None] = relationship(foreign_keys=[user_id], lazy="joined")


class CustomField(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "custom_fields"

    entity_type: Mapped[str] = mapped_column(String(40), default="work_order")
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(16))
    options: Mapped[list[str]] = mapped_column(JSON, default=list)  # for select
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    copy_on_repeat: Mapped[bool] = mapped_column(Boolean, default=True)
    on_request_form: Mapped[bool] = mapped_column(Boolean, default=False)
    sort: Mapped[int] = mapped_column(Integer, default=0)


class Template(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "work_order_templates"

    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(500), default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class SavedView(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Saved filters for a list. owner_id NULL = shared with the whole organization."""

    __tablename__ = "saved_views"

    entity_type: Mapped[str] = mapped_column(String(40), default="work_order")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    filters: Mapped[list[Any]] = mapped_column(JSON, default=list)
    sort: Mapped[str] = mapped_column(String(40), default="")
    columns: Mapped[list[str]] = mapped_column(JSON, default=list)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)


class ReadMark(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "read_marks"
    __table_args__ = (UniqueConstraint("entity_id", "user_id", name="uq_read_marks_entity_user"),)

    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    read_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
