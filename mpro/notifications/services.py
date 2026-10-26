"""Notifications: business rules (G-04).

Pipeline (r271): domain event → route (who cares?) → each person's preferences → channels.

* **In-app**: a `Notification` row (the bell and /notifications), pushed live on topic `user:<id>`.
* **Email**: instant, or batched into an hourly / daily digest; held during quiet hours and pauses.
* **Web push**: sent straight away unless the person is in quiet hours or paused (then skipped, not delayed).

Routing is an event consumer (G-05): services never call this module. Time-based notices (due soon, overdue,
escalations) come from a periodic job that emits `wo.due_soon`, `wo.overdue` and `wo.escalated` events, which go
through the same pipeline.
"""

from __future__ import annotations

import copy
import html
import logging
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from flask import current_app
from sqlalchemy import delete, func, select, update

from mpro.auth.models import User
from mpro.core import realtime
from mpro.core.events import DomainEvent, consumer, emit
from mpro.core.jobs import enqueue, job, periodic
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.notifications.models import (
    EscalationRule,
    Notification,
    NotificationPref,
    PushKey,
    PushSubscription,
    WorkOrderNotice,
)
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import RuleError

log = logging.getLogger(__name__)

# ============================================================================ catalogue
# key -> (label, category, default channels). The settings page lists them in this order.
EVENT_TYPES: dict[str, tuple[str, str, dict[str, bool]]] = {
    "wo.assigned": ("Assigned to me or my team", "work_orders", {"in_app": True, "email": True, "push": True}),
    "wo.status_changed": ("Status changes", "work_orders", {"in_app": True, "email": False, "push": True}),
    "wo.commented": ("New comments", "work_orders", {"in_app": True, "email": False, "push": True}),
    "wo.mentioned": ("Mentions", "work_orders", {"in_app": True, "email": True, "push": True}),
    "wo.due_soon": ("Due soon", "work_orders", {"in_app": True, "email": False, "push": True}),
    "wo.overdue": ("Overdue", "work_orders", {"in_app": True, "email": True, "push": True}),
    "wo.escalated": ("Escalations", "work_orders", {"in_app": True, "email": True, "push": True}),
    "wo.approval": (
        "Completed work approved or rejected",
        "work_orders",
        {"in_app": True, "email": False, "push": True},
    ),
    "wo.parts_short": (
        "Not enough parts in stock when work was completed",
        "work_orders",
        {"in_app": True, "email": True, "push": False},
    ),
    "request.new": ("New requests to review", "requests", {"in_app": True, "email": True, "push": True}),
    "request.update": (
        "My requests: approved, declined, done, comments",
        "requests",
        {"in_app": True, "email": True, "push": True},
    ),
    "po.needs_approval": (
        "Purchase orders to review or approve",
        "purchasing",
        {"in_app": True, "email": True, "push": False},
    ),
    "po.decided": (
        "My purchase orders approved, rejected or canceled",
        "purchasing",
        {"in_app": True, "email": True, "push": False},
    ),
    "po.vendor": (
        "Vendor replies to my purchase orders",
        "purchasing",
        {"in_app": True, "email": True, "push": True},
    ),
    "message.direct": ("Direct messages and mentions", "messages", {"in_app": False, "email": False, "push": True}),
    "message.other": (
        "Other messages in my conversations",
        "messages",
        {"in_app": False, "email": False, "push": True},
    ),
}
CATEGORIES = {
    "work_orders": "Work orders",
    "requests": "Requests",
    "purchasing": "Purchase orders",
    "messages": "Messages",
    "system": "MPro",
}
CHANNELS = ("in_app", "email", "push")
FREQUENCIES = ("instant", "hourly", "daily")
MESSAGE_LEVELS = ("all", "direct", "none")  # all | DMs and mentions only | nothing (r308)

DEFAULT_PREFS: dict[str, Any] = {
    "channels": {k: dict(v[2]) for k, v in EVENT_TYPES.items()},
    # which work orders' events reach me (r286): created by me, assigned to me, assigned to my teams
    "groups": {"created_by_me": True, "assigned_to_me": True, "my_teams": True},
    "comments": "all",  # all | mentions
    "messages": "all",
    "email_frequency": "instant",
    "digest_hour": 7,
    "quiet": {"enabled": False, "start": "22:00", "end": "07:00", "weekends": False},
}

ORG_DEFAULTS: dict[str, Any] = {
    "due_soon_hours": 24,  # 0 turns "due soon" off
    "overdue_team_ids": [],  # teams told when any work order becomes overdue (r083)
    "weekly_report": False,  # Monday report email (r311)
    "weekly_report_user_ids": [],  # empty = owners and administrators
    "weekly_report_last": "",  # ISO week already sent, e.g. "2026-W43"
    "brand_color": "",  # email branding (r312); empty = MPro blue
    "brand_logo_file_id": "",
    "brand_info": "",  # a line under the logo: address, phone, website
    "notify_from": "",  # ISO time; events before it don't notify (set when demo data is seeded)
}
register_defaults("notifications", ORG_DEFAULTS)

CLOSED = ("done", "canceled")
STALE_DAYS = 7  # overdue work orders older than this don't notify (keeps upgrades from flooding inboxes)
MAX_DIGEST = 50


# ============================================================================ preferences
def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if k not in out:
            continue
        if isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _merge(out[k], v) if k != "channels" else _merge_channels(out[k], v)
        else:
            out[k] = v
    return out


