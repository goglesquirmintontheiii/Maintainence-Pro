"""Regression tests for the finance findings of the independent 0.5.0 review (#1, #4–#7, #10–#12)."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_finance import (
    API,
    PNG_1PX,
    TECH,
    FakeImap,
    _mail,
    cert,
    customer,
    done_wo,
    multipart,
    org_id,
    vendor,
)
from tests.test_parts import stocked
from tests.test_work_orders import login, uid


def _rule_over_50(admin: Api) -> None:
    r = admin.post(
        f"{API}/approval-rules",
        {
            "name": "Invoices over 50",
            "applies_to": "vendor_invoice",
            "conditions": [{"field": "total", "op": ">", "value": "50"}],
            "approver_user_ids": [uid(admin, "jordan.reyes@example.com")],
        },
    )
    assert r.status_code in (200, 201), r.json


def _invoice(admin: Api, app: Any, price: str = "120") -> dict[str, Any]:
    r = admin.post(
        f"{API}/finance/vendor-invoices",
        {
            "vendor_id": vendor(app, name=f"V {uuid.uuid4().hex[:6]}"),
            "number": uuid.uuid4().hex[:8],
            "lines": [{"description": "Service call", "quantity": 1, "unit_price": price}],
        },
    )
    assert r.status_code == 200, r.json
    return r.json


def _steps(app: Any, inv_id: str) -> list[str]:
    with app.app_context():
        from sqlalchemy import select

        from mpro.extensions import db
        from mpro.purchasing.models import Approval

        return list(
            db.session.scalars(
                select(Approval.status).where(
                    Approval.entity_type == "vendor_invoice", Approval.entity_id == uuid.UUID(inv_id)
                )
            )
        )


# ---- #1 vendor invoice approval state ----------------------------------------------------------------------------
def test_invoice_waiting_for_approval_is_locked_and_decide_needs_pending(app: Any, admin: Api) -> None:
    _rule_over_50(admin)
    inv = _invoice(admin, app)
    url = f"{API}/finance/vendor-invoices/{inv['id']}"
    jordan = login(app, "jordan.reyes@example.com")
    assert jordan.post(f"{url}/decide", {"approve": True}).status_code == 409  # nothing to decide yet
    got = admin.post(f"{url}/submit", {"override": True})
    assert got.status_code == 200 and got.json["status"] == "pending", got.json
    # locked while the approvers decide: no changing the amount under them
    assert admin.patch(url, {"lines": [{"description": "x", "quantity": 1, "unit_price": "9999"}]}).status_code == 409
    assert admin.post(f"{url}/submit", {"override": True}).status_code == 409
    assert admin.get(f"{API}/finance/vendor-invoices?status=pending").json["total"] == 1
    # dispute skips the pending step, and the approver can't approve the disputed invoice afterwards
    assert admin.post(f"{url}/status", {"action": "dispute", "note": "Wrong rate"}).json["status"] == "disputed"
    assert _steps(app, inv["id"]) == ["skipped"]
    assert jordan.post(f"{url}/decide", {"approve": True}).status_code in (403, 409)
    assert admin.get(url).json["status"] == "disputed"
    # reopened and edited → approval starts over from scratch
    assert admin.post(f"{url}/status", {"action": "reopen"}).json["status"] == "received"
    assert admin.patch(url, {"lines": [{"description": "x", "quantity": 1, "unit_price": "80"}]}).status_code == 200
    assert admin.post(f"{url}/submit", {"override": True}).json["status"] == "pending"
    assert jordan.post(f"{url}/decide", {"approve": True}).json["status"] == "approved"
    # void skips pending steps too
    inv2 = _invoice(admin, app)
    admin.post(f"{API}/finance/vendor-invoices/{inv2['id']}/submit", {"override": True})
    assert admin.post(f"{API}/finance/vendor-invoices/{inv2['id']}/status", {"action": "void"}).json["status"] == "void"
    assert _steps(app, inv2["id"]) == ["skipped"]
    assert jordan.post(f"{API}/finance/vendor-invoices/{inv2['id']}/decide", {"approve": True}).status_code in (
        403,
        409,
    )


def test_invoice_payments_cannot_exceed_what_is_owed(app: Any, admin: Api) -> None:
    inv = _invoice(admin, app, "100")
    url = f"{API}/finance/vendor-invoices/{inv['id']}"
    assert admin.post(f"{url}/submit", {"override": True}).json["status"] == "approved"
    assert admin.post(f"{url}/payments", {"amount": "100.01"}).status_code == 422
    assert admin.post(f"{url}/payments", {"amount": "60"}).status_code == 200
    assert admin.post(f"{url}/payments", {"amount": "40.01"}).status_code == 422
    assert admin.post(f"{url}/status", {"action": "void"}).status_code in (409, 422)  # money already went out
    assert admin.post(f"{url}/payments", {"amount": "40"}).json["status"] == "paid"


# ---- #4 receipt restock once -------------------------------------------------------------------------------------
def test_receipt_restocks_a_part_only_once(app: Any, admin: Api) -> None:
    part = admin.post(f"{API}/parts", {"name": "Belt B50", "unit_cost": "10"}).json
    r = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "Belts", "total": "40.00"}}).json
    url = f"{API}/finance/receipts/{r['id']}/attach"
    assert admin.post(url, {"target": "part", "id": part["id"], "quantity": 4}).status_code == 200
    assert admin.post(url, {"target": "part", "id": part["id"], "quantity": 4}).status_code == 409
    assert Decimal(admin.get(f"{API}/parts/{part['id']}").json["on_hand"]) == 4


# ---- #5 credit notes ---------------------------------------------------------------------------------------------
def _sent_invoice(app: Any, admin: Api) -> dict[str, Any]:
    cust = customer(app, name=f"C {uuid.uuid4().hex[:6]}")
    wo = done_wo(admin, app, cust)
    ci = admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust, "work_order_ids": [wo["id"]]}).json
    sent = admin.post(f"{API}/finance/customer-invoices/{ci['id']}/send", {})
    assert sent.status_code == 200, sent.json
    return sent.json


def _credit(admin: Api, ci: dict[str, Any], amount: str) -> Any:
    return admin.post(
        f"{API}/finance/customer-invoices/{ci['id']}/credit-note",
        {
            "reason": "Goodwill",
            "lines": [{"kind": "cost", "description": "Credit", "quantity": 1, "unit_price": amount}],
        },
    )


def test_draft_credit_notes_count_against_the_invoice(app: Any, admin: Api) -> None:
    ci = _sent_invoice(app, admin)
    total = Decimal(ci["total"])
    first = _credit(admin, ci, str(total))
    assert first.status_code == 200, first.json
    assert _credit(admin, ci, "1").status_code == 422  # the draft already credits all of it


def test_credit_note_is_checked_again_when_sent(app: Any, admin: Api) -> None:
    ci = _sent_invoice(app, admin)
    half = (Decimal(ci["total"]) / 2).quantize(Decimal("0.01"))
    a = _credit(admin, ci, str(half)).json
    b = _credit(admin, ci, str(half)).json
    # a draft can't be edited past what's left to credit
    grown = admin.patch(
        f"{API}/finance/customer-invoices/{b['id']}",
        {"lines": [{"kind": "cost", "description": "Credit", "quantity": 1, "unit_price": ci["total"]}]},
    )
    assert grown.status_code == 422, grown.json
    # and if a draft ends up too large anyway (e.g. two people at once), sending it is refused
    with app.app_context():
        from mpro.extensions import db
        from mpro.finance.models import CustomerInvoice

        row = db.session.get(CustomerInvoice, uuid.UUID(b["id"]))
        assert row is not None
        row.total = Decimal(ci["total"])
        db.session.commit()
    assert admin.post(f"{API}/finance/customer-invoices/{b['id']}/send", {}).status_code == 422
    assert admin.get(f"{API}/finance/customer-invoices/{b['id']}").json["status"] == "draft"
    assert admin.post(f"{API}/finance/customer-invoices/{a['id']}/send", {}).status_code == 422  # b's draft counts
    with app.app_context():
        row = db.session.get(CustomerInvoice, uuid.UUID(b["id"]))
        assert row is not None
        row.total = half
        db.session.commit()
    assert admin.post(f"{API}/finance/customer-invoices/{a['id']}/send", {}).status_code == 200
    got = admin.get(f"{API}/finance/customer-invoices/{ci['id']}").json
    assert Decimal(got["balance"]) == Decimal(ci["total"]) - half


# ---- #6 a work order is billed once ------------------------------------------------------------------------------
def test_work_order_cannot_be_invoiced_twice(app: Any, admin: Api) -> None:
    cust = customer(app, name="Twice Ltd")
    wo = done_wo(admin, app, cust)
    body = {"customer_id": cust, "work_order_ids": [wo["id"]]}
    assert admin.post(f"{API}/finance/customer-invoices", body).status_code == 200
    assert admin.post(f"{API}/finance/customer-invoices", body).status_code == 409
    assert admin.post(
        f"{API}/finance/customer-invoices", {**body, "work_order_ids": [wo["id"], wo["id"]]}
    ).status_code in (409, 422)


# ---- #7 reimbursement request ------------------------------------------------------------------------------------
def test_reimbursement_request_only_from_new_or_rejected(app: Any, admin: Api) -> None:
    tech = login(app, TECH)
    r = multipart(tech, f"{API}/finance/receipts", [("fuel.png", PNG_1PX)]).json
    tech.patch(f"{API}/finance/receipts/{r['id']}", {"total": "12.00", "purchased_on": date.today().isoformat()})
    url = f"{API}/finance/receipts/{r['id']}/reimbursement"
    assert tech.post(url, {"action": "request"}).json["reimbursement_status"] == "requested"
    assert admin.post(url, {"action": "reject", "comment": "Blurry"}).json["reimbursement_status"] == "rejected"
    assert tech.post(url, {"action": "request"}).json["reimbursement_status"] == "requested"
    assert admin.post(url, {"action": "approve"}).json["reimbursement_status"] == "approved"
    # an approved (or paid) reimbursement can't be pulled back to "requested"
    assert tech.post(url, {"action": "request"}).status_code == 409
    admin.post(url, {"action": "paid"})
    assert tech.post(url, {"action": "request"}).status_code == 409
    assert admin.get(f"{API}/finance/receipts/{r['id']}").json["reimbursement_status"] == "paid"


# ---- #10 email-in ------------------------------------------------------------------------------------------------
def _inbox_on(admin: Api, host: str = "imap.example.com") -> Any:
    return admin.patch(
        f"{API}/finance/settings",
        {
            "inbox_enabled": True,
            "inbox_host": host,
            "inbox_user": "ap@example.com",
            "inbox_password": "imap-secret",
            "inbox_address": "ap@example.com",
        },
    )


def _with_auth(raw: bytes, results: str) -> bytes:
    return f"Authentication-Results: {results}\r\n".encode() + raw


def test_email_in_needs_the_secret_and_flags_unverified_senders(
    app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mpro.finance import inbox

    s = _inbox_on(admin).json
    receipts_at, invoices_at = s["receipts_address"], s["invoices_address"]
    assert receipts_at.startswith("ap+receipts-") and receipts_at.endswith("@example.com")
    assert "inbox_secret" not in s and "MPRO_ALLOW_PRIVATE_MAIL_HOSTS" in s["inbox_help"]
    assert admin.patch(f"{API}/finance/settings", {"inbox_secret": "guessable"}).json["receipts_address"] == receipts_at
    FakeImap.messages = {
        b"1": _mail("ap+receipts@example.com", "Admin <admin@example.com>"),  # no secret: skipped
        b"2": _mail("ap+receipts-wrong@example.com", "Admin <admin@example.com>"),
        b"3": _mail(invoices_at, "Admin <admin@example.com>"),  # right address, no DKIM → not verified
        b"4": _with_auth(
            _mail(invoices_at, "Admin <admin@example.com>"), "mx.example.com; spf=pass; dkim=pass header.d=example.com"
        ),
        # a DKIM pass for some other domain doesn't vouch for the From address
        b"5": _with_auth(
            _mail(invoices_at, "Admin <admin@example.com>"), "mx.example.com; dkim=pass header.d=evil.test"
        ),
    }
    FakeImap.seen = set()
    monkeypatch.setattr(inbox, "IMAP_FACTORY", FakeImap)
    got = admin.post(f"{API}/finance/settings/inbox-test")
    assert got.status_code == 200 and got.json["created"] == 3, got.json
    items = admin.get(f"{API}/finance/vendor-invoices?status=received,matched").json["items"]
    flags = sorted(i["sender_verified"] for i in items if i["source"] == "email")
    assert flags == [False, False, True]
    assert admin.get(f"{API}/finance/receipts").json["total"] == 0

    # a new secret: the old address stops working
    new = admin.post(f"{API}/finance/settings/inbox-secret").json
    assert new["invoices_address"] != invoices_at
    FakeImap.messages = {b"6": _mail(invoices_at, "Admin <admin@example.com>")}
    FakeImap.seen = set()
    assert admin.post(f"{API}/finance/settings/inbox-test").json["created"] == 0


def test_email_in_refuses_private_hosts_and_hides_server_errors(
    app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mpro.finance import inbox

    monkeypatch.delenv("MPRO_ALLOW_PRIVATE_MAIL_HOSTS", raising=False)
    for host in ("127.0.0.1", "localhost", "10.0.0.5", "169.254.169.254", "[::1]"):
        assert _inbox_on(admin, host).status_code == 422, host
    monkeypatch.setenv("MPRO_ALLOW_PRIVATE_MAIL_HOSTS", "1")
    assert _inbox_on(admin, "192.168.1.20").status_code == 200  # LAN mail server, allowed by the admin
    monkeypatch.delenv("MPRO_ALLOW_PRIVATE_MAIL_HOSTS")
    assert admin.post(f"{API}/finance/settings/inbox-test").status_code == 422  # checked again when connecting

    assert _inbox_on(admin, "imap.example.com").status_code == 200

    class Broken(FakeImap):
        def login(self, user: str, password: str) -> None:
            raise OSError("SSH-2.0-OpenSSH_9.6 internal banner")

    monkeypatch.setattr(inbox, "IMAP_FACTORY", Broken)
    got = admin.post(f"{API}/finance/settings/inbox-test")
    assert got.status_code == 502 and "OpenSSH" not in got.json["message"]


# ---- #11 customer invoice parts at the cost they were used at ----------------------------------------------------
def test_invoice_part_lines_use_the_cost_when_used(app: Any, admin: Api) -> None:
    cust = customer(app, name="Parts Co")
    p, wh = stocked(admin, "10")  # unit cost 2.50
    wo = admin.post(f"{API}/work-orders", {"title": "Swap belts"}).json
    r = admin.post(f"{API}/work-orders/{wo['id']}/parts", {"part_id": p["id"], "quantity": "4", "location_id": wh})
    assert r.status_code == 201, r.json
    assert admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"}).status_code == 200
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts.models import Part
        from mpro.workorders.models import WorkOrder

        w = db.session.get(WorkOrder, uuid.UUID(wo["id"]))
        part = db.session.get(Part, uuid.UUID(p["id"]))
        assert w is not None and part is not None and part.org_id == org_id(app)
        w.customer_id = uuid.UUID(cust)
        part.unit_cost = Decimal("99.00")  # the price went up after the job
        db.session.commit()
    ci = admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust, "work_order_ids": [wo["id"]]})
    assert ci.status_code == 200, ci.json
    line = next(ln for ln in ci.json["lines"] if ln["kind"] == "part")
    assert Decimal(line["unit_price"]) == Decimal("2.50") and Decimal(line["amount"]) == Decimal("10.00")


# ---- #12 certificate download header -----------------------------------------------------------------------------
def test_certificate_download_filename_is_sanitised(app: Any, admin: Api) -> None:
    c = cert(admin)
    bad = 'x"; filename=evil.html\r\nSet-Cookie: a=b.png'
    r = multipart(admin, f"{API}/finance/tax-certificates/{c['id']}/files", [("card.png", PNG_1PX)], field="file")
    assert r.status_code == 200, r.json
    fid = r.json["files"][0]["id"]
    with app.app_context():  # store the name exactly as given, whatever the upload layer did with it
        from mpro.core.files import FileObject
        from mpro.extensions import db

        f = db.session.get(FileObject, uuid.UUID(fid))
        assert f is not None
        f.name = bad
        db.session.commit()
    got = admin.get(f"{API}/finance/tax-certificates/{c['id']}/files/{fid}")
    assert got.status_code == 200
    disp = got.headers["Content-Disposition"]
    assert "\r" not in disp and "\n" not in disp and disp.count('"') == 2
    assert "Set-Cookie" not in got.headers
