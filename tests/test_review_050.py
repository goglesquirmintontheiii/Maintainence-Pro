# ruff: noqa: E501, F811  (long API calls read better on one line; `net` is a fixture imported from test_suppliers)
"""Fixes from the independent 0.5.0 review: purchasing approvals and receiving, PunchOut, SSRF (DNS rebinding),
races on POs / stock / cycle counts, work-order part cost, client IPs, public links, quotes, part deletion, jobs."""

from __future__ import annotations

import http.server
import os
import socket
import ssl
import threading
import uuid
from decimal import Decimal
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_assets import other_org
from tests.test_parts import stocked
from tests.test_purchasing import part_row, po
from tests.test_suppliers import CXML_SETUP_RESPONSE, PAGE_JSONLD, FakeNet, _order_message, link, make_part, net  # noqa: F401
from tests.test_vendors import customer, last_email, quote
from tests.test_work_orders import create as create_wo
from tests.test_work_orders import login, uid

API = "/api/v1"
PG = pytest.mark.skipif(
    not (os.environ.get("TEST_DATABASE_URL") or "").startswith("postgresql"),
    reason="needs PostgreSQL for real concurrency",
)


def _ctx(email: str = "admin@example.com") -> tuple[Any, Any]:
    """(org, membership) for a user, inside an app context."""
    from sqlalchemy import select

    from mpro.auth.models import User
    from mpro.extensions import db
    from mpro.orgs.models import Membership, Organization

    u = db.session.scalars(select(User).where(User.email == email)).one()
    m = db.session.scalars(select(Membership).where(Membership.user_id == u.id)).first()
    assert m is not None
    return db.session.get(Organization, m.org_id), m


def _run_threads(n: int, fn: Any) -> list[BaseException]:
    errors: list[BaseException] = []
    barrier = threading.Barrier(n)

    def worker(i: int) -> None:
        try:
            barrier.wait()
            fn(i)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return errors