def _merge_channels(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k in out and isinstance(v, dict):
            out[k].update({c: bool(x) for c, x in v.items() if c in CHANNELS})
    return out


def _pref_row(org_id: uuid.UUID, user_id: uuid.UUID) -> NotificationPref | None:
    return db.session.scalars(
        select(NotificationPref).where(NotificationPref.org_id == org_id, NotificationPref.user_id == user_id)
    ).first()


def prefs_for(org_id: uuid.UUID, user_id: uuid.UUID, row: NotificationPref | None = None) -> dict[str, Any]:
    row = row or _pref_row(org_id, user_id)
    return _merge(DEFAULT_PREFS, row.prefs if row else {})


def _hhmm(v: Any, what: str) -> str:
    try:
        t = time.fromisoformat(str(v))
    except ValueError:
        raise RuleError(f"{what} must be a time like 22:00.", 422) from None
    return f"{t.hour:02d}:{t.minute:02d}"


def validate_prefs(data: dict[str, Any]) -> dict[str, Any]:
    """Clean a (partial) settings update from the client."""
    if not isinstance(data, dict):
        raise RuleError("Send the settings as an object.", 422)
    out: dict[str, Any] = {}
    if "channels" in data:
        ch = data["channels"]
        if not isinstance(ch, dict):
            raise RuleError("channels must be an object.", 422)
        out["channels"] = {
            k: {c: bool(x) for c, x in v.items() if c in CHANNELS}
            for k, v in ch.items()
            if k in EVENT_TYPES and isinstance(v, dict)
        }
    if "groups" in data:
        g = data["groups"]
        if not isinstance(g, dict):
            raise RuleError("groups must be an object.", 422)
        out["groups"] = {k: bool(v) for k, v in g.items() if k in DEFAULT_PREFS["groups"]}
    if "comments" in data:
        if data["comments"] not in ("all", "mentions"):
            raise RuleError("Comments must be all or mentions.", 422)
        out["comments"] = data["comments"]
    if "messages" in data:
        if data["messages"] not in MESSAGE_LEVELS:
            raise RuleError("Messages must be all, direct or none.", 422)
        out["messages"] = data["messages"]
    if "email_frequency" in data:
        if data["email_frequency"] not in FREQUENCIES:
            raise RuleError("Email can be instant, hourly or daily.", 422)
        out["email_frequency"] = data["email_frequency"]
    if "digest_hour" in data:
        try:
            h = int(data["digest_hour"])
        except (TypeError, ValueError):
            raise RuleError("The digest hour must be 0–23.", 422) from None
        if not 0 <= h <= 23:
            raise RuleError("The digest hour must be 0–23.", 422)
        out["digest_hour"] = h
    if "quiet" in data:
        q = data["quiet"]
        if not isinstance(q, dict):
            raise RuleError("quiet must be an object.", 422)
        clean: dict[str, Any] = {}
        if "enabled" in q:
            clean["enabled"] = bool(q["enabled"])
        if "weekends" in q:
            clean["weekends"] = bool(q["weekends"])
        if "start" in q:
            clean["start"] = _hhmm(q["start"], "Quiet hours start")
        if "end" in q:
            clean["end"] = _hhmm(q["end"], "Quiet hours end")
        out["quiet"] = clean
    return out


def save_prefs(org_id: uuid.UUID, user: User, data: dict[str, Any]) -> dict[str, Any]:
    clean = validate_prefs(data)
    row = _pref_row(org_id, user.id)
    if row is None:
        row = NotificationPref(org_id=org_id, user_id=user.id, prefs={})
        db.session.add(row)
    stored = copy.deepcopy(row.prefs or {})
    for k, v in clean.items():
        if isinstance(v, dict) and isinstance(stored.get(k), dict):
            if k == "channels":
                for ek, ev in v.items():
                    stored[k].setdefault(ek, {}).update(ev)
            else:
                stored[k].update(v)
        else:
            stored[k] = v
    row.prefs = stored
    emit(
        "notifications.prefs_changed",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Changed notification settings",
        data={"keys": sorted(clean)},
        org_id=org_id,
        actor=user,
    )
    db.session.commit()
    return settings_dict(org_id, user)


def pause(org_id: uuid.UUID, user: User, minutes: int | None) -> dict[str, Any]:
    """Pause push and email for a while (r309). minutes=None or 0 resumes."""
    row = _pref_row(org_id, user.id)
    if row is None:
        row = NotificationPref(org_id=org_id, user_id=user.id, prefs={})
        db.session.add(row)
    if minutes:
        if not 1 <= minutes <= 60 * 24 * 14:
            raise RuleError("Pause for between a minute and two weeks.", 422)
        row.paused_until = utcnow() + timedelta(minutes=minutes)
    else:
        row.paused_until = None
    emit(
        "notifications.paused" if minutes else "notifications.resumed",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary=f"Paused notifications for {minutes} minutes" if minutes else "Resumed notifications",
        org_id=org_id,
        actor=user,
    )
    db.session.commit()
    return settings_dict(org_id, user)


def settings_dict(org_id: uuid.UUID, user: User) -> dict[str, Any]:
    row = _pref_row(org_id, user.id)
    paused = row.paused_until if row and row.paused_until and row.paused_until > utcnow() else None
    return {
        "prefs": prefs_for(org_id, user.id, row),
        "paused_until": iso(paused),
        "catalogue": [
            {"key": k, "label": v[0], "category": v[1], "category_label": CATEGORIES[v[1]]}
            for k, v in EVENT_TYPES.items()
        ],
        "push": {
            "available": True,
            "public_key": vapid_public_key(),
            "devices": [s.to_dict() for s in _subs(user.id)],
        },
    }


# ============================================================================ quiet hours
def _org_tz(org: Organization | None) -> ZoneInfo:
    try:
        return ZoneInfo(org.timezone if org and org.timezone else "UTC")
    except Exception:  # noqa: BLE001
        return ZoneInfo("UTC")


def in_quiet_hours(prefs: dict[str, Any], tz: ZoneInfo, now: datetime | None = None) -> bool:
    q = prefs.get("quiet") or {}
    local = (now or utcnow()).astimezone(tz)
    if q.get("weekends") and local.weekday() >= 5:
        return True
    if not q.get("enabled"):
        return False
    start, end = time.fromisoformat(q.get("start", "22:00")), time.fromisoformat(q.get("end", "07:00"))
    t = local.time().replace(second=0, microsecond=0)
    if start == end:
        return False
    if start < end:
        return start <= t < end
    return t >= start or t < end  # crosses midnight


def held(row: NotificationPref | None, prefs: dict[str, Any], tz: ZoneInfo, now: datetime | None = None) -> bool:
    """True while push and email are held back: paused, or in quiet hours."""
    now = now or utcnow()
    if row is not None and row.paused_until and row.paused_until > now:
        return True
    return in_quiet_hours(prefs, tz, now)


# ============================================================================ recipients
@dataclass
class Target:
    user_id: uuid.UUID
    kind: str
    title: str
    body: str = ""
    link: str = ""
    entity_type: str = ""
    entity_id: str = ""
    groups: set[str] = field(default_factory=set)  # why they get it (r286); empty = always
    check: Callable[[Membership], bool] | None = None  # visibility check for this record


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError):
        return None


def team_members(org_id: uuid.UUID, team_ids: Iterable[Any]) -> list[uuid.UUID]:
    ids = [t for t in (_uuid(x) for x in team_ids) if t]
    if not ids:
        return []
    return list(
        db.session.scalars(
            select(TeamMember.user_id)
            .join(Team, Team.id == TeamMember.team_id)
            .where(TeamMember.org_id == org_id, TeamMember.team_id.in_(ids), Team.deleted_at.is_(None))
            .distinct()
        )
    )


def members_who_can(org_id: uuid.UUID, action: str) -> list[uuid.UUID]:
    rows = db.session.scalars(
        select(Membership).where(Membership.org_id == org_id, Membership.deleted_at.is_(None))
    ).all()
    return [m.user_id for m in rows if can(m, action)]


def _wo(org_id: uuid.UUID, entity_id: str) -> Any:
    from mpro.workorders.models import WorkOrder

    wid = _uuid(entity_id)
    if wid is None:
        return None
    wo = db.session.get(WorkOrder, wid)
    return wo if wo is not None and wo.org_id == org_id and wo.deleted_at is None else None


def _watchers(wo: Any) -> dict[uuid.UUID, set[str]]:
    out: dict[uuid.UUID, set[str]] = {}
    if wo.created_by_id:
        out.setdefault(wo.created_by_id, set()).add("created_by_me")
    team_ids = []
    for a in wo.assignees:
        if a.user_id:
            out.setdefault(a.user_id, set()).add("assigned_to_me")
        elif a.team_id:
            team_ids.append(a.team_id)
    for uid in team_members(wo.org_id, team_ids):
        out.setdefault(uid, set()).add("my_teams")
    return out


def _wo_check(wo: Any) -> Callable[[Membership], bool]:
    from mpro.workorders.services import can_see

    return lambda m: can_see(m, wo)


def _wo_label(wo: Any) -> str:
    return f"#{wo.number} {wo.title}"


