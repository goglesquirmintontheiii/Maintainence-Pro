"""Central permission engine (guideline G-15): every endpoint calls `can()`.

Roles mirror MaintainX's built-in roles. Permissions are data (role -> allowed actions), so
custom roles in 0.9.0 become an admin screen rather than a refactor.
"""

from __future__ import annotations

from typing import Any

ROLES: dict[str, dict[str, Any]] = {
    "admin": {
        "label": "Administrator",
        "rank": 50,
        "description": "Full access, including organization settings, users, billing and the audit log.",
    },
    "limited_admin": {
        "label": "Limited Administrator",
        "rank": 40,
        "description": "Manages work and people, but not organization settings or billing.",
    },
    "technician": {
        "label": "Technician",
        "rank": 30,
        "description": "Full user: works on and creates work orders, assets and procedures.",
    },
    "requester": {
        "label": "Requester",
        "rank": 20,
        "description": "Submits requests and follows their progress. Free seat.",
    },
    "viewer": {
        "label": "View-only",
        "rank": 10,
        "description": "Can look at everything they're given access to; changes nothing.",
    },
}

# action -> minimum set of roles. "*" in a role list means every role.
ACTIONS: dict[str, set[str]] = {
    "org.view": {"admin", "limited_admin", "technician", "requester", "viewer"},
    "org.manage": {"admin"},
    "users.view": {"admin", "limited_admin", "technician", "viewer"},
    "users.manage": {"admin", "limited_admin"},
    "users.manage_admins": {"admin"},
    "teams.view": {"admin", "limited_admin", "technician", "requester", "viewer"},
    "teams.manage": {"admin", "limited_admin"},
    "audit.view": {"admin"},
    "jobs.view": {"admin"},
    "jobs.manage": {"admin"},
    "mail.view": {"admin"},
    "search.use": {"admin", "limited_admin", "technician", "requester", "viewer"},
}


def role_can(role: str | None, action: str) -> bool:
    return bool(role) and role in ACTIONS.get(action, set())


def can(membership: Any, action: str, record: Any = None) -> bool:
    """True if the member may perform `action` (optionally on `record`).

    Record-level checks: a record must belong to the member's organization.
    Location-scoped access arrives with locations in 0.3.0.
    """
    if membership is None or getattr(membership, "deleted_at", None) is not None:
        return False
    if record is not None and getattr(record, "org_id", membership.org_id) != membership.org_id:
        return False
    return role_can(membership.role, action)


def permissions_for(role: str) -> list[str]:
    return sorted(a for a, roles in ACTIONS.items() if role in roles)


def can_assign_role(actor_role: str, target_role: str) -> bool:
    """Limited admins can't create or edit administrators."""
    if target_role not in ROLES:
        return False
    if target_role in {"admin", "limited_admin"}:
        return actor_role == "admin"
    return role_can(actor_role, "users.manage")
