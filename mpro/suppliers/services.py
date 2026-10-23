"""Supplier product links: business rules (MP-084–089).

Links tie a part or an asset to a supplier listing. Listings are cached as `Product` rows shared by every link to the
same listing in the organization; a background job refreshes them (API connector when one is connected for that
supplier, otherwise the page itself), keeps a price history, copies the product image into MPro's file storage and
sends price / stock alerts.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select

from mpro.assets.models import Asset
from mpro.core import crypto
from mpro.core.events import emit
from mpro.core.files import attach, save_file
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.extensions import db
from mpro.orgs.models import TeamMember
from mpro.orgs.services import RuleError
from mpro.parts.ledger import dec
from mpro.parts.models import Part, PartTeam
from mpro.suppliers import connectors as conn_mod
from mpro.suppliers import fetch as fetch_mod
from mpro.suppliers import recognize as rec
from mpro.suppliers.models import (
    Product,
    ProductLink,
    ProductPrice,
    PunchOutSession,
    SupplierConnection,
    SupplierSite,
)
from mpro.vendors.models import Vendor

log = logging.getLogger(__name__)

ENTITY_TYPES = ("part", "asset")
ROLES = ("listing", "spare_part", "purchased_from")
STALE_AFTER = timedelta(hours=24)
REFRESH_EVERY = timedelta(days=1)
RETRY_AFTER = timedelta(hours=6)


# ---------------------------------------------------------------- helpers


def _uuid(v: Any, what: str = "record") -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 404) from e


def entity_record(org_id: uuid.UUID, entity_type: str, entity_id: Any) -> Part | Asset:
    if entity_type not in ENTITY_TYPES:
        raise RuleError("Links can be added to parts and assets.", 422)
    uid = _uuid(entity_id, entity_type)
    rec_: Part | Asset | None = db.session.get(Part, uid) if entity_type == "part" else db.session.get(Asset, uid)
    if rec_ is None or rec_.org_id != org_id or rec_.deleted_at is not None:
        raise RuleError(f"That {entity_type} doesn't exist.", 404)
    return rec_


def can_view_entity(member: Any, entity_type: str) -> bool:
    return can(member, "parts.view" if entity_type == "part" else "assets.view")


def _vendor(org_id: uuid.UUID, vendor_id: Any) -> uuid.UUID | None:
    if not vendor_id:
        return None
    v = db.session.get(Vendor, _uuid(vendor_id, "vendor"))
    if v is None or v.org_id != org_id or v.deleted_at is not None:
        raise RuleError("That vendor doesn't exist.", 404)
    return v.id


def _opt_dec(v: Any, field: str) -> Decimal | None:
    if v is None or v == "":
        return None
    d = dec(v, field)
    if d < 0:
        raise RuleError(f"{field.capitalize()} can't be negative.", 422)
    return d


def product_key(match: rec.Match) -> str:
    if match.external_id:
        return match.external_id[:120]
    return "url:" + hashlib.sha1(match.canonical_url.encode()).hexdigest()[:36]


def get_or_create_product(org_id: uuid.UUID, match: rec.Match) -> Product:
    ext = product_key(match)
    p = db.session.scalars(
        select(Product).where(
            Product.org_id == org_id, Product.supplier_key == match.supplier_key, Product.external_id == ext
        )
    ).first()
    if p is None:
        p = Product(
            org_id=org_id,
            supplier_key=match.supplier_key,
            external_id=ext,
            url=match.canonical_url[:1000],
            fetch_status="pending",
            next_refresh_at=utcnow(),
        )
        db.session.add(p)
        db.session.flush()
    return p


# ---------------------------------------------------------------- serialization


def is_stale(p: Product) -> bool:
    return p.price is not None and (p.fetched_at is None or utcnow() - p.fetched_at > STALE_AFTER)


def product_dict(p: Product, org_id: uuid.UUID | None = None) -> dict[str, Any]:
    return {
        "id": str(p.id),
        "supplier_key": p.supplier_key,
        "supplier_name": rec.supplier_name(org_id or p.org_id, p.supplier_key),
        "external_id": "" if p.external_id.startswith("url:") else p.external_id,
        "url": p.url,
        "title": p.title,
        "brand": p.brand,
        "image_url": f"/api/v1/files/{p.image_file_id}" if p.image_file_id else None,
        "thumb_url": f"/api/v1/files/{p.image_file_id}/thumb" if p.image_file_id else None,
        "price": str(p.price) if p.price is not None else None,
        "currency": p.currency,
        "price_unit": p.price_unit,
        "availability": p.availability,
        "sku": p.sku,
        "mpn": p.mpn,
        "replacement_url": p.replacement_url,
        "specs": {k: v for k, v in (p.specs or {}).items() if not k.startswith("_")},
        "source": p.source,
        "fetched_at": iso(p.fetched_at),
        "fetch_status": p.fetch_status,
        "fetch_error": p.fetch_error,
        "price_may_have_changed": is_stale(p),
    }


def link_dict(link: ProductLink, product: Product | None = None, member: Any = None) -> dict[str, Any]:
    product = product or db.session.get(Product, link.product_id)
    show_cost = member is None or can(member, "costs.view")
    pd = product_dict(product, link.org_id) if product else None
    title = (product.title if product else "") or link.manual_title or (pd["external_id"] if pd else "") or link.url
    price = product.price if product and product.price is not None else link.manual_price
    return {
        "id": str(link.id),
        "entity_type": link.entity_type,
        "entity_id": str(link.entity_id),
        "role": link.role,
        "url": link.url,
        "supplier_key": link.supplier_key,
        "supplier_name": rec.supplier_name(link.org_id, link.supplier_key),
        "external_id": link.external_id,
        "vendor_id": str(link.vendor_id) if link.vendor_id else None,
        "supplier_sku": link.supplier_sku,
        "mpn": link.mpn,
        "pack_size": str(link.pack_size) if link.pack_size is not None else None,
        "unit": link.unit,
        "preferred": link.preferred,
        "note": link.note,
        "manual_title": link.manual_title,
        "manual_price": str(link.manual_price) if link.manual_price is not None else None,
        "last_paid_price": str(link.last_paid_price) if show_cost and link.last_paid_price is not None else None,
        "alert_price_change_pct": str(link.alert_price_change_pct) if link.alert_price_change_pct is not None else None,
        "alert_out_of_stock": link.alert_out_of_stock,
        "title": title,
        "price": str(price) if price is not None else None,
        "price_from": "site"
        if product and product.price is not None
        else ("typed" if link.manual_price is not None else None),
        "product": pd,
        "created_at": iso(link.created_at),
    }


# ---------------------------------------------------------------- links


def links_for(org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID, role: str | None = None) -> list[ProductLink]:
    q = select(ProductLink).where(
        ProductLink.org_id == org_id,
        ProductLink.entity_type == entity_type,
        ProductLink.entity_id == entity_id,
        ProductLink.deleted_at.is_(None),
    )
    if role:
        q = q.where(ProductLink.role == role)
    return list(db.session.scalars(q.order_by(ProductLink.preferred.desc(), ProductLink.created_at)).all())


def _apply(link: ProductLink, org_id: uuid.UUID, data: dict[str, Any]) -> None:
    if "vendor_id" in data:
        link.vendor_id = _vendor(org_id, data["vendor_id"])
    for k, n in (("supplier_sku", 120), ("mpn", 120), ("unit", 30), ("note", 500), ("manual_title", 500)):
        if k in data:
            setattr(link, k, str(data[k] or "").strip()[:n])
    if "pack_size" in data:
        ps = _opt_dec(data["pack_size"], "pack size")
        if ps is not None and ps == 0:
            raise RuleError("Pack size must be more than zero.", 422)
        link.pack_size = ps
    if "manual_price" in data:
        link.manual_price = _opt_dec(data["manual_price"], "price")
    if "alert_price_change_pct" in data:
        pct = _opt_dec(data["alert_price_change_pct"], "alert percentage")
        if pct is not None and not (Decimal("0.1") <= pct <= Decimal("1000")):
            raise RuleError("Use a percentage between 0.1 and 1000.", 422)
        link.alert_price_change_pct = pct
    if "alert_out_of_stock" in data:
        link.alert_out_of_stock = bool(data["alert_out_of_stock"])


def _make_preferred(link: ProductLink) -> None:
    for other in links_for(link.org_id, link.entity_type, link.entity_id, link.role):
        if other.id != link.id:
            other.preferred = False
    link.preferred = True


def add_link(org_id: uuid.UUID, member: Any, data: dict[str, Any], *, fetch: bool = True) -> ProductLink:
    entity_type = str(data.get("entity_type") or "")
    entity = entity_record(org_id, entity_type, data.get("entity_id"))
    role = str(data.get("role") or ("listing" if entity_type == "part" else "spare_part"))
    if role not in ROLES or (entity_type == "part" and role != "listing"):
        raise RuleError("Pick listing, spare part or purchased from.", 422)
    match = rec.recognize(str(data.get("url") or ""), org_id)
    existing = db.session.scalars(
        select(ProductLink).where(
            ProductLink.org_id == org_id,
            ProductLink.entity_type == entity_type,
            ProductLink.entity_id == entity.id,
            ProductLink.role == role,
            ProductLink.supplier_key == match.supplier_key,
            ProductLink.external_id == match.external_id,
            ProductLink.url == match.url[:1000],
            ProductLink.deleted_at.is_(None),
        )
    ).first()
    if existing is not None:
        raise RuleError("That product is already linked here.", 409)
    if len(links_for(org_id, entity_type, entity.id)) >= 25:
        raise RuleError("A record can have up to 25 product links.", 422)
    product = get_or_create_product(org_id, match)
    link = ProductLink(
        org_id=org_id,
        entity_type=entity_type,
        entity_id=entity.id,
        role=role,
        product_id=product.id,
        url=match.url[:1000],
        supplier_key=match.supplier_key,
        external_id=match.external_id,
        vendor_id=_uuid(match.vendor_id) if match.vendor_id else None,
        created_by_id=getattr(member, "user_id", None),
    )
    db.session.add(link)
    _apply(link, org_id, data)
    if not link.supplier_sku and match.external_id:
        link.supplier_sku = match.external_id[:120]
    db.session.flush()
    if data.get("preferred") or not any(
        x.preferred for x in links_for(org_id, entity_type, entity.id, role) if x.id != link.id
    ):
        _make_preferred(link)
    emit(
        "product_link.created",
        entity_type=entity_type,
        entity_id=entity.id,
        entity_label=getattr(entity, "name", ""),
        summary=f"Linked {match.supplier_name} {match.external_id}".strip(),
        data={"link_id": link.id, "url": link.url, "supplier": match.supplier_key},
        org_id=org_id,
    )
    if fetch and product.fetch_status in ("pending", "failed", "blocked"):
        queue_refresh(product)
    return link


def get_link(org_id: uuid.UUID, link_id: Any) -> ProductLink:
    link = db.session.get(ProductLink, _uuid(link_id, "link"))
    if link is None or link.org_id != org_id or link.deleted_at is not None:
        raise RuleError("That link doesn't exist.", 404)
    return link


def update_link(org_id: uuid.UUID, link: ProductLink, data: dict[str, Any]) -> ProductLink:
    _apply(link, org_id, data)
    if data.get("preferred") is True:
        _make_preferred(link)
    elif data.get("preferred") is False:
        link.preferred = False
    emit(
        "product_link.updated",
        entity_type=link.entity_type,
        entity_id=link.entity_id,
        summary="Product link updated",
        data={"link_id": link.id, "fields": sorted(data)},
        org_id=org_id,
    )
    return link


def delete_link(org_id: uuid.UUID, link: ProductLink) -> None:
    link.deleted_at = utcnow()
    was_preferred = link.preferred
    link.preferred = False
    if was_preferred:
        rest = links_for(org_id, link.entity_type, link.entity_id, link.role)
        if rest:
            rest[0].preferred = True
    emit(
        "product_link.deleted",
        entity_type=link.entity_type,
        entity_id=link.entity_id,
        summary="Product link removed",
        data={"link_id": link.id, "url": link.url},
        org_id=org_id,
    )


# ---------------------------------------------------------------- refresh


def queue_refresh(product: Product) -> None:
    from mpro.core.jobs import enqueue

    enqueue("suppliers.refresh", {"product_id": str(product.id)}, org_id=product.org_id, max_attempts=1)


def connection_for_supplier(org_id: uuid.UUID, supplier_key: str) -> SupplierConnection | None:
    return db.session.scalars(
        select(SupplierConnection).where(
            SupplierConnection.org_id == org_id,
            SupplierConnection.supplier_key == supplier_key,
            SupplierConnection.connector.in_(list(conn_mod.CONNECTORS)),
            SupplierConnection.enabled.is_(True),
            SupplierConnection.deleted_at.is_(None),
        )
    ).first()


def _copy_image(product: Product, url: str) -> None:
    if not url or (url == product.image_url and product.image_file_id):
        return
    try:
        data, ext = fetch_mod.fetch_image(url)
    except fetch_mod.FetchError as e:
        log.info("product image not copied: %s", e)
        return
    f = save_file(product.org_id, f"product-{product.external_id[:40]}.{ext}", data, None)
    attach(f, "product", product.id, role="image")
    product.image_file_id = f.id
    product.image_url = url[:1000]


def apply_info(product: Product, info: fetch_mod.ProductInfo, *, copy_image: bool = True) -> dict[str, Any]:
    """Store fresh details; returns what changed for alerts."""
    old_price, old_avail = product.price, product.availability
    if info.title:
        product.title = info.title[:500]
    if info.brand:
        product.brand = info.brand[:200]
    product.price = info.price if info.price is not None else product.price
    product.currency = (info.currency or product.currency or "")[:3]
    product.price_unit = (info.price_unit or product.price_unit)[:60]
    if info.availability:
        product.availability = info.availability
    product.sku = (info.sku or product.sku)[:120]
    product.mpn = (info.mpn or product.mpn)[:120]
    product.replacement_url = (info.replacement_url or product.replacement_url)[:1000]
    if info.specs:
        product.specs = dict(list(info.specs.items())[:40])
    product.source = info.source
    product.fetched_at = utcnow()
    product.fetch_status = "ok"
    product.fetch_error = ""
    product.next_refresh_at = utcnow() + REFRESH_EVERY
    if copy_image and info.image_url:
        _copy_image(product, info.image_url)
    last = db.session.scalars(
        select(ProductPrice).where(ProductPrice.product_id == product.id).order_by(ProductPrice.at.desc())
    ).first()
    if (
        last is None
        or last.price != product.price
        or last.availability != product.availability
        or (utcnow() - last.at > timedelta(hours=23))
    ):
        db.session.add(
            ProductPrice(
                org_id=product.org_id,
                product_id=product.id,
                at=utcnow(),
                price=product.price,
                currency=product.currency,
                availability=product.availability,
            )
        )
    return {
        "old_price": old_price,
        "new_price": product.price,
        "old_availability": old_avail,
        "new_availability": product.availability,
    }


def refresh_product(product: Product, *, http: Any = None) -> str:
    """Read the listing again. Returns the fetch status (ok | blocked | failed)."""
    org_id = product.org_id
    try:
        # short links (amzn.to…) are resolved by following the redirect, then recognised again
        if product.supplier_key == "amazon_short":
            r = fetch_mod.get(product.url, check_robots=False)
            match = rec.recognize(r.url, org_id)
            if match.supplier_key != "amazon_short":
                target = get_or_create_product(org_id, match)
                if target.id != product.id:
                    for link in db.session.scalars(select(ProductLink).where(ProductLink.product_id == product.id)):
                        link.product_id, link.supplier_key, link.external_id = (
                            target.id,
                            match.supplier_key,
                            match.external_id,
                        )
                        link.url = match.url[:1000]
                    product.fetch_status, product.fetch_error, product.next_refresh_at = (
                        "ok",
                        "Resolved to " + match.url[:200],
                        None,
                    )
                    product = target
        connection = connection_for_supplier(org_id, product.supplier_key)
        if connection is not None:
            try:
                info = conn_mod.connector_for(connection, http=http).lookup(product.url)
                connection.last_success_at, connection.calls_today = utcnow(), (connection.calls_today or 0) + 1
            except conn_mod.ConnectorError as e:
                connection.last_error_at, connection.last_error = utcnow(), str(e)[:2000]
                info = fetch_mod.fetch_product(product.url)  # fall back to the page
        else:
            info = fetch_mod.fetch_product(product.url)
        changes = apply_info(product, info)
        _alerts(product, changes)
        emit(
            "product.refreshed",
            entity_type="product",
            entity_id=product.id,
            entity_label=product.title,
            summary="Product details refreshed",
            org_id=org_id,
            data={"price": product.price, "availability": product.availability, "source": product.source},
        )
        return "ok"
    except fetch_mod.FetchError as e:
        product.fetch_status = "blocked" if e.kind == "blocked" else "failed"
        product.fetch_error = str(e)[:2000]
        product.fetched_at = product.fetched_at  # keep the last good read
        product.next_refresh_at = utcnow() + (REFRESH_EVERY if e.kind == "blocked" else RETRY_AFTER)
        emit(
            "product.refresh_failed",
            entity_type="product",
            entity_id=product.id,
            entity_label=product.title or product.url,
            summary=str(e)[:300],
            org_id=org_id,
            data={"status": product.fetch_status},
        )
        return product.fetch_status


def refresh_due(limit: int = 50) -> int:
    rows = db.session.scalars(
        select(Product)
        .where(Product.next_refresh_at.is_not(None), Product.next_refresh_at <= utcnow())
        .order_by(Product.next_refresh_at)
        .limit(limit)
    ).all()
    n = 0
    for p in rows:
        if not db.session.scalar(
            select(func.count())
            .select_from(ProductLink)
            .where(ProductLink.product_id == p.id, ProductLink.deleted_at.is_(None))
        ):
            p.next_refresh_at = None  # nobody links to it any more
            continue
        refresh_product(p)
        db.session.commit()
        n += 1
    db.session.commit()
    return n


# ---------------------------------------------------------------- alerts (MP-087)


def _pct_change(old: Decimal | None, new: Decimal | None) -> Decimal | None:
    if old is None or new is None or old == 0:
        return None
    return (new - old) / old * 100


def _alerts(product: Product, ch: dict[str, Any]) -> None:
    pct = _pct_change(ch["old_price"], ch["new_price"])
    went_out = (
        ch["old_availability"] not in ("out_of_stock", "discontinued") and ch["new_availability"] == "out_of_stock"
    )
    discontinued = ch["old_availability"] != "discontinued" and ch["new_availability"] == "discontinued"
    if pct is None and not went_out and not discontinued:
        return
    links = db.session.scalars(
        select(ProductLink).where(ProductLink.product_id == product.id, ProductLink.deleted_at.is_(None))
    ).all()
    for link in links:
        reasons: list[str] = []
        if pct is not None and link.alert_price_change_pct is not None and abs(pct) >= link.alert_price_change_pct:
            word = "rose" if pct > 0 else "dropped"
            reasons.append(f"price {word} {abs(pct):.1f}% to {product.price} {product.currency}".strip())
        if went_out and link.alert_out_of_stock:
            reasons.append("is out of stock")
        if discontinued:
            reasons.append(
                "was discontinued"
                + (f"; suggested replacement: {product.replacement_url}" if product.replacement_url else "")
            )
        if not reasons:
            continue
        _send_alert(link, product, reasons)


def _recipients(link: ProductLink) -> set[str]:
    from mpro.auth.models import User

    ids: set[uuid.UUID] = set()
    if link.created_by_id:
        ids.add(link.created_by_id)
    if link.entity_type == "part":
        team_ids = db.session.scalars(select(PartTeam.team_id).where(PartTeam.part_id == link.entity_id)).all()
        if team_ids:
            ids |= set(db.session.scalars(select(TeamMember.user_id).where(TeamMember.team_id.in_(team_ids))).all())
    emails = db.session.scalars(select(User.email).where(User.id.in_(ids))).all() if ids else []
    return {e for e in emails if e}


def _send_alert(link: ProductLink, product: Product, reasons: list[str]) -> None:
    from mpro.core.mail import send_email

    entity = db.session.get(Part if link.entity_type == "part" else Asset, link.entity_id)
    name = getattr(entity, "name", "") or "a linked product"
    title = product.title or link.manual_title or product.url
    supplier = rec.supplier_name(link.org_id, link.supplier_key)
    body = (
        f"{title} at {supplier}, linked to {link.entity_type} {name}, {' and '.join(reasons)}.\n\n"
        f"Product page: {product.url}\n"
    )
    for to in sorted(_recipients(link)):
        send_email(to, f"Supplier update: {title[:80]}", body, org_id=link.org_id)
    emit(
        "product.alert",
        entity_type=link.entity_type,
        entity_id=link.entity_id,
        entity_label=name,
        summary=f"{supplier}: {title[:80]} {' and '.join(reasons)}"[:500],
        org_id=link.org_id,
        data={"link_id": link.id, "product_id": product.id, "reasons": reasons},
    )


# ---------------------------------------------------------------- price history and comparison


def price_history(product: Product, days: int = 365) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        select(ProductPrice)
        .where(ProductPrice.product_id == product.id, ProductPrice.at >= utcnow() - timedelta(days=days))
        .order_by(ProductPrice.at)
    ).all()
    return [
        {
            "at": iso(r.at),
            "price": str(r.price) if r.price is not None else None,
            "currency": r.currency,
            "availability": r.availability,
        }
        for r in rows
    ]


def unit_price(link: ProductLink, product: Product | None) -> Decimal | None:
    price = product.price if product and product.price is not None else link.manual_price
    if price is None:
        return None
    if link.pack_size and link.pack_size > 0:
        return (price / link.pack_size).quantize(Decimal("0.0001"))
    return price


def compare(org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID) -> list[dict[str, Any]]:
    """Suppliers for the same part/asset: in stock first, then lowest price per unit."""
    out: list[dict[str, Any]] = []
    for link in links_for(org_id, entity_type, entity_id):
        p = db.session.get(Product, link.product_id)
        up = unit_price(link, p)
        avail = (p.availability if p else "") or ""
        out.append(
            {
                "link_id": str(link.id),
                "supplier_name": rec.supplier_name(org_id, link.supplier_key),
                "unit_price": str(up) if up is not None else None,
                "currency": p.currency if p else "",
                "availability": avail,
                "preferred": link.preferred,
                "replacement_url": p.replacement_url if p else "",
            }
        )
    rank = {"in_stock": 0, "limited": 1, "": 2, "out_of_stock": 3, "discontinued": 4}
    out.sort(
        key=lambda r: (rank.get(r["availability"], 2), Decimal(r["unit_price"]) if r["unit_price"] else Decimal("1e12"))
    )
    if out and out[0]["unit_price"] is not None:
        out[0]["best"] = True
    return out


# ---------------------------------------------------------------- reorder (MP-088)


def po_line_for(org_id: uuid.UUID, link: ProductLink, quantity: Decimal | None = None) -> dict[str, Any]:
    """A purchase-order line pre-filled from a linked product (part, SKU, last price, unit)."""
    p = db.session.get(Product, link.product_id)
    part_id = link.entity_id if link.entity_type == "part" else None
    part = db.session.get(Part, part_id) if part_id else None
    qty = quantity
    if qty is None:
        qty = Decimal("1")
        if part is not None:
            from mpro.parts.models import PartStock

            stocks = db.session.scalars(select(PartStock).where(PartStock.part_id == part.id)).all()
            want = Decimal("0")
            for s in stocks:
                target = s.max_qty if s.max_qty is not None else s.min_qty
                if target is not None and (s.on_hand or 0) < target:
                    want += target - (s.on_hand or Decimal("0"))
            if want > 0:
                qty = want
    price = link.last_paid_price if link.last_paid_price is not None else unit_price(link, p)
    return {
        "part_id": str(part_id) if part_id else None,
        "description": ((p.title if p else "") or link.manual_title or (part.name if part else "") or link.url)[:500],
        "part_number": (link.supplier_sku or link.external_id)[:120],
        "unit": (link.unit or (part.unit if part else "") or "each")[:30],
        "quantity": str(qty),
        "unit_cost": str(price if price is not None else Decimal("0")),
        "product_link_id": str(link.id),
        "vendor_id": str(v) if (v := _link_vendor(org_id, link.vendor_id, link.supplier_key)) else None,
    }


def _link_vendor(org_id: uuid.UUID, vendor_id: uuid.UUID | None, supplier_key: str) -> uuid.UUID | None:
    """The link's vendor, else a vendor named like the supplier ("Grainger")."""
    if vendor_id:
        return vendor_id
    name = rec.supplier_name(org_id, supplier_key)
    v = db.session.scalars(
        select(Vendor.id).where(
            Vendor.org_id == org_id, Vendor.deleted_at.is_(None), func.lower(Vendor.name) == name.lower()
        )
    ).first()
    return v


