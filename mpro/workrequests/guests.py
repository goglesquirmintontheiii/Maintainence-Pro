"""Guest role (r236): a customer's contact who signs in and sees only their own sites.

A guest sees work orders at their locations (and every location below them) plus anything made from their own
requests, may complete them and comment, follows the history of assets at those locations, and approves quotes for
their customer. Which locations and which customer is set per guest in Settings → Requests → Guests.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import false, or_, select

from mpro.core.entitlements import entitlements_for
from mpro.core.events import emit
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.workrequests.models import GuestAccess, WorkRequest

FEATURE = "guest_role"


def is_guest(m: Membership | None) -> bool:
    return m is not None and m.role == "guest"


def check_entitled(org: Organization | None) -> None:
    if org is not None and not entitlements_for(org).can_use(FEATURE):
        raise RuleError("Guests aren't included in this plan.", 403)


def access_of(org_id: uuid.UUID, user_id: uuid.UUID) -> GuestAccess | None:
    return db.session.scalars(
        select(GuestAccess).where(GuestAccess.org_id == org_id, GuestAccess.user_id == user_id)
    ).first()


def location_ids(m: Membership) -> list[uuid.UUID]:
    a = access_of(m.org_id, m.user_id)
    out = []
    for raw in (a.location_ids if a else None) or []:
        try:
            out.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    return out


def location_scope(m: Membership) -> Any:
    """SQL `IN` target: the guest's locations and everything below them (empty when none are set)."""
    from mpro.core.hierarchy import TreePath

    ids = location_ids(m)
    if not ids:
        return select(TreePath.descendant_id).where(false())
    return select(TreePath.descendant_id).where(TreePath.kind == "location", TreePath.ancestor_id.in_(ids)).distinct()


def wo_clause(m: Membership) -> Any:
    from mpro.workorders.models import WorkOrder

    from_requests = select(WorkRequest.work_order_id).where(
        WorkRequest.org_id == m.org_id, WorkRequest.created_by_id == m.user_id, WorkRequest.work_order_id.isnot(None)
    )
    return or_(WorkOrder.location_id.in_(location_scope(m)), WorkOrder.id.in_(from_requests))


def can_see_wo(m: Membership, wo: Any) -> bool:
    if wo.location_id is not None and wo.location_id in set(db.session.scalars(location_scope(m)).all()):
        return True
    return bool(
        db.session.scalar(
            select(WorkRequest.id).where(
                WorkRequest.org_id == m.org_id,
                WorkRequest.created_by_id == m.user_id,
                WorkRequest.work_order_id == wo.id,
            )
        )
    )


def can_see_location(m: Membership, location_id: uuid.UUID | None) -> bool:
    return location_id is not None and location_id in set(db.session.scalars(location_scope(m)).all())


# ---- managing guests (admins) --------------------------------------------------------------------
def guest_dict(m: Membership) -> dict[str, Any]:
    from mpro.assets.models import Location
    from mpro.vendors.models import Customer

    a = access_of(m.org_id, m.user_id)
    locs = []
    for lid in location_ids(m):
        loc = db.session.get(Location, lid)
        if loc is not None and loc.org_id == m.org_id and loc.deleted_at is None:
            locs.append({"id": str(loc.id), "name": loc.name})
    cust = db.session.get(Customer, a.customer_id) if a is not None and a.customer_id else None
    return {
        "user_id": str(m.user_id),
        "name": m.user.name,
        "email": m.user.email,
        "locations": locs,
        "customer": {"id": str(cust.id), "name": cust.name} if cust is not None and cust.org_id == m.org_id else None,
    }


def list_guests(org_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        select(Membership).where(
            Membership.org_id == org_id, Membership.role == "guest", Membership.deleted_at.is_(None)
        )
    ).all()
    return sorted((guest_dict(m) for m in rows), key=lambda d: str(d["name"]).lower())


