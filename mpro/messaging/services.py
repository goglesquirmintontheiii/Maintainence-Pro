"""Messaging: business rules (G-04). 0.6.0, MP-049 (r283–r285, r301–r306, r080, r305, r323, r655).

Every write emits a domain event (G-05). Notifications are not sent from here: the notifications workstream consumes
`message.created` and asks `notification_targets(message)` who should hear about it.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select

from mpro.auth.models import User
from mpro.core.events import emit
from mpro.core.files import FileObject, attach, file_dict, links_for_many
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.realtime import publish
from mpro.extensions import db
from mpro.messaging.models import (
    NOTIFY_LEVELS,
    Conversation,
    ConversationMember,
    Message,
    MessageAck,
    MessageReaction,
    ThreadFollow,
)
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import RuleError, avatar_url, members_query

MAX_BODY = 10000
MAX_GROUP = 200
ALL_TEAM_NAME = "All Team"


# ---- helpers -----------------------------------------------------------------------------------------
def _uuid(v: Any, what: str = "record") -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 404) from e


def membership_of(org_id: uuid.UUID, user_id: uuid.UUID) -> Membership | None:
    return db.session.scalars(members_query(org_id).where(Membership.user_id == user_id)).first()


def _active_member_ids(org_id: uuid.UUID) -> list[uuid.UUID]:
    return list(db.session.scalars(members_query(org_id).with_only_columns(Membership.user_id)))


def _team_member_ids(team_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        db.session.scalars(
            select(TeamMember.user_id)
            .join(Team, Team.id == TeamMember.team_id)
            .where(TeamMember.team_id == team_id, Team.deleted_at.is_(None))
        )
    )


def _team_ids(org_id: uuid.UUID, user_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        db.session.scalars(
            select(TeamMember.team_id)
            .join(Team, Team.id == TeamMember.team_id)
            .where(TeamMember.org_id == org_id, TeamMember.user_id == user_id, Team.deleted_at.is_(None))
        )
    )


def _wo(conv: Conversation) -> Any:
    from mpro.workorders.models import WorkOrder

    return db.session.get(WorkOrder, conv.work_order_id) if conv.work_order_id else None


def state(conv: Conversation, user_id: uuid.UUID, create: bool = False) -> ConversationMember | None:
    row = db.session.scalars(
        select(ConversationMember).where(
            ConversationMember.conversation_id == conv.id, ConversationMember.user_id == user_id
        )
    ).first()
    if row is None and create:
        row = ConversationMember(
            org_id=conv.org_id, conversation_id=conv.id, user_id=user_id, notify=default_notify(conv.kind)
        )
        db.session.add(row)
        db.session.flush()
    return row


def default_notify(kind: str) -> str:
    """Busy org-wide and work order threads notify on mentions; people and teams on every message (r308)."""
    return "mentions" if kind in ("all", "work_order") else "all"


def participant_ids(conv: Conversation) -> list[uuid.UUID]:
    """Everyone who belongs to the conversation right now."""
    if conv.kind in ("direct", "group"):
        return list(
            db.session.scalars(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conv.id, ConversationMember.left_at.is_(None)
                )
            )
        )
    if conv.kind == "team" and conv.team_id:
        return _team_member_ids(conv.team_id)
    if conv.kind == "all":
        return _active_member_ids(conv.org_id)
    if conv.kind == "work_order":
        wo = _wo(conv)
        if wo is None:
            return []
        ids: set[uuid.UUID] = set()
        if wo.created_by_id:
            ids.add(wo.created_by_id)
        for a in wo.assignees:
            if a.user_id:
                ids.add(a.user_id)
            elif a.team_id:
                ids.update(_team_member_ids(a.team_id))
        ids.update(
            db.session.scalars(
                select(ConversationMember.user_id).where(ConversationMember.conversation_id == conv.id)
            )
        )
        out = []
        for uid in ids:  # only people who can still see the work order
            m = membership_of(conv.org_id, uid)
            if m is not None and can_access(m, conv):
                out.append(uid)
        return out
    return []


def can_access(m: Membership | None, conv: Conversation | None) -> bool:
    """May this member read (and, with messages.use, post in) the conversation?"""
    if m is None or conv is None or conv.org_id != m.org_id or conv.deleted_at is not None:
        return False
    if conv.kind in ("direct", "group"):
        row = state(conv, m.user_id)
        return row is not None and row.left_at is None
    if conv.kind == "team":
        return conv.team_id is not None and conv.team_id in _team_ids(m.org_id, m.user_id)
    if conv.kind == "all":
        return not conv.hidden_for_all or can(m, "messages.manage")
    if conv.kind == "work_order":
        from mpro.workorders.services import can_see

        wo = _wo(conv)
        return wo is not None and wo.deleted_at is None and can_see(m, wo)
    return False


def get_conversation(m: Membership, cid: Any) -> Conversation:
    conv = db.session.get(Conversation, _uuid(cid, "conversation"))
    if not can_access(m, conv):
        raise RuleError("That conversation doesn't exist or you're not in it.", 404)
    assert conv is not None
    return conv


def get_message(m: Membership, mid: Any) -> Message:
    msg = db.session.get(Message, _uuid(mid, "message"))
    if msg is None or msg.org_id != m.org_id:
        raise RuleError("That message doesn't exist.", 404)
    conv = db.session.get(Conversation, msg.conversation_id)
    if not can_access(m, conv):
        raise RuleError("That message doesn't exist.", 404)
    return msg


def _check_people(org_id: uuid.UUID, ids: Iterable[Any]) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for raw in ids:
        uid = _uuid(raw, "person")
        if membership_of(org_id, uid) is None:
            raise RuleError("One of those people isn't in this organization.", 422)
        if uid not in out:
            out.append(uid)
    return out


def _touch(conv: Conversation, at: datetime) -> None:
    conv.last_message_at = at
    # a hidden conversation comes back when something new arrives (r285)
    for row in db.session.scalars(
        select(ConversationMember).where(
            ConversationMember.conversation_id == conv.id, ConversationMember.hidden.is_(True)
        )
    ):
        row.hidden = False


def _push(conv: Conversation, typ: str, **data: Any) -> None:
    publish(conv.org_id, f"conv:{conv.id}", {"type": typ, "conversation_id": str(conv.id), **data})


# ---- conversations ---------------------------------------------------------------------------------
def ensure_all_conversation(org_id: uuid.UUID) -> Conversation:
    conv = db.session.scalars(
        select(Conversation).where(
            Conversation.org_id == org_id, Conversation.kind == "all", Conversation.deleted_at.is_(None)
        )
    ).first()
    if conv is None:
        conv = Conversation(org_id=org_id, kind="all", name=ALL_TEAM_NAME, description="Everyone in the organization")
        db.session.add(conv)
        db.session.flush()
    return conv


def ensure_team_conversation(team: Team) -> Conversation:
    conv = db.session.scalars(
        select(Conversation).where(Conversation.org_id == team.org_id, Conversation.team_id == team.id)
    ).first()
    if conv is None:
        conv = Conversation(org_id=team.org_id, kind="team", team_id=team.id, name=team.name)
        db.session.add(conv)
        db.session.flush()
    elif conv.name != team.name or conv.deleted_at is not None:
        conv.name = team.name
        conv.deleted_at = None if team.deleted_at is None else conv.deleted_at
    return conv


def _ensure_mine(m: Membership) -> None:
    """Team chats and All Team exist for everything this person belongs to (created lazily)."""
    ensure_all_conversation(m.org_id)
    for tid in _team_ids(m.org_id, m.user_id):
        team = db.session.get(Team, tid)
        if team is not None:
            ensure_team_conversation(team)


def direct_conversation(org: Organization, m: Membership, other_user_id: Any) -> Conversation:
    other = _check_people(org.id, [other_user_id])[0]
    if other == m.user_id:
        raise RuleError("Pick someone else to message.", 422)
    key = ":".join(sorted([str(m.user_id), str(other)]))
    conv = db.session.scalars(
        select(Conversation).where(Conversation.org_id == org.id, Conversation.dm_key == key)
    ).first()
    if conv is not None:
        for uid in (m.user_id, other):  # someone hid it: open it again
            row = state(conv, uid, create=True)
            assert row is not None
            row.left_at = None
            if uid == m.user_id:
                row.hidden = False
        db.session.commit()
        return conv
    conv = Conversation(org_id=org.id, kind="direct", dm_key=key, created_by_id=m.user_id)
    db.session.add(conv)
    db.session.flush()
    for uid in (m.user_id, other):
        db.session.add(ConversationMember(org_id=org.id, conversation_id=conv.id, user_id=uid))
    emit(
        "conversation.created",
        entity_type="conversation",
        entity_id=conv.id,
        summary="Started a direct conversation",
        data={"conversation_id": conv.id, "kind": "direct", "member_ids": [m.user_id, other]},
        org_id=org.id,
    )
    db.session.commit()
    return conv


def create_group(org: Organization, m: Membership, data: dict[str, Any]) -> Conversation:
    ids = _check_people(org.id, data.get("user_ids") or [])
    if m.user_id not in ids:
        ids.insert(0, m.user_id)
    if len(ids) < 2:
        raise RuleError("Add at least one other person.", 422)
    if len(ids) > MAX_GROUP:
        raise RuleError(f"Groups can have up to {MAX_GROUP} people. Use a team chat for more.", 422)
    if len(ids) == 2 and not (data.get("name") or "").strip():
        other = next(u for u in ids if u != m.user_id)
        return direct_conversation(org, m, other)
    name = str(data.get("name") or "").strip()[:120]
    conv = Conversation(
        org_id=org.id,
        kind="group",
        name=name,
        description=str(data.get("description") or "").strip()[:2000],
        created_by_id=m.user_id,
    )
    db.session.add(conv)
    db.session.flush()
    for uid in ids:
        db.session.add(ConversationMember(org_id=org.id, conversation_id=conv.id, user_id=uid))
    emit(
        "conversation.created",
        entity_type="conversation",
        entity_id=conv.id,
        entity_label=name,
        summary=f"Created the group {name or 'conversation'}",
        data={"conversation_id": conv.id, "kind": "group", "member_ids": ids},
        org_id=org.id,
    )
    db.session.commit()
    return conv


def team_conversation(org: Organization, m: Membership, team_id: Any) -> Conversation:
    team = db.session.get(Team, _uuid(team_id, "team"))
    if team is None or team.org_id != org.id or team.deleted_at is not None:
        raise RuleError("That team doesn't exist.", 404)
    conv = ensure_team_conversation(team)
    db.session.commit()
    if not can_access(m, conv):
        raise RuleError("Only members of the team can open its chat.", 403)
    return conv


def work_order_conversation(org: Organization, m: Membership, wo: Any) -> Conversation:
    """The thread on a work order (MP-049). Anyone who can see the work order can use it."""
    conv = db.session.scalars(
        select(Conversation).where(Conversation.org_id == org.id, Conversation.work_order_id == wo.id)
    ).first()
    if conv is None:
        conv = Conversation(
            org_id=org.id, kind="work_order", work_order_id=wo.id, name=f"#{wo.number} {wo.title}"[:120]
        )
        db.session.add(conv)
        db.session.flush()
        emit(
            "conversation.created",
            entity_type="conversation",
            entity_id=conv.id,
            entity_label=conv.name,
            summary=f"Started the thread on work order #{wo.number}",
            data={"conversation_id": conv.id, "kind": "work_order", "work_order_id": wo.id},
            org_id=org.id,
        )
    state(conv, m.user_id, create=True)  # it shows in their list from now on
    db.session.commit()
    return conv


def _can_edit_details(m: Membership, conv: Conversation) -> bool:
    if conv.kind == "group":
        return True
    if conv.kind in ("team", "all"):
        return can(m, "messages.manage")
    return False


def update_conversation(m: Membership, conv: Conversation, data: dict[str, Any]) -> Conversation:
    changes: dict[str, Any] = {}
    if "hidden_for_all" in data:
        if conv.kind != "all" or not can(m, "messages.manage"):
            raise RuleError("Only administrators can hide the All Team conversation.", 403)
        changes["hidden_for_all"] = (conv.hidden_for_all, bool(data["hidden_for_all"]))
        conv.hidden_for_all = bool(data["hidden_for_all"])
    detail = {k for k in ("name", "description", "picture_file_id") if k in data}
    if detail and not _can_edit_details(m, conv):
        raise RuleError("You can't change this conversation's details.", 403)
    if "name" in data:
        if conv.kind == "team":
            raise RuleError("A team chat is named after its team. Rename the team instead.", 422)
        name = str(data["name"] or "").strip()[:120]
        changes["name"] = (conv.name, name)
        conv.name = name
    if "description" in data:
        desc = str(data["description"] or "").strip()[:2000]
        changes["description"] = (conv.description, desc)
        conv.description = desc
    if "picture_file_id" in data:
        fid = data["picture_file_id"]
        if fid:
            f = db.session.get(FileObject, _uuid(fid, "picture"))
            if f is None or f.org_id != conv.org_id or not f.is_image:
                raise RuleError("Pick a picture to use.", 422)
            attach(f, "conversation", conv.id, "picture")
            conv.picture_file_id = f.id
        else:
            conv.picture_file_id = None
        changes["picture"] = (None, bool(fid))
    emit(
        "conversation.updated",
        entity_type="conversation",
        entity_id=conv.id,
        entity_label=conv.name,
        summary="Changed the conversation",
        changes=changes,
        data={"conversation_id": conv.id},
        org_id=conv.org_id,
    )
    _push(conv, "conversation.updated")
    db.session.commit()
    return conv


def update_my_settings(m: Membership, conv: Conversation, data: dict[str, Any]) -> ConversationMember:
    """Mute, notification level, pin, hide, follow all threads (r284, r285, r308)."""
    row = state(conv, m.user_id, create=True)
    assert row is not None
    if "notify" in data:
        if data["notify"] not in NOTIFY_LEVELS:
            raise RuleError("Pick All messages, Mentions only or Nothing.", 422)
        row.notify = data["notify"]
    if "mute_hours" in data:
        hours = data["mute_hours"]
        if hours in (None, 0, "0", ""):
            row.muted_until = None
        else:
            try:
                h = float(hours)
            except (TypeError, ValueError) as e:
                raise RuleError("Mute for a number of hours.", 422) from e
            if h < 0:
                raise RuleError("Mute for a number of hours.", 422)
            row.muted_until = utcnow() + timedelta(hours=min(h, 24 * 365 * 10))
    if "pinned" in data:
        row.pinned = bool(data["pinned"])
    if "hidden" in data:
        row.hidden = bool(data["hidden"])
    if "follow_all_threads" in data:
        row.follow_all_threads = bool(data["follow_all_threads"])
    db.session.commit()
    publish(m.org_id, f"user:{m.user_id}", {"type": "conversation.settings", "conversation_id": str(conv.id)})
    db.session.commit()
    return row


def add_members(m: Membership, conv: Conversation, user_ids: list[Any]) -> list[uuid.UUID]:
    if conv.kind != "group":
        raise RuleError("People can only be added to group conversations.", 422)
    ids = _check_people(conv.org_id, user_ids)
    current = set(participant_ids(conv))
    if len(current | set(ids)) > MAX_GROUP:
        raise RuleError(f"Groups can have up to {MAX_GROUP} people.", 422)
    added = []
    for uid in ids:
        row = state(conv, uid, create=True)
        assert row is not None
        if uid not in current:
            row.left_at = None
            row.hidden = False
            added.append(uid)
    if added:
        names = ", ".join(u.name for u in db.session.scalars(select(User).where(User.id.in_(added))))
        _system(conv, f"{_name(m.user_id)} added {names}")
        emit(
            "conversation.members_added",
            entity_type="conversation",
            entity_id=conv.id,
            entity_label=conv.name,
            summary=f"Added {names}",
            data={"conversation_id": conv.id, "user_ids": added},
            org_id=conv.org_id,
        )
    db.session.commit()
    return added


def remove_member(m: Membership, conv: Conversation, user_id: Any) -> None:
    uid = _uuid(user_id, "person")
    if conv.kind == "direct":
        raise RuleError("You can't leave a direct conversation. Hide it instead.", 422)
    if conv.kind != "group":
        raise RuleError("Team, All Team and work order chats can't be left. Mute or hide them instead.", 422)
    if uid != m.user_id and conv.created_by_id != m.user_id and not can(m, "messages.manage"):
        raise RuleError("Only the person who created the group can remove people.", 403)
    row = state(conv, uid)
    if row is None or row.left_at is not None:
        raise RuleError("That person isn't in this conversation.", 404)
    row.left_at = utcnow()
    _system(conv, f"{_name(uid)} left" if uid == m.user_id else f"{_name(m.user_id)} removed {_name(uid)}")
    emit(
        "conversation.member_removed",
        entity_type="conversation",
        entity_id=conv.id,
        entity_label=conv.name,
        summary="Left the conversation" if uid == m.user_id else "Removed someone",
        data={"conversation_id": conv.id, "user_id": uid},
        org_id=conv.org_id,
    )
    db.session.commit()


def _name(user_id: uuid.UUID | None) -> str:
    u = db.session.get(User, user_id) if user_id else None
    return u.name if u else "Someone"


def mark_read(m: Membership, conv: Conversation, thread_id: Any = None) -> None:
    now = utcnow()
    if thread_id:
        root = get_message(m, thread_id)
        f = _follow(root, m.user_id, create=True)
        f.last_read_at = now
    else:
        row = state(conv, m.user_id, create=True)
        assert row is not None
        row.last_read_at = now
    db.session.commit()
    # read receipts for the others, and the unread badge on this person's other tabs
    _push(conv, "conversation.read", user_id=str(m.user_id), at=iso(now))
    publish(m.org_id, f"user:{m.user_id}", {"type": "unread", "conversation_id": str(conv.id)})
    db.session.commit()


# ---- messages -------------------------------------------------------------------------------------------
def _follow(root: Message, user_id: uuid.UUID, create: bool = False, level: str = "all") -> ThreadFollow:
    f = db.session.scalars(
        select(ThreadFollow).where(ThreadFollow.message_id == root.id, ThreadFollow.user_id == user_id)
    ).first()
    if f is None and create:
        f = ThreadFollow(org_id=root.org_id, message_id=root.id, user_id=user_id, level=level)
        db.session.add(f)
        db.session.flush()
    return f  # type: ignore[return-value]


def _system(conv: Conversation, text: str, kind: str = "system", data: dict[str, Any] | None = None) -> Message:
    now = utcnow()
    msg = Message(org_id=conv.org_id, conversation_id=conv.id, kind=kind, body=text[:MAX_BODY], data=data or {})
    msg.created_at = now
    db.session.add(msg)
    _touch(conv, now)
    db.session.flush()
    _push(conv, "message.created", message_id=str(msg.id))
    return msg


def post_message(
    org: Organization,
    m: Membership,
    conv: Conversation,
    body: str,
    file_ids: list[Any] | None = None,
    parent_id: Any = None,
    announcement: bool = False,
) -> Message:
    from mpro.workorders.activity import parse_mentions

    if not can(m, "messages.use"):
        raise RuleError("You don't have permission to send messages.", 403)
    body = (body or "").strip()
    if not body and not file_ids:
        raise RuleError("Write a message or attach a file.", 422)
    if len(body) > MAX_BODY:
        raise RuleError("Messages can be up to 10,000 characters.", 422)
    if announcement and not can(m, "messages.manage"):
        raise RuleError("Only administrators can post announcements.", 403)
    parent: Message | None = None
    if parent_id:
        parent = get_message(m, parent_id)
        if parent.conversation_id != conv.id:
            raise RuleError("That thread is in another conversation.", 422)
        if parent.parent_id is not None:
            parent = db.session.get(Message, parent.parent_id)  # replies to a reply go to the same thread
        if parent is None or parent.deleted_at is not None:
            raise RuleError("That thread was deleted.", 409)
        if announcement:
            raise RuleError("Announcements start a new message, not a reply.", 422)
    now = utcnow()
    msg = Message(
        org_id=org.id,
        conversation_id=conv.id,
        author_id=m.user_id,
        parent_id=parent.id if parent else None,
        kind="announcement" if announcement else "text",
        body=body,
        mentions=parse_mentions(org.id, body),
        requires_ack=announcement,
    )
    msg.created_at = now
    db.session.add(msg)
    db.session.flush()
    for fid in file_ids or []:
        f = db.session.get(FileObject, _uuid(fid, "file"))
        if f is None or f.org_id != org.id or f.uploaded_by_id != m.user_id:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        attach(f, "message", msg.id, "file")
    if parent is not None:
        parent.reply_count = (parent.reply_count or 0) + 1
        parent.last_reply_at = now
        if parent.author_id:
            _follow(parent, parent.author_id, create=True)
        f = _follow(parent, m.user_id, create=True)
        f.last_read_at = now
    else:
        _touch(conv, now)
        row = state(conv, m.user_id, create=True)
        assert row is not None
        row.last_read_at = now
        row.hidden = False
    emit(
        "message.created",
        entity_type="message",
        entity_id=msg.id,
        entity_label=conv.name or conv.kind,
        summary="Posted an announcement" if announcement else ("Replied in a thread" if parent else "Sent a message"),
        data={
            "message_id": msg.id,
            "conversation_id": conv.id,
            "conversation_kind": conv.kind,
            "conversation_name": conv.name,
            "work_order_id": conv.work_order_id,
            "parent_id": parent.id if parent else None,
            "author_id": m.user_id,
            "mentions": msg.mentions,
            "announcement": announcement,
            "excerpt": body[:200],
            "has_files": bool(file_ids),
        },
        org_id=org.id,
    )
    _push(conv, "message.created", message_id=str(msg.id), parent_id=str(parent.id) if parent else None)
    db.session.commit()
    return msg


def edit_message(m: Membership, msg: Message, body: str) -> Message:
    from mpro.workorders.activity import parse_mentions

    if msg.author_id != m.user_id:
        raise RuleError("You can only edit your own messages.", 403)
    if msg.deleted_at is not None:
        raise RuleError("That message was deleted.", 409)
    body = (body or "").strip()
    if not body:
        raise RuleError("Write something, or delete the message instead.", 422)
    if len(body) > MAX_BODY:
        raise RuleError("Messages can be up to 10,000 characters.", 422)
    old = msg.body
    msg.body = body
    msg.mentions = parse_mentions(msg.org_id, body)
    msg.edited_at = utcnow()
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    emit(
        "message.edited",
        entity_type="message",
        entity_id=msg.id,
        entity_label=conv.name or conv.kind,
        summary="Edited a message",
        changes={"body": (old[:200], body[:200])},
        data={"message_id": msg.id, "conversation_id": conv.id, "mentions": msg.mentions},
        org_id=msg.org_id,
    )
    _push(conv, "message.updated", message_id=str(msg.id))
    db.session.commit()
    return msg


def delete_message(m: Membership, msg: Message) -> None:
    if msg.author_id != m.user_id and not can(m, "messages.manage"):
        raise RuleError("You can only delete your own messages.", 403)
    if msg.deleted_at is not None:
        return
    msg.deleted_at = utcnow()
    msg.body = ""
    msg.mentions = {}
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    emit(
        "message.deleted",
        entity_type="message",
        entity_id=msg.id,
        entity_label=conv.name or conv.kind,
        summary="Deleted a message",
        data={"message_id": msg.id, "conversation_id": conv.id, "by_author": msg.author_id == m.user_id},
        org_id=msg.org_id,
    )
    _push(conv, "message.updated", message_id=str(msg.id))
    db.session.commit()


EMOJI_RE = re.compile(r"^[^\sA-Za-z0-9<>&\"'`]{1,16}$")


def toggle_reaction(m: Membership, msg: Message, emoji: str) -> bool:
    emoji = (emoji or "").strip()
    if not EMOJI_RE.match(emoji):
        raise RuleError("Pick an emoji.", 422)
    if msg.deleted_at is not None:
        raise RuleError("That message was deleted.", 409)
    have = db.session.scalars(
        select(MessageReaction).where(
            MessageReaction.message_id == msg.id, MessageReaction.user_id == m.user_id, MessageReaction.emoji == emoji
        )
    ).first()
    if have:
        db.session.delete(have)
        on = False
    else:
        db.session.add(MessageReaction(org_id=msg.org_id, message_id=msg.id, user_id=m.user_id, emoji=emoji))
        on = True
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    emit(
        "message.reacted",
        entity_type="message",
        entity_id=msg.id,
        summary=f"Reacted {emoji}" if on else f"Removed {emoji}",
        data={"message_id": msg.id, "conversation_id": conv.id, "emoji": emoji, "on": on, "author_id": msg.author_id},
        org_id=msg.org_id,
    )
    _push(conv, "message.updated", message_id=str(msg.id))
    db.session.commit()
    return on


def acknowledge(m: Membership, msg: Message) -> None:
    if not msg.requires_ack:
        raise RuleError("That message doesn't need confirming.", 422)
    if db.session.scalars(
        select(MessageAck).where(MessageAck.message_id == msg.id, MessageAck.user_id == m.user_id)
    ).first():
        return
    db.session.add(MessageAck(org_id=msg.org_id, message_id=msg.id, user_id=m.user_id, at=utcnow()))
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    emit(
        "message.acknowledged",
        entity_type="message",
        entity_id=msg.id,
        summary="Confirmed an announcement",
        data={"message_id": msg.id, "conversation_id": conv.id},
        org_id=msg.org_id,
    )
    _push(conv, "message.updated", message_id=str(msg.id))
    db.session.commit()


def ack_report(msg: Message) -> dict[str, Any]:
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    acks = {a.user_id: a.at for a in db.session.scalars(select(MessageAck).where(MessageAck.message_id == msg.id))}
    people = participant_ids(conv) or []
    users = {u.id: u for u in db.session.scalars(select(User).where(User.id.in_(set(people) | set(acks))))}
    rows = [
        {**_user_ref(users[uid]), "acknowledged_at": iso(acks.get(uid))}
        for uid in sorted(set(people) | set(acks), key=lambda x: users[x].name.lower() if x in users else "")
        if uid in users
    ]
    return {
        "acknowledged": sum(1 for r in rows if r["acknowledged_at"]),
        "total": len(rows),
        "people": rows,
    }


def set_thread_level(m: Membership, root: Message, level: str) -> ThreadFollow:
    if level not in NOTIFY_LEVELS:
        raise RuleError("Pick All replies, Mentions only or Nothing.", 422)
    if root.parent_id is not None:
        raise RuleError("Pick the first message of the thread.", 422)
    f = _follow(root, m.user_id, create=True, level=level)
    f.level = level
    db.session.commit()
    return f


def create_work_order_from_message(org: Organization, m: Membership, msg: Message) -> Any:
    """Turn a message into a work order (r080). Its files come along; the conversation gets a link."""
    from mpro.core.files import links_for
    from mpro.workorders.services import create_work_order

    if not can(m, "wo.create"):
        raise RuleError("You don't have permission to create work orders.", 403)
    if msg.deleted_at is not None or msg.kind not in ("text", "announcement"):
        raise RuleError("Pick a message someone wrote.", 422)
    plain = re.sub(r"@\[([^\]]{1,200})\]\((?:user|team):[0-9a-fA-F-]{36}\)", r"@\1", msg.body or "").strip()
    first = (plain.splitlines() or [""])[0].strip()
    title = (first[:117] + "…") if len(first) > 120 else (first or "Work order from a message")
    conv = db.session.get(Conversation, msg.conversation_id)
    assert conv is not None
    wo = create_work_order(org, m, {"title": title, "description": plain}, commit=False)
    for link in links_for("message", msg.id):
        attach(link.file, "work_order", wo.id, "file")
    _system(
        conv,
        f"{_name(m.user_id)} created work order #{wo.number} from a message",
        kind="work_order",
        data={"work_order_id": str(wo.id), "number": wo.number, "title": wo.title, "from_message_id": str(msg.id)},
    )
    db.session.commit()
    return wo


def post_work_order_link(
    team_id: uuid.UUID, wo: Any, actor_label: str = "", happened_at: datetime | None = None
) -> Message | None:
    """Assigning a work order to a team posts its link in the team chat (r305). Called by the event consumer.

    Assignments from before the chat existed aren't back-filled (e.g. sample data seeded before the chats)."""
    team = db.session.get(Team, team_id)
    if team is None or team.deleted_at is not None or team.org_id != wo.org_id:
        return None
    existing = db.session.scalars(
        select(Conversation).where(Conversation.org_id == team.org_id, Conversation.team_id == team.id)
    ).first()
    if existing is not None and happened_at is not None and existing.created_at > happened_at:
        return None
    conv = ensure_team_conversation(team)
    who = actor_label or "Someone"
    return _system(
        conv,
        f"{who} assigned work order #{wo.number} to {team.name}",
        kind="work_order",
        data={"work_order_id": str(wo.id), "number": wo.number, "title": wo.title},
    )


