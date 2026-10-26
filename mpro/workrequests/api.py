"""Work requests and request portals: HTTP API (thin views over services)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("workrequests", __name__, url_prefix="/api/v1", tag="Workrequests")
