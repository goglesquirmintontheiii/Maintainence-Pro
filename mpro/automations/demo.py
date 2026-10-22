"""Demo automations: the demo's 0.3.0 meter triggers become automations, plus a few more."""

from __future__ import annotations

from flask import current_app, g
from sqlalchemy import select

from mpro.assets.models import Asset
from mpro.auth.models import User
from mpro.automations import services as svc
from mpro.automations.models import Automation
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team


def seed_automations(org: Organization, admin: User) -> None:
    svc.convert_legacy_triggers(org.id)
    db.session.commit()
    if db.session.scalar(
        select(Automation.id).where(Automation.org_id == org.id, Automation.legacy_trigger_id.is_(None)).limit(1)
    ):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    assets = {a.name: a for a in db.session.scalars(select(Asset).where(Asset.org_id == org.id)).all()}
    teams = {t.name: t for t in db.session.scalars(select(Team).where(Team.org_id == org.id)).all()}
    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        critical = [str(a.id) for a in assets.values() if a.criticality == "critical"]
        if critical:
            svc.save_automation(
                org,
                m,
                {
                    "name": "Critical asset goes offline",
                    "description": "Any critical asset that breaks down gets a high-priority work order right away.",
                    "trigger": {"type": "asset_status", "to": ["offline"]},
                    "targets": critical,
                    "conditions": [],
                    "actions": [
                        {
                            "type": "create_work_order",
                            "title": "{asset} is offline — investigate",
                            "priority": "high",
                            "description": "Raised automatically when {asset} went offline.",
                            "due_in_days": 0,
                        }
                    ],
                    "rerun_minutes": 60,
                },
            )
        chiller = assets.get("Chiller 1")
        hvac = teams.get("HVAC")
        if chiller is not None and hvac is not None:
            svc.save_automation(
                org,
                m,
                {
                    "name": "Chiller 1 work done — tell HVAC",
                    "trigger": {"type": "work_order_status", "to": ["done"]},
                    "targets": [str(chiller.id)],
                    "actions": [
                        {
                            "type": "send_email",
                            "recipients": [f"team:{hvac.id}"],
                            "subject": "Done: {work_order}",
                            "body": "{work_order} on {asset} was marked Done. Check the log sheet before restart.",
                        }
                    ],
                },
            )
        mixer = assets.get("Mixer M-2")
        if mixer is not None:
            from mpro.meters.models import Meter

            vib = db.session.scalars(select(Meter).where(Meter.org_id == org.id, Meter.asset_id == mixer.id)).first()
            if vib is not None:
                svc.save_automation(
                    org,
                    m,
                    {
                        "name": "Mixer vibration high — take it offline",
                        "trigger": {"type": "meter_reading", "condition": "above", "value": 0.45},
                        "targets": [str(vib.id)],
                        "sensitivity": {"mode": "n_of_m", "n": 3, "m": 5},
                        "conditions": [{"type": "weekday", "days": [0, 1, 2, 3, 4]}],
                        "actions": [
                            {
                                "type": "change_asset_status",
                                "status": "offline",
                                "downtime_type": "unplanned",
                                "reason": "Breakdown",
                            },
                            {
                                "type": "create_work_order",
                                "title": "Mixer M-2 vibration above alarm",
                                "priority": "high",
                            },
                        ],
                        "rerun_minutes": 720,
                    },
                )
