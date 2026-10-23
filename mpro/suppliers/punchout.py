"""PunchOut catalogs (MP-088): shop on the supplier's own site, get the cart back as an MPro purchase order.

cXML (PunchOutSetupRequest → StartPage URL; the supplier posts a PunchOutOrderMessage back to our return URL as the
form field `cxml-urlencoded` or `cxml-base64`) and SAP OCI (form post to the catalog with HOOK_URL; the cart comes
back as NEW_ITEM-…[n] form fields). The return URL carries a random per-session token (`buyer cookie`), which is what
ties the returned cart to the session; it's single-use.

XML from suppliers is untrusted: documents with entity declarations are refused before parsing.
"""

from __future__ import annotations

import base64
import secrets
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from xml.sax.saxutils import escape

from mpro import __version__
from mpro.suppliers.fetch import money


class PunchOutError(Exception):
    pass


@dataclass
class CartLine:
    supplier_part_id: str
    description: str
    quantity: Decimal
    unit_price: Decimal
    currency: str = ""
    unit: str = ""
    manufacturer_part_id: str = ""
    manufacturer: str = ""
    aux_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "supplier_part_id": self.supplier_part_id,
            "description": self.description,
            "quantity": str(self.quantity),
            "unit_price": str(self.unit_price),
            "currency": self.currency,
            "unit": self.unit,
            "manufacturer_part_id": self.manufacturer_part_id,
            "manufacturer": self.manufacturer,
            "aux_id": self.aux_id,
        }


def new_buyer_cookie() -> str:
    return secrets.token_urlsafe(32)


def _payload_id() -> str:
    return f"{datetime.now(UTC):%Y%m%d%H%M%S}.{secrets.token_hex(6)}@mpro"


def cxml_setup_request(
    settings: dict[str, Any],
    shared_secret: str,
    buyer_cookie: str,
    return_url: str,
    user_email: str = "",
    user_name: str = "",
) -> bytes:
    domain = escape(str(settings.get("domain") or "NetworkID"))
    frm = escape(str(settings.get("from_identity") or ""))
    to = escape(str(settings.get("to_identity") or ""))
    sender = escape(str(settings.get("sender_identity") or settings.get("from_identity") or ""))
    ts = datetime.now(UTC).isoformat(timespec="seconds")
    extr = ""
    if user_email:
        extr += f'<Extrinsic name="UserEmail">{escape(user_email)}</Extrinsic>'
    if user_name:
        extr += f'<Extrinsic name="UserFullName">{escape(user_name)}</Extrinsic>'
    doc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">'
        f'<cXML payloadID="{escape(_payload_id())}" timestamp="{ts}" xml:lang="en-US">'
        "<Header>"
        f'<From><Credential domain="{domain}"><Identity>{frm}</Identity></Credential></From>'
        f'<To><Credential domain="{domain}"><Identity>{to}</Identity></Credential></To>'
        f'<Sender><Credential domain="{domain}"><Identity>{sender}</Identity>'
        f"<SharedSecret>{escape(shared_secret)}</SharedSecret></Credential>"
        f"<UserAgent>Maintenance Pro {escape(__version__)}</UserAgent></Sender>"
        "</Header>"
        '<Request><PunchOutSetupRequest operation="create">'
        f"<BuyerCookie>{escape(buyer_cookie)}</BuyerCookie>{extr}"
        f"<BrowserFormPost><URL>{escape(return_url)}</URL></BrowserFormPost>"
        f"<SupplierSetup><URL>{escape(str(settings.get('setup_url') or ''))}</URL></SupplierSetup>"
        "</PunchOutSetupRequest></Request></cXML>"
    )
    return doc.encode()


def _safe_xml(raw: bytes | str) -> ET.Element:
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    if "<!ENTITY" in text.upper():
        raise PunchOutError("The supplier sent XML with entity declarations; it was refused.")
    if len(text) > 5 * 1024 * 1024:
        raise PunchOutError("The supplier's response is too large.")
    # drop the DOCTYPE line (external DTDs are never loaded by ElementTree, but there's no need to keep it)
    import re

    text = re.sub(r"<!DOCTYPE[^>\[]*>", "", text, count=1)
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise PunchOutError("The supplier's response isn't valid XML.") from e


def _find(el: ET.Element, path: str) -> ET.Element | None:
    # cXML has no namespaces in practice, but tolerate them
    for node in el.iter():
        tag = node.tag.split("}")[-1]
        if tag == path:
            return node
    return None


