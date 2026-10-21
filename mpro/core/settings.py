"""Per-organization settings stored as JSON documents (one row per org and key).

Modules register defaults with `register_defaults(key, {...})`; `get_settings(org_id, key)` returns the
defaults merged with what the organization saved, so new settings appear without a migration.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any

from sqlalchemy import JSON, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin, TimestampMixin
from mpro.extensions import db

_defaults: dict[str, dict[str, Any]] = {}


class OrgSetting(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "org_settings"
    __table_args__ = (UniqueConstraint("org_id", "key", name="uq_org_settings_org_key"),)

    key: Mapped[str] = mapped_column(String(64))
    value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


def register_defaults(key: str, defaults: dict[str, Any]) -> None:
    _defaults[key] = defaults


def get_settings(org_id: uuid.UUID, key: str) -> dict[str, Any]:
    out = copy.deepcopy(_defaults.get(key, {}))
    row = db.session.scalars(select(OrgSetting).where(OrgSetting.org_id == org_id, OrgSetting.key == key)).first()
    if row is not None:
        out.update({k: v for k, v in (row.value or {}).items() if k in out})
    return out


def save_settings(org_id: uuid.UUID, key: str, values: dict[str, Any]) -> dict[str, Any]:
    """Merge `values` into the stored settings (caller validates and commits)."""
    row = db.session.scalars(select(OrgSetting).where(OrgSetting.org_id == org_id, OrgSetting.key == key)).first()
    if row is None:
        row = OrgSetting(org_id=org_id, key=key, value={})
        db.session.add(row)
    merged = dict(row.value or {})
    merged.update(values)
    row.value = merged  # reassign so SQLAlchemy sees the JSON change
    return get_settings_from(merged, key)


def get_settings_from(stored: dict[str, Any], key: str) -> dict[str, Any]:
    out = copy.deepcopy(_defaults.get(key, {}))
    out.update({k: v for k, v in stored.items() if k in out})
    return out
