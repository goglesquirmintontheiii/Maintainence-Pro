"""Background jobs without Redis (guideline G-02).

Jobs live in a database table. Workers claim them with `SELECT ... FOR UPDATE SKIP LOCKED`
on PostgreSQL (safe with many workers) or an atomic UPDATE on SQLite (single worker).
Failed jobs retry with exponential back-off. Periodic tasks run from a small scheduler.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from flask import Flask, current_app
from sqlalchemy import JSON, Integer, String, Text, Uuid, select, update
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db

log = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], Any]
_handlers: dict[str, Handler] = {}


class Job(IdMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "jobs"

    org_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(80), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)  # queued|running|done|failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    run_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    locked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    locked_by: Mapped[str] = mapped_column(String(120), default="")
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "kind": self.kind,
            "status": self.status,
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "run_at": iso(self.run_at),
            "created_at": iso(self.created_at),
            "finished_at": iso(self.finished_at),
            "last_error": self.last_error[-2000:],
            "locked_by": self.locked_by,
        }


def job(kind: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        _handlers[kind] = fn
        return fn

    return deco


def enqueue(
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    org_id: uuid.UUID | None = None,
    delay: timedelta | None = None,
    max_attempts: int = 5,
) -> Job:
    """Add a job in the current transaction. With MPRO_INLINE_JOBS it runs right after commit (tests)."""
    if kind not in _handlers:
        raise KeyError(f"Unknown job kind: {kind}")
    j = Job(
        kind=kind,
        payload=payload or {},
        org_id=org_id,
        max_attempts=max_attempts,
        run_at=utcnow() + (delay or timedelta()),
    )
    db.session.add(j)
    return j


def worker_name() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{threading.get_ident() % 10000}"


def claim_next(name: str) -> Job | None:
    now = utcnow()
    if db.engine.dialect.name == "postgresql":
        q = (
            select(Job)
            .where(Job.status == "queued", Job.run_at <= now)
            .order_by(Job.run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        j = db.session.scalars(q).first()
        if not j:
            db.session.rollback()
            return None
        j.status, j.locked_at, j.locked_by = "running", now, name
        j.attempts += 1
        db.session.commit()
        return j
    # SQLite: atomic compare-and-set on a candidate row
    cand = db.session.scalars(
        select(Job.id).where(Job.status == "queued", Job.run_at <= now).order_by(Job.run_at).limit(1)
    ).first()
    if not cand:
        db.session.rollback()
        return None
    res = db.session.execute(
        update(Job)
        .where(Job.id == cand, Job.status == "queued")
        .values(status="running", locked_at=now, locked_by=name, attempts=Job.attempts + 1)
    )
    db.session.commit()
    if res.rowcount != 1:  # type: ignore[attr-defined]
        return None
    return db.session.get(Job, cand)


def run_job(j: Job) -> None:
    handler = _handlers.get(j.kind)
    try:
        if handler is None:
            raise KeyError(f"No handler for job kind {j.kind!r}")
        handler(dict(j.payload or {}))
        j.status, j.finished_at, j.last_error = "done", utcnow(), ""
    except Exception:
        db.session.rollback()
        j = db.session.get(Job, j.id) or j
        j.last_error = traceback.format_exc()[-4000:]
        if j.attempts >= j.max_attempts:
            j.status, j.finished_at = "failed", utcnow()
        else:
            j.status = "queued"
            j.run_at = utcnow() + timedelta(seconds=min(3600, 2**j.attempts * 5))
        log.warning("Job %s (%s) failed, attempt %s", j.id, j.kind, j.attempts)
    db.session.commit()


def run_pending(name: str | None = None, max_jobs: int = 100) -> int:
    """Run queued jobs until none are due. Returns how many ran."""
    name = name or worker_name()
    n = 0
    while n < max_jobs:
        j = claim_next(name)
        if not j:
            break
        run_job(j)
        n += 1
    return n


@dataclass
class Periodic:
    kind: str
    every: timedelta
    payload: dict[str, Any]


PERIODIC: list[Periodic] = []


def periodic(kind: str, every: timedelta, payload: dict[str, Any] | None = None) -> None:
    PERIODIC.append(Periodic(kind, every, payload or {}))


def schedule_due(last_run: dict[str, float]) -> None:
    """Enqueue periodic jobs that are due and not already queued."""
    now = time.monotonic()
    for p in PERIODIC:
        if now - last_run.get(p.kind, 0.0) >= p.every.total_seconds():
            exists = db.session.scalars(
                select(Job.id).where(Job.kind == p.kind, Job.status.in_(["queued", "running"]))
            ).first()
            if not exists:
                enqueue(p.kind, p.payload, max_attempts=1)
                db.session.commit()
            last_run[p.kind] = now


def requeue_stuck(minutes: int = 15) -> int:
    cutoff = utcnow() - timedelta(minutes=minutes)
    res = db.session.execute(update(Job).where(Job.status == "running", Job.locked_at < cutoff).values(status="queued"))
    db.session.commit()
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


def worker_loop(app: Flask, stop: threading.Event | None = None, poll: float = 1.0) -> None:
    """Run jobs and the periodic scheduler until `stop` is set."""
    stop = stop or threading.Event()
    name = worker_name()
    last: dict[str, float] = {}
    log.info("Worker %s started", name)
    with app.app_context():
        requeue_stuck()
        while not stop.is_set():
            try:
                schedule_due(last)
                ran = run_pending(name)
            except Exception:
                log.exception("Worker loop error")
                db.session.rollback()
                ran = 0
            finally:
                db.session.remove()
            if not ran:
                stop.wait(poll)


def start_background_worker(app: Flask) -> threading.Event:
    """In-process worker thread (self-hosted test builds and dev)."""
    stop = threading.Event()
    t = threading.Thread(target=worker_loop, args=(app, stop), name="mpro-worker", daemon=True)
    t.start()
    return stop


def inline_after_commit() -> None:
    if current_app.config.get("MPRO_INLINE_JOBS"):
        run_pending()


# ---- built-in jobs -------------------------------------------------------------------------
@job("process_outbox")
def _process_outbox(_: dict[str, Any]) -> None:
    from mpro.core.events import process_outbox

    while process_outbox() >= 200:
        pass


@job("cleanup")
def _cleanup(_: dict[str, Any]) -> None:
    from sqlalchemy import delete

    from mpro.auth.models import LoginAttempt

    db.session.execute(delete(LoginAttempt).where(LoginAttempt.at < utcnow() - timedelta(days=7)))
    db.session.execute(delete(Job).where(Job.status == "done", Job.finished_at < utcnow() - timedelta(days=14)))
    db.session.commit()


periodic("process_outbox", timedelta(seconds=5))
periodic("cleanup", timedelta(hours=6))