# ---- 2: approved POs whose total goes up -----------------------------------------------------------
def test_raising_a_partially_received_po_needs_approval_again_and_keeps_receipts(app: Any, admin: Api) -> None:
    r = admin.post(
        f"{API}/approval-rules",
        {
            "name": "Big orders",
            "conditions": [{"field": "total", "op": ">=", "value": "500"}],
            "approver_user_ids": [uid(admin, "admin@example.com")],
        },
    )
    assert r.status_code == 201, r.json
    p, wh = stocked(admin, "0")
    d = po(admin, lines=[{"part_id": p["id"], "quantity": "10", "unit_cost": "3", "location_id": wh}])
    assert d["status"] == "approved"
    line = d["lines"][0]["id"]
    got = admin.post(f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": line, "quantity": "4"}]})
    assert got.json["status"] == "partially_fulfilled"
    # the total goes from 30 to 600: the rules run again even though items were received
    up = admin.patch(
        f"{API}/purchase-orders/{d['id']}",
        {"lines": [{"id": line, "part_id": p["id"], "quantity": "200", "unit_cost": "3", "location_id": wh}]},
    )
    assert up.status_code == 200, up.json
    assert up.json["status"] == "pending" and up.json["lines"][0]["received"] == "4"
    assert any(a["status"] == "pending" for a in up.json["approvals"])
    # can't receive or send it until approved
    assert (
        admin.post(
            f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": line, "quantity": "1"}]}
        ).status_code
        == 409
    )
    assert admin.post(f"{API}/purchase-orders/{d['id']}/send", {"to": ["v@example.com"]}).status_code == 409
    # approving puts it back to what was received
    ok = admin.post(f"{API}/purchase-orders/{d['id']}/approve", {"comment": "Fine"})
    assert ok.status_code == 200, ok.json
    assert ok.json["status"] == "partially_fulfilled" and ok.json["lines"][0]["received"] == "4"
    assert part_row(app, p["id"])[0] == Decimal("4")
    assert (
        admin.post(
            f"{API}/purchase-orders/{d['id']}/receive", {"lines": [{"line_id": line, "quantity": "1"}]}
        ).status_code
        == 200
    )


def test_requesters_cant_set_costs_budget_or_number_on_create(app: Any, admin: Api) -> None:
    tech = login(app, "avery.kim@example.com")
    body = {"title": "Gloves", "lines": [{"description": "Gloves", "quantity": "1", "unit_cost": "5"}]}
    for extra in (
        {"costs": [{"label": "Rush", "kind": "fixed", "value": "500"}]},
        {"custom_number": "VIP-1"},
        {"budget_id": admin.post(f"{API}/budgets", {"name": "B", "amount": "100", "period": "month"}).json["id"]},
    ):
        assert tech.post(f"{API}/purchase-orders", {**body, **extra}).status_code == 403
    assert tech.post(f"{API}/purchase-orders", body).json["status"] == "requested"


# ---- 3: PunchOut -----------------------------------------------------------------------------------
def _punchout(admin: Api, app: Any, net: FakeNet, monkeypatch: Any) -> str:
    from mpro.suppliers import services as svc

    pid = make_part(app)
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    link(admin, pid, "https://www.grainger.com/product/1A120", supplier_sku="1A120")
    c = admin.post(
        f"{API}/supplier-connections",
        {
            "connector": "punchout_cxml",
            "supplier_key": "grainger",
            "name": "Grainger PunchOut",
            "settings": {
                "setup_url": "https://punchout.grainger.example/setup",
                "from_identity": "A",
                "to_identity": "G",
            },
            "secrets": {"shared_secret": "s3cret"},
        },
    ).json
    sent: list[bytes] = []
    monkeypatch.setattr(svc, "_post_xml", lambda url, doc: sent.append(doc) or CXML_SETUP_RESPONSE)
    assert admin.post(f"{API}/punchout/start", {"connection_id": c["id"]}).status_code == 200
    return sent[0].decode().split("<BuyerCookie>")[1].split("</BuyerCookie>")[0]


def test_punchout_cart_is_a_request_that_runs_the_rules(app: Any, admin: Api, net: FakeNet, monkeypatch: Any) -> None:
    cookie = _punchout(admin, app, net, monkeypatch)
    # the supplier's page posts back in a browser where a staff member happens to be signed in
    r = admin.c.post(f"{API}/punchout/return/{cookie}", data={"cxml-urlencoded": _order_message(cookie)})
    assert r.status_code == 303 and r.headers["Location"].startswith("/purchase-orders/")
    pid = r.headers["Location"].rsplit("/", 1)[1]
    d = admin.get(f"{API}/purchase-orders/{pid}").json
    assert d["status"] == "requested" and d["source"] == "punchout"
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent as AuditEvent
        from mpro.extensions import db

        ev = db.session.scalars(
            select(AuditEvent).where(AuditEvent.type == "purchase_order.created", AuditEvent.entity_id == pid)
        ).one()
        org, _m = _ctx()
        assert ev.org_id == org.id and ev.actor_id is None  # explicit org; the signed-in browser isn't the actor
    # a manager's review runs the approval rules
    assert admin.post(f"{API}/purchase-orders/{pid}/approve", {}).json["status"] == "approved"
    # a replayed post can't make a second PO
    again = admin.c.post(f"{API}/punchout/return/{cookie}", data={"cxml-urlencoded": _order_message(cookie)})
    assert "punchout_error" in again.headers["Location"]
    assert len([x for x in admin.get(f"{API}/purchase-orders").json["items"] if x.get("source") == "punchout"]) == 1


@PG
def test_concurrent_punchout_replays_make_one_po(app: Any, admin: Api, net: FakeNet, monkeypatch: Any) -> None:
    cookie = _punchout(admin, app, net, monkeypatch)
    form = {"cxml-urlencoded": _order_message(cookie)}

    def go(_i: int) -> None:
        from mpro.extensions import db
        from mpro.orgs.services import RuleError
        from mpro.suppliers import services as svc

        with app.app_context():
            try:
                svc.punchout_return(cookie, form)
                db.session.commit()
            except RuleError:
                db.session.rollback()

    assert not _run_threads(4, go)
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.extensions import db
        from mpro.purchasing.models import PurchaseOrder

        assert (
            db.session.scalar(select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.source == "punchout"))
            == 1
        )