def _route_wo(ev: DomainEvent) -> list[Target]:
    wo = _wo(ev.org_id, ev.entity_id) if ev.org_id else None
    if wo is None:
        return []
    label, link, check = _wo_label(wo), f"/work-orders/{wo.id}", _wo_check(wo)
    who = ev.actor_label or "Someone"
    base: dict[str, Any] = {"link": link, "entity_type": "work_order", "entity_id": str(wo.id), "check": check}
    data = ev.data or {}
    out: list[Target] = []
    t = ev.type
    if t == "wo.assigned":
        if ev.summary.startswith("Assigned by mention"):
            return []  # the mention notification already covers it
        users: set[uuid.UUID] = set()
        team_ids: list[uuid.UUID] = []
        for item in data.get("added") or []:
            kind, _, raw = str(item).partition(":")
            uid = _uuid(raw)
            if uid is None:
                continue
            if kind == "user":
                users.add(uid)
            elif kind == "team":
                team_ids.append(uid)
        for uid in users:
            out.append(Target(uid, "wo.assigned", f"{who} assigned you {label}", wo.description[:200], **base))
        for tid in team_ids:
            team = db.session.get(Team, tid)
            for uid in team_members(wo.org_id, [tid]):
                if uid not in users:
                    out.append(
                        Target(
                            uid,
                            "wo.assigned",
                            f"{who} assigned {team.name if team else 'your team'} to {label}",
                            wo.description[:200],
                            groups={"my_teams"},
                            **base,
                        )
                    )
        return out
    if t == "wo.commented":
        mentions = data.get("mentions") or {}
        mentioned = {u for u in (_uuid(x) for x in mentions.get("users") or []) if u}
        mentioned |= set(team_members(wo.org_id, mentions.get("teams") or []))
        excerpt = str(data.get("excerpt") or "")
        for uid in mentioned:
            out.append(Target(uid, "wo.mentioned", f"{who} mentioned you on {label}", excerpt, **base))
        for uid, groups in _watchers(wo).items():
            if uid not in mentioned:
                out.append(Target(uid, "wo.commented", f"{who} commented on {label}", excerpt, groups=groups, **base))
        return out
    watchers = _watchers(wo)
    if t == "wo.status_changed":
        title = f"{label}: {ev.summary}" if ev.summary else f"{label} changed status"
        body = str(data.get("comment") or "")
        return [Target(uid, "wo.status_changed", title, body, groups=g, **base) for uid, g in watchers.items()]
    if t in ("wo.approved", "wo.rejected"):
        verb = "approved" if t == "wo.approved" else "rejected"
        return [
            Target(uid, "wo.approval", f"{who} {verb} the work on {label}", ev.summary, groups=g, **base)
            for uid, g in watchers.items()
        ]
    if t == "wo.due_soon":
        due = _fmt_due(wo, data.get("due_at"))
        return [
            Target(uid, "wo.due_soon", f"{label} is due {due}", "", groups=g, **base) for uid, g in watchers.items()
        ]
    if t == "wo.overdue":
        due = _fmt_due(wo, data.get("due_at"))
        out = [
            Target(uid, "wo.overdue", f"{label} is overdue", f"It was due {due}.", groups=g, **base)
            for uid, g in watchers.items()
        ]
        team_ids = get_settings(wo.org_id, "notifications")["overdue_team_ids"]
        for uid in team_members(wo.org_id, team_ids):
            if uid not in watchers:
                out.append(Target(uid, "wo.overdue", f"{label} is overdue", f"It was due {due}.", **base))
        return out
    if t == "wo.parts_short":  # MP-131: Done used what was in stock; tell the people on it and the parts team
        body = "; ".join(str(x) for x in (data.get("lines") or []))[:2000]
        title = f"{label} was completed without enough parts"
        out = [Target(uid, "wo.parts_short", title, body, groups=g, **base) for uid, g in watchers.items()]
        parts_teams = get_settings(wo.org_id, "parts").get("escalation_team_ids") or []
        for uid in team_members(wo.org_id, parts_teams):
            if uid not in watchers:
                out.append(Target(uid, "wo.parts_short", title, body, **base))
        return out
    if t == "wo.escalated":
        body = str(data.get("reason") or "")
        return [
            Target(uid, "wo.escalated", f"Escalated: {label}", body, **base)
            for uid in (u for u in (_uuid(x) for x in data.get("user_ids") or []) if u)
        ]
    return []


def _fmt_due(wo: Any, due_iso: Any) -> str:
    from mpro.orgs.models import Organization as Org

    due = wo.due_at
    if not due:
        return "soon"
    org = db.session.get(Org, wo.org_id)
    return due.astimezone(_org_tz(org)).strftime("%b %d, %I:%M %p").replace(" 0", " ")


def _route_po(ev: DomainEvent) -> list[Target]:
    from mpro.purchasing.models import Approval, PurchaseOrder

    pid = _uuid(ev.entity_id)
    po = db.session.get(PurchaseOrder, pid) if pid else None
    if po is None or po.org_id != ev.org_id or po.deleted_at is not None:
        return []
    if ev.type == "purchase_order.created":
        status = po.status
    else:
        change = (ev.changes or {}).get("status")
        if not change:
            return []
        status = change[1]
    label = ev.entity_label or "A purchase order"
    who = ev.actor_label or "Someone"
    base: dict[str, Any] = {
        "link": f"/purchase-orders/{po.id}",
        "entity_type": "purchase_order",
        "entity_id": str(po.id),
    }

    def visible(m: Membership) -> bool:
        return can(m, "po.view") or m.user_id in (po.requested_by_id, po.created_by_id)

    if status == "requested":
        return [
            Target(uid, "po.needs_approval", f"{who} requested {label}", po.title or "", check=visible, **base)
            for uid in members_who_can(po.org_id, "po.manage")
        ]
    if status == "pending":
        steps = db.session.scalars(
            select(Approval).where(
                Approval.org_id == po.org_id,
                Approval.entity_type == "purchase_order",
                Approval.entity_id == po.id,
                Approval.status == "pending",
            )
        ).all()
        users: set[uuid.UUID] = set()
        generic = False
        for s in steps:
            listed = [u for u in (_uuid(x) for x in s.approver_user_ids or []) if u]
            listed += team_members(po.org_id, s.approver_team_ids or [])
            users |= set(listed)
            generic = generic or not listed
        if generic or not steps:
            users |= set(members_who_can(po.org_id, "po.approve"))
        return [
            Target(uid, "po.needs_approval", f"{label} needs your approval", po.title or "", check=visible, **base)
            for uid in users
        ]
    if status in ("approved", "rejected", "canceled"):
        verb = {"approved": "approved", "rejected": "rejected", "canceled": "canceled"}[status]
        body = (po.rejected_reason or "") if status == "rejected" else ""
        people = {u for u in (po.requested_by_id, po.created_by_id) if u}
        return [Target(uid, "po.decided", f"{who} {verb} {label}", body, check=visible, **base) for uid in people]
    return []


def _route_po_vendor(ev: DomainEvent) -> list[Target]:
    """The vendor answered through the PO link (r261): acknowledged, proposed another date, or declined."""
    from mpro.purchasing.models import PurchaseOrder

    pid = _uuid(ev.entity_id)
    po = db.session.get(PurchaseOrder, pid) if pid else None
    if po is None or po.org_id != ev.org_id or po.deleted_at is not None:
        return []
    data = ev.data or {}
    label = ev.entity_label or "A purchase order"
    who = str(data.get("responder_name") or "The vendor")
    if ev.type.endswith("acknowledged"):
        title = f"{who} acknowledged {label}"
    elif ev.type.endswith("proposed_date"):
        title = f"{who} proposed a new date for {label}: {data.get('proposed_date') or 'see the order'}"
    elif ev.type.endswith("declined"):
        title = f"{who} declined {label}"
    else:
        return []
    people = {u for u in (po.requested_by_id, po.created_by_id, po.approved_by_id) if u}

    def visible(m: Membership) -> bool:
        return can(m, "po.view") or m.user_id in people

    return [
        Target(uid, "po.vendor", title, str(data.get("note") or ""), link=f"/purchase-orders/{po.id}",
               entity_type="purchase_order", entity_id=str(po.id), check=visible)
        for uid in people
    ]  # fmt: skip


