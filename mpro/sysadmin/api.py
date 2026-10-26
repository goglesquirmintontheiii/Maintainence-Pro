"""MPro Management for server sysadmins: HTTP API (thin views over services)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("sysadmin", __name__, url_prefix="/api/v1", tag="Sysadmin")
