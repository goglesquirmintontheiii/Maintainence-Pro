"""Messaging and realtime: HTTP API (thin views over services). 0.6.0, MP-049, r269."""

from __future__ import annotations

import json
import queue
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, current_app, g, request, stream_with_context
from sqlalchemy import select

from mpro.core import realtime
from mpro.core.files import FileError, register_entity
from mpro.core.jobs import job, periodic
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.messaging import consumers as _consumers  # noqa: F401  (registers event consumers)
from mpro.messaging import services as svc
from mpro.messaging.models import Conversation, Message
from mpro.orgs.models import Membership, Team
from mpro.orgs.services import RuleError, avatar_url, members_query

bp = APIBlueprint("messaging", __name__, url_prefix="/api/v1", tag="Messaging")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _conv(cid: str) -> Conversation:
    return guard(svc.get_conversation, g.membership, cid)


def _msg(mid: str) -> Message:
    return guard(svc.get_message, g.membership, mid)


def _one(msg: Message) -> dict[str, Any]:
    return svc.message_dicts(g.membership, [msg])[0]


@bp.after_app_request
def _flush_realtime(resp: Response) -> Response:
    realtime.flush_pending()
    return resp


# ---- people for pickers and @mentions -------------------------------------------------------------------
@bp.get("/messaging/people")
@require("messages.use")
def people() -> dict[str, Any]:
    ms = db.session.scalars(members_query(g.org.id)).all()
    teams = db.session.scalars(
        select(Team).where(Team.org_id == g.org.id, Team.deleted_at.is_(None)).order_by(Team.name)
    ).all()
    return {
        "people": sorted(
            [
                {
                    "id": str(m.user.id),
                    "name": m.user.name,
                    "initials": m.user.initials,
                    "avatar_url": avatar_url(m.user),
                    "job_title": m.job_title,
                }
                for m in ms
            ],
            key=lambda p: p["name"].lower(),
        ),
        "teams": [{"id": str(t.id), "name": t.name, "color": t.color} for t in teams],
    }


# ---- conversations ------------------------------------------------------------------------------------------
@bp.get("/conversations")
@require("messages.use")
def list_conversations() -> dict[str, Any]:
    return svc.list_conversations(g.membership)


@bp.get("/messages/unread")
@require("messages.use")
def unread() -> dict[str, Any]:
    return {"total": svc.unread_total(g.membership)}


@bp.post("/conversations")
@require("messages.use")
def create_conversation() -> tuple[dict[str, Any], int]:
    """{kind: "direct", user_id} opens (or reuses) a direct conversation; {kind: "group", name?, user_ids} a group."""
    d = body()
    kind = d.get("kind") or ("direct" if d.get("user_id") else "group")
    if kind == "direct":
        conv = guard(svc.direct_conversation, g.org, g.membership, d.get("user_id"))
    elif kind == "group":
        conv = guard(svc.create_group, g.org, g.membership, d)
    else:
        abort(422, message="Start a direct or a group conversation.")
    return svc.conversation_detail(g.membership, conv), 201


@bp.post("/teams/<team_id>/conversation")
@require("messages.use")
def team_conversation(team_id: str) -> dict[str, Any]:
    """The team's chat (r655 Message button on a team page)."""
    conv = guard(svc.team_conversation, g.org, g.membership, team_id)
    return svc.conversation_detail(g.membership, conv)


@bp.post("/work-orders/<wo_id>/conversation")
@require("messages.use")
def work_order_conversation(wo_id: str) -> dict[str, Any]:
    """The thread on a work order (MP-049). Created the first time someone opens it."""
    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import can_see

    try:
        wid = uuid.UUID(wo_id)
    except ValueError:
        abort(404)
    wo = db.session.get(WorkOrder, wid)
    if wo is None or wo.org_id != g.org.id or wo.deleted_at is not None or not can_see(g.membership, wo):
        abort(404)
    conv = guard(svc.work_order_conversation, g.org, g.membership, wo)
    return svc.conversation_detail(g.membership, conv)


@bp.get("/conversations/<cid>")
@require("messages.use")
def get_conversation(cid: str) -> dict[str, Any]:
    return svc.conversation_detail(g.membership, _conv(cid))


@bp.patch("/conversations/<cid>")
@require("messages.use")
def update_conversation(cid: str) -> dict[str, Any]:
    conv = guard(svc.update_conversation, g.membership, _conv(cid), body())
    return svc.conversation_detail(g.membership, conv)


