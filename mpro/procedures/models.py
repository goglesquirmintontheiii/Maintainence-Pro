"""Procedures (checklists) and their answers on work orders (0.4.0, MP-034–037).

A procedure has versions. A version's `schema` is a JSON document: an ordered list of items (headings, sections,
fields, nested procedures) with field types, options, conditions, scoring and assignment. Work orders attach a
specific version as a *run*; answers are stored one row per field so they can be reported on across work orders.
Completed work orders keep the version they used (roadmap r154).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime
from mpro.extensions import db

# MaintainX procedure field types (roadmap r180) plus MPro's location check-in (r043/r120) and meter reading.
FIELD_TYPES = (
    "checkbox",
    "text",
    "number",
    "amount",
    "multiple_choice",
    "checklist",
    "inspection",  # pass / flag / fail
    "yes_no_na",
    "date",
    "file",  # pictures and files
    "signature",
    "meter_reading",
    "location_check_in",
)
STRUCTURE_TYPES = ("heading", "section", "procedure")  # "procedure" = a nested library procedure (r185)
PROCEDURE_STATUSES = ("draft", "published", "archived")
RUN_STATUSES = ("not_started", "in_progress", "done")


class Procedure(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "procedures"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="draft")
    category: Mapped[str] = mapped_column(String(80), default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    # seasonal variants (r598): [{"name": "Winter", "months": [11, 12, 1, 2, 3], "procedure_id": "<uuid>"}]
    variants: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # set for one-off procedures built inside a single work order (r210); hidden from the library
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class ProcedureVersion(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "procedure_versions"
    __table_args__ = (UniqueConstraint("procedure_id", "number", name="uq_procedure_versions_number"),)

    procedure_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedures.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {"items": [...], "scoring": {...}}
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    changes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # added / edited / removed (r206)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class ProcedureRun(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A procedure version attached to a work order (r076); several per work order, each its own section."""

    __tablename__ = "procedure_runs"

    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    procedure_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedures.id"), index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedure_versions.id"), index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(12), default="not_started")
    score: Mapped[Decimal | None] = mapped_column(Numeric(7, 2), nullable=True)  # percent (r184)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class ProcedureAnswer(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One answer to one field of a run. Typed columns make reporting across work orders cheap (MP-037, r596)."""

    __tablename__ = "procedure_answers"
    __table_args__ = (
        UniqueConstraint("run_id", "field_id", name="uq_procedure_answers_run_field"),
        Index("ix_procedure_answers_proc_field", "procedure_id", "field_id"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedure_runs.id"), index=True)
    procedure_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("procedures.id"))
    work_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("work_orders.id"), index=True)
    field_id: Mapped[str] = mapped_column(String(40))  # stable id inside the schema
    field_type: Mapped[str] = mapped_column(String(24))
    value: Mapped[Any] = mapped_column(JSON, nullable=True)  # the raw answer
    value_number: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    value_text: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[str] = mapped_column(String(8), default="")  # pass | flag | fail | yes | no | na
    note: Mapped[str] = mapped_column(Text, default="")
    file_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    answered_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)  # e.g. location check-in skipped (logged)
