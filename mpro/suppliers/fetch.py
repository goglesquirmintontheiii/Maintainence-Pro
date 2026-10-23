"""Reading product details from supplier pages (MP-085, roadmap r213). Server-side only, standard library only.

Safety (pages are untrusted input from the internet):
- only http/https, ports 80/443 (or the URL's explicit port if public), no credentials in URLs;
- every host is resolved and refused if any address is private, loopback, link-local, multicast or reserved, and
  redirects are followed by hand (at most 5) with the same check each time;
- the connection dials the exact address that was checked (Host header and TLS SNI/certificate stay the host
  name), so a DNS answer that changes between the check and the connection (DNS rebinding) can't reach an
  internal address. Exception: when an outbound proxy is configured for the host (HTTPS_PROXY…), the proxy
  resolves the name, and the proxy's own egress rules apply;
- responses are capped (2 MB pages, 5 MB images) and time-limited;
- robots.txt is respected for our User-Agent; requests to one domain are spaced out;
- only plain text fields are kept from the HTML; nothing from the page is ever rendered as HTML.

The HTTP layer is replaceable (`set_transport`) so tests never touch the network.
"""

from __future__ import annotations

import html
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
import urllib.robotparser
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

from mpro import __version__

USER_AGENT = f"MaintenancePro/{__version__} (+product-cards; self-hosted CMMS)"
PAGE_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 5 * 1024 * 1024
TIMEOUT = 15.0
MAX_REDIRECTS = 5
DOMAIN_SPACING = 5.0  # seconds between requests to the same domain (per process)


class FetchError(Exception):
    """Can't read the page. `kind` is "blocked" (the site or our rules don't allow it) or "failed"."""

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class Response:
    status: int
    url: str
    headers: dict[str, str]
    body: bytes


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None, limit: int) -> Response: ...


# ---------------------------------------------------------------- address checks (SSRF)


def _ip_ok(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified)


Resolver = Callable[[str], list[str]]


def _resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({str(i[4][0]) for i in infos})


_resolver: Resolver = _resolve


def check_url(url: str) -> str:
    """Refuse URLs we must never fetch (raises FetchError(kind="blocked")); returns the checked address to dial."""
    p = urlsplit(url)
    if p.scheme not in ("http", "https"):
        raise FetchError("Only web links (http or https) can be read.", "blocked")
    if p.username or p.password:
        raise FetchError("Links with a user name or password can't be read.", "blocked")
    host = p.hostname or ""
    if not host:
        raise FetchError("That link has no web address.", "blocked")
    try:
        port = p.port
    except ValueError as e:
        raise FetchError("That link has a bad port.", "blocked") from e
    if port not in (None, 80, 443, 8080, 8443):
        raise FetchError("Only standard web ports can be read.", "blocked")
    if host.lower() in ("localhost",) or host.lower().endswith((".local", ".internal", ".localhost")):
        raise FetchError("That address is on a private network.", "blocked")
    return checked_address(host)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------- the real transport


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a: Any, **k: Any) -> None:
        return None


def checked_address(host: str) -> str:
    """Resolve once, refuse private/internal answers, and return the address to dial (DNS rebinding safe)."""
    try:
        ips = [host] if _is_ip(host) else _resolver(host)
    except OSError as e:
        raise FetchError("That web address can't be found.") from e
    if not ips or not all(_ip_ok(ip) for ip in ips):
        raise FetchError("That address is on a private network.", "blocked")
    return ips[0]


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, ip: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, ip: str, timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self._ip = ip
        self._ctx = context

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        # SNI and certificate checks use the host name, not the address
        self.sock = self._ctx.wrap_socket(sock, server_hostname=self.host)


def _proxied(url: str) -> bool:
    p = urlsplit(url)
    proxies = urllib.request.getproxies()
    return bool(proxies.get(p.scheme)) and not urllib.request.proxy_bypass(p.hostname or "")


