# ruff: noqa: E501  (long URLs and API calls read better on one line)
"""Supplier product links, product cards, connectors, price tracking and PunchOut (0.5.0, MP-084–089).

The network is never used: a fake transport serves saved sample pages, and DNS answers are faked.
"""

from __future__ import annotations

import base64
import io
import json
import uuid
from collections.abc import Iterator
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from urllib.parse import quote

import pytest

from tests.conftest import Api
from tests.test_assets import asset, other_org
from tests.test_roles import member

API = "/api/v1"


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


PNG = _png()

PAGE_JSONLD = """<!doctype html><html><head><title>Grainger page</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
{"@type":"Product","name":"V-Belt, 4L360 &amp; more","brand":{"@type":"Brand","name":"Dayton"},"sku":"1A120","mpn":"4L360",
"image":["https://www.grainger.com/img/1A120.png"],
"offers":{"@type":"Offer","price":"14.85","priceCurrency":"usd","availability":"https://schema.org/InStock"},
"additionalProperty":[{"name":"Length","value":"36 in"}]}]}</script>
<script>alert('x')</script></head><body><h1>V-Belt</h1></body></html>"""

PAGE_OG = """<html><head><meta property="og:title" content="Filter &lt;b&gt;20x20&lt;/b&gt;">
<meta property="product:price:amount" content="1.234,56"><meta property="product:price:currency" content="EUR">
<meta property="og:image" content="/img/f.png"><meta property="product:availability" content="out of stock"></head></html>"""

PAGE_TITLE = "<html><head><title>  Some   Product Page </title></head></html>"


class FakeNet:
    """Serves canned responses; records every URL asked for."""

    def __init__(self) -> None:
        self.pages: dict[str, tuple[int, dict[str, str], bytes]] = {}
        self.calls: list[str] = []
        self.dns: dict[str, list[str]] = {}

    def add(
        self,
        url: str,
        body: str | bytes,
        status: int = 200,
        ctype: str = "text/html; charset=utf-8",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.pages[url] = (
            status,
            {"content-type": ctype, **(headers or {})},
            body.encode() if isinstance(body, str) else body,
        )

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None, limit: int) -> Any:
        from mpro.suppliers.fetch import FetchError, Response

        self.calls.append(url)
        if url.endswith("/robots.txt") and url not in self.pages:
            return Response(404, url, {}, b"")
        if url not in self.pages:
            raise FetchError("no route in test")
        st, h, b = self.pages[url]
        if len(b) > limit:
            raise FetchError("The page is too large to read.")
        return Response(st, url, h, b)

    def resolve(self, host: str) -> list[str]:
        return self.dns.get(host, ["93.184.216.34"])


@pytest.fixture()
def net() -> Iterator[FakeNet]:
    from mpro.suppliers import fetch

    n = FakeNet()
    fetch.set_transport(n, n.resolve, domain_spacing=0)
    yield n
    fetch.set_transport(None)


def make_part(app: Any, name: str = "V-belt 4L360", email: str = "admin@example.com") -> str:
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.extensions import db
        from mpro.orgs.models import Membership
        from mpro.parts.models import Part

        u = db.session.scalars(select(User).where(User.email == email)).one()
        m = db.session.scalars(select(Membership).where(Membership.user_id == u.id)).first()
        assert m is not None
        p = Part(org_id=m.org_id, name=name, unit="each", unit_cost=Decimal("10"), on_hand=Decimal("1"))
        db.session.add(p)
        db.session.commit()
        return str(p.id)


