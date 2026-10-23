"""Purchasing finance (0.5.0, MP-090–MP-094): tax certificates, receipts, cards, vendor invoices (3-way match),
customer invoices, the documents vault, email-in and finance settings. Cross-organization checks on every area."""

from __future__ import annotations

import io
import uuid
import zipfile
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_assets import PNG_1PX, other_org
from tests.test_work_orders import login, uid

API = "/api/v1"
TECH = "avery.kim@example.com"


# ---- helpers ---------------------------------------------------------------------------------------------------
def org_id(app: Any, email: str = "admin@example.com") -> uuid.UUID:
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.models import Membership

        u = db.session.scalars(select(User).where(User.email == email)).one()
        return db.session.scalars(select(Membership.org_id).where(Membership.user_id == u.id)).first()  # type: ignore[return-value]


def vendor(app: Any, name: str = "Northside Supply", region: str = "IL", email: str = "orders@northside.example") -> str:
    with app.app_context():
        from mpro.extensions import db
        from mpro.vendors.models import Vendor

        v = Vendor(org_id=org_id(app), name=name, email=email, address={"region": region, "country": "US"})
        db.session.add(v)
        db.session.commit()
        return str(v.id)


def customer(app: Any, name: str = "Riverside Apartments", region: str = "IL", **kw: Any) -> str:
    with app.app_context():
        from mpro.extensions import db
        from mpro.vendors.models import Customer

        c = Customer(org_id=org_id(app), name=name, billing_email="ap@riverside.example",
                     billing_address={"line1": "22 River Rd", "city": "Springfield", "region": region, "country": "US"},
                     **kw)
        db.session.add(c)
        db.session.commit()
        return str(c.id)


def multipart(api: Api, url: str, files: list[tuple[str, bytes]], field: str = "files", **form: Any) -> Any:
    data: dict[str, Any] = {k: v for k, v in form.items()}
    data[field] = [(io.BytesIO(b), n) for n, b in files]
    return api.c.post(url, data=data, headers=api._h(), content_type="multipart/form-data")


def emails(app: Any) -> list[Any]:
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        rows = db.session.scalars(select(OutboundEmail).order_by(OutboundEmail.created_at)).all()
        db.session.expunge_all()
        return list(rows)


def export_bytes(app: Any, export_id: str) -> bytes:
    with app.app_context():
        from mpro.core.files import Export, FileObject, read_bytes
        from mpro.extensions import db

        ex = db.session.get(Export, uuid.UUID(export_id))
        assert ex is not None and ex.status == "ready", (ex.status if ex else None, ex.error if ex else None)
        f = db.session.get(FileObject, ex.file_id)
        assert f is not None
        return read_bytes(f)


def cert(admin: Api, **kw: Any) -> dict[str, Any]:
    body = {"type": "resale", "country": "US", "region": "IL", "number": "2931-0457",
            "issued_on": (date.today() - timedelta(days=300)).isoformat(),
            "expires_on": (date.today() + timedelta(days=200)).isoformat(), **kw}
    r = admin.post(f"{API}/finance/tax-certificates", body)
    assert r.status_code == 200, r.json
    return r.json  # type: ignore[no-any-return]


def done_wo(admin: Api, app: Any, customer_id: str | None = None) -> dict[str, Any]:
    wo = admin.post(f"{API}/work-orders", {"title": "Rooftop unit service"}).json
    assert admin.post(f"{API}/work-orders/{wo['id']}/time", {"minutes": 90, "time_type": "Work",
                                                            "rate_cents": 4000}).status_code == 201
    assert admin.post(f"{API}/work-orders/{wo['id']}/costs", {"amount_cents": 2500, "cost_type": "Travel",
                                                             "description": "Trip charge"}).status_code == 201
    r = admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json
    if customer_id:
        with app.app_context():
            from mpro.extensions import db
            from mpro.workorders.models import WorkOrder

            w = db.session.get(WorkOrder, uuid.UUID(wo["id"]))
            assert w is not None
            w.customer_id = uuid.UUID(customer_id)
            db.session.commit()
    return wo  # type: ignore[no-any-return]


# ---- core: encrypted files -----------------------------------------------------------------------------------
def test_encrypted_file_round_trip(app: Any) -> None:
    with app.app_context():
        from mpro.core.files import read_bytes, save_file, storage
        from mpro.core.previews import render_preview
        from mpro.extensions import db

        f = save_file(org_id(app), "scan.png", PNG_1PX, None, encrypt=True)
        db.session.commit()
        stored = storage().get(f.storage_key)
        assert f.encrypted and stored != PNG_1PX and PNG_1PX not in stored
        assert read_bytes(f) == PNG_1PX
        assert f.thumb_key in (None, "")  # no thumbnails / previews of encrypted scans
        assert render_preview(f)["kind"] in ("none", "image")