def create_po(
    org: Any,
    member: Any,
    vendor_id: uuid.UUID | None,
    lines: list[dict[str, Any]],
    source: str,
    *,
    as_request: bool = False,
    commit: bool = True,
) -> Any:
    """Through the purchasing module's documented contract. `as_request` makes a Requested PO (a manager reviews it,
    which runs the approval rules)."""
    from mpro.purchasing import services as po_svc

    fn = getattr(po_svc, "create_purchase_order", None)
    if fn is None:
        raise RuleError("Purchase orders aren't available yet.", 503)
    data: dict[str, Any] = {"vendor_id": str(vendor_id) if vendor_id else None, "lines": lines, "source": source}
    if as_request:
        data["as_request"] = True
    return fn(org, member, data, commit=commit)


def reorder(org: Any, member: Any, link: ProductLink, quantity: Any = None) -> Any:
    qty = _opt_dec(quantity, "quantity") if quantity not in (None, "") else None
    if qty is not None and qty <= 0:
        raise RuleError("Order at least one.", 422)
    line = po_line_for(org.id, link, qty)
    vendor_id = _uuid(line.pop("vendor_id")) if line.get("vendor_id") else None
    return create_po(org, member, vendor_id, [line], "reorder")


def on_po_received(org_id: uuid.UUID, po: Any, receipt: Any, receipt_lines: list[Any]) -> None:
    """PO_RECEIVED_HOOKS: received items update the linked product's last paid price (MP-088)."""
    from mpro.purchasing.models import PurchaseOrderLine

    for rl in receipt_lines:
        if rl.quantity is None or rl.quantity <= 0:
            continue
        line = db.session.get(PurchaseOrderLine, rl.line_id)
        if line is None:
            continue
        link = None
        if line.product_link_id:
            link = db.session.get(ProductLink, line.product_link_id)
        if (link is None or link.org_id != org_id) and line.part_id and line.part_number:
            link = db.session.scalars(
                select(ProductLink).where(
                    ProductLink.org_id == org_id,
                    ProductLink.entity_type == "part",
                    ProductLink.entity_id == line.part_id,
                    ProductLink.deleted_at.is_(None),
                    or_(ProductLink.supplier_sku == line.part_number, ProductLink.external_id == line.part_number),
                )
            ).first()
        if link is not None and link.org_id == org_id:
            link.last_paid_price = rl.unit_cost


