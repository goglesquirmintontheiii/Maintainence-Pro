# ruff: noqa: E501  (sample data rows read better on one line)
"""Demo locations, assets, meters and QR codes for the demo organization. Uses the real services."""

from __future__ import annotations

import math
import random
from datetime import timedelta
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.assets import services as svc
from mpro.assets.models import Asset, AssetStatusChange, Location
from mpro.auth.models import User
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team

# name, parent, address/city
LOCATIONS = [
    (
        "Dayton Plant",
        None,
        {
            "address_line1": "1200 Industrial Pkwy",
            "city": "Dayton",
            "region": "OH",
            "postal_code": "45414",
            "country": "United States",
            "latitude": 39.8131,
            "longitude": -84.2005,
        },
    ),
    ("Building A - Production", "Dayton Plant", {}),
    ("Line 2", "Building A - Production", {}),
    ("Line 3", "Building A - Production", {}),
    ("Paint Line", "Building A - Production", {}),
    ("Compressor Room", "Building A - Production", {}),
    ("Building B - Warehouse", "Dayton Plant", {}),
    ("Shipping Docks", "Building B - Warehouse", {}),
    ("Roof", "Dayton Plant", {}),
    ("Mechanical Room", "Dayton Plant", {}),
    ("Office", "Dayton Plant", {}),
    (
        "Springfield Distribution Center",
        None,
        {
            "address_line1": "45 Commerce Dr",
            "city": "Springfield",
            "region": "OH",
            "postal_code": "45505",
            "country": "United States",
            "latitude": 39.9242,
            "longitude": -83.8088,
        },
    ),
]
TYPES = [
    ("Conveyor", "#1b5bd4"),
    ("Motor", "#b8560b"),
    ("HVAC", "#0a7f96"),
    ("Compressor", "#7a52c9"),
    ("Vehicle", "#2f8f46"),
    ("Door", "#5d6880"),
    ("Pump", "#c43c5c"),
]
# name, parent asset, location, types, criticality, manufacturer, model, serial, year, team
ASSETS = [
    ("Line 2 Packaging Line", None, "Line 2", ["Conveyor"], "critical", "", "", "", 2016, "Mechanical"),
    (
        "Conveyor 2",
        "Line 2 Packaging Line",
        "Line 2",
        ["Conveyor"],
        "critical",
        "Hytrol",
        "E24EZ",
        "HY-22841",
        2016,
        "Mechanical",
    ),
    (
        "Conveyor 2 Drive Motor",
        "Conveyor 2",
        "Line 2",
        ["Motor"],
        "important",
        "Baldor",
        "EM3615T",
        "Z1709301234",
        2016,
        "Electrical",
    ),
    (
        "Mixer M-2",
        "Line 2 Packaging Line",
        "Line 2",
        ["Motor"],
        "critical",
        "Ross",
        "HSM-100",
        "R-77120",
        2018,
        "Mechanical",
    ),
    (
        "Mixer M-2 VFD",
        "Mixer M-2",
        "Line 2",
        ["Motor"],
        "important",
        "Allen-Bradley",
        "PowerFlex 525",
        "AB525-90311",
        2018,
        "Electrical",
    ),
    (
        "Palletizer",
        "Line 2 Packaging Line",
        "Line 2",
        [],
        "important",
        "Columbia",
        "FL5000",
        "COL-5521",
        2019,
        "Mechanical",
    ),
    ("Line 3 Assembly Line", None, "Line 3", ["Conveyor"], "critical", "", "", "", 2014, "Mechanical"),
    (
        "Conveyor 3",
        "Line 3 Assembly Line",
        "Line 3",
        ["Conveyor"],
        "critical",
        "Hytrol",
        "ABEZ",
        "HY-19920",
        2014,
        "Mechanical",
    ),
    (
        "Conveyor 3 Drive Motor",
        "Conveyor 3",
        "Line 3",
        ["Motor"],
        "important",
        "Baldor",
        "EM3611T",
        "Z1405567781",
        2014,
        "Electrical",
    ),
    (
        "Paint Booth Exhaust Fan",
        None,
        "Paint Line",
        ["Motor"],
        "important",
        "Greenheck",
        "SQ-120",
        "GH-0098812",
        2015,
        "Facilities",
    ),
    (
        "Air Compressor 1",
        None,
        "Compressor Room",
        ["Compressor"],
        "critical",
        "Atlas Copco",
        "GA 37 VSD+",
        "AIF-095512",
        2020,
        "Mechanical",
    ),
    (
        "Air Compressor 2",
        None,
        "Compressor Room",
        ["Compressor"],
        "critical",
        "Atlas Copco",
        "GA 37",
        "AIF-071144",
        2012,
        "Mechanical",
    ),
    (
        "Refrigerated Air Dryer",
        "Air Compressor 2",
        "Compressor Room",
        [],
        "normal",
        "Atlas Copco",
        "FD 120",
        "AIF-071190",
        2012,
        "Mechanical",
    ),
    ("Chiller 1", None, "Mechanical Room", ["HVAC"], "critical", "Trane", "CGAM 070", "U18B04521", 2018, "HVAC"),
    (
        "Boiler 1",
        None,
        "Mechanical Room",
        ["HVAC"],
        "critical",
        "Lochinvar",
        "Crest FBN2001",
        "LV-1611-2241",
        2016,
        "HVAC",
    ),
    (
        "Chilled Water Pump P-1",
        "Chiller 1",
        "Mechanical Room",
        ["Pump"],
        "important",
        "Bell & Gossett",
        "e-1510",
        "BG-77310",
        2018,
        "HVAC",
    ),
    ("AHU-2", None, "Roof", ["HVAC"], "important", "Trane", "Performance Climate Changer", "K19D11871", 2019, "HVAC"),
    ("RTU-4", None, "Roof", ["HVAC"], "normal", "Carrier", "48FC", "2817G30115", 2017, "HVAC"),
    ("Dock Door 4", None, "Shipping Docks", ["Door"], "normal", "Rytec", "Spiral FV", "RY-4410", 2015, "Facilities"),
    (
        "Forklift 3",
        None,
        "Building B - Warehouse",
        ["Vehicle"],
        "important",
        "Toyota",
        "8FGCU25",
        "8FGCU25-71244",
        2019,
        "Mechanical",
    ),
    (
        "Forklift 5",
        None,
        "Springfield Distribution Center",
        ["Vehicle"],
        "important",
        "Crown",
        "RC 5500",
        "CR-1A445621",
        2021,
        "Mechanical",
    ),
    ("Bandsaw", None, "Building A - Production", [], "normal", "DoALL", "C-916M", "DA-58812", 2026, "Mechanical"),
    ("Eyewash Station 1", None, "Building A - Production", [], "important", "Haws", "7360", "", 2017, "Facilities"),
    (
        "Emergency Generator",
        None,
        "Dayton Plant",
        [],
        "critical",
        "Generac",
        "SD150",
        "GEN-3009861",
        2013,
        "Electrical",
    ),
]
# work order title keyword -> asset name
WO_ASSETS = {
    "Conveyor 3 drive belt": "Conveyor 3",
    "AHU-2": "AHU-2",
    "compressor 2": "Air Compressor 2",
    "Dock door 4": "Dock Door 4",
    "Chiller 1": "Chiller 1",
    "mixer M-2": "Mixer M-2 VFD",
    "line 2 bearings": "Conveyor 2",
    "Eyewash": "Eyewash Station 1",
    "bandsaw": "Bandsaw",
    "RTU-4": "RTU-4",
    "Forklift 3": "Forklift 3",
    "Paint line booth exhaust": "Paint Booth Exhaust Fan",
    "Boiler": "Boiler 1",
    "palletizer": "Palletizer",
    "conveyor 2 rollers": "Conveyor 2",
    "Line 2": "Line 2 Packaging Line",
}


