"""Vendors, customers and quotes (0.5.0, MP-045/046, roadmap r233, r234, r235, r262–r264)."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from flask import current_app
from sqlalchemy import func, or_, select

from mpro.assets.models import Asset, Location
from mpro.core.events import emit
from mpro.core.files import FileObject
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.vendors.common import (
    address,
    color,
    count,
    currency,
    day,
    email,
    ids_in_org,
    money,
    num,
    one_in_org,
    page_args,
    text,
    uid,
)
from mpro.vendors.models import (
    QUOTE_STATUSES,
    Customer,
    CustomerAsset,
    CustomerContact,
    Quote,
    QuoteLine,
    Vendor,
    VendorAsset,
    VendorContact,
    VendorLocation,
    VendorType,
    VendorTypeLink,
)

ZERO = Decimal("0")


def _custom(org_id: uuid.UUID, values: Any, existing: dict[str, Any] | None, entity_type: str) -> dict[str, Any]:
    from mpro.workorders.services import _clean_custom

    if values is None:
        return dict(existing or {})
    if not isinstance(values, dict):
        raise RuleError("Custom fields must be an object.", 422)
    return _clean_custom(org_id, values, existing, entity_type=entity_type)


def _picture(org_id: uuid.UUID, raw: Any) -> uuid.UUID | None:
    f = one_in_org(FileObject, org_id, raw, "picture")
    if f is not None and not f.content_type.startswith("image/"):
        raise RuleError("The picture must be an image.", 422)
    return f.id if f is not None else None


# ================================================================ vendor types (r263)
def vendor_type_dict(t: VendorType, usage: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(t.id), "name": t.name, "color": t.color}
    if usage is not None:
        out["usage"] = usage
    return out


def list_vendor_types(org_id: uuid.UUID) -> list[dict[str, Any]]:
    types = db.session.scalars(
        select(VendorType)
        .where(VendorType.org_id == org_id, VendorType.deleted_at.is_(None))
        .order_by(func.lower(VendorType.name))
    ).all()
    usage = dict(
        db.session.execute(
            select(VendorTypeLink.type_id, func.count())
            .join(Vendor, Vendor.id == VendorTypeLink.vendor_id)
            .where(VendorTypeLink.org_id == org_id, Vendor.deleted_at.is_(None))
            .group_by(VendorTypeLink.type_id)
        ).all()
    )
    return [vendor_type_dict(t, int(usage.get(t.id, 0))) for t in types]


def save_vendor_type(org: Organization, data: dict[str, Any], t: VendorType | None = None) -> VendorType:
    name = text(data.get("name", t.name if t else ""), 80, "Name", required=True)
    dup = db.session.scalar(
        select(VendorType.id).where(
            VendorType.org_id == org.id,
            func.lower(VendorType.name) == name.lower(),
            VendorType.deleted_at.is_(None),
            VendorType.id != (t.id if t else uuid.UUID(int=0)),
        )
    )
    if dup:
        raise RuleError(f"There's already a vendor type called {name}.", 409)
    if t is None:
        t = VendorType(org_id=org.id, name=name, color=color(data.get("color")))
        db.session.add(t)
    else:
        t.name = name
        if "color" in data:
            t.color = color(data.get("color"))
    db.session.flush()
    emit(
        "vendor_type.saved",
        entity_type="vendor_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Saved vendor type {t.name}",
    )
    db.session.commit()
    return t


def delete_vendor_type(org: Organization, t: VendorType) -> None:
    t.deleted_at = utcnow()
    for link in db.session.scalars(select(VendorTypeLink).where(VendorTypeLink.type_id == t.id)):
        db.session.delete(link)
    emit(
        "vendor_type.deleted",
        entity_type="vendor_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Deleted vendor type {t.name}",
    )
    db.session.commit()


# ================================================================ vendors (MP-045, r233)
VENDOR_TEXT = {
    "name": 255,
    "description": 20000,
    "website": 500,
    "phone": 60,
    "account_number": 120,
    "payment_terms": 80,
}


def get_vendor(org_id: uuid.UUID, vid: Any) -> Vendor:
    v = db.session.get(Vendor, uid(vid, "vendor"))
    if v is None or v.org_id != org_id or v.deleted_at is not None:
        raise RuleError("That vendor doesn't exist.", 404)
    return v


def _link_set(
    model: Any, org_id: uuid.UUID, owner_col: str, owner_id: uuid.UUID, other_col: str, ids: list[uuid.UUID]
) -> None:
    existing = {
        getattr(r, other_col): r for r in db.session.scalars(select(model).where(getattr(model, owner_col) == owner_id))
    }
    for oid, row in existing.items():
        if oid not in ids:
            db.session.delete(row)
    for oid in ids:
        if oid not in existing:
            db.session.add(model(org_id=org_id, **{owner_col: owner_id, other_col: oid}))


def save_vendor(org: Organization, m: Membership, data: dict[str, Any], v: Vendor | None = None) -> Vendor:
    creating = v is None
    if v is None:
        v = Vendor(
            org_id=org.id,
            name="",
            color="#5d6880",
            description="",
            website="",
            email="",
            phone="",
            address={},
            account_number="",
            exemption_accounts={},
            payment_terms="",
            currency="",
            custom={},
            created_by_id=m.user_id,
        )
    before = {k: getattr(v, k) for k in ("name", "color", "email", "phone", "website")}
    for k, n in VENDOR_TEXT.items():
        if k in data or (creating and k == "name"):
            setattr(v, k, text(data.get(k), n, k.replace("_", " ").capitalize(), required=(k == "name")))
    if "email" in data:
        v.email = email(data.get("email"))
    if "color" in data or creating:
        v.color = color(data.get("color"))
    if "address" in data:
        v.address = address(data.get("address"))
    if "currency" in data:
        v.currency = currency(data.get("currency"))
    if "exemption_accounts" in data:
        ea = data.get("exemption_accounts") or {}
        if not isinstance(ea, dict) or len(ea) > 20:
            raise RuleError("Exemption accounts must be an object.", 422)
        v.exemption_accounts = {text(k, 60, "Account"): text(val, 120, "Account id") for k, val in ea.items()}
    if "picture_file_id" in data:
        v.picture_file_id = _picture(org.id, data.get("picture_file_id"))
    if "custom" in data or creating:
        v.custom = _custom(org.id, data.get("custom") or {}, v.custom if not creating else None, "vendor")
    from mpro.workorders.services import custom_fields

    for f in custom_fields(org.id, "vendor"):
        if f.required and (v.custom or {}).get(str(f.id)) in (None, ""):
            raise RuleError(f"Fill in {f.name}.", 422)
    if creating:
        db.session.add(v)
    db.session.flush()
    if "type_ids" in data:
        _link_set(
            VendorTypeLink,
            org.id,
            "vendor_id",
            v.id,
            "type_id",
            ids_in_org(VendorType, org.id, data.get("type_ids"), "vendor type"),
        )
    if "asset_ids" in data:
        _link_set(
            VendorAsset,
            org.id,
            "vendor_id",
            v.id,
            "asset_id",
            ids_in_org(Asset, org.id, data.get("asset_ids"), "asset"),
        )
    if "location_ids" in data:
        _link_set(
            VendorLocation,
            org.id,
            "vendor_id",
            v.id,
            "location_id",
            ids_in_org(Location, org.id, data.get("location_ids"), "location"),
        )
    if creating:
        for c in data.get("contacts") or []:
            save_contact(org, v, c, commit=False)
    after = {k: getattr(v, k) for k in before}
    emit(
        "vendor.created" if creating else "vendor.updated",
        entity_type="vendor",
        entity_id=v.id,
        entity_label=v.name,
        summary=f"{'Created' if creating else 'Updated'} vendor {v.name}",
        changes={} if creating else {k: (before[k], after[k]) for k in before if before[k] != after[k]},
    )
    db.session.commit()
    return v


def delete_vendor(org: Organization, v: Vendor) -> None:
    v.deleted_at = utcnow()
    emit(
        "vendor.deleted", entity_type="vendor", entity_id=v.id, entity_label=v.name, summary=f"Deleted vendor {v.name}"
    )
    db.session.commit()


def contact_dict(c: VendorContact | CustomerContact) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(c.id), "name": c.name, "role": c.role, "email": c.email, "phone": c.phone}
    if isinstance(c, VendorContact):
        out.update({"extension": c.extension, "is_po_contact": c.is_po_contact, "cc_on_po": c.cc_on_po})
    else:
        out["is_billing"] = c.is_billing
    return out


def save_contact(
    org: Organization, v: Vendor, data: dict[str, Any], c: VendorContact | None = None, commit: bool = True
) -> VendorContact:
    creating = c is None
    if c is None:
        c = VendorContact(org_id=org.id, vendor_id=v.id, name="", role="", email="", phone="", extension="")
        db.session.add(c)
    if "name" in data or creating:
        c.name = text(data.get("name"), 200, "Name", required=True)
    if "role" in data:
        c.role = text(data.get("role"), 120, "Role")
    if "email" in data:
        c.email = email(data.get("email"))
    if "phone" in data:
        c.phone = text(data.get("phone"), 60, "Phone")
    if "extension" in data:
        c.extension = text(data.get("extension"), 20, "Extension")
    for k in ("is_po_contact", "cc_on_po"):
        if k in data:
            setattr(c, k, bool(data.get(k)))
    if c.is_po_contact and not c.email:
        raise RuleError("A purchase order contact needs an email address.", 422)
    db.session.flush()
    emit(
        "vendor.contact_saved",
        entity_type="vendor",
        entity_id=v.id,
        entity_label=v.name,
        summary=f"{'Added' if creating else 'Updated'} contact {c.name}",
    )
    if commit:
        db.session.commit()
    return c


def delete_contact(org: Organization, v: Vendor, c: VendorContact) -> None:
    c.deleted_at = utcnow()
    emit(
        "vendor.contact_deleted",
        entity_type="vendor",
        entity_id=v.id,
        entity_label=v.name,
        summary=f"Removed contact {c.name}",
    )
    db.session.commit()


def contacts_of(vendor_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[VendorContact]]:
    out: dict[uuid.UUID, list[VendorContact]] = {}
    if not vendor_ids:
        return out
    for c in db.session.scalars(
        select(VendorContact)
        .where(VendorContact.vendor_id.in_(vendor_ids), VendorContact.deleted_at.is_(None))
        .order_by(VendorContact.created_at)
    ):
        out.setdefault(c.vendor_id, []).append(c)
    return out


def _types_of(vendor_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    if not vendor_ids:
        return out
    rows = db.session.execute(
        select(VendorTypeLink.vendor_id, VendorType)
        .join(VendorType, VendorType.id == VendorTypeLink.type_id)
        .where(VendorTypeLink.vendor_id.in_(vendor_ids), VendorType.deleted_at.is_(None))
        .order_by(func.lower(VendorType.name))
    ).all()
    for vid, t in rows:
        out.setdefault(vid, []).append(vendor_type_dict(t))
    return out


def _file_url(fid: uuid.UUID | None) -> str | None:
    return f"/api/v1/files/{fid}/thumbnail" if fid else None


def vendor_dict(
    v: Vendor, types: list[dict[str, Any]] | None = None, contacts: list[VendorContact] | None = None
) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "name": v.name,
        "color": v.color,
        "description": v.description,
        "picture_file_id": str(v.picture_file_id) if v.picture_file_id else None,
        "picture_url": _file_url(v.picture_file_id),
        "website": v.website,
        "email": v.email,
        "phone": v.phone,
        "address": v.address or {},
        "account_number": v.account_number,
        "exemption_accounts": v.exemption_accounts or {},
        "payment_terms": v.payment_terms,
        "currency": v.currency,
        "custom": v.custom or {},
        "types": types or [],
        "contacts": [contact_dict(c) for c in contacts or []],
        "created_at": iso(v.created_at),
        "updated_at": iso(v.updated_at),
    }


def list_vendors(org_id: uuid.UUID, params: dict[str, Any]) -> dict[str, Any]:
    q = select(Vendor).where(Vendor.org_id == org_id, Vendor.deleted_at.is_(None))
    s = text(params.get("q"), 200)
    if s:
        pat = f"%{s.lower()}%"
        q = q.where(
            or_(
                func.lower(Vendor.name).like(pat),
                func.lower(Vendor.email).like(pat),
                func.lower(Vendor.account_number).like(pat),
                Vendor.id.in_(
                    select(VendorContact.vendor_id).where(
                        VendorContact.org_id == org_id,
                        VendorContact.deleted_at.is_(None),
                        or_(func.lower(VendorContact.name).like(pat), func.lower(VendorContact.email).like(pat)),
                    )
                ),
            )
        )
    if params.get("type_id"):
        q = q.where(
            Vendor.id.in_(
                select(VendorTypeLink.vendor_id).where(VendorTypeLink.type_id == uid(params["type_id"], "vendor type"))
            )
        )
    if params.get("ids"):
        ids = [uid(x, "vendor") for x in str(params["ids"]).split(",") if x][:200]
        q = q.where(Vendor.id.in_(ids))
    total = count(q)
    page, per_page = page_args(params, 50, 500)
    order = func.lower(Vendor.name)
    rows = db.session.scalars(
        q.order_by(Vendor.updated_at.desc() if params.get("sort") == "updated" else order)
        .limit(per_page)
        .offset((page - 1) * per_page)
    ).all()
    ids = [v.id for v in rows]
    types, contacts = _types_of(ids), contacts_of(ids)
    from mpro.purchasing.models import PurchaseOrder

    open_pos = (
        dict(
            db.session.execute(
                select(PurchaseOrder.vendor_id, func.count())
                .where(
                    PurchaseOrder.org_id == org_id,
                    PurchaseOrder.vendor_id.in_(ids),
                    PurchaseOrder.deleted_at.is_(None),
                    PurchaseOrder.status.in_(("requested", "pending", "approved", "partially_fulfilled")),
                )
                .group_by(PurchaseOrder.vendor_id)
            ).all()
        )
        if ids
        else {}
    )
    items = []
    for v in rows:
        d = vendor_dict(v, types.get(v.id), contacts.get(v.id))
        d["open_purchase_orders"] = int(open_pos.get(v.id, 0))
        items.append(d)
    return {"items": items, "total": total, "page": page, "per_page": per_page}


def vendor_detail(m: Membership, v: Vendor) -> dict[str, Any]:
    from mpro.parts.models import Part, PartVendor
    from mpro.purchasing.models import PurchaseOrder

    d = vendor_dict(v, _types_of([v.id]).get(v.id), contacts_of([v.id]).get(v.id))
    assets = db.session.execute(
        select(Asset.id, Asset.name)
        .join(VendorAsset, VendorAsset.asset_id == Asset.id)
        .where(VendorAsset.vendor_id == v.id, Asset.deleted_at.is_(None))
        .order_by(func.lower(Asset.name))
    ).all()
    locs = db.session.execute(
        select(Location.id, Location.name)
        .join(VendorLocation, VendorLocation.location_id == Location.id)
        .where(VendorLocation.vendor_id == v.id, Location.deleted_at.is_(None))
        .order_by(func.lower(Location.name))
    ).all()
    show_costs = can(m, "costs.view") or can(m, "po.manage")
    parts = db.session.execute(
        select(
            Part.id,
            Part.name,
            Part.part_number,
            PartVendor.vendor_part_number,
            PartVendor.unit_cost,
            PartVendor.preferred,
        )
        .join(PartVendor, PartVendor.part_id == Part.id)
        .where(PartVendor.vendor_id == v.id, Part.deleted_at.is_(None))
        .order_by(func.lower(Part.name))
        .limit(500)
    ).all()
    pos = db.session.scalars(
        select(PurchaseOrder)
        .where(PurchaseOrder.vendor_id == v.id, PurchaseOrder.deleted_at.is_(None))
        .order_by(PurchaseOrder.created_at.desc())
        .limit(50)
    ).all()
    d["assets"] = [{"id": str(i), "name": n} for i, n in assets]
    d["locations"] = [{"id": str(i), "name": n} for i, n in locs]
    d["parts"] = [
        {
            "id": str(i),
            "name": n,
            "part_number": pn,
            "vendor_part_number": vpn,
            "unit_cost": num(c) if show_costs else None,
            "preferred": pref,
        }
        for i, n, pn, vpn, c, pref in parts
    ]
    from mpro.purchasing.services import po_number

    d["purchase_orders"] = [
        {
            "id": str(p.id),
            "number": po_number(p),
            "title": p.title,
            "status": p.status,
            "total": num(p.total) if show_costs else None,
            "created_at": iso(p.created_at),
        }
        for p in pos
    ]
    from mpro.core.files import file_dict, links_for

    d["files"] = [file_dict(link.file, link.role, link.id) for link in links_for("vendor", v.id) if link.file]
    return d


# ================================================================ customers (MP-046, r234)
def get_customer(org_id: uuid.UUID, cid: Any) -> Customer:
    c = db.session.get(Customer, uid(cid, "customer"))
    if c is None or c.org_id != org_id or c.deleted_at is not None:
        raise RuleError("That customer doesn't exist.", 404)
    return c


def save_customer(org: Organization, m: Membership, data: dict[str, Any], c: Customer | None = None) -> Customer:
    creating = c is None
    if c is None:
        c = Customer(
            org_id=org.id,
            name="",
            color="#5d6880",
            description="",
            email="",
            phone="",
            billing_address={},
            billing_email="",
            tax_id="",
            payment_terms="",
            currency="",
            custom={},
            created_by_id=m.user_id,
        )
    for k, n in {"name": 255, "description": 20000, "phone": 60, "tax_id": 80, "payment_terms": 80}.items():
        if k in data or (creating and k == "name"):
            setattr(c, k, text(data.get(k), n, k.replace("_", " ").capitalize(), required=(k == "name")))
    for k in ("email", "billing_email"):
        if k in data:
            setattr(c, k, email(data.get(k), "Billing email" if k == "billing_email" else "Email"))
    if "color" in data or creating:
        c.color = color(data.get("color"))
    if "billing_address" in data:
        c.billing_address = address(data.get("billing_address"))
    if "currency" in data:
        c.currency = currency(data.get("currency"))
    if "labor_rate" in data:
        c.labor_rate = money(data.get("labor_rate"), "Labor rate", required=False)
    if "parts_markup_pct" in data:
        p = money(data.get("parts_markup_pct"), "Parts markup", required=False)
        if p is not None and p > 1000:
            raise RuleError("Parts markup can be up to 1,000%.", 422)
        c.parts_markup_pct = p
    if "custom" in data and isinstance(data.get("custom"), dict):
        c.custom = {text(k, 60, "Field"): v for k, v in data["custom"].items()}
    if creating:
        db.session.add(c)
        db.session.flush()
        # every customer gets a location of its own (MaintainX auto-creates one), unless one was given
        if data.get("default_location_id"):
            loc = one_in_org(Location, org.id, data["default_location_id"], "location")
        else:
            addr = c.billing_address or {}
            loc = Location(
                org_id=org.id,
                name=c.name[:255],
                description=f"Customer location for {c.name}"[:500],
                custom={},
                created_by_id=m.user_id,
                address_line1=addr.get("line1", ""),
                address_line2=addr.get("line2", ""),
                city=addr.get("city", ""),
                region=addr.get("region", ""),
                postal_code=addr.get("postal_code", ""),
                country=addr.get("country", ""),
            )
            db.session.add(loc)
            db.session.flush()
            from mpro.core import hierarchy

            hierarchy.add_node(org.id, "location", loc.id, None)
        loc.customer_id = c.id
        c.default_location_id = loc.id
    elif "default_location_id" in data and data.get("default_location_id"):
        loc = one_in_org(Location, org.id, data["default_location_id"], "location")
        loc.customer_id = c.id
        c.default_location_id = loc.id
    if "location_ids" in data:
        want = set(ids_in_org(Location, org.id, data.get("location_ids"), "location"))
        if c.default_location_id:
            want.add(c.default_location_id)
        for loc in db.session.scalars(select(Location).where(Location.org_id == org.id, Location.customer_id == c.id)):
            if loc.id not in want:
                loc.customer_id = None
        for lid in want:
            loc = db.session.get(Location, lid)
            if loc is not None:
                if loc.customer_id not in (None, c.id):
                    raise RuleError(f"{loc.name} already belongs to another customer.", 409)
                loc.customer_id = c.id
    if "asset_ids" in data:
        _link_set(
            CustomerAsset,
            org.id,
            "customer_id",
            c.id,
            "asset_id",
            ids_in_org(Asset, org.id, data.get("asset_ids"), "asset"),
        )
    if creating:
        for ct in data.get("contacts") or []:
            save_customer_contact(org, c, ct, commit=False)
    emit(
        "customer.created" if creating else "customer.updated",
        entity_type="customer",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"{'Created' if creating else 'Updated'} customer {c.name}",
    )
    db.session.commit()
    return c


def delete_customer(org: Organization, c: Customer) -> None:
    c.deleted_at = utcnow()
    emit(
        "customer.deleted",
        entity_type="customer",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Deleted customer {c.name}",
    )
    db.session.commit()


def save_customer_contact(
    org: Organization, c: Customer, data: dict[str, Any], ct: CustomerContact | None = None, commit: bool = True
) -> CustomerContact:
    creating = ct is None
    if ct is None:
        ct = CustomerContact(org_id=org.id, customer_id=c.id, name="", role="", email="", phone="")
        db.session.add(ct)
    if "name" in data or creating:
        ct.name = text(data.get("name"), 200, "Name", required=True)
    if "role" in data:
        ct.role = text(data.get("role"), 120, "Role")
    if "email" in data:
        ct.email = email(data.get("email"))
    if "phone" in data:
        ct.phone = text(data.get("phone"), 60, "Phone")
    if "is_billing" in data:
        ct.is_billing = bool(data.get("is_billing"))
    db.session.flush()
    emit(
        "customer.contact_saved",
        entity_type="customer",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"{'Added' if creating else 'Updated'} contact {ct.name}",
    )
    if commit:
        db.session.commit()
    return ct


def delete_customer_contact(org: Organization, c: Customer, ct: CustomerContact) -> None:
    ct.deleted_at = utcnow()
    emit(
        "customer.contact_deleted",
        entity_type="customer",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Removed contact {ct.name}",
    )
    db.session.commit()


def customer_dict(c: Customer, contacts: list[CustomerContact] | None = None) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "name": c.name,
        "color": c.color,
        "description": c.description,
        "email": c.email,
        "phone": c.phone,
        "billing_address": c.billing_address or {},
        "billing_email": c.billing_email,
        "tax_id": c.tax_id,
        "payment_terms": c.payment_terms,
        "currency": c.currency,
        "labor_rate": num(c.labor_rate),
        "parts_markup_pct": num(c.parts_markup_pct),
        "default_location_id": str(c.default_location_id) if c.default_location_id else None,
        "contacts": [contact_dict(x) for x in contacts or []],
        "created_at": iso(c.created_at),
    }


def _customer_contacts(ids: list[uuid.UUID]) -> dict[uuid.UUID, list[CustomerContact]]:
    out: dict[uuid.UUID, list[CustomerContact]] = {}
    if not ids:
        return out
    for ct in db.session.scalars(
        select(CustomerContact)
        .where(CustomerContact.customer_id.in_(ids), CustomerContact.deleted_at.is_(None))
        .order_by(CustomerContact.created_at)
    ):
        out.setdefault(ct.customer_id, []).append(ct)
    return out


def list_customers(org_id: uuid.UUID, params: dict[str, Any]) -> dict[str, Any]:
    q = select(Customer).where(Customer.org_id == org_id, Customer.deleted_at.is_(None))
    s = text(params.get("q"), 200)
    if s:
        pat = f"%{s.lower()}%"
        q = q.where(or_(func.lower(Customer.name).like(pat), func.lower(Customer.email).like(pat)))
    total = count(q)
    page, per_page = page_args(params, 50, 500)
    rows = db.session.scalars(q.order_by(func.lower(Customer.name)).limit(per_page).offset((page - 1) * per_page)).all()
    cts = _customer_contacts([c.id for c in rows])
    return {
        "items": [customer_dict(c, cts.get(c.id)) for c in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def customer_detail(m: Membership, c: Customer) -> dict[str, Any]:
    from mpro.workorders.models import WorkOrder
    from mpro.workorders.services import visibility_filter

    d = customer_dict(c, _customer_contacts([c.id]).get(c.id))
    d["locations"] = [
        {"id": str(i), "name": n}
        for i, n in db.session.execute(
            select(Location.id, Location.name)
            .where(Location.customer_id == c.id, Location.deleted_at.is_(None))
            .order_by(func.lower(Location.name))
        ).all()
    ]
    d["assets"] = [
        {"id": str(i), "name": n}
        for i, n in db.session.execute(
            select(Asset.id, Asset.name)
            .join(CustomerAsset, CustomerAsset.asset_id == Asset.id)
            .where(CustomerAsset.customer_id == c.id, Asset.deleted_at.is_(None))
            .order_by(func.lower(Asset.name))
        ).all()
    ]
    wos = db.session.scalars(
        select(WorkOrder)
        .where(
            WorkOrder.org_id == c.org_id,
            WorkOrder.customer_id == c.id,
            WorkOrder.deleted_at.is_(None),
            visibility_filter(m),
        )
        .order_by(WorkOrder.created_at.desc())
        .limit(50)
    ).all()
    d["work_orders"] = [{"id": str(w.id), "number": w.number, "title": w.title, "status": w.status} for w in wos]
    d["quotes"] = [
        quote_dict(q)
        for q in db.session.scalars(
            select(Quote)
            .where(Quote.customer_id == c.id, Quote.deleted_at.is_(None))
            .order_by(Quote.created_at.desc())
            .limit(50)
        )
    ]
    return d


def set_work_order_customer(org: Organization, wo: Any, raw: Any) -> None:
    """Called from the work-order form (one field). Caller commits."""
    cust = one_in_org(Customer, org.id, raw, "customer") if raw else None
    before = wo.customer_id
    wo.customer_id = cust.id if cust else None
    if before != wo.customer_id:
        emit(
            "wo.customer_set",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=f"#{wo.number} {wo.title}",
            summary=f"Customer: {cust.name if cust else 'none'}",
        )


# ================================================================ quotes (r235)
def _quote_number(org_id: uuid.UUID) -> int:
    from mpro.purchasing.services import next_counter

    return next_counter(org_id, "quote")


def get_quote(org_id: uuid.UUID, qid: Any) -> Quote:
    q = db.session.get(Quote, uid(qid, "quote"))
    if q is None or q.org_id != org_id or q.deleted_at is not None:
        raise RuleError("That quote doesn't exist.", 404)
    return q


def _quote_lines(q: Quote) -> list[QuoteLine]:
    return list(db.session.scalars(select(QuoteLine).where(QuoteLine.quote_id == q.id).order_by(QuoteLine.sort)))


def _recalc_quote(q: Quote, tax_pct: Decimal | None = None) -> None:
    lines = _quote_lines(q)
    sub = sum(((ln.quantity * ln.unit_price) for ln in lines), ZERO)
    taxable = sum(((ln.quantity * ln.unit_price) for ln in lines if ln.taxable), ZERO)
    q.subtotal = sub.quantize(Decimal("0.01"))
    if tax_pct is not None:
        q.tax = (taxable * tax_pct / 100).quantize(Decimal("0.01"))
    q.total = (q.subtotal + (q.tax or ZERO)).quantize(Decimal("0.01"))


def save_quote(org: Organization, m: Membership, data: dict[str, Any], q: Quote | None = None) -> Quote:
    creating = q is None
    if q is not None and q.status not in ("draft", "sent"):
        raise RuleError("Approved, rejected or canceled quotes can't be changed.", 409)
    if q is None:
        cust = get_customer(org.id, data.get("customer_id"))
        q = Quote(
            org_id=org.id,
            number=_quote_number(org.id),
            customer_id=cust.id,
            title="",
            scope="",
            status="draft",
            currency=cust.currency or org.currency,
            created_by_id=m.user_id,
            share_token_hash="",
        )
        db.session.add(q)
    if "title" in data or creating:
        q.title = text(data.get("title"), 255, "Title", required=True)
    if "scope" in data:
        q.scope = text(data.get("scope"), 20000, "Scope")
    if "valid_until" in data:
        q.valid_until = day(data.get("valid_until"), "Valid until")
    if "work_order_id" in data:
        from mpro.workorders.models import WorkOrder

        wo = one_in_org(WorkOrder, org.id, data.get("work_order_id"), "work order")
        q.work_order_id = wo.id if wo else None
    db.session.flush()
    if "lines" in data:
        from mpro.parts.models import Part

        raw = data.get("lines") or []
        if not isinstance(raw, list) or len(raw) > 200:
            raise RuleError("A quote can have up to 200 lines.", 422)
        for old in _quote_lines(q):
            db.session.delete(old)
        for i, ln in enumerate(raw):
            if not isinstance(ln, dict):
                raise RuleError("Each line must be an object.", 422)
            kind = ln.get("kind") or "other"
            if kind not in ("labor", "part", "other"):
                raise RuleError("Line kind must be labor, part or other.", 422)
            part = one_in_org(Part, org.id, ln.get("part_id"), "part") if ln.get("part_id") else None
            desc = text(ln.get("description") or (part.name if part else ""), 500, "Description", required=True)
            qty = money(ln.get("quantity", 1), "Quantity")
            price = money(ln.get("unit_price", 0), "Unit price")
            db.session.add(
                QuoteLine(
                    org_id=org.id,
                    quote_id=q.id,
                    sort=i,
                    kind=kind,
                    part_id=part.id if part else None,
                    description=desc,
                    quantity=qty,
                    unit_price=price,
                    taxable=bool(ln.get("taxable", True)),
                )
            )
        db.session.flush()
    tax_pct = money(data.get("tax_pct"), "Tax", required=False) if "tax_pct" in data else None
    if "tax" in data and tax_pct is None:
        q.tax = money(data.get("tax"), "Tax") or ZERO
    _recalc_quote(q, tax_pct)
    emit(
        "quote.created" if creating else "quote.updated",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        summary=f"{'Created' if creating else 'Updated'} quote {q.number}",
    )
    db.session.commit()
    return q


def quote_dict(q: Quote, lines: list[QuoteLine] | None = None, public: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(q.id) if not public else None,
        "number": q.number,
        "title": q.title,
        "scope": q.scope,
        "status": q.status,
        "currency": q.currency,
        "valid_until": q.valid_until.isoformat() if q.valid_until else None,
        "subtotal": num(q.subtotal),
        "tax": num(q.tax),
        "total": num(q.total),
        "sent_at": iso(q.sent_at),
        "decided_at": iso(q.decided_at),
        "decided_by_name": q.decided_by_name,
        "decision_comment": q.decision_comment,
    }
    if not public:
        out["customer_id"] = str(q.customer_id)
        out["work_order_id"] = str(q.work_order_id) if q.work_order_id else None
        out["shared"] = bool(q.share_token_hash)
        out["created_at"] = iso(q.created_at)
    if lines is not None:
        out["lines"] = [
            {
                "kind": ln.kind,
                "part_id": str(ln.part_id) if ln.part_id and not public else None,
                "description": ln.description,
                "quantity": num(ln.quantity),
                "unit_price": num(ln.unit_price),
                "amount": num((ln.quantity * ln.unit_price).quantize(Decimal("0.01"))),
                "taxable": ln.taxable,
            }
            for ln in lines
        ]
    return out


def quote_detail(q: Quote) -> dict[str, Any]:
    d = quote_dict(q, _quote_lines(q))
    d["comments"] = quote_comments(q)
    return d


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def send_quote(org: Organization, m: Membership, q: Quote, data: dict[str, Any]) -> dict[str, Any]:
    """Make (or renew) the customer link and email it. Returns {url} — the token is shown only now."""
    from mpro.core.mail import send_email

    if q.status not in ("draft", "sent"):
        raise RuleError("Only draft or sent quotes can be sent.", 409)
    if not _quote_lines(q):
        raise RuleError("Add at least one line before sending the quote.", 422)
    to = [email(x, "Recipient") for x in (data.get("to") or [])]
    if not to:
        cust = get_customer(org.id, q.customer_id)
        to = [x for x in [cust.billing_email or cust.email] if x]
    token = secrets.token_urlsafe(32)
    q.share_token_hash = _token_hash(token)
    q.status = "sent"
    q.sent_at = utcnow()
    base = current_app.config.get("MPRO_BASE_URL", "").rstrip("/")
    url = f"{base}/quote/{token}"
    msg = text(data.get("message"), 4000, "Message")
    for addr in to:
        send_email(
            addr,
            f"Quote {q.number} from {org.name}: {q.title}",
            (f"{msg}\n\n" if msg else "")
            + f"Review and approve the quote here:\n{url}\n\nTotal: {num(q.total)} {q.currency}",
            org_id=org.id,
        )
    emit(
        "quote.sent",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        summary=f"Sent quote {q.number}" + (f" to {', '.join(to)}" if to else ""),
    )
    db.session.commit()
    return {"url": url, "sent_to": to}


def quote_by_token(token: str) -> Quote:
    if not token or len(token) > 200:
        raise RuleError("This link isn't valid.", 404)
    q = db.session.scalars(
        select(Quote).where(Quote.share_token_hash == _token_hash(token), Quote.deleted_at.is_(None))
    ).first()
    if q is None or not q.share_token_hash:
        raise RuleError("This link isn't valid any more.", 404)
    return q


def public_quote(q: Quote) -> dict[str, Any]:
    org = db.session.get(Organization, q.org_id)
    cust = db.session.get(Customer, q.customer_id)
    d = quote_dict(q, _quote_lines(q), public=True)
    d["organization"] = org.name if org else ""
    d["customer"] = cust.name if cust else ""
    d["expired"] = bool(q.valid_until and q.valid_until < date.today() and q.status == "sent")
    d["comments"] = quote_comments(q)
    return d


def quote_comments(q: Quote) -> list[dict[str, Any]]:
    from mpro.workorders.models import Comment

    out = []
    for c in db.session.scalars(
        select(Comment)
        .where(Comment.entity_type == "quote", Comment.entity_id == q.id, Comment.deleted_at.is_(None))
        .order_by(Comment.created_at)
    ):
        out.append(
            {
                "body": c.body,
                "author": (c.mentions or {}).get("external_name") or "Team",
                "external": not c.author_id,
                "created_at": iso(c.created_at),
            }
        )
    return out


def add_quote_comment(q: Quote, body: str, *, user_id: uuid.UUID | None = None, external_name: str = "") -> None:
    from mpro.workorders.models import Comment

    body = text(body, 4000, "Comment", required=True)
    db.session.add(
        Comment(
            org_id=q.org_id,
            entity_type="quote",
            entity_id=q.id,
            author_id=user_id,
            body=body,
            mentions={"external_name": text(external_name, 200, "Name")} if not user_id else {},
            reactions={},
        )
    )
    emit(
        "quote.commented",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        org_id=q.org_id,
        summary=f"Comment from {external_name or 'the team'}",
    )
    db.session.commit()


def decide_quote(q: Quote, approve: bool, name: str, comment: str = "") -> None:
    if q.status != "sent":
        raise RuleError(
            "This quote has already been decided."
            if q.status in ("approved", "rejected")
            else "This quote isn't open for a decision.",
            409,
        )
    if q.valid_until and q.valid_until < date.today():
        q.status = "expired"
        db.session.commit()
        raise RuleError("This quote has expired. Ask for a new one.", 409)
    name = text(name, 200, "Your name", required=True)
    if not approve and not comment.strip():
        raise RuleError("Tell us why you're rejecting the quote.", 422)
    q.status = "approved" if approve else "rejected"
    q.decided_at = utcnow()
    q.decided_by_name = name
    q.decision_comment = text(comment, 4000, "Comment")
    emit(
        "quote.decided",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        org_id=q.org_id,
        summary=f"{'Approved' if approve else 'Rejected'} by {name}",
        data={"approve": approve},
    )
    if approve and q.work_order_id:
        # the approved quote attaches to its work order: a PDF in its files, and a line in its activity
        from mpro.core.files import attach, save_file
        from mpro.purchasing.pdf import quote_pdf

        try:
            f = save_file(q.org_id, f"Quote-{q.number}.pdf", quote_pdf(q), None, "application/pdf")
            attach(f, "work_order", q.work_order_id, "file")
        except Exception:  # noqa: BLE001  — the approval itself must not fail on the PDF
            current_app.logger.warning("Quote PDF failed for %s", q.id, exc_info=True)
        emit(
            "wo.quote_approved",
            entity_type="work_order",
            entity_id=q.work_order_id,
            org_id=q.org_id,
            summary=f"Quote {q.number} approved by {name} ({num(q.total)} {q.currency})",
        )
    db.session.commit()


def cancel_quote(org: Organization, q: Quote) -> None:
    if q.status in ("approved", "rejected"):
        raise RuleError("Decided quotes can't be canceled.", 409)
    q.status = "canceled"
    q.share_token_hash = ""
    emit(
        "quote.canceled",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        summary=f"Canceled quote {q.number}",
    )
    db.session.commit()


def delete_quote(org: Organization, q: Quote) -> None:
    q.deleted_at = utcnow()
    q.share_token_hash = ""
    emit(
        "quote.deleted",
        entity_type="quote",
        entity_id=q.id,
        entity_label=f"Quote {q.number}",
        summary=f"Deleted quote {q.number}",
    )
    db.session.commit()


__all__ = ["QUOTE_STATUSES"]
