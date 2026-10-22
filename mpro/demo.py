"""Realistic demo organization, used by test builds, `./start.sh --dev`, screenshots and tests."""

from __future__ import annotations

from sqlalchemy import select

from mpro.auth.models import User
from mpro.core.events import emit
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import create_org

DEMO_EMAIL = "admin@example.com"
DEMO_PASSWORD = "mpro-demo-123"

PEOPLE = [
    ("Jordan Reyes", "jordan.reyes@example.com", "limited_admin", "Maintenance Manager", ["Mechanical", "Facilities"]),
    ("Avery Kim", "avery.kim@example.com", "technician", "Senior Technician", ["Mechanical"]),
    ("Sam Patel", "sam.patel@example.com", "technician", "Electrician", ["Electrical"]),
    ("Riley Chen", "riley.chen@example.com", "technician", "HVAC Technician", ["HVAC"]),
    ("Morgan Diaz", "morgan.diaz@example.com", "technician", "Technician II", ["Mechanical"]),
    ("Taylor Brooks", "taylor.brooks@example.com", "technician", "Electrician", ["Electrical"]),
    ("Casey Nguyen", "casey.nguyen@example.com", "technician", "HVAC Technician", ["HVAC", "Facilities"]),
    ("Jamie Ortiz", "jamie.ortiz@example.com", "requester", "Line Supervisor, Line 2", []),
    ("Drew Walker", "drew.walker@example.com", "requester", "Front Office", []),
    ("Quinn Foster", "quinn.foster@example.com", "viewer", "Plant Controller", []),
    ("Harper Lewis", "harper.lewis@example.com", "technician", "Planner / Scheduler", ["Facilities"]),
]
TEAMS = [
    ("Mechanical", "Conveyors, pumps, gearboxes and line equipment.", "#1b5bd4"),
    ("Electrical", "Panels, motors, VFDs and lighting.", "#b8560b"),
    ("HVAC", "Chillers, RTUs, AHUs and building controls.", "#0a7f96"),
    ("Facilities", "Building, grounds, doors and janitorial.", "#7a52c9"),
]


def seed_demo(password: str = DEMO_PASSWORD, work_orders: bool = True) -> Organization:
    """Create the demo org if it doesn't exist. Idempotent. `work_orders=False` skips sample work (tests)."""
    existing = db.session.scalars(select(Organization).where(Organization.slug == "acme-demo")).first()
    if existing:
        if work_orders:
            _seed_work(existing)
        return existing
    admin = db.session.scalars(select(User).where(User.email == DEMO_EMAIL)).first()
    if admin is None:
        admin = User(email=DEMO_EMAIL, name="Alex Morgan")
        admin.set_password(password)
        db.session.add(admin)
        db.session.flush()
    org = create_org("Acme Manufacturing (Demo)", admin, timezone="America/Chicago")
    org.slug = "acme-demo"
    teams = {}
    for name, desc, color in TEAMS:
        t = Team(org_id=org.id, name=name, description=desc, color=color)
        db.session.add(t)
        teams[name] = t
    db.session.flush()
    for name, email, role, title, tnames in PEOPLE:
        u = User(email=email, name=name)
        u.set_password(password)
        db.session.add(u)
        db.session.flush()
        db.session.add(Membership(org_id=org.id, user_id=u.id, role=role, job_title=title))
        for tn in tnames:
            db.session.add(TeamMember(org_id=org.id, team_id=teams[tn].id, user_id=u.id))
        emit(
            "member.invited",
            entity_type="user",
            entity_id=u.id,
            entity_label=name,
            summary=f"Invited {email}",
            org_id=org.id,
            actor=admin,
        )
    for name, *_ in TEAMS:
        emit(
            "team.created",
            entity_type="team",
            entity_id=teams[name].id,
            entity_label=name,
            summary=f"Created team {name}",
            org_id=org.id,
            actor=admin,
        )
    db.session.query(Membership).filter_by(org_id=org.id, user_id=admin.id).update({"job_title": "Plant Engineer"})
    db.session.commit()
    if work_orders:
        _seed_work(org)
    return org


def _seed_work(org: Organization) -> None:
    from mpro.workorders.demo import seed_work_orders

    admin = db.session.scalars(select(User).where(User.email == DEMO_EMAIL)).first()
    if admin is not None:
        from mpro.assets.demo import seed_assets

        seed_work_orders(org, admin)
        seed_assets(org, admin)