# ---------------------------------------------------------------- asset spare parts (MP-089)


def spare_parts(org_id: uuid.UUID, asset: Asset, member: Any) -> dict[str, Any]:
    from mpro.parts.models import PartAsset

    parts = (
        db.session.scalars(
            select(Part)
            .join(PartAsset, PartAsset.part_id == Part.id)
            .where(PartAsset.asset_id == asset.id, PartAsset.org_id == org_id, Part.deleted_at.is_(None))
            .order_by(Part.name)
        ).all()
        if can(member, "parts.view")
        else []
    )
    part_links: dict[uuid.UUID, ProductLink] = {}
    if parts:
        for link in db.session.scalars(
            select(ProductLink)
            .where(
                ProductLink.org_id == org_id,
                ProductLink.entity_type == "part",
                ProductLink.entity_id.in_([p.id for p in parts]),
                ProductLink.deleted_at.is_(None),
            )
            .order_by(ProductLink.preferred.desc(), ProductLink.created_at)
        ):
            part_links.setdefault(link.entity_id, link)
    return {
        "parts": [
            {
                "id": str(p.id),
                "name": p.name,
                "part_number": p.part_number,
                "unit": p.unit,
                "on_hand": str(p.on_hand),
                "reserved": str(p.reserved),
                "non_stock": p.non_stock,
                "link": link_dict(part_links[p.id], member=member) if p.id in part_links else None,
            }
            for p in parts
        ],
        "spare_links": [link_dict(x, member=member) for x in links_for(org_id, "asset", asset.id, "spare_part")],
        "purchased_from": [link_dict(x, member=member) for x in links_for(org_id, "asset", asset.id, "purchased_from")],
    }


