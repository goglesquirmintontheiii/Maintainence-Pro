"""Notifications: demo data."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.notifications.models import EscalationRule, Notification


def seed(org: Any, admin: Any) -> None:
    """Called once per demo org from mpro/demo.py (must be idempotent)."""
    from mpro.workorders.models import WorkOrder

    if db.session.scalars(select(EscalationRule.id).where(EscalationRule.org_id == org.id).limit(1)).first() is None:
        db.session.add(
            EscalationRule(
                org_id=org.id,
                name="High priority overdue for 2 hours",
                trigger="overdue",
                after_hours=2,
                priorities=["high"],
                notify_admins=True,
                notify_assignees=True,
                created_by_id=admin.id,
            )
        )
    if db.session.scalars(select(Notification.id).where(Notification.org_id == org.id).limit(1)).first() is None:
        wos = db.session.scalars(
            select(WorkOrder)
            .where(WorkOrder.org_id == org.id, WorkOrder.deleted_at.is_(None))
            .order_by(WorkOrder.number)
            .limit(4)
        ).all()
        now = utcnow()
        samples = [
            ("wo.assigned", "Jordan Reyes assigned you {wo}", "", 5, False),
            (
                "wo.mentioned",
                "Avery Kim mentioned you on {wo}",
                "@Alex Morgan can you sign off on this one?",
                40,
                False,
            ),
            ("wo.overdue", "{wo} is overdue", "It was due yesterday.", 180, True),
            ("wo.status_changed", "{wo}: Changed status to In Progress", "", 600, True),
        ]
        for (kind, title, body, mins, read), wo in zip(samples, wos, strict=False):
            label = f"#{wo.number} {wo.title}"
            db.session.add(
                Notification(
                    org_id=org.id,
                    user_id=admin.id,
                    kind=kind,
                    category="work_orders",
                    title=title.format(wo=label),
                    body=body,
                    link=f"/work-orders/{wo.id}",
                    entity_type="work_order",
                    entity_id=str(wo.id),
                    actor_label=title.split(" ")[0] + " " + title.split(" ")[1]
                    if kind in ("wo.assigned", "wo.mentioned")
                    else "",
                    created_at=now - timedelta(minutes=mins),
                    read_at=now - timedelta(minutes=mins - 1) if read else None,
                )
            )
    # the demo's own history (assignments, comments…) shouldn't send anyone notifications or emails
    from mpro.core.models import iso
    from mpro.core.settings import get_settings, save_settings

    if not get_settings(org.id, "notifications").get("notify_from"):
        save_settings(org.id, "notifications", {"notify_from": iso(utcnow())})
    db.session.flush()
