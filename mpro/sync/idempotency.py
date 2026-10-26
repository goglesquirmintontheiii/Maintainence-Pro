"""`Idempotency-Key` for every change sent to the API (r270, guideline G-06).

The phone app sends each queued offline change with a key. If the same person sends the same key again (the reply
was lost, the app restarted mid-sync), the stored reply comes back with `Idempotent-Replay: true` and nothing runs a
second time. Works for every POST / PUT / PATCH / DELETE under /api/v1 without changes to the endpoints.

Limits: replies larger than `MAX_STORED` aren't stored (a repeat runs again); if the server stops halfway through a
request, the key frees up after `STALE` and a repeat runs again.
"""

from __future__ import annotations

import json
import re
from datetime import timedelta
from typing import Any

from flask import Response, g, request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.sync.models import IdempotentRequest

HEADER = "Idempotency-Key"
KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,100}$")
STALE = timedelta(minutes=2)
KEEP = timedelta(days=14)
MAX_STORED = 512 * 1024
_NOT_STORED = {401, 429}


def _json(message: str, status: int) -> Response:
    return Response(json.dumps({"message": message, "status": status}), status=status, mimetype="application/json")


def before() -> Response | None:
    key = request.headers.get(HEADER)
    if not key or request.method in ("GET", "HEAD", "OPTIONS") or not request.path.startswith("/api/v1/"):
        return None
    user = getattr(g, "user", None)
    if user is None:
        return None  # the endpoint answers 401 itself
    if not KEY_RE.match(key):
        return _json("The Idempotency-Key must be 8 to 100 letters, digits or - _ . :", 422)
    path = request.full_path.rstrip("?")[:500]
    row = db.session.scalars(
        select(IdempotentRequest).where(IdempotentRequest.user_id == user.id, IdempotentRequest.key == key)
    ).first()
    if row is not None:
        if row.method != request.method or row.path != path:
            return _json("This change key was already used for a different change.", 422)
        if row.status_code:
            resp = Response(
                json.dumps(row.response) if row.response is not None else "",
                status=row.status_code,
                mimetype="application/json",
            )
            resp.headers["Idempotent-Replay"] = "true"
            return resp
        if utcnow() - row.created_at < STALE:
            return _json("This change is still being saved. Try again in a moment.", 409)
        db.session.delete(row)  # the first try never finished: let this one run
        db.session.commit()
    org = getattr(g, "org", None)
    row = IdempotentRequest(
        org_id=org.id if org is not None else None,
        user_id=user.id,
        key=key,
        method=request.method,
        path=path,
        status_code=0,
    )
    db.session.add(row)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _json("This change is still being saved. Try again in a moment.", 409)
    g.idempotency_id = row.id
    return None


def after(resp: Response) -> Response:
    rid = getattr(g, "idempotency_id", None)
    if rid is None or request.headers.get("Idempotent-Replay"):
        return resp
    g.idempotency_id = None
    # Anything the endpoint left uncommitted is thrown away at the end of the request anyway.
    db.session.rollback()
    row = db.session.get(IdempotentRequest, rid)
    if row is None:
        return resp
    stored: Any = None
    keep = resp.status_code < 500 and resp.status_code not in _NOT_STORED and not resp.is_streamed
    if keep:
        data = resp.get_data()
        if len(data) > MAX_STORED:
            keep = False
        elif data:
            try:
                stored = json.loads(data)
            except ValueError:
                keep = False
    if keep:
        row.status_code = resp.status_code
        row.response = stored
        row.finished_at = utcnow()
    else:
        db.session.delete(row)  # a repeat should run again
    db.session.commit()
    return resp


def cleanup() -> int:
    """Forget keys older than KEEP (called by the daily cleanup job)."""
    old = db.session.scalars(
        select(IdempotentRequest).where(IdempotentRequest.created_at < utcnow() - KEEP).limit(5000)
    ).all()
    for r in old:
        db.session.delete(r)
    db.session.commit()
    return len(old)