@bp.patch("/conversations/<cid>/me")
@require("messages.use")
def my_settings(cid: str) -> dict[str, Any]:
    conv = _conv(cid)
    guard(svc.update_my_settings, g.membership, conv, body())
    return svc.conversation_summary(g.membership, conv)


@bp.post("/conversations/<cid>/members")
@require("messages.use")
def add_members(cid: str) -> dict[str, Any]:
    conv = _conv(cid)
    guard(svc.add_members, g.membership, conv, body().get("user_ids") or [])
    return svc.conversation_detail(g.membership, conv)


@bp.delete("/conversations/<cid>/members/<user_id>")
@require("messages.use")
def remove_member(cid: str, user_id: str) -> tuple[str, int]:
    guard(svc.remove_member, g.membership, _conv(cid), user_id)
    return "", 204


@bp.post("/conversations/<cid>/read")
@require("messages.use")
def mark_read(cid: str) -> tuple[str, int]:
    guard(svc.mark_read, g.membership, _conv(cid), body().get("thread_id"))
    return "", 204


# ---- messages ------------------------------------------------------------------------------------------------
@bp.get("/conversations/<cid>/messages")
@require("messages.use")
def list_messages(cid: str) -> dict[str, Any]:
    a = request.args
    return guard(
        svc.list_messages,
        g.membership,
        _conv(cid),
        before=a.get("before"),
        after=a.get("after"),
        around=a.get("around"),
        parent_id=a.get("thread"),
        limit=a.get("limit", 50, type=int),
    )


@bp.post("/conversations/<cid>/messages")
@require("messages.use")
def post_message(cid: str) -> tuple[dict[str, Any], int]:
    d = body()
    msg = guard(
        svc.post_message,
        g.org,
        g.membership,
        _conv(cid),
        str(d.get("body") or ""),
        d.get("file_ids") or [],
        d.get("parent_id"),
        bool(d.get("announcement")),
    )
    return _one(msg), 201


@bp.get("/messages/search")
@require("messages.use")
def search() -> dict[str, Any]:
    return svc.search(g.membership, request.args.get("q", ""))


@bp.get("/threads")
@require("messages.use")
def threads() -> dict[str, Any]:
    return svc.threads(g.membership)


@bp.get("/messages/<mid>")
@require("messages.use")
def get_message(mid: str) -> dict[str, Any]:
    """Resolve a message permalink (r302)."""
    msg = _msg(mid)
    return {**_one(msg), "link": f"/messages/{msg.conversation_id}?m={msg.id}"}


@bp.patch("/messages/<mid>")
@require("messages.use")
def edit_message(mid: str) -> dict[str, Any]:
    msg = guard(svc.edit_message, g.membership, _msg(mid), str(body().get("body") or ""))
    return _one(msg)


@bp.delete("/messages/<mid>")
@require("messages.use")
def delete_message(mid: str) -> tuple[str, int]:
    guard(svc.delete_message, g.membership, _msg(mid))
    return "", 204


@bp.post("/messages/<mid>/reactions")
@require("messages.use")
def react(mid: str) -> dict[str, Any]:
    msg = _msg(mid)
    guard(svc.toggle_reaction, g.membership, msg, str(body().get("emoji") or ""))
    return _one(msg)


@bp.post("/messages/<mid>/ack")
@require("messages.use")
def ack(mid: str) -> dict[str, Any]:
    msg = _msg(mid)
    guard(svc.acknowledge, g.membership, msg)
    return _one(msg)


@bp.get("/messages/<mid>/acks")
@require("messages.use")
def acks(mid: str) -> dict[str, Any]:
    msg = _msg(mid)
    if not msg.requires_ack:
        abort(404)
    if msg.author_id != g.user.id and not can(g.membership, "messages.manage"):
        abort(403, message="Only the person who posted it and administrators can see who confirmed.")
    return svc.ack_report(msg)


@bp.patch("/messages/<mid>/thread")
@require("messages.use")
def thread_level(mid: str) -> dict[str, Any]:
    msg = _msg(mid)
    guard(svc.set_thread_level, g.membership, msg, str(body().get("level") or ""))
    return _one(msg)


@bp.post("/messages/<mid>/work-order")
@require("wo.create")
def work_order_from_message(mid: str) -> tuple[dict[str, Any], int]:
    wo = guard(svc.create_work_order_from_message, g.org, g.membership, _msg(mid))
    return {"id": str(wo.id), "number": wo.number, "title": wo.title}, 201


