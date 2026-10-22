# ruff: noqa: E501  (sample data reads better on one line)
"""Built-in procedure templates (r209) and demo procedures with answers for the demo organization."""

from __future__ import annotations

import copy
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.auth.models import User
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization

TEMPLATES: dict[str, dict[str, Any]] = {
    "chiller_quarterly": {
        "name": "Chiller quarterly inspection",
        "category": "HVAC",
        "tags": ["HVAC", "Quarterly"],
        "description": "Condenser approach, oil, refrigerant pressures and vibration for water-cooled chillers.",
        "schema": {
            "scoring": {"enabled": True, "goal": 80},
            "items": [
                {
                    "id": "safety",
                    "type": "section",
                    "label": "Before you start",
                    "items": [
                        {"id": "ppe", "type": "checkbox", "label": "Safety glasses and gloves on", "required": True},
                        {"id": "notify", "type": "checkbox", "label": "Operations notified the chiller may cycle"},
                    ],
                },
                {
                    "id": "readings",
                    "type": "section",
                    "label": "Readings",
                    "items": [
                        {"id": "lwt", "type": "meter_reading", "label": "Leaving water temperature", "required": True},
                        {
                            "id": "approach",
                            "type": "number",
                            "label": "Condenser approach",
                            "unit": "°F",
                            "min": 0,
                            "max": 40,
                        },
                        {
                            "id": "oil",
                            "type": "inspection",
                            "label": "Oil level in sight glass",
                            "required": True,
                            "points": 2,
                        },
                        {
                            "id": "leaks",
                            "type": "inspection",
                            "label": "No refrigerant leaks (bubble test at flanges)",
                            "required": True,
                            "points": 2,
                        },
                        {
                            "id": "leak_where",
                            "type": "text",
                            "label": "Where is the leak?",
                            "condition": {"field": "leaks", "op": "in", "value": ["flag", "fail"]},
                            "required": True,
                        },
                        {"id": "vibration", "type": "inspection", "label": "Compressor vibration normal", "points": 1},
                    ],
                },
                {"id": "photos", "type": "file", "label": "Photos of the control panel and any findings"},
                {"id": "sign", "type": "signature", "label": "Technician sign-off", "required": True},
            ],
        },
    },
    "forklift_daily": {
        "name": "Forklift daily pre-use check",
        "category": "Vehicles",
        "tags": ["Daily", "Safety", "OSHA"],
        "description": "OSHA-style pre-shift inspection. Any Fail takes the truck out of service.",
        "schema": {
            "scoring": {"enabled": True, "goal": 100},
            "items": [
                {"id": "hours", "type": "number", "label": "Hour meter", "unit": "h"},
                {
                    "id": "forks",
                    "type": "inspection",
                    "label": "Forks, chains and mast: no cracks or damage",
                    "required": True,
                },
                {
                    "id": "hydraulics",
                    "type": "inspection",
                    "label": "Hydraulic hoses and cylinders: no leaks",
                    "required": True,
                },
                {"id": "tires", "type": "inspection", "label": "Tires and wheels", "required": True},
                {"id": "brakes", "type": "inspection", "label": "Service and parking brakes work", "required": True},
                {"id": "horn", "type": "inspection", "label": "Horn, lights and backup alarm", "required": True},
                {
                    "id": "fluids",
                    "type": "checklist",
                    "label": "Fluid levels checked",
                    "options": ["Engine oil", "Hydraulic oil", "Coolant", "Fuel / battery charge"],
                },
                {"id": "notes", "type": "text", "label": "Notes"},
            ],
        },
    },
    "eyewash_weekly": {
        "name": "Eyewash station weekly check",
        "category": "Safety",
        "tags": ["Weekly", "Safety", "ANSI Z358.1"],
        "description": "Activate weekly to flush the line and verify flow (ANSI Z358.1).",
        "schema": {
            "items": [
                {"id": "access", "type": "yes_no_na", "label": "Station is unobstructed and signed", "required": True},
                {"id": "flush", "type": "checkbox", "label": "Flushed for 3 minutes", "required": True},
                {"id": "clear", "type": "inspection", "label": "Water runs clear and tepid", "required": True},
                {"id": "caps", "type": "inspection", "label": "Dust caps in place and pop off with the flow"},
                {"id": "date", "type": "date", "label": "Date tested", "required": True},
            ],
        },
    },
    "extinguisher_monthly": {
        "name": "Fire extinguisher monthly inspection",
        "category": "Safety",
        "tags": ["Monthly", "Safety", "NFPA 10"],
        "description": "Monthly visual inspection (NFPA 10).",
        "schema": {
            "items": [
                {
                    "id": "checkin",
                    "type": "location_check_in",
                    "label": "Check in at the extinguisher's location",
                    "buffer_m": 30,
                    "allow_skip": True,
                },
                {"id": "gauge", "type": "inspection", "label": "Pressure gauge in the green", "required": True},
                {"id": "pin", "type": "inspection", "label": "Pin and tamper seal intact", "required": True},
                {"id": "body", "type": "inspection", "label": "No dents, corrosion or damaged hose"},
                {
                    "id": "type",
                    "type": "multiple_choice",
                    "label": "Extinguisher type",
                    "options": ["ABC dry chemical", "CO2", "Water", "Class K"],
                },
                {"id": "tag", "type": "checkbox", "label": "Inspection tag initialled", "required": True},
            ],
        },
    },
    "loto": {
        "name": "Lockout / tagout verification",
        "category": "Safety",
        "tags": ["LOTO", "Safety"],
        "description": "Verify zero energy before work. Steps for stored energy appear only when there is some.",
        "schema": {
            "items": [
                {"id": "h1", "type": "heading", "label": "Isolate"},
                {"id": "notify", "type": "checkbox", "label": "Affected employees notified", "required": True},
                {
                    "id": "sources",
                    "type": "checklist",
                    "label": "Energy sources isolated",
                    "options": ["Electrical", "Pneumatic", "Hydraulic", "Gravity / spring", "Thermal"],
                    "required": True,
                },
                {
                    "id": "locks",
                    "type": "number",
                    "label": "Number of locks applied",
                    "required": True,
                    "min": 1,
                    "max": 50,
                },
                {
                    "id": "stored",
                    "type": "yes_no_na",
                    "label": "Is there stored energy (springs, accumulators, capacitors)?",
                    "required": True,
                },
                {
                    "id": "stored_sec",
                    "type": "section",
                    "label": "Release stored energy",
                    "condition": {"field": "stored", "op": "eq", "value": "yes"},
                    "items": [
                        {"id": "bled", "type": "checkbox", "label": "Pressure bled / blocked", "required": True},
                        {
                            "id": "blocked",
                            "type": "checkbox",
                            "label": "Parts blocked against movement",
                            "required": True,
                        },
                    ],
                },
                {"id": "h2", "type": "heading", "label": "Verify"},
                {
                    "id": "tryout",
                    "type": "inspection",
                    "label": "Try-out: start attempted, nothing moves",
                    "required": True,
                },
                {"id": "sign", "type": "signature", "label": "Authorized employee", "required": True},
            ],
        },
    },
}