def seed_assets(org: Organization, admin: User) -> None:
    if db.session.scalar(select(Asset.id).where(Asset.org_id == org.id).limit(1)):
        return
    from mpro.meters import services as msvc
    from mpro.meters.models import MeterReading
    from mpro.qr import services as qsvc

    rnd = random.Random(7)
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    assert m is not None
    teams = {t.name: str(t.id) for t in db.session.scalars(select(Team).where(Team.org_id == org.id)).all()}
    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        locs: dict[str, Location] = {}
        for name, parent, extra in LOCATIONS:
            locs[name] = svc.create_location(
                org, m, {"name": name, "parent_id": str(locs[parent].id) if parent else None, **extra}
            )
        svc.update_location(org, m, locs["Mechanical Room"], {"teams": [teams["HVAC"]]})
        svc.update_location(org, m, locs["Compressor Room"], {"teams": [teams["Mechanical"]]})
        types = {n: str(svc.save_asset_type(org, {"name": n, "color": c}).id) for n, c in TYPES}
        from mpro.workorders.services import save_custom_field

        hp = save_custom_field(org, {"name": "Horsepower", "type": "number"}, entity_type="asset")
        save_custom_field(
            org,
            {
                "name": "Refrigerant",
                "type": "select",
                "options": ["R-410A", "R-134a", "R-32", "R-454B"],
                "scope_id": types["HVAC"],
            },
            entity_type="asset",
        )
        assets: dict[str, Asset] = {}
        today = utcnow().date()
        for name, parent, loc_name, tnames, crit, mfr, model, serial, year, team in ASSETS:
            data: dict[str, Any] = {
                "name": name, "parent_id": str(assets[parent].id) if parent else None, "location_id": str(locs[loc_name].id),
                "types": [types[t] for t in tnames], "criticality": crit, "manufacturer": mfr, "model": model, "serial_number": serial,
                "year": year, "teams": [teams[team]] if team in teams else [], "commissioned_on": f"{year}-03-01" if year else None,
                "expected_life_years": 15 if crit == "critical" else 12,
            }  # fmt: skip
            if "Motor" in tnames:
                data["custom"] = {str(hp.id): rnd.choice([5, 10, 15, 25, 40])}
            if year and year >= 2018:
                data.update({"warranty_start": f"{year}-03-01", "warranty_end": (today + timedelta(days=rnd.choice([25, 40, 75, 200, 400]))).isoformat() if year >= 2020 else f"{year + 5}-03-01",
                             "warranty_provider": mfr or "Manufacturer", "warranty_terms": "Parts and labor. Excludes wear items."})  # fmt: skip
            if crit == "critical" and year:
                data.update({"purchase_price_cents": rnd.choice([1_850_000, 4_200_000, 6_500_000, 9_800_000]), "purchase_date": f"{year}-02-15",
                             "useful_life_years": 15, "salvage_value_cents": 250_000, "replacement_cost_cents": 7_500_000,
                             "replacement_year": year + 15})  # fmt: skip
            assets[name] = svc.create_asset(org, m, data)
        # status history: a few outages over the last 60 days, for availability
        now = utcnow()
        for a in assets.values():  # the demo plant has been on MPro for three months
            a.created_at = now - timedelta(days=90)
            for first in db.session.scalars(select(AssetStatusChange).where(AssetStatusChange.asset_id == a.id)).all():
                first.at = now - timedelta(days=90)
        db.session.flush()
        for name, outages in (("Air Compressor 2", [(50, 6, "Breakdown"), (21, 30, "Waiting on parts"), (3, 4, "Breakdown")]),
                              ("Conveyor 3", [(40, 2, "Breakdown"), (9, 3, "Breakdown")]), ("Chiller 1", [(30, 8, "Preventive maintenance")]),
                              ("Forklift 3", [(12, 48, "Breakdown")]), ("Mixer M-2", [(16, 5, "Breakdown")])):  # fmt: skip
            a = assets[name]
            for days_ago, hours, reason in outages:
                start = now - timedelta(days=days_ago)
                svc.set_status(
                    org,
                    m,
                    a,
                    "offline",
                    reason=reason,
                    downtime_type="planned" if reason == "Preventive maintenance" else "unplanned",
                    at=start,
                )
                svc.set_status(org, m, a, "online", at=start + timedelta(hours=hours))
        svc.set_status(
            org,
            m,
            assets["Forklift 3"],
            "offline",
            reason="Breakdown",
            note="Hydraulic leak at the mast. Tagged out.",
            at=now - timedelta(hours=20),
        )
        svc.set_status(org, m, assets["Dock Door 4"], "offline", reason="Waiting on parts", at=now - timedelta(days=2))
        svc.set_status(org, m, assets["Bandsaw"], "do_not_track", reason="Out of service", note="Not commissioned yet.")
        # meters with two months of readings
        meters = [
            ("Run hours", "hours", "Air Compressor 1", "day", None, None, (4100, 16, 0.4)),
            ("Discharge pressure", "psi", "Air Compressor 2", "day", 110, 125, (102, 0, 3.0)),
            ("Bearing temperature", "°F", "Conveyor 3 Drive Motor", "week", 160, 180, (132, 0, 5.0)),
            ("Vibration", "in/s", "Mixer M-2", "week", 0.3, 0.45, (0.16, 0, 0.03)),
            ("Odometer", "hours", "Forklift 3", "week", None, None, (6200, 6, 1.0)),
            ("Leaving water temp", "°F", "Chiller 1", "day", 46, 50, (44, 0, 0.8)),
        ]
        rd: dict[str, Any] = {}
        for name, unit, aname, freq, warn, alarm, (base, slope, noise) in meters:
            mt = msvc.create_meter(org, m, {"name": name, "unit": unit, "asset_id": str(assets[aname].id), "reading_frequency": freq,
                                            "warning_high": warn, "alarm_high": alarm})  # fmt: skip
            rd[name] = mt
            v = float(base)
            step = 1 if freq == "day" else 7
            for i in range(60, 0, -step):
                v = v + slope * step if slope else base + noise * math.sin(i / 5) + rnd.uniform(-noise, noise)
                if name == "Bearing temperature" and i < 10:
                    v += 22  # trending up
                db.session.add(MeterReading(org_id=org.id, meter_id=mt.id, value=round(v, 2), recorded_at=now - timedelta(days=i, hours=rnd.randint(0, 6)),
                                            source="manual", recorded_by_id=admin.id, note="", level=msvc.level_for(mt, msvc._dec(round(v, 2), "v")),  # type: ignore[arg-type]
                                            anomaly=False))  # fmt: skip
            db.session.flush()
            last = db.session.scalars(
                select(MeterReading).where(MeterReading.meter_id == mt.id).order_by(MeterReading.recorded_at.desc())
            ).first()
            if last:
                mt.last_value, mt.last_reading_at = last.value, last.recorded_at
            db.session.commit()
        # Leaving water temp is overdue: last reading 3 days ago
        lw = rd["Leaving water temp"]
        lw.last_reading_at = now - timedelta(days=3)
        msvc.save_trigger(org, m, rd["Run hours"], {"kind": "every", "every_units": 2000, "start_at": 4000,
                                                     "work_order": {"title": "Air Compressor 1 - 2,000 hour service", "priority": "medium", "assignees": [f"team:{teams['Mechanical']}"], "due_in_days": 7}})  # fmt: skip
        msvc.save_trigger(org, m, rd["Bearing temperature"], {"kind": "threshold", "comparator": "gt", "threshold": 180,
                                                               "work_order": {"title": "Conveyor 3 motor bearing overheating", "priority": "high"}})  # fmt: skip
        # QR codes on most assets, plus a sheet of blank codes
        for a in list(assets.values())[:18]:
            qsvc.ensure_code(org, m, "asset", a.id, commit=False)
        db.session.commit()
        qsvc.generate_batch(org, m, 6, "Spare labels")
        # put the matching work orders on their assets
        from mpro.workorders.models import WorkOrder

        for wo in db.session.scalars(select(WorkOrder).where(WorkOrder.org_id == org.id)).all():
            for key, aname in WO_ASSETS.items():
                if key.lower() in wo.title.lower():
                    a = assets[aname]
                    wo.asset_id, wo.location_id = a.id, a.location_id
                    break
            else:
                if "Building A" in wo.title:
                    wo.location_id = locs["Building A - Production"].id
                elif "parking" in wo.title.lower():
                    wo.location_id = locs["Dayton Plant"].id
        # a work order with an asset task list (MP-099)
        from mpro.workorders.services import create_work_order

        create_work_order(org, m, {"title": "Quarterly HVAC filter and belt check", "priority": "medium", "work_type": "preventive",
                                   "location_id": str(locs["Roof"].id), "assignees": [f"team:{teams['HVAC']}"],
                                   "asset_tasks": [str(assets[n].id) for n in ("AHU-2", "RTU-4", "Chiller 1", "Boiler 1")],
                                   "due_at": (now + timedelta(days=3)).isoformat()})  # fmt: skip
        db.session.commit()