# Other workstreams' events (requests F1, messages F2) are routed by `_route_requests` / `_route_messages`.
def _route_requests(ev: DomainEvent) -> list[Target]:
    from mpro.notifications import routes_external

    return routes_external.requests(ev)


def _route_messages(ev: DomainEvent) -> list[Target]:
    from mpro.notifications import routes_external

    return routes_external.messages(ev)


ROUTES: list[tuple[str, Callable[[DomainEvent], list[Target]]]] = [
    ("wo.", _route_wo),
    ("purchase_order.created", _route_po),
    ("purchase_order.status_changed", _route_po),
    ("purchase_order.vendor_", _route_po_vendor),
    ("request.", _route_requests),
    ("message.", _route_messages),
]


# ============================================================================ delivery
def _member(org_id: uuid.UUID, user_id: uuid.UUID) -> Membership | None:
    m = db.session.scalars(
        select(Membership).where(
            Membership.org_id == org_id, Membership.user_id == user_id, Membership.deleted_at.is_(None)
        )
    ).first()
    if m is None or m.user is None or not m.user.active or m.user.deleted_at is not None:
        return None
    if m.org is None or m.org.deleted_at is not None:  # a deleted organization tells no one anything
        return None
    return m


def wants(prefs: dict[str, Any], t: Target) -> dict[str, bool]:
    """Which channels this person wants for this notification."""
    ch = dict(prefs["channels"].get(t.kind) or EVENT_TYPES[t.kind][2])
    if t.groups and not any(prefs["groups"].get(g, True) for g in t.groups):
        return {c: False for c in CHANNELS}
    if t.kind == "wo.commented" and prefs.get("comments") == "mentions":
        return {c: False for c in CHANNELS}
    if t.kind == "message.other" and prefs.get("messages") != "all":
        return {c: False for c in CHANNELS}
    if t.kind == "message.direct" and prefs.get("messages") == "none":
        return {c: False for c in CHANNELS}
    return {c: bool(ch.get(c)) for c in CHANNELS}


def deliver(ev: DomainEvent, targets: list[Target]) -> list[Notification]:
    """Turn routed targets into notifications for one event (in the caller's transaction)."""
    if ev.org_id is None or not targets:
        return []
    org = db.session.get(Organization, ev.org_id)
    if org is None or org.deleted_at is not None:
        return []
    tz = _org_tz(org)
    seen: set[uuid.UUID] = set()
    created: list[Notification] = []
    for t in targets:
        if t.user_id in seen or (ev.actor_id is not None and t.user_id == ev.actor_id):
            continue
        seen.add(t.user_id)
        if t.kind not in EVENT_TYPES:
            continue
        m = _member(ev.org_id, t.user_id)
        if m is None or (t.check is not None and not t.check(m)):
            continue
        row = _pref_row(ev.org_id, t.user_id)
        prefs = prefs_for(ev.org_id, t.user_id, row)
        ch = wants(prefs, t)
        if not any(ch.values()):
            continue
        exists = db.session.scalars(
            select(Notification.id).where(
                Notification.event_id == ev.id, Notification.user_id == t.user_id, Notification.kind == t.kind
            )
        ).first()
        if exists:
            continue
        n = Notification(
            org_id=ev.org_id,
            user_id=t.user_id,
            kind=t.kind,
            category=EVENT_TYPES[t.kind][1],
            title=t.title[:300],
            body=t.body[:2000],
            link=t.link[:500],
            entity_type=t.entity_type,
            entity_id=t.entity_id,
            actor_id=ev.actor_id,
            actor_label=ev.actor_label if ev.actor_id else "",
            event_id=ev.id,
            in_app=ch["in_app"],
            email_state="pending" if ch["email"] else "none",
            push_state="none",
            created_at=ev.created_at or utcnow(),
        )
        db.session.add(n)
        db.session.flush()
        quiet = held(row, prefs, tz)
        if ch["email"] and not quiet and prefs["email_frequency"] == "instant":
            _email_one(org, m.user, n)
        if ch["push"]:
            if quiet:
                n.push_state = "skipped"
            elif _subs(t.user_id):
                n.push_state = "queued"
                enqueue("notifications.push", {"id": str(n.id)}, org_id=ev.org_id, max_attempts=2)
        created.append(n)
        if n.in_app:
            realtime.publish(
                ev.org_id, f"user:{t.user_id}", {"type": "notification", "id": str(n.id)}, user_ids=[t.user_id]
            )
    return created


@consumer("")
def route_event(ev: DomainEvent) -> None:
    """The notification consumer: one savepoint per event so a bad route never blocks the outbox."""
    if ev.org_id is None:
        return
    since = get_settings(ev.org_id, "notifications").get("notify_from")
    if since and ev.created_at:
        try:
            if ev.created_at < datetime.fromisoformat(str(since).replace("Z", "+00:00")):
                return
        except ValueError:
            pass
    for prefix, fn in ROUTES:
        if not ev.type.startswith(prefix):
            continue
        try:
            with db.session.begin_nested():
                deliver(ev, fn(ev))
        except Exception:  # noqa: BLE001
            log.exception("Notification routing failed for %s %s", ev.type, ev.id)
        break


# ============================================================================ inbox
def inbox(
    org_id: uuid.UUID, user_id: uuid.UUID, *, unread: bool = False, limit: int = 30, before: str = ""
) -> dict[str, Any]:
    q = select(Notification).where(
        Notification.org_id == org_id, Notification.user_id == user_id, Notification.in_app.is_(True)
    )
    if unread:
        q = q.where(Notification.read_at.is_(None))
    if before:
        try:
            cut = datetime.fromisoformat(before.replace("Z", "+00:00"))
        except ValueError:
            raise RuleError("before must be a date and time.", 422) from None
        q = q.where(Notification.created_at < cut)
    limit = max(1, min(limit, 100))
    rows = db.session.scalars(q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [n.to_dict() for n in rows],
        "next": iso(rows[-1].created_at) if more and rows else None,
        "unread": unread_count(org_id, user_id),
    }


def unread_count(org_id: uuid.UUID, user_id: uuid.UUID) -> int:
    return int(
        db.session.scalar(
            select(func.count(Notification.id)).where(
                Notification.org_id == org_id,
                Notification.user_id == user_id,
                Notification.in_app.is_(True),
                Notification.read_at.is_(None),
            )
        )
        or 0
    )


def mark_read(org_id: uuid.UUID, user_id: uuid.UUID, ids: list[str] | None, read: bool = True) -> int:
    """Mark some (or, with ids=None, all) of this person's notifications read or unread."""
    q = update(Notification).where(Notification.org_id == org_id, Notification.user_id == user_id)
    if ids is not None:
        clean = [u for u in (_uuid(x) for x in ids) if u]
        if not clean:
            return 0
        q = q.where(Notification.id.in_(clean))
    elif read:
        q = q.where(Notification.read_at.is_(None))
    res = db.session.execute(q.values(read_at=utcnow() if read else None))
    db.session.commit()
    realtime.publish(org_id, f"user:{user_id}", {"type": "notification.read"}, user_ids=[user_id])
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


def mark_entity_read(org_id: uuid.UUID, user_id: uuid.UUID, entity_type: str, entity_id: str) -> int:
    """Opening a work order (or other record) clears its notifications."""
    res = db.session.execute(
        update(Notification)
        .where(
            Notification.org_id == org_id,
            Notification.user_id == user_id,
            Notification.entity_type == entity_type,
            Notification.entity_id == entity_id,
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow())
    )
    db.session.commit()
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


