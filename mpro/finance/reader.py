"""Document reading service (roadmap r582): turn receipts, invoices and certificates into fields.

Readers are pluggable. MPro ships:
    "browser_ocr" — the browser runs OCR (tesseract.js, the same engine as nameplate reading) and sends the text;
    "pdf_text"    — the server extracts the text layer of a PDF (pypdf);
    "manual"      — the person types the fields.
All of them end in the same text parsers below, and the person always confirms or fixes the result. Readers that send
the image to the organization's AI vision model arrive with AI providers in 1.2.0 (register into READERS then).
"""

from __future__ import annotations

import io
import re
from collections.abc import Callable
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

READERS: dict[str, Callable[..., str]] = {}

_AMOUNT = r"[-−]?\$?\s?(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})"
_MONTH_NAMES = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_MONTHS = {m: i + 1 for i, m in enumerate(_MONTH_NAMES)}


def reader(name: str) -> Callable[[Callable[..., str]], Callable[..., str]]:
    def deco(fn: Callable[..., str]) -> Callable[..., str]:
        READERS[name] = fn
        return fn

    return deco


@reader("pdf_text")
def pdf_text(data: bytes, max_pages: int = 20) -> str:
    """The text layer of a PDF (scans without one return "": OCR them in the browser)."""
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
    except ImportError:  # pragma: no cover
        return ""
    try:
        r = PdfReader(io.BytesIO(data))
        if r.is_encrypted:
            return ""
        return "\n".join((p.extract_text() or "") for p in r.pages[:max_pages])[:200_000]
    except (PdfReadError, ValueError, KeyError, TypeError, OSError):
        return ""


@reader("browser_ocr")
def browser_ocr(text: str) -> str:
    return text[:200_000]


def _num(raw: str) -> Decimal | None:
    t = raw.replace("−", "-").replace("$", "").replace(" ", "")
    # "1.234,56" (European) vs "1,234.56"
    if re.search(r",\d{2}$", t) and ("." in t[:-3] or t.count(",") == 1):
        t = t.replace(".", "").replace(",", ".")
    else:
        t = t.replace(",", "")
    try:
        return Decimal(t)
    except InvalidOperation:
        return None


def _amount_on(line: str) -> Decimal | None:
    found = re.findall(_AMOUNT, line)
    return _num(found[-1]) if found else None


