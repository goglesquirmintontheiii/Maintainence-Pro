"""Demo purchasing (MP-042–044): addresses, a budget, an approval rule and purchase orders in several
statuses, one partly received through the inventory ledger. Uses the real services."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.extensions import db


def seed_purchasing(org: Any, admin: Any) -> None:
    """Seed demo records. Runs after work orders, assets, procedures, PM and automations, in the order
    vendors → parts → purchasing → suppliers → finance."""
    from mpro.orgs.models import Membership
    from mpro.purchasing import services as svc
    from mpro.purchasing.models import PurchaseOrder
    from mpro.vendors.models import Vendor

    if db.session.scalar(select(PurchaseOrder.id).where(PurchaseOrder.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    try:
        from mpro.parts.models import Part, PartVendor

        parts = list(
            db.session.scalars(select(Part).where(Part.org_id == org.id, Part.deleted_at.is_(None)).order_by(Part.name))
        )
        pv = {r.part_id: r.vendor_id for r in db.session.scalars(select(PartVendor).where(PartVendor.org_id == org.id))}
    except Exception:  # noqa: BLE001  parts module not ready: POs fall back to free-text lines
        parts, pv = [], {}
    vendors = list(
        db.session.scalars(
            select(Vendor).where(Vendor.org_id == org.id, Vendor.deleted_at.is_(None)).order_by(Vendor.name)
        )
    )
    if not vendors:
        return
    today = date.today()

    def lines_for(v: Vendor, n: int) -> list[dict[str, Any]]:
        mine = [p for p in parts if pv.get(p.id) == v.id] or parts
        out = [
            {"part_id": str(p.id), "quantity": str(4 + 2 * i), "unit_cost": str(p.unit_cost or Decimal("10"))}
            for i, p in enumerate(mine[:n])
        ]
        return out or [{"description": "Shop supplies", "quantity": "1", "unit_cost": "120"}]

    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        svc.save_address(
            org,
            {
                "label": "Main plant",
                "company": org.name,
                "attention": "Receiving dock",
                "line1": "1 Industrial Pkwy",
                "city": "Springfield",
                "region": "IL",
                "postal_code": "62701",
                "country": "US",
                "kind": "both",
                "is_default": True,
            },
        )
        svc.save_budget(
            org,
            {"name": "Maintenance parts", "period": "month", "amount": "8000", "approval_limit": "5000"},
        )
        svc.save_rule(
            org,
            {
                "name": "Orders over 2,500 need the owner",
                "conditions": [{"field": "total", "op": ">=", "value": "2500"}],
                "approver_user_ids": [str(admin.id)],
            },
        )
        by_name = {v.name: v for v in vendors}
        a = by_name.get("Apex Bearing & Belt", vendors[0])
        n = by_name.get("Northside Industrial Supply", vendors[-1])
        k = by_name.get("Keystone HVAC Services", vendors[0])
        # received in part: stock goes up through the ledger, the rest is still on order
        po = svc.create_purchase_order(
            org,
            m,
            {
                "vendor_id": str(a.id),
                "title": "Bearings and belts restock",
                "lines": lines_for(a, 3),
                "due_on": (today - timedelta(days=2)).isoformat(),
                "costs": [
                    {"label": "Shipping", "kind": "fixed", "value": "18.50"},
                    {"label": "Sales tax", "kind": "percent", "value": "7.25", "is_tax": True},
                ],
            },
        )
        first = svc.lines_of(po)[0]
        svc.receive(
            org,
            m,
            po,
            {"lines": [{"line_id": str(first.id), "quantity": str(first.quantity)}], "packing_slip": "PS-4410"},
        )
        # approved, due next week
        svc.create_purchase_order(
            org,
            m,
            {
                "vendor_id": str(n.id),
                "title": "Filters for the quarter",
                "lines": lines_for(n, 2),
                "due_on": (today + timedelta(days=7)).isoformat(),
            },
        )
        # waiting on the approval rule
        svc.create_purchase_order(
            org,
            m,
            {
                "vendor_id": str(k.id),
                "title": "Chiller service contract",
                "lines": [{"description": "Annual chiller service", "quantity": "1", "unit_cost": "3200"}],
            },
        )
        # a request from a technician
        svc.create_purchase_order(
            org,
            m,
            {
                "vendor_id": str(n.id),
                "title": "Shop rags and gloves",
                "as_request": True,
                "lines": [{"description": "Nitrile gloves, box of 100", "quantity": "6", "unit_cost": "11.90"}],
            },
        )
        # finished
        done = svc.create_purchase_order(
            org, m, {"vendor_id": str(a.id), "title": "Spare V-belts", "lines": lines_for(a, 1)}
        )
        svc.receive(
            org,
            m,
            done,
            {"lines": [{"line_id": str(ln.id), "quantity": str(ln.quantity)} for ln in svc.lines_of(done)]},
        )
