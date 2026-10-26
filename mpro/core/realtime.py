"""Realtime push to open browsers (0.6.0, r269). Owned by the messaging workstream (F2).

Contract used by every module:

    publish(org_id, topic, payload, user_ids=None)

`topic` is a string such as "wo:<id>", "conv:<id>", "user:<id>", "requests" or "org:<entity_type>". Only signed-in
members of `org_id` who may see the topic receive it; `user_ids` narrows it further. Publishing never raises: the row
rides along with the caller's transaction and goes out when it commits (or at the end of the request when nothing
else is pending). Payloads carry ids and event types only; browsers refetch through the normal API, which checks
permissions again.

How it works (G-02: one machine, PostgreSQL or SQLite, no Redis):

- Every domain event of a watched entity type (`ENTITY_TOPICS`), and every `publish()` call, adds a row to
  `realtime_events` in the same transaction (a `before_flush` / `before_commit` listener).
- One broker thread per server process polls that table (every 0.5 s while someone is connected, immediately after a
  local commit), and hands new rows to the open streams of that organization. Several processes or machines all read
  the same table, so it works under gunicorn too.
- Browsers hold one Server-Sent Events stream per tab (`/api/v1/realtime/stream`), shared by every subscription; the
  stream authorizes each row for its viewer. Waitress gives each open stream a thread, so streams are capped
  (`MPRO_REALTIME_MAX_STREAMS`, default 16 per process; `mpro serve` runs 32 threads); beyond that, or when a
  proxy breaks streaming, the browser polls `/api/v1/realtime/poll` every few seconds instead.
- Rows older than an hour are deleted by a periodic job.
"""

from __future__ import annotations

import logging
import queue
import threading
import uuid
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta
from typing import Any

from flask import Flask
from sqlalchemy import JSON, String, Uuid, and_, delete, event, or_, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from mpro.core.models import IdMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db

log = logging.getLogger(__name__)


class RealtimeEvent(IdMixin, db.Model):  # type: ignore[name-defined]
    """A short-lived fan-out row. Not domain data: pruned after an hour."""

    __tablename__ = "realtime_events"

    org_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True, nullable=True)
    topic: Mapped[str] = mapped_column(String(120), index=True)
    type: Mapped[str] = mapped_column(String(80), default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    user_ids: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)  # None = everyone allowed on the topic
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True, default=utcnow)


def row_dict(r: RealtimeEvent) -> dict[str, Any]:
    return {"id": str(r.id), "topic": r.topic, "type": r.type, "data": r.data or {}, "at": iso(r.at)}


# ---- publishing ------------------------------------------------------------------------------------
_BUFFER_KEY = "mpro_realtime_buffer"


def publish(
    org_id: uuid.UUID | None, topic: str, payload: dict[str, Any], user_ids: Iterable[uuid.UUID] | None = None
) -> None:
    """Queue a push for `topic`. It's written with the current transaction's commit (see module docstring)."""
    try:
        data = dict(payload)
        typ = str(data.pop("type", "") or "update")[:80]
        row = {
            "org_id": org_id,
            "topic": topic[:120],
            "type": typ,
            "data": _jsonable(data),
            "user_ids": [str(u) for u in user_ids] if user_ids is not None else None,
        }
        db.session.info.setdefault(_BUFFER_KEY, []).append(row)
    except Exception:  # pragma: no cover - publishing must never break the caller
        log.exception("realtime publish failed")


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, list | tuple | set):
        return [_jsonable(x) for x in v]
    if isinstance(v, uuid.UUID | datetime):
        return str(v)
    if v is None or isinstance(v, bool | int | float | str):
        return v
    return str(v)


# entity_type of a domain event -> topic builder. Watched entities get pushed automatically from their events.
TopicFn = Callable[[Any], list[str]]
ENTITY_TOPICS: dict[str, TopicFn] = {
    "work_order": lambda ev: [f"wo:{ev.entity_id}", "org:work_order"],
    "asset": lambda ev: [f"org:asset:{ev.entity_id}", "org:asset"],
    "location": lambda ev: ["org:location"],
    "part": lambda ev: ["org:part"],
    "purchase_order": lambda ev: ["org:purchase_order"],
    "team": lambda ev: ["org:team"],
}


def watch_entity(entity_type: str, topics: TopicFn) -> None:
    """Push every domain event of `entity_type` to the topics `topics(event)` returns (other workstreams)."""
    ENTITY_TOPICS[entity_type] = topics


_ADDED_KEY = "mpro_realtime_added"  # (org_id, topic) -> the row already written in this transaction


def _collection_topic(topic: str) -> bool:
    """Topics about a whole list (org:work_order, requests…) rather than one record: a bulk edit needs one push."""
    return topic.count(":") <= 1 and not topic.startswith(("wo:", "conv:", "user:"))


