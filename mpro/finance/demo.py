"""Demo data for the 0.5.0 finance module (MP-090–MP-094): tax certificates (one expiring soon), receipts (one charged
sales tax despite the exemption), a vendor invoice with a price exception and a customer invoice. Uses the real
services; skips whatever the other demo modules didn't create (vendors, purchase orders, customers)."""

from __future__ import annotations

import io
import logging
from datetime import timedelta
from decimal import Decimal
from typing import Any

from flask import current_app, g
from sqlalchemy import select

from mpro.extensions import db

log = logging.getLogger(__name__)


def _picture(lines: list[str], size: tuple[int, int] = (360, 480)) -> bytes:
    """A plain receipt / certificate picture (PNG) so the demo has something to look at."""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(im)
    y = 18
    for t in lines:
        d.text((18, y), t, fill=(30, 36, 50))
        y += 22
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def seed_finance(org: Any, admin: Any) -> None:
    """Seed demo records. Runs after work orders, assets, procedures, PM and automations, in the order
    vendors → parts → purchasing → suppliers → finance."""
    from mpro.finance.models import TaxCertificate
    from mpro.orgs.models import Membership

    if db.session.scalar(select(TaxCertificate.id).where(TaxCertificate.org_id == org.id).limit(1)):
        return
    m = db.session.scalars(
        select(Membership).where(Membership.org_id == org.id, Membership.user_id == admin.id)
    ).first()
    if m is None:
        return
    with current_app.test_request_context():
        g.user, g.org, g.membership = admin, org, m
        for step in (_certificates, _receipts, _vendor_invoice, _customer_invoice):
            try:
                with db.session.begin_nested():
                    step(org, admin, m)
            except Exception as e:  # noqa: BLE001 — demo data is best effort; never block the rest of the demo
                log.warning("Finance demo step %s skipped: %s", step.__name__, e)
        db.session.commit()


def _vendors(org: Any) -> list[Any]:
    from mpro.vendors.models import Vendor

    return list(
        db.session.scalars(
            select(Vendor).where(Vendor.org_id == org.id, Vendor.deleted_at.is_(None)).order_by(Vendor.created_at)
        )
    )


def _certificates(org: Any, admin: Any, m: Any) -> None:
    from mpro.finance import certificates as certs
    from mpro.finance.common import today

    on = today()
    il = certs.create(
        org.id,
        admin,
        {
            "type": "resale",
            "country": "US",
            "region": "IL",
            "number": "2931-0457",
            "legal_entity": org.name,
            "issued_on": (on - timedelta(days=345)).isoformat(),
            "expires_on": (on + timedelta(days=21)).isoformat(),  # expiring soon: shows the reminder state
            "card_user_ids": [str(admin.id)],
            "scope_notes": "Parts and supplies bought for resale to service customers.",
        },
    )
    pic = _picture(
        ["ILLINOIS RESALE CERTIFICATE", "CRT-61", "", f"Purchaser: {org.name}", "Number: 2931-0457", "Signed: (demo)"]
    )
    certs.add_scan(org.id, il, "il-crt-61.png", pic, admin)
    for v in _vendors(org)[:2]:
        certs.set_vendor(org.id, il, {"vendor_id": str(v.id), "status": "on_file", "auto_resend": True})
    certs.create(
        org.id,
        admin,
        {
            "type": "resale",
            "country": "US",
            "multistate_form": "sst",
            "covered_regions": ["IN", "KY", "MI", "OH"],
            "number": "SST-55-01882",
            "legal_entity": org.name,
            "issued_on": (on - timedelta(days=60)).isoformat(),
            "expires_on": (on + timedelta(days=700)).isoformat(),
        },
    )