def parse_setup_response(raw: bytes) -> str:
    root = _safe_xml(raw)
    status = _find(root, "Status")
    code = status.get("code", "") if status is not None else ""
    if code and code != "200":
        text = (status.get("text") or "") if status is not None else ""
        raise PunchOutError(f"The supplier refused the PunchOut ({code} {text}).".replace(" )", ")"))
    url_el = None
    start = _find(root, "StartPage")
    if start is not None:
        for n in start.iter():
            if n.tag.split("}")[-1] == "URL":
                url_el = n
                break
    url = (url_el.text or "").strip() if url_el is not None else ""
    if not url.startswith(("https://", "http://")):
        raise PunchOutError("The supplier didn't send a start page.")
    return url


def _text(el: ET.Element | None) -> str:
    return " ".join("".join(el.itertext()).split()) if el is not None else ""


def parse_order_message(raw: bytes | str) -> tuple[str, list[CartLine]]:
    """cXML PunchOutOrderMessage → (buyer cookie, lines)."""
    root = _safe_xml(raw)
    cookie = _text(_find(root, "BuyerCookie"))
    lines: list[CartLine] = []
    for item in root.iter():
        if item.tag.split("}")[-1] != "ItemIn":
            continue
        qty = money(item.get("quantity")) or Decimal("0")
        sup = _text(_find(item, "SupplierPartID"))
        aux = _text(_find(item, "SupplierPartAuxiliaryID"))
        detail = _find(item, "ItemDetail")
        price_el = _find(detail, "Money") if detail is not None else None
        lines.append(
            CartLine(
                supplier_part_id=sup[:120],
                aux_id=aux[:200],
                description=_text(_find(detail, "Description") if detail is not None else None)[:500] or sup,
                quantity=qty,
                unit_price=money(price_el.text if price_el is not None else None) or Decimal("0"),
                currency=(price_el.get("currency", "") if price_el is not None else "")[:3].upper(),
                unit=_text(_find(detail, "UnitOfMeasure") if detail is not None else None)[:30],
                manufacturer_part_id=_text(_find(detail, "ManufacturerPartID") if detail is not None else None)[:120],
                manufacturer=_text(_find(detail, "ManufacturerName") if detail is not None else None)[:200],
            )
        )
        if len(lines) >= 500:
            break
    return cookie, [ln for ln in lines if ln.quantity > 0]


def order_message_from_form(form: dict[str, str]) -> bytes:
    """The cXML document from the supplier's form post."""
    for k, v in form.items():
        kl = k.lower()
        if kl == "cxml-urlencoded":
            return v.encode()
        if kl == "cxml-base64":
            try:
                return base64.b64decode(v)
            except ValueError as e:
                raise PunchOutError("The returned cart is damaged.") from e
    raise PunchOutError("The supplier didn't send a cart.")


def oci_start_form(settings: dict[str, Any], password: str, hook_url: str) -> dict[str, Any]:
    return {
        "action": str(settings.get("setup_url") or ""),
        "fields": {
            "USERNAME": str(settings.get("username") or ""),
            "PASSWORD": password,
            "HOOK_URL": hook_url,
            "~OkCode": "ADDI",
            "~TARGET": "_top",
            "~CALLER": "CTLG",
            "returntarget": "_top",
        },
    }


def parse_oci(form: dict[str, str]) -> list[CartLine]:
    """OCI return: NEW_ITEM-DESCRIPTION[1], NEW_ITEM-QUANTITY[1], NEW_ITEM-PRICE[1]…"""
    rows: dict[str, dict[str, str]] = {}
    for k, v in form.items():
        if not k.upper().startswith("NEW_ITEM-") or "[" not in k:
            continue
        name, idx = k[9:].split("[", 1)
        rows.setdefault(idx.rstrip("]"), {})[name.upper()] = v
    lines: list[CartLine] = []
    for idx in sorted(rows, key=lambda x: int(x) if x.isdigit() else 0)[:500]:
        r = rows[idx]
        qty = money(r.get("QUANTITY")) or Decimal("0")
        price = money(r.get("PRICE")) or Decimal("0")
        per = money(r.get("PRICEUNIT")) or Decimal("1")
        if per and per != 1:
            price = price / per
        if qty <= 0:
            continue
        lines.append(
            CartLine(
                supplier_part_id=(r.get("VENDORMAT") or r.get("MATNR") or "")[:120],
                description=(r.get("DESCRIPTION") or r.get("LONGTEXT_1:132") or "")[:500],
                quantity=qty,
                unit_price=price,
                currency=(r.get("CURRENCY") or "")[:3].upper(),
                unit=(r.get("UNIT") or "")[:30],
                manufacturer_part_id=(r.get("MANUFACTMAT") or "")[:120],
            )
        )
    return lines