# ============================================================================ email
def _base_url() -> str:
    return str(current_app.config.get("MPRO_BASE_URL") or "http://localhost:8080").rstrip("/")


def brand(org: Organization) -> dict[str, Any]:
    s = get_settings(org.id, "notifications")
    color = s["brand_color"] if _is_color(s["brand_color"]) else "#1b5bd4"
    logo = f"{_base_url()}/api/v1/notifications/brand-logo/{org.id}" if s["brand_logo_file_id"] else ""
    return {"color": color, "logo_url": logo, "info": s["brand_info"], "name": org.name}


def _is_color(v: Any) -> bool:
    return (
        isinstance(v, str) and len(v) == 7 and v.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in v[1:])
    )


def render_email(org: Organization, heading: str, items: list[Notification], intro: str = "") -> tuple[str, str]:
    """(text, html) for one notification or a digest, with the organization's branding (r312)."""
    base = _base_url()
    b = brand(org)
    settings_url = f"{base}/notifications?tab=settings"
    lines = [heading, ""]
    if intro:
        lines += [intro, ""]
    for n in items:
        lines.append(f"• {n.title}")
        if n.body:
            lines.append(f"  {n.body[:300]}")
        if n.link:
            lines.append(f"  {base}{n.link}")
    lines += ["", f"— {org.name}", "", f"Change which emails you get: {settings_url}"]
    text = "\n".join(lines)
    e = html.escape
    rows = "".join(
        f'<tr><td style="padding:10px 0;border-bottom:1px solid #e3e8f1">'
        f'<a href="{e(base + n.link) if n.link else e(base)}" '
        'style="color:#141b28;font-weight:600;text-decoration:none">'
        f"{e(n.title)}</a>"
        + (f'<div style="color:#5d6880;margin-top:4px">{e(n.body[:300])}</div>' if n.body else "")
        + "</td></tr>"
        for n in items
    )
    logo = (
        f'<img src="{e(b["logo_url"])}" alt="{e(org.name)}" style="max-height:40px;max-width:200px;display:block">'
        if b["logo_url"]
        else f'<div style="font-size:18px;font-weight:700;color:#ffffff">{e(org.name)}</div>'
    )
    info = f'<div style="color:#5d6880;font-size:12px;margin-top:6px">{e(b["info"])}</div>' if b["info"] else ""
    html_body = (
        '<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,'
        'Helvetica,Arial,sans-serif;font-size:14px;color:#141b28">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        '<tr><td align="center" style="padding:24px 12px">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;'
        'background:#ffffff;border-radius:8px;overflow:hidden">'
        f'<tr><td style="background:{b["color"]};padding:16px 24px">{logo}</td></tr>'
        f'<tr><td style="padding:20px 24px"><h1 style="font-size:18px;margin:0 0 8px">{e(heading)}</h1>'
        + (f'<p style="margin:0 0 8px;color:#5d6880">{e(intro)}</p>' if intro else "")
        + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>{info}</td></tr>'
        f'<tr><td style="padding:12px 24px 20px;color:#8a93a6;font-size:12px">{e(org.name)} · '
        f'<a href="{e(settings_url)}" style="color:#8a93a6">Change which emails you get</a></td></tr>'
        "</table></td></tr></table></body></html>"
    )
    return text, html_body


def _email_one(org: Organization, user: User, n: Notification) -> None:
    text, html_body = render_email(org, n.title, [n])
    send_email(user.email, n.title, text, org_id=org.id, html=html_body)
    n.email_state = "sent"


def _send_digest(org: Organization, user: User, items: list[Notification], freq: str) -> None:
    if len(items) == 1 and freq == "instant":
        _email_one(org, user, items[0])
        return
    when = {"hourly": "the last hour", "daily": "today"}.get(freq, "while you were away")
    subject = f"{len(items)} update{'s' if len(items) != 1 else ''} in {org.name}"
    text, html_body = render_email(org, subject, items[:MAX_DIGEST], intro=f"What happened {when}.")
    send_email(user.email, subject, text, org_id=org.id, html=html_body)
    for n in items:
        n.email_state = "sent"


def deliver_pending(now: datetime | None = None) -> int:
    """Send digests and emails held by quiet hours or pauses (periodic job). Returns emails sent."""
    now = now or utcnow()
    pairs = db.session.execute(
        select(Notification.org_id, Notification.user_id).where(Notification.email_state == "pending").distinct()
    ).all()
    sent = 0
    for org_id, user_id in pairs:
        org = db.session.get(Organization, org_id)
        m = _member(org_id, user_id)
        if org is None or m is None:
            db.session.execute(
                update(Notification)
                .where(
                    Notification.org_id == org_id,
                    Notification.user_id == user_id,
                    Notification.email_state == "pending",
                )
                .values(email_state="none")
            )
            continue
        row = _pref_row(org_id, user_id)
        prefs = prefs_for(org_id, user_id, row)
        tz = _org_tz(org)
        if held(row, prefs, tz, now):
            continue
        freq = prefs["email_frequency"]
        last = row.last_digest_at if row else None
        if freq == "hourly" and last and now - last < timedelta(hours=1):
            continue
        if freq == "daily":
            local = now.astimezone(tz)
            if local.hour < int(prefs["digest_hour"]):
                continue
            if last and last.astimezone(tz).date() >= local.date():
                continue
        items = db.session.scalars(
            select(Notification)
            .where(
                Notification.org_id == org_id, Notification.user_id == user_id, Notification.email_state == "pending"
            )
            .order_by(Notification.created_at)
        ).all()
        if not items:
            continue
        _send_digest(org, m.user, list(items), freq)
        if row is None:
            row = NotificationPref(org_id=org_id, user_id=user_id, prefs={})
            db.session.add(row)
        row.last_digest_at = now
        sent += 1
    db.session.commit()
    return sent


# ============================================================================ web push
def _subs(user_id: uuid.UUID) -> list[PushSubscription]:
    return list(db.session.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id)))


def vapid_keys() -> PushKey:
    from mpro.core.crypto import encrypt_str
    from mpro.notifications.webpush import generate_keys

    k = db.session.scalars(select(PushKey).order_by(PushKey.created_at)).first()
    if k is None:
        pub, pem = generate_keys()
        k = PushKey(public_key=pub, private_key=encrypt_str(pem))
        db.session.add(k)
        db.session.flush()
    return k


def vapid_public_key() -> str:
    return vapid_keys().public_key


def subscribe(user: User, data: dict[str, Any], user_agent: str = "") -> dict[str, Any]:
    from mpro.notifications.webpush import allowed_endpoint, unb64u

    endpoint = str(data.get("endpoint") or "")
    keys = data.get("keys") or {}
    p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
    extra = tuple(current_app.config.get("MPRO_PUSH_HOSTS") or ())
    if not allowed_endpoint(endpoint, extra):
        raise RuleError("This browser's push service isn't supported.", 422)
    try:
        if len(unb64u(p256dh)) != 65 or len(unb64u(auth)) != 16:
            raise ValueError
    except (ValueError, TypeError):
        raise RuleError("The push subscription keys are invalid.", 422) from None
    sub = db.session.scalars(select(PushSubscription).where(PushSubscription.endpoint == endpoint)).first()
    if sub is None:
        sub = PushSubscription(endpoint=endpoint, user_id=user.id, p256dh=p256dh, auth=auth)
        db.session.add(sub)
    else:  # the same browser signed in as someone else takes the subscription over
        sub.user_id, sub.p256dh, sub.auth, sub.failures = user.id, p256dh, auth, 0
    sub.label = _device_label(str(data.get("label") or user_agent))
    db.session.commit()
    return sub.to_dict()


