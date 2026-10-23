"""Demo vendors (MP-045) and customers with a quote (r234, r235). Uses the real services."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.extensions import db

TYPES = [("Parts supplier", "#3b82f6"), ("Contractor", "#f59e0b"), ("Service provider", "#10b981")]

# name, color, types, email, phone, terms, account, [contacts (name, role, email, po_contact)], asset hints
VENDORS: list[tuple[str, str, list[str], str, str, str, str, list[tuple[str, str, str, bool]], list[str]]] = [
    (
        "Northside Industrial Supply",
        "#2563eb",
        ["Parts supplier"],
        "orders@northside-supply.example",
        "+1 555 0140",
        "Net 30",
        "NIS-20418",
        [("Dana Cole", "Account manager", "dana.cole@northside-supply.example", True)],
        ["Conveyor"],
    ),
    (
        "Apex Bearing & Belt",
        "#7c3aed",
        ["Parts supplier"],
        "sales@apexbb.example",
        "+1 555 0177",
        "2/10 net 30",
        "AB-7731",
        [
            ("Luis Ortega", "Inside sales", "luis@apexbb.example", True),
            ("Accounts payable", "Billing", "ap@apexbb.example", False),
        ],
        ["Motor", "Compressor"],
    ),
    (
        "Brightline Electrical",
        "#d97706",
        ["Contractor", "Parts supplier"],
        "service@brightline.example",
        "+1 555 0123",
        "Net 15",
        "",
        [("Priya Nair", "Dispatcher", "dispatch@brightline.example", True)],
        [],
    ),
    (
        "Keystone HVAC Services",
        "#059669",
        ["Service provider"],
        "hello@keystonehvac.example",
        "+1 555 0199",
        "Net 30",
        "KH-118",
        [("Sam Whitfield", "Service lead", "sam@keystonehvac.example", True)],
        ["Air Handler", "Chiller"],
    ),
]


def seed_vendors(org: Any, admin: Any) -> None:
    """Seed demo records. Runs after work orders, assets, procedures, PM and automations, in the order
    vendors → parts → purchasing → suppliers → finance."""
    from mpro.assets.models import Asset
    from mpro.orgs.models import Membership
    from mpro.vendors import services as svc
    from mpro.vendors.models import Customer, Vendor

    if db.session.scalar(select(Vendor.id).where(Vendor.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    assets = list(db.session.scalars(select(Asset).where(Asset.org_id == org.id, Asset.deleted_at.is_(None))))

    def asset_ids(hints: list[str]) -> list[str]:
        return [str(a.id) for a in assets if any(h.lower() in a.name.lower() for h in hints)][:3]

    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        types = {name: svc.save_vendor_type(org, {"name": name, "color": c}) for name, c in TYPES}
        for name, color, tnames, mail, phone, terms, acct, contacts, hints in VENDORS:
            v = svc.save_vendor(
                org,
                m,
                {
                    "name": name,
                    "color": color,
                    "email": mail,
                    "phone": phone,
                    "payment_terms": terms,
                    "account_number": acct,
                    "type_ids": [str(types[t].id) for t in tnames],
                    "asset_ids": asset_ids(hints),
                    "address": {"line1": "100 Commerce Way", "city": "Springfield", "region": "IL", "country": "US"},
                },
            )
            for cname, role, cmail, po in contacts:
                svc.save_contact(org, v, {"name": cname, "role": role, "email": cmail, "is_po_contact": po})
        if db.session.scalar(select(Customer.id).where(Customer.org_id == org.id).limit(1)):
            return
        riverside = svc.save_customer(
            org,
            m,
            {
                "name": "Riverside Apartments",
                "color": "#0ea5e9",
                "email": "manager@riverside-apts.example",
                "billing_email": "billing@riverside-apts.example",
                "phone": "+1 555 0161",
                "payment_terms": "Net 30",
                "labor_rate": "85",
                "parts_markup_pct": "15",
                "billing_address": {"line1": "22 River Rd", "city": "Springfield", "region": "IL", "country": "US"},
            },
        )
        svc.save_customer_contact(
            org, riverside, {"name": "Morgan Lee", "role": "Property manager", "email": "morgan@riverside-apts.example"}
        )
        svc.save_customer(
            org,
            m,
            {
                "name": "Harbor Foods Co.",
                "color": "#e11d48",
                "email": "facilities@harborfoods.example",
                "payment_terms": "Net 45",
                "labor_rate": "95",
            },
        )
        svc.save_quote(
            org,
            m,
            {
                "customer_id": str(riverside.id),
                "title": "Replace boiler circulation pump",
                "scope": "Remove the failed circulation pump in the boiler room, fit a new one and test the loop.",
                "valid_until": (date.today() + timedelta(days=30)).isoformat(),
                "tax_pct": "8",
                "lines": [
                    {"kind": "labor", "description": "Technician labor (hours)", "quantity": "4", "unit_price": "85"},
                    {"kind": "part", "description": "Circulation pump, 1/6 HP", "quantity": "1", "unit_price": "412"},
                    {"kind": "other", "description": "Disposal of old pump", "quantity": "1", "unit_price": "35"},
                ],
            },
        )
