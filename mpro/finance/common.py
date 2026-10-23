"""Helpers shared by the finance services: money parsing, dates, paging, document indexing."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select

from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.orgs.services import RuleError

ZERO = Decimal("0")
CENT = Decimal("0.01")


def money(
    value: Any, field: str = "amount", *, allow_none: bool = False, allow_negative: bool = False
) -> Decimal | None:
    """Parse an amount as Decimal (never float, G-12). Strings like "$1,234.50" are accepted."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_none:
            return None
        raise RuleError(f"Enter the {field}.", 422)
    if isinstance(value, bool):
        raise RuleError(f"The {field} must be a number.", 422)
    try:
        if isinstance(value, Decimal):
            d = value
        elif isinstance(value, int):
            d = Decimal(value)
        elif isinstance(value, float):
            d = Decimal(str(value))
        else:
            d = Decimal(str(value).replace(",", "").replace("$", "").replace("€", "").replace("£", "").strip())
    except (InvalidOperation, ValueError) as e:
        raise RuleError(f"The {field} must be a number.", 422) from e
    if not d.is_finite() or abs(d) > Decimal("1000000000000"):
        raise RuleError(f"The {field} must be a number.", 422)
    if d < ZERO and not allow_negative:
        raise RuleError(f"The {field} can't be negative.", 422)
    return d


def cents(d: Decimal | None) -> Decimal:
    return (d or ZERO).quantize(CENT, rounding=ROUND_HALF_UP)


def s(d: Decimal | None) -> str | None:
    """Decimal → string for JSON (keeps exactness)."""
    return None if d is None else format(d, "f")


def parse_date(value: Any, field: str = "date", *, allow_none: bool = True) -> date | None:
    if value in (None, ""):
        if allow_none:
            return None
        raise RuleError(f"Enter the {field}.", 422)
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError as e:
        raise RuleError(f"The {field} must be a date (YYYY-MM-DD).", 422) from e


def to_uuid(value: Any, what: str = "record") -> uuid.UUID | None:
    if value in (None, ""):
        return None
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 404) from e


def get_in_org(model: Any, org_id: uuid.UUID, value: Any, what: str, *, allow_none: bool = True) -> Any:
    """Load a record by id and check it belongs to the organization (ids from request bodies, G-15)."""
    uid = to_uuid(value, what)
    if uid is None:
        if allow_none:
            return None
        raise RuleError(f"Pick a {what}.", 422)
    obj = db.session.get(model, uid)
    if obj is None or getattr(obj, "org_id", None) != org_id or getattr(obj, "deleted_at", None) is not None:
        raise RuleError(f"That {what} doesn't exist.", 404)
    return obj


def page_args(args: dict[str, Any], default: int = 50) -> tuple[int, int]:
    try:
        page = max(1, int(args.get("page", 1)))
        per = min(200, max(1, int(args.get("per_page", default))))
    except ValueError:
        page, per = 1, default
    return page, per


def paged(q: Any, args: dict[str, Any], to_dict: Any, default: int = 50) -> dict[str, Any]:
    page, per = page_args(args, default)
    total = db.session.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    rows = db.session.scalars(q.limit(per).offset((page - 1) * per)).all()
    return {"items": [to_dict(r) for r in rows], "total": total, "page": page, "per_page": per}


def today() -> date:
    return utcnow().date()


def user_label(user_id: uuid.UUID | None) -> dict[str, Any] | None:
    if user_id is None:
        return None
    from mpro.auth.models import User

    u = db.session.get(User, user_id)
    return {"id": str(u.id), "name": u.name} if u else None


def vendor_label(vendor_id: uuid.UUID | None) -> dict[str, Any] | None:
    if vendor_id is None:
        return None
    from mpro.vendors.models import Vendor

    v = db.session.get(Vendor, vendor_id)
    return {"id": str(v.id), "name": v.name, "color": v.color} if v else None


def customer_label(customer_id: uuid.UUID | None) -> dict[str, Any] | None:
    if customer_id is None:
        return None
    from mpro.vendors.models import Customer

    c = db.session.get(Customer, customer_id)
    return {"id": str(c.id), "name": c.name} if c else None


def org_currency(org_id: uuid.UUID) -> str:
    from mpro.orgs.models import Organization

    o = db.session.get(Organization, org_id)
    return (o.currency if o else "USD") or "USD"


__all__ = ["iso", "utcnow"]
