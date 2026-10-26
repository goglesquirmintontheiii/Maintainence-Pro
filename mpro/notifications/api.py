"""Notifications: in-app, email, web push, digests and escalation rules: HTTP API (thin views over services)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("notifications", __name__, url_prefix="/api/v1", tag="Notifications")