# ---- 8: SSRF / DNS rebinding -----------------------------------------------------------------------
def test_fetch_dials_the_address_it_checked(monkeypatch: Any) -> None:
    from mpro.suppliers import fetch

    answers: list[list[str]] = []

    def rebinding(host: str) -> list[str]:
        answers.append(["93.184.216.34"] if not answers else ["10.0.0.7"])  # public when checked, private after
        return answers[-1]

    dialed: list[tuple[str, int]] = []

    def connect(addr: tuple[str, int], *a: Any, **k: Any) -> Any:
        dialed.append(addr)
        raise OSError("stop here")

    fetch.set_transport(None, rebinding, domain_spacing=0)
    monkeypatch.setattr(fetch, "_proxied", lambda url: False)
    monkeypatch.setattr(fetch.socket, "create_connection", connect)
    try:
        with pytest.raises(fetch.FetchError):
            fetch.urllib_transport("GET", "http://shop.example/item", {}, None, 1000)
        assert dialed == [("93.184.216.34", 80)] and len(answers) == 1
        # a name that resolves to a private address is never dialed
        fetch.set_transport(None, lambda h: ["169.254.169.254"], domain_spacing=0)
        with pytest.raises(fetch.FetchError):
            fetch.urllib_transport("GET", "http://metadata.example/", {}, None, 1000)
        assert len(dialed) == 1
    finally:
        fetch.set_transport(None)


def test_https_uses_host_name_for_sni_and_certificate(monkeypatch: Any) -> None:
    from mpro.suppliers import fetch

    seen: dict[str, Any] = {}

    class Ctx(ssl.SSLContext):
        def wrap_socket(self, sock: Any, *a: Any, server_hostname: str | None = None, **k: Any) -> Any:  # type: ignore[override]
            seen["sni"] = server_hostname
            return sock

    def connect(addr: tuple[str, int], *a: Any, **k: Any) -> Any:
        seen["addr"] = addr
        return socket.socket()

    monkeypatch.setattr(fetch.socket, "create_connection", connect)
    conn = fetch._PinnedHTTPS("supplier.example", 443, "93.184.216.34", 5, Ctx(ssl.PROTOCOL_TLS_CLIENT))
    conn.connect()
    conn.close()
    assert seen == {"addr": ("93.184.216.34", 443), "sni": "supplier.example"}


def test_connector_http_sends_host_header_and_does_not_follow_redirects(monkeypatch: Any) -> None:
    from mpro.suppliers import connectors, fetch

    hits: list[tuple[str, str]] = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            hits.append((self.path, self.headers.get("Host", "")))
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a: Any) -> None:
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    real = socket.create_connection
    dialed: list[tuple[str, int]] = []

    def connect(addr: tuple[str, int], *a: Any, **k: Any) -> Any:
        dialed.append(addr)
        return real(("127.0.0.1", port), *a, **k)  # the test server stands in for the checked address

    fetch.set_transport(None, lambda h: ["93.184.216.34"], domain_spacing=0)
    monkeypatch.setattr(fetch.socket, "create_connection", connect)
    try:
        status, _body = connectors._default_http()("GET", "http://api.supplier.example/v1/items", {}, None)
    finally:
        fetch.set_transport(None)
        srv.shutdown()
    assert status == 302  # handed back, not followed
    assert hits == [("/v1/items", "api.supplier.example")] and dialed == [("93.184.216.34", 80)]
    # a supplier address on a private network is refused before connecting
    fetch.set_transport(None, lambda h: ["10.1.2.3"], domain_spacing=0)
    try:
        with pytest.raises(connectors.ConnectorError):
            connectors._default_http()("GET", "http://api.supplier.example/v1/items", {}, None)
    finally:
        fetch.set_transport(None)


def test_redirect_hops_are_checked_and_punchout_posts_dont_follow_redirects(net: FakeNet) -> None:
    from mpro.suppliers import fetch
    from mpro.suppliers.services import _post_xml

    net.dns["inside.example"] = ["10.0.0.9"]
    net.add("https://shop.example/a", "", status=302, headers={"location": "http://inside.example/admin"})
    with pytest.raises(fetch.FetchError) as e:
        fetch.get("https://shop.example/a", check_robots=False)
    assert e.value.kind == "blocked" and "http://inside.example/admin" not in net.calls
    net.add("https://punchout.example/setup", "", status=307, headers={"location": "http://inside.example/x"})
    with pytest.raises(fetch.FetchError):
        _post_xml("https://punchout.example/setup", b"<cXML/>")
    assert "http://inside.example/x" not in net.calls