def _device_label(ua: str) -> str:
    ua_l = ua.lower()
    browser = next(
        (
            b
            for k, b in (
                ("edg/", "Edge"),
                ("opr/", "Opera"),
                ("firefox", "Firefox"),
                ("chrome", "Chrome"),
                ("safari", "Safari"),
            )
            if k in ua_l
        ),
        "",
    )
    system = next(
        (
            s
            for k, s in (
                ("android", "Android"),
                ("iphone", "iPhone"),
                ("ipad", "iPad"),
                ("windows", "Windows"),
                ("mac os", "Mac"),
                ("linux", "Linux"),
            )
            if k in ua_l
        ),
        "",
    )
    if browser or system:
        return f"{browser or 'Browser'}{' on ' + system if system else ''}"
    return ua[:200] or "This device"


def unsubscribe(user: User, endpoint: str | None = None, sub_id: str | None = None) -> int:
    q = delete(PushSubscription).where(PushSubscription.user_id == user.id)
    if endpoint:
        q = q.where(PushSubscription.endpoint == endpoint)
    elif sub_id:
        sid = _uuid(sub_id)
        if sid is None:
            return 0
        q = q.where(PushSubscription.id == sid)
    res = db.session.execute(q)
    db.session.commit()
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


def push_message(n: Notification, org: Organization | None) -> dict[str, Any]:
    return {
        "title": n.title[:120],
        "body": n.body[:240],
        "url": n.link or "/notifications",
        "tag": f"{n.entity_type}:{n.entity_id}" if n.entity_id else str(n.id),
        "org": org.name if org else "",
        "id": str(n.id),
    }


# Replaced in tests: (url, headers, body) -> HTTP status
def _post(req: Any) -> int:
    from mpro.notifications.webpush import post

    return post(req)


def send_push(n: Notification) -> int:
    """Send one notification to every device of its person. Returns how many accepted it."""
    from mpro.core.crypto import decrypt_str
    from mpro.notifications.webpush import PushError, allowed_endpoint, build_request

    key = vapid_keys()
    pem = decrypt_str(key.private_key)
    org = db.session.get(Organization, n.org_id)
    subject = str(current_app.config.get("MPRO_PUSH_SUBJECT") or _base_url())
    if not subject.startswith(("mailto:", "https:")):
        subject = "mailto:" + str(current_app.config.get("MAIL_FROM") or "admin@localhost")
    extra = tuple(current_app.config.get("MPRO_PUSH_HOSTS") or ())
    ok = 0
    for s in _subs(n.user_id):
        if not allowed_endpoint(s.endpoint, extra):
            db.session.delete(s)
            continue
        try:
            req = build_request(
                s.endpoint,
                s.p256dh,
                s.auth,
                push_message(n, org),
                private_pem=pem,
                public_b64=key.public_key,
                subject=subject,
                urgency="high" if n.kind in ("wo.escalated", "wo.overdue", "message.direct") else "normal",
            )
            status = _post(req)
        except (PushError, ValueError) as e:
            log.info("Push to %s failed: %s", s.id, e)
            status = 0
        if status in (200, 201, 202):
            ok += 1
            s.failures, s.last_used_at = 0, utcnow()
        elif status in (404, 410):  # the browser unsubscribed: forget the device
            db.session.delete(s)
        else:
            s.failures = (s.failures or 0) + 1
            if s.failures >= 5:
                db.session.delete(s)
    n.push_state = "sent" if ok else "failed"
    return ok


@job("notifications.push")
def _push_job(payload: dict[str, Any]) -> None:
    n = db.session.get(Notification, _uuid(payload.get("id")))
    if n is None or n.push_state != "queued":
        return
    send_push(n)
    db.session.commit()


def test_push(user: User, org: Organization) -> int:
    """Send a test notification to the person's devices right away."""
    n = Notification(
        org_id=org.id,
        user_id=user.id,
        kind="wo.assigned",
        category="system",
        title="Push notifications work",
        body=f"You'll get MPro notifications from {org.name} on this device.",
        link="/notifications?tab=settings",
        in_app=False,
        email_state="none",
        push_state="queued",
    )
    db.session.add(n)
    db.session.flush()
    ok = send_push(n)
    db.session.commit()
    return ok


# ============================================================================ time-based notices
def _notice(org_id: uuid.UUID, wo_id: uuid.UUID, kind: str, ref: str) -> bool:
    """Record a notice; False if it was already sent."""
    exists = db.session.scalars(
        select(WorkOrderNotice.id).where(
            WorkOrderNotice.work_order_id == wo_id, WorkOrderNotice.kind == kind, WorkOrderNotice.ref == ref
        )
    ).first()
    if exists:
        return False
    db.session.add(WorkOrderNotice(org_id=org_id, work_order_id=wo_id, kind=kind, ref=ref[:80]))
    return True


def scan_due(now: datetime | None = None) -> dict[str, int]:
    """Emit due-soon, overdue and escalation events (periodic job). Each fires once per due date / rule."""
    from mpro.core.events import current_job_org
    from mpro.workorders.models import WorkOrder

    now = now or utcnow()
    counts = {"due_soon": 0, "overdue": 0, "escalated": 0}
    open_q = select(WorkOrder).where(WorkOrder.deleted_at.is_(None), WorkOrder.status.not_in(CLOSED))
    org_ids = db.session.scalars(select(Organization.id).where(Organization.deleted_at.is_(None))).all()
    for org_id in org_ids:
        token = current_job_org.set(org_id)
        try:
            s = get_settings(org_id, "notifications")
            hours = int(s.get("due_soon_hours") or 0)
            # overdue
            for wo in db.session.scalars(
                open_q.where(
                    WorkOrder.org_id == org_id,
                    WorkOrder.due_at.is_not(None),
                    WorkOrder.due_at < now,
                    WorkOrder.due_at > now - timedelta(days=STALE_DAYS),
                )
            ):
                if _notice(org_id, wo.id, "overdue", iso(wo.due_at) or ""):
                    emit(
                        "wo.overdue",
                        entity_type="work_order",
                        entity_id=wo.id,
                        entity_label=_wo_label(wo),
                        summary="Became overdue",
                        data={"due_at": wo.due_at},
                        org_id=org_id,
                        actor=None,
                    )
                    counts["overdue"] += 1
            # due soon
            if hours > 0:
                for wo in db.session.scalars(
                    open_q.where(
                        WorkOrder.org_id == org_id,
                        WorkOrder.due_at.is_not(None),
                        WorkOrder.due_at >= now,
                        WorkOrder.due_at <= now + timedelta(hours=hours),
                    )
                ):
                    if _notice(org_id, wo.id, "due_soon", iso(wo.due_at) or ""):
                        emit(
                            "wo.due_soon",
                            entity_type="work_order",
                            entity_id=wo.id,
                            entity_label=_wo_label(wo),
                            summary="Due soon",
                            data={"due_at": wo.due_at},
                            org_id=org_id,
                            actor=None,
                        )
                        counts["due_soon"] += 1
            counts["escalated"] += _run_escalations(org_id, now)
            db.session.commit()
        except Exception:  # noqa: BLE001
            db.session.rollback()
            log.exception("Due-date scan failed for org %s", org_id)
        finally:
            current_job_org.reset(token)
    return counts


