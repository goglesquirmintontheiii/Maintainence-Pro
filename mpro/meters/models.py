"""Meters, readings, monitoring points and meter triggers (0.3.0).

Readings are a time series. On PostgreSQL the table is partitioned by month (roadmap r105); the primary
key is (id, recorded_at) so partitions work. SQLite uses the same table without partitions.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.ids import uuid7
from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

FREQUENCIES = ("none", "hour", "day", "week", "month", "year")
METER_TYPES = ("manual", "automated")
# MaintainX unit groups (r122) with common units; organizations can add their own.
UNITS: dict[str, list[str]] = {
    "Time": ["hours", "minutes", "days"],
    "Distance": ["miles", "kilometers", "feet", "meters"],
    "Volume": ["gallons", "liters", "cubic feet", "cubic meters"],
    "Temperature": ["°F", "°C"],
    "Pressure": ["psi", "bar", "kPa", "inH2O"],
    "Velocity": ["mph", "km/h", "ft/min", "m/s", "rpm"],
    "Acceleration": ["g", "in/s", "mm/s"],
    "Electrical": ["volts", "amps", "kW", "kWh", "ohms", "Hz"],
    "Other": ["cycles", "units", "%", "count"],
}


class MonitoringPoint(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """One physical sensor spot on an asset that several meters read from (r123)."""

    __tablename__ = "monitoring_points"

    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")


class Meter(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "meters"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    meter_type: Mapped[str] = mapped_column(String(12), default="manual")
    unit: Mapped[str] = mapped_column(String(40), default="hours")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    monitoring_point_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("monitoring_points.id"), nullable=True, index=True
    )
    reading_frequency: Mapped[str] = mapped_column(String(8), default="none")
    frequency_interval: Mapped[int] = mapped_column(Integer, default=1)
    warning_low: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    warning_high: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    alarm_low: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    alarm_high: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    last_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    last_reading_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class MeterReading(OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "meter_readings"
    __table_args__ = (Index("ix_meter_readings_meter_at", "meter_id", "recorded_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    recorded_at: Mapped[datetime] = mapped_column(UTCDateTime, primary_key=True, default=utcnow)
    meter_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=False)  # no FK: partitioned tables keep it simple
    value: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    source: Mapped[str] = mapped_column(String(12), default="manual")  # manual | api | work_order
    recorded_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    note: Mapped[str] = mapped_column(String(500), default="")
    level: Mapped[str] = mapped_column(String(8), default="")  # "" | warning | alarm
    anomaly: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class MeterTrigger(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Create a work order from readings: when a value crosses a threshold, or every N units (MP-031)."""

    __tablename__ = "meter_triggers"

    meter_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("meters.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(12))  # threshold | every
    comparator: Mapped[str] = mapped_column(String(4), default="gt")  # gt | lt (threshold)
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    every_units: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    next_at: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)  # every-N: next milestone
    work_order: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # title, description, priority, …
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    fired_count: Mapped[int] = mapped_column(Integer, default=0)
    last_fired_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_note: Mapped[str] = mapped_column(Text, default="")