# ---- 9: races --------------------------------------------------------------------------------------
@PG
def test_concurrent_receipts_all_count(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "0")
    d = po(admin, lines=[{"part_id": p["id"], "quantity": "20", "unit_cost": "3", "location_id": wh}])

    def go(_i: int) -> None:
        from mpro.extensions import db
        from mpro.purchasing import services as ps

        with app.app_context():
            org, m = _ctx()
            ps.receive(
                org, m, ps.get_po(org.id, d["id"]), {"lines": [{"line_id": d["lines"][0]["id"], "quantity": "1"}]}
            )
            db.session.remove()

    assert not _run_threads(6, go)
    got = admin.get(f"{API}/purchase-orders/{d['id']}").json
    assert got["lines"][0]["received"] == "6" and got["status"] == "partially_fulfilled"
    assert part_row(app, p["id"]) == (Decimal("6"), Decimal("14"))


@PG
def test_concurrent_adjust_to_count_and_apply_run(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "10")

    def count(_i: int) -> None:
        from mpro.extensions import db
        from mpro.orgs.services import RuleError
        from mpro.parts import services as ps

        with app.app_context():
            org, m = _ctx()
            try:
                ps.adjust(org, m, ps.get_part(org.id, p["id"]), {"location_id": wh, "quantity": "5", "note": "count"})
            except RuleError:  # "that's already the quantity" for everyone after the first
                db.session.rollback()
            db.session.remove()

    assert not _run_threads(4, count)
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "5"
    # applying the same cycle-count run twice at once writes the correction once
    c = admin.post(f"{API}/cycle-counts", {"name": "Weekly", "location_id": wh, "selection": {"all": True}}).json
    run = admin.post(f"{API}/cycle-counts/{c['id']}/start").json
    line = run["lines"][0]
    assert (
        admin.c.put(
            f"{API}/cycle-count-runs/{run['id']}/lines/{line['id']}", json={"counted": "8"}, headers=admin._h()
        ).status_code
        == 200
    )

    def apply(_i: int) -> None:
        from mpro.extensions import db
        from mpro.parts import counts
        from mpro.parts.models import CycleCountRun

        with app.app_context():
            org, m = _ctx()
            counts.apply_run(org, m, db.session.get(CycleCountRun, uuid.UUID(run["id"])))
            db.session.remove()

    assert not _run_threads(3, apply)
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "8"
    kinds = [t["kind"] for t in admin.get(f"{API}/parts/transactions?part_id={p['id']}").json["items"]]
    assert kinds.count("count") == 1


def test_apply_run_twice_writes_once(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "10")
    c = admin.post(f"{API}/cycle-counts", {"name": "Weekly", "location_id": wh, "selection": {"all": True}}).json
    run = admin.post(f"{API}/cycle-counts/{c['id']}/start").json
    line = run["lines"][0]
    admin.c.put(f"{API}/cycle-count-runs/{run['id']}/lines/{line['id']}", json={"counted": "7"}, headers=admin._h())
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts import counts
        from mpro.parts.models import CycleCountRun

        org, m = _ctx()
        stale = db.session.get(CycleCountRun, uuid.UUID(run["id"]))
        assert counts.apply_run(org, m, stale) == 1
        stale.status = "open"  # a stale in-memory copy (another request's view) must not apply again
        assert counts.apply_run(org, m, stale) == 0
    assert admin.get(f"{API}/parts/{p['id']}").json["on_hand"] == "7"


# ---- 11: work-order part cost is what the parts cost when used --------------------------------------
def test_work_order_part_cost_uses_ledger_cost(admin: Api) -> None:
    p, wh = stocked(admin, "10")  # unit cost 2.50
    wo = create_wo(admin)
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/parts",
        {"part_id": p["id"], "quantity": "4", "location_id": wh, "status": "issued"},
    )
    assert r.status_code == 201, r.json
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["costs"]["parts_cents"] == 1000
    assert admin.patch(f"{API}/parts/{p['id']}", {"unit_cost": "9"}).status_code == 200
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["costs"]["parts_cents"] == 1000  # history doesn't move
    line = r.json["items"][0]
    admin.post(f"{API}/work-orders/{wo['id']}/parts/{line['id']}/return", {"quantity": "1"})
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["costs"]["parts_cents"] == 750
    admin.patch(f"{API}/work-orders/{wo['id']}/parts/{line['id']}", {"unit_cost_override": "1"})
    assert admin.get(f"{API}/work-orders/{wo['id']}").json["costs"]["parts_cents"] == 300


