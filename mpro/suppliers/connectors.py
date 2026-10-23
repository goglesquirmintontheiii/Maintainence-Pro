"""Official supplier API connectors (MP-086).

Interface: a connector reads product details for a URL or SKU with an organization's own account.

    conn = connector_for(connection)          # SupplierConnection -> Connector
    info = conn.lookup("https://www.amazon.com/dp/B0…")   # ProductInfo
    conn.test()                                # raises ConnectorError with a plain message

Built from the suppliers' public documentation; both need the organization's own account, so neither has been tried
against the live service from here (the UI says "needs your account to try"):

- Amazon **Creators API** (replaces PA-API 5): OAuth client credentials at the regional token endpoint
  (`api.amazon.com/auth/o2/token` NA, `api.amazon.co.uk` EU, `api.amazon.co.jp` FE; scope `creatorsapi::default`),
  then `POST https://creatorsapi.amazon/catalog/v1/getItems` with `Authorization: Bearer`, `x-marketplace` header and
  `{itemIds, itemIdType: "ASIN", marketplace, partnerTag, resources}`. Title is `itemInfo.title.displayValue` and the
  image `images.primary.<size>.url` (documented). Offer fields (`offersV2.listings[].price…`, availability) aren't
  shown in the public example; they're read defensively and left empty if absent.
- **McMaster-Carr Product Information API** (approved customers): client certificate on every request,
  `POST /v1/login {UserName, Password}` → `AuthToken` (24 h), `PUT /v1/products {URL}` to subscribe,
  `GET /v1/products/{part}` (ProductStatus, FamilyDescription, DetailDescription, Specifications, Links incl.
  Price / Image / SuggestedProduct), `GET /v1/products/{part}/price` → [{Amount, MinimumQuantity, UnitOfMeasure}].

The HTTP layer is injectable (`http=`) so tests use fake transports; the default goes through `fetch.urllib_transport`
plus the same address checks as page reading.
"""

from __future__ import annotations

import json
import os
import ssl
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from mpro.core.crypto import decrypt_json
from mpro.suppliers import fetch as fetch_mod
from mpro.suppliers.fetch import ProductInfo, availability, money

HTTP = Callable[[str, str, dict[str, str], bytes | None], tuple[int, dict[str, Any] | list[Any] | None]]


class ConnectorError(Exception):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ConnectorSpec:
    key: str
    name: str
    supplier_key: str
    fields: list[dict[str, Any]]  # settings form: {"name", "label", "secret", "type", "options"?}
    docs: str
    kind: str = "api"  # api | punchout


SPECS: dict[str, ConnectorSpec] = {
    "amazon_creators": ConnectorSpec(
        "amazon_creators",
        "Amazon Creators API",
        "amazon",
        [
            {"name": "credential_id", "label": "Credential ID (client id)", "secret": False},
            {"name": "credential_secret", "label": "Credential secret", "secret": True},
            {
                "name": "region",
                "label": "Credential version",
                "secret": False,
                "type": "select",
                "options": [["3.1", "3.1 North America"], ["3.2", "3.2 Europe"], ["3.3", "3.3 Far East"]],
            },
            {"name": "marketplace", "label": "Marketplace", "secret": False, "placeholder": "www.amazon.com"},
            {
                "name": "partner_tag",
                "label": "Partner tag (Associates)",
                "secret": False,
                "placeholder": "yourstore-20",
            },
        ],
        "Needs an Amazon Associates account with Creators API access. PA-API 5 was retired and returns 403.",
    ),
    "mcmaster": ConnectorSpec(
        "mcmaster",
        "McMaster-Carr Product Information API",
        "mcmaster",
        [
            {"name": "username", "label": "API user name", "secret": False},
            {"name": "password", "label": "API password", "secret": True},
            {"name": "certificate", "label": "Client certificate (.pfx, base64)", "secret": True, "type": "file"},
            {"name": "certificate_password", "label": "Certificate password", "secret": True},
        ],
        "For approved McMaster-Carr customers. McMaster-Carr issues the client certificate and password. Each product "
        "is subscribed automatically before it's looked up.",
    ),
    "punchout_cxml": ConnectorSpec(
        "punchout_cxml",
        "PunchOut catalog (cXML)",
        "",
        [
            {
                "name": "setup_url",
                "label": "PunchOut setup URL",
                "secret": False,
                "placeholder": "https://supplier.example/punchout",
            },
            {"name": "from_identity", "label": "Your identity (From)", "secret": False},
            {"name": "to_identity", "label": "Supplier identity (To)", "secret": False},
            {"name": "sender_identity", "label": "Sender identity", "secret": False},
            {"name": "domain", "label": "Credential domain", "secret": False, "placeholder": "NetworkID"},
            {"name": "shared_secret", "label": "Shared secret", "secret": True},
        ],
        "Your supplier's e-procurement team gives you these (Grainger, McMaster-Carr, Fastenal, MSC, Uline and "
        "Amazon Business offer PunchOut to business accounts).",
        "punchout",
    ),
    "punchout_oci": ConnectorSpec(
        "punchout_oci",
        "PunchOut catalog (OCI)",
        "",
        [
            {"name": "setup_url", "label": "Catalog URL", "secret": False},
            {"name": "username", "label": "User name", "secret": False},
            {"name": "password", "label": "Password", "secret": True},
        ],
        "SAP OCI catalogs: the supplier sends the cart back to MPro when you're done shopping.",
        "punchout",
    ),
}


