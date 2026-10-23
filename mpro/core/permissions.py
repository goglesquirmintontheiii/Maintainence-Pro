"""Central permission engine (guideline G-15): every endpoint calls `can()`.

Built-in roles mirror MaintainX's roles, plus an Owner (0.4.0). Permissions are data (role -> allowed actions),
so organizations can build their own roles (Settings → Roles, MP-106): a custom role is a row in `roles` with an
explicit list of actions, and a membership points at it with `role="custom"` and `role_id`.
"""

from __future__ import annotations

from typing import Any

ROLES: dict[str, dict[str, Any]] = {
    "owner": {
        "label": "Owner",
        "rank": 60,
        "description": "Full access, including organization settings, billing and roles. Every organization has one.",
    },
    "admin": {
        "label": "Administrator",
        "rank": 50,
        "description": "Manages everything except organization settings, billing and roles.",
    },
    "limited_admin": {
        "label": "Limited Administrator",
        "rank": 40,
        "description": "Manages work and people, but not settings.",
    },
    "technician": {
        "label": "Technician",
        "rank": 30,
        "description": "Full user: works on and creates work orders, assets and procedures.",
    },
    "operator": {
        "label": "Operator",
        "rank": 25,
        "description": "Front-line user: sees only work assigned to them, fills in procedures, changes status "
        "and logs time.",
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

ALL = {"owner", "admin", "limited_admin", "technician", "operator", "requester", "viewer"}
_STAFF = {"owner", "admin", "limited_admin"}
_FULL = _STAFF | {"technician"}

# action -> built-in roles that have it.
ACTIONS: dict[str, set[str]] = {
    "org.view": ALL,
    "org.manage": {"owner"},
    "billing.manage": {"owner"},
    "roles.manage": {"owner"},
    "users.view": _FULL | {"operator", "viewer"},
    "users.manage": _STAFF,
    "users.manage_admins": {"owner", "admin"},
    "profile.job_title": _STAFF,
    "teams.view": ALL,
    "teams.manage": _STAFF,
    "audit.view": {"owner", "admin"},
    "jobs.view": {"owner", "admin"},
    "jobs.manage": {"owner", "admin"},
    "mail.view": {"owner", "admin"},
    "search.use": ALL,
    # work orders (0.2.0). Operators only ever see work assigned to them (forced limited visibility).
    "wo.view": _FULL | {"operator", "viewer"},
    "wo.create": _FULL,
    "wo.edit": _FULL,
    "wo.status": _FULL | {"operator"},
    "wo.time": _FULL | {"operator"},
    "wo.comment": _FULL | {"operator"},
    "wo.delete": _STAFF,
    "wo.approve": _STAFF,
    "wo.settings": {"owner", "admin"},
    "wo.rates.view": _STAFF,
    "categories.manage": _STAFF,
    "templates.manage": _STAFF,
    "views.share": {"owner", "admin"},
    "exports.use": _FULL | {"viewer"},
    # locations, assets, meters, QR codes (0.3.0)
    "locations.view": _FULL | {"operator", "viewer"},
    "locations.manage": _FULL,
    "locations.delete": _STAFF,
    "assets.view": _FULL | {"operator", "viewer"},
    "assets.manage": _FULL,
    "assets.status": _FULL | {"operator"},
    "assets.delete": _STAFF,
    "assets.financials": _STAFF,
    "assets.settings": {"owner", "admin"},
    "meters.view": _FULL | {"operator", "viewer"},
    "meters.read": _FULL | {"operator"},
    "meters.manage": _FULL,
    "meters.delete": _STAFF,
    "qr.manage": _FULL,
    # preventive maintenance, procedures, automations (0.4.0)
    "pm.view": _FULL | {"viewer"},
    "pm.manage": _STAFF | {"technician"},
    "pm.delete": _STAFF,
    "pm.skip": _STAFF,
    "procedures.view": _FULL | {"operator", "viewer"},
    "procedures.manage": _STAFF | {"technician"},
    "procedures.delete": _STAFF,
    "procedures.fill": _FULL | {"operator"},
    "automations.view": _FULL | {"viewer"},
    "automations.manage": _STAFF,
    # parts & inventory (0.5.0)
    "parts.view": _FULL | {"operator", "viewer"},
    "parts.manage": _FULL,
    "parts.delete": _STAFF,
    "parts.use": _FULL | {"operator"},
    "parts.stock": _FULL,
    "parts.counts": _STAFF,
    "parts.settings": {"owner", "admin"},
    "costs.view": _STAFF,
    # purchase orders (0.5.0)
    "po.view": _FULL | {"viewer"},
    "po.request": _FULL,
    "po.manage": _STAFF,
    "po.approve": {"owner", "admin"},
    "po.receive": _FULL,
    "po.delete": _STAFF,
    "po.settings": {"owner", "admin"},
    # vendors and customers (0.5.0)
    "vendors.view": _FULL | {"viewer"},
    "vendors.manage": _STAFF,
    "vendors.delete": _STAFF,
    "customers.view": _FULL | {"viewer"},
    "customers.manage": _STAFF,
    "quotes.manage": _STAFF,
    # supplier product links (0.5.0)
    "suppliers.links": _FULL,
    "suppliers.connections": {"owner", "admin"},
    # purchasing finance (0.5.0)
    "finance.view": _STAFF,
    "finance.receipts": _FULL | {"operator"},
    "finance.invoices": _STAFF,
    "finance.invoices.approve": {"owner", "admin"},
    "finance.customer_invoices": _STAFF,
    "finance.tax_certificates": {"owner", "admin"},
    "finance.export": {"owner", "admin"},
    # work orders shared outside the organization, asset packages (0.5.0)
    "wo.share_external": _STAFF,
    "assets.packages": {"owner", "admin"},
}

# Plain-language names and groups for the role editor (Settings → Roles).
AREAS: list[tuple[str, str]] = [
    ("org", "Organization"),
    ("people", "People"),
    ("wo", "Work orders"),
    ("assets", "Assets and locations"),
    ("meters", "Meters"),
    ("pm", "Preventive maintenance"),
    ("procedures", "Procedures"),
    ("automations", "Automations"),
    ("parts", "Parts and inventory"),
    ("purchasing", "Purchase orders"),
    ("vendors", "Vendors and customers"),
    ("finance", "Finance"),
    ("data", "Data and system"),
]
ACTION_INFO: dict[str, tuple[str, str]] = {
    "org.view": ("org", "Use the organization"),
    "org.manage": ("org", "Change organization settings"),
    "billing.manage": ("org", "Manage plan and billing"),
    "roles.manage": ("org", "Create and edit roles"),
    "users.view": ("people", "See people"),
    "users.manage": ("people", "Invite and manage people"),
    "users.manage_admins": ("people", "Manage administrators"),
    "profile.job_title": ("people", "Edit their own job title"),
    "teams.view": ("people", "See teams"),
    "teams.manage": ("people", "Create and edit teams"),
    "audit.view": ("data", "See the audit log"),
    "jobs.view": ("data", "See background jobs"),
    "jobs.manage": ("data", "Retry and cancel background jobs"),
    "mail.view": ("data", "See the email outbox"),
    "search.use": ("org", "Search"),
    "wo.view": ("wo", "See work orders"),
    "wo.create": ("wo", "Create work orders"),
    "wo.edit": ("wo", "Edit work orders"),
    "wo.status": ("wo", "Change work order status"),
    "wo.time": ("wo", "Log time and costs"),
    "wo.comment": ("wo", "Comment on work orders"),
    "wo.delete": ("wo", "Delete work orders"),
    "wo.approve": ("wo", "Approve completed work"),
    "wo.settings": ("wo", "Change work order settings"),
    "wo.rates.view": ("wo", "See labor rates and costs"),
    "categories.manage": ("wo", "Manage categories"),
    "templates.manage": ("wo", "Manage work order templates"),
    "views.share": ("wo", "Share saved views with everyone"),
    "exports.use": ("data", "Export data"),
    "locations.view": ("assets", "See locations"),
    "locations.manage": ("assets", "Create and edit locations"),
    "locations.delete": ("assets", "Delete locations"),
    "assets.view": ("assets", "See assets"),
    "assets.manage": ("assets", "Create and edit assets"),
    "assets.status": ("assets", "Change asset status"),
    "assets.delete": ("assets", "Delete assets"),
    "assets.financials": ("assets", "See and edit asset costs and values"),
    "assets.settings": ("assets", "Change asset settings"),
    "meters.view": ("meters", "See meters"),
    "meters.read": ("meters", "Record meter readings"),
    "meters.manage": ("meters", "Create and edit meters"),
    "meters.delete": ("meters", "Delete meters"),
    "qr.manage": ("assets", "Create, assign and print QR codes"),
    "pm.view": ("pm", "See maintenance plans and repeating work"),
    "pm.manage": ("pm", "Create and edit maintenance plans"),
    "pm.delete": ("pm", "Delete maintenance plans"),
    "pm.skip": ("pm", "Skip or postpone scheduled maintenance"),
    "procedures.view": ("procedures", "See procedures"),
    "procedures.manage": ("procedures", "Create and edit procedures"),
    "procedures.delete": ("procedures", "Delete procedures"),
    "procedures.fill": ("procedures", "Fill in procedures on work orders"),
    "automations.view": ("automations", "See automations"),
    "automations.manage": ("automations", "Create and edit automations"),
    "parts.view": ("parts", "See parts and stock"),
    "parts.manage": ("parts", "Create and edit parts"),
    "parts.delete": ("parts", "Delete parts"),
    "parts.use": ("parts", "Use parts on work orders"),
    "parts.stock": ("parts", "Restock, adjust and move stock"),
    "parts.counts": ("parts", "Schedule and approve cycle counts"),
    "parts.settings": ("parts", "Change parts and inventory settings"),
    "costs.view": ("parts", "See part costs and inventory value"),
    "po.view": ("purchasing", "See purchase orders"),
    "po.request": ("purchasing", "Request purchase orders"),
    "po.manage": ("purchasing", "Create, edit and send purchase orders"),
    "po.approve": ("purchasing", "Approve or reject purchase orders"),
    "po.receive": ("purchasing", "Receive items on purchase orders"),
    "po.delete": ("purchasing", "Cancel and delete purchase orders"),
    "po.settings": ("purchasing", "Change purchasing settings, approval rules and budgets"),
    "vendors.view": ("vendors", "See vendors"),
    "vendors.manage": ("vendors", "Create and edit vendors"),
    "vendors.delete": ("vendors", "Delete vendors"),
    "customers.view": ("vendors", "See customers"),
    "customers.manage": ("vendors", "Create and edit customers"),
    "quotes.manage": ("vendors", "Create and send quotes"),
    "suppliers.links": ("parts", "Link parts and assets to supplier products"),
    "suppliers.connections": ("parts", "Connect supplier accounts and catalogs"),
    "finance.view": ("finance", "See finance documents"),
    "finance.receipts": ("finance", "Submit receipts"),
    "finance.invoices": ("finance", "Record and match vendor invoices"),
    "finance.invoices.approve": ("finance", "Approve vendor invoices"),
    "finance.customer_invoices": ("finance", "Create and send customer invoices"),
    "finance.tax_certificates": ("finance", "Manage tax exemption certificates"),
    "finance.export": ("finance", "Export for the accountant"),
    "wo.share_external": ("wo", "Share work orders outside the organization"),
    "assets.packages": ("assets", "Install asset packages"),
}

# Roles whose people only see work orders assigned to them, whatever their own setting says.
FORCED_LIMITED_VISIBILITY = {"operator"}


def role_can(role: str | None, action: str) -> bool:
    return bool(role) and role in ACTIONS.get(action, set())


def role_permissions(membership: Any) -> set[str]:
    """Every action this membership may perform (built-in role, or a custom role's list)."""
    if membership is None:
        return set()
    if getattr(membership, "role", None) == "custom":
        role = getattr(membership, "custom_role", None)
        if role is None or getattr(role, "deleted_at", None) is not None:
            return {"org.view"}
        return set(role.permissions or []) & set(ACTIONS) | {"org.view"}
    return {a for a, roles in ACTIONS.items() if membership.role in roles}


def can(membership: Any, action: str, record: Any = None) -> bool:
    """True if the member may perform `action` (optionally on `record`).

    Record-level checks: a record must belong to the member's organization.
    """
    if membership is None or getattr(membership, "deleted_at", None) is not None:
        return False
    if record is not None and getattr(record, "org_id", membership.org_id) != membership.org_id:
        return False
    if getattr(membership, "role", None) == "custom":
        return action in role_permissions(membership)
    return role_can(membership.role, action)


def permissions_for(role_or_membership: Any) -> list[str]:
    if isinstance(role_or_membership, str):
        return sorted(a for a, roles in ACTIONS.items() if role_or_membership in roles)
    return sorted(role_permissions(role_or_membership))


def role_rank(membership_or_role: Any) -> int:
    if isinstance(membership_or_role, str):
        return int(ROLES.get(membership_or_role, {}).get("rank", 0))
    if getattr(membership_or_role, "role", None) == "custom":
        base = getattr(getattr(membership_or_role, "custom_role", None), "base", "technician") or "technician"
        return min(int(ROLES.get(base, {}).get("rank", 30)), 45)
    return int(ROLES.get(getattr(membership_or_role, "role", ""), {}).get("rank", 0))


def can_assign_role(actor_role: str, target_role: str) -> bool:
    """Only Owners make Owners; Limited Administrators can't create or edit administrators."""
    if target_role not in ROLES and target_role != "custom":
        return False
    if target_role == "owner":
        return actor_role == "owner"
    if target_role in {"admin", "limited_admin"}:
        return actor_role in {"owner", "admin"}
    return role_can(actor_role, "users.manage")