def link(api: Api, entity_id: str, url: str, entity_type: str = "part", **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/product-links", {"entity_type": entity_type, "entity_id": entity_id, "url": url, **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


# ---------------------------------------------------------------- recognition


@pytest.mark.parametrize(
    ("url", "key", "ext"),
    [
        ("https://www.amazon.com/Hydraulic-Kit/dp/B07PJV4WS3/ref=sr_1_3?keywords=hose&qid=1", "amazon", "B07PJV4WS3"),
        ("amazon.co.uk/gp/product/b07pjv4ws3", "amazon", "B07PJV4WS3"),
        ("https://amzn.to/3xYz12Q", "amazon_short", "3xYz12Q"),
        ("https://www.grainger.com/product/DAYTON-V-Belt-4L360-1A120", "grainger", "1A120"),
        ("https://www.mcmaster.com/2165K24/", "mcmaster", "2165K24"),
        ("https://www.zoro.com/dayton-v-belt/i/G1234567/", "zoro", "G1234567"),
        ("https://www.fastenal.com/product/details/0123456", "fastenal", "0123456"),
        ("https://www.mscdirect.com/product/details/01234567", "msc", "01234567"),
        ("https://www.homedepot.com/p/Some-Thing/312345678", "home_depot", "312345678"),
        ("https://www.lowes.com/pd/Some-Thing/1000123456", "lowes", "1000123456"),
        ("https://www.uline.com/Product/Detail/S-12345/Boxes", "uline", "S-12345"),
        ("https://www.digikey.com/en/products/detail/texas-instruments/LM358P/277042", "digikey", "277042"),
        ("https://www.mouser.com/ProductDetail/Texas-Instruments/LM358P", "mouser", "LM358P"),
        ("https://www.automationdirect.com/pn/GS1-10P5", "automationdirect", "GS1-10P5"),
        ("https://www.graybar.com/p/88158923", "graybar", "88158923"),
        ("https://shop.example.org/thing", "other", ""),
    ],
)
def test_recognises_suppliers(admin: Api, url: str, key: str, ext: str) -> None:
    r = admin.post(f"{API}/suppliers/recognize", {"url": url})
    assert r.status_code == 200, r.json
    assert (r.json["supplier_key"], r.json["external_id"]) == (key, ext)
    assert "qid=" not in r.json["url"] and "keywords=" not in r.json["url"]


def test_recognise_rejects_bad_links(admin: Api) -> None:
    for bad in ("", "ftp://x.com/a", "javascript:alert(1)"):
        assert admin.post(f"{API}/suppliers/recognize", {"url": bad}).status_code == 422


def test_org_supplier_patterns(admin: Api, app: Any) -> None:
    assert (
        admin.post(
            f"{API}/supplier-sites",
            {"name": "Acme Supply", "domains": ["acmesupply.com"], "id_patterns": ["/item/(?P<id>[0-9]+"]},
        ).status_code
        == 422
    )
    assert (
        admin.post(
            f"{API}/supplier-sites",
            {"name": "Acme Supply", "domains": ["acmesupply.com"], "id_patterns": ["/item/([0-9]+)"]},
        ).status_code
        == 422
    )
    r = admin.post(
        f"{API}/supplier-sites",
        {
            "name": "Acme Supply",
            "domains": ["https://www.acmesupply.com/"],
            "id_patterns": ["/item/(?P<id>[0-9]+)"],
            "id_label": "Acme #",
        },
    )
    assert r.status_code == 201, r.json
    m = admin.post(f"{API}/suppliers/recognize", {"url": "https://shop.acmesupply.com/item/7788?x=1"}).json
    assert (m["supplier_key"], m["external_id"], m["id_label"]) == ("acme_supply", "7788", "Acme #")
    assert any(s["key"] == "acme_supply" for s in admin.get(f"{API}/suppliers").json["items"])
    assert admin.post(f"{API}/supplier-sites", {"name": "Acme Supply", "domains": ["acme.com"]}).status_code == 409
    tech = member(app, "tech-sup@example.com", "technician", admin)
    assert tech.post(f"{API}/supplier-sites", {"name": "X", "domains": ["x.com"]}).status_code == 403
    assert tech.get(f"{API}/supplier-sites").status_code == 403


# ---------------------------------------------------------------- links, fetching, cards


def test_link_part_reads_page_and_copies_image(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    url = "https://www.grainger.com/product/DAYTON-V-Belt-4L360-1A120"
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    net.add("https://www.grainger.com/img/1A120.png", PNG, ctype="image/png")
    lk = link(admin, pid, url, mpn="4L360", pack_size="2", alert_price_change_pct="10")
    got = admin.get(f"{API}/product-links/{lk['id']}").json
    p = got["product"]
    assert p["fetch_status"] == "ok" and p["source"] == "jsonld"
    assert (
        p["title"] == "V-Belt, 4L360 & more"
        and p["brand"] == "Dayton"
        and p["price"] == "14.8500"
        and p["currency"] == "USD"
    )
    assert p["availability"] == "in_stock" and p["specs"] == {"Length": "36 in"} and not p["price_may_have_changed"]
    assert got["preferred"] and got["supplier_name"] == "Grainger" and got["supplier_sku"] == "1A120"
    assert p["image_url"] and admin.get(p["image_url"]).status_code == 200  # served from MPro, not the supplier
    hist = admin.get(f"{API}/products/{p['id']}/prices").json["items"]
    assert len(hist) == 1 and hist[0]["price"].startswith("14.85")
    assert admin.post(f"{API}/product-links", {"entity_type": "part", "entity_id": pid, "url": url}).status_code == 409
    # second supplier: not preferred until chosen; choosing it moves the star
    net.add("https://www.mcmaster.com/6384K365", PAGE_TITLE)
    lk2 = link(admin, pid, "https://www.mcmaster.com/6384K365")
    assert not lk2["preferred"]
    admin.patch(f"{API}/product-links/{lk2['id']}", {"preferred": True})
    items = admin.get(f"{API}/product-links?entity_type=part&entity_id={pid}").json["items"]
    assert [i["preferred"] for i in items] == [True, False] and items[0]["id"] == lk2["id"]
    assert items[0]["product"]["source"] == "title" and items[0]["title"] == "Some Product Page"
    # deleting the preferred one passes the star on
    assert admin.delete(f"{API}/product-links/{lk2['id']}").status_code == 204
    assert admin.get(f"{API}/product-links?entity_type=part&entity_id={pid}").json["items"][0]["preferred"]


def test_parsers() -> None:
    from mpro.suppliers.fetch import money, parse_page

    og = parse_page(PAGE_OG.encode(), "https://shop.example.com/x")
    assert (
        og.source == "opengraph"
        and og.title == "Filter 20x20"
        and og.price == Decimal("1234.56")
        and og.currency == "EUR"
    )
    assert og.availability == "out_of_stock" and og.image_url == "https://shop.example.com/img/f.png"
    t = parse_page(PAGE_TITLE.encode(), "https://x.example.com/")
    assert t.source == "title" and t.title == "Some Product Page"
    assert money("$1,299.00") == Decimal("1299.00") and money("abc") is None and money("-5") is None
    js = parse_page(
        b'<script type="application/ld+json">{"@type":"Product","name":"<img src=x onerror=alert(1)>Pump","offers":[{"@type":"AggregateOffer","lowPrice":"5"}]}</script>',
        "https://a.example/",
    )
    assert js.title == "Pump" and js.price == Decimal("5")
    broken = parse_page(b'<script type="application/ld+json">{not json</script><title>T</title>', "https://a.example/")
    assert broken.title == "T"


def test_blocked_sites_still_show_a_card(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    net.add("https://www.homedepot.com/robots.txt", "User-agent: *\nDisallow: /p/\n", ctype="text/plain")
    lk = link(
        admin, pid, "https://www.homedepot.com/p/Thing/312345678", manual_title="Shop vac filter", manual_price="19.97"
    )
    got = admin.get(f"{API}/product-links/{lk['id']}").json
    assert got["product"]["fetch_status"] == "blocked" and "automatic readers" in got["product"]["fetch_error"]
    assert got["title"] == "Shop vac filter" and got["price"] == "19.9700" and got["price_from"] == "typed"
    assert not any("/p/" in c for c in net.calls)  # robots.txt was respected
    net.add("https://www.lowes.com/pd/1000123456", "denied", status=403)
    lk2 = link(admin, pid, "https://www.lowes.com/pd/Thing/1000123456")
    assert admin.get(f"{API}/product-links/{lk2['id']}").json["product"]["fetch_status"] == "blocked"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://10.1.2.3/x",
        "http://localhost:8080/x",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x",
        "http://intranet.local/x",
        "http://shop.example.com:22/x",
    ],
)
def test_never_fetches_private_addresses(admin: Api, app: Any, net: FakeNet, url: str) -> None:
    pid = make_part(app)
    lk = link(admin, pid, url)
    assert admin.get(f"{API}/product-links/{lk['id']}").json["product"]["fetch_status"] == "blocked"
    assert net.calls == []


def test_dns_and_redirects_are_checked(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    net.dns["evil.example.com"] = ["93.184.216.34", "10.0.0.7"]  # any private answer refuses the host
    lk = link(admin, pid, "https://evil.example.com/p")
    assert admin.get(f"{API}/product-links/{lk['id']}").json["product"]["fetch_status"] == "blocked"
    net.add("https://shop.example.com/p", "", status=302, headers={"location": "http://192.168.1.1/admin"})
    lk2 = link(admin, pid, "https://shop.example.com/p")
    assert admin.get(f"{API}/product-links/{lk2['id']}").json["product"]["fetch_status"] == "blocked"
    assert "http://192.168.1.1/admin" not in net.calls


def test_stale_prices_and_daily_refresh(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    lk = link(admin, pid, "https://www.grainger.com/product/1A120")
    with app.app_context():
        from mpro.core.models import utcnow
        from mpro.extensions import db
        from mpro.suppliers import services as svc
        from mpro.suppliers.models import Product

        p = db.session.get(Product, uuid.UUID(lk["product"]["id"]))
        assert p is not None
        p.fetched_at = utcnow() - timedelta(hours=30)
        p.next_refresh_at = utcnow() - timedelta(minutes=1)
        db.session.commit()
    assert admin.get(f"{API}/product-links/{lk['id']}").json["product"]["price_may_have_changed"]
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD.replace('"14.85"', '"17.10"'))
    with app.app_context():
        assert svc.refresh_due() == 1
    got = admin.get(f"{API}/product-links/{lk['id']}").json["product"]
    assert got["price"] == "17.1000" and not got["price_may_have_changed"]
    assert len(admin.get(f"{API}/products/{got['id']}/prices").json["items"]) == 2


def _emails(app: Any) -> list[Any]:
    with app.app_context():
        from sqlalchemy import select

        from mpro.core.mail import OutboundEmail
        from mpro.extensions import db

        return [(m.to, m.subject, m.body) for m in db.session.scalars(select(OutboundEmail)).all()]


def test_price_stock_and_discontinued_alerts(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    url = "https://www.grainger.com/product/1A120"
    net.add(url, PAGE_JSONLD)
    lk = link(admin, pid, url, alert_price_change_pct="10", alert_out_of_stock=True)
    before = len(_emails(app))
    net.add(url, PAGE_JSONLD.replace('"14.85"', '"15.50"'))  # +4%: below the 10% threshold
    admin.post(f"{API}/product-links/{lk['id']}/refresh")
    assert len(_emails(app)) == before
    net.add(url, PAGE_JSONLD.replace('"14.85"', '"19.00"').replace("InStock", "OutOfStock"))
    admin.post(f"{API}/product-links/{lk['id']}/refresh")
    mails = _emails(app)[before:]
    assert len(mails) == 1 and mails[0][0] == "admin@example.com"
    assert "rose 22.6% to 19" in mails[0][2] and "out of stock" in mails[0][2]
    net.add(url, PAGE_JSONLD.replace("InStock", "Discontinued"))
    admin.post(f"{API}/product-links/{lk['id']}/refresh")
    assert "discontinued" in _emails(app)[-1][2]
    with app.app_context():
        from sqlalchemy import func, select

        from mpro.core.events import DomainEvent as Event
        from mpro.extensions import db

        assert db.session.scalar(select(func.count()).select_from(Event).where(Event.type == "product.alert")) == 2


def test_compare_suppliers(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)  # 14.85, in stock, pack of 2 → 7.425
    net.add(
        "https://www.zoro.com/i/G1234567/", PAGE_OG.replace("1.234,56", "6.00").replace("EUR", "USD")
    )  # out of stock
    net.add("https://www.mcmaster.com/2165K24", PAGE_JSONLD.replace('"14.85"', '"9.00"'))
    link(admin, pid, "https://www.grainger.com/product/1A120", pack_size="2")
    link(admin, pid, "https://www.zoro.com/i/G1234567/")
    link(admin, pid, "https://www.mcmaster.com/2165K24")
    rows = admin.get(f"{API}/product-links/compare?entity_type=part&entity_id={pid}").json["items"]
    assert [r["supplier_name"] for r in rows] == ["Grainger", "McMaster-Carr", "Zoro"]
    assert rows[0]["best"] and rows[0]["unit_price"] == "7.4250" and rows[-1]["availability"] == "out_of_stock"


# ---------------------------------------------------------------- connectors (MP-086)


class FakeApi:
    def __init__(self, routes: dict[tuple[str, str], list[tuple[int, Any]]]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, str, dict[str, str], Any]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, Any]:
        self.calls.append((method, url, headers, json.loads(body) if body else None))
        seq = self.routes.get((method, url))
        if not seq:
            return 404, None
        return seq.pop(0) if len(seq) > 1 else seq[0]


def test_amazon_creators_connector() -> None:
    from mpro.suppliers.connectors import AmazonCreators, ConnectorError

    api = FakeApi(
        {
            ("POST", "https://api.amazon.co.uk/auth/o2/token"): [(200, {"access_token": "tok", "expires_in": 3600})],
            ("POST", "https://creatorsapi.amazon/catalog/v1/getItems"): [
                (
                    200,
                    {
                        "itemsResult": {
                            "items": [
                                {
                                    "asin": "B07PJV4WS3",
                                    "detailPageURL": "https://www.amazon.co.uk/dp/B07PJV4WS3",
                                    "itemInfo": {
                                        "title": {"displayValue": "Hose kit"},
                                        "byLineInfo": {"brand": {"displayValue": "Acme"}},
                                    },
                                    "images": {
                                        "primary": {"large": {"url": "https://m.media-amazon.com/images/I/x.jpg"}}
                                    },
                                    "offersV2": {
                                        "listings": [
                                            {
                                                "price": {"money": {"amount": 32.99, "currency": "GBP"}},
                                                "availability": {"type": "IN_STOCK"},
                                            }
                                        ]
                                    },
                                }
                            ]
                        }
                    },
                )
            ],
        }
    )
    c = AmazonCreators(
        {"credential_id": "cid", "region": "3.2", "marketplace": "www.amazon.co.uk", "partner_tag": "me-21"},
        {"credential_secret": "sec"},
        http=api,
    )
    info = c.lookup("https://www.amazon.co.uk/dp/B07PJV4WS3?tag=x")
    assert (info.title, info.brand, info.price, info.currency, info.availability) == (
        "Hose kit",
        "Acme",
        Decimal("32.99"),
        "GBP",
        "in_stock",
    )
    tok_call, get_call = api.calls
    assert tok_call[3] == {
        "grant_type": "client_credentials",
        "client_id": "cid",
        "client_secret": "sec",
        "scope": "creatorsapi::default",
    }
    assert get_call[2]["Authorization"] == "Bearer tok" and get_call[2]["x-marketplace"] == "www.amazon.co.uk"
    assert (
        get_call[3]["itemIds"] == ["B07PJV4WS3"]
        and get_call[3]["partnerTag"] == "me-21"
        and get_call[3]["itemIdType"] == "ASIN"
    )
    bad = AmazonCreators(
        {"credential_id": "cid"},
        {"credential_secret": "x"},
        http=FakeApi({("POST", "https://api.amazon.com/auth/o2/token"): [(401, {})]}),
    )
    with pytest.raises(ConnectorError, match="didn't accept"):
        bad.test()


def test_mcmaster_connector_subscribes_and_reads_replacements() -> None:
    from mpro.suppliers.connectors import McMaster

    base = "https://api.mcmaster.com/v1"
    api = FakeApi(
        {
            ("POST", f"{base}/login"): [(200, {"AuthToken": "T", "ExpirationTS": "x"})],
            ("GET", f"{base}/products/6384K365"): [(403, None), (200, {})],
            ("PUT", f"{base}/products"): [
                (
                    201,
                    {
                        "PartNumber": "6384K365",
                        "ProductStatus": "Discontinued",
                        "FamilyDescription": "Ball Bearing",
                        "DetailDescription": "6205-2Z",
                        "Specifications": [{"Attribute": "Shaft", "Values": ["25 mm"]}],
                        "Links": [
                            {"Key": "Price", "Value": "/v1/products/6384K365/price"},
                            {"Key": "SuggestedProduct", "Value": "/5972K91"},
                        ],
                    },
                )
            ],
            ("GET", f"{base}/products/6384K365/price"): [
                (200, [{"Amount": 11.6, "MinimumQuantity": 1, "UnitOfMeasure": "Each"}])
            ],
        }
    )
    info = McMaster({"username": "u"}, {"password": "p"}, http=api).lookup("https://www.mcmaster.com/6384K365")
    assert info.title == "Ball Bearing 6205-2Z" and info.availability == "discontinued"
    assert (
        info.replacement_url == "https://www.mcmaster.com/5972K91"
        and info.price == Decimal("11.6")
        and info.price_unit == "Each"
    )
    assert info.specs["Shaft"] == "25 mm"
    assert [c[0] + " " + c[1].removeprefix(base) for c in api.calls] == [
        "POST /login",
        "GET /products/6384K365",
        "PUT /products",
        "GET /products/6384K365/price",
    ]
    assert (
        api.calls[2][3] == {"URL": "https://mcmaster.com/6384K365"} and api.calls[1][2]["Authorization"] == "Bearer T"
    )


def test_connections_keep_secrets_encrypted(admin: Api, app: Any) -> None:
    specs = admin.get(f"{API}/supplier-connections").json["connectors"]
    assert {s["key"] for s in specs} == {"amazon_creators", "mcmaster", "punchout_cxml", "punchout_oci"}
    assert all(s["needs_account"] for s in specs)
    r = admin.post(
        f"{API}/supplier-connections",
        {
            "connector": "amazon_creators",
            "settings": {"credential_id": "cid", "partner_tag": "me-20"},
            "secrets": {"credential_secret": "very-secret-123"},
        },
    )
    assert r.status_code == 201, r.json
    assert "very-secret-123" not in json.dumps(r.json) and r.json["secrets_set"] == {"credential_secret": True}
    assert r.json["secrets_masked"]["credential_secret"].endswith("-123")
    with app.app_context():
        from mpro.extensions import db
        from mpro.suppliers.models import SupplierConnection

        row = db.session.get(SupplierConnection, uuid.UUID(r.json["id"]))
        assert row is not None and "very-secret" not in row.secrets and row.secrets.startswith("enc1:")
    # blank secret keeps the stored one
    r2 = admin.patch(
        f"{API}/supplier-connections/{r.json['id']}",
        {"settings": {"marketplace": "www.amazon.com"}, "secrets": {"credential_secret": ""}},
    )
    assert r2.json["secrets_set"] == {"credential_secret": True}
    t = admin.post(f"{API}/supplier-connections/{r.json['id']}/test")
    assert t.status_code == 422  # no network here: the error is recorded and shown
    assert admin.get(f"{API}/supplier-connections").json["items"][0]["last_error"]
    assert (
        admin.post(
            f"{API}/supplier-connections",
            {"connector": "punchout_cxml", "settings": {"setup_url": "http://insecure.example"}},
        ).status_code
        == 422
    )


def test_refresh_uses_the_connected_api_and_falls_back_to_the_page(
    admin: Api, app: Any, net: FakeNet, monkeypatch: Any
) -> None:
    from mpro.suppliers import connectors

    pid = make_part(app)
    admin.post(
        f"{API}/supplier-connections",
        {
            "connector": "amazon_creators",
            "settings": {"credential_id": "c", "partner_tag": "t-20"},
            "secrets": {"credential_secret": "s"},
        },
    )
    fake = FakeApi(
        {
            ("POST", "https://api.amazon.com/auth/o2/token"): [(200, {"access_token": "tok"})],
            ("POST", "https://creatorsapi.amazon/catalog/v1/getItems"): [
                (
                    200,
                    {
                        "itemsResult": {
                            "items": [{"asin": "B07PJV4WS3", "itemInfo": {"title": {"displayValue": "From the API"}}}]
                        }
                    },
                )
            ],
        }
    )
    monkeypatch.setattr(connectors, "_default_http", lambda cert=None: fake)
    lk = link(admin, pid, "https://www.amazon.com/dp/B07PJV4WS3")
    p = admin.get(f"{API}/product-links/{lk['id']}").json["product"]
    assert p["title"] == "From the API" and p["source"] == "api"
    item = admin.get(f"{API}/supplier-connections").json["items"][0]
    assert item["last_success_at"] and not item["last_error"]
    monkeypatch.setattr(connectors, "_default_http", lambda cert=None: FakeApi({}))
    net.add("https://www.amazon.com/dp/B07PJV4WS3", PAGE_JSONLD)
    admin.post(f"{API}/product-links/{lk['id']}/refresh")
    p = admin.get(f"{API}/product-links/{lk['id']}").json["product"]
    assert p["source"] == "jsonld" and admin.get(f"{API}/supplier-connections").json["items"][0]["last_error"]


# ---------------------------------------------------------------- reorder and PunchOut (MP-088)


@pytest.fixture()
def po_calls(monkeypatch: Any) -> list[dict[str, Any]]:
    """The purchasing module's create_purchase_order contract, recorded (works with or without the real one)."""
    from mpro.purchasing import services as po_svc  # noqa: F401  (may not exist yet in a parallel build)

    calls: list[dict[str, Any]] = []
    real = getattr(po_svc, "create_purchase_order", None)

    def fake(org: Any, member: Any, data: dict[str, Any], **kw: Any) -> Any:
        calls.append(data)
        if real is not None:
            return real(org, member, data, **kw)
        return SimpleNamespace(id=uuid.uuid4())

    monkeypatch.setattr(po_svc, "create_purchase_order", fake, raising=False)
    return calls


def _make_po_services_importable() -> None:
    import importlib
    import sys
    import types

    try:
        importlib.import_module("mpro.purchasing.services")
    except ModuleNotFoundError:
        sys.modules["mpro.purchasing.services"] = types.ModuleType("mpro.purchasing.services")
        import mpro.purchasing as pkg

        pkg.services = sys.modules["mpro.purchasing.services"]  # type: ignore[attr-defined]


_make_po_services_importable()


def test_reorder_from_a_linked_product(admin: Api, app: Any, net: FakeNet, po_calls: list[dict[str, Any]]) -> None:
    pid = make_part(app)
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    lk = link(admin, pid, "https://www.grainger.com/product/1A120", supplier_sku="1A120", unit="each")
    line = admin.get(f"{API}/product-links/{lk['id']}/po-line?quantity=4").json
    assert (
        line["part_id"] == pid
        and line["quantity"] == "4"
        and line["unit_cost"].startswith("14.85")
        and line["product_link_id"] == lk["id"]
    )
    r = admin.post(f"{API}/product-links/{lk['id']}/reorder", {"quantity": 3})
    assert r.status_code == 201, r.json
    data = po_calls[-1]
    assert (
        data["source"] == "reorder"
        and data["lines"][0]["quantity"] == "3"
        and data["lines"][0]["part_number"] == "1A120"
    )
    assert admin.post(f"{API}/product-links/{lk['id']}/reorder", {"quantity": 0}).status_code == 422


CXML_SETUP_RESPONSE = b"""<?xml version="1.0"?><!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">
<cXML payloadID="1" timestamp="2026-10-23T00:00:00"><Response><Status code="200" text="OK"/>
<PunchOutSetupResponse><StartPage><URL>https://punchout.grainger.example/start?s=abc</URL></StartPage></PunchOutSetupResponse></Response></cXML>"""


def _order_message(cookie: str) -> str:
    return f"""<?xml version="1.0"?><cXML payloadID="2" timestamp="2026-10-23T00:00:00"><Message><PunchOutOrderMessage>
<BuyerCookie>{cookie}</BuyerCookie><PunchOutOrderMessageHeader operationAllowed="edit"><Total><Money currency="USD">44.55</Money></Total></PunchOutOrderMessageHeader>
<ItemIn quantity="3"><ItemID><SupplierPartID>1A120</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">14.85</Money></UnitPrice>
<Description xml:lang="en">V-Belt 4L360</Description><UnitOfMeasure>EA</UnitOfMeasure><ManufacturerPartID>4L360</ManufacturerPartID></ItemDetail></ItemIn>
<ItemIn quantity="1"><ItemID><SupplierPartID>9Z999</SupplierPartID></ItemID><ItemDetail><UnitPrice><Money currency="USD">5.00</Money></UnitPrice>
<Description xml:lang="en">Gloves</Description><UnitOfMeasure>PR</UnitOfMeasure></ItemDetail></ItemIn></PunchOutOrderMessage></Message></cXML>"""


def test_cxml_punchout_cart_becomes_a_po(
    admin: Api, app: Any, net: FakeNet, po_calls: list[dict[str, Any]], monkeypatch: Any
) -> None:
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
                "from_identity": "ACME",
                "to_identity": "GRAINGER",
            },
            "secrets": {"shared_secret": "s3cret"},
        },
    ).json
    sent: list[bytes] = []

    def post(url: str, doc: bytes) -> bytes:
        sent.append(doc)
        return CXML_SETUP_RESPONSE

    monkeypatch.setattr(svc, "_post_xml", post)
    cats = admin.get(f"{API}/punchout/catalogs").json["items"]
    assert cats and cats[0]["supplier_name"] == "Grainger"
    out = admin.post(f"{API}/punchout/start", {"connection_id": c["id"]})
    assert out.status_code == 200, out.json
    assert out.json["redirect"] == "https://punchout.grainger.example/start?s=abc"
    doc = sent[0].decode()
    assert "<SharedSecret>s3cret</SharedSecret>" in doc and "<BuyerCookie>" in doc and "/api/v1/punchout/return/" in doc
    cookie = doc.split("<BuyerCookie>")[1].split("</BuyerCookie>")[0]
    browser = app.test_client()  # the supplier's page posts back: no MPro session, no CSRF token
    r = browser.post(f"{API}/punchout/return/{cookie}", data={"cxml-urlencoded": _order_message(cookie)})
    assert r.status_code == 303 and r.headers["Location"].startswith("/purchase-orders/")
    data = po_calls[-1]
    assert data["source"] == "punchout" and len(data["lines"]) == 2
    first = data["lines"][0]
    assert (
        first["part_id"] == pid
        and first["quantity"] == "3"
        and first["unit_cost"] == "14.85"
        and first["product_link_id"]
    )
    assert data["lines"][1]["part_id"] is None and data["lines"][1]["description"] == "Gloves"
    again = browser.post(f"{API}/punchout/return/{cookie}", data={"cxml-urlencoded": _order_message(cookie)})
    assert again.status_code == 303 and "punchout_error" in again.headers["Location"]
    assert "punchout_error" in browser.post(f"{API}/punchout/return/not-a-cookie", data={}).headers["Location"]


