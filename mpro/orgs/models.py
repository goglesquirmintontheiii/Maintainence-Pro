from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin
from mpro.extensions import db

if TYPE_CHECKING:
    from mpro.auth.models import User


class Organization(IdMixin, TimestampMixin, SoftDeleteMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    locale: Mapped[str] = mapped_column(String(16), default="en-US")
    units: Mapped[str] = mapped_column(String(16), default="imperial")  # imperial | metric
    plan: Mapped[str] = mapped_column(String(32), default="selfhosted")  # selfhosted | free | pro | expert
    home_region: Mapped[str] = mapped_column(String(32), default="local")

    memberships: Mapped[list[Membership]] = relationship(back_populates="org", lazy="selectin")


class Membership(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A user's seat in an organization, with their role (MaintainX role names)."""

    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_memberships_org_user"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(32), default="technician")
    job_title: Mapped[str] = mapped_column(String(120), default="")
    hourly_rate_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = org default rate
    # "all" or "limited": limited users see only work orders they created or that are assigned to them or
    # their teams (MaintainX "Limited work order visibility").
    wo_visibility: Mapped[str] = mapped_column(String(16), default="all")
    # role == "custom": the organization's own role (Settings → Roles, MP-106)
    role_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("roles.id"), nullable=True, index=True)

    org: Mapped[Organization] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships", lazy="joined")
    custom_role: Mapped[Role | None] = relationship(lazy="joined")


class Role(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """An organization's own role: a name and an explicit list of permitted actions (mpro.core.permissions)."""

    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text, default="")
    base: Mapped[str] = mapped_column(String(32), default="technician")  # built-in role it started from
    permissions: Mapped[list[str]] = mapped_column(JSON, default=list)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # e.g. {"wo_visibility": "limited"}


class Team(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "teams"

    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(2000), default="")
    color: Mapped[str] = mapped_column(String(16), default="#1b5bd4")

    members: Mapped[list[TeamMember]] = relationship(
        back_populates="team", lazy="selectin", cascade="all, delete-orphan"
    )


class TeamMember(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id", name="uq_team_members_team_user"),)

    team_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("teams.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)

    team: Mapped[Team] = relationship(back_populates="members")
    user: Mapped[User] = relationship(lazy="joined")