# ---- 12: client IPs, public links, quotes, part deletion, jobs ----------------------------------------
def test_forwarded_for_is_ignored_unless_proxies_are_trusted(app: Any) -> None:
    from sqlalchemy import select

    from mpro.app import create_app
    from mpro.auth.models import LoginAttempt
    from mpro.extensions import db

    c = app.test_client()
    c.post(
        f"{API}/auth/login",
        json={"email": "nobody@example.com", "password": "wrong-password"},
        headers={"X-Forwarded-For": "6.6.6.6"},
    )
    with app.app_context():
        ips = set(db.session.scalars(select(LoginAttempt.ip)))
    assert "6.6.6.6" not in ips and "127.0.0.1" in ips
    with app.test_request_context(environ_base={"REMOTE_ADDR": "10.9.8.7"}, headers={"X-Forwarded-For": "6.6.6.6"}):
        from mpro.workorders.external import _ip

        assert _ip() == "10.9.8.7"
    trusted = create_app(
        {
            **{k: app.config[k] for k in ("SQLALCHEMY_DATABASE_URI", "MPRO_BASE_URL")},
            "TESTING": True,
            "MPRO_TRUSTED_PROXIES": 1,
        }
    )
    trusted.test_client().post(
        f"{API}/auth/login",
        json={"email": "nobody@example.com", "password": "wrong-password"},
        headers={"X-Forwarded-For": "6.6.6.6"},
    )
    with trusted.app_context():
        assert "6.6.6.6" in set(db.session.scalars(select(LoginAttempt.ip)))
        db.session.remove()
        db.engine.dispose()


