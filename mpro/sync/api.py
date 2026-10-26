"""Offline sync for the phone app: change feed and mutation queue: HTTP API (thin views over services)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("sync", __name__, url_prefix="/api/v1", tag="Sync")