# ---- server-side reading ---------------------------------------------------------------------------------------
def test_reader_parses_receipts_invoices_and_terms() -> None:
    from mpro.finance import reader

    r = reader.parse_receipt(
        "THE HOME DEPOT\n1234 Main St\n10/12/2026 2:31 PM\nV-BELT A42   2 @ 19.25   38.50\nSUBTOTAL 38.50\n"
        "SALES TAX 3.18\nTOTAL $41.68\nVISA XXXXXXXXXXXX4417\n"
    )
    assert r["vendor_name"].upper().startswith("THE HOME DEPOT")
    assert (r["subtotal"], r["tax"], r["total"], r["card_last4"]) == ("38.50", "3.18", "41.68", "4417")
    assert r["purchased_on"] == "2026-10-12"
    inv = reader.parse_invoice("GRAINGER\nInvoice No: 9981-22\nInvoice Date: Oct 1, 2026\nPO Number: PO-0042\n"
                               "Terms: 2/10 Net 30\nSubtotal 100.00\nTax 0.00\nTotal Due $100.00")
    assert inv["number"] == "9981-22" and inv["total"] == "100.00" and inv["invoice_date"] == "2026-10-01"
    assert reader.parse_terms("2/10 net 30") == {"discount_pct": "2", "discount_days": 10, "net_days": 30}
    assert {"pdf_text", "browser_ocr"} <= set(reader.READERS)


# ---- tax exemption certificates (MP-090) -----------------------------------------------------------------------
def test_certificate_scan_encrypted_access_log_and_card(app: Any, admin: Api) -> None:
    tech_id = uid(admin, TECH)
    c = cert(admin, card_user_ids=[tech_id])
    r = multipart(admin, f"{API}/finance/tax-certificates/{c['id']}/files", [("crt-61.png", PNG_1PX)], field="file")
    assert r.status_code == 200, r.json
    fid = r.json["files"][0]["id"]
    with app.app_context():
        from mpro.core.files import FileObject, storage
        from mpro.extensions import db

        f = db.session.get(FileObject, uuid.UUID(fid))
        assert f is not None and f.encrypted and storage().get(f.storage_key) != PNG_1PX
    got = admin.get(f"{API}/finance/tax-certificates/{c['id']}/files/{fid}")
    assert got.status_code == 200 and got.data == PNG_1PX
    log = admin.get(f"{API}/finance/tax-certificates/{c['id']}/access-log").json["items"]
    assert {e["action"] for e in log} >= {"download"}

    tech = login(app, TECH)
    assert tech.get(f"{API}/finance/tax-certificates/{c['id']}").status_code == 403
    assert tech.get(f"{API}/finance/tax-certificates/{c['id']}/files/{fid}").status_code == 403
    assert tech.get(f"{API}/files/{fid}").status_code in (403, 404)  # generic file route: managers only
    mine = tech.get(f"{API}/finance/tax-certificates").json["items"]
    assert [x["id"] for x in mine] == [c["id"]] and "files" not in mine[0]
    card = tech.get(f"{API}/finance/tax-certificates/{c['id']}/card")
    assert card.status_code == 200, card.json
    assert card.json["watermark"].startswith("For ") and card.json["watermark"].endswith("employees only")
    assert card.json["image"].startswith("data:image/png;base64,")
    sam = login(app, "sam.patel@example.com")
    assert sam.get(f"{API}/finance/tax-certificates/{c['id']}/card").status_code == 404
    assert sam.get(f"{API}/finance/tax-certificates").json["items"] == []
    assert "show_card" in {e["action"] for e in admin.get(f"{API}/finance/tax-certificates/{c['id']}/access-log").json["items"]}

    # validation
    assert admin.post(f"{API}/finance/tax-certificates", {"type": "nope"}).status_code == 422
    assert admin.post(f"{API}/finance/tax-certificates", {"multistate_form": "sst"}).status_code == 422
    assert admin.post(f"{API}/finance/tax-certificates", {"card_user_ids": [str(uuid.uuid4())]}).status_code in (404, 422)


def test_vendor_registry_send_and_exemption_lookup(app: Any, admin: Api) -> None:
    v = vendor(app)
    c = cert(admin)
    multipart(admin, f"{API}/finance/tax-certificates/{c['id']}/files", [("crt.png", PNG_1PX)], field="file")
    with app.app_context():
        from mpro.finance.certificates import exemption_for_po
        from mpro.purchasing.hooks import EXEMPTION_LOOKUPS

        assert exemption_for_po in EXEMPTION_LOOKUPS
        # not on file with the vendor yet → no exemption
        assert exemption_for_po(org_id(app), uuid.UUID(v), {"region": "IL", "country": "US"}, None) is None
    r = admin.post(f"{API}/finance/tax-certificates/{c['id']}/send", {"vendor_id": v, "message": "For our account"})
    assert r.status_code == 200, r.json
    assert r.json["status"] == "sent"
    sent = [e for e in emails(app) if e.to == "orders@northside.example"]
    assert sent and sent[-1].attachments and sent[-1].attachments[0]["name"] == "crt.png"
    with app.app_context():
        from mpro.finance.certificates import exemption_for_po

        hit = exemption_for_po(org_id(app), uuid.UUID(v), {"region": "Illinois", "country": "United States"}, None)
        assert hit is not None and str(hit.id) == c["id"]
        assert exemption_for_po(org_id(app), uuid.UUID(v), {"region": "WI", "country": "US"}, None) is None
    # renewal: registry copied, scan on the renewal re-sends automatically
    new = admin.post(f"{API}/finance/tax-certificates/{c['id']}/renew",
                     {"issued_on": date.today().isoformat(), "expires_on": (date.today() + timedelta(days=900)).isoformat()})
    assert new.status_code == 200, new.json
    before = len(emails(app))
    r = multipart(admin, f"{API}/finance/tax-certificates/{new.json['id']}/files", [("crt-2027.png", PNG_1PX)], field="file")
    assert r.json["resent"] == 1 and len(emails(app)) == before + 1
    old = admin.get(f"{API}/finance/tax-certificates/{c['id']}").json
    assert old["status"] == "retired" and old["renewed_by_id"] == new.json["id"]


