"""Vendor PO acknowledgment (0.6.0, roadmap r261).

Sending a PO to the vendor puts a no-login link in the email. The vendor sees the order (what they need to fill it,
nothing internal) and answers: Acknowledge, propose a delivery date, or decline with a note. Only the token's sha256
is stored (like shared work-order links); a new send replaces the link, and it stops working once the PO is complete
or canceled. The public endpoints share the per-IP rate limits of external work-order links.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any, cast

from flask import current_app
from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.orgs.models import Organization
from mpro.orgs.services import RuleError
from mpro.purchasing.models import Address, PurchaseOrder, PurchaseOrderVendorLink
from mpro.workorders import external as ext

RESPONSES = {
    "acknowledged": "Acknowledged",
    "proposed_date": "Proposed a delivery date",
    "declined": "Declined",
}
CLOSED = ("complete", "canceled")


class LinkError(RuleError):
    pass


def link_url(token: str) -> str:
    return str(current_app.config.get("MPRO_BASE_URL", "")).rstrip("/") + f"/v/{token}"


def new_link(org_id: uuid.UUID, po: PurchaseOrder, recipients: list[str], user_id: uuid.UUID | None) -> str:
    """Replace any earlier link for this PO with a fresh one; returns the token (shown only in the email)."""
    for old in db.session.scalars(
        select(PurchaseOrderVendorLink).where(
            PurchaseOrderVendorLink.purchase_order_id == po.id, PurchaseOrderVendorLink.status == "active"
        )
    ).all():
        old.status = "replaced"
    token = ext.new_token()
    db.session.add(
        PurchaseOrderVendorLink(
            org_id=org_id,
            purchase_order_id=po.id,
            token_hash=ext.token_hash(token),
            recipients=list(recipients)[:20],
            created_by_id=user_id,
        )
    )
    db.session.flush()
    return token


def current(po: PurchaseOrder) -> PurchaseOrderVendorLink | None:
    """The latest link (active or replaced) for the PO page."""
    return db.session.scalars(
        select(PurchaseOrderVendorLink)
        .where(PurchaseOrderVendorLink.purchase_order_id == po.id)
        .order_by(PurchaseOrderVendorLink.created_at.desc())
    ).first()


def ack_dict(link: PurchaseOrderVendorLink | None) -> dict[str, Any] | None:
    """What the PO page shows about the vendor's answer."""
    if link is None:
        return None
    return {
        "status": link.status,
        "response": link.response or None,
        "response_label": RESPONSES.get(link.response, "No answer yet"),
        "responder_name": link.responder_name,
        "proposed_date": link.proposed_date.isoformat() if link.proposed_date else None,
        "note": link.note,
        "responded_at": iso(link.responded_at),
        "last_viewed_at": iso(link.last_viewed_at),
        "sent_at": iso(link.created_at),
        "recipients": link.recipients or [],
    }


def resolve(token: str, write: bool = False) -> tuple[PurchaseOrderVendorLink, PurchaseOrder, Organization]:
    """The active link for a token, or LinkError (404). Counts towards the shared external-link rate limits."""
    link = None
    if token and len(token) <= 100:
        link = db.session.scalars(
            select(PurchaseOrderVendorLink).where(PurchaseOrderVendorLink.token_hash == ext.token_hash(token))
        ).first()
    po = db.session.get(PurchaseOrder, link.purchase_order_id) if link is not None else None
    org = db.session.get(Organization, link.org_id) if link is not None else None
    ok = (
        link is not None
        and link.status == "active"
        and po is not None
        and po.org_id == link.org_id
        and po.deleted_at is None
        and po.status not in CLOSED
        and org is not None
        and org.deleted_at is None
    )
    # the hit table is keyed by link id; a vendor link's id never collides with a work-order share's
    ext.throttle(cast(Any, link) if ok else None, ok, write and ok)
    if not ok or link is None or po is None or org is None:
        raise LinkError("This link doesn't work any more. The order may be complete, canceled or sent again.", 404)
    return link, po, org


def public_view(link: PurchaseOrderVendorLink, po: PurchaseOrder, org: Organization) -> dict[str, Any]:
    """Only what the vendor needs to fill the order: no internal notes, approvals, budgets or people."""
    from mpro.purchasing import services as svc

    lines = svc.lines_of(po)
    costs = svc.costs_of(po)
    totals = svc.compute_totals(lines, costs)
    ship = db.session.get(Address, po.shipping_address_id) if po.shipping_address_id else None
    link.last_viewed_at = utcnow()
    db.session.commit()
    return {
        "organization": org.name,
        "number": svc.po_number(po),
        "title": po.title,
        "status": po.status,
        "currency": po.currency,
        "due_on": po.due_on.isoformat() if po.due_on else None,
        "ship_to": {k: getattr(ship, k) for k in (*svc.ADDR_FIELDS, "country")} if ship else None,
        "lines": [
            {
                "description": ln.description,
                "part_number": ln.part_number,
                "unit": ln.unit,
                "quantity": svc.num(ln.quantity),
                "unit_cost": svc.num(ln.unit_cost),
                "amount": svc.num(svc._r(ln.quantity * ln.unit_cost)),
            }
            for ln in lines
        ],
        "costs": [{"label": c.label, "amount": svc.num(totals["amounts"].get(c.id))} for c in costs],
        "subtotal": svc.num(po.subtotal),
        "total": svc.num(po.total),
        "answer": ack_dict(link),
    }


def respond(
    link: PurchaseOrderVendorLink, po: PurchaseOrder, org: Organization, data: dict[str, Any]
) -> dict[str, Any]:
    from mpro.purchasing import services as svc

    response = str(data.get("response") or "")
    if response not in RESPONSES:
        raise RuleError("Choose Acknowledge, Propose a date or Decline.", 422)
    name = " ".join(str(data.get("name") or "").split())[:200]
    if not name:
        raise RuleError("Type your name so the buyer knows who answered.", 422)
    note = str(data.get("note") or "").strip()[:4000]
    proposed: date | None = None
    if response == "proposed_date":
        try:
            proposed = date.fromisoformat(str(data.get("date") or ""))
        except ValueError as e:
            raise RuleError("Pick the date you can deliver by.", 422) from e
    if response == "declined" and not note:
        raise RuleError("Say why you can't fill this order.", 422)
    link.response, link.responder_name, link.note = response, name, note
    link.proposed_date = proposed
    link.responded_at = utcnow()
    summary = f"{name} (vendor): {RESPONSES[response]}"
    if proposed:
        summary += f" for {proposed.isoformat()}"
    emit(
        f"purchase_order.vendor_{response}",
        entity_type="purchase_order",
        entity_id=po.id,
        entity_label=svc.po_number(po),
        summary=summary,
        data={
            "response": response,
            "responder_name": name,
            "proposed_date": proposed.isoformat() if proposed else None,
            "note": note[:500],
            "vendor_id": str(po.vendor_id) if po.vendor_id else None,
        },
        org_id=org.id,
    )
    db.session.commit()
    return ack_dict(link) or {}