def seed_procedures(org: Organization, admin: User) -> None:
    """Library procedures from the templates, attached (with answers) to a few demo work orders."""
    from mpro.procedures import services as svc
    from mpro.procedures.models import Procedure

    if db.session.scalar(select(Procedure.id).where(Procedure.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    from mpro.meters.models import Meter
    from mpro.workorders.models import WorkOrder

    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        made: dict[str, Any] = {}
        lwt = db.session.scalars(
            select(Meter).where(Meter.org_id == org.id, Meter.name == "Leaving water temp")
        ).first()
        for key, t in TEMPLATES.items():
            schema = copy.deepcopy(t["schema"])
            if key == "chiller_quarterly" and lwt is not None:
                schema["items"][1]["items"][0]["meter_id"] = str(lwt.id)
            p = svc.create_procedure(
                org,
                m,
                {
                    "name": t["name"],
                    "description": t["description"],
                    "category": t["category"],
                    "tags": t["tags"],
                    "schema": schema,
                },
            )
            svc.publish(org, m, p)
            made[key] = p
        # a winter variant of the eyewash check (r598): tempered water lines are checked in the cold months
        winter = svc.create_procedure(
            org,
            m,
            {
                "name": "Eyewash station weekly check (winter)",
                "category": "Safety",
                "tags": ["Weekly", "Safety", "Winter"],
                "schema": {
                    "items": copy.deepcopy(TEMPLATES["eyewash_weekly"]["schema"]["items"])
                    + [
                        {
                            "id": "heat",
                            "type": "inspection",
                            "label": "Heat trace / tempering valve working",
                            "required": True,
                        }
                    ]
                },
            },
        )
        svc.publish(org, m, winter)
        svc.update_procedure(
            org,
            m,
            made["eyewash_weekly"],
            {"variants": [{"name": "Winter", "months": [11, 12, 1, 2, 3], "procedure_id": str(winter.id)}]},
        )

        def wo(title_part: str) -> WorkOrder | None:
            return db.session.scalars(
                select(WorkOrder).where(WorkOrder.org_id == org.id, WorkOrder.title.ilike(f"%{title_part}%"))
            ).first()

        chiller = wo("Chiller 1 quarterly")
        if chiller is not None and chiller.status not in ("done", "canceled"):
            run = svc.attach_procedures(org, m, chiller, [made["chiller_quarterly"].id], commit=True)[0]
            for fid, body in (
                ("ppe", {"value": True}),
                ("notify", {"value": True}),
                ("approach", {"value": 6.5}),
                ("oil", {"value": "pass"}),
                ("leaks", {"value": "flag", "note": "Bubbles at the suction service valve"}),
                ("leak_where", {"value": "Suction service valve cap"}),
            ):
                svc.answer(org, m, chiller, run, fid, body)
        eyewash = wo("Eyewash station weekly")
        if eyewash is not None and eyewash.status not in ("done", "canceled"):
            svc.attach_procedures(org, m, eyewash, [made["eyewash_weekly"].id], commit=True)
        forklift = wo("Forklift 3 hydraulic")
        if forklift is not None and forklift.status not in ("done", "canceled"):
            run = svc.attach_procedures(org, m, forklift, [made["forklift_daily"].id], commit=True)[0]
            for fid, body in (
                ("forks", {"value": "pass"}),
                ("hydraulics", {"value": "fail", "note": "Mast cylinder seal leaking"}),
                ("tires", {"value": "pass"}),
            ):
                svc.answer(org, m, forklift, run, fid, body)
        emerg = wo("Emergency lighting")
        if emerg is not None and emerg.status not in ("done", "canceled"):
            svc.attach_procedures(org, m, emerg, [made["extinguisher_monthly"].id], commit=True)
        db.session.commit()