def test_certificate_reminders_60_30_7(app: Any, admin: Api) -> None:
    c = cert(admin, expires_on=(date.today() + timedelta(days=59)).isoformat())
    with app.app_context():
        from mpro.finance import certificates

        assert certificates.reminders() >= 1
        assert certificates.reminders() == 0  # once per threshold
        assert certificates.reminders(date.today() + timedelta(days=30)) >= 1  # 29 days left → the 30-day one
        assert certificates.reminders(date.today() + timedelta(days=53)) >= 1  # 6 days left → the 7-day one
        assert certificates.reminders(date.today() + timedelta(days=54)) == 0
    subjects = [e.subject for e in emails(app) if "Tax certificate expires" in e.subject]
    assert len(subjects) >= 3 and c["number"] in " ".join(subjects)


def test_exempt_purchases_report_and_export(app: Any, admin: Api) -> None:
    v = vendor(app)
    c = cert(admin)
    admin.c.put(f"{API}/finance/tax-certificates/{c['id']}/vendors", json={"vendor_id": v, "status": "on_file"},
                headers=admin._h())
    r = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_id": v, "total": "10.80", "tax": "0.80",
                                                          "purchased_on": date.today().isoformat()}})
    assert r.status_code == 200, r.json
    rows = admin.get(f"{API}/finance/reports/exempt-purchases").json["items"]
    assert rows and rows[0]["certificate_id"] == c["id"] and rows[0]["tax_charged"] == "0.80"
    ex = admin.post(f"{API}/finance/exports", {"kind": "exempt_purchases"})
    assert ex.status_code == 200, ex.json
    assert b"2931-0457" in export_bytes(app, ex.json["id"])


# ---- receipts (MP-091) -----------------------------------------------------------------------------------------
def test_receipt_capture_reading_tax_flag_and_wo_cost(app: Any, admin: Api) -> None:
    v = vendor(app, name="Home Depot")
    c = cert(admin)
    admin.c.put(f"{API}/finance/tax-certificates/{c['id']}/vendors", json={"vendor_id": v, "status": "on_file"},
                headers=admin._h())
    wo = admin.post(f"{API}/work-orders", {"title": "Fix dock door"}).json
    tech = login(app, TECH)
    admin.patch(f"{API}/work-orders/{wo['id']}", {"assignees": [{"type": "user", "id": uid(admin, TECH)}],
                                                  "version": wo["version"]})
    ocr = "HOME DEPOT\n10/20/2026\nSUBTOTAL 38.50\nTAX 3.18\nTOTAL 41.68\nVISA ************4417"
    r = multipart(tech, f"{API}/finance/receipts", [("p1.png", PNG_1PX), ("p2.png", PNG_1PX)], source="camera",
                  ocr_text=ocr, work_order_id=wo["id"])
    assert r.status_code == 200, r.json
    rec = r.json
    assert rec["total"] == "41.68" and rec["tax"] == "3.18" and rec["vendor"]["id"] == v
    assert len(rec["pages"]) == 2 and rec["work_order_id"] == wo["id"]
    assert rec["tax_flagged"] and rec["tax_reclaim_status"] == "to_reclaim"
    reclaim = admin.get(f"{API}/finance/reports/tax-reclaim").json
    assert [x["id"] for x in reclaim["items"]] == [rec["id"]] and reclaim["tax_total"] == "3.18"

    sug = tech.get(f"{API}/finance/receipts/{rec['id']}/suggestions").json
    assert wo["id"] in [w["id"] for w in sug["work_orders"]]
    r = tech.post(f"{API}/finance/receipts/{rec['id']}/attach", {"target": "work_order", "id": wo["id"]})
    assert r.status_code == 200, r.json
    assert r.json["status"] == "matched"
    costs = admin.get(f"{API}/work-orders/{wo['id']}/costs").json["costs"]
    assert [(x["amount_cents"], len(x["receipts"])) for x in costs] == [(4168, 1)], costs
    section = tech.get(f"{API}/finance/work-orders/{wo['id']}/receipts").json["items"]
    assert [x["id"] for x in section] == [rec["id"]]

    # technicians see only their own receipts, and only Receipts in Finance
    me = tech.get(f"{API}/finance/me").json
    assert me["can"]["finance.receipts"] and not me["can"]["finance.view"]
    admin_r = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "Lowe's", "total": "5.00"}}).json
    assert [x["id"] for x in tech.get(f"{API}/finance/receipts").json["items"]] == [rec["id"]]
    assert tech.get(f"{API}/finance/receipts/{admin_r['id']}").status_code == 404
    for url in ("vendor-invoices", "customer-invoices", "cards", "documents", "settings", "summary"):
        assert tech.get(f"{API}/finance/{url}").status_code == 403, url
    req = login(app, "jamie.ortiz@example.com")  # requesters have no Finance at all
    assert req.get(f"{API}/finance/receipts").status_code == 403