def test_punchout_rejects_entities_and_parses_oci() -> None:
    from mpro.suppliers.punchout import PunchOutError, parse_oci, parse_order_message

    with pytest.raises(PunchOutError):
        parse_order_message('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><cXML>&a;</cXML>')
    lines = parse_oci(
        {
            "NEW_ITEM-DESCRIPTION[1]": "Belt",
            "NEW_ITEM-QUANTITY[1]": "2",
            "NEW_ITEM-PRICE[1]": "29.70",
            "NEW_ITEM-PRICEUNIT[1]": "2",
            "NEW_ITEM-CURRENCY[1]": "usd",
            "NEW_ITEM-VENDORMAT[1]": "1A120",
            "NEW_ITEM-DESCRIPTION[2]": "Zero",
            "NEW_ITEM-QUANTITY[2]": "0",
        }
    )
    assert (
        len(lines) == 1
        and lines[0].unit_price == Decimal("14.85")
        and lines[0].currency == "USD"
        and lines[0].supplier_part_id == "1A120"
    )


def test_oci_start_gives_a_form(admin: Api) -> None:
    c = admin.post(
        f"{API}/supplier-connections",
        {
            "connector": "punchout_oci",
            "settings": {"setup_url": "https://catalog.example/oci", "username": "acme"},
            "secrets": {"password": "pw"},
        },
    ).json
    out = admin.post(f"{API}/punchout/start", {"connection_id": c["id"]}).json
    assert out["form"]["action"] == "https://catalog.example/oci" and out["form"]["fields"]["HOOK_URL"].startswith(
        "http://mpro.test/api/v1/punchout/return/"
    )


