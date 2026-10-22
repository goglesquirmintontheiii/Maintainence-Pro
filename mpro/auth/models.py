from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import Boolean, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mpro.core.models import IdMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime
from mpro.extensions import db

if TYPE_CHECKING:
    from mpro.orgs.models import Membership

_ph = PasswordHasher()


class User(IdMixin, TimestampMixin, SoftDeleteMixin, db.Model):  # type: ignore[name-defined]
    """A person. Users are global; access to an organization comes from a Membership."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    theme: Mapped[str] = mapped_column(String(16), default="light")  # system | light | dark
    # profile photo (MP-116): a small square WebP, cropped in the browser; None = initials
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    memberships: Mapped[list[Membership]] = relationship(back_populates="user", lazy="selectin")

    # Flask-Login protocol
    @property
    def is_active(self) -> bool:
        return bool(self.active) and self.deleted_at is None

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def is_anonymous(self) -> bool:
        return False

    def get_id(self) -> str:
        return str(self.id)

    def set_password(self, password: str) -> None:
        self.password_hash = _ph.hash(password)

    def check_password(self, password: str) -> bool:
        if not self.password_hash:
            return False
        try:
            ok = _ph.verify(self.password_hash, password)
        except (VerificationError, InvalidHashError):
            return False
        if ok and _ph.check_needs_rehash(self.password_hash):
            self.password_hash = _ph.hash(password)
        return ok

    @property
    def initials(self) -> str:
        parts = [p for p in self.name.split() if p]
        return ("".join(p[0] for p in parts[:2]) or self.email[:2]).upper()


class LoginAttempt(IdMixin, db.Model):  # type: ignore[name-defined]
    """Used to rate-limit sign-in without Redis (works across processes)."""

    __tablename__ = "login_attempts"

    email: Mapped[str] = mapped_column(String(320), index=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
