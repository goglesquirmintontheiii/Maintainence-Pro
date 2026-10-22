"""Organization, member and team business rules (guideline G-04: logic lives in services)."""

from __future__ import annotations

import re
import uuid
from typing import Any
from zoneinfo import available_timezones

from sqlalchemy import func, select

from mpro.auth.models import User
from mpro.auth.services import AuthError, get_user_by_email, link, make_token, normalize_email
from mpro.core.events import diff, emit
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.core.permissions import ROLES
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team, TeamMember

ORG_FIELDS = ("name", "timezone", "currency", "locale", "units")


class RuleError(AuthError):
    pass


def slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "org"
    slug, n = base, 1
    while db.session.scalar(select(func.count()).select_from(Organization).where(Organization.slug == slug)):
        n += 1
        slug = f"{base}-{n}"
    return slug


def create_org(name: str, owner: User, **settings: Any) -> Organization:
    org = Organization(name=name.strip(), slug=slugify(name), **settings)
    db.session.add(org)
    db.session.flush()
    db.session.add(Membership(org_id=org.id, user_id=owner.id, role="owner"))
    emit(
        "org.created",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary="Created the organization",
        org_id=org.id,
        actor=owner,
    )
    return org


def org_dict(org: Organization) -> dict[str, Any]:
    return {
        "id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "timezone": org.timezone,
        "currency": org.currency,
        "locale": org.locale,
        "units": org.units,
        "plan": org.plan,
        "home_region": org.home_region,
    }


def update_org(org: Organization, data: dict[str, Any]) -> Organization:
    before = {k: getattr(org, k) for k in ORG_FIELDS}
    if "name" in data and not str(data["name"]).strip():
        raise RuleError("The organization needs a name.", 422)
    if "timezone" in data and data["timezone"] not in available_timezones():
        raise RuleError("Pick a time zone from the list.", 422)
    if "units" in data and data["units"] not in {"imperial", "metric"}:
        raise RuleError("Units must be imperial or metric.", 422)
    if "currency" in data and not re.fullmatch(r"[A-Z]{3}", str(data["currency"])):
        raise RuleError("Use a 3-letter currency code, like USD.", 422)
    for k in ORG_FIELDS:
        if k in data:
            setattr(org, k, str(data[k]).strip())
    changes = diff(before, {k: getattr(org, k) for k in ORG_FIELDS})
    if changes:
        emit(
            "org.updated",
            entity_type="org",
            entity_id=org.id,
            entity_label=org.name,
            summary="Changed " + ", ".join(changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return org


# ---- members ---------------------------------------------------------------------------------
def member_dict(m: Membership, teams: list[Team] | None = None) -> dict[str, Any]:
    u = m.user
    return {
        "id": str(u.id),
        "membership_id": str(m.id),
        "name": u.name,
        "email": u.email,
        "initials": u.initials,
        "role": m.role,
        "role_id": str(m.role_id) if m.role_id else None,
        "role_key": f"custom:{m.role_id}" if m.role == "custom" and m.role_id else m.role,
        "role_label": _role_label(m),
        "avatar_url": avatar_url(u),
        "job_title": m.job_title,
        "active": u.is_active and m.deleted_at is None,
        "has_password": bool(u.password_hash),
        "last_login_at": iso(u.last_login_at),
        "joined_at": iso(m.created_at),
        "teams": [{"id": str(t.id), "name": t.name, "color": t.color} for t in (teams or [])],
    }


def _role_label(m: Membership) -> str:
    from mpro.orgs.roles import role_label

    return role_label(m) or m.role


def avatar_url(u: User) -> str | None:
    """Profile photo address (cache-busted by its update time), or None for initials."""
    if u.avatar_updated_at is None:
        return None
    return f"/api/v1/users/{u.id}/avatar?v={int(u.avatar_updated_at.timestamp())}"


def members_query(org_id: uuid.UUID) -> Any:
    return (
        select(Membership)
        .join(User, User.id == Membership.user_id)
        .where(Membership.org_id == org_id, Membership.deleted_at.is_(None), User.deleted_at.is_(None))
    )


def teams_of(org_id: uuid.UUID, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[Team]]:
    if not user_ids:
        return {}
    rows = db.session.execute(
        select(TeamMember.user_id, Team)
        .join(Team, Team.id == TeamMember.team_id)
        .where(TeamMember.org_id == org_id, TeamMember.user_id.in_(user_ids), Team.deleted_at.is_(None))
    ).all()
    out: dict[uuid.UUID, list[Team]] = {}
    for uid, team in rows:
        out.setdefault(uid, []).append(team)
    return out


def _admin_count(org_id: uuid.UUID) -> int:
    return int(
        db.session.scalar(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.role == "owner", Membership.deleted_at.is_(None))
        )
        or 0
    )


def invite_member(
    org: Organization, actor_m: Membership, email: str, name: str, role: str, job_title: str = ""
) -> Membership:
    email = normalize_email(email)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise RuleError("Enter a valid email address.", 422)
    from mpro.orgs.roles import may_assign, resolve_role

    role, custom = resolve_role(org.id, role)
    if not may_assign(actor_m, role, custom):
        raise RuleError("You can't give someone that role.", 403)
    role_id = custom.id if custom is not None else None
    label = custom.name if custom is not None else ROLES[role]["label"]
    user = get_user_by_email(email)
    if user is None:
        user = User(email=email, name=name.strip() or email.split("@")[0])
        db.session.add(user)
        db.session.flush()
    existing = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == user.id)
    ).first()
    if existing and existing.deleted_at is None:
        raise RuleError(f"{user.name} is already in this organization.", 409)
    if existing:
        existing.deleted_at, existing.role, existing.role_id, existing.job_title = None, role, role_id, job_title
        m = existing
    else:
        m = Membership(org_id=org.id, user_id=user.id, role=role, role_id=role_id, job_title=job_title)
        db.session.add(m)
    db.session.flush()
    path = ("/reset-password/" + make_token(user, "invite") + "?invite=1") if not user.password_hash else "/login"
    send_email(
        user.email,
        f"You've been invited to {org.name} on Maintenance Pro",
        f"Hi {user.name},\n\n{actor_m.user.name} added you to {org.name} on Maintenance Pro as "
        f"{label}.\n\n"
        + (
            "Set your password and sign in here (link works for 7 days):\n"
            if not user.password_hash
            else "Sign in here:\n"
        )
        + link(path)
        + "\n",
        org_id=org.id,
    )
    emit(
        "member.invited",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary=f"Invited {user.email} as {label}",
        data={"role": role},
        org_id=org.id,
    )
    db.session.commit()
    return m