# ---- reading ---------------------------------------------------------------------------------------------
def _user_ref(u: User) -> dict[str, Any]:
    return {"id": str(u.id), "name": u.name, "initials": u.initials, "avatar_url": avatar_url(u)}


def _baseline(m: Membership, row: ConversationMember | None) -> datetime:
    base = m.created_at
    if row is not None and row.last_read_at is not None and row.last_read_at > base:
        base = row.last_read_at
    return base


def _unread_count(m: Membership, conv: Conversation, row: ConversationMember | None) -> int:
    return int(
        db.session.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == conv.id,
                Message.parent_id.is_(None),
                Message.deleted_at.is_(None),
                Message.created_at > _baseline(m, row),
                or_(Message.author_id.is_(None), Message.author_id != m.user_id),
            )
        )
        or 0
    )


def visible_conversations(m: Membership) -> list[Conversation]:
    _ensure_mine(m)
    db.session.flush()
    mine = select(ConversationMember.conversation_id).where(
        ConversationMember.user_id == m.user_id, ConversationMember.org_id == m.org_id
    )
    teams = _team_ids(m.org_id, m.user_id)
    convs = db.session.scalars(
        select(Conversation).where(
            Conversation.org_id == m.org_id,
            Conversation.deleted_at.is_(None),
            or_(
                Conversation.id.in_(mine),
                and_(Conversation.kind == "team", Conversation.team_id.in_(teams or [uuid.uuid4()])),
                Conversation.kind == "all",
            ),
        )
    ).all()
    return [c for c in convs if can_access(m, c)]


