"""Automations: trigger → conditions → actions (0.4.0, MP-117). Replaces 0.3.0 meter triggers.

`trigger`, `conditions` and `actions` are validated JSON documents (see services). One automation can watch up to
250 assets/meters (`targets`); per-target state (counters for "N of last M", last fired) lives in AutomationState.
Every evaluation that does something — or fails, or is skipped — is recorded in AutomationRun (action history).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime
from mpro.extensions import db

TRIGGER_TYPES = ("meter_reading", "asset_status", "work_order_status")
ACTION_TYPES = ("create_work_order", "change_asset_status", "send_email")
RUN_STATUSES = ("ok", "failed", "skipped")


class Automation(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "automations"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    conditions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    actions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    sensitivity: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # "for" settings (r175)
    rerun_minutes: Mapped[int] = mapped_column(Integer, default=0)  # don't fire again within (r201)
    targets: Mapped[list[str]] = mapped_column(JSON, default=list)  # asset or meter ids (≤ 250, r176)
    last_run_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    fail_count: Mapped[int] = mapped_column(Integer, default=0)
    skip_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    legacy_trigger_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # migrated meter trigger


class AutomationState(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "automation_states"
    __table_args__ = (UniqueConstraint("automation_id", "target_id", name="uq_automation_states_target"),)

    automation_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("automations.id"), index=True)
    target_id: Mapped[str] = mapped_column(String(40))  # asset/meter id, or "*" for org-wide triggers
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # recent readings, next milestone, armed…
    last_fired_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class AutomationRun(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "automation_runs"

    automation_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("automations.id"), index=True)
    target_id: Mapped[str] = mapped_column(String(40), default="")
    status: Mapped[str] = mapped_column(String(10))
    message: Mapped[str] = mapped_column(Text, default="")
    results: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{action, ok, work_order_id…}]
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
