"""Small validation helpers shared by vendors, customers and purchasing."""

from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select

from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.parts.ledger import dec

COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ADDRESS_KEYS = ("line1", "line2", "city", "region", "postal_code", "country")


def uid(v: Any, what: str) -> uuid.UUID:
    if isinstance(v, uuid.UUID):
        return v
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError, AttributeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def text(v: Any, n: int, field: str = "", required: bool = False) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str | int | float) or isinstance(v, bool):
        raise RuleError(f"{field or 'That field'} must be text.", 422)
    s = str(v).strip()
    if len(s) > n:
        raise RuleError(f"{field or 'That field'} can be up to {n:,} characters.", 422)
    if required and not s:
        raise RuleError(f"{field or 'That field'} is required.", 422)
    return s


def email(v: Any, field: str = "Email") -> str:
    s = text(v, 255, field)
    if s and not EMAIL.match(s):
        raise RuleError(f"{field} doesn't look like an email address.", 422)
    return s


def color(v: Any) -> str:
    s = text(v, 16, "Colour") or "#5d6880"
    if not COLOR.match(s):
        raise RuleError("Colour must look like #1b5bd4.", 422)
    return s.lower()


def address(v: Any) -> dict[str, str]:
    if v in (None, ""):
        return {}
    if not isinstance(v, dict):
        raise RuleError("Address must be an object.", 422)
    out = {k: text(v.get(k), 200, k.replace("_", " ").capitalize()) for k in ADDRESS_KEYS if v.get(k)}
    if out.get("country") and len(out["country"]) != 2:
        raise RuleError("Use the two-letter country code (US, CA, GB…).", 422)
    if "country" in out:
        out["country"] = out["country"].upper()
    return out


def money(v: Any, field: str, allow_negative: bool = False, required: bool = True) -> Decimal | None:
    if v in (None, ""):
        if required:
            raise RuleError(f"{field} is required.", 422)
        return None
    d = dec(v, field)
    if d < 0 and not allow_negative:
        raise RuleError(f"{field} can't be negative.", 422)
    if abs(d) >= Decimal("1e13"):
        raise RuleError(f"{field} is too large.", 422)
    return d


def currency(v: Any) -> str:
    s = text(v, 3, "Currency").upper()
    if s and not re.fullmatch(r"[A-Z]{3}", s):
        raise RuleError("Use a three-letter currency code (USD, EUR…).", 422)
    return s


def day(v: Any, field: str) -> date | None:
    if v in (None, ""):
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError as e:
        raise RuleError(f"{field} must be a date (YYYY-MM-DD).", 422) from e


def ids_in_org(model: Any, org_id: uuid.UUID, raw: Any, what: str) -> list[uuid.UUID]:
    """Validate a list of ids against the organization (G-15). Returns them de-duplicated, in order."""
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > 500:
        raise RuleError(f"Pick up to 500 {what}s.", 422)
    want = list(dict.fromkeys(uid(x, what) for x in raw))
    if not want:
        return []
    q = select(model.id).where(model.org_id == org_id, model.id.in_(want))
    if hasattr(model, "deleted_at"):
        q = q.where(model.deleted_at.is_(None))
    found = set(db.session.scalars(q))
    if len(found) != len(want):
        raise RuleError(f"One of the {what}s doesn't exist.", 422)
    return want


def one_in_org(model: Any, org_id: uuid.UUID, raw: Any, what: str) -> Any:
    if raw in (None, ""):
        return None
    obj = db.session.get(model, uid(raw, what))
    if obj is None or obj.org_id != org_id or getattr(obj, "deleted_at", None) is not None:
        raise RuleError(f"That {what} doesn't exist.", 422)
    return obj


def page_args(params: dict[str, Any], default: int = 50, cap: int = 200) -> tuple[int, int]:
    try:
        per_page = max(1, min(int(params.get("per_page") or default), cap))
        page = max(1, int(params.get("page") or 1))
    except (TypeError, ValueError) as e:
        raise RuleError("page and per_page must be numbers.", 422) from e
    return page, per_page


def count(q: Any) -> int:
    return int(db.session.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0)


def num(d: Decimal | None) -> str | None:
    """Decimal → string for JSON without float rounding ('12.5' not 12.4999…)."""
    if d is None:
        return None
    d = Decimal(d)
    if d == d.to_integral():
        return str(d.quantize(Decimal("1")))
    return format(d.normalize(), "f")
