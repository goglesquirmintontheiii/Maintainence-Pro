"""Automations REST API (/api/v1). Built in 0.4.0."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("automations", __name__, url_prefix="/api/v1", tag="Automations")
