"""Offline sync for the phone app: business rules (G-04).

Design (r270, r291)
-------------------
* **Cache set.** A phone keeps the work orders assigned to the person or their teams that are still open (plus those
  finished in the last few days), soonest due first, up to a limit. That's MaintainX's offline mode.
* **Change feed.** `feed(m, cursor)` returns the ids of the whole cache set (so the phone can drop what left it) and
  the ids that changed since the cursor. A work order "changed" when a domain event was recorded for it or its row was
  updated. The cursor is the server time when the feed was read; the next read looks a little further back
  (`OVERLAP`) so a transaction that committed late is never missed. Repeats are harmless: the phone overwrites.
* **Items.** `items(m, ids)` returns, per work order, what the work order screen shows: the detail, its activity and
  its parts. The phone stores them so the screens open offline.
* **Changes made offline** are replayed as the normal API calls with an `Idempotency-Key` header (see `idempotency`),
  in order. Field and status changes carry the version they started from, so a change made on top of someone
  else's newer edit comes back as 409 Conflict with the current record instead of overwriting it.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import case, or_, select

from mpro.core.events import DomainEvent, emit
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.orgs.services import RuleError
from mpro.workorders import activity as act
from mpro.workorders import queries as wo_queries
from mpro.workorders.models import PRIORITY_RANK, WorkOrder, WorkOrderAssignee
from mpro.workorders.services import can_see, team_ids_of, visibility_filter

CACHE_LIMIT = 150  # work orders kept on a phone (r291)
CACHE_LIMIT_MAX = 300
ITEMS_MAX = 25  # work orders per items() call
DONE_KEEP_DAYS = 3  # finished work stays on the phone a few days, so the technician sees it went through
OVERLAP = timedelta(minutes=2)  # look back this far past the cursor (late commits)
MAX_CURSOR_AGE = timedelta(days=30)  # older cursors get a full sync


# ---------------------------------------------------------------- cursors
def make_cursor(at: datetime, org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    raw = json.dumps({"t": iso(at), "o": str(org_id), "u": str(user_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def read_cursor(cursor: str | None, org_id: uuid.UUID, user_id: uuid.UUID) -> datetime | None:
    """The time in a cursor, or None (full sync) when it's missing, broken, from another org or person, or old."""
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        at = datetime.fromisoformat(str(data["t"]).replace("Z", "+00:00"))
    except (ValueError, KeyError, TypeError):
        return None
    if data.get("o") != str(org_id) or data.get("u") != str(user_id) or at.tzinfo is None:
        return None
    now = utcnow()
    if at > now + timedelta(minutes=5) or now - at > MAX_CURSOR_AGE:
        return None
    return at


# ---------------------------------------------------------------- the cache set
def cache_ids(m: Membership, limit: int = CACHE_LIMIT) -> list[uuid.UUID]:
    """Work orders this person's phone keeps: assigned to them or their teams, open or recently finished, soonest
    due first (no due date last), then most urgent."""
    teams = team_ids_of(m.org_id, m.user_id)
    mine = select(WorkOrderAssignee.work_order_id).where(
        WorkOrderAssignee.org_id == m.org_id,
        or_(WorkOrderAssignee.user_id == m.user_id, WorkOrderAssignee.team_id.in_(teams or [uuid.uuid4()])),
    )
    recent = utcnow() - timedelta(days=DONE_KEEP_DAYS)
    q = (
        select(WorkOrder.id)
        .where(
            WorkOrder.org_id == m.org_id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.id.in_(mine),
            or_(
                WorkOrder.status.in_(("open", "on_hold", "in_progress")),
                (WorkOrder.status == "done") & (WorkOrder.completed_at >= recent),
            ),
            visibility_filter(m),
        )
        .order_by(
            WorkOrder.due_at.is_(None),
            WorkOrder.due_at,
            case(PRIORITY_RANK, value=WorkOrder.priority).desc(),
            WorkOrder.number,
        )
        .limit(max(1, min(limit, CACHE_LIMIT_MAX)))
    )
    return list(db.session.scalars(q).all())