def _run_escalations(org_id: uuid.UUID, now: datetime) -> int:
    from mpro.workorders.models import WorkOrder, WorkOrderCategory

    n = 0
    rules = db.session.scalars(
        select(EscalationRule).where(
            EscalationRule.org_id == org_id, EscalationRule.active.is_(True), EscalationRule.deleted_at.is_(None)
        )
    ).all()
    for r in rules:
        cutoff = now - timedelta(hours=r.after_hours)
        q = select(WorkOrder).where(
            WorkOrder.org_id == org_id, WorkOrder.deleted_at.is_(None), WorkOrder.status.not_in(CLOSED)
        )
        if r.trigger == "not_started":
            q = q.where(
                WorkOrder.status == "open",
                WorkOrder.created_at < cutoff,
                WorkOrder.created_at > now - timedelta(days=STALE_DAYS),
            )
        else:
            q = q.where(
                WorkOrder.due_at.is_not(None),
                WorkOrder.due_at < cutoff,
                WorkOrder.due_at > now - timedelta(days=STALE_DAYS),
            )
        if r.priorities:
            q = q.where(WorkOrder.priority.in_(r.priorities))
        cats = [c for c in (_uuid(x) for x in r.category_ids or []) if c]
        if cats:
            q = q.where(
                WorkOrder.id.in_(select(WorkOrderCategory.work_order_id).where(WorkOrderCategory.category_id.in_(cats)))
            )
        for wo in db.session.scalars(q):
            ref = f"{r.id}:{iso(wo.due_at) if r.trigger == 'overdue' else ''}"
            if not _notice(org_id, wo.id, "escalated", ref):
                continue
            users = rule_recipients(org_id, r, wo)
            changes: dict[str, Any] = {}
            if r.raise_priority and wo.priority != "high":
                changes["priority"] = (wo.priority, "high")
                wo.priority = "high"
                if hasattr(wo, "version"):
                    wo.version = (wo.version or 1) + 1
            reason = (
                f"Overdue for more than {r.after_hours} hour{'s' if r.after_hours != 1 else ''}"
                if r.trigger == "overdue"
                else f"Not started {r.after_hours} hour{'s' if r.after_hours != 1 else ''} after it was created"
            ) + f" (rule: {r.name})."
            emit(
                "wo.escalated",
                entity_type="work_order",
                entity_id=wo.id,
                entity_label=_wo_label(wo),
                summary=f"Escalated by {r.name}" + (" and set to High priority" if changes else ""),
                changes=changes,
                data={"rule_id": r.id, "rule_name": r.name, "reason": reason, "user_ids": [str(u) for u in users]},
                org_id=org_id,
                actor=None,
            )
            n += 1
    return n


def rule_recipients(org_id: uuid.UUID, r: EscalationRule, wo: Any) -> list[uuid.UUID]:
    users: set[uuid.UUID] = {u for u in (_uuid(x) for x in r.notify_user_ids or []) if u}
    users |= set(team_members(org_id, r.notify_team_ids or []))
    if r.notify_admins:
        users |= {
            m.user_id
            for m in db.session.scalars(
                select(Membership).where(
                    Membership.org_id == org_id,
                    Membership.deleted_at.is_(None),
                    Membership.role.in_(("owner", "admin")),
                )
            )
        }
    if r.notify_assignees and wo is not None:
        users |= {u for u, g in _watchers(wo).items() if g & {"assigned_to_me", "my_teams"}}
    return sorted(users, key=str)


# ============================================================================ escalation rules (settings)
TRIGGERS = ("overdue", "not_started")
PRIORITIES = ("none", "low", "medium", "high")


def _ids_in_org(org_id: uuid.UUID, ids: Any, model: Any, what: str) -> list[str]:
    if ids is None:
        return []
    if not isinstance(ids, list) or len(ids) > 200:
        raise RuleError(f"{what} must be a list.", 422)
    out: list[str] = []
    for raw in ids:
        u = _uuid(raw)
        if u is None:
            raise RuleError(f"Unknown {what.lower()}.", 422)
        if model is Membership:
            ok = (
                db.session.scalars(
                    select(Membership.id).where(
                        Membership.org_id == org_id, Membership.user_id == u, Membership.deleted_at.is_(None)
                    )
                ).first()
                is not None
            )
        else:
            row = db.session.get(model, u)
            ok = row is not None and row.org_id == org_id and getattr(row, "deleted_at", None) is None
        if not ok:
            raise RuleError(f"Unknown {what.lower()}.", 422)
        out.append(str(u))
    return out


def save_rule(
    org_id: uuid.UUID, user: User, data: dict[str, Any], rule: EscalationRule | None = None
) -> EscalationRule:
    from mpro.workorders.models import Category

    creating = rule is None
    if rule is None:
        rule = EscalationRule(org_id=org_id, created_by_id=user.id, name="")
        db.session.add(rule)
    if "name" in data or creating:
        name = str(data.get("name") or "").strip()
        if not name:
            raise RuleError("Give the rule a name.", 422)
        rule.name = name[:120]
    if "active" in data:
        rule.active = bool(data["active"])
    if "trigger" in data or creating:
        trig = data.get("trigger", "overdue")
        if trig not in TRIGGERS:
            raise RuleError("Escalate when overdue or not started.", 422)
        rule.trigger = trig
    if "after_hours" in data or creating:
        try:
            h = int(data.get("after_hours", 4))
        except (TypeError, ValueError):
            raise RuleError("Hours must be a whole number.", 422) from None
        if not 0 <= h <= 24 * 30:
            raise RuleError("Hours must be between 0 and 720.", 422)
        rule.after_hours = h
    if "priorities" in data:
        p = data["priorities"] or []
        if not isinstance(p, list) or any(x not in PRIORITIES for x in p):
            raise RuleError("Unknown priority.", 422)
        rule.priorities = sorted(set(p), key=PRIORITIES.index)
    if "category_ids" in data:
        rule.category_ids = _ids_in_org(org_id, data["category_ids"], Category, "Categories")
    if "notify_user_ids" in data:
        rule.notify_user_ids = _ids_in_org(org_id, data["notify_user_ids"], Membership, "People")
    if "notify_team_ids" in data:
        rule.notify_team_ids = _ids_in_org(org_id, data["notify_team_ids"], Team, "Teams")
    for k in ("notify_admins", "notify_assignees", "raise_priority"):
        if k in data:
            setattr(rule, k, bool(data[k]))
    if not (rule.notify_user_ids or rule.notify_team_ids or rule.notify_admins or rule.notify_assignees):
        raise RuleError("Choose who gets the escalation.", 422)
    db.session.flush()
    emit(
        "escalation_rule.saved",
        entity_type="escalation_rule",
        entity_id=rule.id,
        entity_label=rule.name,
        summary=f"{'Created' if creating else 'Updated'} escalation rule {rule.name}",
        org_id=org_id,
        actor=user,
    )
    db.session.commit()
    return rule


def delete_rule(org_id: uuid.UUID, user: User, rule: EscalationRule) -> None:
    rule.deleted_at = utcnow()
    emit(
        "escalation_rule.deleted",
        entity_type="escalation_rule",
        entity_id=rule.id,
        entity_label=rule.name,
        summary=f"Deleted escalation rule {rule.name}",
        org_id=org_id,
        actor=user,
    )
    db.session.commit()


def rule_dict(r: EscalationRule) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "name": r.name,
        "active": r.active,
        "trigger": r.trigger,
        "after_hours": r.after_hours,
        "priorities": r.priorities or [],
        "category_ids": r.category_ids or [],
        "notify_user_ids": r.notify_user_ids or [],
        "notify_team_ids": r.notify_team_ids or [],
        "notify_admins": r.notify_admins,
        "notify_assignees": r.notify_assignees,
        "raise_priority": r.raise_priority,
        "created_at": iso(r.created_at),
    }