def test_receipt_duplicates_reimbursement_and_export(app: Any, admin: Api) -> None:
    tech = login(app, TECH)
    a = multipart(tech, f"{API}/finance/receipts", [("r.png", PNG_1PX)]).json
    b = multipart(tech, f"{API}/finance/receipts", [("r-again.png", PNG_1PX)]).json
    assert b["status"] == "duplicate" and b["duplicate_of_id"] == a["id"]
    assert tech.post(f"{API}/finance/receipts/{b['id']}/attach", {"target": "expense", "category": "Fuel"}).status_code == 409
    assert tech.post(f"{API}/finance/receipts/{b['id']}/not-duplicate").json["status"] == "new"

    tech.patch(f"{API}/finance/receipts/{a['id']}", {"total": "42.10", "vendor_name": "Corner Gas",
                                                     "purchased_on": date.today().isoformat()})
    assert tech.post(f"{API}/finance/receipts/{a['id']}/reimbursement", {"action": "request"}).json[
        "reimbursement_status"] == "requested"
    assert tech.post(f"{API}/finance/receipts/{a['id']}/reimbursement", {"action": "approve"}).status_code == 403
    assert admin.post(f"{API}/finance/receipts/{a['id']}/reimbursement", {"action": "approve"}).json[
        "reimbursement_status"] == "approved"
    # approved receipts are read-only
    assert tech.patch(f"{API}/finance/receipts/{a['id']}", {"total": "1.00"}).status_code == 409
    assert tech.delete(f"{API}/finance/receipts/{a['id']}").status_code == 409
    ex = admin.post(f"{API}/finance/reimbursements/export")
    data = export_bytes(app, ex.json["id"]).decode("utf-8-sig")
    assert "Avery Kim" in data and "42.10" in data
    assert admin.get(f"{API}/finance/receipts/{a['id']}").json["reimbursement_status"] == "exported"
    assert admin.post(f"{API}/finance/receipts/{a['id']}/reimbursement", {"action": "paid"}).json[
        "reimbursement_status"] == "paid"


def test_receipt_attach_to_part_restock_and_po(app: Any, admin: Api) -> None:
    part = admin.post(f"{API}/parts", {"name": "V-belt A42", "unit_cost": "10"})
    assert part.status_code in (200, 201), part.json
    r = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "Belts R Us", "total": "40.00"}}).json
    got = admin.post(f"{API}/finance/receipts/{r['id']}/attach", {"target": "part", "id": part.json["id"], "quantity": 4})
    assert got.status_code == 200, got.json
    assert got.json["part_id"] == part.json["id"]
    assert admin.post(f"{API}/finance/receipts/{r['id']}/attach", {"target": "nope"}).status_code == 422
    assert admin.post(f"{API}/finance/receipts/{r['id']}/attach",
                      {"target": "purchase_order", "id": str(uuid.uuid4())}).status_code == 404


def test_cards_statement_reconcile_and_chase(app: Any, admin: Api) -> None:
    card = admin.post(f"{API}/finance/cards", {"name": "Maintenance Amex", "last4": "1005",
                                               "holder_user_id": uid(admin, TECH)})
    assert card.status_code == 200, card.json
    cid = card.json["id"]
    assert admin.post(f"{API}/finance/cards", {"name": "x", "last4": "12"}).status_code == 422
    rec = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "Grainger", "total": "112.40",
                                                            "card_last4": "1005", "purchased_on": "2026-10-02"}}).json
    csv_data = ("Date,Description,Amount\n10/03/2026,GRAINGER 0441,-112.40\n10/05/2026,=cmd|' /C calc'!A0,15.00\n"
                "bad,row,\n").encode()
    r = multipart(admin, f"{API}/finance/cards/{cid}/statement", [("stmt.csv", csv_data)], field="file")
    assert r.status_code == 200, r.json
    assert (r.json["added"], r.json["matched"]) == (2, 1)
    again = multipart(admin, f"{API}/finance/cards/{cid}/statement", [("stmt.csv", csv_data)], field="file").json
    assert again["added"] == 0  # the same statement twice doesn't double up
    txns = admin.get(f"{API}/finance/cards/{cid}/transactions").json["items"]
    assert {t["status"] for t in txns} == {"matched", "unmatched"}
    assert next(t for t in txns if t["status"] == "matched")["receipt_id"] == rec["id"]
    assert admin.post(f"{API}/finance/cards/{cid}/chase").json["chased"] == 1
    assert any(e.to == TECH and "Receipts needed" in e.subject for e in emails(app))


# ---- vendor invoices (MP-092) -----------------------------------------------------------------------------------
def make_po(admin: Api, app: Any, v: str) -> dict[str, Any]:
    po = admin.post(f"{API}/purchase-orders", {"vendor_id": v, "title": "Belts", "lines": [
        {"description": "V-belt A42", "part_number": "A42", "quantity": 10, "unit_cost": "19.25"},
        {"description": "Bearing 6205", "part_number": "6205-2RS", "quantity": 4, "unit_cost": "8.00"}]})
    assert po.status_code == 201, po.json
    po = po.json
    if po["status"] != "approved":
        admin.post(f"{API}/purchase-orders/{po['id']}/approve", {})
    rec = admin.post(f"{API}/purchase-orders/{po['id']}/receive", {"lines": [
        {"line_id": po["lines"][0]["id"], "quantity": 10}, {"line_id": po["lines"][1]["id"], "quantity": 2}]})
    assert rec.status_code in (200, 201), rec.json
    return admin.get(f"{API}/purchase-orders/{po['id']}").json  # type: ignore[no-any-return]