# ---------------------------------------------------------------- supplier sites and connections


def site_dict(s: SupplierSite) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "key": s.key,
        "name": s.name,
        "category": s.category,
        "domains": s.domains,
        "id_patterns": s.id_patterns,
        "id_label": s.id_label,
        "product_url": s.product_url,
        "vendor_id": str(s.vendor_id) if s.vendor_id else None,
        "enabled": s.enabled,
        "builtin": False,
    }


def save_site(org_id: uuid.UUID, data: dict[str, Any], site: SupplierSite | None = None) -> SupplierSite:
    clean = rec.validate_site({**(site_dict(site) if site else {}), **data})
    dup = db.session.scalars(
        select(SupplierSite).where(
            SupplierSite.org_id == org_id, SupplierSite.key == clean["key"], SupplierSite.deleted_at.is_(None)
        )
    ).first()
    if dup is not None and (site is None or dup.id != site.id):
        raise RuleError("A supplier with that key already exists.", 409)
    if site is None:
        site = SupplierSite(org_id=org_id, **clean)
        db.session.add(site)
    else:
        for k, v in clean.items():
            setattr(site, k, v)
    if "vendor_id" in data:
        site.vendor_id = _vendor(org_id, data["vendor_id"])
    if "enabled" in data:
        site.enabled = bool(data["enabled"])
    db.session.flush()
    emit(
        "supplier_site.saved",
        entity_type="supplier_site",
        entity_id=site.id,
        entity_label=site.name,
        summary=f"Supplier pattern {site.name} saved",
        org_id=org_id,
    )
    return site


