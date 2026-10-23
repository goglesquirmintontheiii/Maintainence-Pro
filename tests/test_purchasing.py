# ruff: noqa: E501  (long API calls read better on one line)
"""Purchase orders (MP-042–044): requests and approvals, rules and budgets, totals, receiving through the
inventory ledger, numbering, sending to the vendor, low-stock suggestions, exports and tenancy."""

from __future__ import annotations

import os
import threading
from decimal import Decimal
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_assets import other_org
from tests.test_parts import stocked
from tests.test_roles import member
from tests.test_vendors import last_email, latest_export, seed_demo_records, vendor
from tests.test_work_orders import login, uid

API = "/api/v1"


def po(api: Api, v: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    body = {"title": "Restock", "lines": [{"description": "Gloves", "quantity": "2", "unit_cost": "10"}], **kw}
    if v is not None:
        body["vendor_id"] = v["id"]
    r = api.post(f"{API}/purchase-orders", body)
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def part_row(app: Any, pid: str) -> tuple[Decimal, Decimal]:
    """(on hand across locations, ordered) straight from the database."""
    with app.app_context():
        import uuid

        from mpro.extensions import db
        from mpro.parts.models import Part

        p = db.session.get(Part, uuid.UUID(pid))
        assert p is not None
        return Decimal(p.on_hand), Decimal(p.ordered)


# ---- create, totals, edit --------------------------------------------------------------------------
def test_totals_with_percent_fixed_and_tax(admin: Api) -> None:
    v = vendor(admin)
    d = po(
        admin,
        v,
        lines=[
            {"description": "Taxed item", "quantity": "2", "unit_cost": "10"},
            {"description": "Exempt item", "quantity": "1", "unit_cost": "30", "taxable": False},
        ],
        costs=[
            {"label": "Shipping", "kind": "fixed", "value": "10", "taxable": True},
            {"label": "Handling", "kind": "percent", "value": "10"},
            {"label": "Sales tax", "kind": "percent", "value": "8", "is_tax": True},
        ],
    )
    assert d["status"] == "approved"  # the owner creates approved POs
    assert (d["subtotal"], d["total"]) == ("50", "67.4")  # 50 + 10 + 5 + 8% of (20 + 10)
    assert [c["amount"] for c in d["costs"]] == ["10", "5", "2.4"]
    assert d["display_number"].startswith("PO-") and d["vendor"]["name"] == v["name"]
    # edit lines: totals follow; the version guards against stale edits
    r = admin.patch(
        f"{API}/purchase-orders/{d['id']}",
        {
            "version": d["version"],
            "lines": [{"id": d["lines"][0]["id"], "description": "Taxed item", "quantity": "3", "unit_cost": "10"}],
        },
    )
    assert r.status_code == 200, r.json
    assert r.json["subtotal"] == "30"
    assert (
        admin.patch(f"{API}/purchase-orders/{d['id']}", {"version": d["version"], "title": "Stale"}).status_code == 409
    )
    assert admin.post(f"{API}/purchase-orders", {"lines": [{"description": "X", "quantity": "0"}]}).status_code == 422
    assert (
        admin.post(
            f"{API}/purchase-orders",
            {
                "lines": [{"description": "X", "quantity": "1"}],
                "costs": [{"label": "Bad", "kind": "weird", "value": "1"}],
            },
        ).status_code
        == 422
    )


def test_requests_review_and_reject(app: Any, admin: Api) -> None:
    tech = login(app, "avery.kim@example.com")
    d = po(tech)
    assert d["status"] == "requested" and d["total"] is None and d["can"]["costs"] is False
    assert tech.post(f"{API}/purchase-orders/{d['id']}/approve", {}).status_code == 403
    # a technician can edit their own request, not someone else's
    assert tech.patch(f"{API}/purchase-orders/{d['id']}", {"title": "Gloves, large"}).status_code == 200
    other = po(login(app, "sam.patel@example.com"))
    assert tech.patch(f"{API}/purchase-orders/{other['id']}", {"title": "Mine now"}).status_code == 403
    assert admin.post(f"{API}/purchase-orders/{other['id']}/reject", {}).status_code == 422
    assert (
        admin.post(f"{API}/purchase-orders/{other['id']}/reject", {"reason": "Use stock"}).json["status"] == "rejected"
    )
    assert admin.post(f"{API}/purchase-orders/{d['id']}/approve", {}).json["status"] == "approved"
    awaiting = admin.get(f"{API}/purchase-orders?status=awaiting_me").json["items"]
    assert d["id"] not in [x["id"] for x in awaiting]
    # requesters (role) can't see purchasing at all; viewers can look but not buy
    assert login(app, "jamie.ortiz@example.com").get(f"{API}/purchase-orders").status_code == 403
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/purchase-orders/{d['id']}").status_code == 200
    assert viewer.post(f"{API}/purchase-orders", {"lines": [{"description": "X", "quantity": "1"}]}).status_code == 403


def test_approval_rule_and_budget_limit(app: Any, admin: Api) -> None:
    owner_id = uid(admin, "admin@example.com")
    r = admin.post(
        f"{API}/approval-rules",
        {
            "name": "Big orders",
            "conditions": [{"field": "total", "op": ">=", "value": "1000"}],
            "approver_user_ids": [owner_id],
        },
    )
    assert r.status_code == 201, r.json
    assert admin.post(f"{API}/approval-rules", {"name": "Bad", "conditions": [{"field": "nope"}]}).status_code == 422
    assert admin.post(
        f"{API}/approval-rules", {"name": "Bad", "approver_user_ids": ["00000000-0000-0000-0000-000000000000"]}
    ).status_code in (404, 422)
    manager = login(app, "jordan.reyes@example.com")  # limited admin: manages POs, can't approve them
    small = po(manager)
    assert small["status"] == "approved"
    big = po(manager, lines=[{"description": "Gearbox", "quantity": "1", "unit_cost": "1500"}])
    assert big["status"] == "pending" and big["approvals"][0]["status"] == "pending"
    assert big["can"]["decide"] is False
    assert manager.post(f"{API}/purchase-orders/{big['id']}/approve", {}).status_code == 403
    assert big["id"] in [x["id"] for x in admin.get(f"{API}/purchase-orders?status=awaiting_me").json["items"]]
    assert (
        admin.post(
            f"{API}/purchase-orders/{big['id']}/receive",
            {"lines": [{"line_id": big["lines"][0]["id"], "quantity": "1"}]},
        ).status_code
        == 409
    )
    ok = admin.post(f"{API}/purchase-orders/{big['id']}/approve", {"comment": "Go"})
    assert ok.status_code == 200, ok.json
    assert ok.json["status"] == "approved" and ok.json["approved_by"]
    # raising the total of an approved PO sends it back for approval
    raised = manager.patch(
        f"{API}/purchase-orders/{small['id']}",
        {"lines": [{"description": "Gloves", "quantity": "200", "unit_cost": "10"}]},
    )
    assert raised.status_code == 200, raised.json
    assert raised.json["status"] == "pending"
    assert (
        admin.post(f"{API}/purchase-orders/{small['id']}/reject", {"reason": "Too many"}).json["status"] == "rejected"
    )
    # a budget's approval limit
    b = admin.post(
        f"{API}/budgets",
        {"name": "Line 2", "amount": "1000", "approval_limit": "300", "period": "month", "warn_at_pct": 80},
    )
    assert b.status_code == 201, b.json
    under = po(manager, budget_id=b.json["id"], lines=[{"description": "Belt", "quantity": "1", "unit_cost": "250"}])
    assert under["status"] == "approved" and under["budget"]["level"] == "ok"
    over = po(manager, budget_id=b.json["id"], lines=[{"description": "Motor", "quantity": "1", "unit_cost": "600"}])
    assert over["status"] == "pending" and over["budget"]["over_limit"] is True and over["budget"]["level"] == "warn"
    spent = next(x for x in admin.get(f"{API}/budgets").json["items"] if x["id"] == b.json["id"])
    assert spent["spent"] == "850"
    assert admin.post(f"{API}/budgets", {"name": "X", "period": "week"}).status_code == 422


# ---- receiving -------------------------------------------------------------------------------------
def test_partial_receiving_moves_stock_and_ordered(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "2")
    v = vendor(admin)
    d = po(
        admin,
        v,
        lines=[
            {"part_id": p["id"], "quantity": "10", "unit_cost": "3", "location_id": wh},
            {"description": "Freight insurance", "quantity": "1", "unit_cost": "5"},
        ],
    )
    assert d["lines"][0]["part"]["id"] == p["id"]
    assert part_row(app, p["id"]) == (Decimal("2"), Decimal("10"))
    pl, other = d["lines"][0]["id"], d["lines"][1]["id"]
    r = admin.post(
        f"{API}/purchase-orders/{d['id']}/receive",
        {"lines": [{"line_id": pl, "quantity": "4", "unit_cost": "3.25"}], "packing_slip": "PS-1"},
    )
    assert r.status_code == 200, r.json
    assert r.json["status"] == "partially_fulfilled" and any("3.25" in w for w in r.json["warnings"])
    assert part_row(app, p["id"]) == (Decimal("6"), Decimal("6"))
    assert r.json["lines"][0]["locked"] is True and len(r.json["receipts"]) == 1
    txns = admin.get(f"{API}/parts/transactions?part_id={p['id']}").json["items"]
    assert any(t["kind"] == "receive" and Decimal(t["quantity"]) == 4 for t in txns)
    # received lines can't be removed; nothing received can't be canceled
    assert admin.patch(
        f"{API}/purchase-orders/{d['id']}",
        {"lines": [{"id": other, "description": "Freight insurance", "quantity": "1", "unit_cost": "5"}]},
    ).status_code in (409, 422)
    assert admin.post(f"{API}/purchase-orders/{d['id']}/cancel", {}).status_code == 409
    assert admin.delete(f"{API}/purchase-orders/{d['id']}").status_code == 409
    # a correction takes stock back out
    assert (
        admin.post(
            f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": pl, "quantity": "-1"}]}
        ).status_code
        == 200
    )
    assert part_row(app, p["id"]) == (Decimal("5"), Decimal("7"))
    assert (
        admin.post(
            f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": pl, "quantity": "-9"}]}
        ).status_code
        == 422
    )
    # the rest arrives (one extra): complete, nothing left on order
    r = admin.post(
        f"{API}/purchase-orders/{d['id']}/receive",
        {"lines": [{"line_id": pl, "quantity": "8"}, {"line_id": other, "quantity": "1"}]},
    )
    assert r.json["status"] == "complete" and any("ordered" in w for w in r.json["warnings"])
    assert part_row(app, p["id"]) == (Decimal("13"), Decimal("0"))
    assert admin.post(f"{API}/purchase-orders/{d['id']}/reopen", {}).json["status"] == "partially_fulfilled"
    assert admin.post(f"{API}/purchase-orders/{d['id']}/complete", {}).json["status"] == "complete"
    assert (
        admin.post(
            f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": pl, "quantity": "1"}]}
        ).status_code
        == 409
    )
    # filters
    assert d["id"] in [x["id"] for x in admin.get(f"{API}/purchase-orders?part_id={p['id']}").json["items"]]
    assert d["id"] in [x["id"] for x in admin.get(f"{API}/purchase-orders?vendor_id={v['id']}").json["items"]]


def test_cancel_and_delete_release_ordered(app: Any, admin: Api) -> None:
    p, _wh = stocked(admin, "2")
    d = po(admin, lines=[{"part_id": p["id"], "quantity": "5"}])
    assert part_row(app, p["id"])[1] == 5
    assert admin.post(f"{API}/purchase-orders/{d['id']}/cancel", {"reason": "Wrong part"}).json["status"] == "canceled"
    assert part_row(app, p["id"])[1] == 0
    copy = admin.post(f"{API}/purchase-orders/{d['id']}/duplicate", {})
    assert copy.status_code == 201 and copy.json["lines"][0]["part"]["id"] == p["id"] and copy.json["id"] != d["id"]
    assert part_row(app, p["id"])[1] == 5
    assert admin.delete(f"{API}/purchase-orders/{copy.json['id']}").status_code == 204
    assert part_row(app, p["id"])[1] == 0
    assert admin.get(f"{API}/purchase-orders/{copy.json['id']}").status_code == 404


# ---- numbering -------------------------------------------------------------------------------------
def test_numbering_prefix_custom_numbers_and_next_number(admin: Api) -> None:
    s = admin.patch(
        f"{API}/purchasing/settings",
        {"number_prefix": "ACME-", "next_number": 500, "default_cc": ["buyer@example.com"]},
    )
    assert s.status_code == 200, s.json
    a = po(admin)
    assert a["number"] == 500 and a["display_number"] == "ACME-500"
    assert po(admin)["number"] == 501
    assert (
        admin.patch(f"{API}/purchasing/settings", {"next_number": 3}).status_code == 422
    )  # can't go back below used numbers
    assert admin.patch(f"{API}/purchasing/settings", {"default_cc": ["nope"]}).status_code == 422
    c = po(admin, custom_number="VENDOR-77")
    assert c["display_number"] == "VENDOR-77"
    assert (
        admin.post(
            f"{API}/purchase-orders", {"custom_number": "VENDOR-77", "lines": [{"description": "X", "quantity": "1"}]}
        ).status_code
        == 409
    )
    assert [x["id"] for x in admin.get(f"{API}/purchase-orders?q=ACME-500").json["items"]] == [a["id"]]


@pytest.mark.skipif(
    not (os.environ.get("TEST_DATABASE_URL") or "").startswith("postgresql"),
    reason="needs PostgreSQL for real concurrency",
)
def test_numbering_is_unique_under_concurrency(app: Any) -> None:
    with app.app_context():
        from sqlalchemy import select

        from mpro.extensions import db
        from mpro.orgs.models import Organization

        org_id = db.session.scalars(select(Organization.id)).first()
    got: list[int] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            with app.app_context():
                from mpro.extensions import db
                from mpro.purchasing.services import next_counter

                n = next_counter(org_id, "purchase_order")
                db.session.commit()
                got.append(n)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors and len(got) == 8 and len(set(got)) == 8


# ---- send, comments, pdf ---------------------------------------------------------------------------
def test_send_to_vendor_emails_pdf_with_cc(app: Any, admin: Api) -> None:
    admin.patch(f"{API}/purchasing/settings", {"default_cc": ["buyer@example.com"]})
    v = vendor(
        admin,
        contacts=[
            {"name": "Pat", "email": "pat@vendor.example", "is_po_contact": True},
            {"name": "AP", "email": "ap@vendor.example", "cc_on_po": True},
        ],
    )
    d = po(admin, v)
    assert admin.get(f"{API}/purchase-orders/{d['id']}/pdf").data[:4] == b"%PDF"
    r = admin.post(f"{API}/purchase-orders/{d['id']}/send", {"message": "Please confirm the ship date"})
    assert r.status_code == 200, r.json
    assert r.json["sent"]["sent_to"] == ["pat@vendor.example"] and r.json["sent_at"]
    mail = last_email(app, "pat@vendor.example")
    assert "ap@vendor.example" in mail["cc"] and "buyer@example.com" in mail["cc"]
    assert mail["attachments"][0]["name"].endswith(".pdf")
    assert any(f["role"] == "pdf" for f in r.json["files"])
    # a request can't be sent; no address at all is an error
    req = po(login(app, "avery.kim@example.com"), v)
    assert admin.post(f"{API}/purchase-orders/{req['id']}/send", {}).status_code == 409
    bare = po(admin, vendor(admin, "No Email Co"))
    assert admin.post(f"{API}/purchase-orders/{bare['id']}/send", {}).status_code == 422
    # technicians can't download the priced PDF
    assert login(app, "avery.kim@example.com").get(f"{API}/purchase-orders/{d['id']}/pdf").status_code == 403


def test_comments(app: Any, admin: Api) -> None:
    d = po(admin)
    r = admin.post(f"{API}/purchase-orders/{d['id']}/comments", {"body": "Vendor says Tuesday"})
    assert r.status_code == 201, r.json
    items = admin.get(f"{API}/purchase-orders/{d['id']}/comments").json["items"]
    assert items[-1]["body"] == "Vendor says Tuesday"
    tech = login(app, "avery.kim@example.com")
    assert tech.delete(f"{API}/purchase-orders/{d['id']}/comments/{items[-1]['id']}").status_code == 403
    assert admin.delete(f"{API}/purchase-orders/{d['id']}/comments/{items[-1]['id']}").status_code == 204


# ---- low stock suggestions -------------------------------------------------------------------------
def test_low_stock_suggestions_make_a_po(app: Any, admin: Api) -> None:
    v = vendor(admin, "Bearing World")
    p, wh = stocked(
        admin,
        "1",
        min_qty="4",
        max_qty="10",
        vendors=[{"vendor_id": v["id"], "vendor_part_number": "BW-1", "preferred": True}],
    )
    groups = admin.get(f"{API}/purchase-orders/suggestions").json["groups"]
    g = next(x for x in groups if x["vendor_id"] == v["id"])
    line = next(ln for ln in g["lines"] if ln["part_id"] == p["id"])
    assert Decimal(line["quantity"]) == 9 and line["vendor_part_number"] == "BW-1"
    r = admin.post(f"{API}/purchase-orders/from-suggestions", {"vendor_id": v["id"], "part_ids": [p["id"]]})
    assert r.status_code == 201, r.json
    assert r.json["source"] == "low_stock" and r.json["lines"][0]["part_number"] == "BW-1"
    # what's on order now covers it
    groups = admin.get(f"{API}/purchase-orders/suggestions").json["groups"]
    assert not any(ln["part_id"] == p["id"] for grp in groups for ln in grp["lines"])
    assert admin.post(f"{API}/purchase-orders/from-suggestions", {"vendor_id": v["id"]}).status_code == 404


# ---- addresses, export, search ---------------------------------------------------------------------
def test_addresses_defaults_export_and_search(admin: Api) -> None:
    a = admin.post(
        f"{API}/addresses",
        {"label": "Dock 2", "line1": "2 Harbor Rd", "kind": "shipping", "is_default": True, "country": "us"},
    )
    assert a.status_code == 201, a.json
    assert a.json["country"] == "US"
    assert admin.post(f"{API}/addresses", {"kind": "shipping"}).status_code == 422
    d = po(admin, title="Seal kit order")
    assert d["shipping_address"]["id"] == a.json["id"]
    assert admin.post(f"{API}/purchase-orders/export", {}).status_code == 202
    body = latest_export(admin)
    assert "Seal kit order" in body and "Total" in body
    assert "Seal kit order" in str(admin.get(f"{API}/search?q=seal kit").json)
    opts = admin.get(f"{API}/purchase-orders/options").json
    assert opts["can"]["settings"] is True and any(x["id"] == a.json["id"] for x in opts["addresses"])


def test_contract_create_purchase_order(app: Any, admin: Api) -> None:
    """Other modules (supplier links, work orders) create POs through this function."""
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.models import Membership, Organization
        from mpro.purchasing.services import create_purchase_order

        u = db.session.scalars(select(User).where(User.email == "admin@example.com")).one()
        m = db.session.scalars(select(Membership).where(Membership.user_id == u.id)).first()
        assert m is not None
        org = db.session.get(Organization, m.org_id)
        p = create_purchase_order(
            org, m, {"source": "punchout", "lines": [{"description": "Cart item", "quantity": "2", "unit_cost": "4.5"}]}
        )
        assert p.status == "approved" and p.total == Decimal("9.00") and p.source == "punchout"


# ---- tenancy ---------------------------------------------------------------------------------------
def test_other_org_cannot_reach_purchasing(app: Any, admin: Api) -> None:
    v = vendor(admin, contacts=[{"name": "Pat", "email": "pat@v.example"}])
    p, wh = stocked(admin, "1")
    d = po(admin, v, lines=[{"part_id": p["id"], "quantity": "1"}])
    a = admin.post(f"{API}/addresses", {"label": "Mine", "line1": "1 Road"}).json
    b = admin.post(f"{API}/budgets", {"name": "Mine", "amount": "10"}).json
    rule = admin.post(f"{API}/approval-rules", {"name": "Mine", "conditions": [], "action": "auto_approve"}).json
    admin.post(f"{API}/purchase-orders/{d['id']}/comments", {"body": "hi"})
    cid = admin.get(f"{API}/purchase-orders/{d['id']}/comments").json["items"][0]["id"]
    other = other_org(app)
    base = f"{API}/purchase-orders/{d['id']}"
    for url in (base, f"{base}/pdf", f"{base}/comments"):
        assert other.get(url).status_code == 404, url
    assert other.patch(base, {"title": "Hijack"}).status_code == 404
    for action in ("approve", "reject", "receive", "complete", "reopen", "cancel", "duplicate", "send", "comments"):
        assert (
            other.post(
                f"{base}/{action}",
                {"reason": "x", "body": "x", "lines": [{"line_id": d["lines"][0]["id"], "quantity": "1"}]},
            ).status_code
            == 404
        ), action
    assert other.delete(f"{base}/comments/{cid}").status_code == 404
    assert other.delete(base).status_code == 404
    for url in (f"{API}/addresses/{a['id']}", f"{API}/budgets/{b['id']}", f"{API}/approval-rules/{rule['id']}"):
        assert other.patch(url, {"name": "x", "label": "x"}).status_code == 404, url
        assert other.delete(url).status_code == 404, url
    assert other.get(f"{API}/purchase-orders").json["items"] == []
    assert other.get(f"{API}/purchase-orders/suggestions").json["groups"] == []
    # their POs can't use our vendor, part, address, budget or contacts
    line = [{"description": "X", "quantity": "1"}]
    for bad in (
        {"vendor_id": v["id"]},
        {"shipping_address_id": a["id"]},
        {"budget_id": b["id"]},
        {"lines": [{"part_id": p["id"], "quantity": "1"}]},
        {"lines": [{"description": "X", "quantity": "1", "location_id": wh}]},
    ):
        r = other.post(f"{API}/purchase-orders", {"lines": line, **bad})
        assert r.status_code in (404, 422), (bad, r.status_code)
    own = other.post(f"{API}/purchase-orders", {"lines": line}).json
    assert (
        other.post(
            f"{API}/purchase-orders/{own['id']}/receive", {"lines": [{"line_id": d["lines"][0]["id"], "quantity": "1"}]}
        ).status_code
        == 422
    )
    assert other.post(
        f"{API}/approval-rules", {"name": "x", "approver_user_ids": [uid(admin, "admin@example.com")]}
    ).status_code in (404, 422)
    assert admin.get(f"{API}/purchase-orders/{own['id']}").status_code == 404


def test_custom_role_with_own_po_management(app: Any, admin: Api) -> None:
    role = admin.post(f"{API}/roles", {"name": "Buyer (own)", "base": "technician"}).json
    perms = [x for x in role["permissions"] if x != "po.manage"] + ["po.manage_own", "po.view", "po.request"]
    admin.patch(f"{API}/roles/{role['id']}", {"permissions": perms})
    buyer = member(app, "buyer@example.com", "technician", admin)
    admin.patch(f"{API}/users/{uid(admin, 'buyer@example.com')}", {"role": role["key"]})
    mine = po(buyer)
    assert mine["status"] == "approved" and mine["can"]["edit"] is True
    theirs = po(admin)
    assert buyer.patch(f"{API}/purchase-orders/{theirs['id']}", {"title": "Mine"}).status_code == 403
    assert buyer.patch(f"{API}/purchase-orders/{mine['id']}", {"title": "Still mine"}).status_code == 200


def test_demo_purchasing(app: Any, admin: Api) -> None:
    seed_demo_records(app)
    items = admin.get(f"{API}/purchase-orders").json["items"]
    assert len(items) == 5
    assert {x["status"] for x in items} >= {"partially_fulfilled", "approved", "pending", "requested", "complete"}
    assert admin.get(f"{API}/approval-rules").json["items"] and admin.get(f"{API}/budgets").json["items"]
