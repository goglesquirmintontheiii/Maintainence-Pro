from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, UniqueConstraint, Uuid
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

    org: Mapped[Organization] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships", lazy="joined")


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