# ---- files on messages and conversation pictures ---------------------------------------------------------------
def _message_ok(mid: uuid.UUID, edit: bool) -> bool:
    msg = db.session.get(Message, mid)
    m = getattr(g, "membership", None)
    if msg is None or m is None or msg.org_id != m.org_id:
        return False
    conv = db.session.get(Conversation, msg.conversation_id)
    if not svc.can_access(m, conv):
        return False
    return not edit or msg.author_id == m.user_id


def _conversation_ok(cid: uuid.UUID, edit: bool) -> bool:
    conv = db.session.get(Conversation, cid)
    m = getattr(g, "membership", None)
    if not svc.can_access(m, conv):
        return False
    assert conv is not None and m is not None
    return not edit or conv.kind == "group" or can(m, "messages.manage")


register_entity("message", lambda mid: _message_ok(mid, False), lambda mid: _message_ok(mid, True))
register_entity("conversation", lambda cid: _conversation_ok(cid, False), lambda cid: _conversation_ok(cid, True))


# ---- realtime (r269) -------------------------------------------------------------------------------------------
def _authorize_conversation(m: Membership, rest: str) -> bool:
    try:
        conv = db.session.get(Conversation, uuid.UUID(rest))
    except ValueError:
        return False
    return svc.can_access(m, conv)


realtime.register_topic("conv:", _authorize_conversation)


def _parse_since(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.split("|")[0].replace("Z", "+00:00"))
    except ValueError:
        return None


def _sse(d: dict[str, Any]) -> str:
    out = {k: d[k] for k in ("id", "topic", "type", "data", "at")}
    return f"id: {d['at']}|{d['id']}\nevent: rt\ndata: {json.dumps(out, separators=(',', ':'))}\n\n"


@bp.get("/realtime/stream")
@require("org.view")
def realtime_stream() -> Any:
    """Server-Sent Events: everything this person may see in their organization, as it happens.

    Each tab keeps one stream. When the server's stream budget is used up (MPRO_REALTIME_MAX_STREAMS, waitress gives
    each open stream a thread), it answers 429 and the browser polls /realtime/poll instead."""
    app = current_app._get_current_object()  # type: ignore[attr-defined]
    limit = int(app.config.get("MPRO_REALTIME_MAX_STREAMS", 4))
    if realtime.broker.count() >= limit:
        return {"mode": "poll", "message": "Live updates are busy; polling instead."}, 429, {"Retry-After": "60"}
    org_id, user_id = g.org.id, g.user.id
    since = _parse_since(request.args.get("since") or request.headers.get("Last-Event-ID"))
    max_age = float(app.config.get("MPRO_REALTIME_STREAM_SECONDS", 300))
    sub = realtime.broker.subscribe(app, org_id)

    def gen() -> Any:
        try:
            yield "retry: 3000\n\n"
            yield f"event: hello\ndata: {json.dumps({'cursor': iso(utcnow())})}\n\n"
            if since is not None:  # catch up after a reconnect
                m = svc.membership_of(org_id, user_id)
                for r in realtime.rows_since(org_id, since):
                    if realtime.may_receive(m, r):
                        yield _sse({**realtime.row_dict(r)})
                db.session.rollback()
            end = time.monotonic() + max_age
            while time.monotonic() < end:
                try:
                    first = sub.q.get(timeout=15)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                batch = [first]
                while len(batch) < 200:
                    try:
                        batch.append(sub.q.get_nowait())
                    except queue.Empty:
                        break
                m = svc.membership_of(org_id, user_id)
                if m is None:  # removed from the organization while connected
                    return
                for d in batch:
                    if realtime.may_receive(m, d):
                        yield _sse(d)
                if sub.overflow:
                    sub.overflow = False
                    yield "event: resync\ndata: {}\n\n"
                db.session.rollback()
        finally:
            realtime.broker.unsubscribe(sub)
            db.session.remove()

    return Response(
        stream_with_context(gen()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@bp.get("/realtime/poll")
@require("org.view")
def realtime_poll() -> dict[str, Any]:
    """The fallback when streaming isn't possible: everything since `since` (the browser drops repeats by id)."""
    since = _parse_since(request.args.get("since")) or utcnow()
    now = utcnow()
    m = g.membership
    items = [realtime.row_dict(r) for r in realtime.rows_since(g.org.id, since) if realtime.may_receive(m, r)]
    return {"items": items, "cursor": iso(now)}


@job("realtime_prune")
def _prune(_: dict[str, Any]) -> None:
    realtime.prune()


periodic("realtime_prune", timedelta(minutes=10))
