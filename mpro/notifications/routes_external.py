"""Routing for events from the requests (F1) and messaging (F2) modules.

Kept apart from services.py so those modules' models are only imported when their events arrive.
"""

from __future__ import annotations

import uuid
from typing import Any

from mpro.core.events import DomainEvent
from mpro.extensions import db
from mpro.notifications.services import Target, _uuid, members_who_can, team_members
from mpro.orgs.models import Membership

REQUEST_UPDATES = {
    "request.approved",
    "request.declined",
    "request.status_changed",
    "request.work_order_status",
    "request.commented",
}


def requests(ev: DomainEvent) -> list[Target]:
    try:
        from mpro.workrequests.models import WorkRequest
        from mpro.workrequests.services import can_view
    except ImportError:  # pragma: no cover - module not built yet
        return []
    rid = _uuid(ev.entity_id)
    r = db.session.get(WorkRequest, rid) if rid else None
    if r is None or r.org_id != ev.org_id or r.deleted_at is not None:
        return []
    label = f"request #{r.number}: {r.title}"
    base: dict[str, Any] = {
        "link": f"/requests/{r.id}",
        "entity_type": "work_request",
        "entity_id": str(r.id),
        "check": lambda m: can_view(m, r),
    }
    data = ev.data or {}
    who = ev.actor_label if ev.actor_id else (data.get("submitter_name") or "Someone")
    if ev.type == "request.created":
        approvers = set(members_who_can(r.org_id, "requests.approve"))
        people: set[uuid.UUID]
        if r.team_id:  # routed to a team (r278): its members, plus anyone who reviews requests in that team
            team = set(team_members(r.org_id, [r.team_id]))
            people = team & set(members_who_can(r.org_id, "requests.view_all")) or approvers
        else:
            people = approvers
        return [Target(uid, "request.new", f"New {label}", f"From {who}", **base) for uid in sorted(people, key=str)]
    if ev.type in REQUEST_UPDATES and r.created_by_id:
        title = {
            "request.approved": f"Your {label} was approved",
            "request.declined": f"Your {label} was declined",
            "request.commented": f"{who} commented on your {label}",
        }.get(ev.type, f"Your {label}: {ev.summary}")
        body = str(data.get("reason") or data.get("excerpt") or "")
        return [Target(r.created_by_id, "request.update", title, body, **base)]
    return []


def messages(ev: DomainEvent) -> list[Target]:
    """Who hears about a new message comes from the messaging module (participants of the conversation right now,
    with mute, conversation and thread levels applied); each recipient must still be able to open the conversation
    when it's delivered (they may have left the team or lost sight of the work order since)."""
    if ev.type != "message.created":
        return []
    try:
        from mpro.messaging.models import Conversation, Message
        from mpro.messaging.services import notification_targets
    except ImportError:  # pragma: no cover
        return []
    data = ev.data or {}
    cid = _uuid(data.get("conversation_id"))
    conv = db.session.get(Conversation, cid) if cid else None
    if conv is None or conv.org_id != ev.org_id or getattr(conv, "deleted_at", None) is not None:
        return []
    mid = _uuid(data.get("message_id"))
    msg = db.session.get(Message, mid) if mid else None
    if msg is None or msg.deleted_at is not None or msg.conversation_id != conv.id:
        return []
    who = ev.actor_label or "Someone"
    place = conv.name or ("a work order" if conv.kind == "work_order" else "a conversation")
    excerpt = str(data.get("excerpt") or "")
    out: list[Target] = []
    for t in notification_targets(msg.id):
        reason = t["reason"]
        if reason == "dm":
            title, kind = f"{who} sent you a message", "message.direct"
        elif reason == "mention":
            title, kind = f"{who} mentioned you in {place}", "message.direct"
        elif reason == "announcement":
            title, kind = f"Announcement from {who} in {place}", "message.direct"
        else:
            title, kind = f"{who} in {place}", "message.other"
        out.append(
            Target(
                t["user_id"],
                kind,
                title,
                excerpt,
                link=f"/messages/{conv.id}",
                entity_type="conversation",
                entity_id=str(conv.id),
                check=_can_open(conv),
            )
        )
    return out


def _can_open(conv: Any) -> Any:
    from mpro.messaging.services import can_access

    return lambda m: isinstance(m, Membership) and can_access(m, conv)
