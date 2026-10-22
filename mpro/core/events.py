"""Domain events + transactional outbox (guideline G-05).

Every write records an event in the same transaction. The events table doubles as the
org-wide audit log (who, what, when, old -> new). A background job dispatches unprocessed
events to registered consumers (notifications, webhooks, search, sync in later phases).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from flask import current_app, g, has_request_context, request
from sqlalchemy import JSON, String, Uuid, select
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db

log = logging.getLogger(__name__)


class DomainEvent(IdMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "domain_events"

    org_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True, nullable=True)
    type: Mapped[str] = mapped_column(String(80), index=True)  # e.g. "user.role_changed"
    entity_type: Mapped[str] = mapped_column(String(40), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    entity_label: Mapped[str] = mapped_column(String(300), default="")
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    actor_label: Mapped[str] = mapped_column(String(300), default="")
    summary: Mapped[str] = mapped_column(String(500), default="")
    changes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # field -> [old, new]
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")
    region: Mapped[str] = mapped_column(String(32), default="local")
    node_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "type": self.type,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "entity_label": self.entity_label,
            "actor_id": str(self.actor_id) if self.actor_id else None,
            "actor_label": self.actor_label,
            "summary": self.summary,
            "changes": self.changes or {},
            "data": self.data or {},
            "ip": self.ip,
            "created_at": iso(self.created_at),
        }


def _jsonable(v: Any) -> Any:
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return iso(v)
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return format(v.normalize(), "f")
    if isinstance(v, list | tuple):
        return [_jsonable(x) for x in v]
    return v


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, list[Any]]:
    """Field-level changes, for the audit log."""
    return {k: [_jsonable(before.get(k)), _jsonable(after.get(k))] for k in after if before.get(k) != after.get(k)}


def emit(
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
    """Record a domain event in the current transaction (caller commits)."""
    if org_id is None and has_request_context() and getattr(g, "org", None) is not None:
        org_id = g.org.id
    if actor is None and has_request_context():
        actor = getattr(g, "user", None)
    ev = DomainEvent(
        org_id=org_id,
        type=type,
        entity_type=entity_type,
        entity_id=str(entity_id),
        entity_label=entity_label[:300],
        actor_id=getattr(actor, "id", None),
        actor_label=(getattr(actor, "name", "") or "System")[:300],
        summary=summary[:500],
        changes={k: [_jsonable(a), _jsonable(b)] for k, (a, b) in (changes or {}).items()},
        data={k: _jsonable(v) for k, v in (data or {}).items()},
        ip=(
            request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()[:64]
            if has_request_context()
            else ""
        ),
        region=current_app.config.get("MPRO_REGION", "local"),
        node_id=current_app.config.get("MPRO_NODE_ID", ""),
    )
    db.session.add(ev)
    return ev


Consumer = Callable[[DomainEvent], None]
_consumers: list[tuple[str, Consumer]] = []


def consumer(prefix: str = "") -> Callable[[Consumer], Consumer]:
    """Register a consumer for events whose type starts with `prefix`."""

    def deco(fn: Consumer) -> Consumer:
        _consumers.append((prefix, fn))
        return fn

    return deco


def process_outbox(limit: int = 200) -> int:
    """Dispatch unprocessed events to consumers. Safe to run on several machines (row locks on PostgreSQL)."""
    q = select(DomainEvent).where(DomainEvent.processed_at.is_(None)).order_by(DomainEvent.id).limit(limit)
    if db.engine.dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=True)
    events: Iterable[DomainEvent] = db.session.scalars(q).all()
    n = 0
    for ev in events:
        for prefix, fn in _consumers:
            if ev.type.startswith(prefix):
                try:
                    fn(ev)
                except Exception:  # a broken consumer must never block the outbox
                    log.exception("Event consumer %s failed for %s", fn.__name__, ev.id)
        ev.processed_at = utcnow()
        n += 1
    db.session.commit()
    return n


@consumer("")
def _log_consumer(ev: DomainEvent) -> None:
    log.debug("event %s %s:%s", ev.type, ev.entity_type, ev.entity_id)
