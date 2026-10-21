"""Entitlements: plan -> features and limits (guideline G-07).

Never compare plan names in code; ask `entitlements_for(org).can_use(...)` / `.limit(...)`.
Self-hosted installs get every feature with no limits. MPro Cloud plans arrive in 1.1.0;
the table below is the starting point from the roadmap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from flask import current_app

UNLIMITED = None

PLANS: dict[str, dict[str, Any]] = {
    "free": {
        "features": {"work_orders", "assets", "locations", "pm", "procedures", "requests", "exports", "offline"},
        "limits": {
            "full_users": 3,
            "sites": 1,
            "storage_gb": 2,
            "file_mb": 25,
            "assets": 250,
            "pm_schedules": 20,
            "api_per_min": 30,
            "api_per_day": 2000,
            "report_history_months": 6,
        },
    },
    "pro": {
        "features": {
            "work_orders",
            "assets",
            "locations",
            "pm",
            "procedures",
            "requests",
            "exports",
            "offline",
            "parts",
            "purchase_orders",
            "webhooks",
            "api",
            "supplier_cards",
            "ai_byok",
        },
        "limits": {
            "full_users": UNLIMITED,
            "sites": 3,
            "storage_gb_per_user": 10,
            "api_per_min": 300,
            "report_history_months": 36,
        },
    },
    "expert": {
        "features": {"*"},
        "limits": {"api_per_min": 1200, "storage_gb_per_user": 50},
    },
}


@dataclass
class Entitlements:
    plan: str
    features: set[str] = field(default_factory=set)
    limits: dict[str, int | None] = field(default_factory=dict)

    def can_use(self, feature: str) -> bool:
        return "*" in self.features or feature in self.features

    def limit(self, name: str) -> int | None:
        """None means unlimited."""
        return self.limits.get(name, UNLIMITED)

    def to_dict(self) -> dict[str, Any]:
        return {"plan": self.plan, "features": sorted(self.features), "limits": self.limits}


def entitlements_for(org: Any) -> Entitlements:
    if current_app.config.get("MPRO_EDITION") != "cloud":
        return Entitlements(plan="selfhosted", features={"*"}, limits={})
    plan = getattr(org, "plan", "free") if org is not None else "free"
    p = PLANS.get(plan, PLANS["free"])
    return Entitlements(plan=plan, features=set(p["features"]), limits=dict(p["limits"]))
