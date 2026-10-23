"""Vendors and customers REST API (/api/v1), 0.5.0 (MP-045/046, r233–r235, r262–r264)."""

from __future__ import annotations

import csv
import io
import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, select

from mpro.core.files import Export, FileError, export_dict, exporter, register_entity, request_export
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.vendors import services as svc
from mpro.vendors.models import Customer, CustomerContact, Quote, Vendor, VendorContact, VendorType

bp = APIBlueprint("vendors", __name__, url_prefix="/api/v1", tag="Vendors")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _vendor(vid: str) -> Vendor:
    return guard(svc.get_vendor, g.org.id, vid)


def _customer(cid: str) -> Customer:
    return guard(svc.get_customer, g.org.id, cid)


def _quote(qid: str) -> Quote:
    return guard(svc.get_quote, g.org.id, qid)


# ---- vendor types (r263) -------------------------------------------------------------------------
@bp.get("/vendor-types")
@require("vendors.view")
def list_vendor_types() -> dict[str, Any]:
    return {"items": svc.list_vendor_types(g.org.id)}


@bp.post("/vendor-types")
@require("vendors.manage")
def create_vendor_type() -> tuple[dict[str, Any], int]:
    return svc.vendor_type_dict(guard(svc.save_vendor_type, g.org, body())), 201


@bp.patch("/vendor-types/<tid>")
@require("vendors.manage")
def patch_vendor_type(tid: str) -> dict[str, Any]:
    return svc.vendor_type_dict(guard(svc.save_vendor_type, g.org, body(), get_scoped(VendorType, tid)))


@bp.delete("/vendor-types/<tid>")
@require("vendors.manage")
def delete_vendor_type(tid: str) -> tuple[str, int]:
    svc.delete_vendor_type(g.org, get_scoped(VendorType, tid))
    return "", 204


# ---- vendors (MP-045) ------------------------------------------------------------------------------
@bp.get("/vendors")
@require("vendors.view")
def list_vendors() -> dict[str, Any]:
    """Query: q, type_id, ids (comma-separated), sort (name|updated), page, per_page."""
    return guard(svc.list_vendors, g.org.id, dict(request.args.items()))


@bp.post("/vendors")
@require("vendors.manage")
def create_vendor() -> tuple[dict[str, Any], int]:
    """{name, color, description, website, email, phone, address, account_number, payment_terms, currency,
    exemption_accounts, picture_file_id, custom, type_ids, asset_ids, location_ids, contacts: [...]}"""
    v = guard(svc.save_vendor, g.org, g.membership, body())
    return svc.vendor_detail(g.membership, v), 201


@bp.get("/vendors/<vid>")
@require("vendors.view")
def get_vendor(vid: str) -> dict[str, Any]:
    d = svc.vendor_detail(g.membership, _vendor(vid))
    d["can"] = {"manage": can(g.membership, "vendors.manage"), "delete": can(g.membership, "vendors.delete")}
    return d


@bp.patch("/vendors/<vid>")
@require("vendors.manage")
def patch_vendor(vid: str) -> dict[str, Any]:
    v = guard(svc.save_vendor, g.org, g.membership, body(), _vendor(vid))
    return svc.vendor_detail(g.membership, v)


@bp.delete("/vendors/<vid>")
@require("vendors.delete")
def delete_vendor(vid: str) -> tuple[str, int]:
    svc.delete_vendor(g.org, _vendor(vid))
    return "", 204


@bp.post("/vendors/<vid>/contacts")
@require("vendors.manage")
def add_vendor_contact(vid: str) -> tuple[dict[str, Any], int]:
    return svc.contact_dict(guard(svc.save_contact, g.org, _vendor(vid), body())), 201


def _vendor_contact(cid: str) -> tuple[Vendor, VendorContact]:
    c = get_scoped(VendorContact, cid)
    return _vendor(str(c.vendor_id)), c


