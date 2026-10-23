# ruff: noqa: E501  (long API calls read better on one line)
"""Vendors (MP-045), customers and the work-order Customer field (MP-046, r234), customer quotes (r235)."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from tests.conftest import Api
from tests.test_assets import asset, loc, other_org
from tests.test_work_orders import create as create_wo
from tests.test_work_orders import login

API = "/api/v1"


def vendor(api: Api, name: str = "Acme Bearings", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/vendors", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def customer(api: Api, name: str = "Lakeside Condos", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/customers", {"name": name, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def put(api: Api, url: str, json: Any) -> Any:
    return api.c.put(url, json=json, headers={"X-CSRF-Token": api.csrf})


def last_email(app: Any, to: str) -> Any:
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        m = db.session.scalars(
            select(OutboundEmail).where(OutboundEmail.to == to).order_by(OutboundEmail.created_at.desc())
        ).first()
        assert m is not None, f"no email to {to}"
        return {"subject": m.subject, "body": m.body, "cc": m.cc, "attachments": m.attachments}


def latest_export(api: Api) -> str:
    ready = [i for i in api.get(f"{API}/exports").json["items"] if i["status"] == "ready"]
    assert ready, "no finished export"
    return api.get(ready[0]["file"]["url"]).data.decode()  # type: ignore[no-any-return]


# ---- vendors ---------------------------------------------------------------------------------------
def test_vendor_types_contacts_links_and_detail(admin: Api) -> None:
    t = admin.post(f"{API}/vendor-types", {"name": "Electrical", "color": "#f59e0b"})
    assert t.status_code == 201, t.json
    a = asset(admin, "Press 4")
    site = loc(admin, "Plant 7")
    v = vendor(
        admin,
        email="Orders@Acme.example",
        payment_terms="Net 30",
        account_number="C-1001",
        type_ids=[t.json["id"]],
        asset_ids=[a["id"]],
        location_ids=[site["id"]],
        contacts=[{"name": "Pat Doe", "email": "pat@acme.example", "is_po_contact": True}],
        address={"line1": "1 Main St", "city": "Springfield", "country": "US"},
    )
    assert v["types"][0]["name"] == "Electrical"
    assert [x["name"] for x in v["assets"]] == ["Press 4"] and [x["name"] for x in v["locations"]] == ["Plant 7"]
    assert v["contacts"][0]["is_po_contact"] is True
    c = admin.post(
        f"{API}/vendors/{v['id']}/contacts", {"name": "Billing", "email": "ap@acme.example", "cc_on_po": True}
    )
    assert c.status_code == 201, c.json
    assert (
        admin.patch(f"{API}/vendor-contacts/{c.json['id']}", {"role": "Accounts payable"}).json["role"]
        == "Accounts payable"
    )
    assert admin.post(f"{API}/vendors/{v['id']}/contacts", {"name": "Bad", "email": "not-an-email"}).status_code == 422
    d = admin.get(f"{API}/vendors/{v['id']}").json
    assert len(d["contacts"]) == 2 and d["purchase_orders"] == []
    # list, search, type filter
    vendor(admin, "Zeta Hydraulics")
    found = admin.get(f"{API}/vendors?q=acme").json
    assert [x["name"] for x in found["items"]] == ["Acme Bearings"]
    assert [x["name"] for x in admin.get(f"{API}/vendors?type_id={t.json['id']}").json["items"]] == ["Acme Bearings"]
    assert admin.post(f"{API}/vendors", {"name": ""}).status_code == 422
    # edit, then type delete unlinks it
    assert admin.patch(f"{API}/vendors/{v['id']}", {"phone": "+1 555 0100"}).json["phone"] == "+1 555 0100"
    assert admin.delete(f"{API}/vendor-types/{t.json['id']}").status_code == 204
    assert admin.get(f"{API}/vendors/{v['id']}").json["types"] == []
    assert admin.delete(f"{API}/vendor-contacts/{c.json['id']}").status_code == 204
    assert admin.delete(f"{API}/vendors/{v['id']}").status_code == 204
    assert admin.get(f"{API}/vendors/{v['id']}").status_code == 404


def test_vendor_search_and_export(admin: Api) -> None:
    vendor(admin, "Quantum Seals")
    hits = admin.get(f"{API}/search?q=quantum").json
    flat = str(hits)
    assert "Quantum Seals" in flat
    r = admin.post(f"{API}/vendors/export", {})
    assert r.status_code == 202, r.json
    body = latest_export(admin)
    assert "Quantum Seals" in body


def test_vendor_csv_export_neutralises_formulas(admin: Api) -> None:
    vendor(admin, "=HYPERLINK(1)")
    admin.post(f"{API}/vendors/export", {})
    body = latest_export(admin)
    assert "'=HYPERLINK(1)" in body


def test_vendor_permissions(app: Any, admin: Api) -> None:
    v = vendor(admin)
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/vendors/{v['id']}").status_code == 200
    assert viewer.post(f"{API}/vendors", {"name": "Nope"}).status_code == 403
    assert viewer.patch(f"{API}/vendors/{v['id']}", {"name": "Nope"}).status_code == 403
    requester = login(app, "jamie.ortiz@example.com")
    assert requester.get(f"{API}/vendors").status_code == 403
    tech = login(app, "avery.kim@example.com")
    assert tech.delete(f"{API}/vendors/{v['id']}").status_code == 403


# ---- customers -----------------------------------------------------------------------------------
def test_customer_gets_a_location_and_work_order_field(app: Any, admin: Api) -> None:
    c = customer(admin, labor_rate="90", parts_markup_pct="12.5", billing_email="pay@lakeside.example")
    assert c["labor_rate"] == "90" and c["parts_markup_pct"] == "12.5"
    assert c["default_location_id"] and [x["name"] for x in c["locations"]] == ["Lakeside Condos"]
    assert admin.post(f"{API}/customers", {"name": "X", "labor_rate": "-5"}).status_code == 422
    assert admin.post(f"{API}/customers/{c['id']}/contacts", {"name": "Sky", "is_billing": True}).status_code == 201
    wo = create_wo(admin)
    r = put(admin, f"{API}/work-orders/{wo['id']}/customer", {"customer_id": c["id"]})
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/work-orders/{wo['id']}/customer").json["customer"]["name"] == "Lakeside Condos"
    d = admin.get(f"{API}/customers/{c['id']}").json
    assert [w["id"] for w in d["work_orders"]] == [wo["id"]]
    assert admin.get(f"{API}/customers?q=lakes").json["items"][0]["id"] == c["id"]
    # clear it; viewers can't set it
    assert put(admin, f"{API}/work-orders/{wo['id']}/customer", {"customer_id": None}).json["customer"] is None
    viewer = login(app, "quinn.foster@example.com")
    assert put(viewer, f"{API}/work-orders/{wo['id']}/customer", {"customer_id": c["id"]}).status_code == 403
    assert admin.delete(f"{API}/customers/{c['id']}").status_code == 204


# ---- quotes --------------------------------------------------------------------------------------
def quote(admin: Api, **kw: Any) -> dict[str, Any]:
    c = kw.pop("customer", None) or customer(admin, billing_email="pay@lakeside.example")
    r = admin.post(
        f"{API}/quotes",
        {
            "customer_id": c["id"],
            "title": "Replace pump",
            "tax_pct": "10",
            "lines": [
                {"kind": "labor", "description": "Labor", "quantity": "3", "unit_price": "80"},
                {"kind": "part", "description": "Pump", "quantity": "1", "unit_price": "300", "taxable": True},
                {"kind": "other", "description": "Permit", "quantity": "1", "unit_price": "50", "taxable": False},
            ],
            **kw,
        },
    )
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def test_quote_totals_send_and_public_approval(app: Any, admin: Api) -> None:
    wo = create_wo(admin)
    q = quote(admin, work_order_id=wo["id"], valid_until=(date.today() + timedelta(days=10)).isoformat())
    assert (q["subtotal"], q["total"]) == ("590", "644")  # tax on 540 of taxable lines
    sent = admin.post(f"{API}/quotes/{q['id']}/send", {"message": "Thanks for asking"})
    assert sent.status_code == 200, sent.json
    mail = last_email(app, "pay@lakeside.example")
    token = re.search(r"/quote/([\w-]+)", mail["body"]).group(1)  # type: ignore[union-attr]
    assert sent.json["url"].endswith(token)
    # the customer, signed out
    anon = Api(app.test_client())
    anon.session()
    pub = anon.get(f"{API}/public/quotes/{token}")
    assert pub.status_code == 200, pub.json
    assert pub.json["title"] == "Replace pump" and pub.json["id"] is None and len(pub.json["lines"]) == 3
    assert "customer_id" not in pub.json
    assert anon.get(f"{API}/public/quotes/{token}/pdf").data[:4] == b"%PDF"
    assert anon.post(
        f"{API}/public/quotes/{token}/comments", {"name": "Morgan", "body": "Can you start Monday?"}
    ).status_code in (200, 201)
    assert anon.post(f"{API}/public/quotes/{token}/decision", {"approve": False, "name": "Morgan"}).status_code == 422
    r = anon.post(f"{API}/public/quotes/{token}/decision", {"approve": True, "name": "Morgan Lee"})
    assert r.status_code == 200, r.json
    assert anon.post(f"{API}/public/quotes/{token}/decision", {"approve": True, "name": "Again"}).status_code == 409
    d = admin.get(f"{API}/quotes/{q['id']}").json
    assert d["status"] == "approved" and d["decided_by_name"] == "Morgan Lee"
    with app.app_context():
        import uuid

        from mpro.core.files import links_for

        names = [link.file.name for link in links_for("work_order", uuid.UUID(wo["id"])) if link.file]
    assert any(n.startswith("Quote-") for n in names)
    assert admin.patch(f"{API}/quotes/{q['id']}", {"title": "Changed"}).status_code == 409
    assert anon.get(f"{API}/public/quotes/not-a-real-token").status_code == 404


def test_quote_expiry_rejection_and_cancel(app: Any, admin: Api) -> None:
    c = customer(admin, billing_email="pay@lakeside.example")
    q = quote(admin, customer=c, valid_until=(date.today() - timedelta(days=1)).isoformat())
    url = admin.post(f"{API}/quotes/{q['id']}/send", {}).json["url"]
    token = url.rsplit("/", 1)[1]
    anon = Api(app.test_client())
    anon.session()
    assert anon.get(f"{API}/public/quotes/{token}").json["expired"] is True
    assert anon.post(f"{API}/public/quotes/{token}/decision", {"approve": True, "name": "M"}).status_code == 409
    q2 = quote(admin, customer=c)
    t2 = admin.post(f"{API}/quotes/{q2['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    r = anon.post(f"{API}/public/quotes/{t2}/decision", {"approve": False, "name": "M", "comment": "Too pricey"})
    assert r.status_code == 200, r.json
    q3 = quote(admin, customer=c)
    t3 = admin.post(f"{API}/quotes/{q3['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    assert admin.post(f"{API}/quotes/{q3['id']}/cancel", {}).status_code == 200
    assert anon.get(f"{API}/public/quotes/{t3}").status_code == 404
    # resending makes a new link and kills the old one
    q4 = quote(admin, customer=c)
    old = admin.post(f"{API}/quotes/{q4['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    new = admin.post(f"{API}/quotes/{q4['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    assert anon.get(f"{API}/public/quotes/{old}").status_code == 404
    assert anon.get(f"{API}/public/quotes/{new}").status_code == 200
    assert [x["status"] for x in admin.get(f"{API}/quotes?customer_id={c['id']}").json["items"]].count("sent") == 1


# ---- tenancy -------------------------------------------------------------------------------------
def test_other_org_cannot_reach_vendors_customers_or_quotes(app: Any, admin: Api) -> None:
    v = vendor(admin, contacts=[{"name": "Pat"}])
    cid = v["contacts"][0]["id"]
    t = admin.post(f"{API}/vendor-types", {"name": "Mine"}).json
    c = customer(admin)
    cc = admin.post(f"{API}/customers/{c['id']}/contacts", {"name": "Sky"}).json
    q = quote(admin, customer=c)
    wo = create_wo(admin)
    a = asset(admin, "Press 9")
    other = other_org(app)
    for url in (
        f"{API}/vendors/{v['id']}",
        f"{API}/customers/{c['id']}",
        f"{API}/quotes/{q['id']}",
        f"{API}/quotes/{q['id']}/pdf",
    ):
        assert other.get(url).status_code == 404, url
    for url in (
        f"{API}/vendors/{v['id']}",
        f"{API}/vendor-contacts/{cid}",
        f"{API}/vendor-types/{t['id']}",
        f"{API}/customers/{c['id']}",
        f"{API}/customer-contacts/{cc['id']}",
        f"{API}/quotes/{q['id']}",
    ):
        assert other.patch(url, {"name": "Hijack", "title": "Hijack"}).status_code == 404, url
        assert other.delete(url).status_code == 404, url
    for url in (
        f"{API}/vendors/{v['id']}/contacts",
        f"{API}/customers/{c['id']}/contacts",
        f"{API}/quotes/{q['id']}/send",
        f"{API}/quotes/{q['id']}/cancel",
    ):
        assert other.post(url, {"name": "X"}).status_code == 404, url
    assert other.get(f"{API}/vendors").json["items"] == []
    assert other.get(f"{API}/customers").json["items"] == []
    assert other.get(f"{API}/quotes").json["items"] == []
    # IDs from another org can't be linked
    assert other.post(f"{API}/vendors", {"name": "X", "asset_ids": [a["id"]]}).status_code in (404, 422)
    assert other.post(f"{API}/vendors", {"name": "X", "type_ids": [t["id"]]}).status_code in (404, 422)
    assert other.post(f"{API}/quotes", {"customer_id": c["id"], "title": "X"}).status_code in (404, 422)
    own = customer(other, "Theirs")
    assert other.post(
        f"{API}/quotes", {"customer_id": own["id"], "title": "X", "work_order_id": wo["id"]}
    ).status_code in (404, 422)
    own_wo = create_wo(other)
    assert put(other, f"{API}/work-orders/{own_wo['id']}/customer", {"customer_id": c["id"]}).status_code in (404, 422)
    assert put(other, f"{API}/work-orders/{wo['id']}/customer", {"customer_id": own["id"]}).status_code == 404
    assert put(admin, f"{API}/work-orders/{wo['id']}/customer", {"customer_id": own["id"]}).status_code in (404, 422)


def seed_demo_records(app: Any) -> None:
    """The test app skips demo work (MPRO_TEST_DEMO_WORK); seed the 0.5.0 records the way the demo does."""
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.demo import DEMO_EMAIL
        from mpro.extensions import db
        from mpro.orgs.models import Organization
        from mpro.parts.demo import seed_parts
        from mpro.purchasing.demo import seed_purchasing
        from mpro.vendors.demo import seed_vendors

        admin = db.session.scalars(select(User).where(User.email == DEMO_EMAIL)).one()
        org = db.session.scalars(select(Organization).where(Organization.slug == "acme-demo")).one()
        seed_vendors(org, admin)
        seed_parts(org, admin)
        seed_purchasing(org, admin)
        seed_vendors(org, admin)  # runs once
        seed_purchasing(org, admin)


def test_demo_vendors_and_customers(app: Any, admin: Api) -> None:
    seed_demo_records(app)
    names = [v["name"] for v in admin.get(f"{API}/vendors").json["items"]]
    assert "Apex Bearing & Belt" in names and len(names) == 4
    cs = admin.get(f"{API}/customers").json["items"]
    assert {c["name"] for c in cs} == {"Riverside Apartments", "Harbor Foods Co."}
    assert admin.get(f"{API}/quotes").json["items"]
