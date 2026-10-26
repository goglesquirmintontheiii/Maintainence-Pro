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
            "storage_mb_per_user": 500,  # pooled across the organization (r651)
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
            "request_portals",
        },
        "limits": {
            "full_users": UNLIMITED,
            "sites": 3,
            "storage_mb_per_user": 4 * 1024,
            "api_per_min": 300,
            "report_history_months": 36,
        },
    },
    "expert": {
        "features": {"*"},
        "limits": {"api_per_min": 1200, "storage_mb_per_user": 8 * 1024},
    },
}
# Billing packs (r541/r649) share their tier's features; storage is per user but capped for the whole org (r651).
PLANS["pro_50"] = {**PLANS["pro"], "limits": {**PLANS["pro"]["limits"], "full_users": 50}}
PLANS["pro_unlimited"] = {**PLANS["pro"], "limits": {**PLANS["pro"]["limits"], "storage_cap_gb": 200}}
PLANS["expert_50"] = {**PLANS["expert"], "limits": {**PLANS["expert"]["limits"], "full_users": 50}}
PLANS["expert_unlimited"] = {**PLANS["expert"], "limits": {**PLANS["expert"]["limits"], "storage_cap_gb": 300}}
PLANS["expert_lifetime"] = {**PLANS["expert"], "limits": {**PLANS["expert"]["limits"], "storage_cap_gb": 200}}


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

    def storage_quota_bytes(self, users: int) -> int | None:
        """The organization's pooled storage: per-user allowance x users, up to the plan's cap. None = unlimited."""
        per_user = self.limits.get("storage_mb_per_user")
        if per_user is None:
            return None
        quota = per_user * 1024 * 1024 * max(1, users)
        cap = self.limits.get("storage_cap_gb")
        return min(quota, cap * 1024**3) if cap is not None else quota

    def to_dict(self) -> dict[str, Any]:
        return {"plan": self.plan, "features": sorted(self.features), "limits": self.limits}


def entitlements_for(org: Any) -> Entitlements:
    if current_app.config.get("MPRO_EDITION") != "cloud":
        return Entitlements(plan="selfhosted", features={"*"}, limits={})
    plan = getattr(org, "plan", "free") if org is not None else "free"
    p = PLANS.get(plan, PLANS["free"])
    return Entitlements(plan=plan, features=set(p["features"]), limits=dict(p["limits"]))
