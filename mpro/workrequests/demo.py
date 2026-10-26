"""Work requests and request portals: demo data."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from mpro.extensions import db


def seed(org: Any, admin: Any) -> None:
    """Called once per demo org from mpro/demo.py (must be idempotent)."""
    from mpro.assets.models import Asset, Location
    from mpro.orgs.models import Membership, Team
    from mpro.workrequests import services as svc
    from mpro.workrequests.models import WorkRequest

    if db.session.scalar(select(WorkRequest.id).where(WorkRequest.org_id == org.id).limit(1)) is not None:
        return
    admin_m = db.session.scalars(select(Membership).filter_by(org_id=org.id, user_id=admin.id)).one()
    requesters = db.session.scalars(
        select(Membership).where(
            Membership.org_id == org.id, Membership.role == "requester", Membership.deleted_at.is_(None)
        )
    ).all()
    req_a = requesters[0] if requesters else admin_m
    req_b = requesters[1] if len(requesters) > 1 else req_a
    assets = {a.name: a for a in db.session.scalars(select(Asset).where(Asset.org_id == org.id)).all()}
    locs = {loc.name: loc for loc in db.session.scalars(select(Location).where(Location.org_id == org.id)).all()}
    team = db.session.scalars(select(Team).where(Team.org_id == org.id).order_by(Team.name)).first()

    def asset(*names: str) -> str | None:
        for n in names:
            if n in assets:
                return str(assets[n].id)
        return str(next(iter(assets.values())).id) if assets else None

    def loc(*names: str) -> str | None:
        for n in names:
            if n in locs:
                return str(locs[n].id)
        return None

    items: list[tuple[Membership, dict[str, Any]]] = [
        (req_a, {"title": "Leaking valve under the line 2 wash station", "priority": "high",
                 "description": "Water pooling on the floor near the wash station. Someone could slip.",
                 "asset_id": None, "location_id": loc("Line 2", "Building A - Production")}),
        (req_b, {"title": "Office AC blowing warm air", "priority": "medium",
                 "description": "Front office has been warm since yesterday afternoon.",
                 "location_id": loc("Front Office", "Building A - Production")}),
        (req_a, {"title": "Conveyor 3 making a grinding noise", "priority": "high",
                 "description": "Loud grinding from the tail pulley at start-up.",
                 "asset_id": asset("Conveyor 3", "Conveyor 3 Drive Motor"),
                 "team_id": str(team.id) if team else None}),
        (req_b, {"title": "Replace burnt-out lights in the break room", "priority": "low",
                 "description": "Two of the four panels are out."}),
        (req_a, {"title": "Paint the visitor parking lines", "priority": "low",
                 "description": "Lines are faded; visitors park across two spots."}),
    ]  # fmt: skip
    made = []
    for m, data in items:
        made.append(svc.create_request(org, m, {k: v for k, v in data.items() if v is not None}))
    # one approved (now a work order), one declined; the rest wait for review
    svc.approve(org, admin_m, made[3], {})
    svc.decline(org, admin_m, made[4], "Parking is managed by the landlord. Please email facilities@landlord.example.")
    made[2].seen_at = made[2].created_at  # already looked at: no "new" dot
    db.session.commit()

    portal = svc.save_portal(
        org,
        admin_m,
        {
            "name": "Report a problem",
            "intro": "Tell the maintenance team what's wrong. Add a photo if you can.",
            "fields": {"attachments": "optional", "priority": "hidden"},
        },
    )
    from mpro.vendors.models import Customer

    cust = db.session.scalars(
        select(Customer).where(Customer.org_id == org.id, Customer.deleted_at.is_(None)).order_by(Customer.name)
    ).first()
    if cust is not None:
        svc.save_portal(
            org,
            admin_m,
            {
                "name": f"{cust.name} service requests",
                "intro": f"Service requests for {cust.name}. We'll reply by email.",
                "customer_id": str(cust.id),
                "require_email": True,
            },
        )
    # one request that came in through the public portal
    svc.public_submit(
        portal,
        org,
        {
            "title": "Hand dryer in the lobby restroom doesn't work",
            "description": "Pressing the button does nothing.",
            "name": "Sam Visitor",
            "email": "sam.visitor@example.com",
            "notify_email": True,
        },
        "127.0.0.1",
    )