def conversation_title(conv: Conversation, me: uuid.UUID, people: dict[uuid.UUID, User] | None = None) -> str:
    if conv.kind == "direct":
        other = next((u for u in participant_ids(conv) if u != me), None)
        u = (people or {}).get(other) if other else None
        u = u or (db.session.get(User, other) if other else None)
        return u.name if u else "Direct message"
    if conv.kind == "group" and not conv.name:
        names = [
            u.name
            for u in db.session.scalars(select(User).where(User.id.in_(participant_ids(conv)), User.id != me)).all()
        ]
        return ", ".join(sorted(names)[:4]) + (" and others" if len(names) > 4 else "") or "Group"
    return conv.name or "Conversation"


def conversation_summary(m: Membership, conv: Conversation) -> dict[str, Any]:
    row = state(conv, m.user_id)
    last = db.session.scalars(
        select(Message)
        .where(Message.conversation_id == conv.id, Message.parent_id.is_(None))
        .order_by(Message.created_at.desc())
        .limit(1)
    ).first()
    other: dict[str, Any] | None = None
    if conv.kind == "direct":
        oid = next((u for u in participant_ids(conv) if u != m.user_id), None)
        ou = db.session.get(User, oid) if oid else None
        other = _user_ref(ou) if ou else None
    team = db.session.get(Team, conv.team_id) if conv.team_id else None
    muted = bool(row and row.muted_until and row.muted_until > utcnow())
    return {
        "id": str(conv.id),
        "kind": conv.kind,
        "title": conversation_title(conv, m.user_id),
        "name": conv.name,
        "description": conv.description,
        "picture_url": f"/api/v1/files/{conv.picture_file_id}/thumb" if conv.picture_file_id else None,
        "other": other,
        "team": {"id": str(team.id), "name": team.name, "color": team.color} if team else None,
        "work_order_id": str(conv.work_order_id) if conv.work_order_id else None,
        "hidden_for_all": conv.hidden_for_all,
        "last_message_at": iso(conv.last_message_at),
        "last_message": _preview(last),
        "unread": _unread_count(m, conv, row),
        "me": {
            "notify": row.notify if row else default_notify(conv.kind),
            "muted": muted,
            "muted_until": iso(row.muted_until) if muted and row else None,
            "pinned": bool(row and row.pinned),
            "hidden": bool(row and row.hidden),
            "follow_all_threads": bool(row and row.follow_all_threads),
            "last_read_at": iso(row.last_read_at) if row else None,
        },
    }


