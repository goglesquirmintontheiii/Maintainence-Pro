"""Locations and assets (0.3.0). Trees are kept in `tree_paths` (see mpro.core.hierarchy)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, BigInteger, Date, Float, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime, utcnow
from mpro.extensions import db

if TYPE_CHECKING:
    from mpro.auth.models import User
    from mpro.orgs.models import Team

ASSET_STATUSES = ("online", "offline", "do_not_track")
ASSET_STATUS_LABELS = {"online": "Online", "offline": "Offline", "do_not_track": "Do Not Track"}
CRITICALITY = ("", "critical", "important", "normal")
CRITICALITY_LABELS = {"": "None", "critical": "Critical", "important": "Important", "normal": "Normal"}
DOWNTIME_TYPES = ("", "planned", "unplanned")
DISPOSAL_METHODS = ("", "sold", "scrapped", "recycled", "donated", "other")


class Location(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "locations"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    address_line1: Mapped[str] = mapped_column(String(200), default="")
    address_line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(120), default="")
    region: Mapped[str] = mapped_column(String(120), default="")
    postal_code: Mapped[str] = mapped_column(String(30), default="")
    country: Mapped[str] = mapped_column(String(80), default="")
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)


class TeamInCharge(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Teams in charge of a location or asset."""

    __tablename__ = "teams_in_charge"
    __table_args__ = (UniqueConstraint("entity_type", "entity_id", "team_id", name="uq_teams_in_charge_entity_team"),)

    entity_type: Mapped[str] = mapped_column(String(20))
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    team_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("teams.id"), index=True)

    team: Mapped[Team] = relationship(lazy="joined")


class FloorPlan(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "floor_plans"

    location_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("locations.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    file_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("files.id"))
    sort: Mapped[int] = mapped_column(Integer, default=0)
    # editor layer (MP-110): shapes, lines, text and location bindings, stored apart from the image
    annotations: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    annotations_version: Mapped[int] = mapped_column(Integer, default=0)


class FloorPlanPin(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A pin on a floor plan, at x/y as fractions (0–1) of the image size."""

    __tablename__ = "floor_plan_pins"

    floor_plan_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("floor_plans.id"), index=True)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True)
    label: Mapped[str] = mapped_column(String(120), default="")
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)


class AssetType(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "asset_types"

    name: Mapped[str] = mapped_column(String(80))
    color: Mapped[str] = mapped_column(String(16), default="#5d6880")


class Asset(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "assets"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=True, index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("locations.id"), nullable=True, index=True)
    criticality: Mapped[str] = mapped_column(String(12), default="")
    manufacturer: Mapped[str] = mapped_column(String(120), default="")
    model: Mapped[str] = mapped_column(String(120), default="")
    serial_number: Mapped[str] = mapped_column(String(120), default="", index=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    barcode: Mapped[str] = mapped_column(String(200), default="", index=True)  # an existing barcode value
    custom: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    status: Mapped[str] = mapped_column(String(16), default="online", index=True)
    status_reason: Mapped[str] = mapped_column(String(80), default="")
    downtime_type: Mapped[str] = mapped_column(String(12), default="")
    status_changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    status_changed_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)

    # lifecycle (r593)
    commissioned_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    expected_life_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    replacement_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    replacement_cost_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    disposed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    disposal_method: Mapped[str] = mapped_column(String(16), default="")
    disposal_value_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    disposal_notes: Mapped[str] = mapped_column(Text, default="")
    # warranty (r152)
    warranty_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    warranty_end: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    warranty_provider: Mapped[str] = mapped_column(String(200), default="")
    warranty_terms: Mapped[str] = mapped_column(Text, default="")
    # straight-line depreciation (r113)
    purchase_price_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    useful_life_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    salvage_value_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    depreciation_start: Mapped[date | None] = mapped_column(Date, nullable=True)

    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    location: Mapped[Location | None] = relationship(lazy="joined")
    status_changed_by: Mapped[User | None] = relationship(foreign_keys=[status_changed_by_id], lazy="joined")
    type_links: Mapped[list[AssetTypeLink]] = relationship(
        back_populates="asset", lazy="selectin", cascade="all, delete-orphan"
    )


class AssetTypeLink(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "asset_type_links"
    __table_args__ = (UniqueConstraint("asset_id", "type_id", name="uq_asset_type_links_asset_type"),)

    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), index=True)
    type_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("asset_types.id"), index=True)

    asset: Mapped[Asset] = relationship(back_populates="type_links")
    type: Mapped[AssetType] = relationship(lazy="joined")


class AssetStatusChange(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Every status change; downtime and availability are computed from consecutive rows."""

    __tablename__ = "asset_status_changes"

    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), index=True)
    from_status: Mapped[str] = mapped_column(String(16), default="")
    to_status: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(String(80), default="")
    downtime_type: Mapped[str] = mapped_column(String(12), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class CatalogEntry(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Organization's own manufacturers and models (added to MPro's default manufacturer list)."""

    __tablename__ = "catalog_entries"
    __table_args__ = (
        UniqueConstraint("org_id", "kind", "parent", "name", name="uq_catalog_entries_org_kind_parent_name"),
    )

    kind: Mapped[str] = mapped_column(String(16))  # manufacturer | model
    parent: Mapped[str] = mapped_column(String(120), default="")  # manufacturer of a model
    name: Mapped[str] = mapped_column(String(120))