def parse_date(text: str) -> date | None:
    for m in re.finditer(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", text):
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    for m in re.finditer(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b", text):
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
        for mo, d in ((a, b), (b, a)):  # US first, then day-first
            try:
                return date(y, mo, d)
            except ValueError:
                continue
    for m in re.finditer(r"\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b", text):
        mon = _MONTHS.get(m.group(1).lower())
        if mon:
            try:
                return date(int(m.group(3)), mon, int(m.group(2)))
            except ValueError:
                pass
    for m in re.finditer(r"\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b", text):
        mon = _MONTHS.get(m.group(2).lower())
        if mon:
            try:
                return date(int(m.group(3)), mon, int(m.group(1)))
            except ValueError:
                pass
    return None


_TOTAL_RE = re.compile(r"\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total|amount\s*paid|balance)\b", re.I)
_SUB_RE = re.compile(r"\bsub[\s-]?total\b", re.I)
_TAX_RE = re.compile(r"\b(sales\s*tax|tax|vat|gst|hst|pst|qst)\b", re.I)
_SKIP_ITEM = re.compile(
    r"\b(sub[\s-]?total|total|tax|vat|gst|hst|pst|change|cash|visa|mastercard|amex|discover|debit|credit|card|"
    r"balance|amount|tender|payment|auth|approval|ref|tip)\b",
    re.I,
)


def _card_last4(text: str) -> str:
    for pat in (
        r"(?:\*{2,}|x{2,}|X{2,}|#{2,}|•{2,})\s?-?\s?(\d{4})\b",
        r"ending\s+(?:in\s+)?(\d{4})\b",
        r"\b(?:card|acct|account)\s*(?:#|no\.?|number)?\s*:?\s*(?:[*xX•.]+\s*)?(\d{4})\b",
    ):
        m = re.search(pat, text, re.I)
        if m:
            return m.group(1)
    return ""


def _vendor(lines: list[str]) -> str:
    for line in lines[:6]:
        t = line.strip(" -*=#")
        if (
            len(t) >= 3
            and sum(c.isalpha() for c in t) >= 3
            and not re.search(r"\d{3}[-.)\s]\d{3}", t)
            and not re.search(r"receipt|invoice|welcome|thank", t, re.I)
        ):
            return t[:120]
    return ""


def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.replace("\r", "").split("\n") if ln.strip()]


def parse_receipt(text: str) -> dict[str, Any]:
    """Best-effort fields from receipt text. Every value is a suggestion; `confidence` says how sure (0–1)."""
    lines = _lines(text)
    out: dict[str, Any] = {
        "vendor_name": _vendor(lines),
        "purchased_on": None,
        "subtotal": None,
        "tax": None,
        "total": None,
        "card_last4": _card_last4(text),
        "lines": [],
        "confidence": {},
    }
    d = parse_date(text)
    out["purchased_on"] = d.isoformat() if d else None
    totals: list[Decimal] = []
    tax = Decimal("0")
    tax_found = False
    for line in lines:
        amt = _amount_on(line)
        if amt is None:
            continue
        if _SUB_RE.search(line):
            out["subtotal"] = amt
        elif _TAX_RE.search(line) and not re.search(r"tax\s*(exempt|id)", line, re.I):
            tax += amt
            tax_found = True
        elif _TOTAL_RE.search(line) and not re.search(r"\bchange\b|\bsav", line, re.I):
            totals.append(amt)
        elif not _SKIP_ITEM.search(line):
            desc = re.sub(_AMOUNT + r"\s*[A-Z]?$", "", line).strip(" .:-*")
            qty = Decimal("1")
            m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:@|x|X|\*)\s*", desc)
            if m:
                qty = Decimal(m.group(1))
                desc = desc[m.end() :]
                desc = re.sub(r"^" + _AMOUNT + r"\s*", "", desc).strip()
            if len(desc) >= 2 and any(c.isalpha() for c in desc):
                unit = (amt / qty).quantize(Decimal("0.0001")) if qty else amt
                out["lines"].append(
                    {"description": desc[:200], "quantity": str(qty), "unit_price": str(unit), "amount": str(amt)}
                )
    if tax_found:
        out["tax"] = tax
    if totals:
        out["total"] = max(totals)
    if out["total"] is None and out["subtotal"] is not None:
        out["total"] = out["subtotal"] + (out["tax"] or Decimal("0"))
    if out["subtotal"] is None and out["total"] is not None and out["tax"] is not None:
        out["subtotal"] = out["total"] - out["tax"]
    conf = out["confidence"]
    conf["vendor_name"] = 0.6 if out["vendor_name"] else 0
    conf["purchased_on"] = 0.8 if d else 0
    conf["total"] = 0.9 if totals else (0.5 if out["total"] is not None else 0)
    conf["tax"] = 0.8 if tax_found else 0
    conf["card_last4"] = 0.8 if out["card_last4"] else 0
    for k in ("subtotal", "tax", "total"):
        if isinstance(out[k], Decimal):
            out[k] = str(out[k])
    out["lines"] = out["lines"][:100]
    return out


def parse_terms(terms: str) -> dict[str, Any]:
    """ "2/10 net 30" → {"discount_pct": "2", "discount_days": 10, "net_days": 30}; "Net 45" → {"net_days": 45}."""
    t = terms.lower()
    out: dict[str, Any] = {}
    m = re.search(r"(\d+(?:\.\d+)?)\s*%?\s*/\s*(\d+)\s*,?\s*n(?:et)?\s*/?\s*(\d+)", t)
    if m:
        out = {"discount_pct": m.group(1), "discount_days": int(m.group(2)), "net_days": int(m.group(3))}
    else:
        m = re.search(r"net\s*(\d+)", t)
        if m:
            out = {"net_days": int(m.group(1))}
        elif re.search(r"due\s+on\s+receipt|upon\s+receipt|cod", t):
            out = {"net_days": 0}
    return out