def test_vendor_invoice_three_way_match_approval_and_payment(app: Any, admin: Api) -> None:
    v = vendor(app)
    po = make_po(admin, app, v)
    body = {"vendor_id": v, "number": "INV-1001", "invoice_date": date.today().isoformat(), "terms": "2/10 net 30",
            "purchase_order_ids": [po["id"]],
            "lines": [{"description": "V-belt A42", "part_number": "A42", "quantity": 10, "unit_price": "19.50"},
                      {"description": "Bearing 6205", "part_number": "6205-2RS", "quantity": 4, "unit_price": "8.00"}]}
    inv = admin.post(f"{API}/finance/vendor-invoices", body)
    assert inv.status_code == 200, inv.json
    inv = inv.json
    kinds = sorted(e["kind"] for e in inv["exceptions"])
    assert kinds == ["quantity"], inv["exceptions"]  # 19.50 is within the 2% price tolerance; 4 billed, 2 received
    assert inv["status"] == "received" and Decimal(inv["discount_pct"]) == 2
    assert inv["due_date"] == (date.today() + timedelta(days=30)).isoformat()
    queue = admin.get(f"{API}/finance/vendor-invoices?status=exceptions").json
    assert [i["id"] for i in queue["items"]] == [inv["id"]] and queue["total"] == 1
    # tighter tolerance → price exception too
    admin.patch(f"{API}/finance/settings", {"price_tolerance_pct": "1"})
    inv = admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/match").json
    assert sorted(e["kind"] for e in inv["exceptions"]) == ["price", "quantity"]
    admin.patch(f"{API}/finance/settings", {"price_tolerance_pct": "2"})

    jordan = login(app, "jordan.reyes@example.com")  # limited admin: records invoices, can't override exceptions
    assert jordan.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {"override": True}).status_code == 409
    # receiving the rest clears the quantity exception
    admin.post(f"{API}/purchase-orders/{po['id']}/receive", {"lines": [{"line_id": po["lines"][1]["id"], "quantity": 2}]})
    inv = admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/match").json
    assert inv["exceptions"] == [] and inv["status"] == "matched"
    dup = admin.post(f"{API}/finance/vendor-invoices", {**body, "lines": []}).json
    assert "duplicate" in {e["kind"] for e in dup["exceptions"]}

    got = admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {})
    assert got.status_code == 200, got.json
    assert got.json["status"] == "approved"
    assert admin.patch(f"{API}/finance/vendor-invoices/{inv['id']}", {"number": "X"}).status_code == 409  # read-only
    assert admin.delete(f"{API}/finance/vendor-invoices/{inv['id']}").status_code == 409
    paid = admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/payments",
                      {"amount": got.json["total"], "method": "ach", "paid_on": date.today().isoformat()})
    assert paid.status_code == 200, paid.json
    assert paid.json["status"] == "paid"
    spend = admin.get(f"{API}/finance/reports/vendor-spend").json["items"]
    assert spend[0]["vendor"]["id"] == v and Decimal(spend[0]["spend"]) == Decimal(got.json["total"])
    assert spend[0]["paid_on_time_pct"] == 100


def test_vendor_invoice_approval_rule_dispute_and_void(app: Any, admin: Api) -> None:
    v = vendor(app)
    jordan_id = uid(admin, "jordan.reyes@example.com")
    rule = admin.post(f"{API}/approval-rules", {"name": "Invoices over 50", "applies_to": "vendor_invoice",
                                                 "conditions": [{"field": "total", "op": ">", "value": "50"}],
                                                 "approver_user_ids": [jordan_id]})
    assert rule.status_code in (200, 201), rule.json
    inv = admin.post(f"{API}/finance/vendor-invoices", {"vendor_id": v, "number": "A-1", "lines": [
        {"description": "Service call", "quantity": 1, "unit_price": "120"}]}).json
    assert {e["kind"] for e in inv["exceptions"]} == {"no_po"}
    assert admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {}).status_code == 409
    got = admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {"override": True}).json
    assert got["status"] == "received"  # waiting for Jordan
    sam = login(app, "sam.patel@example.com")
    assert sam.post(f"{API}/finance/vendor-invoices/{inv['id']}/decide", {"approve": True}).status_code == 403
    jordan = login(app, "jordan.reyes@example.com")
    d = jordan.post(f"{API}/finance/vendor-invoices/{inv['id']}/decide", {"approve": False, "comment": "Wrong rate"})
    assert d.status_code == 200, d.json
    assert d.json["status"] == "disputed"
    assert admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/status", {"action": "reopen"}).json["status"] == "received"
    assert admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/status", {"action": "dispute"}).status_code == 422
    assert admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/status", {"action": "void"}).json["status"] == "void"


def test_vendor_invoice_reminders(app: Any, admin: Api) -> None:
    v = vendor(app)
    inv = admin.post(f"{API}/finance/vendor-invoices", {"vendor_id": v, "number": "R-1", "terms": "2/10 net 30",
                                                         "invoice_date": date.today().isoformat(), "lines": [
                                                             {"description": "x", "quantity": 1, "unit_price": "5"}]}).json
    admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {"override": True})
    with app.app_context():
        from mpro.finance import invoices

        assert invoices.reminders(date.today() + timedelta(days=8)) >= 1  # discount deadline in 2 days
        assert invoices.reminders(date.today() + timedelta(days=27)) >= 1  # due in 3 days
    assert any("discount" in e.subject for e in emails(app))


