"""Messaging: demo data (team chats, All Team announcement, a direct conversation and a work order thread)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from mpro.auth.models import User
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.messaging import services as svc
from mpro.messaging.models import Message
from mpro.orgs.models import Membership, Team


def seed(org: Any, admin: Any) -> None:
    """Called once per demo org from mpro/demo.py (must be idempotent)."""
    if db.session.scalars(select(Message.id).where(Message.org_id == org.id).limit(1)).first() is not None:
        return
    people = {
        u.email.split("@")[0]: u
        for u in db.session.scalars(
            select(User).join(Membership, Membership.user_id == User.id).where(Membership.org_id == org.id)
        )
    }

    def m_of(u: User) -> Membership:
        return db.session.scalars(select(Membership).filter_by(org_id=org.id, user_id=u.id)).one()

    def say(conv: Any, who: User, text: str, minutes_ago: float, **kw: Any) -> Message:
        msg = svc.post_message(org, m_of(who), conv, text, **kw)
        msg.created_at = utcnow() - timedelta(minutes=minutes_ago)
        if msg.parent_id is None:
            conv.last_message_at = max(conv.last_message_at or msg.created_at, msg.created_at)
        db.session.commit()
        return msg

    alex = admin
    jordan = people.get("jordan.reyes", alex)
    avery = people.get("avery.kim", alex)
    sam = people.get("sam.patel", alex)
    riley = people.get("riley.chen", alex)

    everyone = svc.ensure_all_conversation(org.id)
    teams = {t.name: svc.ensure_team_conversation(t) for t in db.session.scalars(select(Team).filter_by(org_id=org.id))}
    db.session.commit()

    say(
        everyone,
        alex,
        "Safety notice: the north dock will be closed Thursday 6am–2pm for the forklift charger upgrade. "
        "Use the south dock and keep the walkway by Line 3 clear. Please confirm you've read this.",
        60 * 20,
        announcement=True,
    )
    say(everyone, jordan, "Reminder: timesheets are due Friday by noon.", 60 * 6)

    mech = teams.get("Mechanical")
    if mech is not None:
        root = say(mech, jordan, "Who can take a look at the Line 3 conveyor belt tension before second shift?", 180)
        say(mech, avery, "I'll grab it after lunch. Need a 4L360 belt from stores?", 170, parent_id=root.id)
        say(mech, jordan, "Yes, there are two on the shelf in Building B.", 165, parent_id=root.id)
        say(mech, avery, "Belt is in. Tension checked and logged on the work order 👍", 40)
    elec = teams.get("Electrical")
    if elec is not None:
        say(elec, sam, "VFD on mixer M-2 threw OC2 again. I'm reading the fault log now.", 95)
    hvac = teams.get("HVAC")
    if hvac is not None:
        say(hvac, riley, "Chiller 1 quarterly inspection is done. Readings look normal.", 300)

    dm = svc.direct_conversation(org, m_of(alex), jordan.id)
    say(dm, jordan, "Can we move the Line 2 shutdown review to Thursday?", 55)
    say(dm, alex, "Thursday 10am works. I'll update the invite.", 50)
    say(dm, jordan, "Thanks!", 49)

    from mpro.workorders.models import WorkOrder

    wo = db.session.scalars(
        select(WorkOrder).where(WorkOrder.org_id == org.id, WorkOrder.title.ilike("%Conveyor 3 drive belt%"))
    ).first()
    if wo is not None:
        thread = svc.work_order_conversation(org, m_of(avery), wo)
        say(thread, avery, "Belt looks glazed on the drive side. Replacing it rather than re-tensioning.", 35)
        say(thread, jordan, "Good call. Order two more spares so we're not caught short.", 30)