def changed_since(m: Membership, ids: list[uuid.UUID], since: datetime) -> list[uuid.UUID]:
    """Which of `ids` changed at or after `since` (an event about them, or their row was updated)."""
    if not ids:
        return []
    keys = {str(i) for i in ids}
    by_event = set(
        db.session.scalars(
            select(DomainEvent.entity_id)
            .where(
                DomainEvent.org_id == m.org_id,
                DomainEvent.entity_type == "work_order",
                DomainEvent.created_at >= since,
                DomainEvent.entity_id.in_(keys),
            )
            .distinct()
        ).all()
    )
    by_row = {
        str(x)
        for x in db.session.scalars(
            select(WorkOrder.id).where(WorkOrder.id.in_(ids), WorkOrder.updated_at >= since)
        ).all()
    }
    hit = by_event | by_row
    return [i for i in ids if str(i) in hit]


def feed(m: Membership, cursor: str | None, limit: int = CACHE_LIMIT) -> dict[str, Any]:
    now = utcnow()
    since = read_cursor(cursor, m.org_id, m.user_id)
    ids = cache_ids(m, limit)
    changed = ids if since is None else changed_since(m, ids, since - OVERLAP)
    return {
        "cursor": make_cursor(now, m.org_id, m.user_id),
        "full": since is None,
        "server_time": iso(now),
        "cache_ids": [str(i) for i in ids],
        "changed_ids": [str(i) for i in changed],
        "items_max": ITEMS_MAX,
    }


def items(m: Membership, raw_ids: list[str]) -> dict[str, Any]:
    """The work order screens' data for each id the person may still see; the others come back in `missing`."""
    if len(raw_ids) > ITEMS_MAX:
        raise RuleError(f"Ask for at most {ITEMS_MAX} work orders at a time.", 422)
    ids: list[uuid.UUID] = []
    missing: list[str] = []
    for r in raw_ids:
        try:
            ids.append(uuid.UUID(str(r)))
        except ValueError:
            missing.append(str(r))
    rows = {
        w.id: w
        for w in db.session.scalars(
            select(WorkOrder).where(WorkOrder.org_id == m.org_id, WorkOrder.id.in_(ids), WorkOrder.deleted_at.is_(None))
        ).all()
    }
    parts_ok = can(m, "parts.view")
    out = []
    for i in ids:
        wo = rows.get(i)
        if wo is None or not can_see(m, wo):
            missing.append(str(i))
            continue
        item: dict[str, Any] = {
            "id": str(wo.id),
            "version": wo.version,
            "detail": wo_queries.detail_dict(m, wo),
            "activity": {"items": act.activity(wo)},
        }
        if parts_ok:
            from mpro.parts import queries as parts_queries

            item["parts"] = parts_queries.work_order_parts(m, wo)
        out.append(item)
    return {"items": out, "missing": missing}