def _default_http(cert: tuple[str, str | None] | None = None) -> HTTP:
    def call(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, Any]:
        ctx = ssl.create_default_context()
        if cert:
            ctx.load_cert_chain(cert[0], password=cert[1])
        try:
            # dials the checked address (DNS rebinding safe) and never follows redirects
            r = fetch_mod.pinned_request(method, url, headers, body, 4 * 1024 * 1024, context=ctx, timeout=20)
        except fetch_mod.FetchError as e:
            raise ConnectorError(f"Couldn't reach the supplier: {e}") from e
        raw, status = r.body, r.status
        try:
            return status, json.loads(raw) if raw else None
        except ValueError:
            return status, None

    return call


class Connector:
    spec: ConnectorSpec

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any], http: HTTP | None = None) -> None:
        self.settings = settings or {}
        self.secrets = secrets or {}
        self.http = http

    def lookup(self, url_or_sku: str) -> ProductInfo:
        raise NotImplementedError

    def test(self) -> None:
        raise NotImplementedError


# ---------------------------------------------------------------- Amazon Creators API

AMAZON_TOKEN_URLS = {
    "3.1": "https://api.amazon.com/auth/o2/token",
    "3.2": "https://api.amazon.co.uk/auth/o2/token",
    "3.3": "https://api.amazon.co.jp/auth/o2/token",
}
AMAZON_GET_ITEMS = "https://creatorsapi.amazon/catalog/v1/getItems"
AMAZON_RESOURCES = [
    "itemInfo.title",
    "itemInfo.byLineInfo",
    "itemInfo.externalIds",
    "images.primary.large",
    "offersV2.listings.price",
    "offersV2.listings.availability",
]


