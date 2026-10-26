"""Comments (with @mentions and reactions), time entries, timers, other costs and the activity feed."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from mpro.core.events import DomainEvent, emit
from mpro.core.files import FileObject, attach, link_dict, links_for, links_for_many
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can, can_on
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team
from mpro.orgs.services import RuleError, members_query
from mpro.workorders.models import Comment, CostEntry, TimeEntry, Timer, WorkOrder
from mpro.workorders.services import MENTION_RE, _set_assignees, label, touch, wo_settings

REACTIONS = ("👍", "👀", "✅", "🎉", "❤️", "⚠️")


# ---- rates -----------------------------------------------------------------------------------
def rate_for(org_id: uuid.UUID, user_id: uuid.UUID) -> int:
    m = db.session.scalars(select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id)).first()
    if m is not None and m.hourly_rate_cents is not None:
        return m.hourly_rate_cents
    return int(wo_settings(org_id)["default_hourly_rate_cents"])


def can_see_rates(m: Membership) -> bool:
    return can(m, "wo.rates.view") or bool(wo_settings(m.org_id)["rates_visible_to_all"])


# ---- comments --------------------------------------------------------------------------------
def parse_mentions(org_id: uuid.UUID, body: str) -> dict[str, list[str]]:
    users: list[str] = []
    teams: list[str] = []
    for _, kind, ident in MENTION_RE.findall(body or ""):
        try:
            uid = uuid.UUID(ident)
        except ValueError:
            continue
        if kind == "user":
            ok = db.session.scalar(
                members_query(org_id).with_only_columns(Membership.id).where(Membership.user_id == uid)
            )
            if ok and str(uid) not in users:
                users.append(str(uid))
        else:
            ok = db.session.scalar(
                select(Team.id).where(Team.org_id == org_id, Team.id == uid, Team.deleted_at.is_(None))
            )
            if ok and str(uid) not in teams:
                teams.append(str(uid))
    return {"users": users, "teams": teams}


def _person(u: Any) -> dict[str, Any] | None:
    from mpro.workorders.queries import _person as person

    return person(u)


def comment_dict(c: Comment, files: list[Any] | None = None) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "body": "" if c.deleted_at else c.body,
        "deleted": c.deleted_at is not None,
        "author": _person(c.author),
        "external_name": c.external_name or "",  # written through a shared link (0.5.0)
        "mentions": c.mentions or {"users": [], "teams": []},
        "reactions": c.reactions or {},
        "files": [link_dict(x) for x in (files or [])] if not c.deleted_at else [],
        "created_at": iso(c.created_at),
        "edited_at": iso(c.edited_at),
    }


def add_comment(
    org: Organization, m: Membership, wo: WorkOrder, body: str, file_ids: list[Any] | None = None
) -> Comment:
    body = (body or "").strip()
    if not body and not file_ids:
        raise RuleError("Write a comment or attach a file.", 422)
    if len(body) > 10000:
        raise RuleError("Comments can be up to 10,000 characters.", 422)
    mentions = parse_mentions(org.id, body)
    c = Comment(
        org_id=org.id, entity_type="work_order", entity_id=wo.id, author_id=m.user_id, body=body, mentions=mentions
    )
    db.session.add(c)
    db.session.flush()
    for fid in file_ids or []:
        f = db.session.get(FileObject, _uuid(fid))
        if f is None or f.org_id != org.id or f.uploaded_by_id != m.user_id:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        attach(f, "comment", c.id, "comment")
    s = wo_settings(org.id)
    added: list[str] = []
    if s["mention_assigns"] and (mentions["users"] or mentions["teams"]):
        current = [("user", a.user_id) if a.user_id else ("team", a.team_id) for a in wo.assignees]
        from mpro.workorders.services import _resolve_assignees

        wanted = [f"user:{u}" for u in mentions["users"]] + [f"team:{t}" for t in mentions["teams"]]
        try:
            extra = _resolve_assignees(org.id, wanted)
        except RuleError:  # e.g. a requester was mentioned; mentioning still works, assigning doesn't
            extra = []
        new_pairs = current + [p for p in extra if p not in current]
        added, _ = _set_assignees(wo, new_pairs)  # type: ignore[arg-type]
        if added:
            wo.version += 1
    touch(wo, m.user_id)
    emit(
        "wo.commented",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary="Commented",
        data={"comment_id": c.id, "mentions": mentions, "excerpt": body[:200]},
    )
    if added:
        emit(
            "wo.assigned",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Assigned by mention",
            data={"added": added},
        )
    db.session.commit()
    return c


def edit_comment(m: Membership, wo: WorkOrder, c: Comment, body: str) -> Comment:
    if c.author_id != m.user_id:
        raise RuleError("You can only edit your own comments.", 403)
    if c.deleted_at:
        raise RuleError("That comment was deleted.", 409)
    body = (body or "").strip()
    if not body:
        raise RuleError("A comment can't be empty. Delete it instead.", 422)
    if len(body) > 10000:
        raise RuleError("Comments can be up to 10,000 characters.", 422)
    c.body, c.mentions, c.edited_at = body, parse_mentions(m.org_id, body), utcnow()
    db.session.commit()
    return c


def delete_comment(m: Membership, wo: WorkOrder, c: Comment) -> None:
    if c.author_id != m.user_id and not can_on(m, "wo.delete", wo):
        raise RuleError("You can only delete your own comments.", 403)
    c.deleted_at = utcnow()
    emit(
        "wo.comment_deleted",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary="Deleted a comment",
    )
    db.session.commit()


def react(m: Membership, c: Comment, emoji: str) -> Comment:
    if emoji not in REACTIONS:
        raise RuleError("Unknown reaction.", 422)
    if c.deleted_at:
        raise RuleError("That comment was deleted.", 409)
    r = {k: list(v) for k, v in (c.reactions or {}).items()}
    who = r.setdefault(emoji, [])
    uid = str(m.user_id)
    if uid in who:
        who.remove(uid)
    else:
        who.append(uid)
    c.reactions = {k: v for k, v in r.items() if v}
    db.session.commit()
    return c


def comments_for(wo: WorkOrder) -> list[dict[str, Any]]:
    cs = db.session.scalars(
        select(Comment)
        .where(Comment.entity_type == "work_order", Comment.entity_id == wo.id)
        .order_by(Comment.created_at)
    ).all()
    files = links_for_many("comment", [c.id for c in cs])
    return [comment_dict(c, files.get(c.id)) for c in cs]


def _uuid(v: Any) -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError("That record doesn't exist.", 422) from e


# ---- time ------------------------------------------------------------------------------------
def time_dict(t: TimeEntry, show_rates: bool) -> dict[str, Any]:
    cost = round(t.minutes * t.effective_rate_cents / 60)
    return {
        "id": str(t.id),
        "user": {"id": str(t.user.id), "name": t.user.name, "initials": t.user.initials},
        "minutes": t.minutes,
        "time_type": t.time_type,
        "rate_cents": t.rate_cents if show_rates else None,
        "effective_rate_cents": t.effective_rate_cents if show_rates else None,
        "cost_cents": cost if show_rates else None,
        "note": t.note,
        "started_at": iso(t.started_at),
        "created_at": iso(t.created_at),
    }


def _check_time_type(org_id: uuid.UUID, t: str) -> str:
    types = wo_settings(org_id)["time_types"]
    if t not in types:
        raise RuleError("Pick one of the time types: " + ", ".join(types) + ".", 422)
    return t


def add_time(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> TimeEntry:
    user_id = _uuid(data.get("user_id") or m.user_id)
    if user_id != m.user_id and not can(m, "users.manage"):
        raise RuleError("Only managers can log time for someone else.", 403)
    if not db.session.scalar(
        members_query(org.id).with_only_columns(Membership.id).where(Membership.user_id == user_id)
    ):
        raise RuleError("That person isn't in this organization.", 422)
    try:
        minutes = int(data.get("minutes") or 0)
    except (TypeError, ValueError) as e:
        raise RuleError("Time must be whole minutes.", 422) from e
    if minutes <= 0 or minutes > 60 * 24 * 7:
        raise RuleError("Log between 1 minute and 7 days.", 422)
    rate = data.get("rate_cents")
    if rate is not None:
        if not can_see_rates(m):
            raise RuleError("You can't set hourly rates.", 403)
        if not isinstance(rate, int) or rate < 0 or rate > 10_000_000:
            raise RuleError("Enter a rate between 0 and 100,000 per hour (0 for no labor cost).", 422)
    from mpro.workorders.services import _dt

    t = TimeEntry(
        org_id=org.id,
        work_order_id=wo.id,
        user_id=user_id,
        minutes=minutes,
        time_type=_check_time_type(org.id, str(data.get("time_type") or wo_settings(org.id)["time_types"][0])),
        rate_cents=rate,
        effective_rate_cents=rate if rate is not None else rate_for(org.id, user_id),
        note=str(data.get("note") or "").strip()[:500],
        started_at=_dt(data.get("started_at"), "Start time"),
        created_by_id=m.user_id,
    )
    db.session.add(t)
    db.session.flush()
    touch(wo, m.user_id)
    emit(
        "wo.time_logged",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Logged {fmt_minutes(minutes)} ({t.time_type})",
        data={"time_entry_id": t.id, "minutes": minutes, "user_id": user_id},
    )
    db.session.commit()
    return t


def delete_time(m: Membership, wo: WorkOrder, t: TimeEntry) -> None:
    if t.user_id != m.user_id and t.created_by_id != m.user_id and not can(m, "users.manage"):
        raise RuleError("You can only remove your own time.", 403)
    db.session.delete(t)
    touch(wo, m.user_id)
    emit(
        "wo.time_removed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Removed {fmt_minutes(t.minutes)} of time",
    )
    db.session.commit()


def client_time(value: Any) -> datetime | None:
    """When the phone says something happened (offline changes are sent later, r090): an ISO time from the last
    week and not in the future. Anything else means "now"."""
    if not value:
        return None
    try:
        at = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        return None
    now = utcnow()
    return at if now - timedelta(days=7) <= at <= now + timedelta(minutes=1) else None


def _my_timer(wo: WorkOrder, m: Membership) -> Timer | None:
    return db.session.scalars(select(Timer).where(Timer.work_order_id == wo.id, Timer.user_id == m.user_id)).first()


def timer_seconds(t: Timer, until: datetime | None = None) -> int:
    run = 0 if t.paused_at is not None else max(0, int(((until or utcnow()) - t.started_at).total_seconds()))
    return (t.accumulated_seconds or 0) + run


def start_timer(org: Organization, m: Membership, wo: WorkOrder, time_type: str | None = None, at: Any = None) -> Timer:
    if wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to time more work.", 409)
    existing = _my_timer(wo, m)
    if existing:
        if existing.paused_at is not None:  # starting a paused timer resumes it
            return resume_timer(org, m, wo, at)
        return existing
    t = Timer(
        org_id=org.id,
        work_order_id=wo.id,
        user_id=m.user_id,
        time_type=_check_time_type(org.id, time_type or wo_settings(org.id)["time_types"][0]),
        started_at=client_time(at) or utcnow(),
        accumulated_seconds=0,
    )
    db.session.add(t)
    if wo.status == "open":  # starting work moves the WO to In Progress, as on MaintainX mobile
        from mpro.workorders.services import set_status

        set_status(org, m, wo, "in_progress", commit=False)
    db.session.commit()
    return t


def pause_timer(org: Organization, m: Membership, wo: WorkOrder, at: Any = None) -> Timer:
    t = _my_timer(wo, m)
    if t is None:
        raise RuleError("You don't have a timer running on this work order.", 409)
    if t.paused_at is None:
        when = max(client_time(at) or utcnow(), t.started_at)
        t.accumulated_seconds = timer_seconds(t, when)
        t.paused_at = when
        emit(
            "wo.timer_paused",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Paused a timer",
        )
        db.session.commit()
    return t


def resume_timer(org: Organization, m: Membership, wo: WorkOrder, at: Any = None) -> Timer:
    t = _my_timer(wo, m)
    if t is None:
        raise RuleError("You don't have a timer on this work order.", 409)
    if t.paused_at is not None:
        t.started_at = max(client_time(at) or utcnow(), t.paused_at)
        t.paused_at = None
        emit(
            "wo.timer_resumed",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Resumed a timer",
        )
        db.session.commit()
    return t


def stop_timer(
    org: Organization, m: Membership, wo: WorkOrder, discard: bool = False, at: Any = None
) -> TimeEntry | None:
    t = _my_timer(wo, m)
    if t is None:
        raise RuleError("You don't have a timer running on this work order.", 409)
    end = max(client_time(at) or utcnow(), t.started_at)
    seconds = timer_seconds(t, end)
    minutes = max(1, round(seconds / 60))
    started, ttype = end - timedelta(seconds=seconds), t.time_type
    db.session.delete(t)
    if discard:
        db.session.commit()
        return None
    return add_time(org, m, wo, {"minutes": minutes, "time_type": ttype, "started_at": started})


def timers_for(wo: WorkOrder) -> list[dict[str, Any]]:
    from mpro.auth.models import User

    out = []
    for t in db.session.scalars(select(Timer).where(Timer.work_order_id == wo.id)).all():
        u = db.session.get(User, t.user_id)
        out.append(
            {
                "user": {"id": str(t.user_id), "name": u.name if u else "", "initials": u.initials if u else ""},
                "started_at": iso(t.started_at),
                "time_type": t.time_type,
                "paused": t.paused_at is not None,
                "elapsed_seconds": timer_seconds(t),
            }
        )
    return out


def my_timers(m: Membership) -> list[dict[str, Any]]:
    rows = db.session.execute(
        select(Timer, WorkOrder)
        .join(WorkOrder, WorkOrder.id == Timer.work_order_id)
        .where(Timer.org_id == m.org_id, Timer.user_id == m.user_id)
    ).all()
    return [
        {
            "work_order_id": str(w.id),
            "number": w.number,
            "title": w.title,
            "started_at": iso(t.started_at),
            "paused": t.paused_at is not None,
            "elapsed_seconds": timer_seconds(t),
        }
        for t, w in rows
    ]


# ---- other costs -----------------------------------------------------------------------------
def cost_dict(c: CostEntry, receipts: list[Any] | None = None) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "user": {"id": str(c.user.id), "name": c.user.name, "initials": c.user.initials} if c.user else None,
        "amount_cents": c.amount_cents,
        "cost_type": c.cost_type,
        "description": c.description,
        "receipts": [link_dict(x) for x in (receipts or [])],
        "created_at": iso(c.created_at),
    }


def add_cost(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> CostEntry:
    try:
        cents = int(data.get("amount_cents"))  # type: ignore[arg-type]
    except (TypeError, ValueError) as e:
        raise RuleError("Enter an amount.", 422) from e
    if cents <= 0 or cents > 10**11:
        raise RuleError("Enter an amount above zero.", 422)
    types = wo_settings(org.id)["cost_types"]
    ctype = str(data.get("cost_type") or types[-1])
    if ctype not in types:
        raise RuleError("Pick one of the cost types: " + ", ".join(types) + ".", 422)
    user_id = _uuid(data["user_id"]) if data.get("user_id") else m.user_id
    if not db.session.scalar(
        members_query(org.id).with_only_columns(Membership.id).where(Membership.user_id == user_id)
    ):
        raise RuleError("That person isn't in this organization.", 422)
    c = CostEntry(
        org_id=org.id,
        work_order_id=wo.id,
        user_id=user_id,
        amount_cents=cents,
        cost_type=ctype,
        description=str(data.get("description") or "").strip()[:500],
        created_by_id=m.user_id,
    )
    db.session.add(c)
    db.session.flush()
    for fid in data.get("file_ids") or []:
        f = db.session.get(FileObject, _uuid(fid))
        if f is None or f.org_id != org.id or f.uploaded_by_id != m.user_id:
            raise RuleError("One of the receipts couldn't be found. Upload it again.", 422)
        attach(f, "cost", c.id, "receipt")
    touch(wo, m.user_id)
    emit(
        "wo.cost_added",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Added a {ctype.lower()} cost of {cents / 100:,.2f}",
        data={"cost_id": c.id, "amount_cents": cents},
    )
    db.session.commit()
    return c


def delete_cost(m: Membership, wo: WorkOrder, c: CostEntry) -> None:
    if c.created_by_id != m.user_id and not can(m, "users.manage"):
        raise RuleError("You can only remove costs you added.", 403)
    db.session.delete(c)
    touch(wo, m.user_id)
    emit("wo.cost_removed", entity_type="work_order", entity_id=wo.id, entity_label=label(wo), summary="Removed a cost")
    db.session.commit()


def costs_summary(m: Membership, wo: WorkOrder) -> dict[str, Any]:
    show = can_see_rates(m)
    times = db.session.scalars(
        select(TimeEntry).where(TimeEntry.work_order_id == wo.id).order_by(TimeEntry.created_at)
    ).all()
    costs = db.session.scalars(
        select(CostEntry).where(CostEntry.work_order_id == wo.id).order_by(CostEntry.created_at)
    ).all()
    receipts = links_for_many("cost", [c.id for c in costs])
    labor = sum(round(t.minutes * t.effective_rate_cents / 60) for t in times)
    other = sum(c.amount_cents for c in costs)
    from mpro.parts.services import parts_cost  # 0.5.0: parts used count towards the WO cost

    parts_cents = int((parts_cost(wo.id) * 100).to_integral_value()) if can(m, "costs.view") else None
    return {
        "parts_cents": parts_cents,
        "time": [time_dict(t, show) for t in times],
        "costs": [cost_dict(c, receipts.get(c.id)) for c in costs],
        "timers": timers_for(wo),
        "total_minutes": sum(t.minutes for t in times),
        "labor_cents": labor if show else None,
        "other_cents": other,
        "total_cents": (labor + other + (parts_cents or 0)) if show else None,
        "rates_visible": show,
    }


def fmt_minutes(n: int) -> str:
    h, mnt = divmod(int(n), 60)
    return f"{h} h {mnt} min" if h and mnt else f"{h} h" if h else f"{mnt} min"


# ---- activity feed ---------------------------------------------------------------------------
def activity(wo: WorkOrder) -> list[dict[str, Any]]:
    """Comments and system history in time order (MaintainX shows both in the WO feed)."""
    events = db.session.scalars(
        select(DomainEvent)
        .where(DomainEvent.entity_type == "work_order", DomainEvent.entity_id == str(wo.id))
        .order_by(DomainEvent.created_at)
    ).all()
    items: list[dict[str, Any]] = [
        {"kind": "event", "at": iso(e.created_at), **_public_event(e.to_dict())}
        for e in events
        if e.type != "wo.commented"
    ]
    items += [{"kind": "comment", "at": c["created_at"], **c} for c in comments_for(wo)]
    items.sort(key=lambda x: x["at"] or "")
    return items


def _public_event(d: dict[str, Any]) -> dict[str, Any]:
    """Feed items are visible to everyone who can see the work order; IP addresses stay in the admin audit log."""
    d.pop("ip", None)
    return d


def attachments_for(wo: WorkOrder) -> list[dict[str, Any]]:
    return [link_dict(x) for x in links_for("work_order", wo.id)]


def counts_for(ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = db.session.execute(
        select(Comment.entity_id, func.count())
        .where(Comment.entity_id.in_(ids), Comment.deleted_at.is_(None))
        .group_by(Comment.entity_id)
    ).all()
    return {r[0]: int(r[1]) for r in rows}