# ---- customer invoices (MP-093) ---------------------------------------------------------------------------------
def test_customer_invoice_from_work_orders_send_pay_credit(app: Any, admin: Api) -> None:
    cust = customer(app, labor_rate=Decimal("95"), parts_markup_pct=Decimal("20"))
    admin.patch(f"{API}/finance/settings", {"tax_rates": {"US-IL": "6.25"}, "invoice_prefix": "RS-"})
    wo = done_wo(admin, app, cust)
    open_wo = admin.post(f"{API}/work-orders", {"title": "Not done"}).json
    assert admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust,
                                                           "work_order_ids": [open_wo["id"]]}).status_code == 422
    billable = admin.get(f"{API}/finance/billable-work-orders?customer_id={cust}").json["items"]
    assert [w["id"] for w in billable] == [wo["id"]]
    r = admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust, "work_order_ids": [wo["id"]],
                                                        "lines": [{"kind": "part", "description": "Filter",
                                                                   "quantity": 2, "unit_price": "10"}]})
    assert r.status_code == 200, r.json
    ci = r.json
    labor = next(ln for ln in ci["lines"] if ln["kind"] == "labor")
    assert (Decimal(labor["quantity"]), Decimal(labor["unit_price"]), labor["amount"]) == (Decimal("1.5"), 95, "142.50")
    assert not labor["taxable"]
    # 142.50 labour + 25.00 trip + 20.00 filter; tax 6.25% of 45.00 = 2.81
    assert (ci["subtotal"], ci["tax"], ci["total"]) == ("187.50", "2.81", "190.31")
    assert ci["label"].startswith("RS-") and ci["status"] == "draft"
    assert admin.get(f"{API}/finance/billable-work-orders?customer_id={cust}").json["items"] == []

    pdf = admin.get(f"{API}/finance/customer-invoices/{ci['id']}/pdf")
    assert pdf.status_code == 200 and pdf.data.startswith(b"%PDF")
    sent = admin.post(f"{API}/finance/customer-invoices/{ci['id']}/send", {"message": "Thanks!"})
    assert sent.status_code == 200, sent.json
    assert sent.json["status"] == "sent" and sent.json["due_date"] and sent.json["payment_link_url"] == ""
    mail = [e for e in emails(app) if e.to == "ap@riverside.example"][-1]
    assert mail.attachments[0]["name"].endswith(".pdf") and "Thanks!" in mail.body
    assert admin.patch(f"{API}/finance/customer-invoices/{ci['id']}", {"notes": "x"}).status_code == 409
    assert admin.delete(f"{API}/finance/customer-invoices/{ci['id']}").status_code == 409

    p = admin.post(f"{API}/finance/customer-invoices/{ci['id']}/payments", {"amount": "100", "method": "check"})
    assert p.json["status"] == "partially_paid" and p.json["balance"] == "90.31"
    assert admin.post(f"{API}/finance/customer-invoices/{ci['id']}/void").status_code == 409
    cn = admin.post(f"{API}/finance/customer-invoices/{ci['id']}/credit-note", {
        "reason": "Trip charge waived", "lines": [{"kind": "cost", "description": "Trip charge", "quantity": 1,
                                                   "unit_price": "25", "taxable": True}]})
    assert cn.status_code == 200, cn.json
    assert cn.json["kind"] == "credit_note" and cn.json["total"] == "26.56"
    admin.post(f"{API}/finance/customer-invoices/{cn.json['id']}/send", {})
    got = admin.get(f"{API}/finance/customer-invoices/{ci['id']}").json
    assert got["balance"] == "63.75" and got["credit_notes"][0]["id"] == cn.json["id"]
    st = admin.get(f"{API}/finance/customers/{cust}/statement").json
    assert st["balance"] == "63.75" and [e["kind"] for e in st["entries"]].count("payment") == 1
    assert admin.get(f"{API}/finance/customers/{cust}/statement?format=csv").data.startswith(b"\xef\xbb\xbfDate")
    paid = admin.post(f"{API}/finance/customer-invoices/{ci['id']}/payments", {"amount": "63.75"}).json
    assert paid["status"] == "paid" and paid["balance"] == "0.00"


def test_customer_invoice_exempt_overdue_and_ageing(app: Any, admin: Api) -> None:
    cust = customer(app, name="County Schools")
    admin.patch(f"{API}/finance/settings", {"default_tax_rate_pct": "7", "reminder_days_after_due": [7, 30]})
    c = cert(admin, type="government", customer_id=cust)
    ci = admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust, "lines": [
        {"kind": "part", "description": "Ballast", "quantity": 1, "unit_price": "80"}]}).json
    assert ci["tax_exempt"] and ci["tax"] == "0.00" and ci["total"] == "80.00"
    assert admin.patch(f"{API}/finance/customer-invoices/{ci['id']}", {"tax_rate_pct": "7"}).status_code == 409
    pdf = admin.get(f"{API}/finance/customer-invoices/{ci['id']}/pdf").data
    assert pdf.startswith(b"%PDF")
    admin.patch(f"{API}/finance/customer-invoices/{ci['id']}", {"due_date": (date.today() - timedelta(days=40)).isoformat(),
                                                                "issue_date": (date.today() - timedelta(days=70)).isoformat()})
    admin.post(f"{API}/finance/customer-invoices/{ci['id']}/send", {})
    with app.app_context():
        from mpro.finance import billing

        assert billing.mark_overdue_and_remind() == 1  # one email covering the 7- and 30-day steps
        assert billing.mark_overdue_and_remind() == 0
    assert admin.get(f"{API}/finance/customer-invoices/{ci['id']}").json["status"] == "overdue"
    ageing = admin.get(f"{API}/finance/reports/ageing").json["items"]
    assert ageing[0]["d31_60"] == "80.00" and ageing[0]["total"] == "80.00"
    ex = admin.post(f"{API}/finance/exports", {"kind": "ageing"})
    assert b"County Schools" in export_bytes(app, ex.json["id"])
    assert c["customer_id"] == cust