def rules(org_id: uuid.UUID) -> list[EscalationRule]:
    return list(
        db.session.scalars(
            select(EscalationRule)
            .where(EscalationRule.org_id == org_id, EscalationRule.deleted_at.is_(None))
            .order_by(EscalationRule.created_at)
        )
    )


# ============================================================================ organization settings
def org_settings(org_id: uuid.UUID) -> dict[str, Any]:
    s = get_settings(org_id, "notifications")
    s.pop("weekly_report_last", None)
    s.pop("notify_from", None)
    return s


def save_org_settings(org: Organization, user: User, data: dict[str, Any]) -> dict[str, Any]:
    from mpro.core.files import FileObject

    clean: dict[str, Any] = {}
    if "due_soon_hours" in data:
        try:
            h = int(data["due_soon_hours"])
        except (TypeError, ValueError):
            raise RuleError("Due soon must be a number of hours.", 422) from None
        if not 0 <= h <= 24 * 14:
            raise RuleError("Due soon must be between 0 and 336 hours.", 422)
        clean["due_soon_hours"] = h
    if "overdue_team_ids" in data:
        clean["overdue_team_ids"] = _ids_in_org(org.id, data["overdue_team_ids"], Team, "Teams")
    if "weekly_report" in data:
        clean["weekly_report"] = bool(data["weekly_report"])
    if "weekly_report_user_ids" in data:
        clean["weekly_report_user_ids"] = _ids_in_org(org.id, data["weekly_report_user_ids"], Membership, "People")
    if "brand_color" in data:
        c = str(data["brand_color"] or "")
        if c and not _is_color(c):
            raise RuleError("The brand colour must look like #1b5bd4.", 422)
        clean["brand_color"] = c
    if "brand_info" in data:
        clean["brand_info"] = str(data["brand_info"] or "")[:300]
    if "brand_logo_file_id" in data:
        raw = data["brand_logo_file_id"]
        if raw:
            fid = _uuid(raw)
            f = db.session.get(FileObject, fid) if fid else None
            if f is None or f.org_id != org.id or f.deleted_at is not None or not f.is_image:
                raise RuleError("The logo must be a picture uploaded to this organization.", 422)
            # the logo is served without sign-in: only a picture this person uploaded (not, say, a photo from a
            # work order they can't see), or the one already in use
            if f.uploaded_by_id != user.id and str(f.id) != str(org_settings(org.id).get("brand_logo_file_id") or ""):
                raise RuleError("Upload the logo here, rather than picking an existing file.", 422)
            clean["brand_logo_file_id"] = str(f.id)
        else:
            clean["brand_logo_file_id"] = ""
    save_settings(org.id, "notifications", clean)
    emit(
        "notifications.settings_changed",
        entity_type="organization",
        entity_id=org.id,
        entity_label=org.name,
        summary="Changed notification settings",
        data={"keys": sorted(clean)},
        org_id=org.id,
        actor=user,
    )
    db.session.commit()
    return org_settings(org.id)


# ============================================================================ weekly report (r311)
def weekly_report_due(org: Organization, now: datetime) -> str | None:
    """The ISO week to report on when it's Monday 07:00 or later in the org's time zone and not sent yet."""
    s = get_settings(org.id, "notifications")
    if not s["weekly_report"]:
        return None
    local = now.astimezone(_org_tz(org))
    if local.weekday() != 0 or local.hour < 7:
        return None
    y, w, _ = local.isocalendar()
    week = f"{y}-W{w:02d}"
    return None if s["weekly_report_last"] == week else week


def weekly_report(org: Organization, now: datetime | None = None) -> dict[str, Any]:
    from mpro.workorders.models import WorkOrder

    now = now or utcnow()
    start = now - timedelta(days=7)
    base = select(func.count(WorkOrder.id)).where(WorkOrder.org_id == org.id, WorkOrder.deleted_at.is_(None))
    created = db.session.scalar(base.where(WorkOrder.created_at >= start)) or 0
    completed = db.session.scalar(base.where(WorkOrder.completed_at >= start, WorkOrder.status == "done")) or 0
    open_ = db.session.scalar(base.where(WorkOrder.status.not_in(CLOSED))) or 0
    overdue_q = (
        select(WorkOrder)
        .where(
            WorkOrder.org_id == org.id,
            WorkOrder.deleted_at.is_(None),
            WorkOrder.status.not_in(CLOSED),
            WorkOrder.due_at.is_not(None),
            WorkOrder.due_at < now,
        )
        .order_by(WorkOrder.due_at)
    )
    overdue_count = db.session.scalar(select(func.count()).select_from(overdue_q.subquery())) or 0
    overdue = [
        {"id": str(w.id), "label": _wo_label(w), "due_at": iso(w.due_at)}
        for w in db.session.scalars(overdue_q.limit(10))
    ]
    return {
        "created": created,
        "completed": completed,
        "open": open_,
        "overdue": overdue_count,
        "overdue_list": overdue,
    }


def send_weekly_reports(now: datetime | None = None) -> int:
    now = now or utcnow()
    sent = 0
    for org in db.session.scalars(select(Organization).where(Organization.deleted_at.is_(None))):
        week = weekly_report_due(org, now)
        if week is None:
            continue
        s = get_settings(org.id, "notifications")
        ids = [u for u in (_uuid(x) for x in s["weekly_report_user_ids"]) if u]
        if not ids:
            ids = [
                m.user_id
                for m in db.session.scalars(
                    select(Membership).where(
                        Membership.org_id == org.id,
                        Membership.deleted_at.is_(None),
                        Membership.role.in_(("owner", "admin")),
                    )
                )
            ]
        rep = weekly_report(org, now)
        items = [
            Notification(
                title=f"{rep['created']} created · {rep['completed']} completed · "
                f"{rep['open']} open · {rep['overdue']} overdue",
                body="",
                link="/work-orders",
            ),
            *[
                Notification(title=f"Overdue: {o['label']}", body="", link=f"/work-orders/{o['id']}")
                for o in rep["overdue_list"]
            ],
        ]
        for uid in ids:
            m = _member(org.id, uid)
            if m is None:
                continue
            subject = f"Weekly work order report for {org.name}"
            text, html_body = render_email(org, subject, items, intro="The last 7 days.")
            send_email(m.user.email, subject, text, org_id=org.id, html=html_body)
            sent += 1
        save_settings(org.id, "notifications", {"weekly_report_last": week})
        db.session.commit()
    return sent


# ============================================================================ jobs
@job("notifications.deliver")
def _deliver_job(_: dict[str, Any]) -> None:
    deliver_pending()


@job("notifications.scan")
def _scan_job(_: dict[str, Any]) -> None:
    scan_due()


@job("notifications.weekly")
def _weekly_job(_: dict[str, Any]) -> None:
    send_weekly_reports()


@job("notifications.cleanup")
def _cleanup_job(_: dict[str, Any]) -> None:
    """Read notifications older than 90 days and any older than a year are removed."""
    now = utcnow()
    db.session.execute(
        delete(Notification).where(
            (Notification.created_at < now - timedelta(days=365))
            | ((Notification.read_at.is_not(None)) & (Notification.created_at < now - timedelta(days=90)))
            | (
                (Notification.in_app.is_(False))
                & (Notification.email_state != "pending")
                & (Notification.created_at < now - timedelta(days=7))
            )
        )
    )
    db.session.execute(delete(WorkOrderNotice).where(WorkOrderNotice.created_at < now - timedelta(days=120)))
    db.session.commit()


periodic("notifications.deliver", timedelta(minutes=1))
periodic("notifications.scan", timedelta(minutes=5))
periodic("notifications.weekly", timedelta(minutes=30))
periodic("notifications.cleanup", timedelta(hours=12))
