"""Recognise a supplier and its product id from a pasted URL (MP-084).

Built-in patterns come from `suppliers.json`; an organization's own `SupplierSite` rows are checked first, so they can
also override a built-in supplier. Matching is on the host (exact or any subdomain) and then regexes with a named
group `id` against the path (and then path + query).
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select

from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.suppliers.models import SupplierSite

GENERIC = "other"  # unknown site: still linkable, the card is built from the page or what the user typed


@dataclass
class Supplier:
    key: str
    name: str
    domains: list[str]
    id_patterns: list[str]
    id_label: str = "Item #"
    product_url: str = ""
    category: str = ""
    connector: str = ""
    needs_resolving: bool = False
    resolves_to: str = ""
    builtin: bool = True
    vendor_id: str | None = None
    _compiled: list[re.Pattern[str]] = field(default_factory=list, repr=False)

    def compiled(self) -> list[re.Pattern[str]]:
        if not self._compiled:
            for p in self.id_patterns:
                try:
                    self._compiled.append(re.compile(p, re.IGNORECASE if "asin" in p.lower() else 0))
                except re.error:
                    continue
        return self._compiled

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "category": self.category,
            "domains": self.domains,
            "id_label": self.id_label,
            "connector": self.connector,
            "builtin": self.builtin,
            "vendor_id": self.vendor_id,
        }


@dataclass
class Match:
    supplier_key: str
    supplier_name: str
    external_id: str
    id_label: str
    url: str  # cleaned URL (tracking parameters removed)
    canonical_url: str
    needs_resolving: bool = False
    connector: str = ""
    vendor_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "supplier_key": self.supplier_key,
            "supplier_name": self.supplier_name,
            "external_id": self.external_id,
            "id_label": self.id_label,
            "url": self.url,
            "canonical_url": self.canonical_url,
            "needs_resolving": self.needs_resolving,
            "connector": self.connector,
            "vendor_id": self.vendor_id,
        }


@lru_cache(maxsize=1)
def builtin_suppliers() -> tuple[Supplier, ...]:
    data = json.loads((Path(__file__).parent / "suppliers.json").read_text(encoding="utf-8"))
    return tuple(
        Supplier(
            key=s["key"],
            name=s["name"],
            domains=[d.lower() for d in s.get("domains", [])],
            id_patterns=list(s.get("id_patterns", [])),
            id_label=s.get("id_label", "Item #"),
            product_url=s.get("product_url", ""),
            category=s.get("category", ""),
            connector=s.get("connector", ""),
            needs_resolving=bool(s.get("needs_resolving")),
            resolves_to=s.get("resolves_to", ""),
        )
        for s in data["suppliers"]
    )


def org_suppliers(org_id: uuid.UUID) -> list[Supplier]:
    rows = db.session.scalars(
        select(SupplierSite).where(
            SupplierSite.org_id == org_id, SupplierSite.deleted_at.is_(None), SupplierSite.enabled.is_(True)
        )
    ).all()
    return [
        Supplier(
            key=r.key,
            name=r.name,
            domains=[d.lower() for d in r.domains or []],
            id_patterns=list(r.id_patterns or []),
            id_label=r.id_label or "Item #",
            product_url=r.product_url or "",
            category=r.category or "",
            builtin=False,
            vendor_id=str(r.vendor_id) if r.vendor_id else None,
        )
        for r in rows
    ]


def all_suppliers(org_id: uuid.UUID | None) -> list[Supplier]:
    own = org_suppliers(org_id) if org_id else []
    keys = {s.key for s in own}
    return own + [s for s in builtin_suppliers() if s.key not in keys]


def supplier_name(org_id: uuid.UUID | None, key: str) -> str:
    for s in all_suppliers(org_id):
        if s.key == key:
            return s.name
    return "Other site" if key == GENERIC else key


TRACKING = re.compile(
    r"^(utm_|ref$|ref_|tag$|psc$|th$|qid$|sr$|keywords$|crid$|sprefix$|gclid$|fbclid$|msclkid$)", re.I
)


def clean_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise RuleError("Paste a product link.", 422)
    if re.match(r"^[a-z][a-z0-9+.-]*:(?!//)(?![0-9]+(/|$))", raw, re.I):  # javascript:, data:, mailto: …
        raise RuleError("Paste a web link that starts with http:// or https://.", 422)
    if not re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.I):
        raw = "https://" + raw
    parts = urlsplit(raw)
    try:
        parts.port  # noqa: B018  (raises on a malformed port)
    except ValueError:
        raise RuleError("That link isn't valid.", 422) from None
    host = parts.hostname or ""
    if parts.scheme.lower() not in ("http", "https") or not host or ("." not in host and ":" not in host and host != "localhost"):
        raise RuleError("Paste a web link that starts with http:// or https://.", 422)
    if len(raw) > 1000:
        raise RuleError("That link is too long.", 422)
    query = "&".join(p for p in parts.query.split("&") if p and not TRACKING.match(p.split("=", 1)[0]))
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", query, ""))


def _host_matches(host: str, domains: list[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in domains)


def recognize(raw_url: str, org_id: uuid.UUID | None = None) -> Match:
    url = clean_url(raw_url)
    parts = urlsplit(url)
    host = parts.hostname or ""
    for s in all_suppliers(org_id):
        if not _host_matches(host, s.domains):
            continue
        ext = ""
        for target in (parts.path, parts.path + ("?" + parts.query if parts.query else "")):
            for rx in s.compiled():
                m = rx.search(target)
                if m and m.groupdict().get("id"):
                    ext = m.group("id")
                    break
            if ext:
                break
        if s.key == "amazon" and ext:
            ext = ext.upper()
        canonical = s.product_url.replace("{id}", ext) if ext and s.product_url else url
        return Match(
            supplier_key=s.key,
            supplier_name=s.name,
            external_id=ext,
            id_label=s.id_label,
            url=url,
            canonical_url=canonical,
            needs_resolving=s.needs_resolving,
            connector=s.connector,
            vendor_id=s.vendor_id,
        )
    return Match(
        supplier_key=GENERIC,
        supplier_name=host.removeprefix("www."),
        external_id="",
        id_label="Item #",
        url=url,
        canonical_url=url,
    )


def validate_site(data: dict[str, Any]) -> dict[str, Any]:
    """Check an organization's own supplier pattern before saving."""
    name = str(data.get("name") or "").strip()
    if not name:
        raise RuleError("Give the supplier a name.", 422)
    domains = [
        str(d).strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
        for d in data.get("domains") or []
    ]
    domains = [d.removeprefix("www.") for d in domains if d]
    if not domains or any(not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", d) for d in domains):
        raise RuleError("Add the supplier's web address, like acmesupply.com.", 422)
    patterns = [str(p) for p in data.get("id_patterns") or [] if str(p).strip()]
    for p in patterns:
        try:
            rx = re.compile(p)
        except re.error as e:
            raise RuleError(f"That product id pattern isn't valid: {e}.", 422) from e
        if "id" not in rx.groupindex:
            raise RuleError("Each pattern needs a named group called id, like /item/(?P<id>[0-9]+).", 422)
        if len(p) > 300:
            raise RuleError("Keep patterns under 300 characters.", 422)
    key = str(data.get("key") or "").strip().lower() or re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if not re.fullmatch(r"[a-z0-9_]{2,60}", key):
        raise RuleError("Use letters, numbers and underscores for the supplier key.", 422)
    url_t = str(data.get("product_url") or "").strip()
    if url_t and not url_t.startswith(("http://", "https://")):
        raise RuleError("The product link template must start with https://.", 422)
    return {
        "key": key,
        "name": name[:120],
        "category": str(data.get("category") or "")[:60],
        "domains": domains[:20],
        "id_patterns": patterns[:10],
        "id_label": str(data.get("id_label") or "Item #")[:60],
        "product_url": url_t[:500],
    }