def update_member(
    org: Organization, actor_m: Membership, m: Membership, data: dict[str, Any], self_edit: bool = False
) -> Membership:
    from mpro.orgs.roles import may_assign, may_manage, resolve_role

    before = {"name": m.user.name, "role": _role_label(m), "job_title": m.job_title}
    if "role" in data:
        new, custom = resolve_role(org.id, data["role"])
        new_id = custom.id if custom is not None else None
        if (new, new_id) != (m.role, m.role_id):
            if not may_assign(actor_m, new, custom) or not may_manage(actor_m, m):
                raise RuleError("You can't change this person's role.", 403)
            if m.role == "owner" and new != "owner" and _admin_count(org.id) <= 1:
                raise RuleError("Every organization needs at least one Owner.", 409)
            m.role, m.role_id = new, new_id
            m.custom_role = custom
    if "job_title" in data:
        m.job_title = str(data["job_title"]).strip()[:120]
    if "name" in data:
        if not str(data["name"]).strip():
            raise RuleError("A name is required.", 422)
        m.user.name = str(data["name"]).strip()[:200]
    changes = diff(before, {"name": m.user.name, "role": _role_label(m), "job_title": m.job_title})
    if changes:
        emit(
            "member.updated",
            entity_type="user",
            entity_id=m.user_id,
            entity_label=m.user.name,
            summary="Changed " + ", ".join(changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return m


def remove_member(org: Organization, actor_m: Membership, m: Membership) -> None:
    if m.id == actor_m.id:
        raise RuleError("You can't remove yourself. Ask another administrator.", 409)
    from mpro.orgs.roles import may_manage

    if not may_manage(actor_m, m):
        raise RuleError("You can't remove this person.", 403)
    if m.role == "owner" and _admin_count(org.id) <= 1:
        raise RuleError("Every organization needs at least one Owner.", 409)
    m.deleted_at = utcnow()
    emit(
        "member.removed",
        entity_type="user",
        entity_id=m.user_id,
        entity_label=m.user.name,
        summary=f"Removed {m.user.email} from the organization",
        org_id=org.id,
    )
    db.session.commit()


# ---- teams -----------------------------------------------------------------------------------
def team_dict(t: Team) -> dict[str, Any]:
    members = [tm.user for tm in t.members if tm.user.deleted_at is None]
    return {
        "id": str(t.id),
        "name": t.name,
        "description": t.description,
        "color": t.color,
        "member_count": len(members),
        "created_at": iso(t.created_at),
        "members": [{"id": str(u.id), "name": u.name, "email": u.email, "initials": u.initials} for u in members],
    }


def _check_team_name(org_id: uuid.UUID, name: str, exclude: uuid.UUID | None = None) -> str:
    name = name.strip()
    if not name:
        raise RuleError("The team needs a name.", 422)
    q = select(Team.id).where(Team.org_id == org_id, Team.deleted_at.is_(None), func.lower(Team.name) == name.lower())
    if exclude:
        q = q.where(Team.id != exclude)
    if db.session.scalar(q):
        raise RuleError(f"There's already a team called {name}.", 409)
    return name[:120]


def create_team(org: Organization, name: str, description: str = "", color: str = "#1b5bd4") -> Team:
    t = Team(org_id=org.id, name=_check_team_name(org.id, name), description=description.strip(), color=color)
    db.session.add(t)
    db.session.flush()
    emit(
        "team.created",
        entity_type="team",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Created team {t.name}",
        org_id=org.id,
    )
    db.session.commit()
    return t


def update_team(org: Organization, t: Team, data: dict[str, Any]) -> Team:
    before = {"name": t.name, "description": t.description, "color": t.color}
    if "name" in data:
        t.name = _check_team_name(org.id, str(data["name"]), exclude=t.id)
    if "description" in data:
        t.description = str(data["description"]).strip()[:2000]
    if "color" in data:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(data["color"])):
            raise RuleError("Use a colour like #1b5bd4.", 422)
        t.color = str(data["color"])
    changes = diff(before, {"name": t.name, "description": t.description, "color": t.color})
    if changes:
        emit(
            "team.updated",
            entity_type="team",
            entity_id=t.id,
            entity_label=t.name,
            summary="Changed " + ", ".join(changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return t


def delete_team(org: Organization, t: Team) -> None:
    t.deleted_at = utcnow()
    emit(
        "team.deleted",
        entity_type="team",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Deleted team {t.name}",
        org_id=org.id,
    )
    db.session.commit()


def add_team_member(org: Organization, t: Team, user_id: uuid.UUID) -> Team:
    m = db.session.scalars(members_query(org.id).where(Membership.user_id == user_id)).first()
    if m is None:
        raise RuleError("That person isn't in this organization.", 404)
    if any(tm.user_id == user_id for tm in t.members):
        return t
    t.members.append(TeamMember(org_id=org.id, user_id=user_id))
    emit(
        "team.member_added",
        entity_type="team",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Added {m.user.name} to {t.name}",
        data={"user_id": user_id},
        org_id=org.id,
    )
    db.session.commit()
    return t


def remove_team_member(org: Organization, t: Team, user_id: uuid.UUID) -> Team:
    for tm in list(t.members):
        if tm.user_id == user_id:
            name = tm.user.name
            t.members.remove(tm)
            emit(
                "team.member_removed",
                entity_type="team",
                entity_id=t.id,
                entity_label=t.name,
                summary=f"Removed {name} from {t.name}",
                data={"user_id": user_id},
                org_id=org.id,
            )
    db.session.commit()
    return t


def transfer_ownership(org: Organization, actor_m: Membership, target: Membership, stay_owner: bool) -> Membership:
    """An Owner makes someone else Owner; by default they step down to Administrator."""
    if actor_m.role != "owner":
        raise RuleError("Only an Owner can hand over ownership.", 403)
    if target.id == actor_m.id:
        raise RuleError("Pick someone else.", 422)
    if target.user.deleted_at is not None or not target.user.active:
        raise RuleError("That person's account is deactivated.", 409)
    before = _role_label(target)
    target.role, target.role_id = "owner", None
    if not stay_owner:
        actor_m.role, actor_m.role_id = "admin", None
    emit(
        "org.ownership_transferred",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary=f"Made {target.user.name} an Owner"
        + ("" if stay_owner else f"; {actor_m.user.name} is now an Administrator"),
        changes={"role": (before, "Owner")},
        org_id=org.id,
    )
    db.session.commit()
    return target
