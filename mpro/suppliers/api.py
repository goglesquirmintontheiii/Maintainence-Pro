"""Supplier product links REST API (/api/v1). Built in 0.5.0 (MP-084–089)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import current_app, g, redirect, request
from sqlalchemy import func, or_, select

from mpro.assets.models import Asset
from mpro.auth.api import CSRF_EXEMPT
from mpro.core.files import FileError, register_entity
from mpro.core.jobs import job, periodic
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.parts.models import Part
from mpro.purchasing.hooks import PO_RECEIVED_HOOKS
from mpro.suppliers import connectors as conn_mod
from mpro.suppliers import recognize as rec
from mpro.suppliers import services as svc
from mpro.suppliers.models import Product, ProductLink, SupplierConnection, SupplierSite

bp = APIBlueprint("suppliers", __name__, url_prefix="/api/v1", tag="Suppliers")

CSRF_EXEMPT.add("suppliers.punchout_return")  # the supplier's site posts the cart back (cross-site form post)


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except (RuleError, FileError) as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


def _need(action: str) -> None:
    if not can(g.membership, action):
        abort(403, message="You don't have permission to do that.")


def _entity_view(entity_type: str) -> None:
    if entity_type not in svc.ENTITY_TYPES:
        abort(422, message="Links can be added to parts and assets.")
    _need("parts.view" if entity_type == "part" else "assets.view")


# ---------------------------------------------------------------- suppliers and recognition


@bp.get("/suppliers")
@require("org.view")
def list_suppliers() -> Any:
    if not (can(g.membership, "parts.view") or can(g.membership, "assets.view")):
        abort(403, message="You don't have permission to do that.")
    return {"items": [s.to_dict() for s in rec.all_suppliers(g.org.id)]}


@bp.post("/suppliers/recognize")
@require("suppliers.links")
def recognize_url() -> Any:
    return guard(lambda: rec.recognize(str(body().get("url") or ""), g.org.id).to_dict())


# ---------------------------------------------------------------- links


@bp.get("/product-links")
@require("org.view")
def list_links() -> Any:
    et = request.args.get("entity_type", "")
    _entity_view(et)
    entity = guard(svc.entity_record, g.org.id, et, request.args.get("entity_id"))
    role = request.args.get("role") or None
    links = svc.links_for(g.org.id, et, entity.id, role)
    return {
        "items": [svc.link_dict(link, member=g.membership) for link in links],
        "can_edit": can(g.membership, "suppliers.links"),
        "can_order": can(g.membership, "po.request"),
    }


@bp.post("/product-links")
@require("suppliers.links")
def create_link() -> Any:
    data = body()
    _entity_view(str(data.get("entity_type") or ""))
    link = guard(svc.add_link, g.org.id, g.membership, data)
    db.session.commit()
    db.session.refresh(link)
    return svc.link_dict(link, member=g.membership), 201


@bp.get("/product-links/compare")
@require("org.view")
def compare_links() -> Any:
    et = request.args.get("entity_type", "")
    _entity_view(et)
    entity = guard(svc.entity_record, g.org.id, et, request.args.get("entity_id"))
    return {"items": svc.compare(g.org.id, et, entity.id)}


def _link(link_id: str, edit: bool = False) -> ProductLink:
    link = guard(svc.get_link, g.org.id, link_id)
    _entity_view(link.entity_type)
    if edit:
        _need("suppliers.links")
    return link


@bp.get("/product-links/<link_id>")
@require("org.view")
def get_link(link_id: str) -> Any:
    return svc.link_dict(_link(link_id), member=g.membership)


@bp.patch("/product-links/<link_id>")
@require("suppliers.links")
def patch_link(link_id: str) -> Any:
    link = _link(link_id, True)
    guard(svc.update_link, g.org.id, link, body())
    db.session.commit()
    return svc.link_dict(link, member=g.membership)


@bp.delete("/product-links/<link_id>")
@require("suppliers.links")
def remove_link(link_id: str) -> Any:
    link = _link(link_id, True)
    svc.delete_link(g.org.id, link)
    db.session.commit()
    return "", 204


@bp.post("/product-links/<link_id>/refresh")
@require("suppliers.links")
def refresh_link(link_id: str) -> Any:
    link = _link(link_id, True)
    product = db.session.get(Product, link.product_id)
    if product is not None:
        svc.queue_refresh(product)
    db.session.commit()
    db.session.refresh(link)
    return svc.link_dict(link, member=g.membership), 202


@bp.get("/product-links/<link_id>/po-line")
@require("po.request")
def link_po_line(link_id: str) -> Any:
    link = _link(link_id)
    qty = request.args.get("quantity")
    return guard(svc.po_line_for, g.org.id, link, guard(svc._opt_dec, qty, "quantity") if qty else None)


@bp.post("/product-links/<link_id>/reorder")
@require("po.request")
def reorder_link(link_id: str) -> Any:
    link = _link(link_id)
    po = guard(svc.reorder, g.org, g.membership, link, body().get("quantity"))
    db.session.commit()
    return {"purchase_order_id": str(po.id), "url": f"/purchase-orders/{po.id}"}, 201


@bp.get("/products/<product_id>")
@require("org.view")
def get_product(product_id: str) -> Any:
    p = _product(product_id)
    return {**svc.product_dict(p), "history": svc.price_history(p, int(request.args.get("days", 365) or 365))}


def _product(product_id: str) -> Product:
    if not (can(g.membership, "parts.view") or can(g.membership, "assets.view")):
        abort(403, message="You don't have permission to do that.")
    return get_scoped(Product, product_id)


@bp.get("/products/<product_id>/prices")
@require("org.view")
def product_prices(product_id: str) -> Any:
    p = _product(product_id)
    days = max(1, min(3650, int(request.args.get("days", 365) or 365)))
    return {"items": svc.price_history(p, days), "currency": p.currency}


@bp.get("/assets/<asset_id>/spare-parts")
@require("assets.view")
def asset_spare_parts(asset_id: str) -> Any:
    a = get_scoped(Asset, asset_id)
    return {
        **svc.spare_parts(g.org.id, a, g.membership),
        "can_edit": can(g.membership, "suppliers.links"),
        "can_order": can(g.membership, "po.request"),
    }


# ---------------------------------------------------------------- supplier patterns (org's own suppliers)


@bp.get("/supplier-sites")
@require("suppliers.connections")
def list_sites() -> Any:
    rows = db.session.scalars(scoped(SupplierSite).order_by(SupplierSite.name)).all()
    return {
        "items": [svc.site_dict(s) for s in rows],
        "builtin": [s.to_dict() for s in rec.builtin_suppliers() if s.key != "amazon_short"],
    }


@bp.post("/supplier-sites")
@require("suppliers.connections")
def create_site() -> Any:
    site = guard(svc.save_site, g.org.id, body())
    db.session.commit()
    return svc.site_dict(site), 201


@bp.patch("/supplier-sites/<site_id>")
@require("suppliers.connections")
def patch_site(site_id: str) -> Any:
    site = get_scoped(SupplierSite, site_id)
    guard(svc.save_site, g.org.id, body(), site)
    db.session.commit()
    return svc.site_dict(site)


@bp.delete("/supplier-sites/<site_id>")
@require("suppliers.connections")
def delete_site(site_id: str) -> Any:
    from mpro.core.events import emit
    from mpro.core.models import utcnow

    site = get_scoped(SupplierSite, site_id)
    site.deleted_at = utcnow()
    emit(
        "supplier_site.deleted",
        entity_type="supplier_site",
        entity_id=site.id,
        entity_label=site.name,
        summary=f"Supplier pattern {site.name} removed",
    )
    db.session.commit()
    return "", 204


# ---------------------------------------------------------------- connections (MP-086, MP-088)


def _specs() -> list[dict[str, Any]]:
    return [
        {
            "key": s.key,
            "name": s.name,
            "supplier_key": s.supplier_key,
            "fields": s.fields,
            "docs": s.docs,
            "kind": s.kind,
            "needs_account": True,
        }
        for s in conn_mod.SPECS.values()
    ]


@bp.get("/supplier-connections")
@require("suppliers.connections")
def list_connections() -> Any:
    rows = db.session.scalars(scoped(SupplierConnection).order_by(SupplierConnection.created_at)).all()
    return {"items": [svc.connection_dict(c) for c in rows], "connectors": _specs()}


@bp.post("/supplier-connections")
@require("suppliers.connections")
def create_connection() -> Any:
    c = guard(svc.save_connection, g.org.id, body())
    db.session.commit()
    return svc.connection_dict(c), 201


@bp.patch("/supplier-connections/<conn_id>")
@require("suppliers.connections")
def patch_connection(conn_id: str) -> Any:
    c = get_scoped(SupplierConnection, conn_id)
    data = body()
    data.pop("connector", None)
    guard(svc.save_connection, g.org.id, data, c)
    db.session.commit()
    return svc.connection_dict(c)


@bp.delete("/supplier-connections/<conn_id>")
@require("suppliers.connections")
def delete_connection(conn_id: str) -> Any:
    from mpro.core.events import emit
    from mpro.core.models import utcnow

    c = get_scoped(SupplierConnection, conn_id)
    c.deleted_at, c.secrets, c.enabled = utcnow(), "", False
    emit(
        "supplier_connection.deleted",
        entity_type="supplier_connection",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"{c.name} disconnected",
    )
    db.session.commit()
    return "", 204


@bp.post("/supplier-connections/<conn_id>/test")
@require("suppliers.connections")
def test_connection(conn_id: str) -> Any:
    c = get_scoped(SupplierConnection, conn_id)
    try:
        msg = svc.test_connection(c)
    except RuleError as e:
        db.session.commit()  # keep the recorded error
        abort(e.status, message=e.message)
    db.session.commit()
    return {"ok": True, "message": msg, **svc.connection_dict(c)}


# ---------------------------------------------------------------- PunchOut


@bp.get("/punchout/catalogs")
@require("po.request")
def punchout_catalogs() -> Any:
    rows = db.session.scalars(
        scoped(SupplierConnection).where(
            SupplierConnection.connector.in_(["punchout_cxml", "punchout_oci"]), SupplierConnection.enabled.is_(True)
        )
    ).all()
    return {
        "items": [
            {
                "id": str(c.id),
                "name": c.name,
                "supplier_key": c.supplier_key,
                "supplier_name": rec.supplier_name(g.org.id, c.supplier_key) if c.supplier_key else c.name,
            }
            for c in rows
        ]
    }


@bp.post("/punchout/start")
@require("po.request")
def punchout_start() -> Any:
    c = get_scoped(SupplierConnection, str(body().get("connection_id") or ""))
    base = current_app.config.get("MPRO_BASE_URL") or request.host_url
    out = guard(svc.punchout_start, g.org, g.membership, g.user, c, base)
    db.session.commit()
    return out


@bp.post("/punchout/return/<cookie>")
@bp.doc(hide=True)
def punchout_return(cookie: str) -> Any:
    form = {k: v for k, v in request.form.items()}
    try:
        session = svc.punchout_return(cookie, form)
    except RuleError as e:
        db.session.rollback()
        return redirect(f"/purchase-orders?punchout_error={_q(e.message)}", 303)
    db.session.commit()
    if session.purchase_order_id:
        return redirect(f"/purchase-orders/{session.purchase_order_id}", 303)
    return redirect("/purchase-orders?punchout_error=" + _q("The cart came back empty."), 303)


def _q(s: str) -> str:
    from urllib.parse import quote

    return quote(s[:200])


# ---------------------------------------------------------------- jobs, search, files, hooks


@job("suppliers.refresh")
def _refresh_job(payload: dict[str, Any]) -> None:
    import uuid

    p = db.session.get(Product, uuid.UUID(payload["product_id"]))
    if p is not None:
        svc.refresh_product(p)
        db.session.commit()


@job("suppliers.refresh_due")
def _refresh_due(_payload: dict[str, Any]) -> None:
    svc.refresh_due()


periodic("suppliers.refresh_due", timedelta(hours=1))


@provider("supplier_products", "Parts by supplier number", "parts.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    pat = like(q)
    rows = db.session.execute(
        select(Part, ProductLink)
        .join(ProductLink, (ProductLink.entity_id == Part.id) & (ProductLink.entity_type == "part"))
        .where(
            Part.org_id == g.org.id,
            Part.deleted_at.is_(None),
            ProductLink.deleted_at.is_(None),
            or_(
                func.lower(ProductLink.supplier_sku).like(pat, escape="\\"),
                func.lower(ProductLink.mpn).like(pat, escape="\\"),
                func.lower(ProductLink.external_id).like(pat, escape="\\"),
            ),
        )
        .limit(limit)
    ).all()
    seen: set[str] = set()
    out = []
    for part, link in rows:
        if str(part.id) in seen:
            continue
        seen.add(str(part.id))
        num = link.supplier_sku or link.mpn or link.external_id
        out.append(
            {
                "id": str(part.id),
                "title": part.name,
                "subtitle": f"{rec.supplier_name(g.org.id, link.supplier_key)} {num}".strip(),
                "url": f"/parts/{part.id}",
            }
        )
    return out


def _can_view_product(product_id: Any) -> bool:
    p = db.session.get(Product, product_id)
    return bool(p and p.org_id == g.org.id and (can(g.membership, "parts.view") or can(g.membership, "assets.view")))


register_entity("product", can_view=_can_view_product, can_edit=lambda _id: False)

if svc.on_po_received not in PO_RECEIVED_HOOKS:
    PO_RECEIVED_HOOKS.append(svc.on_po_received)
