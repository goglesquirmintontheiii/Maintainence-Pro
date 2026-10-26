"""Sysadmins and MPro Management: demo data."""

from __future__ import annotations

from typing import Any


def seed(org: Any, admin: Any) -> None:
    """Called once per demo org from mpro/demo.py (must be idempotent).

    A server with no sysadmin makes the demo admin its first one, so test builds can open MPro Management.
    """
    from mpro.extensions import db
    from mpro.sysadmin.services import make_first_sysadmin

    if make_first_sysadmin(admin, "demo data"):
        db.session.commit()