def test_payment_links_are_cloud_only(app: Any, admin: Api) -> None:
    pl = admin.get(f"{API}/finance/settings").json["payment_links"]
    assert pl["available"] is False and "Cloud" in pl["reason"]
    with app.app_context():
        from mpro.cloud import payments

        app.config["MPRO_EDITION"] = "cloud"
        try:
            st = payments.status(type("O", (), {"plan": "expert"})())
            assert st["available"] is False and "Stripe" in st["reason"]  # no provider registered: no live calls
            assert payments.status(type("O", (), {"plan": "free"})())["available"] is False
        finally:
            app.config["MPRO_EDITION"] = None


# ---- documents vault and accountant export (MP-094) ---------------------------------------------------------
def test_vault_search_hold_retention_and_accounting_export(app: Any, admin: Api) -> None:
    v = vendor(app)
    inv = admin.post(f"{API}/finance/vendor-invoices", {"vendor_id": v, "number": "V-77",
                                                         "invoice_date": date.today().isoformat(),
                                                         "lines": [{"description": "Gasket", "quantity": 2,
                                                                    "unit_price": "12.5"}]}).json
    admin.post(f"{API}/finance/vendor-invoices/{inv['id']}/submit", {"override": True})
    rec = multipart(admin, f"{API}/finance/receipts", [("r.png", PNG_1PX)],
                    fields='{"vendor_name": "=HYPERLINK(1)", "total": "9.99", "purchased_on": "%s"}' % date.today()).json
    admin.post(f"{API}/finance/receipts/{rec['id']}/attach", {"target": "expense", "category": "Supplies"})
    docs = admin.get(f"{API}/finance/documents?q=V-77").json["items"]
    assert len(docs) == 1 and docs[0]["kind"] == "vendor_invoice" and docs[0]["locked"]
    retain = date.fromisoformat(docs[0]["retain_until"])
    assert retain.year - date.today().year == 7
    doc = next(d for d in admin.get(f"{API}/finance/documents?kind=receipt").json["items"] if d["record_id"] == rec["id"])
    assert admin.post(f"{API}/finance/documents/{doc['id']}/hold", {"hold": True}).json["legal_hold"]
    assert admin.delete(f"{API}/finance/receipts/{rec['id']}").status_code == 409
    jordan = login(app, "jordan.reyes@example.com")
    assert jordan.post(f"{API}/finance/documents/{doc['id']}/hold", {"hold": False}).status_code == 403
    admin.post(f"{API}/finance/documents/{doc['id']}/hold", {"hold": False})
    month = date.today().strftime("%Y-%m")
    assert admin.post(f"{API}/finance/exports", {"kind": "accounting", "month": "13/2026"}).status_code == 422
    z = admin.post(f"{API}/finance/exports", {"kind": "accounting", "month": month, "format": "zip"})
    assert z.status_code == 200, z.json
    with zipfile.ZipFile(io.BytesIO(export_bytes(app, z.json["id"]))) as zf:
        names = zf.namelist()
        assert any(n.endswith(".csv") for n in names) and any(n.lower().endswith(".png") for n in names)
        expenses = next(zf.read(n) for n in names if "expense" in n).decode("utf-8-sig")
        assert "'=HYPERLINK(1)" in expenses  # no spreadsheet formulas from receipts
    for fmt, needle in (("qbo", b"Bill No"), ("xero", b"ContactName"), ("netsuite", b"External ID"), ("sage", b"")):
        ex = admin.post(f"{API}/finance/exports", {"kind": "accounting", "month": month, "format": fmt})
        assert ex.status_code == 200, (fmt, ex.json)
        data = export_bytes(app, ex.json["id"])
        assert data and needle in data, fmt
    tech = login(app, TECH)
    assert tech.post(f"{API}/finance/exports", {"kind": "accounting", "month": month}).status_code == 403


# ---- email-in (IMAP) ---------------------------------------------------------------------------------------------
class FakeImap:
    messages: dict[bytes, bytes] = {}
    seen: set[bytes] = set()

    def __init__(self, host: str, port: int) -> None:
        self.host = host

    def login(self, user: str, password: str) -> None:
        assert (user, password) == ("ap@example.com", "imap-secret")

    def select(self, folder: str) -> None:
        pass

    def search(self, charset: Any, criteria: str) -> tuple[str, list[bytes]]:
        return "OK", [b" ".join(k for k in self.messages if k not in self.seen)]

    def fetch(self, mid: bytes, what: str) -> tuple[str, list[Any]]:
        return "OK", [(b"1 (RFC822)", self.messages[mid])]

    def store(self, mid: bytes, op: str, flag: str) -> None:
        self.seen.add(mid)

    def logout(self) -> None:
        pass


