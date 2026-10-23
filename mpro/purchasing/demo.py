"""Demo data for the 0.5.0 purchasing module (filled in by the module build)."""

from __future__ import annotations

from typing import Any


def seed_purchasing(org: Any, admin: Any) -> None:
    """Seed demo records. Runs after work orders, assets, procedures, PM and automations, in the order
    vendors → parts → purchasing → suppliers → finance."""
