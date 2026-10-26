"""Messaging event consumers (G-05): team chats follow their teams, and assigning a work order to a team posts its
link in the team chat (r305)."""

from __future__ import annotations

import uuid

from mpro.core.events import DomainEvent, consumer
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.messaging import services as svc
from mpro.messaging.models import Conversation
from mpro.orgs.models import Team


@consumer("team.")
def _team_changed(ev: DomainEvent) -> None:
    try:
        tid = uuid.UUID(ev.entity_id)
    except ValueError:
        return
    team = db.session.get(Team, tid)
    if team is None:
        return
    if ev.type == "team.deleted" or team.deleted_at is not None:
        for conv in db.session.query(Conversation).filter_by(org_id=team.org_id, team_id=team.id):
            if conv.deleted_at is None:
                conv.deleted_at = utcnow()
        return
    if ev.type in ("team.created", "team.updated"):
        svc.ensure_team_conversation(team)


@consumer("wo.assigned")
def _wo_assigned_to_team(ev: DomainEvent) -> None:
    from mpro.workorders.models import WorkOrder

    added = (ev.data or {}).get("added") or []
    team_ids = []
    for a in added:
        kind, _, ident = str(a).partition(":")
        if kind == "team":
            try:
                team_ids.append(uuid.UUID(ident))
            except ValueError:
                continue
    if not team_ids:
        return
    try:
        wo = db.session.get(WorkOrder, uuid.UUID(ev.entity_id))
    except ValueError:
        return
    if wo is None or wo.deleted_at is not None or wo.org_id != ev.org_id:
        return
    for tid in team_ids:
        svc.post_work_order_link(tid, wo, ev.actor_label if ev.actor_id else "", ev.created_at)