def connection_dict(c: SupplierConnection) -> dict[str, Any]:
    spec = conn_mod.SPECS.get(c.connector)
    try:
        secrets = crypto.decrypt_json(c.secrets) or {}
    except crypto.DecryptError:
        secrets = {}
    return {
        "id": str(c.id),
        "connector": c.connector,
        "connector_name": spec.name if spec else c.connector,
        "kind": spec.kind if spec else "api",
        "supplier_key": c.supplier_key,
        "name": c.name or (spec.name if spec else c.connector),
        "settings": c.settings,
        "secrets_set": {k: bool(v) for k, v in secrets.items()},
        "secrets_masked": {k: crypto.mask(str(v)) for k, v in secrets.items() if v and k != "certificate"},
        "enabled": c.enabled,
        "last_success_at": iso(c.last_success_at),
        "last_error_at": iso(c.last_error_at),
        "last_error": c.last_error,
        "verified": False,  # built from public docs; not yet tried against the live service
    }


def save_connection(org_id: uuid.UUID, data: dict[str, Any], c: SupplierConnection | None = None) -> SupplierConnection:
    key = str(data.get("connector") or (c.connector if c else ""))
    spec = conn_mod.SPECS.get(key)
    if spec is None:
        raise RuleError("Pick a connector.", 422)
    if c is None:
        c = SupplierConnection(org_id=org_id, connector=key, secrets="")
        db.session.add(c)
    secret_names = {f["name"] for f in spec.fields if f.get("secret")}
    plain_names = {f["name"] for f in spec.fields if not f.get("secret")}
    settings = dict(c.settings or {})
    for k in plain_names:
        if k in (data.get("settings") or {}):
            settings[k] = str(data["settings"][k] or "").strip()[:500]
    for k in ("setup_url",):
        if settings.get(k) and not str(settings[k]).startswith("https://"):
            raise RuleError("The catalog address must start with https://.", 422)
    c.settings = settings
    try:
        secrets = crypto.decrypt_json(c.secrets) or {}
    except crypto.DecryptError:
        secrets = {}
    for k, v in (data.get("secrets") or {}).items():
        if k in secret_names and v not in (None, ""):  # blank = keep what's stored
            secrets[k] = str(v)[:200_000]
    c.secrets = crypto.encrypt_json(secrets) if secrets else ""
    c.supplier_key = str(data.get("supplier_key") or c.supplier_key or spec.supplier_key)[:60]
    c.name = str(data.get("name") or c.name or spec.name)[:120]
    if "enabled" in data:
        c.enabled = bool(data["enabled"])
    db.session.flush()
    emit(
        "supplier_connection.saved",
        entity_type="supplier_connection",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"{c.name} saved",
        org_id=org_id,
        data={"connector": key, "secrets_changed": sorted(data.get("secrets") or {})},
    )
    return c


