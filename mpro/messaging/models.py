"""Messaging: database models (0.6.0, MP-049, r283–r285, r301–r306, r323).

Conversations come in kinds:
- direct: two people (`dm_key` keeps one per pair)
- group: people picked by hand
- team: one per team, members follow the team (r283)
- all: the org-wide "All Team" conversation (admins can hide it)
- work_order: the thread on a work order; anyone who can see the work order can read and post

Members of team / all / work_order conversations are worked out when needed; `ConversationMember` rows only hold a
person's own state there (read position, mute, pin, hide, notification level).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core import realtime as _realtime  # noqa: F401  (realtime_events lives with this module's migration)
from mpro.core.models import IdMixin, OrgScopedMixin, SoftDeleteMixin, TimestampMixin, UTCDateTime
from mpro.extensions import db

KINDS = ("direct", "group", "team", "all", "work_order")
NOTIFY_LEVELS = ("all", "mentions", "none")


class Conversation(IdMixin, TimestampMixin, SoftDeleteMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("org_id", "dm_key", name="uq_conversations_org_dm_key"),
        UniqueConstraint("org_id", "team_id", name="uq_conversations_org_team"),
        UniqueConstraint("org_id", "work_order_id", name="uq_conversations_org_work_order"),
    )

    kind: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(String(2000), default="")
    picture_file_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("files.id"), nullable=True)
    dm_key: Mapped[str | None] = mapped_column(String(80), nullable=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("teams.id"), nullable=True)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("work_orders.id"), nullable=True)
    hidden_for_all: Mapped[bool] = mapped_column(Boolean, default=False)  # admins hide the All Team chat (r283)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    last_message_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)


class ConversationMember(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """A person in a direct/group conversation, or their own settings in a team/all/work-order one."""

    __tablename__ = "conversation_members"
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="uq_conversation_members_conv_user"),)

    conversation_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("conversations.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), index=True)
    left_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # left a group (not team chats)
    last_read_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    notify: Mapped[str] = mapped_column(String(12), default="all")  # all | mentions | none (r308)
    muted_until: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)  # comes back when a new message arrives
    follow_all_threads: Mapped[bool] = mapped_column(Boolean, default=False)  # r284


class Message(IdMixin, TimestampMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_conversation_created", "conversation_id", "created_at"),)

    conversation_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("conversations.id"), index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("messages.id"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), default="text")  # text | system | work_order | announcement
    body: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {work_order_id, number, title, …}
    mentions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {users: [...], teams: [...]}
    requires_ack: Mapped[bool] = mapped_column(Boolean, default=False)  # announcements (r323)
    reply_count: Mapped[int] = mapped_column(Integer, default=0)
    last_reply_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class MessageReaction(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "message_reactions"
    __table_args__ = (UniqueConstraint("message_id", "user_id", "emoji", name="uq_message_reactions_msg_user_emoji"),)

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("messages.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    emoji: Mapped[str] = mapped_column(String(16))


class MessageAck(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Someone confirmed they read an announcement (r323)."""

    __tablename__ = "message_acks"
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_message_acks_msg_user"),)

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("messages.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    at: Mapped[datetime] = mapped_column(UTCDateTime)


class ThreadFollow(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    """Someone's notification level for one thread (r284). Authors and repliers follow automatically."""

    __tablename__ = "thread_follows"
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_thread_follows_msg_user"),)

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("messages.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    level: Mapped[str] = mapped_column(String(12), default="all")  # all | mentions | none
    last_read_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
