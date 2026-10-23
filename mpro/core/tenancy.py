"""Tenant scoping (guideline G-15). Every query on tenant data goes through `scoped()`."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar, cast

from apiflask import abort
from flask import g, has_request_context
from sqlalchemy import Select, select

from mpro.core.permissions import OWN_ACTIONS, can, is_own
from mpro.extensions import db

M = TypeVar("M")
F = TypeVar("F", bound=Callable[..., Any])


def current_org_id() -> uuid.UUID:
    org = getattr(g, "org", None)
    if org is None:
        abort(403, message="No organization selected.")
    return cast(uuid.UUID, org.id)


def scoped(model: type[M], include_deleted: bool = False) -> Select[Any]:
    """SELECT limited to the current organization (and not soft-deleted)."""
    q = select(model).where(model.org_id == current_org_id())  # type: ignore[attr-defined]
    if not include_deleted and hasattr(model, "deleted_at"):
        q = q.where(model.deleted_at.is_(None))  # type: ignore[attr-defined]
    return q


def get_scoped(model: type[M], id_: str | uuid.UUID) -> M:
    """Fetch one record of the current org or 404 (never reveals other orgs' records)."""
    try:
        uid = id_ if isinstance(id_, uuid.UUID) else uuid.UUID(str(id_))
    except ValueError:
        abort(404)
    obj = db.session.scalars(scoped(model).where(model.id == uid)).first()  # type: ignore[attr-defined]
    if obj is None:
        abort(404)
    enforce_own_scope(obj)
    return cast(M, obj)


# Own vs any (MP-130): which records an "own only" permission limits, by table.
OWN_TABLES = {
    "wo.edit": "work_orders",
    "wo.delete": "work_orders",
    "assets.manage": "assets",
    "procedures.manage": "procedures",
    "po.manage": "purchase_orders",
}
_OWN_MESSAGES = {
    "work_orders": "You can only change work orders you created or that are assigned to you.",
    "assets": "You can only change assets you created or that your team is in charge of.",
    "procedures": "You can only change procedures you created.",
    "purchase_orders": "You can only change purchase orders you created or requested.",
}


def enforce_own_scope(obj: Any) -> None:
    """When the endpoint was entered with an "own only" permission (see `require`), the record it loads must be the
    member's own. `get_scoped` calls this; modules with their own loaders call it too."""
    if not has_request_context():
        return
    scope: dict[str, str] = getattr(g, "own_scope", None) or {}
    table = getattr(obj, "__tablename__", "")
    if table in scope and not is_own(getattr(g, "membership", None), obj):
        abort(403, message=_OWN_MESSAGES.get(table, "You can only change your own records."))


def require(action: str) -> Callable[[F], F]:
    """Endpoint decorator: signed in, member of the current org, and allowed to do `action`."""

    def deco(fn: F) -> F:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if getattr(g, "user", None) is None:
                abort(401, message="Please sign in.")
            m = getattr(g, "membership", None)
            if not can(m, action):
                own = OWN_ACTIONS.get(action)
                if own is None or not can(m, own):
                    abort(403, message="You don't have permission to do that.")
                # only their own records: loaders check each record they fetch (enforce_own_scope)
                g.own_scope = {**(getattr(g, "own_scope", None) or {}), OWN_TABLES[action]: action}
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return deco