def set_access(org: Organization, target: Membership, data: dict[str, Any]) -> dict[str, Any]:
    """{location_ids: [...], customer_id?} for a member whose role is Guest. Ids are checked against the org."""
    from mpro.assets.models import Location
    from mpro.vendors.models import Customer

    check_entitled(org)
    if target.role != "guest":
        raise RuleError("Only Guests have site access settings.", 422)
    raw = data.get("location_ids") or []
    if not isinstance(raw, list) or len(raw) > 200:
        raise RuleError("Pick up to 200 locations.", 422)
    ids: list[str] = []
    for lid in raw:
        try:
            loc = db.session.get(Location, uuid.UUID(str(lid)))
        except ValueError:
            loc = None
        if loc is None or loc.org_id != org.id or loc.deleted_at is not None:
            raise RuleError("One of the locations doesn't exist.", 422)
        if str(loc.id) not in ids:
            ids.append(str(loc.id))
    cust_id = None
    if data.get("customer_id"):
        try:
            cust = db.session.get(Customer, uuid.UUID(str(data["customer_id"])))
        except ValueError:
            cust = None
        if cust is None or cust.org_id != org.id or cust.deleted_at is not None:
            raise RuleError("That customer doesn't exist.", 422)
        cust_id = cust.id
    a = access_of(org.id, target.user_id)
    if a is None:
        a = GuestAccess(org_id=org.id, user_id=target.user_id)
        db.session.add(a)
    before = {"locations": list(a.location_ids or []), "customer_id": str(a.customer_id) if a.customer_id else None}
    a.location_ids = ids
    a.customer_id = cust_id
    emit(
        "guest.access_changed",
        entity_type="user",
        entity_id=target.user_id,
        entity_label=target.user.name,
        summary=f"Changed {target.user.name}'s guest access",
        changes={"locations": (before["locations"], ids), "customer_id": (before["customer_id"], cust_id)},
        org_id=org.id,
    )
    db.session.commit()
    return guest_dict(target)


# ---- what a guest sees ------------------------------------------------------------------------------
def guest_assets(m: Membership) -> list[dict[str, Any]]:
    from mpro.assets.models import Asset, Location

    rows = db.session.execute(
        select(Asset, Location.name)
        .outerjoin(Location, Location.id == Asset.location_id)
        .where(Asset.org_id == m.org_id, Asset.deleted_at.is_(None), Asset.location_id.in_(location_scope(m)))
        .order_by(Asset.name)
        .limit(500)
    ).all()
    return [{"id": str(a.id), "name": a.name, "status": a.status, "location": loc_name or ""} for a, loc_name in rows]


def guest_asset_history(m: Membership, asset_id: str) -> dict[str, Any]:
    from mpro.assets.models import Asset
    from mpro.workorders.models import WorkOrder

    try:
        a = db.session.get(Asset, uuid.UUID(asset_id))
    except ValueError:
        a = None
    if a is None or a.org_id != m.org_id or a.deleted_at is not None or not can_see_location(m, a.location_id):
        raise RuleError("That asset doesn't exist.", 404)
    wos = db.session.scalars(
        select(WorkOrder)
        .where(WorkOrder.org_id == m.org_id, WorkOrder.asset_id == a.id, WorkOrder.deleted_at.is_(None))
        .order_by(WorkOrder.created_at.desc())
        .limit(100)
    ).all()
    from mpro.core.models import iso

    return {
        "asset": {"id": str(a.id), "name": a.name, "status": a.status},
        "work_orders": [
            {
                "id": str(w.id),
                "number": w.number,
                "title": w.title,
                "status": w.status,
                "created_at": iso(w.created_at),
                "completed_at": iso(getattr(w, "completed_at", None)),
            }
            for w in wos
        ],
    }


def guest_quotes(m: Membership) -> list[dict[str, Any]]:
    from mpro.vendors.models import Quote
    from mpro.vendors.services import quote_dict

    a = access_of(m.org_id, m.user_id)
    if a is None or a.customer_id is None:
        return []
    rows = db.session.scalars(
        select(Quote)
        .where(
            Quote.org_id == m.org_id,
            Quote.customer_id == a.customer_id,
            Quote.deleted_at.is_(None),
            Quote.status.in_(("sent", "approved", "rejected", "expired")),
        )
        .order_by(Quote.created_at.desc())
        .limit(100)
    ).all()
    return [quote_dict(q, public=True) for q in rows]


def decide_quote(m: Membership, quote_id: str, approve: bool, comment: str) -> dict[str, Any]:
    from mpro.vendors.models import Quote
    from mpro.vendors.services import decide_quote as _decide
    from mpro.vendors.services import quote_dict

    a = access_of(m.org_id, m.user_id)
    try:
        q = db.session.get(Quote, uuid.UUID(quote_id))
    except ValueError:
        q = None
    if (
        q is None
        or a is None
        or a.customer_id is None
        or q.org_id != m.org_id
        or q.customer_id != a.customer_id
        or q.deleted_at is not None
    ):
        raise RuleError("That quote doesn't exist.", 404)
    _decide(q, approve, m.user.name, comment)
    return quote_dict(q, public=True)