class AmazonCreators(Connector):
    spec = SPECS["amazon_creators"]
    _token: tuple[str, float] | None = None

    def _http(self) -> HTTP:
        return self.http or _default_http()

    def _access_token(self) -> str:
        if self._token and self._token[1] > time.time() + 60:
            return self._token[0]
        cid, secret = self.settings.get("credential_id"), self.secrets.get("credential_secret")
        if not cid or not secret:
            raise ConnectorError("Add the credential ID and secret first.")
        url = AMAZON_TOKEN_URLS.get(str(self.settings.get("region") or "3.1"), AMAZON_TOKEN_URLS["3.1"])
        body = json.dumps(
            {
                "grant_type": "client_credentials",
                "client_id": cid,
                "client_secret": secret,
                "scope": "creatorsapi::default",
            }
        ).encode()
        status, data = self._http()("POST", url, {"Content-Type": "application/json"}, body)
        if status != 200 or not isinstance(data, dict) or not data.get("access_token"):
            raise ConnectorError("Amazon didn't accept the credentials. Check the ID, secret and version.", status)
        self._token = (str(data["access_token"]), time.time() + float(data.get("expires_in") or 3600))
        return self._token[0]

    def get_items(self, asins: list[str]) -> list[dict[str, Any]]:
        market = str(self.settings.get("marketplace") or "www.amazon.com")
        tag = str(self.settings.get("partner_tag") or "")
        if not tag:
            raise ConnectorError("Add your Associates partner tag.")
        body = json.dumps(
            {
                "itemIds": asins[:10],
                "itemIdType": "ASIN",
                "marketplace": market,
                "partnerTag": tag,
                "resources": AMAZON_RESOURCES,
            }
        ).encode()
        headers = {
            "Authorization": f"Bearer {self._access_token()}",
            "Content-Type": "application/json",
            "x-marketplace": market,
        }
        status, data = self._http()("POST", AMAZON_GET_ITEMS, headers, body)
        if status == 429:
            raise ConnectorError("Amazon is limiting requests right now. Try again later.", status)
        if status != 200 or not isinstance(data, dict):
            msg = ""
            if isinstance(data, dict):
                errs = data.get("errors") or []
                msg = (errs[0].get("message") if errs and isinstance(errs[0], dict) else "") or str(
                    data.get("message") or ""
                )
            raise ConnectorError(f"Amazon answered with an error ({status}){': ' + msg if msg else ''}.", status)
        return list(((data.get("itemsResult") or {}).get("items")) or [])

    def lookup(self, url_or_sku: str) -> ProductInfo:
        from mpro.suppliers.recognize import recognize

        asin = url_or_sku.strip().upper()
        if "/" in url_or_sku or "." in url_or_sku:
            asin = recognize(url_or_sku).external_id
        if not asin:
            raise ConnectorError("That isn't an Amazon product link.")
        items = self.get_items([asin])
        if not items:
            raise ConnectorError("Amazon didn't return that product.")
        return amazon_item_info(items[0])

    def test(self) -> None:
        self._access_token()


def _dig(d: Any, *path: str | int) -> Any:
    for p in path:
        if isinstance(p, int):
            d = d[p] if isinstance(d, list) and len(d) > p else None
        else:
            d = d.get(p) if isinstance(d, dict) else None
        if d is None:
            return None
    return d


def amazon_item_info(item: dict[str, Any]) -> ProductInfo:
    info = ProductInfo(source="api")
    info.title = str(_dig(item, "itemInfo", "title", "displayValue") or "")[:500]
    info.brand = str(_dig(item, "itemInfo", "byLineInfo", "brand", "displayValue") or "")[:200]
    for size in ("large", "medium", "small"):
        u = _dig(item, "images", "primary", size, "url")
        if u:
            info.image_url = str(u)
            break
    listing = _dig(item, "offersV2", "listings", 0) or {}
    price = _dig(listing, "price", "money") or _dig(listing, "price") or {}
    if isinstance(price, dict):
        info.price = money(price.get("amount") if price.get("amount") is not None else price.get("displayAmount"))
        info.currency = str(price.get("currency") or "")[:3].upper()
    info.availability = availability(_dig(listing, "availability", "type") or _dig(listing, "availability", "message"))
    info.sku = str(item.get("asin") or "")
    info.url = str(item.get("detailPageURL") or "")
    return info


# ---------------------------------------------------------------- McMaster-Carr

MCMASTER = "https://api.mcmaster.com/v1"


