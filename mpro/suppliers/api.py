"""Supplier product links (0.5.0) REST API (/api/v1)."""

from __future__ import annotations

from apiflask import APIBlueprint

bp = APIBlueprint("suppliers", __name__, url_prefix="/api/v1", tag="Suppliers")