def _preview(msg: Message | None) -> dict[str, Any] | None:
    if msg is None:
        return None
    plain = re.sub(r"@\[([^\]]{1,200})\]\((?:user|team):[0-9a-fA-F-]{36}\)", r"@\1", msg.body or "")
    author = db.session.get(User, msg.author_id) if msg.author_id else None
    return {
        "id": str(msg.id),
        "text": "Message deleted" if msg.deleted_at else (plain[:140] or "Sent a file"),
        "author": author.name if author else None,
        "author_id": str(msg.author_id) if msg.author_id else None,
        "at": iso(msg.created_at),
        "kind": msg.kind,
    }


def list_conversations(m: Membership) -> dict[str, Any]:
    items = [conversation_summary(m, c) for c in visible_conversations(m)]
    db.session.commit()  # lazily created team / All Team chats
    items = [i for i in items if not i["me"]["hidden"]]
    items.sort(key=lambda i: (not i["me"]["pinned"], -(_ts(i["last_message_at"]))))
    total = sum(i["unread"] for i in items if not i["me"]["muted"] and i["me"]["notify"] != "none")
    return {"items": items, "unread_total": total}


def _ts(v: str | None) -> float:
    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() if v else 0.0


def unread_total(m: Membership) -> int:
    return int(list_conversations(m)["unread_total"])