@bp.patch("/vendor-contacts/<cid>")
@require("vendors.manage")
def patch_vendor_contact(cid: str) -> dict[str, Any]:
    v, c = _vendor_contact(cid)
    return svc.contact_dict(guard(svc.save_contact, g.org, v, body(), c))


@bp.delete("/vendor-contacts/<cid>")
@require("vendors.manage")
def delete_vendor_contact(cid: str) -> tuple[str, int]:
    v, c = _vendor_contact(cid)
    svc.delete_contact(g.org, v, c)
    return "", 204


@bp.post("/vendors/export")
@require("vendors.view")
def export_vendors() -> tuple[dict[str, Any], int]:
    if not can(g.membership, "exports.use"):
        abort(403, message="You don't have permission to export.")
    ex = guard(request_export, g.org.id, g.user.id, "vendors.csv", "Vendors (CSV)", {})
    db.session.commit()
    return export_dict(ex), 202


@exporter("vendors.csv")
def _vendors_csv(ex: Export) -> tuple[str, bytes, str]:
    from mpro.purchasing.services import _safe

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Types", "Email", "Phone", "Website", "Account number", "Payment terms", "Address", "Contacts"])
    vendors = db.session.scalars(
        select(Vendor).where(Vendor.org_id == ex.org_id, Vendor.deleted_at.is_(None)).order_by(func.lower(Vendor.name))
    ).all()
    types = svc._types_of([v.id for v in vendors])
    contacts = svc.contacts_of([v.id for v in vendors])
    for v in vendors:
        a = v.address or {}
        w.writerow(
            [
                _safe(x)
                for x in [
                    v.name,
                    ", ".join(t["name"] for t in types.get(v.id, [])),
                    v.email,
                    v.phone,
                    v.website,
                    v.account_number,
                    v.payment_terms,
                    ", ".join(
                        a.get(k, "") for k in ("line1", "line2", "city", "region", "postal_code", "country") if a.get(k)
                    ),
                    "; ".join(f"{c.name} <{c.email}>" if c.email else c.name for c in contacts.get(v.id, [])),
                ]
            ]
        )
    return "vendors.csv", buf.getvalue().encode("utf-8-sig"), "text/csv"


# ---- customers (MP-046) ---------------------------------------------------------------------------
@bp.get("/customers")
@require("customers.view")
def list_customers() -> dict[str, Any]:
    return guard(svc.list_customers, g.org.id, dict(request.args.items()))


@bp.post("/customers")
@require("customers.manage")
def create_customer() -> tuple[dict[str, Any], int]:
    c = guard(svc.save_customer, g.org, g.membership, body())
    return svc.customer_detail(g.membership, c), 201


@bp.get("/customers/<cid>")
@require("customers.view")
def get_customer(cid: str) -> dict[str, Any]:
    d = svc.customer_detail(g.membership, _customer(cid))
    d["can"] = {"manage": can(g.membership, "customers.manage"), "quotes": can(g.membership, "quotes.manage")}
    return d


@bp.patch("/customers/<cid>")
@require("customers.manage")
def patch_customer(cid: str) -> dict[str, Any]:
    c = guard(svc.save_customer, g.org, g.membership, body(), _customer(cid))
    return svc.customer_detail(g.membership, c)


@bp.delete("/customers/<cid>")
@require("customers.manage")
def delete_customer(cid: str) -> tuple[str, int]:
    svc.delete_customer(g.org, _customer(cid))
    return "", 204


@bp.post("/customers/<cid>/contacts")
@require("customers.manage")
def add_customer_contact(cid: str) -> tuple[dict[str, Any], int]:
    return svc.contact_dict(guard(svc.save_customer_contact, g.org, _customer(cid), body())), 201


def _customer_contact(ccid: str) -> tuple[Customer, CustomerContact]:
    ct = get_scoped(CustomerContact, ccid)
    return _customer(str(ct.customer_id)), ct


