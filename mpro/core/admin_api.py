"""Admin endpoints: audit log, background jobs, email outbox, global search, health."""

from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, current_app, g, request
from sqlalchemy import func, or_, select, text

from mpro import __version__
from mpro.core.events import DomainEvent
from mpro.core.jobs import Job
from mpro.core.mail import OutboundEmail
from mpro.core.search import like, search
from mpro.core.tenancy import require
from mpro.extensions import db

bp = APIBlueprint("admin", __name__, url_prefix="/api/v1", tag="Admin")


def _limit(default: int = 50, maximum: int = 200) -> int:
    try:
        return max(1, min(maximum, int(request.args.get("limit", default))))
    except ValueError:
        return default


def _parse_dt(name: str) -> datetime | None:
    v = request.args.get(name)
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        abort(422, message=f"{name} must be an ISO date like 2026-10-21.")
    if d.tzinfo is None:
        from datetime import UTC

        d = d.replace(tzinfo=UTC)
    return d


def audit_query() -> Any:
    q = select(DomainEvent).where(DomainEvent.org_id == g.org.id)
    if et := request.args.get("entity_type"):
        q = q.where(DomainEvent.entity_type == et)
    if eid := request.args.get("entity_id"):
        q = q.where(DomainEvent.entity_id == eid)
    if actor := request.args.get("actor_id"):
        try:
            q = q.where(DomainEvent.actor_id == uuid.UUID(actor))
        except ValueError:
            abort(422, message="actor_id isn't valid.")
    if s := (request.args.get("q") or "").strip():
        q = q.where(
            or_(
                func.lower(DomainEvent.summary).like(like(s), escape="\\"),
                func.lower(DomainEvent.entity_label).like(like(s), escape="\\"),
                func.lower(DomainEvent.actor_label).like(like(s), escape="\\"),
                func.lower(DomainEvent.type).like(like(s), escape="\\"),
            )
        )
    if (frm := _parse_dt("from")) is not None:
        q = q.where(DomainEvent.created_at >= frm)
    if (to := _parse_dt("to")) is not None:
        q = q.where(DomainEvent.created_at <= to)
    return q


@bp.get("/audit")
@require("audit.view")
def audit() -> dict[str, Any]:
    """Org-wide audit trail, newest first. Cursor-paginated (pass `cursor` = last id)."""
    q = audit_query()
    if cur := request.args.get("cursor"):
        try:
            q = q.where(DomainEvent.id < uuid.UUID(cur))
        except ValueError:
            abort(422, message="cursor isn't valid.")
    lim = _limit()
    rows = db.session.scalars(q.order_by(DomainEvent.id.desc()).limit(lim + 1)).all()
    more = len(rows) > lim
    rows = rows[:lim]
    types = db.session.scalars(select(DomainEvent.entity_type).where(DomainEvent.org_id == g.org.id).distinct()).all()
    return {
        "items": [r.to_dict() for r in rows],
        "next_cursor": str(rows[-1].id) if more and rows else None,
        "entity_types": sorted(types),
    }


@bp.get("/audit/export.csv")
@require("audit.view")
def audit_csv() -> Response:
    rows = db.session.scalars(audit_query().order_by(DomainEvent.id.desc()).limit(50000)).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["when_utc", "who", "action", "record_type", "record", "summary", "changes", "ip"])
    for r in rows:
        changes = "; ".join(f"{k}: {v[0]!r} -> {v[1]!r}" for k, v in (r.changes or {}).items())
        w.writerow(
            [r.to_dict()["created_at"], r.actor_label, r.type, r.entity_type, r.entity_label, r.summary, changes, r.ip]
        )
    return Response(
        buf.getvalue(), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=mpro-audit-log.csv"}
    )


@bp.get("/jobs")
@require("jobs.view")
def jobs() -> dict[str, Any]:
    q = select(Job).where(or_(Job.org_id == g.org.id, Job.org_id.is_(None)))
    if st := request.args.get("status"):
        q = q.where(Job.status == st)
    rows = db.session.scalars(q.order_by(Job.created_at.desc()).limit(_limit(100))).all()
    counts = dict(db.session.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    return {"items": [j.to_dict() for j in rows], "counts": {k: int(v) for k, v in counts.items()}}


@bp.post("/jobs/<job_id>/retry")
@require("jobs.manage")
def retry_job(job_id: str) -> dict[str, Any]:
    try:
        j = db.session.get(Job, uuid.UUID(job_id))
    except ValueError:
        abort(404)
    if j is None or (j.org_id not in (None, g.org.id)):
        abort(404)
    if j.status != "failed":
        abort(409, message="Only failed jobs can be retried.")
    j.status, j.attempts, j.last_error, j.finished_at = "queued", 0, "", None
    from mpro.core.models import utcnow

    j.run_at = utcnow()
    db.session.commit()
    return j.to_dict()


@bp.get("/outbox")
@require("mail.view")
def outbox() -> dict[str, Any]:

    # Only this organization's own email. Personal emails without an organization (password resets) aren't listed,
    # and links that work without signing in (reset, invite, request status, vendor PO, shared work orders,
    # quotes) are hidden: reading them would let an admin act as the recipient (0.6.0 review #1).
    q = select(OutboundEmail).where(OutboundEmail.org_id == g.org.id)
    rows = db.session.scalars(q.order_by(OutboundEmail.created_at.desc()).limit(_limit(50))).all()
    items = []
    for m in rows:
        d = m.to_dict()
        d["body"] = redact_links(d["body"])
        items.append(d)
    return {"items": items, "smtp_configured": bool(current_app.config.get("MAIL_SERVER"))}


@bp.get("/search")
@require("search.use")
def global_search() -> dict[str, Any]:
    q = request.args.get("q", "")
    types = [t for t in (request.args.get("types") or "").split(",") if t] or None
    return {"q": q, "groups": search(q, types, limit=_limit(8, 25))}


@bp.get("/meta")
def meta() -> dict[str, Any]:
    cfg = current_app.config
    return {
        "name": "Maintenance Pro",
        "version": __version__,
        "edition": cfg["MPRO_EDITION"],
        "region": cfg["MPRO_REGION"],
        "node": cfg["MPRO_NODE_ID"],
        "database": db.engine.dialect.name,
    }


health_bp = APIBlueprint("health", __name__, tag="Health")


@health_bp.get("/healthz")
def healthz() -> tuple[dict[str, Any], int]:
    try:
        db.session.execute(text("SELECT 1"))
        return {"status": "ok", "version": __version__, "database": "ok"}, 200
    except Exception as e:  # pragma: no cover
        return {"status": "error", "database": str(e)[:200]}, 503


_TOKEN_LINK = re.compile(r"(/(?:reset-password|request-status|v|x|quote)/)[^\s\"'<>)\]]+")


def redact_links(text: str) -> str:
    """Replace the secret part of sign-in-free links with "[Link hidden]"."""
    return _TOKEN_LINK.sub(r"\1[Link hidden]", text or "")