def test_connection(c: SupplierConnection, http: Any = None) -> str:
    spec = conn_mod.SPECS.get(c.connector)
    try:
        if spec and spec.kind == "punchout":
            if not (c.settings or {}).get("setup_url"):
                raise conn_mod.ConnectorError("Add the catalog address.")
            msg = "Settings saved. PunchOut is tried when you start shopping."
        else:
            conn_mod.connector_for(c, http=http).test()
            msg = "Connected."
        c.last_success_at, c.last_error = utcnow(), ""
        return msg
    except (conn_mod.ConnectorError, fetch_mod.FetchError) as e:
        c.last_error_at, c.last_error = utcnow(), str(e)[:2000]
        raise RuleError(str(e), 422) from e


# ---------------------------------------------------------------- PunchOut (MP-088)


def punchout_start(
    org: Any, member: Any, user: Any, connection: SupplierConnection, return_base: str, post: Any = None
) -> dict[str, Any]:
    from mpro.suppliers import punchout as po

    spec = conn_mod.SPECS.get(connection.connector)
    if spec is None or spec.kind != "punchout" or not connection.enabled:
        raise RuleError("That connection isn't a PunchOut catalog.", 422)
    secrets = crypto.decrypt_json(connection.secrets) or {}
    cookie = po.new_buyer_cookie()
    return_url = f"{return_base.rstrip('/')}/api/v1/punchout/return/{cookie}"
    session = PunchOutSession(org_id=org.id, connection_id=connection.id, user_id=user.id, buyer_cookie=cookie)
    db.session.add(session)
    if connection.connector == "punchout_cxml":
        doc = po.cxml_setup_request(
            connection.settings or {},
            str(secrets.get("shared_secret") or ""),
            cookie,
            return_url,
            user_email=user.email,
            user_name=user.name,
        )
        sender = post or _post_xml
        try:
            raw = sender(str((connection.settings or {}).get("setup_url") or ""), doc)
            start = po.parse_setup_response(raw)
        except (po.PunchOutError, fetch_mod.FetchError) as e:
            connection.last_error_at, connection.last_error = utcnow(), str(e)[:2000]
            raise RuleError(str(e), 502) from e
        session.start_url = start[:1000]
        connection.last_success_at = utcnow()
        db.session.flush()
        return {"session_id": str(session.id), "redirect": start}
    form = po.oci_start_form(connection.settings or {}, str(secrets.get("password") or ""), return_url)
    session.start_url = form["action"][:1000]
    db.session.flush()
    return {"session_id": str(session.id), "form": form}