@bp.patch("/customer-contacts/<ccid>")
@require("customers.manage")
def patch_customer_contact(ccid: str) -> dict[str, Any]:
    c, ct = _customer_contact(ccid)
    return svc.contact_dict(guard(svc.save_customer_contact, g.org, c, body(), ct))


@bp.delete("/customer-contacts/<ccid>")
@require("customers.manage")
def delete_customer_contact(ccid: str) -> tuple[str, int]:
    c, ct = _customer_contact(ccid)
    svc.delete_customer_contact(g.org, c, ct)
    return "", 204


@bp.put("/work-orders/<wo_id>/customer")
@require("wo.view")
def set_work_order_customer(wo_id: str) -> dict[str, Any]:
    """{customer_id: id | null} — the Customer field on a work order (MP-046)."""
    from mpro.core.permissions import can_on
    from mpro.workorders.api import _wo

    wo = _wo(wo_id)
    if not can_on(g.membership, "wo.edit", wo):
        abort(403, message="You can't change this work order.")
    guard(svc.set_work_order_customer, g.org, wo, body().get("customer_id"))
    db.session.commit()
    c = db.session.get(Customer, wo.customer_id) if wo.customer_id else None
    return {"customer": {"id": str(c.id), "name": c.name} if c else None}


@bp.get("/work-orders/<wo_id>/customer")
@require("wo.view")
def get_work_order_customer(wo_id: str) -> dict[str, Any]:
    from mpro.workorders.api import _wo

    wo = _wo(wo_id)
    c = db.session.get(Customer, wo.customer_id) if wo.customer_id else None
    return {"customer": {"id": str(c.id), "name": c.name} if c and c.deleted_at is None else None}


# ---- quotes (r235) ------------------------------------------------------------------------------
@bp.get("/quotes")
@require("customers.view")
def list_quotes() -> dict[str, Any]:
    q = scoped(Quote)
    if request.args.get("customer_id"):
        q = q.where(Quote.customer_id == guard(svc.uid, request.args["customer_id"], "customer"))
    if request.args.get("work_order_id"):
        q = q.where(Quote.work_order_id == guard(svc.uid, request.args["work_order_id"], "work order"))
    rows = db.session.scalars(q.order_by(Quote.created_at.desc()).limit(200)).all()
    return {"items": [svc.quote_dict(x) for x in rows]}


@bp.post("/quotes")
@require("quotes.manage")
def create_quote() -> tuple[dict[str, Any], int]:
    """{customer_id, title, scope, valid_until, work_order_id, lines: [{kind, part_id?, description, quantity,
    unit_price, taxable}], tax_pct? | tax?}"""
    return svc.quote_detail(guard(svc.save_quote, g.org, g.membership, body())), 201


@bp.get("/quotes/<qid>")
@require("customers.view")
def get_quote(qid: str) -> dict[str, Any]:
    return svc.quote_detail(_quote(qid))


@bp.patch("/quotes/<qid>")
@require("quotes.manage")
def patch_quote(qid: str) -> dict[str, Any]:
    return svc.quote_detail(guard(svc.save_quote, g.org, g.membership, body(), _quote(qid)))


@bp.delete("/quotes/<qid>")
@require("quotes.manage")
def delete_quote(qid: str) -> tuple[str, int]:
    svc.delete_quote(g.org, _quote(qid))
    return "", 204


@bp.post("/quotes/<qid>/send")
@require("quotes.manage")
def send_quote(qid: str) -> dict[str, Any]:
    """{to?: [emails], message?} — returns {url} (shown once; sending again makes a new link)."""
    return guard(svc.send_quote, g.org, g.membership, _quote(qid), body())


@bp.post("/quotes/<qid>/cancel")
@require("quotes.manage")
def cancel_quote(qid: str) -> dict[str, Any]:
    q = _quote(qid)
    guard(svc.cancel_quote, g.org, q)
    return svc.quote_detail(q)


