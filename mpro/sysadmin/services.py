"""Sysadmins and MPro Management: business rules (G-04).

Sysadmins run the MPro server (MP-135). They're separate from organization roles: being a sysadmin gives no access
to an organization's work, and an organization's Owner isn't a sysadmin. MPro Management (MP-136) lets them look
after the server, its people and its organizations without seeing the organizations' data: no files, money, work
orders or assets ever leave these functions.

How the first sysadmin exists: when a server has none, the person who gets the first organization through
`mpro create-admin` (or the demo admin, when demo data is loaded) becomes one; on servers upgraded to 0.6.0 it's the
owner of the oldest organization (migration 0012). After that, `mpro sysadmin add | remove | list` manages them.

Every change is a domain event (`sysadmin.*`). Server-level changes have no organization (org_id None, the server
audit log); changes to one organization are recorded in that organization's audit log too.
"""

from __future__ import annotations

import contextlib
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from flask import current_app
from sqlalchemy import ColumnElement, func, or_, select

from mpro.auth.models import User
from mpro.auth.services import AuthError, get_user_by_email, link, make_token, normalize_email, validate_password
from mpro.core.crypto import encrypt_str
from mpro.core.entitlements import PLANS
from mpro.core.events import DomainEvent, emit
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.core.permissions import ROLES
from mpro.core.search import like
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.sysadmin import server_settings as ss
from mpro.sysadmin.models import SERVICES, ApiKey


class SysadminError(AuthError):
    pass


PLAN_CHOICES: list[str] = ["selfhosted", *PLANS.keys()]
PLAN_LABELS: dict[str, str] = {
    "selfhosted": "Self-hosted (everything)",
    "free": "Free",
    "pro": "Pro",
    "pro_50": "Pro, up to 50 users",
    "pro_unlimited": "Pro, unlimited users",
    "expert": "Expert",
    "expert_50": "Expert, up to 50 users",
    "expert_unlimited": "Expert, unlimited users",
    "expert_lifetime": "Expert lifetime",
}
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


# ---- audit ----------------------------------------------------------------------------------
def audit(
    type: str,
    *,
    entity_type: str,
    entity_id: Any,
    entity_label: str = "",
    summary: str = "",
    changes: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    org_id: uuid.UUID | None = None,
    actor: Any = None,
) -> DomainEvent:
    """emit() fills in the signed-in person's organization when org_id is None; server-level events keep None."""
    ev = emit(
        type,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_label=entity_label,
        summary=summary,
        changes=changes,
        data={**(data or {}), "sysadmin": True},
        org_id=org_id,
        actor=actor,
    )
    ev.org_id = org_id
    return ev