def _post_xml(url: str, doc: bytes) -> bytes:
    fetch_mod.check_url(url)
    r = fetch_mod._transport(
        "POST", url, {"Content-Type": "text/xml; charset=utf-8", "User-Agent": fetch_mod.USER_AGENT}, doc, 1024 * 1024
    )
    if 300 <= r.status < 400:  # redirects aren't followed: the next hop wouldn't have been checked
        raise fetch_mod.FetchError("The supplier's address redirects somewhere else; use the final address.")
    if r.status >= 400:
        raise fetch_mod.FetchError(f"The supplier answered with an error ({r.status}).")
    return r.body


def punchout_return(cookie: str, form: dict[str, str]) -> PunchOutSession:
    """The supplier's browser post with the cart. Creates a Requested PO for the person who started shopping (a
    manager reviews it, and the approval rules run then). This request has no signed-in user: g.org is the
    session's org and g.user is cleared. The session row is locked and marked, so a replayed post can't create a
    second purchase order."""
    from flask import g

    from mpro.orgs.models import Membership, Organization
    from mpro.suppliers import punchout as po

    g.user = None
    session = db.session.scalars(
        select(PunchOutSession)
        .where(PunchOutSession.buyer_cookie == cookie)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if session is None or session.status != "started" or utcnow() - session.created_at > timedelta(hours=8):
        raise RuleError("This shopping session has ended. Start PunchOut again from MPro.", 410)
    connection = db.session.get(SupplierConnection, session.connection_id)
    if connection is None or connection.org_id != session.org_id:
        raise RuleError("This shopping session has ended.", 410)
    org = db.session.get(Organization, session.org_id)
    if org is None:
        raise RuleError("This shopping session has ended.", 410)
    g.org = org
    if connection.connector == "punchout_cxml":
        raw = po.order_message_from_form(form)
        sent_cookie, lines = po.parse_order_message(raw)
        if sent_cookie and sent_cookie != cookie:
            raise RuleError("The returned cart belongs to a different session.", 400)
        session.raw = raw.decode("utf-8", "replace")[:200_000]
    else:
        lines = po.parse_oci(form)
    session.cart = [ln.to_dict() for ln in lines]
    session.status = "returned"
    session.returned_at = utcnow()
    if not lines:
        db.session.flush()
        return session
    member = db.session.scalars(
        select(Membership).where(
            Membership.org_id == session.org_id, Membership.user_id == session.user_id, Membership.deleted_at.is_(None)
        )
    ).first()
    if member is None or not (can(member, "po.request") or can(member, "po.manage")):
        raise RuleError("You can no longer request purchase orders here.", 403)
    vendor_id = None
    if connection.supplier_key:
        vendor_id = _link_vendor(org.id, None, connection.supplier_key)
    po_lines = [_cart_line_to_po(org.id, connection.supplier_key, ln) for ln in lines]
    created = create_po(org, member, vendor_id, po_lines, "punchout", as_request=True, commit=False)
    session.purchase_order_id = getattr(created, "id", None)
    session.status = "converted"
    if hasattr(created, "punchout_session_id"):
        created.punchout_session_id = session.id
    db.session.flush()
    return session


def _cart_line_to_po(org_id: uuid.UUID, supplier_key: str, ln: Any) -> dict[str, Any]:
    from mpro.parts.models import PartVendor

    part_id = None
    link_id = None
    if ln.supplier_part_id:
        link = db.session.scalars(
            select(ProductLink).where(
                ProductLink.org_id == org_id,
                ProductLink.entity_type == "part",
                ProductLink.deleted_at.is_(None),
                or_(ProductLink.supplier_sku == ln.supplier_part_id, ProductLink.external_id == ln.supplier_part_id),
                *([ProductLink.supplier_key == supplier_key] if supplier_key else []),
            )
        ).first()
        if link is not None:
            part_id, link_id = link.entity_id, link.id
        else:
            pv = db.session.scalars(
                select(PartVendor).where(
                    PartVendor.org_id == org_id, PartVendor.vendor_part_number == ln.supplier_part_id
                )
            ).first()
            if pv is not None:
                part_id = pv.part_id
    return {
        "part_id": str(part_id) if part_id else None,
        "description": ln.description,
        "part_number": ln.supplier_part_id,
        "unit": ln.unit or "each",
        "quantity": str(ln.quantity),
        "unit_cost": str(ln.unit_price),
        "product_link_id": str(link_id) if link_id else None,
    }