def _drain(session: Session) -> None:
    from mpro.core.events import DomainEvent

    rows = session.info.pop(_BUFFER_KEY, None) or []
    added: dict[tuple[str, str], RealtimeEvent] = session.info.setdefault(_ADDED_KEY, {})
    derived: list[dict[str, Any]] = []
    for obj in list(session.new):
        if isinstance(obj, DomainEvent) and obj.org_id is not None and obj.entity_type in ENTITY_TOPICS:
            try:
                topics = ENTITY_TOPICS[obj.entity_type](obj)
            except Exception:  # pragma: no cover
                log.exception("realtime topic mapping failed for %s", obj.type)
                continue
            for t in topics:
                derived.append(
                    {
                        "org_id": obj.org_id,
                        "topic": t,
                        "type": obj.type,
                        "data": {"entity_type": obj.entity_type, "entity_id": str(obj.entity_id)},
                        "user_ids": None,
                    }
                )
    wrote = bool(rows)
    for r in rows:
        session.add(RealtimeEvent(**r))
    for r in derived:
        if _collection_topic(r["topic"]):
            key = (str(r["org_id"]), r["topic"])
            prev = added.get(key)
            if prev is not None:  # one push per list topic per transaction, however many records changed
                prev.data = {**(prev.data or {}), "count": int((prev.data or {}).get("count", 1)) + 1}
                continue
            row = RealtimeEvent(**r)
            added[key] = row
        else:
            row = RealtimeEvent(**r)
        session.add(row)
        wrote = True
    if wrote:
        session.info["mpro_realtime_nudge"] = True


@event.listens_for(Session, "before_flush")
def _before_flush(session: Session, _ctx: Any, _instances: Any) -> None:
    _drain(session)


@event.listens_for(Session, "before_commit")
def _before_commit(session: Session) -> None:
    if session.info.get(_BUFFER_KEY):
        _drain(session)


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    if session.in_transaction():  # a SAVEPOINT was released; the real commit comes later
        return
    session.info.pop(_ADDED_KEY, None)
    if session.info.pop("mpro_realtime_nudge", False):
        broker.wake.set()


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop(_BUFFER_KEY, None)
    session.info.pop(_ADDED_KEY, None)  # rows it held may be gone (even a SAVEPOINT rollback): start a new one
    session.info.pop("mpro_realtime_nudge", None)


def flush_pending() -> None:
    """End of a request: write publishes that came after the last commit (only when nothing else is pending)."""
    s = db.session
    if not s.info.get(_BUFFER_KEY):
        return
    if s.new or s.dirty or s.deleted:  # someone left changes uncommitted on purpose; don't commit them for them
        s.info.pop(_BUFFER_KEY, None)
        return
    try:
        s.commit()
    except Exception:  # pragma: no cover
        log.exception("realtime flush failed")
        s.rollback()


# ---- topic authorization ---------------------------------------------------------------------------
# prefix -> fn(membership, rest_of_topic) -> bool. The longest matching prefix wins.
Authorizer = Callable[[Any, str], bool]
_authorizers: dict[str, Authorizer] = {}


def register_topic(prefix: str, fn: Authorizer) -> None:
    _authorizers[prefix] = fn


def may_receive(m: Any, row: RealtimeEvent | dict[str, Any]) -> bool:
    """Can this membership see this row? Wrong org, wrong user, unknown topic → no."""
    get = row.get if isinstance(row, dict) else lambda k: getattr(row, k)
    if m is None or get("org_id") is None or str(get("org_id")) != str(m.org_id):
        return False
    uids = get("user_ids")
    if uids is not None and str(m.user_id) not in {str(u) for u in uids}:
        return False
    topic = str(get("topic"))
    best = max((p for p in _authorizers if topic.startswith(p)), key=len, default=None)
    if best is None:
        return uids is not None  # an explicitly addressed row on an unknown topic is fine
    try:
        return bool(_authorizers[best](m, topic[len(best) :]))
    except Exception:  # pragma: no cover
        log.exception("realtime authorizer %s failed", best)
        return False


def _auth_user(m: Any, rest: str) -> bool:
    return rest == str(m.user_id)


def _auth_wo(m: Any, rest: str) -> bool:
    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import can_see

    try:
        wo = db.session.get(WorkOrder, uuid.UUID(rest))
    except ValueError:
        return False
    return wo is not None and wo.org_id == m.org_id and can_see(m, wo)


def _perm(action: str) -> Authorizer:
    def fn(m: Any, _rest: str) -> bool:
        from mpro.core.permissions import can

        return can(m, action)

    return fn


register_topic("user:", _auth_user)
register_topic("wo:", _auth_wo)
register_topic("org:work_order", _perm("wo.view"))  # list refresh: ids only, the list API applies visibility
register_topic("org:asset", _perm("assets.view"))
register_topic("org:location", _perm("locations.view"))
register_topic("org:part", _perm("parts.view"))
register_topic("org:purchase_order", _perm("po.view"))
register_topic("org:team", _perm("teams.view"))
register_topic("org", _perm("org.view"))


# ---- reading -----------------------------------------------------------------------------------------
LOOKBACK = timedelta(seconds=3)  # rows can commit slightly out of order across processes