def _mail(to: str, sender: str, name: str = "receipt.pdf") -> bytes:
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, to, "Receipt"
    msg.set_content("see attached")
    pdf = (b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF")
    msg.add_attachment(pdf if name.endswith(".pdf") else PNG_1PX, maintype="application" if name.endswith(".pdf")
                       else "image", subtype="pdf" if name.endswith(".pdf") else "png", filename=name)
    return msg.as_bytes()


def test_email_in_routes_plus_tags_and_checks_senders(app: Any, admin: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpro.finance import inbox

    r = admin.patch(f"{API}/finance/settings", {"inbox_enabled": True, "inbox_host": "imap.example.com",
                                                "inbox_user": "ap@example.com", "inbox_password": "imap-secret",
                                                "inbox_address": "ap@example.com"})
    assert r.status_code == 200, r.json
    assert r.json["inbox_password"] != "imap-secret" and r.json["inbox_password_set"]
    assert r.json["receipts_address"] == "ap+receipts@example.com"
    FakeImap.messages = {
        b"1": _mail("ap+receipts@example.com", f"Avery <{TECH}>", "fuel.png"),
        b"2": _mail("ap+invoices@example.com", "Admin <admin@example.com>"),
        b"3": _mail("ap+receipts@example.com", "stranger@evil.example"),
        b"4": _mail("ap+invoices@example.com", f"Avery <{TECH}>"),  # technicians can't send invoices
        b"5": _mail("ap@example.com", "admin@example.com"),  # no plus-tag
    }
    FakeImap.seen = set()
    monkeypatch.setattr(inbox, "IMAP_FACTORY", FakeImap)
    got = admin.post(f"{API}/finance/settings/inbox-test")
    assert got.status_code == 200, got.json
    assert got.json["created"] == 2 and FakeImap.seen == {b"1", b"2", b"3", b"4", b"5"}
    tech = login(app, TECH)
    mine = tech.get(f"{API}/finance/receipts").json["items"]
    assert len(mine) == 1 and mine[0]["source"] == "email"
    assert admin.get(f"{API}/finance/vendor-invoices").json["total"] == 1
    assert admin.post(f"{API}/finance/settings/inbox-test").json["created"] == 0  # read once
    assert login(app, "jordan.reyes@example.com").patch(f"{API}/finance/settings", {"retention_years": 3}).status_code == 403
    assert admin.patch(f"{API}/finance/settings", {"retention_years": 0}).status_code == 422


# ---- other organizations ------------------------------------------------------------------------------------------
def test_cross_org_isolation(app: Any, admin: Api) -> None:
    v = vendor(app)
    cust = customer(app)
    c = cert(admin)
    rec = admin.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "A", "total": "1.00"}}).json
    inv = admin.post(f"{API}/finance/vendor-invoices", {"vendor_id": v, "number": "Z"}).json
    ci = admin.post(f"{API}/finance/customer-invoices", {"customer_id": cust, "lines": [
        {"description": "x", "quantity": 1, "unit_price": "1"}]}).json
    card = admin.post(f"{API}/finance/cards", {"name": "Card", "last4": "1111"}).json
    doc = admin.get(f"{API}/finance/documents").json["items"][0]
    wo = admin.post(f"{API}/work-orders", {"title": "x"}).json

    other = other_org(app)
    for url in (f"finance/receipts/{rec['id']}", f"finance/vendor-invoices/{inv['id']}",
                f"finance/customer-invoices/{ci['id']}", f"finance/customer-invoices/{ci['id']}/pdf",
                f"finance/tax-certificates/{c['id']}", f"finance/tax-certificates/{c['id']}/card",
                f"finance/cards/{card['id']}/transactions", f"finance/customers/{cust}/statement",
                f"finance/work-orders/{wo['id']}/receipts", f"finance/billable-work-orders?customer_id={cust}"):
        assert other.get(f"{API}/{url}").status_code == 404, url
    for url, body in ((f"finance/receipts/{rec['id']}/attach", {"target": "expense", "category": "x"}),
                      (f"finance/vendor-invoices/{inv['id']}/submit", {}),
                      (f"finance/customer-invoices/{ci['id']}/send", {}),
                      (f"finance/tax-certificates/{c['id']}/send", {"vendor_id": v}),
                      (f"finance/documents/{doc['id']}/hold", {"hold": True}),
                      (f"finance/cards/{card['id']}/chase", {})):
        assert other.post(f"{API}/{url}", body).status_code == 404, url
    for kind, coll in (("receipts", "items"), ("vendor-invoices", "items"), ("customer-invoices", "items"),
                       ("tax-certificates", "items"), ("documents", "items")):
        assert other.get(f"{API}/finance/{kind}").json[coll] == [], kind
    # ids from another organization in request bodies are refused
    mine = other.post(f"{API}/finance/receipts", {"fields": {"vendor_name": "B", "total": "2.00"}}).json
    assert other.patch(f"{API}/finance/receipts/{mine['id']}", {"vendor_id": v}).status_code == 404
    assert other.patch(f"{API}/finance/receipts/{mine['id']}", {"card_id": card["id"]}).status_code == 404
    assert other.post(f"{API}/finance/receipts/{mine['id']}/attach",
                      {"target": "work_order", "id": wo["id"]}).status_code == 404
    assert other.post(f"{API}/finance/vendor-invoices", {"vendor_id": v}).status_code == 404
    assert other.post(f"{API}/finance/customer-invoices", {"customer_id": cust}).status_code == 404
    assert other.post(f"{API}/finance/tax-certificates", {"customer_id": cust}).status_code == 404
    assert other.post(f"{API}/finance/receipts", {"work_order_id": wo["id"], "fields": {"total": "1"}}).status_code == 404
