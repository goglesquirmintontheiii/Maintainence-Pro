"""MPro Management: HTTP API for sysadmins (MP-136). Thin views over services.

Every endpoint checks that the signed-in person is a sysadmin, on the server, whatever the browser shows.
"""

from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar

from apiflask import APIBlueprint, abort
from flask import g, request

from mpro.sysadmin import services as svc
from mpro.sysadmin.models import SERVICES

bp = APIBlueprint("sysadmin", __name__, url_prefix="/api/v1/sysadmin", tag="MPro Management")

F = TypeVar("F", bound=Callable[..., Any])


def sysadmin_only(fn: F) -> F:
    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        user = getattr(g, "user", None)
        if user is None:
            abort(401, message="Please sign in.")
        if not user.is_sysadmin or not user.is_active:
            abort(403, message="Only MPro sysadmins can open MPro Management.")
        try:
            return fn(*args, **kwargs)
        except svc.SysadminError as e:
            abort(e.status, message=e.message)

    return wrapper  # type: ignore[return-value]


def _body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(422, message="Send the changes as a JSON object.")
    return data


def _page() -> tuple[str, int, int]:
    try:
        page = int(request.args.get("page", 1))
        per = int(request.args.get("per_page", 25))
    except ValueError:
        abort(422, message="page and per_page must be numbers.")
    return (request.args.get("q") or "")[:200], page, per


# ---- overview, audit -------------------------------------------------------------------------
@bp.get("/overview")
@sysadmin_only
def overview() -> dict[str, Any]:
    return svc.overview()


@bp.get("/audit")
@sysadmin_only
def audit() -> dict[str, Any]:
    return svc.server_audit(request.args.get("q") or "", request.args.get("cursor"))


# ---- server settings ---------------------------------------------------------------------------
@bp.get("/server-settings")
@sysadmin_only
def get_settings() -> dict[str, Any]:
    return svc.server_settings()


@bp.patch("/server-settings")
@sysadmin_only
def patch_settings() -> dict[str, Any]:
    return svc.save_server_settings(g.user, _body())


# ---- API keys ----------------------------------------------------------------------------------
@bp.get("/api-keys")
@sysadmin_only
def keys() -> dict[str, Any]:
    return {"items": svc.list_keys(), "services": [{"key": k, "label": v} for k, v in SERVICES.items()]}


@bp.post("/api-keys")
@sysadmin_only
def create_key() -> tuple[dict[str, Any], int]:
    return svc.key_dict(svc.create_key(g.user, _body())), 201


@bp.patch("/api-keys/<key_id>")
@sysadmin_only
def patch_key(key_id: str) -> dict[str, Any]:
    return svc.key_dict(svc.update_key(g.user, svc.get_key(key_id), _body()))


@bp.delete("/api-keys/<key_id>")
@sysadmin_only
def delete_key(key_id: str) -> tuple[str, int]:
    svc.delete_key(g.user, svc.get_key(key_id))
    return "", 204


# ---- users ----------------------------------------------------------------------------------
@bp.get("/users")
@sysadmin_only
def users() -> dict[str, Any]:
    q, page, per = _page()
    return svc.search_users(q, page, per, request.args.get("filter") or "")


@bp.get("/users/<user_id>")
@sysadmin_only
def user(user_id: str) -> dict[str, Any]:
    return svc.user_detail(svc.get_user(user_id))


@bp.patch("/users/<user_id>")
@sysadmin_only
def patch_user(user_id: str) -> dict[str, Any]:
    return svc.user_detail(svc.update_user(g.user, svc.get_user(user_id), _body()))


@bp.post("/users/<user_id>/reset-password")
@sysadmin_only
def reset_password(user_id: str) -> dict[str, Any]:
    return svc.reset_password(g.user, svc.get_user(user_id), _body())


# ---- organizations --------------------------------------------------------------------------
@bp.get("/orgs")
@sysadmin_only
def orgs() -> dict[str, Any]:
    q, page, per = _page()
    return {
        **svc.search_orgs(q, page, per, include_deleted=request.args.get("deleted") == "1"),
        "plans_apply": svc.plans_apply(),
    }


@bp.get("/orgs/<org_id>")
@sysadmin_only
def org(org_id: str) -> dict[str, Any]:
    return {**svc.org_detail(svc.get_org(org_id, include_deleted=True)), "plans_apply": svc.plans_apply()}


@bp.patch("/orgs/<org_id>")
@sysadmin_only
def patch_org(org_id: str) -> dict[str, Any]:
    return svc.org_detail(svc.update_org(g.user, svc.get_org(org_id), _body()))


@bp.post("/orgs/<org_id>/members")
@sysadmin_only
def add_member(org_id: str) -> tuple[dict[str, Any], int]:
    o = svc.get_org(org_id)
    svc.add_member(g.user, o, _body())
    return svc.org_detail(o), 201


@bp.patch("/orgs/<org_id>/members/<user_id>")
@sysadmin_only
def patch_member(org_id: str, user_id: str) -> dict[str, Any]:
    o = svc.get_org(org_id)
    svc.change_member_role(g.user, o, user_id, _body().get("role"))
    return svc.org_detail(o)


@bp.delete("/orgs/<org_id>/members/<user_id>")
@sysadmin_only
def remove_member(org_id: str, user_id: str) -> dict[str, Any]:
    o = svc.get_org(org_id)
    svc.remove_member(g.user, o, user_id)
    return svc.org_detail(o)


@bp.post("/orgs/<org_id>/delete")
@sysadmin_only
def delete_org(org_id: str) -> dict[str, Any]:
    o = svc.get_org(org_id)
    svc.delete_org(g.user, o, _body())
    return svc.org_row(o)


@bp.post("/orgs/<org_id>/restore")
@sysadmin_only
def restore_org(org_id: str) -> dict[str, Any]:
    return svc.org_row(svc.restore_org(g.user, svc.get_org(org_id, include_deleted=True)))