def test_received_items_update_last_paid_price(admin: Api, app: Any, net: FakeNet) -> None:
    from mpro.suppliers import services as svc
    from tests.test_parts import stocked
    from tests.test_vendors import vendor

    p, _wh = stocked(admin, "2")
    v = vendor(admin, "Grainger")
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    lk = link(admin, p["id"], "https://www.grainger.com/product/1A120", supplier_sku="1A120")
    line = admin.get(f"{API}/product-links/{lk['id']}/po-line").json
    assert line["vendor_id"] == v["id"]  # a vendor named like the supplier
    assert Decimal(line["quantity"]) == 18  # up to the part's maximum (20) from 2 on hand
    r = admin.post(f"{API}/product-links/{lk['id']}/reorder", {"quantity": "5"})
    assert r.status_code == 201, r.json
    po = admin.get(f"{API}/purchase-orders/{r.json['purchase_order_id']}").json
    pol = po["lines"][0]
    if po["status"] != "approved":
        admin.post(f"{API}/purchase-orders/{po['id']}/approve", {})
    got = admin.post(
        f"{API}/purchase-orders/{po['id']}/receive",
        {"lines": [{"line_id": pol["id"], "quantity": "5", "unit_cost": "13.25"}]},
    )
    assert got.status_code == 200, got.json
    with app.app_context():
        from mpro.purchasing.hooks import PO_RECEIVED_HOOKS

        assert svc.on_po_received in PO_RECEIVED_HOOKS
    assert admin.get(f"{API}/product-links/{lk['id']}").json["last_paid_price"].startswith("13.25")