def conversation_detail(m: Membership, conv: Conversation) -> dict[str, Any]:
    d = conversation_summary(m, conv)
    ids = participant_ids(conv)
    people = db.session.scalars(select(User).where(User.id.in_(ids)).order_by(User.name)).all() if ids else []
    reads = {
        r.user_id: r.last_read_at
        for r in db.session.scalars(select(ConversationMember).where(ConversationMember.conversation_id == conv.id))
    }
    d["members"] = [{**_user_ref(u), "last_read_at": iso(reads.get(u.id))} for u in people[:500]]
    d["member_count"] = len(ids)
    d["can"] = {
        "post": can(m, "messages.use"),
        "edit_details": _can_edit_details(m, conv) and conv.kind != "team",
        "edit_description": _can_edit_details(m, conv),
        "add_people": conv.kind == "group",
        "leave": conv.kind == "group",
        "announce": can(m, "messages.manage"),
        "hide_for_all": conv.kind == "all" and can(m, "messages.manage"),
        "create_work_order": can(m, "wo.create"),
    }
    return d


def message_dicts(m: Membership, msgs: list[Message]) -> list[dict[str, Any]]:
    if not msgs:
        return []
    ids = [x.id for x in msgs]
    authors = {x.author_id for x in msgs if x.author_id}
    users = {u.id: u for u in db.session.scalars(select(User).where(User.id.in_(authors)))} if authors else {}
    files = links_for_many("message", ids)
    reactions: dict[uuid.UUID, dict[str, list[str]]] = {}
    for r in db.session.scalars(
        select(MessageReaction).where(MessageReaction.message_id.in_(ids)).order_by(MessageReaction.id)
    ):
        reactions.setdefault(r.message_id, {}).setdefault(r.emoji, []).append(str(r.user_id))
    announce = [x.id for x in msgs if x.requires_ack]
    acked: dict[uuid.UUID, int] = {}
    mine: set[uuid.UUID] = set()
    if announce:
        for a in db.session.scalars(select(MessageAck).where(MessageAck.message_id.in_(announce))):
            acked[a.message_id] = acked.get(a.message_id, 0) + 1
            if a.user_id == m.user_id:
                mine.add(a.message_id)
    follows = {
        f.message_id: f
        for f in db.session.scalars(
            select(ThreadFollow).where(ThreadFollow.message_id.in_(ids), ThreadFollow.user_id == m.user_id)
        )
    }
    out = []
    for x in msgs:
        u = users.get(x.author_id) if x.author_id else None
        deleted = x.deleted_at is not None
        f = follows.get(x.id)
        out.append(
            {
                "id": str(x.id),
                "conversation_id": str(x.conversation_id),
                "parent_id": str(x.parent_id) if x.parent_id else None,
                "kind": x.kind,
                "author": _user_ref(u) if u else None,
                "mine": x.author_id == m.user_id,
                "body": "" if deleted else x.body,
                "data": x.data or {},
                "deleted": deleted,
                "edited": x.edited_at is not None,
                "created_at": iso(x.created_at),
                "reply_count": x.reply_count,
                "last_reply_at": iso(x.last_reply_at),
                "thread_level": f.level if f else None,
                "reactions": reactions.get(x.id, {}),
                "files": [] if deleted else [file_dict(link.file, link.role, link.id) for link in files.get(x.id, [])],
                "requires_ack": x.requires_ack,
                "acknowledged": x.id in mine,
                "ack_count": acked.get(x.id, 0),
            }
        )
    return out