def pinned_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    limit: int,
    *,
    context: ssl.SSLContext | None = None,
    timeout: float = TIMEOUT,
) -> Response:
    """One request to the checked address of `url`'s host; never follows redirects."""
    ip = check_url(url)  # resolved once; this exact address is dialed
    p = urlsplit(url)
    host = p.hostname or ""
    port = p.port or (443 if p.scheme == "https" else 80)
    conn: http.client.HTTPConnection
    if p.scheme == "https":
        conn = _PinnedHTTPS(host, port, ip, timeout, context or ssl.create_default_context())
    else:
        conn = _PinnedHTTP(host, port, ip, timeout)
    path = (p.path or "/") + (f"?{p.query}" if p.query else "")
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read(limit + 1)
    except (TimeoutError, OSError, http.client.HTTPException) as e:
        raise FetchError(f"The site didn't answer ({type(e).__name__}).") from e
    finally:
        conn.close()
    if len(data) > limit:
        raise FetchError("The page is too large to read.")
    return Response(int(resp.status or 0), url, {k.lower(): v for k, v in resp.getheaders()}, data)


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None, limit: int) -> Response:
    """One request, no automatic redirects. Dials the checked address directly; when an outbound proxy is set for
    this host (HTTPS_PROXY…) the request goes through the proxy instead."""
    if not _proxied(url):
        return pinned_request(method, url, headers, body, limit)
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        resp = opener.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        resp = e  # 3xx/4xx/5xx: still a response
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FetchError(f"The site didn't answer ({type(e).__name__}).") from e
    try:
        data = resp.read(limit + 1)
    except (TimeoutError, OSError) as e:
        raise FetchError("The site stopped answering.") from e
    if len(data) > limit:
        raise FetchError("The page is too large to read.")
    return Response(int(resp.status or 0), url, {k.lower(): v for k, v in resp.headers.items()}, data)


_transport: Transport = urllib_transport
_lock = threading.Lock()
_last_hit: dict[str, float] = {}
_robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser]] = {}
spacing = DOMAIN_SPACING


def set_transport(t: Transport | None, resolver: Resolver | None = None, domain_spacing: float | None = None) -> None:
    """Replace the network layer (tests). `None` restores the real one."""
    global _transport, _resolver, spacing
    _transport = t or urllib_transport
    _resolver = resolver or _resolve
    spacing = DOMAIN_SPACING if domain_spacing is None else domain_spacing
    _last_hit.clear()
    _robots.clear()


def _space(host: str) -> None:
    with _lock:
        wait = _last_hit.get(host, 0.0) + spacing - time.monotonic()
        _last_hit[host] = max(time.monotonic(), _last_hit.get(host, 0.0) + spacing)
    if wait > 0:
        time.sleep(min(wait, spacing))


def _robots_ok(url: str) -> bool:
    p = urlsplit(url)
    base = f"{p.scheme}://{p.netloc}"
    cached = _robots.get(base)
    if cached is None or time.monotonic() - cached[0] > 24 * 3600:
        rp = urllib.robotparser.RobotFileParser()
        lines: list[str] = []
        try:
            r = get(base + "/robots.txt", limit=256 * 1024, check_robots=False)
            if r.status == 200:
                lines = r.body.decode("utf-8", "replace").splitlines()
            # RFC 9309: 4xx (no robots.txt) allows everything; 5xx / unreachable means "don't" for now
            elif r.status >= 500:
                lines = ["User-agent: *", "Disallow: /"]
        except FetchError:
            lines = ["User-agent: *", "Disallow: /"]
        rp.parse(lines)
        _robots[base] = (time.monotonic(), rp)
        cached = _robots[base]
    return cached[1].can_fetch(USER_AGENT, url)