def parse_invoice(text: str) -> dict[str, Any]:
    """Best-effort fields from a vendor invoice's text."""
    lines = _lines(text)
    out: dict[str, Any] = {
        "vendor_name": _vendor(lines),
        "number": "",
        "invoice_date": None,
        "due_date": None,
        "terms": "",
        "po_numbers": [],
        "subtotal": None,
        "tax": None,
        "shipping": None,
        "total": None,
        "lines": [],
    }
    m = re.search(r"invoice\s*(?:#|no\.?|number|num)\s*:?\s*([A-Z0-9][A-Z0-9-/]{1,40})", text, re.I)
    if m:
        out["number"] = m.group(1)
    m = re.search(r"(?:invoice\s*date|date\s*of\s*invoice|dated)\s*:?\s*(.{6,30})", text, re.I)
    d = parse_date(m.group(1)) if m else None
    d = d or parse_date(text)
    out["invoice_date"] = d.isoformat() if d else None
    m = re.search(r"due\s*date\s*:?\s*(.{6,30})", text, re.I)
    dd = parse_date(m.group(1)) if m else None
    out["due_date"] = dd.isoformat() if dd else None
    m = re.search(r"(?:terms|payment\s*terms)\s*:?\s*([^\n]{2,40})", text, re.I)
    if m:
        out["terms"] = m.group(1).strip()
    else:
        m = re.search(r"\b(\d+\s*/\s*\d+\s*,?\s*net\s*\d+|net\s*\d+)\b", text, re.I)
        out["terms"] = m.group(1) if m else ""
    out["po_numbers"] = sorted(
        {
            m.group(1)
            for m in re.finditer(
                r"\b(?:P\.?O\.?|purchase\s*order)\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9-]{1,30})", text, re.I
            )
        }
    )
    totals: list[Decimal] = []
    for line in lines:
        amt = _amount_on(line)
        if amt is None:
            continue
        if _SUB_RE.search(line):
            out["subtotal"] = amt
        elif re.search(r"\b(shipping|freight|delivery)\b", line, re.I):
            out["shipping"] = amt
        elif _TAX_RE.search(line):
            out["tax"] = (out["tax"] or Decimal("0")) + amt
        elif _TOTAL_RE.search(line):
            totals.append(amt)
        else:
            # "<qty> <description> <unit price> <amount>" or "<description> <qty> <unit> <amount>"
            nums = re.findall(_AMOUNT, line)
            m2 = re.match(r"^\s*(\d+(?:\.\d+)?)\s+(.+?)\s+" + _AMOUNT + r"\s+" + _AMOUNT + r"\s*$", line)
            if m2:
                qty, desc = Decimal(m2.group(1)), m2.group(2)
                unit, amount = _num(m2.group(3)), _num(m2.group(4))
            elif len(nums) >= 2:
                m3 = re.match(r"^(.+?)\s+(\d+(?:\.\d+)?)\s+" + _AMOUNT + r"\s+" + _AMOUNT + r"\s*$", line)
                if not m3:
                    continue
                desc, qty = m3.group(1), Decimal(m3.group(2))
                unit, amount = _num(m3.group(3)), _num(m3.group(4))
            else:
                continue
            if unit is None or amount is None or not any(c.isalpha() for c in desc):
                continue
            pn = re.match(r"^([A-Z0-9][A-Z0-9-]{3,})\s+(.+)$", desc)
            out["lines"].append(
                {
                    "part_number": pn.group(1) if pn else "",
                    "description": (pn.group(2) if pn else desc)[:200],
                    "quantity": str(qty),
                    "unit_price": str(unit),
                    "amount": str(amount),
                }
            )
    if totals:
        out["total"] = max(totals)
    for k in ("subtotal", "tax", "shipping", "total"):
        if isinstance(out[k], Decimal):
            out[k] = str(out[k])
    if out["terms"] and not out["due_date"] and out["invoice_date"]:
        t = parse_terms(out["terms"])
        if "net_days" in t:
            from datetime import timedelta

            out["due_date"] = (date.fromisoformat(out["invoice_date"]) + timedelta(days=t["net_days"])).isoformat()
    out["lines"] = out["lines"][:200]
    return out