@bp.post("/quotes/<qid>/comments")
@require("customers.view")
def comment_quote(qid: str) -> tuple[dict[str, Any], int]:
    q = _quote(qid)
    guard(svc.add_quote_comment, q, str(body().get("body") or ""), user_id=g.user.id)
    return {"comments": svc.quote_comments(q)}, 201


@bp.get("/quotes/<qid>/pdf")
@require("customers.view")
def quote_pdf(qid: str) -> Any:
    from flask import Response

    from mpro.purchasing.pdf import quote_pdf as make

    q = _quote(qid)
    return Response(
        make(q), mimetype="application/pdf", headers={"Content-Disposition": f'inline; filename="Quote-{q.number}.pdf"'}
    )


# ---- the customer's link (no sign-in) -------------------------------------------------------------
@bp.get("/public/quotes/<token>")
def public_quote(token: str) -> dict[str, Any]:
    return svc.public_quote(guard(svc.quote_by_token, token))


@bp.post("/public/quotes/<token>/decision")
def public_decide(token: str) -> dict[str, Any]:
    """{approve: bool, name, comment}"""
    q = guard(svc.quote_by_token, token)
    b = body()
    guard(svc.decide_quote, q, bool(b.get("approve")), str(b.get("name") or ""), str(b.get("comment") or ""))
    return svc.public_quote(q)


@bp.post("/public/quotes/<token>/comments")
def public_comment(token: str) -> dict[str, Any]:
    """{name, body}"""
    q = guard(svc.quote_by_token, token)
    if q.status not in ("sent", "approved", "rejected"):
        abort(409, message="This quote isn't open for comments.")
    b = body()
    if not str(b.get("name") or "").strip():
        abort(422, message="Tell us your name.")
    guard(svc.add_quote_comment, q, str(b.get("body") or ""), external_name=str(b.get("name") or ""))
    return svc.public_quote(q)


@bp.get("/public/quotes/<token>/pdf")
def public_quote_pdf(token: str) -> Any:
    from flask import Response

    from mpro.purchasing.pdf import quote_pdf as make

    q = guard(svc.quote_by_token, token)
    return Response(
        make(q), mimetype="application/pdf", headers={"Content-Disposition": f'inline; filename="Quote-{q.number}.pdf"'}
    )


# ---- search and file access ------------------------------------------------------------------------
@provider("vendors", "Vendors", "vendors.view")
def _search_vendors(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        scoped(Vendor)
        .where(func.lower(Vendor.name).like(like(q), escape="\\"))
        .order_by(func.lower(Vendor.name))
        .limit(limit)
    ).all()
    return [
        {"id": str(v.id), "title": v.name, "subtitle": v.email or v.phone or "Vendor", "url": f"/vendors/{v.id}"}
        for v in rows
    ]


@provider("customers", "Customers", "customers.view")
def _search_customers(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        scoped(Customer)
        .where(func.lower(Customer.name).like(like(q), escape="\\"))
        .order_by(func.lower(Customer.name))
        .limit(limit)
    ).all()
    return [
        {"id": str(c.id), "title": c.name, "subtitle": c.email or "Customer", "url": f"/customers/{c.id}"} for c in rows
    ]


def _in_org(model: Any, eid: uuid.UUID) -> bool:
    o = db.session.get(model, eid)
    return o is not None and o.org_id == g.org.id and o.deleted_at is None


register_entity(
    "vendor",
    lambda vid: _in_org(Vendor, vid) and can(g.membership, "vendors.view"),
    lambda vid: _in_org(Vendor, vid) and can(g.membership, "vendors.manage"),
)
register_entity(
    "customer",
    lambda cid: _in_org(Customer, cid) and can(g.membership, "customers.view"),
    lambda cid: _in_org(Customer, cid) and can(g.membership, "customers.manage"),
)