# ---------------------------------------------------------------- assets (MP-089), search, access


def test_asset_spare_parts_and_purchased_from(admin: Api, app: Any, net: FakeNet) -> None:
    a = asset(admin, "Air handler 2")
    pid = make_part(app, "Filter 20x20")
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts.models import Part, PartAsset

        p = db.session.get(Part, uuid.UUID(pid))
        assert p is not None
        db.session.add(PartAsset(org_id=p.org_id, part_id=p.id, asset_id=uuid.UUID(a["id"])))
        db.session.commit()
    net.add("https://www.mcmaster.com/2165K24", PAGE_JSONLD)
    link(admin, pid, "https://www.mcmaster.com/2165K24")
    link(
        admin,
        a["id"],
        "https://www.grainger.com/product/5Z680",
        entity_type="asset",
        role="purchased_from",
        manual_title="Original unit",
    )
    link(admin, a["id"], "https://www.zoro.com/i/G7654321/", entity_type="asset")  # spare_part by default
    sp = admin.get(f"{API}/assets/{a['id']}/spare-parts").json
    assert (
        sp["parts"][0]["name"] == "Filter 20x20"
        and sp["parts"][0]["on_hand"].startswith("1")
        and sp["parts"][0]["link"]["supplier_name"] == "McMaster-Carr"
    )
    assert sp["purchased_from"][0]["title"] == "Original unit" and len(sp["spare_links"]) == 1
    assert (
        admin.post(
            f"{API}/product-links",
            {"entity_type": "part", "entity_id": pid, "url": "https://www.zoro.com/i/G1/", "role": "spare_part"},
        ).status_code
        == 422
    )


