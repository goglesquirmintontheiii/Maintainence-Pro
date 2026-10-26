"""Sysadmins and MPro Management: demo data."""

from __future__ import annotations

from typing import Any


def seed(org: Any, admin: Any) -> None:
    """Called once per demo org from mpro/demo.py (must be idempotent).

    In a test build (.exe / .AppImage, MPRO_TEST_BUILD) a server with no sysadmin makes the demo admin its first
    one, so MPro Management can be tried. Never on a real server: the demo password is public.
    """
    from flask import current_app

    from mpro.extensions import db
    from mpro.sysadmin.services import make_first_sysadmin

    if not current_app.config.get("MPRO_TEST_BUILD"):
        return
    if make_first_sysadmin(admin, "demo data"):
        db.session.commit()