def get(
    url: str, *, limit: int = PAGE_LIMIT, accept: str = "text/html,application/xhtml+xml", check_robots: bool = True
) -> Response:
    """GET with the safety rules above; follows redirects by hand."""
    for _ in range(MAX_REDIRECTS + 1):
        check_url(url)
        if check_robots and not _robots_ok(url):
            raise FetchError("This site asks automatic readers not to read this page.", "blocked")
        _space(urlsplit(url).hostname or "")
        r = _transport("GET", url, {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "en"}, None, limit)
        if r.status in (301, 302, 303, 307, 308):
            loc = r.headers.get("location", "")
            if not loc:
                raise FetchError("The site sent a broken redirect.")
            url = urljoin(url, loc)
            continue
        return r
    raise FetchError("Too many redirects.")


# ---------------------------------------------------------------- parsing


@dataclass
class ProductInfo:
    title: str = ""
    brand: str = ""
    image_url: str = ""
    price: Decimal | None = None
    currency: str = ""
    price_unit: str = ""
    availability: str = ""  # in_stock | out_of_stock | limited | discontinued | ""
    sku: str = ""
    mpn: str = ""
    replacement_url: str = ""
    specs: dict[str, str] = field(default_factory=dict)
    source: str = ""  # api | jsonld | opengraph | title
    url: str = ""

    def empty(self) -> bool:
        return not (self.title or self.price is not None or self.image_url)


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.jsonld: list[str] = []
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_ld = False
        self._in_title = False
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "script" and a.get("type", "").lower().strip() == "application/ld+json":
            self._in_ld, self._buf = True, []
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower().strip()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "title":
            self._in_title, self._buf = True, []
        elif tag == "link" and a.get("itemprop", "").lower() == "availability" and "availability" not in self.meta:
            self.meta["availability"] = a.get("href", "")

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_ld:
            self.jsonld.append("".join(self._buf))
            self._in_ld = False
        elif tag == "title" and self._in_title:
            self.title = "".join(self._buf)
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_ld or self._in_title:
            self._buf.append(data)


def _text(v: Any, n: int = 500) -> str:
    if isinstance(v, dict):
        v = v.get("name") or v.get("@value") or ""
    if isinstance(v, list):
        v = v[0] if v else ""
    s = html.unescape(str(v or ""))
    s = re.sub(r"<[^>]*>", " ", s)
    return re.sub(r"\s+", " ", s).strip()[:n]


def money(v: Any) -> Decimal | None:
    if v is None or v == "":
        return None
    s = re.sub(r"[^\d.,-]", "", str(v))
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif "," in s and len(s.split(",")[-1]) == 2:
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d.is_finite() and d >= 0 else None


def availability(v: Any) -> str:
    s = _text(v, 200).lower().replace("https://schema.org/", "").replace("http://schema.org/", "")
    s = re.sub(r"[\s_-]+", "", s)
    if not s:
        return ""
    if "discontinued" in s:
        return "discontinued"
    if "outofstock" in s or "soldout" in s or "unavailable" in s:
        return "out_of_stock"
    if "limited" in s or "backorder" in s or "preorder" in s:
        return "limited"
    if "instock" in s or "available" in s:
        return "in_stock"
    return ""


