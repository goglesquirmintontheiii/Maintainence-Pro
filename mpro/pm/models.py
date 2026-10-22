"""Preventive maintenance: repeating work orders and Maintenance Plans with nested PMs (0.4.0, MP-032/033/038/104).

One engine serves both MaintainX concepts:
- a **repeating work order** (WO recurrence, a "chain") is a plan with `kind="repeat"` and a single task;
- a **Maintenance Plan** (`kind="plan"`) holds up to 10 tasks on different cycles (nested PMs), time-based,
  usage-based (meter) or whichever comes first.
Each due date becomes an *occurrence*. Occurrences are created ahead of time (preview, per-occurrence edits,
skip/postpone) and turn into work orders inside the plan's scheduling horizon. Generated work orders carry
`source_type="pm_occurrence"` and `source_id=<occurrence id>`. Times use RFC 5545 RRULEs in the plan's time zone
(roadmap r153), and generation is idempotent: (plan, task, due date) is unique.
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

PLAN_KINDS = ("plan", "repeat")
SCHEDULE_KINDS = ("time", "usage", "time_or_usage")
INTERVAL_MODES = ("fixed", "floating")  # fixed = original schedule; floating = from last completion (r197)
OCCURRENCE_STATUSES = ("planned", "generating", "generated", "skipped", "completed", "canceled")


class MaintenancePlan(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "maintenance_plans"

    kind: Mapped[str] = mapped_column(String(10), default="plan")
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)  # paused when False
    schedule_kind: Mapped[str] = mapped_column(String(16), default="time")
    interval_mode: Mapped[str] = mapped_column(String(10), default="fixed")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    horizon_days: Mapped[int] = mapped_column(Integer, default=14)  # generate work orders this far ahead (r165)
    start_offset_days: Mapped[int] = mapped_column(Integer, default=0)  # WO start date = due - N days (r198)
    # default work-order details: title, description, priority, assignees, categories, estimated_minutes,
    # procedure_ids, custom, sub_work_orders (repeating parents recreate their subs, r195) …
    defaults: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # calendar rules (MP-038): {"months": [4..10], "skip_weekends": true, "skip_holidays": true, "shift": "previous"}
    calendar: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source_work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # repeat: the first WO
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # the latest generation problem, shown on the plan (e.g. a procedure was unpublished) (#9)
    last_problem: Mapped[str] = mapped_column(Text, default="")


class PMTask(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One cycle inside a plan (nested PM, r167): e.g. monthly filters, quarterly belts, annual overhaul."""

    __tablename__ = "pm_tasks"

    plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("maintenance_plans.id"), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    sort: Mapped[int] = mapped_column(Integer, default=0)
    rrule: Mapped[str] = mapped_column(String(500), default="")  # time-based; "" for usage-only
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # the friendly form the rule came from
    anchor: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # DTSTART (first due date)
    meter_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("meters.id"), nullable=True)
    every_units: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)  # usage-based
    next_units: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)  # next meter milestone
    lead_units: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)  # create this early (r166)
    overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # task-specific WO details
    procedure_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    last_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # floating intervals


class PMOccurrence(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One scheduled due date of a plan. Several tasks due together merge into one occurrence (one visit)."""

    __tablename__ = "pm_occurrences"
    __table_args__ = (UniqueConstraint("plan_id", "key", name="uq_pm_occurrences_plan_key"),)

    plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("maintenance_plans.id"), index=True)
    key: Mapped[str] = mapped_column(String(120))  # idempotency key, e.g. "2026-11-01" or "units:5000"
    task_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)
    due_units: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    original_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # before a move
    status: Mapped[str] = mapped_column(String(12), default="planned", index=True)
    overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # per-occurrence assignees, dates (r169)
    skip_reason: Mapped[str] = mapped_column(Text, default="")
    skipped_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)
    generated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # for compliance (r200)


class Holiday(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Days PMs skip or shift away from (MP-038)."""

    __tablename__ = "holidays"
    __table_args__ = (UniqueConstraint("org_id", "day", name="uq_holidays_org_day"),)

    day: Mapped[date] = mapped_column(Date)
    name: Mapped[str] = mapped_column(String(120), default="")