def test_search_by_supplier_number(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app, "Drive belt")
    link(admin, pid, "https://www.grainger.com/product/1A120", mpn="4L360-X")
    groups = admin.get(f"{API}/search?q=4l360-x").json["groups"]
    hit = next(g for g in groups if g["type"] == "supplier_products")
    assert hit["results"][0]["url"] == f"/parts/{pid}" and "Grainger" in hit["results"][0]["subtitle"]


def test_other_organizations_and_roles(admin: Api, app: Any, net: FakeNet) -> None:
    pid = make_part(app)
    net.add("https://www.grainger.com/product/1A120", PAGE_JSONLD)
    lk = link(admin, pid, "https://www.grainger.com/product/1A120")
    conn = admin.post(
        f"{API}/supplier-connections",
        {"connector": "mcmaster", "settings": {"username": "u"}, "secrets": {"password": "p"}},
    ).json
    site = admin.post(f"{API}/supplier-sites", {"name": "Acme", "domains": ["acme.example"]}).json
    a = asset(admin, "Pump 9")
    other = other_org(app)
    assert other.get(f"{API}/product-links/{lk['id']}").status_code == 404
    assert other.patch(f"{API}/product-links/{lk['id']}", {"note": "x"}).status_code == 404
    assert other.delete(f"{API}/product-links/{lk['id']}").status_code == 404
    assert other.post(f"{API}/product-links/{lk['id']}/refresh").status_code == 404
    assert other.post(f"{API}/product-links/{lk['id']}/reorder", {}).status_code == 404
    assert other.get(f"{API}/product-links/{lk['id']}/po-line").status_code == 404
    assert other.get(f"{API}/product-links?entity_type=part&entity_id={pid}").status_code == 404
    assert other.get(f"{API}/product-links/compare?entity_type=part&entity_id={pid}").status_code == 404
    assert (
        other.post(
            f"{API}/product-links", {"entity_type": "part", "entity_id": pid, "url": "https://www.zoro.com/i/G1/"}
        ).status_code
        == 404
    )
    assert other.get(f"{API}/products/{lk['product']['id']}").status_code == 404
    assert other.get(f"{API}/products/{lk['product']['id']}/prices").status_code == 404
    assert other.get(f"{API}/assets/{a['id']}/spare-parts").status_code == 404
    assert other.patch(f"{API}/supplier-connections/{conn['id']}", {"name": "x"}).status_code == 404
    assert other.post(f"{API}/supplier-connections/{conn['id']}/test").status_code == 404
    assert other.delete(f"{API}/supplier-connections/{conn['id']}").status_code == 404
    assert other.post(f"{API}/punchout/start", {"connection_id": conn["id"]}).status_code == 404
    assert other.patch(f"{API}/supplier-sites/{site['id']}", {"name": "x"}).status_code == 404
    assert other.delete(f"{API}/supplier-sites/{site['id']}").status_code == 404
    assert other.get(f"{API}/supplier-connections").json["items"] == []
    assert other.post(f"{API}/suppliers/recognize", {"url": "https://acme.example/i/1"}).json["supplier_key"] == "other"
    if lk["product"]["image_url"]:
        assert other.get(lk["product"]["image_url"]).status_code in (403, 404)
    viewer = member(app, "viewer-sup@example.com", "viewer", admin)
    assert viewer.get(f"{API}/product-links?entity_type=part&entity_id={pid}").status_code == 200
    assert (
        viewer.post(
            f"{API}/product-links", {"entity_type": "part", "entity_id": pid, "url": "https://www.zoro.com/i/G1/"}
        ).status_code
        == 403
    )
    assert viewer.get(f"{API}/product-links/{lk['id']}").json["last_paid_price"] is None  # no cost visibility
    tech = member(app, "tech-sup2@example.com", "technician", admin)
    assert tech.get(f"{API}/supplier-connections").status_code == 403
    assert (
        tech.post(
            f"{API}/product-links", {"entity_type": "part", "entity_id": pid, "url": "https://www.zoro.com/i/G2/"}
        ).status_code
        == 201
    )


def test_demo_products(app: Any) -> None:
    from tests.test_vendors import seed_demo_records

    seed_demo_records(app)  # vendors, parts, purchasing, the way the demo does
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.demo import DEMO_EMAIL
        from mpro.extensions import db
        from mpro.orgs.models import Organization
        from mpro.suppliers.demo import seed_suppliers
        from mpro.suppliers.models import Product, ProductLink

        admin = db.session.scalars(select(User).where(User.email == DEMO_EMAIL)).one()
        org = db.session.scalars(select(Organization).where(Organization.slug == "acme-demo")).one()
        seed_suppliers(org, admin)
        db.session.commit()
        rows = db.session.scalars(select(Product).where(Product.org_id == org.id)).all()
        assert any(p.availability == "discontinued" and p.replacement_url for p in rows)
        links = db.session.scalars(select(ProductLink).where(ProductLink.org_id == org.id)).all()
        assert "listing" in {x.role for x in links}  # assets (purchased_from) only exist with demo work


def test_base64_cxml_and_quote_helper() -> None:
    from mpro.suppliers.punchout import order_message_from_form

    raw = b"<cXML/>"
    assert order_message_from_form({"cxml-base64": base64.b64encode(raw).decode()}) == raw
    assert quote("a b") == "a%20b"