def _receipts(org: Any, admin: Any, m: Any) -> None:
    from mpro.finance import receipts
    from mpro.finance.common import today
    from mpro.workorders.models import WorkOrder

    on = today()
    vendors = _vendors(org)
    wo = db.session.scalars(
        select(WorkOrder).where(WorkOrder.org_id == org.id, WorkOrder.deleted_at.is_(None)).order_by(WorkOrder.number)
    ).first()
    v0 = vendors[0] if vendors else None
    # charged tax although the Illinois certificate is on file with this vendor → "tax to reclaim"
    r1 = receipts.create(
        org.id,
        admin,
        [
            (
                "receipt-1.png",
                _picture(
                    [
                        v0.name if v0 else "Hardware store",
                        "V-belt A42 x2  38.50",
                        "Tax  3.18",
                        "TOTAL  41.68",
                        "VISA ****4417",
                    ]
                ),
            )
        ],
        source="camera",
        fields={
            "vendor_id": str(v0.id) if v0 else None,
            "vendor_name": v0.name if v0 else "Hardware store",
            "purchased_on": (on - timedelta(days=3)).isoformat(),
            "subtotal": "38.50",
            "tax": "3.18",
            "total": "41.68",
            "region": "IL",
            "card_last4": "4417",
        },
    )
    if wo is not None:
        receipts.attach_to(org.id, r1, {"target": "work_order", "id": str(wo.id), "cost_type": "Parts"}, m)
    receipts.create(
        org.id,
        admin,
        [("receipt-2.png", _picture(["Corner Gas & Go", "Unleaded 11.2 gal", "TOTAL  42.10"]))],
        source="upload",
        fields={
            "vendor_name": "Corner Gas & Go",
            "purchased_on": (on - timedelta(days=6)).isoformat(),
            "total": "42.10",
            "expense_category": "Fuel",
            "paid_personally": True,
        },
    )
    r3 = receipts.create(
        org.id,
        admin,
        [("receipt-3.png", _picture(["Office Depot", "Label tape x3  29.97", "TOTAL  29.97"]))],
        fields={"vendor_name": "Office Depot", "purchased_on": (on - timedelta(days=9)).isoformat(), "total": "29.97"},
    )
    receipts.attach_to(org.id, r3, {"target": "expense", "category": "Office supplies"}, m)


def _vendor_invoice(org: Any, admin: Any, m: Any) -> None:
    from mpro.finance import invoices
    from mpro.finance.common import today
    from mpro.purchasing.models import PurchaseOrder, PurchaseOrderLine

    po = db.session.scalars(
        select(PurchaseOrder)
        .where(
            PurchaseOrder.org_id == org.id,
            PurchaseOrder.deleted_at.is_(None),
            PurchaseOrder.vendor_id.is_not(None),
            PurchaseOrder.status.in_(("partially_fulfilled", "complete", "approved")),
        )
        .order_by(PurchaseOrder.number)
    ).first()
    if po is None:
        return
    lines = list(
        db.session.scalars(
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.purchase_order_id == po.id)
            .order_by(PurchaseOrderLine.sort)
        )
    )
    if not lines:
        return
    on = today()
    inv_lines = []
    for i, ln in enumerate(lines):
        # the first line is billed 8% above the PO price: a price exception for the exceptions queue
        price = (ln.unit_cost * Decimal("1.08")).quantize(Decimal("0.01")) if i == 0 else ln.unit_cost
        inv_lines.append(
            {
                "po_line_id": str(ln.id),
                "description": ln.description,
                "part_number": ln.part_number,
                "quantity": str(ln.quantity),
                "unit_price": str(price),
            }
        )
    invoices.create(
        org.id,
        admin,
        data={
            "vendor_id": str(po.vendor_id),
            "number": f"INV-{88000 + po.number}",
            "invoice_date": (on - timedelta(days=4)).isoformat(),
            "terms": "2/10 net 30",
            "purchase_order_ids": [str(po.id)],
            "lines": inv_lines,
        },
        source="manual",
    )


def _customer_invoice(org: Any, admin: Any, m: Any) -> None:
    from mpro.finance import billing
    from mpro.vendors.models import Customer
    from mpro.workorders.models import WorkOrder

    cust = db.session.scalars(
        select(Customer).where(Customer.org_id == org.id, Customer.deleted_at.is_(None)).order_by(Customer.created_at)
    ).first()
    if cust is None:
        return
    wos = list(
        db.session.scalars(
            select(WorkOrder)
            .where(
                WorkOrder.org_id == org.id,
                WorkOrder.deleted_at.is_(None),
                WorkOrder.status == "done",
                WorkOrder.customer_id == cust.id,
            )
            .limit(2)
        )
    )
    ci = billing.create(
        org.id,
        admin,
        {
            "customer_id": str(cust.id),
            "work_order_ids": [str(w.id) for w in wos],
            "lines": []
            if wos
            else [
                {
                    "kind": "labor",
                    "description": "Quarterly rooftop unit service — technician time",
                    "quantity": "3.5",
                    "unit_price": "95",
                    "taxable": False,
                },
                {"kind": "part", "description": "Pleated filter 20x25x2", "quantity": "6", "unit_price": "14.25"},
            ],
        },
    )
    if billing._recipient(cust):
        billing.send(org.id, ci, admin)