# ---------------------------------------------------------------- phone Overview: recent activity (r290)
def recent_activity(m: Membership, limit: int = 20) -> list[dict[str, Any]]:
    """The latest changes on work orders this person may see (the phone Overview's Recent Activity)."""
    limit = max(1, min(limit, 50))
    rows = db.session.scalars(
        select(DomainEvent)
        .where(DomainEvent.org_id == m.org_id, DomainEvent.entity_type == "work_order")
        .order_by(DomainEvent.created_at.desc())
        .limit(limit * 4)
    ).all()
    wo_ids: set[uuid.UUID] = set()
    for ev in rows:
        try:
            wo_ids.add(uuid.UUID(ev.entity_id))
        except ValueError:
            continue
    wos = {
        w.id: w
        for w in db.session.scalars(
            select(WorkOrder).where(
                WorkOrder.org_id == m.org_id, WorkOrder.id.in_(wo_ids), WorkOrder.deleted_at.is_(None)
            )
        ).all()
    }
    seen: dict[uuid.UUID, bool] = {}
    out: list[dict[str, Any]] = []
    for ev in rows:
        try:
            wid = uuid.UUID(ev.entity_id)
        except ValueError:
            continue
        wo = wos.get(wid)
        if wo is None:
            continue
        if wid not in seen:
            seen[wid] = can_see(m, wo)
        if not seen[wid]:
            continue
        out.append(
            {
                "id": str(ev.id),
                "type": ev.type,
                "summary": ev.summary,
                "actor": ev.actor_label,
                "at": iso(ev.created_at),
                "work_order": {"id": str(wo.id), "number": wo.number, "title": wo.title, "status": wo.status},
            }
        )
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- delete my account (r321)
def account_blockers(user: Any) -> list[dict[str, str]]:
    """Organizations where this person is the only Owner: they hand over ownership first."""
    out = []
    for mem in user.memberships:
        if mem.deleted_at is not None or mem.org.deleted_at is not None or mem.role != "owner":
            continue
        others = db.session.scalars(
            select(Membership.id).where(
                Membership.org_id == mem.org_id,
                Membership.role == "owner",
                Membership.deleted_at.is_(None),
                Membership.user_id != user.id,
            )
        ).first()
        if others is None:
            out.append({"org_id": str(mem.org_id), "org": mem.org.name})
    return out


def delete_account(user: Any, password: str, confirm: str) -> None:
    """Delete my own account (r321). The person is removed from every organization and their sign-in is wiped;
    their name on past work becomes "Deleted user" so history stays readable."""
    from mpro.auth.models import User

    if not isinstance(user, User):
        raise RuleError("Please sign in.", 401)
    if user.password_hash and not user.check_password(password or ""):
        raise RuleError("That password isn't right.", 403)
    if (confirm or "").strip().upper() != "DELETE":
        raise RuleError("Type DELETE to confirm.", 422)
    if user.is_sysadmin:
        from mpro.sysadmin.services import _active_sysadmins

        if not [x for x in _active_sysadmins() if x.id != user.id]:
            raise RuleError(
                "You're the server's only sysadmin. Make someone else a sysadmin (MPro Management or "
                "`mpro sysadmin add`) before deleting your account.",
                409,
            )
    blockers = account_blockers(user)
    if blockers:
        names = ", ".join(b["org"] for b in blockers)
        raise RuleError(
            f"You're the only Owner of {names}. Make someone else the Owner (Teams & Users) or delete the "
            "organization first.",
            409,
        )
    now = utcnow()
    for mem in user.memberships:
        if mem.deleted_at is None:
            mem.deleted_at = now
            emit(
                "user.account_deleted",
                entity_type="user",
                entity_id=user.id,
                entity_label="Deleted user",
                summary="Deleted their account",
                org_id=mem.org_id,
                actor=user,
            )
    _forget(user)
    user.email = f"deleted-{user.id}@deleted.invalid"
    user.name = "Deleted user"
    user.is_sysadmin = False
    user.password_hash = ""
    user.phone = ""
    user.active = False
    user.avatar = None
    user.avatar_updated_at = None
    user.deleted_at = now
    db.session.commit()


def _forget(user: Any) -> None:
    """What's left of a deleted account: devices, notification settings and inbox, stored replies, conversation
    rows go; past events keep their place in history but show "Deleted user" instead of the name (r321)."""
    from sqlalchemy import delete, update

    from mpro.core.events import DomainEvent
    from mpro.messaging.models import ConversationMember
    from mpro.notifications.models import Notification, NotificationPref, PushSubscription
    from mpro.sync.models import IdempotentRequest

    for model in (PushSubscription, NotificationPref, Notification, IdempotentRequest, ConversationMember):
        db.session.execute(delete(model).where(model.user_id == user.id))
    db.session.execute(update(DomainEvent).where(DomainEvent.actor_id == user.id).values(actor_label="Deleted user"))
    db.session.execute(
        update(DomainEvent)
        .where(DomainEvent.entity_type == "user", DomainEvent.entity_id == str(user.id))
        .values(entity_label="Deleted user")
    )