def rows_since(org_id: uuid.UUID, since: datetime, limit: int = 500) -> list[RealtimeEvent]:
    floor = max(since - LOOKBACK, utcnow() - timedelta(minutes=10))
    return list(
        db.session.scalars(
            select(RealtimeEvent)
            .where(RealtimeEvent.org_id == org_id, RealtimeEvent.at >= floor)
            .order_by(RealtimeEvent.at, RealtimeEvent.id)
            .limit(limit)
        )
    )


def prune(older_than: timedelta = timedelta(hours=1)) -> int:
    res = db.session.execute(delete(RealtimeEvent).where(RealtimeEvent.at < utcnow() - older_than))
    db.session.commit()
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


# ---- broker --------------------------------------------------------------------------------------------
class Subscription:
    def __init__(self, org_id: uuid.UUID, user_id: uuid.UUID | None = None) -> None:
        self.org_id = org_id
        self.user_id = user_id
        self.q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1000)
        self.overflow = False

    def put(self, row: dict[str, Any]) -> None:
        try:
            self.q.put_nowait(row)
        except queue.Full:
            self.overflow = True  # the stream tells the browser to refetch everything


class Broker:
    """One per process. Polls `realtime_events` while anyone is connected and fans rows out to streams."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subs: set[Subscription] = set()
        self.wake = threading.Event()
        self.thread: threading.Thread | None = None
        self.last_at: datetime | None = None
        self.seen: dict[str, datetime] = {}
        self.app: Flask | None = None
        self.generation = 0

    def subscribe(self, app: Flask, org_id: uuid.UUID) -> Subscription:
        sub = Subscription(org_id)
        with self.lock:
            self._add(app, sub)
        self.wake.set()
        return sub

    def try_subscribe(
        self, app: Flask, org_id: uuid.UUID, user_id: uuid.UUID, max_total: int, max_per_user: int
    ) -> Subscription | None:
        """Subscribe unless the process (or this person) already holds its share of streams. Checked and added under
        one lock, so parallel requests can't overshoot."""
        with self.lock:
            if len(self.subs) >= max_total or sum(1 for x in self.subs if x.user_id == user_id) >= max_per_user:
                return None
            sub = Subscription(org_id, user_id)
            self._add(app, sub)
        self.wake.set()
        return sub

    def _add(self, app: Flask, sub: Subscription) -> None:
        """Caller holds self.lock."""
        self.subs.add(sub)
        if self.thread is None or not self.thread.is_alive() or self.app is not app:
            self.app = app  # a new app (tests) gets its own poller; the old thread notices and stops
            self.generation += 1
            self.thread = threading.Thread(
                target=self._run, args=(app, self.generation), name="mpro-realtime", daemon=True
            )
            self.thread.start()

    def unsubscribe(self, sub: Subscription) -> None:
        with self.lock:
            self.subs.discard(sub)

    def count(self) -> int:
        with self.lock:
            return len(self.subs)

    def _run(self, app: Flask, generation: int) -> None:
        with app.app_context():
            self.last_at = utcnow()
            while generation == self.generation:
                self.wake.wait(0.5)
                self.wake.clear()
                with self.lock:
                    subs = list(self.subs)
                if not subs:
                    self.last_at = utcnow()
                    self.seen.clear()
                    continue
                try:
                    self.poll_once(subs)
                except Exception:  # pragma: no cover - keep the thread alive
                    log.exception("realtime broker poll failed")
                finally:
                    db.session.remove()

    PAGE = 2000
    MAX_PAGES = 50  # 100k rows a poll at most; the rest comes next poll

    def poll_once(self, subs: list[Subscription]) -> None:
        """Deliver new rows. Pages on (at, id) so a burst bigger than one page can't stall the window."""
        assert self.last_at is not None
        orgs = {s.org_id for s in subs}
        cur_at, cur_id = self.last_at - LOOKBACK, None
        newest = self.last_at
        for _ in range(self.MAX_PAGES):
            q = select(RealtimeEvent).where(RealtimeEvent.org_id.in_(orgs))
            if cur_id is None:
                q = q.where(RealtimeEvent.at >= cur_at)
            else:
                q = q.where(or_(RealtimeEvent.at > cur_at, and_(RealtimeEvent.at == cur_at, RealtimeEvent.id > cur_id)))
            rows = db.session.scalars(q.order_by(RealtimeEvent.at, RealtimeEvent.id).limit(self.PAGE)).all()
            db.session.rollback()  # never sit in a transaction between polls
            for r in rows:
                key = str(r.id)
                if key in self.seen:
                    continue
                self.seen[key] = r.at
                d = {**row_dict(r), "org_id": str(r.org_id), "user_ids": r.user_ids}
                for s in subs:
                    if s.org_id == r.org_id:
                        s.put(d)
                if r.at > newest:
                    newest = r.at
            if len(rows) < self.PAGE:
                break
            cur_at, cur_id = rows[-1].at, rows[-1].id
        self.last_at = newest
        cutoff = self.last_at - timedelta(seconds=30)
        if len(self.seen) > 5000 or any(v < cutoff for v in list(self.seen.values())[:50]):
            self.seen = {k: v for k, v in self.seen.items() if v >= cutoff}


broker = Broker()
