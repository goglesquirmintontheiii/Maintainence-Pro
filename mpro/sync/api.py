"""Offline sync for the phone app: HTTP API (thin views over services).

    GET    /sync?cursor=&limit=     change feed: the cache set and what changed since the cursor (r270, r291)
    GET    /sync/items?ids=a,b      the work order screens' data for up to 25 work orders
    GET    /me/recent-activity      the phone Overview's Recent Activity (r290)
    GET    /me/account              can I delete my account? (r321)
    DELETE /me/account              {password, confirm: "DELETE"}

Every POST / PUT / PATCH / DELETE also accepts an `Idempotency-Key` header (mpro/sync/idempotency.py).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request
from flask_login import logout_user

from mpro.core.jobs import job, periodic
from mpro.core.tenancy import require
from mpro.orgs.services import RuleError
from mpro.sync import idempotency
from mpro.sync import services as svc

bp = APIBlueprint("sync", __name__, url_prefix="/api/v1", tag="Sync")


@bp.before_app_request
def _idempotency_before() -> Response | None:
    return idempotency.before()


@bp.after_app_request
def _idempotency_after(resp: Response) -> Response:
    return idempotency.after(resp)


def _guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except RuleError as e:
        from mpro.extensions import db

        db.session.rollback()
        abort(e.status, message=e.message)


def _int(name: str, default: int) -> int:
    try:
        return int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


@bp.get("/sync")
@require("wo.view")
def sync_feed() -> dict[str, Any]:
    """Send the `cursor` from the last reply; no cursor (or an old one) means start over (`full: true`)."""
    return svc.feed(g.membership, request.args.get("cursor"), _int("limit", svc.CACHE_LIMIT))


@bp.get("/sync/items")
@require("wo.view")
def sync_items() -> dict[str, Any]:
    ids = [x for x in (request.args.get("ids") or "").split(",") if x.strip()]
    return _guard(svc.items, g.membership, ids)


@bp.get("/me/recent-activity")
@require("wo.view")
def recent_activity() -> dict[str, Any]:
    return {"items": svc.recent_activity(g.membership, _int("limit", 20))}


def _signed_in() -> Any:
    if getattr(g, "user", None) is None:
        abort(401, message="Please sign in.")
    return g.user


@bp.get("/me/account")
def account_status() -> dict[str, Any]:
    user = _signed_in()
    blockers = svc.account_blockers(user)
    return {"can_delete": not blockers, "only_owner_of": blockers, "needs_password": bool(user.password_hash)}


@bp.delete("/me/account")
def delete_account() -> tuple[str, int]:
    user = _signed_in()
    b = request.get_json(silent=True) or {}
    if not isinstance(b, dict):
        abort(422, message="Send a JSON object.")
    _guard(svc.delete_account, user, str(b.get("password") or ""), str(b.get("confirm") or ""))
    logout_user()
    return "", 204


@job("sync.cleanup")
def _cleanup(_: dict[str, Any]) -> None:
    idempotency.cleanup()


periodic("sync.cleanup", timedelta(hours=24))
