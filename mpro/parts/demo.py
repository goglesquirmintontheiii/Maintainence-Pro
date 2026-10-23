"""Demo data for the parts module (0.5.0, MP-039–041): a small storeroom with a few parts low on stock,
some used on work orders, one cycle count. Links vendors and assets when those demo records exist."""

from __future__ import annotations

from typing import Any

from flask import current_app, g
from sqlalchemy import func, select

from mpro.extensions import db

TYPES = [
    ("Bearings", "#3b82f6", False),
    ("Belts", "#8b5cf6", False),
    ("Filters", "#10b981", False),
    ("Electrical", "#f59e0b", True),
    ("Lubricants", "#64748b", False),
]

# name, part number, unit, unit cost, types, barcode, [(location, area, min, max, qty)], asset name hint
PARTS: list[tuple[str, str, str, str, list[str], str, list[tuple[str, str, str, str, str]], str]] = [
    (
        "Ball bearing 6205-2RS",
        "BRG-6205",
        "each",
        "8.40",
        ["Bearings"],
        "0789123456052",
        [("Building B - Warehouse", "Aisle 3 / Bin 12", "10", "40", "24")],
        "Conveyor",
    ),
    (
        "Ball bearing 6308-ZZ",
        "BRG-6308",
        "each",
        "21.75",
        ["Bearings"],
        "",
        [("Building B - Warehouse", "Aisle 3 / Bin 14", "4", "12", "3")],
        "Motor",
    ),
    (
        "V-belt A42",
        "BLT-A42",
        "each",
        "12.10",
        ["Belts"],
        "0789123454201",
        [("Building B - Warehouse", "Aisle 4 / Bin 2", "6", "20", "9"), ("Compressor Room", "Cabinet", "2", "4", "2")],
        "Compressor",
    ),
    (
        "Timing belt HTD 8M-1200",
        "BLT-8M1200",
        "each",
        "64.00",
        ["Belts"],
        "",
        [("Building B - Warehouse", "Aisle 4 / Bin 7", "1", "3", "0")],
        "Conveyor",
    ),
    (
        "Pleated air filter 20x25x2 MERV 13",
        "FLT-20252",
        "each",
        "14.60",
        ["Filters"],
        "0789123452025",
        [("Mechanical Room", "Shelf B", "12", "48", "30")],
        "Air Handler",
    ),
    (
        "Compressor intake filter",
        "FLT-CMP-01",
        "each",
        "38.90",
        ["Filters"],
        "",
        [("Compressor Room", "Cabinet", "2", "6", "1")],
        "Compressor",
    ),
    (
        "Contactor 3-pole 40 A",
        "ELC-CT40",
        "each",
        "86.50",
        ["Electrical"],
        "",
        [("Building B - Warehouse", "Electrical cage", "2", "6", "4")],
        "Motor",
    ),
    (
        "Fuse 30 A time-delay",
        "ELC-FU30",
        "each",
        "6.20",
        ["Electrical"],
        "",
        [("Building B - Warehouse", "Electrical cage", "20", "60", "12")],
        "",
    ),
    (
        "Food-grade grease NLGI 2",
        "LUB-FG2",
        "tube",
        "11.30",
        ["Lubricants"],
        "",
        [("Building B - Warehouse", "Aisle 1 / Bin 1", "6", "24", "18")],
        "Mixer",
    ),
    (
        "Hydraulic oil ISO 46",
        "LUB-H46",
        "gal",
        "17.80",
        ["Lubricants"],
        "",
        [("Building B - Warehouse", "Fluids room", "10", "40", "22.5")],
        "",
    ),
]


def seed_parts(org: Any, admin: Any) -> None:
    """Seed demo records. Runs after work orders, assets, procedures, PM and automations, in the order
    vendors → parts → purchasing → suppliers → finance."""
    from mpro.assets.models import Asset, Location
    from mpro.orgs.models import Membership
    from mpro.parts import counts as cc
    from mpro.parts import services as svc
    from mpro.parts.models import Part
    from mpro.workorders.models import WorkOrder

    if db.session.scalar(select(Part.id).where(Part.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    try:
        from mpro.vendors.models import Vendor

        vendors = list(
            db.session.scalars(
                select(Vendor)
                .where(Vendor.org_id == org.id, Vendor.deleted_at.is_(None))
                .order_by(Vendor.name)
                .limit(3)
            ).all()
        )
    except Exception:  # vendors module not ready: parts don't need it
        db.session.rollback()
        vendors = []
    locs = {lo.name: lo for lo in db.session.scalars(select(Location).where(Location.org_id == org.id)).all()}
    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        types = {n: svc.save_type(org, {"name": n, "color": c, "critical": crit}) for n, c, crit in TYPES}
        made: list[Part] = []
        for i, (name, num, unit, cost, tnames, barcode, stock, asset_hint) in enumerate(PARTS):
            asset_ids = []
            if asset_hint:
                a = db.session.scalars(
                    select(Asset)
                    .where(Asset.org_id == org.id, func.lower(Asset.name).like(f"%{asset_hint.lower()}%"))
                    .order_by(Asset.name)
                    .limit(1)
                ).first()
                if a is not None:
                    asset_ids.append(str(a.id))
            v = vendors[i % len(vendors)] if vendors else None
            data: dict[str, Any] = {
                "name": name,
                "part_number": num,
                "unit": unit,
                "unit_cost": cost,
                "barcode": barcode,
                "type_ids": [str(types[t].id) for t in tnames],
                "asset_ids": asset_ids,
                "stock": [
                    {"location_id": str(locs[ln].id), "area": area, "min_qty": mn, "max_qty": mx, "initial_quantity": q}
                    for ln, area, mn, mx, q in stock
                    if ln in locs
                ],
            }
            if v is not None:
                data["vendors"] = [
                    {"vendor_id": str(v.id), "vendor_part_number": f"{v.name[:3].upper()}-{num}", "preferred": True}
                ]
            made.append(svc.create_part(org, m, data))
        # A non-stock part (bought when needed).
        svc.create_part(
            org,
            m,
            {
                "name": "Replacement gearbox (special order)",
                "part_number": "GBX-SO",
                "non_stock": True,
                "unit_cost": "1240.00",
                "lead_time_days": 21,
            },
        )
        # Parts on open work orders: one used, one reserved.
        wos = db.session.scalars(
            select(WorkOrder)
            .where(
                WorkOrder.org_id == org.id,
                WorkOrder.status.in_(("open", "in_progress")),
                WorkOrder.deleted_at.is_(None),
            )
            .order_by(WorkOrder.number)
            .limit(2)
        ).all()
        for wo, (p, status, qty) in zip(wos, [(made[0], "issued", "2"), (made[2], "reserved", "1")], strict=False):
            svc.add_to_work_order(org, m, wo, {"part_id": str(p.id), "quantity": qty, "status": status})
        wh = locs.get("Building B - Warehouse")
        if wh is not None:
            cc.save_count(
                org,
                m,
                {
                    "name": "Warehouse bearings",
                    "location_id": str(wh.id),
                    "selection": {"type_ids": [str(types["Bearings"].id)]},
                    "rrule": "FREQ=MONTHLY;BYMONTHDAY=1",
                    "active": True,
                },
            )
        db.session.commit()