def test_public_quote_links_are_rate_limited_and_have_no_user(app: Any, admin: Api) -> None:
    from mpro.workorders import external as ext

    q = quote(admin, customer=customer(admin, billing_email="pay@lakeside.example"))
    token = admin.post(f"{API}/quotes/{q['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    # a signed-in staff member opening the customer link isn't the actor of the customer's comment
    assert admin.post(
        f"{API}/public/quotes/{token}/comments", {"name": "Morgan", "body": "Looks good"}
    ).status_code in (200, 201)
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.events import DomainEvent as AuditEvent
        from mpro.extensions import db

        evs = db.session.scalars(
            select(AuditEvent).where(AuditEvent.entity_id == q["id"], AuditEvent.type.like("quote.comment%"))
        ).all()
        assert evs and all(e.actor_id is None for e in evs)
    anon = Api(app.test_client())
    for _ in range(ext.LIMIT_FAILED_15MIN):
        assert anon.get(f"{API}/public/quotes/wrong-token").status_code == 404
    assert anon.get(f"{API}/public/quotes/wrong-token").status_code == 429
    assert anon.get(f"{API}/public/quotes/{token}").status_code == 429  # the same address is slowed down


def test_external_work_order_links_have_no_user(app: Any, admin: Api) -> None:
    from mpro.workorders import external_api

    wo = create_wo(admin)
    share = admin.post(f"{API}/work-orders/{wo['id']}/external-shares", {})
    if share.status_code not in (200, 201):
        pytest.skip("external sharing isn't enabled on this plan")
    token = share.json["token"]
    with app.test_request_context():
        from flask import g

        g.user = object()
        external_api._public(token)
        assert g.user is None and g.membership is None and g.org is not None


def test_editing_a_sent_quote_goes_back_to_draft_and_recomputes_tax(app: Any, admin: Api) -> None:
    q = quote(admin, customer=customer(admin, billing_email="pay@lakeside.example"))
    assert (q["subtotal"], q["tax"], q["total"]) == ("590", "54", "644")  # 10% of 540 taxable
    # changing lines keeps the 10% rate
    r = admin.patch(
        f"{API}/quotes/{q['id']}",
        {"lines": [{"kind": "part", "description": "Pump", "quantity": "2", "unit_price": "300"}]},
    )
    assert r.status_code == 200, r.json
    assert (r.json["subtotal"], r.json["tax"], r.json["total"]) == ("600", "60", "660")
    token = admin.post(f"{API}/quotes/{q['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    anon = Api(app.test_client())
    anon.session()
    assert anon.get(f"{API}/public/quotes/{token}").status_code == 200
    r = admin.patch(
        f"{API}/quotes/{q['id']}",
        {"lines": [{"kind": "part", "description": "Pump", "quantity": "3", "unit_price": "300"}]},
    )
    assert r.status_code == 200 and r.json["status"] == "draft" and r.json["shared"] is False and r.json["tax"] == "90"
    # the customer's old link no longer works, so they can't approve the old price
    assert anon.get(f"{API}/public/quotes/{token}").status_code == 404
    assert anon.post(f"{API}/public/quotes/{token}/decision", {"approve": True, "name": "M"}).status_code == 404
    new = admin.post(f"{API}/quotes/{q['id']}/send", {}).json["url"].rsplit("/", 1)[1]
    assert anon.get(f"{API}/public/quotes/{new}").json["total"] == "990"
    assert last_email(app, "pay@lakeside.example")


def test_parts_on_open_work_orders_or_pos_cant_be_deleted(admin: Api) -> None:
    p, wh = stocked(admin, "10")
    wo = create_wo(admin)
    r = admin.post(
        f"{API}/work-orders/{wo['id']}/parts",
        {"part_id": p["id"], "quantity": "1", "location_id": wh, "status": "assigned"},
    )
    assert r.status_code == 201, r.json
    d = admin.delete(f"{API}/parts/{p['id']}")
    assert d.status_code == 409 and "open work order" in d.json["message"]
    admin.post(f"{API}/work-orders/{wo['id']}/status", {"status": "canceled", "comment": "Not needed"})
    order = po(admin, lines=[{"part_id": p["id"], "quantity": "5", "unit_cost": "2", "location_id": wh}])
    d = admin.delete(f"{API}/parts/{p['id']}")
    assert d.status_code == 409 and "open purchase order" in d.json["message"]
    admin.post(f"{API}/purchase-orders/{order['id']}/cancel", {})
    assert admin.delete(f"{API}/parts/{p['id']}").status_code in (200, 204)


def test_auto_reserve_skips_deleted_parts_and_survives_a_bad_org(app: Any, admin: Api, monkeypatch: Any) -> None:
    p, wh = stocked(admin, "10")
    keep, _wh2 = stocked(admin, "10")
    admin.patch(f"{API}/parts/settings", {"auto_reserve_days": 30})
    from datetime import UTC, datetime, timedelta

    due = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    wo = create_wo(admin, due_at=due)
    for x in (p, keep):
        r = admin.post(
            f"{API}/work-orders/{wo['id']}/parts",
            {"part_id": x["id"], "quantity": "1", "location_id": wh, "status": "assigned"},
        )
        assert r.status_code == 201, r.json
    other = other_org(app)
    other.patch(f"{API}/parts/settings", {"auto_reserve_days": 30})
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts import services as ps
        from mpro.parts.models import Part

        db.session.get(Part, uuid.UUID(p["id"])).deleted_at = datetime.now(UTC)  # deleted behind the guard's back
        db.session.commit()
        org, _m = _ctx()
        org_id = org.id
        real = ps._auto_reserve_org

        mine = org_id

        def flaky(org_id: Any, now: Any) -> int:
            if org_id != mine:
                raise RuntimeError("bad data in another org")
            return real(org_id, now)

        monkeypatch.setattr(ps, "_auto_reserve_org", flaky)
        ps.auto_reserve()  # doesn't raise
    lines = {
        x["part"]["id"] if x.get("part") else x.get("part_id"): x["status"]
        for x in admin.get(f"{API}/work-orders/{wo['id']}/parts").json["items"]
    }
    assert lines.get(keep["id"]) == "reserved" and lines.get(p["id"]) == "assigned"
    with app.app_context():
        from mpro.parts import services as ps

        ps.refresh_reserved(mine, uuid.UUID(p["id"]), uuid.UUID(wh))  # a deleted part is skipped, not an error
