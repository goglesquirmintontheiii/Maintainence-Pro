from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, Schema, abort
from apiflask.fields import String
from apiflask.validators import Length, OneOf
from flask import g, request
from sqlalchemy import func, or_, select

from mpro.auth.models import User
from mpro.core.permissions import ROLES, can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs import services as svc
from mpro.orgs.models import Membership, Team

bp = APIBlueprint("orgs", __name__, url_prefix="/api/v1", tag="Organization")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except svc.RuleError as e:
        abort(e.status, message=e.message)


class OrgPatch(Schema):
    name = String(validate=Length(1, 200))
    timezone = String()
    currency = String()
    locale = String()
    units = String()


class InviteIn(Schema):
    email = String(required=True, validate=Length(3, 320))
    name = String(load_default="")
    role = String(required=True, validate=OneOf(list(ROLES)))
    job_title = String(load_default="")


class MemberPatch(Schema):
    name = String(validate=Length(1, 200))
    role = String(validate=OneOf(list(ROLES)))
    job_title = String(validate=Length(0, 120))


class TeamIn(Schema):
    name = String(required=True, validate=Length(1, 120))
    description = String(load_default="")
    color = String(load_default="#1b5bd4")


class TeamPatch(Schema):
    name = String(validate=Length(1, 120))
    description = String()
    color = String()


class TeamMemberIn(Schema):
    user_id = String(required=True)


@bp.get("/org")
@require("org.view")
def get_org() -> dict[str, Any]:
    return svc.org_dict(g.org)


@bp.patch("/org")
@require("org.manage")
@bp.input(OrgPatch, arg_name="body")
def patch_org(body: dict[str, Any]) -> dict[str, Any]:
    return svc.org_dict(guard(svc.update_org, g.org, body))


@bp.get("/roles")
@require("org.view")
def roles() -> list[dict[str, Any]]:
    return [{"id": k, **v} for k, v in ROLES.items()]


# ---- people ----------------------------------------------------------------------------------
def _member(user_id: str) -> Membership:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        abort(404)
    m = db.session.scalars(svc.members_query(g.org.id).where(Membership.user_id == uid)).first()
    if m is None:
        abort(404)
    return m


@bp.get("/users")
@require("users.view")
def list_users() -> dict[str, Any]:
    q = (request.args.get("q") or "").strip()
    role = request.args.get("role")
    query = svc.members_query(g.org.id)
    if q:
        query = query.where(
            or_(
                func.lower(User.name).like(like(q), escape="\\"),
                func.lower(User.email).like(like(q), escape="\\"),
                func.lower(Membership.job_title).like(like(q), escape="\\"),
            )
        )
    if role in ROLES:
        query = query.where(Membership.role == role)
    ms = db.session.scalars(query.order_by(func.lower(User.name))).all()
    tm = svc.teams_of(g.org.id, [m.user_id for m in ms])
    return {"items": [svc.member_dict(m, tm.get(m.user_id)) for m in ms], "total": len(ms)}


@bp.get("/users/<user_id>")
@require("users.view")
def get_user(user_id: str) -> dict[str, Any]:
    m = _member(user_id)
    return svc.member_dict(m, svc.teams_of(g.org.id, [m.user_id]).get(m.user_id))


@bp.post("/users")
@require("users.manage")
@bp.input(InviteIn, arg_name="body")
def invite(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    m = guard(svc.invite_member, g.org, g.membership, body["email"], body["name"], body["role"], body["job_title"])
    return svc.member_dict(m), 201


@bp.patch("/users/<user_id>")
@bp.input(MemberPatch, arg_name="body")
def patch_user(user_id: str, body: dict[str, Any]) -> dict[str, Any]:
    if g.user is None:
        abort(401)
    m = _member(user_id)
    is_self = m.user_id == g.user.id
    if not can(g.membership, "users.manage") and not (is_self and set(body) <= {"name"}):
        abort(403, message="You don't have permission to do that.")
    m = guard(svc.update_member, g.org, g.membership, m, body)
    return svc.member_dict(m, svc.teams_of(g.org.id, [m.user_id]).get(m.user_id))


@bp.delete("/users/<user_id>")
@require("users.manage")
def remove_user(user_id: str) -> tuple[str, int]:
    guard(svc.remove_member, g.org, g.membership, _member(user_id))
    return "", 204


# ---- teams -----------------------------------------------------------------------------------
@bp.get("/teams")
@require("teams.view")
def list_teams() -> dict[str, Any]:
    q = (request.args.get("q") or "").strip()
    query = scoped(Team)
    if q:
        query = query.where(func.lower(Team.name).like(like(q), escape="\\"))
    ts = db.session.scalars(query.order_by(func.lower(Team.name))).all()
    return {"items": [svc.team_dict(t) for t in ts], "total": len(ts)}


@bp.post("/teams")
@require("teams.manage")
@bp.input(TeamIn, arg_name="body")
def create_team(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return svc.team_dict(guard(svc.create_team, g.org, body["name"], body["description"], body["color"])), 201


@bp.get("/teams/<team_id>")
@require("teams.view")
def get_team(team_id: str) -> dict[str, Any]:
    return svc.team_dict(get_scoped(Team, team_id))


@bp.patch("/teams/<team_id>")
@require("teams.manage")
@bp.input(TeamPatch, arg_name="body")
def patch_team(team_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return svc.team_dict(guard(svc.update_team, g.org, get_scoped(Team, team_id), body))


@bp.delete("/teams/<team_id>")
@require("teams.manage")
def delete_team(team_id: str) -> tuple[str, int]:
    svc.delete_team(g.org, get_scoped(Team, team_id))
    return "", 204


@bp.post("/teams/<team_id>/members")
@require("teams.manage")
@bp.input(TeamMemberIn, arg_name="body")
def add_member(team_id: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        uid = uuid.UUID(body["user_id"])
    except ValueError:
        abort(404)
    return svc.team_dict(guard(svc.add_team_member, g.org, get_scoped(Team, team_id), uid))


@bp.delete("/teams/<team_id>/members/<user_id>")
@require("teams.manage")
def remove_member(team_id: str, user_id: str) -> dict[str, Any]:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        abort(404)
    return svc.team_dict(svc.remove_team_member(g.org, get_scoped(Team, team_id), uid))


# ---- search providers ------------------------------------------------------------------------
@provider("people", "People", "users.view")
def _search_people(q: str, limit: int) -> list[dict[str, Any]]:
    query = svc.members_query(g.org.id).where(
        or_(func.lower(User.name).like(like(q), escape="\\"), func.lower(User.email).like(like(q), escape="\\"))
    )
    ms = db.session.scalars(query.order_by(func.lower(User.name)).limit(limit)).all()
    return [
        {
            "id": str(m.user_id),
            "title": m.user.name,
            "subtitle": f"{ROLES[m.role]['label']} · {m.user.email}",
            "url": f"/people/users/{m.user_id}",
            "initials": m.user.initials,
        }
        for m in ms
    ]


@provider("teams", "Teams", "teams.view")
def _search_teams(q: str, limit: int) -> list[dict[str, Any]]:
    ts = db.session.scalars(
        scoped(Team)
        .where(func.lower(Team.name).like(like(q), escape="\\"))
        .order_by(func.lower(Team.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(t.id),
            "title": t.name,
            "subtitle": f"{len(t.members)} members",
            "url": f"/people/teams/{t.id}",
            "color": t.color,
        }
        for t in ts
    ]


_ = select  # keep import for type checkers
