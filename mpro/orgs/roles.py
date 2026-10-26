"""Roles: built-in roles, the organization's own roles, and who may hand out which (MP-106)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select

from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.core.permissions import (
    ACTION_INFO,
    ACTIONS,
    ANY_OF_OWN,
    AREAS,
    FORCED_LIMITED_VISIBILITY,
    OWN_ACTIONS,
    ROLES,
    role_permissions,
)
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Role
from mpro.orgs.services import RuleError

# A custom role starts from one of these (Owner stays unique: it's never a base).
BASES = ("admin", "limited_admin", "technician", "operator", "requester", "viewer")
# Never grantable through a custom role: these stay with Owners.
OWNER_ONLY = {"org.manage", "billing.manage", "roles.manage"}
MAX_ROLES = 50


def builtin_permissions(role: str) -> set[str]:
    return {a for a, roles in ACTIONS.items() if role in roles}


def role_label(m: Membership | None) -> str | None:
    if m is None:
        return None
    if m.role == "custom":
        return m.custom_role.name if m.custom_role is not None else "Custom role"
    return str(ROLES.get(m.role, {}).get("label", m.role))


def forces_limited(m: Membership) -> bool:
    if m.role in FORCED_LIMITED_VISIBILITY:
        return True
    if m.role == "custom" and m.custom_role is not None:
        return (m.custom_role.settings or {}).get("wo_visibility") == "limited"
    return False


def _member_counts(org_id: uuid.UUID) -> tuple[dict[str, int], dict[uuid.UUID, int]]:
    rows = db.session.execute(
        select(Membership.role, Membership.role_id, func.count())
        .where(Membership.org_id == org_id, Membership.deleted_at.is_(None))
        .group_by(Membership.role, Membership.role_id)
    ).all()
    builtin: dict[str, int] = {}
    custom: dict[uuid.UUID, int] = {}
    for role, rid, n in rows:
        if role == "custom" and rid:
            custom[rid] = custom.get(rid, 0) + int(n)
        else:
            builtin[role] = builtin.get(role, 0) + int(n)
    return builtin, custom


def fallback_role(r: Role) -> str:
    """Where a deleted custom role's people go (#12): the least-privileged built-in role that has every permission
    the custom role had (never Owner); View-only when none does."""
    perms = set(r.permissions or []) & set(ACTIONS)
    for key in sorted((k for k in ROLES if k != "owner"), key=lambda k: ROLES[k]["rank"]):
        if perms <= builtin_permissions(key):
            return key
    return "viewer"


def role_dict(r: Role, members: int = 0) -> dict[str, Any]:
    base = builtin_permissions(r.base)
    perms = set(r.permissions or [])
    fb = fallback_role(r)
    return {
        "id": str(r.id),
        "key": f"custom:{r.id}",
        "custom": True,
        "name": r.name,
        "label": r.name,
        "description": r.description,
        "base": r.base,
        "base_label": ROLES.get(r.base, {}).get("label", r.base),
        "fallback": fb,
        "fallback_label": ROLES[fb]["label"],
        "permissions": sorted(perms),
        "added": sorted(perms - base),
        "removed": sorted(base - perms),
        "settings": r.settings or {},
        "members": members,
        "deleted": r.deleted_at is not None,
        "updated_at": iso(r.updated_at),
    }


def list_roles(org: Organization, include_deleted: bool = False) -> list[dict[str, Any]]:
    builtin, custom = _member_counts(org.id)
    out: list[dict[str, Any]] = [
        {
            "id": k,
            "key": k,
            "custom": False,
            "name": v["label"],
            "label": v["label"],
            "description": v["description"],
            "rank": v["rank"],
            "permissions": sorted(builtin_permissions(k)),
            "members": builtin.get(k, 0),
            "deleted": False,
        }
        for k, v in sorted(ROLES.items(), key=lambda kv: -int(kv[1]["rank"]))
    ]
    q = select(Role).where(Role.org_id == org.id)
    if not include_deleted:
        q = q.where(Role.deleted_at.is_(None))
    for r in db.session.scalars(q.order_by(func.lower(Role.name))).all():
        out.append(role_dict(r, custom.get(r.id, 0)))
    return out


def catalogue() -> dict[str, Any]:
    return {
        "areas": [{"id": a, "label": label} for a, label in AREAS],
        "actions": [
            {
                "id": k,
                "area": ACTION_INFO.get(k, ("data", k))[0],
                "label": ACTION_INFO.get(k, ("data", k))[1],
                "owner_only": k in OWNER_ONLY,
                # own vs any (MP-130): the editor shows the pair as one "No / Their own only / Any" choice
                "own": OWN_ACTIONS.get(k),
                "own_of": ANY_OF_OWN.get(k),
            }
            for k in ACTIONS
        ],
        "builtin": {k: sorted(builtin_permissions(k)) for k in ROLES},
        "bases": list(BASES),
    }


def get_role(org_id: uuid.UUID, rid: Any, include_deleted: bool = False) -> Role:
    try:
        uid = rid if isinstance(rid, uuid.UUID) else uuid.UUID(str(rid).removeprefix("custom:"))
    except ValueError as e:
        raise RuleError("That role doesn't exist.", 404) from e
    r = db.session.get(Role, uid)
    if r is None or r.org_id != org_id or (r.deleted_at is not None and not include_deleted):
        raise RuleError("That role doesn't exist.", 404)
    return r


def _clean_permissions(actor: Membership, perms: Any) -> list[str]:
    if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
        raise RuleError("Permissions must be a list.", 422)
    unknown = [p for p in perms if p not in ACTIONS]
    if unknown:
        raise RuleError(f"Unknown permission: {unknown[0]}.", 422)
    clean = set(perms) | {"org.view"}
    if clean & OWNER_ONLY:
        raise RuleError("Organization settings, billing and roles stay with Owners.", 422)
    mine = role_permissions(actor)
    mine |= {OWN_ACTIONS[a] for a in mine if a in OWN_ACTIONS}  # whoever may act on any record may grant "own only"
    beyond = sorted(clean - mine)
    if beyond:  # nobody hands out more than they have themselves
        raise RuleError(
            f"You can't grant a permission you don't have ({ACTION_INFO.get(beyond[0], ('', beyond[0]))[1]}).", 403
        )
    return sorted(clean)


def _clean_settings(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise RuleError("Settings must be an object.", 422)
    out: dict[str, Any] = {}
    if "wo_visibility" in v:
        if v["wo_visibility"] not in ("all", "limited"):
            raise RuleError("Work order visibility is all or limited.", 422)
        out["wo_visibility"] = v["wo_visibility"]
    return out


def _name(org_id: uuid.UUID, name: Any, exclude: uuid.UUID | None = None) -> str:
    name = str(name or "").strip()[:80]
    if not name:
        raise RuleError("The role needs a name.", 422)
    if name.lower() in {str(v["label"]).lower() for v in ROLES.values()} | set(ROLES):
        raise RuleError(f"{name} is a built-in role. Pick another name.", 409)
    q = select(Role.id).where(Role.org_id == org_id, Role.deleted_at.is_(None), func.lower(Role.name) == name.lower())
    if exclude:
        q = q.where(Role.id != exclude)
    if db.session.scalar(q):
        raise RuleError(f"There's already a role called {name}.", 409)
    return name


def create_role(org: Organization, actor: Membership, data: dict[str, Any]) -> Role:
    count = db.session.scalar(
        select(func.count()).select_from(Role).where(Role.org_id == org.id, Role.deleted_at.is_(None))
    )
    if (count or 0) >= MAX_ROLES:
        raise RuleError(f"An organization can have up to {MAX_ROLES} custom roles.", 422)
    base = data.get("base") or "technician"
    if base not in BASES:
        raise RuleError(
            "Start from Administrator, Limited Administrator, Technician, Operator, Requester or View-only.", 422
        )
    perms = data.get("permissions")
    base_perms = sorted(builtin_permissions(base) - OWNER_ONLY)
    r = Role(
        org_id=org.id,
        name=_name(org.id, data.get("name")),
        description=str(data.get("description") or "")[:2000],
        base=base,
        permissions=_clean_permissions(actor, base_perms if perms is None else perms),
        settings=_clean_settings(data.get("settings") or ({"wo_visibility": "limited"} if base == "operator" else {})),
    )
    db.session.add(r)
    db.session.flush()
    emit(
        "role.created",
        entity_type="role",
        entity_id=r.id,
        entity_label=r.name,
        summary=f"Created role {r.name}",
        data={"base": base, "permissions": r.permissions},
    )
    db.session.commit()
    return r


def update_role(org: Organization, actor: Membership, r: Role, data: dict[str, Any]) -> Role:
    before = {
        "name": r.name,
        "description": r.description,
        "permissions": list(r.permissions or []),
        "settings": dict(r.settings or {}),
    }
    if "name" in data:
        r.name = _name(org.id, data["name"], r.id)
    if "description" in data:
        r.description = str(data["description"] or "")[:2000]
    if "permissions" in data:
        new = set(_clean_permissions(actor, data["permissions"]))
        # removing permissions the actor doesn't have is fine; adding them isn't (checked above)
        r.permissions = sorted(new)
    if "settings" in data:
        r.settings = _clean_settings(data["settings"])
    after = {
        "name": r.name,
        "description": r.description,
        "permissions": list(r.permissions or []),
        "settings": dict(r.settings or {}),
    }
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes:
        added = sorted(set(after["permissions"]) - set(before["permissions"]))
        removed = sorted(set(before["permissions"]) - set(after["permissions"]))
        emit(
            "role.updated",
            entity_type="role",
            entity_id=r.id,
            entity_label=r.name,
            summary="Changed role "
            + r.name
            + (f": +{len(added)} / -{len(removed)} permissions" if added or removed else ""),
            changes=changes,
            data={"added": added, "removed": removed},
        )
    db.session.commit()
    return r


def duplicate_role(org: Organization, actor: Membership, r: Role) -> Role:
    name = f"Copy of {r.name}"[:80]
    n = 2
    while db.session.scalar(
        select(Role.id).where(Role.org_id == org.id, Role.deleted_at.is_(None), func.lower(Role.name) == name.lower())
    ):
        name = f"Copy {n} of {r.name}"[:80]
        n += 1
    return create_role(
        org,
        actor,
        {
            "name": name,
            "description": r.description,
            "base": r.base,
            "permissions": list(r.permissions or []),
            "settings": dict(r.settings or {}),
        },
    )


def delete_role(org: Organization, actor: Membership, r: Role) -> int:
    """Delete a role; its people move to the least-privileged built-in role covering its permissions (#12)."""
    members = db.session.scalars(
        select(Membership).where(
            Membership.org_id == org.id, Membership.role_id == r.id, Membership.deleted_at.is_(None)
        )
    ).all()
    to = fallback_role(r)
    for m in members:
        m.role, m.role_id = to, None
        emit(
            "member.updated",
            entity_type="user",
            entity_id=m.user_id,
            entity_label=m.user.name,
            summary=f"Role {r.name} was deleted; now {ROLES[to]['label']}",
            changes={"role": (r.name, ROLES[to]["label"])},
            org_id=org.id,
        )
    r.deleted_at = utcnow()
    emit(
        "role.deleted",
        entity_type="role",
        entity_id=r.id,
        entity_label=r.name,
        summary=f"Deleted role {r.name}"
        + (f"; {len(members)} people moved to {ROLES[to]['label']}" if members else ""),
        org_id=org.id,
    )
    db.session.commit()
    return len(members)


def restore_role(org: Organization, actor: Membership, r: Role) -> Role:
    if r.deleted_at is None:
        return r
    r.name = _name(org.id, r.name, r.id)
    r.deleted_at = None
    emit("role.restored", entity_type="role", entity_id=r.id, entity_label=r.name, summary=f"Restored role {r.name}")
    db.session.commit()
    return r


# ---- who may assign what ---------------------------------------------------------------------
def target_permissions(role: str, custom: Role | None) -> set[str]:
    if role == "custom":
        return set(custom.permissions or []) | {"org.view"} if custom is not None else {"org.view"}
    return builtin_permissions(role)


def may_assign(actor: Membership, role: str, custom: Role | None = None) -> bool:
    """May `actor` give someone this role? Owners can do anything; nobody grants more than they have."""
    if actor.role == "owner":
        return True
    mine = role_permissions(actor)
    if "users.manage" not in mine:
        return False
    if role == "owner":
        return False
    if role in ("admin", "limited_admin"):  # managing administrators needs users.manage_admins (#16)
        return "users.manage_admins" in mine and target_permissions(role, None) <= mine
    if role == "custom" and custom is None:
        return False
    return target_permissions(role, custom) <= mine


def may_manage(actor: Membership, target: Membership) -> bool:
    """May `actor` change or remove `target` (given their current role)?"""
    return may_assign(actor, target.role, target.custom_role)


def resolve_role(org_id: uuid.UUID, role: Any) -> tuple[str, Role | None]:
    """Accept "technician" or "custom:<id>" (or {"role": "custom", "role_id": …} via the API)."""
    role = str(role or "")
    if role.startswith("custom:"):
        return "custom", get_role(org_id, role)
    if role == "guest":  # r236: a plan feature (0.6.0)
        from mpro.workrequests.guests import check_entitled

        check_entitled(db.session.get(Organization, org_id))
    if role in ROLES:
        return role, None
    raise RuleError("Unknown role.", 422)


def view_as(org: Organization, role: str, custom: Role | None) -> dict[str, Any]:
    perms = target_permissions(role, custom)
    limited = role in FORCED_LIMITED_VISIBILITY or (
        custom is not None and (custom.settings or {}).get("wo_visibility") == "limited"
    )
    areas = []
    for area, label in AREAS:
        acts = [k for k, (a, _l) in ACTION_INFO.items() if a == area]
        areas.append(
            {
                "id": area,
                "label": label,
                "can": [ACTION_INFO[k][1] for k in acts if k in perms],
                "cannot": [ACTION_INFO[k][1] for k in acts if k not in perms],
            }
        )
    return {
        "role": role,
        "label": custom.name if custom is not None else ROLES.get(role, {}).get("label", role),
        "permissions": sorted(perms),
        "work_orders": "Only work at their sites"
        if role == "guest"
        else ("Only work assigned to them or their teams" if limited else "All work orders"),
        "areas": areas,
    }