def server_audit(q: str = "", cursor: str | None = None, limit: int = 50) -> dict[str, Any]:
    """The server's audit log: server-level events and everything done from MPro Management."""
    query = select(DomainEvent).where(or_(DomainEvent.org_id.is_(None), DomainEvent.type.like("sysadmin.%")))
    if q.strip():
        pat = like(q.strip())
        query = query.where(
            or_(
                func.lower(DomainEvent.summary).like(pat, escape="\\"),
                func.lower(DomainEvent.entity_label).like(pat, escape="\\"),
                func.lower(DomainEvent.actor_label).like(pat, escape="\\"),
                func.lower(DomainEvent.type).like(pat, escape="\\"),
            )
        )
    if cursor:
        query = query.where(DomainEvent.id < _uuid(cursor, "cursor"))
    rows = db.session.scalars(query.order_by(DomainEvent.id.desc()).limit(limit + 1)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": [r.to_dict() for r in rows], "next_cursor": str(rows[-1].id) if more and rows else None}


# ---- helpers --------------------------------------------------------------------------------
def _uuid(value: Any, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise SysadminError(f"That {what} isn't valid.", 404) from None


def get_user(user_id: Any) -> User:
    u = db.session.get(User, _uuid(user_id, "person"))
    if u is None or u.deleted_at is not None:
        raise SysadminError("That person doesn't exist.", 404)
    return u


def get_org(org_id: Any, include_deleted: bool = False) -> Organization:
    o = db.session.get(Organization, _uuid(org_id, "organization"))
    if o is None or (o.deleted_at is not None and not include_deleted):
        raise SysadminError("That organization doesn't exist.", 404)
    return o


def confirm_password(actor: User, password: Any) -> None:
    """Risky steps (deleting an organization, resetting a password, sysadmin changes) need the password again."""
    if not password or not actor.check_password(str(password)):
        audit(
            "sysadmin.password_check_failed",
            entity_type="user",
            entity_id=actor.id,
            entity_label=actor.name,
            summary="Entered a wrong password in MPro Management",
            actor=actor,
        )
        db.session.commit()
        raise SysadminError("That password isn't right. Enter your own MPro password to confirm.", 403)


def _active_sysadmins() -> list[User]:
    return list(
        db.session.scalars(
            select(User)
            .where(User.is_sysadmin.is_(True), User.deleted_at.is_(None), User.active.is_(True))
            .order_by(User.email)
        )
    )


def has_sysadmin() -> bool:
    return bool(_active_sysadmins())


# ---- sysadmins (CLI and MPro Management) ----------------------------------------------------
def list_sysadmins() -> list[User]:
    return list(
        db.session.scalars(
            select(User).where(User.is_sysadmin.is_(True), User.deleted_at.is_(None)).order_by(User.email)
        )
    )


def add_sysadmin(email: str, actor: Any = None, via: str = "terminal") -> User:
    u = get_user_by_email(normalize_email(email))
    if u is None or u.deleted_at is not None:
        raise SysadminError(f"No one has the email {email.strip()}. They need an account first.", 404)
    if u.is_sysadmin:
        raise SysadminError(f"{u.email} is already a sysadmin.", 409)
    u.is_sysadmin = True
    audit(
        "sysadmin.added",
        entity_type="user",
        entity_id=u.id,
        entity_label=u.name,
        summary=f"Made {u.email} a sysadmin ({via})",
        data={"via": via},
        actor=actor,
    )
    db.session.commit()
    return u


def remove_sysadmin(email: str, force: bool = False, actor: Any = None, via: str = "terminal") -> User:
    u = get_user_by_email(normalize_email(email))
    if u is None or not u.is_sysadmin:
        raise SysadminError(f"{email.strip()} isn't a sysadmin.", 404)
    others = [x for x in _active_sysadmins() if x.id != u.id]
    if not others and not force:
        raise SysadminError(
            f"{u.email} is the last sysadmin. Add another one first, or use --force to leave the server with none.",
            409,
        )
    u.is_sysadmin = False
    audit(
        "sysadmin.removed",
        entity_type="user",
        entity_id=u.id,
        entity_label=u.name,
        summary=f"Removed {u.email} as a sysadmin ({via})" + (" (forced, no sysadmins left)" if not others else ""),
        data={"via": via, "forced": bool(force and not others)},
        actor=actor,
    )
    db.session.commit()
    return u


def make_first_sysadmin(user: User, via: str) -> bool:
    """A server with no sysadmin gets its first one (create-admin, demo data). Caller commits."""
    if has_sysadmin() or user.is_sysadmin:
        return False
    user.is_sysadmin = True
    audit(
        "sysadmin.added",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary=f"{user.email} is the server's first sysadmin ({via})",
        data={"via": via, "first": True},
        actor=user,
    )
    return True


# ---- users ----------------------------------------------------------------------------------
def _orgs_of(u: User) -> list[dict[str, Any]]:
    out = []
    for m in u.memberships:
        if m.deleted_at is not None:
            continue
        o = m.org
        out.append(
            {
                "org_id": str(o.id),
                "org_name": o.name,
                "org_deleted": o.deleted_at is not None,
                "plan": o.plan,
                "role": m.role,
                "role_label": m.custom_role.name
                if m.custom_role is not None
                else ROLES.get(m.role, {}).get("label", m.role),
                "joined_at": iso(m.created_at),
            }
        )
    return sorted(out, key=lambda x: x["org_name"].lower())


def user_row(u: User) -> dict[str, Any]:
    return {
        "id": str(u.id),
        "name": u.name,
        "email": u.email,
        "phone": u.phone or "",
        "initials": u.initials,
        "active": bool(u.active),
        "sysadmin": bool(u.is_sysadmin),
        "has_password": bool(u.password_hash),
        "last_login_at": iso(u.last_login_at),
        "created_at": iso(u.created_at),
        "org_count": sum(1 for m in u.memberships if m.deleted_at is None and m.org.deleted_at is None),
    }


def user_detail(u: User) -> dict[str, Any]:
    return {**user_row(u), "orgs": _orgs_of(u)}


def search_users(q: str = "", page: int = 1, per_page: int = 25, filter: str = "") -> dict[str, Any]:
    query = select(User).where(User.deleted_at.is_(None))
    if q.strip():
        pat = like(q.strip())
        conds: list[ColumnElement[bool]] = [
            func.lower(User.name).like(pat, escape="\\"),
            func.lower(User.email).like(pat, escape="\\"),
        ]
        conds.append(func.lower(User.phone).like(pat, escape="\\"))
        with contextlib.suppress(ValueError):
            conds.append(User.id == uuid.UUID(q.strip()))
        query = query.where(or_(*conds))
    if filter == "sysadmins":
        query = query.where(User.is_sysadmin.is_(True))
    elif filter == "locked":
        query = query.where(User.active.is_(False))
    total = int(db.session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    per_page = max(1, min(per_page, 100))
    page = max(1, page)
    rows = db.session.scalars(
        query.order_by(func.lower(User.name), User.id).offset((page - 1) * per_page).limit(per_page)
    )
    return {"items": [user_row(u) for u in rows], "total": total, "page": page, "per_page": per_page}


def update_user(actor: User, u: User, data: dict[str, Any]) -> User:
    """Name, email, phone, locked/unlocked and sysadmin on/off. Sysadmin changes need `password`."""
    before = {"name": u.name, "email": u.email, "phone": u.phone or "", "active": u.active, "sysadmin": u.is_sysadmin}
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise SysadminError("A name is required.", 422)
        u.name = name[:200]
    if "email" in data:
        email = normalize_email(str(data["email"] or ""))
        if not EMAIL_RE.fullmatch(email):
            raise SysadminError("Enter a valid email address.", 422)
        other = get_user_by_email(email)
        if other is not None and other.id != u.id:
            raise SysadminError("Someone else already uses that email.", 409)
        u.email = email
    if "phone" in data:
        phone = str(data["phone"] or "").strip()
        if len(phone) > 40 or (phone and not re.fullmatch(r"[0-9+()\-.\s xext]{3,40}", phone)):
            raise SysadminError("Enter a phone number with digits, spaces, + ( ) - only.", 422)
        u.phone = phone
    if "active" in data and bool(data["active"]) != bool(u.active):
        if u.id == actor.id:
            raise SysadminError("You can't lock your own account.", 409)
        if not data["active"] and u.is_sysadmin and len([x for x in _active_sysadmins() if x.id != u.id]) == 0:
            raise SysadminError("This is the last sysadmin, so the account can't be locked.", 409)
        u.active = bool(data["active"])
    if "sysadmin" in data and bool(data["sysadmin"]) != bool(u.is_sysadmin):
        confirm_password(actor, data.get("password"))
        if data["sysadmin"]:
            add_sysadmin(u.email, actor=actor, via="MPro Management")
        else:
            if u.id == actor.id and len([x for x in _active_sysadmins() if x.id != u.id]) == 0:
                raise SysadminError("You're the last sysadmin. Make someone else a sysadmin first.", 409)
            remove_sysadmin(u.email, actor=actor, via="MPro Management")
    after = {"name": u.name, "email": u.email, "phone": u.phone or "", "active": u.active, "sysadmin": u.is_sysadmin}
    changes = {k: (before[k], after[k]) for k in before if before[k] != after[k] and k != "sysadmin"}
    if changes:
        kind = (
            "sysadmin.user_locked"
            if changes.get("active") == (True, False)
            else ("sysadmin.user_unlocked" if changes.get("active") == (False, True) else "sysadmin.user_updated")
        )
        audit(
            kind,
            entity_type="user",
            entity_id=u.id,
            entity_label=u.name,
            summary="Changed " + ", ".join(changes) + f" for {u.email}",
            changes=changes,
            actor=actor,
        )
    db.session.commit()
    return u


def reset_password(actor: User, u: User, data: dict[str, Any]) -> dict[str, Any]:
    """mode "email": send them a reset link. mode "set": give them a new password now. Both need `password`."""
    confirm_password(actor, data.get("password"))
    mode = data.get("mode", "email")
    if mode == "set":
        new = str(data.get("new_password") or "")
        try:
            validate_password(new)
        except AuthError as e:
            raise SysadminError(e.message, 422) from e
        u.set_password(new)
        summary = f"Set a new password for {u.email}"
    elif mode == "email":
        if not u.active:
            raise SysadminError("Unlock the account first, so the reset link works.", 409)
        url = link("/reset-password/" + make_token(u, "reset"))
        send_email(
            u.email,
            "Reset your Maintenance Pro password",
            f"Hi {u.name},\n\nThe administrator of this Maintenance Pro server sent you a link to set a new "
            f"password.\n\nSet a new password here (the link works for 1 hour):\n{url}\n\n"
            "If you didn't expect this, contact your administrator.\n",
        )
        summary = f"Sent a password reset link to {u.email}"
    else:
        raise SysadminError("Pick how to reset the password: email a link or set one now.", 422)
    audit(
        "sysadmin.user_password_reset",
        entity_type="user",
        entity_id=u.id,
        entity_label=u.name,
        summary=summary,
        data={"mode": mode},
        actor=actor,
    )
    db.session.commit()
    return {"mode": mode, "message": summary}


# ---- organizations -----------------------------------------------------------------------------
def _member_counts(org_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not org_ids:
        return {}
    rows = db.session.execute(
        select(Membership.org_id, func.count())
        .join(User, User.id == Membership.user_id)
        .where(Membership.org_id.in_(org_ids), Membership.deleted_at.is_(None), User.deleted_at.is_(None))
        .group_by(Membership.org_id)
    ).all()
    return {r[0]: int(r[1]) for r in rows}


def _owners(o: Organization) -> list[dict[str, str]]:
    return [
        {"id": str(m.user_id), "name": m.user.name, "email": m.user.email}
        for m in o.memberships
        if m.deleted_at is None and m.role == "owner" and m.user.deleted_at is None
    ]


def org_row(o: Organization, members: int | None = None) -> dict[str, Any]:
    """Only what the server's administrator needs: never files, money, work orders or assets (MP-136)."""
    return {
        "id": str(o.id),
        "name": o.name,
        "slug": o.slug,
        "email": o.email or "",
        "plan": o.plan,
        "plan_label": PLAN_LABELS.get(o.plan, o.plan),
        "timezone": o.timezone,
        "created_at": iso(o.created_at),
        "deleted": o.deleted_at is not None,
        "deleted_at": iso(o.deleted_at),
        "members": members if members is not None else _member_counts([o.id]).get(o.id, 0),
        "owners": _owners(o),
    }


def search_orgs(q: str = "", page: int = 1, per_page: int = 25, include_deleted: bool = False) -> dict[str, Any]:
    query = select(Organization)
    if not include_deleted:
        query = query.where(Organization.deleted_at.is_(None))
    if q.strip():
        pat = like(q.strip())
        conds: list[ColumnElement[bool]] = [
            func.lower(Organization.name).like(pat, escape="\\"),
            func.lower(Organization.slug).like(pat, escape="\\"),
            func.lower(Organization.email).like(pat, escape="\\"),
        ]
        with contextlib.suppress(ValueError):
            conds.append(Organization.id == uuid.UUID(q.strip()))
        query = query.where(or_(*conds))
    total = int(db.session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    per_page = max(1, min(per_page, 100))
    page = max(1, page)
    rows = list(
        db.session.scalars(
            query.order_by(func.lower(Organization.name), Organization.id).offset((page - 1) * per_page).limit(per_page)
        )
    )
    counts = _member_counts([o.id for o in rows])
    return {
        "items": [org_row(o, counts.get(o.id, 0)) for o in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def org_members(o: Organization) -> list[dict[str, Any]]:
    out = []
    for m in o.memberships:
        if m.deleted_at is not None or m.user.deleted_at is not None:
            continue
        out.append(
            {
                "membership_id": str(m.id),
                "user_id": str(m.user_id),
                "name": m.user.name,
                "email": m.user.email,
                "role": m.role if m.custom_role is None else "custom:" + str(m.role_id),
                "role_label": m.custom_role.name
                if m.custom_role is not None
                else ROLES.get(m.role, {}).get("label", m.role),
                "active": bool(m.user.active),
                "joined_at": iso(m.created_at),
            }
        )
    return sorted(out, key=lambda x: x["name"].lower())


def org_roles(o: Organization) -> list[dict[str, str]]:
    from mpro.orgs.models import Role

    built_in = [{"key": k, "label": v["label"]} for k, v in ROLES.items()]
    custom = db.session.scalars(
        select(Role).where(Role.org_id == o.id, Role.deleted_at.is_(None)).order_by(func.lower(Role.name))
    ).all()
    return built_in + [{"key": "custom:" + str(r.id), "label": r.name} for r in custom]


def org_detail(o: Organization) -> dict[str, Any]:
    return {**org_row(o), "member_list": org_members(o), "roles": org_roles(o), "plans": plan_choices()}


def plan_choices() -> list[dict[str, str]]:
    return [{"key": k, "label": PLAN_LABELS.get(k, k)} for k in PLAN_CHOICES]


def plans_apply() -> bool:
    """Plans only limit organizations on MPro Cloud (G-07, G-30); on a self-hosted server everyone gets everything."""
    return current_app.config.get("MPRO_EDITION") == "cloud"


def update_org(actor: User, o: Organization, data: dict[str, Any]) -> Organization:
    before = {"name": o.name, "email": o.email or "", "plan": o.plan}
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise SysadminError("The organization needs a name.", 422)
        o.name = name[:200]
    if "email" in data:
        email = normalize_email(str(data["email"] or ""))
        if email and not EMAIL_RE.fullmatch(email):
            raise SysadminError("Enter a valid email address, or leave it empty.", 422)
        o.email = email
    if "plan" in data:
        plan = str(data["plan"] or "")
        if plan not in PLAN_CHOICES:
            raise SysadminError("Pick one of the plans in the list.", 422)
        o.plan = plan
    after = {"name": o.name, "email": o.email or "", "plan": o.plan}
    changes = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    if changes:
        audit(
            "sysadmin.org_updated",
            entity_type="org",
            entity_id=o.id,
            entity_label=o.name,
            summary="MPro sysadmin changed " + ", ".join(changes),
            changes=changes,
            org_id=o.id,
            actor=actor,
        )
    db.session.commit()
    return o


def _owner_count(o: Organization, excluding: uuid.UUID | None = None) -> int:
    return sum(
        1
        for m in o.memberships
        if m.deleted_at is None and m.role == "owner" and m.id != excluding and m.user.deleted_at is None
    )


def _resolve_role(o: Organization, role: Any) -> tuple[str, uuid.UUID | None, str]:
    from mpro.orgs.models import Role

    key = str(role or "")
    if key.startswith("custom:"):
        r = db.session.get(Role, _uuid(key[7:], "role"))
        if r is None or r.org_id != o.id or r.deleted_at is not None:
            raise SysadminError("That role isn't in this organization.", 422)
        return "custom", r.id, r.name
    if key not in ROLES:
        raise SysadminError("Pick a role from the list.", 422)
    return key, None, ROLES[key]["label"]


def add_member(actor: User, o: Organization, data: dict[str, Any]) -> Membership:
    """Add someone (an existing account, or a new one that gets an invitation) to the organization."""
    email = normalize_email(str(data.get("email") or ""))
    if not EMAIL_RE.fullmatch(email):
        raise SysadminError("Enter a valid email address.", 422)
    role, role_id, label = _resolve_role(o, data.get("role") or "technician")
    user = get_user_by_email(email)
    if user is None:
        user = User(email=email, name=str(data.get("name") or "").strip()[:200] or email.split("@")[0])
        db.session.add(user)
        db.session.flush()
    elif user.deleted_at is not None:
        raise SysadminError("That account was deleted.", 409)
    m = db.session.scalars(select(Membership).where(Membership.org_id == o.id, Membership.user_id == user.id)).first()
    if m is not None and m.deleted_at is None:
        raise SysadminError(f"{user.name} is already in {o.name}.", 409)
    if m is not None:
        m.deleted_at, m.role, m.role_id = None, role, role_id
    else:
        m = Membership(org_id=o.id, user_id=user.id, role=role, role_id=role_id)
        db.session.add(m)
    db.session.flush()
    path = ("/reset-password/" + make_token(user, "invite") + "?invite=1") if not user.password_hash else "/login"
    send_email(
        user.email,
        f"You've been added to {o.name} on Maintenance Pro",
        f"Hi {user.name},\n\nThe administrator of this Maintenance Pro server added you to {o.name} as {label}.\n\n"
        + (
            "Set your password and sign in here (link works for 7 days):\n"
            if not user.password_hash
            else "Sign in here:\n"
        )
        + link(path)
        + "\n",
        org_id=o.id,
    )
    audit(
        "sysadmin.membership_added",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary=f"MPro sysadmin added {user.email} to {o.name} as {label}",
        data={"role": role, "org": o.name},
        org_id=o.id,
        actor=actor,
    )
    db.session.commit()
    return m


def _membership(o: Organization, user_id: Any) -> Membership:
    uid = _uuid(user_id, "person")
    m = next((x for x in o.memberships if x.user_id == uid and x.deleted_at is None), None)
    if m is None:
        raise SysadminError("That person isn't in this organization.", 404)
    return m


def change_member_role(actor: User, o: Organization, user_id: Any, role: Any) -> Membership:
    m = _membership(o, user_id)
    new, new_id, label = _resolve_role(o, role)
    if (new, new_id) == (m.role, m.role_id):
        return m
    if m.role == "owner" and new != "owner" and _owner_count(o, excluding=m.id) == 0:
        raise SysadminError("Every organization needs at least one Owner. Make someone else Owner first.", 409)
    old = m.custom_role.name if m.custom_role is not None else ROLES.get(m.role, {}).get("label", m.role)
    m.role, m.role_id = new, new_id
    db.session.flush()
    db.session.refresh(m)
    audit(
        "sysadmin.membership_changed",
        entity_type="user",
        entity_id=m.user_id,
        entity_label=m.user.name,
        summary=f"MPro sysadmin changed {m.user.email}'s role in {o.name} to {label}",
        changes={"role": (old, label)},
        org_id=o.id,
        actor=actor,
    )
    db.session.commit()
    return m


def remove_member(actor: User, o: Organization, user_id: Any) -> None:
    m = _membership(o, user_id)
    if m.role == "owner" and _owner_count(o, excluding=m.id) == 0:
        raise SysadminError("Every organization needs at least one Owner. Make someone else Owner first.", 409)
    m.deleted_at = utcnow()
    audit(
        "sysadmin.membership_removed",
        entity_type="user",
        entity_id=m.user_id,
        entity_label=m.user.name,
        summary=f"MPro sysadmin removed {m.user.email} from {o.name}",
        org_id=o.id,
        actor=actor,
    )
    db.session.commit()


def delete_org(actor: User, o: Organization, data: dict[str, Any]) -> None:
    """Soft delete: members lose access straight away; the data stays until a sysadmin restores or purges it."""
    confirm_password(actor, data.get("password"))
    if str(data.get("confirm_name") or "").strip() != o.name:
        raise SysadminError(f"Type the organization's name ({o.name}) to confirm.", 422)
    o.deleted_at = utcnow()
    audit(
        "sysadmin.org_deleted",
        entity_type="org",
        entity_id=o.id,
        entity_label=o.name,
        summary=f"MPro sysadmin deleted the organization {o.name}",
        org_id=o.id,
        actor=actor,
    )
    db.session.commit()


def restore_org(actor: User, o: Organization) -> Organization:
    if o.deleted_at is None:
        raise SysadminError("This organization isn't deleted.", 409)
    o.deleted_at = None
    audit(
        "sysadmin.org_restored",
        entity_type="org",
        entity_id=o.id,
        entity_label=o.name,
        summary=f"MPro sysadmin restored the organization {o.name}",
        org_id=o.id,
        actor=actor,
    )
    db.session.commit()
    return o


# ---- server settings ------------------------------------------------------------------------
def _data_dir() -> str:
    return str(current_app.config["MPRO_DATA_DIR"])


def server_settings() -> dict[str, Any]:
    saved = ss.load(_data_dir())
    fixed = ss.env_overrides()
    cfg = current_app.config
    running: dict[str, Any] = {
        "base_url": cfg.get("MPRO_BASE_URL"),
        "smtp_host": cfg.get("MAIL_SERVER"),
        "smtp_port": cfg.get("MAIL_PORT"),
        "smtp_user": cfg.get("MAIL_USERNAME"),
        "smtp_tls": cfg.get("MAIL_USE_TLS"),
        "mail_from": cfg.get("MAIL_FROM"),
        "max_upload_mb": cfg.get("MPRO_MAX_UPLOAD_MB"),
        "session_hours": int(cfg["PERMANENT_SESSION_LIFETIME"].total_seconds() // 3600)
        if cfg.get("PERMANENT_SESSION_LIFETIME")
        else None,
        "trusted_proxies": cfg.get("MPRO_TRUSTED_PROXIES"),
        "host": cfg.get("MPRO_LISTEN_HOST"),
        "port": cfg.get("MPRO_LISTEN_PORT"),
    }
    items = []
    for key, (typ, env, _conf, applies, label) in ss.FIELDS.items():
        secret = key in ss.SECRET_FIELDS
        value = saved.get(key)
        item: dict[str, Any] = {
            "key": key,
            "label": label,
            "type": "bool" if typ is bool else ("int" if typ is int else ("secret" if secret else "str")),
            "applies": applies,
            "env": env,
            "locked": key in fixed,
            "source": "environment" if key in fixed else ("file" if key in saved else "default"),
        }
        if secret:
            item["has_value"] = bool(value) or bool(cfg.get("MAIL_PASSWORD"))
            item["value"] = None
        else:
            item["value"] = value
            item["running"] = running.get(key)
        items.append(item)
    return {
        "items": items,
        "file": str(ss.path_for(_data_dir())),
        "everywhere_warning": ss.EVERYWHERE_WARNING,
        "edition": cfg.get("MPRO_EDITION"),
        "test_build": bool(cfg.get("MPRO_TEST_BUILD")),
    }


def save_server_settings(actor: User, updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict) or not updates:
        raise SysadminError("Nothing to save.", 422)
    try:
        clean = ss.validate(updates)
    except ss.SettingsError as e:
        raise SysadminError(str(e), 422) from e
    fixed = ss.env_overrides()
    locked = [ss.FIELDS[k][4] for k in clean if k in fixed]
    if locked:
        raise SysadminError(
            "Set by an environment variable, so change it there: " + ", ".join(locked) + ".",
            409,
        )
    before = ss.load(_data_dir())
    to_save = {k: (encrypt_str(v) if k in ss.SECRET_FIELDS and v else v) for k, v in clean.items()}
    ss.save(_data_dir(), to_save)
    # apply what can change while running; the rest waits for a restart
    cfg = current_app.config
    for key, value in clean.items():
        conf_key = ss.FIELDS[key][2]
        if ss.FIELDS[key][3] != "now" or not conf_key:
            continue
        default = {"smtp_port": 587, "smtp_tls": True, "max_upload_mb": 150}.get(key, "")
        cfg[conf_key] = value if value is not None else default
        if key == "max_upload_mb":
            cfg["MAX_CONTENT_LENGTH"] = (int(cfg[conf_key]) + 2) * 1024 * 1024
    changes = {
        k: (
            ("•••" if before.get(k) else "") if k in ss.SECRET_FIELDS else before.get(k),
            "•••" if (k in ss.SECRET_FIELDS and v) else v,
        )
        for k, v in clean.items()
        if (before.get(k) != to_save.get(k)) or k in ss.SECRET_FIELDS
    }
    restart = sorted(ss.FIELDS[k][4] for k in clean if ss.FIELDS[k][3] == "restart")
    audit(
        "sysadmin.server_settings_changed",
        entity_type="server",
        entity_id="settings",
        entity_label="Server settings",
        summary="Changed server settings: " + ", ".join(ss.FIELDS[k][4] for k in clean),
        changes=changes,
        data={"restart_needed": restart},
        actor=actor,
    )
    db.session.commit()
    host = clean.get("host")
    return {
        **server_settings(),
        "restart_needed": restart,
        "warning": ss.EVERYWHERE_WARNING if host and ss.is_everywhere(host) else None,
    }


# ---- API keys --------------------------------------------------------------------------------
def _mask(last4: str) -> str:
    return "••••" + last4 if last4 else "••••"


def _name_of(user_id: uuid.UUID | None) -> str | None:
    u = db.session.get(User, user_id) if user_id else None
    return u.name if u is not None else None


def key_dict(k: ApiKey) -> dict[str, Any]:
    return {
        "id": str(k.id),
        "name": k.name,
        "service": k.service,
        "service_label": SERVICES.get(k.service, k.service),
        "masked": _mask(k.last4),
        "note": k.note,
        "created_at": iso(k.created_at),
        "updated_at": iso(k.updated_at),
        "created_by": _name_of(k.created_by_id),
    }


def list_keys() -> list[dict[str, Any]]:
    rows = db.session.scalars(select(ApiKey).where(ApiKey.deleted_at.is_(None)).order_by(func.lower(ApiKey.name)))
    return [key_dict(k) for k in rows]


def _clean_secret(value: Any) -> str:
    secret = str(value or "").strip()
    if len(secret) < 8 or len(secret) > 4000 or any(c.isspace() for c in secret):
        raise SysadminError("Paste the whole key (at least 8 characters, no spaces).", 422)
    return secret


def create_key(actor: User, data: dict[str, Any]) -> ApiKey:
    name = str(data.get("name") or "").strip()[:120]
    if not name:
        raise SysadminError("Give the key a name, such as “OpenAI for the AI assistant”.", 422)
    service = str(data.get("service") or "other")
    if service not in SERVICES:
        raise SysadminError("Pick the service the key is for.", 422)
    secret = _clean_secret(data.get("secret"))
    k = ApiKey(
        name=name,
        service=service,
        secret=encrypt_str(secret),
        last4=secret[-4:],
        note=str(data.get("note") or "").strip()[:500],
        created_by_id=actor.id,
    )
    db.session.add(k)
    db.session.flush()
    audit(
        "sysadmin.api_key_created",
        entity_type="api_key",
        entity_id=k.id,
        entity_label=k.name,
        summary=f"Added the {SERVICES[service]} key “{k.name}” ({_mask(k.last4)})",
        data={"service": service},
        actor=actor,
    )
    db.session.commit()
    return k


def get_key(key_id: Any) -> ApiKey:
    k = db.session.get(ApiKey, _uuid(key_id, "key"))
    if k is None or k.deleted_at is not None:
        raise SysadminError("That key doesn't exist.", 404)
    return k


def update_key(actor: User, k: ApiKey, data: dict[str, Any]) -> ApiKey:
    changed = []
    if "name" in data:
        name = str(data["name"] or "").strip()[:120]
        if not name:
            raise SysadminError("Give the key a name.", 422)
        if name != k.name:
            k.name = name
            changed.append("name")
    if "note" in data:
        k.note = str(data["note"] or "").strip()[:500]
        changed.append("note")
    if "service" in data:
        if data["service"] not in SERVICES:
            raise SysadminError("Pick the service the key is for.", 422)
        k.service = str(data["service"])
        changed.append("service")
    if data.get("secret"):
        secret = _clean_secret(data["secret"])
        k.secret, k.last4 = encrypt_str(secret), secret[-4:]
        changed.append("key")
    if changed:
        audit(
            "sysadmin.api_key_updated",
            entity_type="api_key",
            entity_id=k.id,
            entity_label=k.name,
            summary=f"Changed the {', '.join(changed)} of “{k.name}”"
            + (f" (now {_mask(k.last4)})" if "key" in changed else ""),
            actor=actor,
        )
    db.session.commit()
    return k


def delete_key(actor: User, k: ApiKey) -> None:
    k.deleted_at = utcnow()
    audit(
        "sysadmin.api_key_deleted",
        entity_type="api_key",
        entity_id=k.id,
        entity_label=k.name,
        summary=f"Deleted the key “{k.name}” ({_mask(k.last4)})",
        actor=actor,
    )
    db.session.commit()


def secret_for(service: str) -> str | None:
    """For server code that calls an outside service (AI in 1.2.0): the newest key for `service`, decrypted."""
    from mpro.core.crypto import DecryptError, decrypt_str

    k = db.session.scalars(
        select(ApiKey).where(ApiKey.service == service, ApiKey.deleted_at.is_(None)).order_by(ApiKey.created_at.desc())
    ).first()
    if k is None:
        return None
    try:
        return decrypt_str(k.secret)
    except DecryptError:
        return None


def overview() -> dict[str, Any]:
    users = int(db.session.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))) or 0)
    orgs = int(
        db.session.scalar(select(func.count()).select_from(Organization).where(Organization.deleted_at.is_(None))) or 0
    )
    return {
        "users": users,
        "orgs": orgs,
        "sysadmins": [user_row(u) for u in list_sysadmins()],
        "keys": len(list_keys()),
        "now": datetime.now(UTC).isoformat(),
    }