def list_messages(
    m: Membership,
    conv: Conversation,
    before: str | None = None,
    after: str | None = None,
    around: str | None = None,
    parent_id: Any = None,
    limit: int = 50,
) -> dict[str, Any]:
    limit = max(1, min(int(limit or 50), 200))
    q = select(Message).where(Message.conversation_id == conv.id)
    if parent_id:
        root = get_message(m, parent_id)
        if root.conversation_id != conv.id:
            raise RuleError("That thread is in another conversation.", 404)
        q = q.where(Message.parent_id == root.id)
    else:
        q = q.where(Message.parent_id.is_(None))
    if around:
        target = get_message(m, around)
        if target.parent_id is not None:  # a reply: show its thread's root in the conversation
            target = db.session.get(Message, target.parent_id) or target
        older = db.session.scalars(
            q.where(Message.created_at <= target.created_at).order_by(Message.created_at.desc()).limit(limit // 2 + 1)
        ).all()
        newer = db.session.scalars(
            q.where(Message.created_at > target.created_at).order_by(Message.created_at).limit(limit // 2)
        ).all()
        rows = list(reversed(older)) + list(newer)
        return {"items": message_dicts(m, rows), "has_more_before": len(older) > limit // 2, "has_more_after": True}
    if after:
        rows = list(
            db.session.scalars(q.where(Message.created_at > _parse(after)).order_by(Message.created_at).limit(limit))
        )
        return {"items": message_dicts(m, rows), "has_more_before": False, "has_more_after": len(rows) == limit}
    if before:
        q = q.where(Message.created_at < _parse(before))
    rows = list(db.session.scalars(q.order_by(Message.created_at.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    return {"items": message_dicts(m, rows), "has_more_before": more, "has_more_after": False}


def _parse(v: str) -> datetime:
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError as e:
        raise RuleError("That isn't a valid time.", 422) from e


def threads(m: Membership) -> dict[str, Any]:
    """The Threads tab (r284): threads I follow, newest reply first, with unread replies."""
    convs = {c.id: c for c in visible_conversations(m)}
    follows = list(
        db.session.scalars(
            select(ThreadFollow).where(ThreadFollow.user_id == m.user_id, ThreadFollow.org_id == m.org_id)
        )
    )
    # "Follow all new threads" in a conversation: every thread there counts
    auto = [
        r.conversation_id
        for r in db.session.scalars(
            select(ConversationMember).where(
                ConversationMember.user_id == m.user_id, ConversationMember.follow_all_threads.is_(True)
            )
        )
        if r.conversation_id in convs
    ]
    root_ids = {f.message_id for f in follows if f.level != "none"}
    if auto:
        root_ids.update(
            db.session.scalars(
                select(Message.id).where(Message.conversation_id.in_(auto), Message.reply_count > 0).limit(500)
            )
        )
    roots = (
        db.session.scalars(
            select(Message)
            .where(Message.id.in_(root_ids), Message.reply_count > 0)
            .order_by(Message.last_reply_at.desc())
            .limit(100)
        ).all()
        if root_ids
        else []
    )
    roots = [r for r in roots if r.conversation_id in convs]
    fmap = {f.message_id: f for f in follows}
    items = []
    for d, r in zip(message_dicts(m, roots), roots, strict=True):
        f = fmap.get(r.id)
        seen = f.last_read_at if f and f.last_read_at else m.created_at
        unread = db.session.scalar(
            select(func.count(Message.id)).where(
                Message.parent_id == r.id,
                Message.created_at > seen,
                Message.deleted_at.is_(None),
                or_(Message.author_id.is_(None), Message.author_id != m.user_id),
            )
        )
        c = convs[r.conversation_id]
        items.append({**d, "conversation_title": conversation_title(c, m.user_id), "unread": int(unread or 0)})
    return {"items": items}


def search(m: Membership, q: str, limit: int = 40) -> dict[str, Any]:
    """Relevance-ranked search across messages, conversation names and descriptions (r304)."""
    terms = [t for t in re.split(r"\s+", (q or "").strip().lower()) if t][:8]
    if not terms or len("".join(terms)) < 2:
        return {"conversations": [], "messages": []}
    convs = {c.id: c for c in visible_conversations(m)}
    if not convs:
        return {"conversations": [], "messages": []}

    def score(text: str, at: datetime | None) -> float:
        t = (text or "").lower()
        s = 0.0
        for term in terms:
            n = t.count(term)
            if n == 0:
                return 0.0
            s += 1 + min(n, 5) * 0.5
            if re.search(r"\b" + re.escape(term) + r"\b", t):
                s += 1.0
        if len(terms) > 1 and " ".join(terms) in t:
            s += 3.0
        if at is not None:  # newer results win ties
            s += max(0.0, 1.0 - (utcnow() - at).days / 365)
        return s

    conv_hits = []
    for c in convs.values():
        title = conversation_title(c, m.user_id)
        sc = score(f"{title} {c.description}", c.last_message_at)
        if sc:
            conv_hits.append((sc, c))
    conv_hits.sort(key=lambda x: -x[0])
    cond = [func.lower(Message.body).contains(t) for t in terms]
    rows = db.session.scalars(
        select(Message)
        .where(Message.conversation_id.in_(list(convs)), Message.deleted_at.is_(None), and_(*cond))
        .order_by(Message.created_at.desc())
        .limit(500)
    ).all()
    plain = re.compile(r"@\[([^\]]{1,200})\]\((?:user|team):[0-9a-fA-F-]{36}\)")
    ranked = sorted(((score(plain.sub(r"@\1", r.body), r.created_at), r) for r in rows), key=lambda x: -x[0])
    ranked = [x for x in ranked if x[0] > 0][:limit]
    msgs = message_dicts(m, [r for _, r in ranked])
    for d, (_, r) in zip(msgs, ranked, strict=True):
        d["conversation_title"] = conversation_title(convs[r.conversation_id], m.user_id)
    return {
        "conversations": [conversation_summary(m, c) for _, c in conv_hits[:10]],
        "messages": msgs,
    }


# ---- for notifications (F3) ------------------------------------------------------------------------------
def notification_targets(message_id: Any) -> list[dict[str, Any]]:
    """Who should hear about this message, and why: [{user_id, reason}] with reason "mention" | "dm" | "message" |
    "thread" | "announcement". Respects mute, conversation and thread notification levels; the author is left out.
    Read-only, for the notifications workstream's `message.created` consumer."""
    msg = db.session.get(Message, _uuid(message_id, "message"))
    if msg is None or msg.deleted_at is not None:
        return []
    conv = db.session.get(Conversation, msg.conversation_id)
    if conv is None or conv.deleted_at is not None:
        return []
    now = utcnow()
    mentioned = {uuid.UUID(u) for u in (msg.mentions or {}).get("users", [])}
    for tid in (msg.mentions or {}).get("teams", []):
        mentioned.update(_team_member_ids(uuid.UUID(tid)))
    rows = {
        r.user_id: r
        for r in db.session.scalars(select(ConversationMember).where(ConversationMember.conversation_id == conv.id))
    }
    people = set(participant_ids(conv))
    out: list[dict[str, Any]] = []
    if msg.parent_id is not None:
        followers = {
            f.user_id: f.level
            for f in db.session.scalars(select(ThreadFollow).where(ThreadFollow.message_id == msg.parent_id))
        }
        for uid, r in rows.items():
            if r.follow_all_threads and uid not in followers:
                followers[uid] = "all"
        for uid in people:
            if uid == msg.author_id:
                continue
            level = followers.get(uid)
            muted = uid in rows and rows[uid].muted_until is not None and rows[uid].muted_until > now  # type: ignore[operator]
            if uid in mentioned and level != "none":
                out.append({"user_id": uid, "reason": "mention"})
            elif level == "all" and not muted:
                out.append({"user_id": uid, "reason": "thread"})
        return out
    for uid in people:
        if uid == msg.author_id:
            continue
        st = rows.get(uid)
        level = st.notify if st else default_notify(conv.kind)
        muted = bool(st and st.muted_until and st.muted_until > now)
        if msg.requires_ack:
            out.append({"user_id": uid, "reason": "announcement"})  # safety notices reach everyone
        elif uid in mentioned and level != "none":
            out.append({"user_id": uid, "reason": "mention"})
        elif muted or level != "all":
            continue
        else:
            out.append({"user_id": uid, "reason": "dm" if conv.kind == "direct" else "message"})
    return out