class McMaster(Connector):
    spec = SPECS["mcmaster"]
    _token: tuple[str, float] | None = None
    _certfile: str | None = None

    def _cert(self) -> tuple[str, str | None] | None:
        pfx_b64 = self.secrets.get("certificate")
        if not pfx_b64:
            return None
        if self._certfile and os.path.exists(self._certfile):
            return self._certfile, None
        import base64

        from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, pkcs12

        try:
            key, cert, extra = pkcs12.load_key_and_certificates(
                base64.b64decode(pfx_b64), (self.secrets.get("certificate_password") or "").encode() or None
            )
        except Exception as e:  # noqa: BLE001
            raise ConnectorError("The client certificate or its password isn't right.") from e
        if key is None or cert is None:
            raise ConnectorError("The client certificate has no private key.")
        pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()) + cert.public_bytes(Encoding.PEM)
        for c in extra or []:
            pem += c.public_bytes(Encoding.PEM)
        fd, path = tempfile.mkstemp(prefix="mpro-mcm-", suffix=".pem")
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        os.chmod(path, 0o600)
        self._certfile = path
        return path, None

    def _http(self) -> HTTP:
        return self.http or _default_http(self._cert())

    def _login(self) -> str:
        if self._token and self._token[1] > time.time() + 300:
            return self._token[0]
        user, pw = self.settings.get("username"), self.secrets.get("password")
        if not user or not pw:
            raise ConnectorError("Add the API user name and password first.")
        body = json.dumps({"UserName": user, "Password": pw}).encode()
        status, data = self._http()("POST", f"{MCMASTER}/login", {"Content-Type": "application/json"}, body)
        if status != 200 or not isinstance(data, dict) or not data.get("AuthToken"):
            raise ConnectorError("McMaster-Carr didn't accept the login or the certificate.", status)
        self._token = (str(data["AuthToken"]), time.time() + 23 * 3600)
        return self._token[0]

    def _call(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
        headers = {"Authorization": f"Bearer {self._login()}", "Content-Type": "application/json"}
        return self._http()(method, f"{MCMASTER}{path}", headers, json.dumps(payload).encode() if payload else None)

    def lookup(self, url_or_sku: str) -> ProductInfo:
        from mpro.suppliers.recognize import recognize

        part = url_or_sku.strip()
        if "/" in part or "." in part:
            part = recognize(part).external_id
        if not part:
            raise ConnectorError("That isn't a McMaster-Carr part link.")
        status, data = self._call("GET", f"/products/{part}")
        if status == 403:  # not subscribed yet
            status, data = self._call("PUT", "/products", {"URL": f"https://mcmaster.com/{part}"})
        if status not in (200, 201) or not isinstance(data, dict):
            raise ConnectorError(f"McMaster-Carr didn't return that part ({status}).", status)
        info = mcmaster_product_info(data)
        pstatus, prices = self._call("GET", f"/products/{part}/price")
        if pstatus == 200 and isinstance(prices, list) and prices:
            first = min(prices, key=lambda p: float(p.get("MinimumQuantity") or 1) if isinstance(p, dict) else 1)
            if isinstance(first, dict):
                info.price = money(first.get("Amount"))
                info.currency = "USD"
                info.price_unit = str(first.get("UnitOfMeasure") or "")[:60]
        return info

    def test(self) -> None:
        self._login()


def mcmaster_product_info(data: dict[str, Any]) -> ProductInfo:
    info = ProductInfo(source="api")
    part = str(data.get("PartNumber") or "")
    info.sku = part
    info.mpn = part
    info.title = " ".join(
        x for x in (str(data.get("FamilyDescription") or ""), str(data.get("DetailDescription") or "")) if x
    )[:500]
    info.brand = "McMaster-Carr"
    for s in data.get("Specifications") or []:
        if isinstance(s, dict) and s.get("Attribute"):
            vals = s.get("Values") or []
            info.specs[str(s["Attribute"])[:80]] = (
                ", ".join(str(v) for v in vals)[:200] if isinstance(vals, list) else str(vals)[:200]
            )
        if len(info.specs) >= 40:
            break
    links = {str(link.get("Key")): str(link.get("Value")) for link in data.get("Links") or [] if isinstance(link, dict)}
    # McMaster-Carr images need the signed-in session (Links → Image); the card shows the part without one for now
    if links.get("Image"):
        info.specs.setdefault("_image_path", links["Image"][:300])
    status = str(data.get("ProductStatus") or "").lower()
    if "discontinued" in status:
        info.availability = "discontinued"
        sug = links.get("SuggestedProduct", "")
        info.replacement_url = sug if sug.startswith("http") else (f"https://www.mcmaster.com{sug}" if sug else "")
    elif status:
        info.availability = "in_stock"
    info.url = f"https://www.mcmaster.com/{part}" if part else ""
    return info


CONNECTORS: dict[str, type[Connector]] = {"amazon_creators": AmazonCreators, "mcmaster": McMaster}


def connector_for(connection: Any, http: HTTP | None = None) -> Connector:
    cls = CONNECTORS.get(connection.connector)
    if cls is None:
        raise ConnectorError("This connection doesn't read product details.")
    return cls(dict(connection.settings or {}), decrypt_json(connection.secrets) or {}, http=http)
