"""Tenant scoping (guideline G-15). Every query on tenant data goes through `scoped()`."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar, cast

from apiflask import abort
from flask import g
from sqlalchemy import Select, select

from mpro.core.permissions import can
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
    return cast(M, obj)


def require(action: str) -> Callable[[F], F]:
    """Endpoint decorator: signed in, member of the current org, and allowed to do `action`."""

    def deco(fn: F) -> F:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if getattr(g, "user", None) is None:
                abort(401, message="Please sign in.")
            if not can(getattr(g, "membership", None), action):
                abort(403, message="You don't have permission to do that.")
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return deco