def _walk(node: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(node, list):
        for n in node:
            out += _walk(n)
    elif isinstance(node, dict):
        t = node.get("@type")
        types = [str(x).lower() for x in (t if isinstance(t, list) else [t])]
        if "product" in types or "productgroup" in types:
            out.append(node)
        for k in ("@graph", "mainEntity", "itemListElement", "item"):
            if k in node:
                out += _walk(node[k])
    return out


def _from_jsonld(blocks: list[str]) -> ProductInfo | None:
    for raw in blocks:
        try:
            data = json.loads(raw.strip().rstrip(";"))
        except (ValueError, RecursionError):
            continue
        for p in _walk(data):
            info = ProductInfo(source="jsonld")
            info.title = _text(p.get("name"))
            info.brand = _text(p.get("brand"), 200)
            img = p.get("image")
            if isinstance(img, list):
                img = img[0] if img else ""
            if isinstance(img, dict):
                img = img.get("url") or img.get("contentUrl") or ""
            info.image_url = str(img or "")[:1000]
            info.sku = _text(p.get("sku"), 120)
            info.mpn = _text(p.get("mpn"), 120)
            offers = p.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            if isinstance(offers, dict):
                if str(offers.get("@type", "")).lower() == "aggregateoffer":
                    info.price = money(offers.get("lowPrice") or offers.get("price"))
                else:
                    info.price = money(offers.get("price") or (offers.get("priceSpecification") or {}).get("price"))
                info.currency = _text(
                    offers.get("priceCurrency") or (offers.get("priceSpecification") or {}).get("priceCurrency"), 3
                ).upper()
                info.availability = availability(offers.get("availability"))
                unit = (
                    (offers.get("priceSpecification") or {}).get("unitText")
                    if isinstance(offers.get("priceSpecification"), dict)
                    else ""
                )
                info.price_unit = _text(unit, 60)
            for prop in p.get("additionalProperty") or []:
                if isinstance(prop, dict) and prop.get("name"):
                    info.specs[_text(prop.get("name"), 80)] = _text(prop.get("value"), 200)
                if len(info.specs) >= 40:
                    break
            if not info.empty():
                return info
    return None


def parse_page(body: bytes, url: str, content_type: str = "") -> ProductInfo:
    """Product details from a page: JSON-LD first, then Open Graph / product meta tags, then the title."""
    m = re.search(r"charset=([\w-]+)", content_type or "")
    text = body.decode(m.group(1) if m else "utf-8", "replace")
    p = _HeadParser()
    try:
        p.feed(text[:PAGE_LIMIT])
        p.close()
    except Exception:  # noqa: BLE001  (broken HTML still yields what was parsed)
        pass
    info = _from_jsonld(p.jsonld)
    meta = p.meta
    if info is None:
        og_title = meta.get("og:title") or meta.get("twitter:title") or ""
        price = money(meta.get("product:price:amount") or meta.get("og:price:amount") or meta.get("price"))
        if og_title or price is not None:
            info = ProductInfo(source="opengraph")
            info.title = _text(og_title)
            info.price = price
            info.currency = _text(
                meta.get("product:price:currency") or meta.get("og:price:currency") or meta.get("pricecurrency"), 3
            ).upper()
            info.availability = availability(
                meta.get("product:availability") or meta.get("og:availability") or meta.get("availability")
            )
            info.brand = _text(meta.get("product:brand") or meta.get("og:brand") or meta.get("brand"), 200)
            info.image_url = meta.get("og:image") or meta.get("twitter:image") or ""
        else:
            info = ProductInfo(source="title", title=_text(p.title))
    if not info.image_url:
        info.image_url = meta.get("og:image", "")
    if info.image_url:
        info.image_url = urljoin(url, info.image_url.strip())[:1000]
        if not info.image_url.startswith(("http://", "https://")):
            info.image_url = ""
    info.url = url
    return info


def fetch_product(url: str) -> ProductInfo:
    r = get(url)
    if r.status in (401, 403, 429, 503):
        raise FetchError("The site doesn't let automatic readers see this page.", "blocked")
    if r.status == 404:
        raise FetchError("The page wasn't found. The product may have been removed.")
    if r.status >= 400:
        raise FetchError(f"The site answered with an error ({r.status}).")
    ctype = r.headers.get("content-type", "")
    if ctype and "html" not in ctype.lower() and "xml" not in ctype.lower():
        raise FetchError("That link isn't a web page.")
    return parse_page(r.body, r.url, ctype)


IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}


def fetch_image(url: str) -> tuple[bytes, str]:
    """An image for a product card. Checked to really be an image (Pillow) before it's stored."""
    r = get(url, limit=IMAGE_LIMIT, accept="image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5", check_robots=False)
    if r.status >= 400:
        raise FetchError(f"The image couldn't be downloaded ({r.status}).")
    import io

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(r.body)) as im:
            fmt = (im.format or "").lower()
            im.verify()
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise FetchError("That isn't a picture.") from e
    ext = {"jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif", "avif": "avif"}.get(fmt)
    if not ext:
        raise FetchError("That picture type isn't supported.")
    return r.body, ext
