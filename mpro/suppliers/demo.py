"""Demo data for supplier product links (0.5.0): cached product details only, no network."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from mpro.assets.models import Asset
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.parts.models import Part
from mpro.suppliers.models import Product, ProductLink, ProductPrice

# (supplier, id, url, title, brand, price, availability, mpn, history (days ago, price), replacement)
DEMO: list[dict[str, Any]] = [
    {
        "supplier": "grainger",
        "id": "1A120",
        "url": "https://www.grainger.com/product/1A120",
        "title": "V-Belt, 4L360, 36 in Outside Length, 1/2 in Top Width",
        "brand": "Dayton",
        "price": "14.85",
        "availability": "in_stock",
        "mpn": "1A120",
        "history": [(90, "13.95"), (60, "14.20"), (30, "14.85")],
    },
    {
        "supplier": "mcmaster",
        "id": "2165K24",
        "url": "https://www.mcmaster.com/2165K24",
        "title": "Pleated Air Filter, MERV 8, 20 x 20 x 2 in",
        "brand": "McMaster-Carr",
        "price": "9.42",
        "availability": "in_stock",
        "mpn": "2165K24",
        "history": [(120, "8.90"), (45, "9.42")],
    },
    {
        "supplier": "amazon",
        "id": "B07PJV4WS3",
        "url": "https://www.amazon.com/dp/B07PJV4WS3",
        "title": "Hydraulic Hose Repair Kit, 3/8 in, 3000 PSI",
        "brand": "Generic",
        "price": "32.99",
        "availability": "limited",
        "mpn": "",
        "history": [(60, "29.99"), (20, "34.50"), (2, "32.99")],
    },
    {
        "supplier": "mcmaster",
        "id": "6384K365",
        "url": "https://www.mcmaster.com/6384K365",
        "title": "Ball Bearing, Shielded, 6205-2Z, 25 mm Shaft",
        "brand": "McMaster-Carr",
        "price": "11.60",
        "availability": "discontinued",
        "mpn": "6205-2Z",
        "history": [(200, "10.90"), (100, "11.60")],
        "replacement": "https://www.mcmaster.com/5972K91",
    },
]


def seed_suppliers(org: Any, admin: Any) -> None:
    # seeding runs once per demo org; a second call (re-seed) must not duplicate listings
    if db.session.scalars(select(Product.id).where(Product.org_id == org.id).limit(1)).first() is not None:
        return
    parts = db.session.scalars(
        select(Part).where(Part.org_id == org.id, Part.deleted_at.is_(None)).order_by(Part.created_at).limit(len(DEMO))
    ).all()
    assets = db.session.scalars(
        select(Asset).where(Asset.org_id == org.id, Asset.deleted_at.is_(None)).order_by(Asset.created_at).limit(2)
    ).all()
    now = utcnow()
    for i, d in enumerate(DEMO):
        p = Product(
            org_id=org.id,
            supplier_key=d["supplier"],
            external_id=d["id"],
            url=d["url"],
            title=d["title"],
            brand=d["brand"],
            price=Decimal(d["price"]),
            currency="USD",
            price_unit="each",
            availability=d["availability"],
            sku=d["id"],
            mpn=d["mpn"],
            replacement_url=d.get("replacement", ""),
            source="jsonld" if d["supplier"] != "mcmaster" else "api",
            fetched_at=now - timedelta(hours=2 + i * 20),  # the last one is over a day old: "may have changed"
            fetch_status="ok",
            next_refresh_at=now + timedelta(days=1),
        )
        db.session.add(p)
        db.session.flush()
        for days, price in d["history"]:
            db.session.add(
                ProductPrice(
                    org_id=org.id,
                    product_id=p.id,
                    at=now - timedelta(days=days),
                    price=Decimal(price),
                    currency="USD",
                    availability="in_stock",
                )
            )
        if i < len(parts):
            entity_type, entity_id, role = "part", parts[i].id, "listing"
        elif assets:
            entity_type, entity_id, role = "asset", assets[i % len(assets)].id, "spare_part"
        else:
            continue
        db.session.add(
            ProductLink(
                org_id=org.id,
                entity_type=entity_type,
                entity_id=entity_id,
                role=role,
                product_id=p.id,
                url=d["url"],
                supplier_key=d["supplier"],
                external_id=d["id"],
                supplier_sku=d["id"],
                mpn=d["mpn"],
                unit="each",
                preferred=True,
                alert_price_change_pct=Decimal("10"),
                alert_out_of_stock=True,
                last_paid_price=Decimal(d["history"][0][1]),
                created_by_id=admin.id,
            )
        )
    if assets:  # where the first asset was bought (MP-089 "Purchased from")
        bought = Product(
            org_id=org.id,
            supplier_key="grainger",
            external_id="5Z680",
            url="https://www.grainger.com/product/5Z680",
            title=f"{assets[0].name}: replacement unit listing",
            brand="",
            price=Decimal("6420.00"),
            currency="USD",
            availability="in_stock",
            source="manual",
            fetched_at=now - timedelta(hours=5),
            fetch_status="ok",
            next_refresh_at=now + timedelta(days=1),
        )
        db.session.add(bought)
        db.session.flush()
        db.session.add(
            ProductLink(
                org_id=org.id,
                entity_type="asset",
                entity_id=assets[0].id,
                role="purchased_from",
                product_id=bought.id,
                url=bought.url,
                supplier_key="grainger",
                external_id="5Z680",
                note="Bought with the building fit-out",
                created_by_id=admin.id,
            )
        )
    db.session.flush()
