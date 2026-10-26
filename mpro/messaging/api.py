"""Messaging and the realtime service: HTTP API (thin views over services)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("messaging", __name__, url_prefix="/api/v1", tag="Messaging")
