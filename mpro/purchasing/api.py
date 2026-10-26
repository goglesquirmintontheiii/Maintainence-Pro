"""Purchase orders REST API (/api/v1), 0.5.0 (MP-042–044, r227–r232, r249–r259, r268)."""

from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request
from sqlalchemy import func, or_, select

from mpro.core.files import Export, FileError, export_dict, exporter, register_entity, request_export
from mpro.core.permissions import can, can_on
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.orgs.services import RuleError
from mpro.purchasing import services as svc
from mpro.purchasing.models import Address, ApprovalRule, Budget, PurchaseOrder

bp = APIBlueprint("purchasing", __name__, url_prefix="/api/v1", tag="Purchase Orders")


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


def _po(pid: str) -> PurchaseOrder:
    return guard(svc.get_po, g.org.id, pid)


def _detail(po: PurchaseOrder, warnings: list[str] | None = None) -> dict[str, Any]:
    d = svc.po_detail(po, g.membership)
    if warnings:
        d["warnings"] = warnings
    return d


def _manage(po: PurchaseOrder) -> None:
    if not can_on(g.membership, "po.manage", po):
        abort(403, message="You can't change this purchase order.")


# ---- settings ------------------------------------------------------------------------------------
@bp.get("/purchasing/settings")
@require("po.view")
def get_settings() -> dict[str, Any]:
    return {**svc.settings(g.org.id), "next_number": svc.peek_next_number(g.org.id)}


@bp.patch("/purchasing/settings")
@require("po.settings")
def patch_settings() -> dict[str, Any]:
    """{number_prefix, default_title, default_cc: [emails], single_address, requests_need_review, next_number}"""
    return guard(svc.update_settings, g.org, body())


@bp.get("/purchase-orders/options")
@require("po.view")
def options() -> dict[str, Any]:
    m = g.membership
    return {
        "settings": svc.settings(g.org.id),
        "statuses": [{"id": k, "label": v} for k, v in svc.STATUS_LABELS.items()],
        "addresses": svc.list_addresses(g.org.id),
        "budgets": [b for b in svc.list_budgets(g.org.id, svc.sees_costs(m)) if b["active"]],
        "can": {
            "request": can(m, "po.request"),
            "manage": can(m, "po.manage") or can(m, "po.manage_own"),
            "approve": can(m, "po.approve"),
            "receive": can(m, "po.receive"),
            "delete": can(m, "po.delete"),
            "settings": can(m, "po.settings"),
            "costs": svc.sees_costs(m),
            "export": can(m, "exports.use"),
        },
    }


# ---- purchase orders ------------------------------------------------------------------------------
@bp.get("/purchase-orders")
@require("po.view")
def list_pos() -> dict[str, Any]:
    """Query: status (open|overdue|awaiting_me|<status>[,<status>]), vendor_id, work_order_id, part_id, mine, q,
    sort (created|due|number), page, per_page."""
    return guard(svc.list_pos, g.membership, dict(request.args.items()))


@bp.post("/purchase-orders")
@require("po.view")
def create_po() -> tuple[dict[str, Any], int]:
    """{vendor_id, title, custom_number, vendor_contact_ids, currency, due_on, shipping_address_id, billing_address_id,
    notes, custom, work_order_id, budget_id, lines: [{part_id?, description, part_number?, unit?, quantity, unit_cost,
    location_id?, taxable?}], costs: [{label, kind: fixed|percent, value, is_tax, taxable}], as_request?}"""
    po = guard(svc.create_purchase_order, g.org, g.membership, body())
    return _detail(po), 201


@bp.get("/purchase-orders/suggestions")
@require("po.view")
def suggestions() -> dict[str, Any]:
    """Parts under their minimum, grouped by vendor (MP-044)."""
    if not (can(g.membership, "po.manage") or can(g.membership, "po.manage_own") or can(g.membership, "po.request")):
        abort(403, message="You don't have permission to order parts.")
    groups = svc.suggestions(g.org.id)
    if not svc.sees_costs(g.membership):
        for grp in groups:
            for ln in grp["lines"]:
                ln["unit_cost"] = None
    return {"groups": groups}


@bp.post("/purchase-orders/from-suggestions")
@require("po.view")
def from_suggestions() -> tuple[dict[str, Any], int]:
    """{vendor_id | null, part_ids?} — raise one PO for that vendor's low-stock parts."""
    return _detail(guard(svc.po_from_suggestion, g.org, g.membership, body())), 201


@bp.post("/work-orders/<wo_id>/purchase-order")
@require("po.view")
def po_from_wo(wo_id: str) -> tuple[dict[str, Any], int]:
    """PO from a work order's parts (r258). Optional {vendor_id, lines}."""
    from mpro.workorders.api import _wo

    wo = _wo(wo_id)
    return _detail(guard(svc.po_from_work_order, g.org, g.membership, wo, body())), 201


@bp.post("/purchase-orders/export")
@require("po.view")
def export_pos() -> tuple[dict[str, Any], int]:
    if not can(g.membership, "exports.use"):
        abort(403, message="You don't have permission to export.")
    ex = guard(request_export, g.org.id, g.user.id, "purchase_orders.csv", "Purchase orders (CSV)", {})
    db.session.commit()
    return export_dict(ex), 202


@exporter("purchase_orders.csv")
def _pos_csv(ex: Export) -> tuple[str, bytes, str]:
    m = db.session.scalars(
        select(Membership).where(
            Membership.org_id == ex.org_id, Membership.user_id == ex.user_id, Membership.deleted_at.is_(None)
        )
    ).first()
    return "purchase-orders.csv", svc.export_csv(ex.org_id, svc.sees_costs(m)), "text/csv"


@bp.get("/purchase-orders/<pid>")
@require("po.view")
def get_po(pid: str) -> dict[str, Any]:
    return _detail(_po(pid))


@bp.patch("/purchase-orders/<pid>")
@require("po.view")
def patch_po(pid: str) -> dict[str, Any]:
    po, warnings = guard(svc.update_purchase_order, g.org, g.membership, _po(pid), body())
    return _detail(po, warnings)


@bp.delete("/purchase-orders/<pid>")
@require("po.delete")
def delete_po(pid: str) -> tuple[str, int]:
    guard(svc.delete_po, g.org, g.membership, _po(pid))
    return "", 204


@bp.post("/purchase-orders/<pid>/approve")
@require("po.view")
def approve(pid: str) -> dict[str, Any]:
    """{comment?} — review a request, or approve a pending step you're an approver for."""
    return _detail(guard(svc.approve, g.org, g.membership, _po(pid), str(body().get("comment") or "")))


@bp.post("/purchase-orders/<pid>/reject")
@require("po.view")
def reject(pid: str) -> dict[str, Any]:
    """{reason}"""
    return _detail(guard(svc.reject, g.org, g.membership, _po(pid), str(body().get("reason") or "")))


@bp.post("/purchase-orders/<pid>/receive")
@require("po.receive")
def receive(pid: str) -> dict[str, Any]:
    """{lines: [{line_id, quantity, unit_cost?, location_id?}], note?, packing_slip?}"""
    po = _po(pid)
    _rec, warnings = guard(svc.receive, g.org, g.membership, po, body())
    return _detail(po, warnings)


@bp.post("/purchase-orders/<pid>/complete")
@require("po.view")
def complete(pid: str) -> dict[str, Any]:
    po = _po(pid)
    _manage(po)
    return _detail(guard(svc.complete, g.org, g.membership, po))


@bp.post("/purchase-orders/<pid>/reopen")
@require("po.view")
def reopen(pid: str) -> dict[str, Any]:
    po = _po(pid)
    _manage(po)
    return _detail(guard(svc.reopen, g.org, g.membership, po))


@bp.post("/purchase-orders/<pid>/cancel")
@require("po.delete")
def cancel(pid: str) -> dict[str, Any]:
    return _detail(guard(svc.cancel, g.org, g.membership, _po(pid), str(body().get("reason") or "")))


@bp.post("/purchase-orders/<pid>/duplicate")
@require("po.view")
def duplicate(pid: str) -> tuple[dict[str, Any], int]:
    po = _po(pid)
    if not (can(g.membership, "po.manage") or can(g.membership, "po.manage_own") or can(g.membership, "po.request")):
        abort(403, message="You don't have permission to create purchase orders.")
    return _detail(guard(svc.duplicate, g.org, g.membership, po)), 201


@bp.post("/purchase-orders/<pid>/send")
@require("po.view")
def send(pid: str) -> dict[str, Any]:
    """{to?: [emails], cc?: [emails], message?} — PDF emailed to the vendor's PO contact (MP-043)."""
    po = _po(pid)
    _manage(po)
    out = guard(svc.send_to_vendor, g.org, g.membership, po, body())
    return {**_detail(po), "sent": out}


@bp.get("/purchase-orders/<pid>/pdf")
@require("po.view")
def pdf(pid: str) -> Response:
    from mpro.purchasing.pdf import po_pdf

    po = _po(pid)
    if not svc.sees_costs(g.membership):
        abort(403, message="You don't have permission to see purchase order costs.")
    name = svc.po_number(po)
    return Response(
        po_pdf(po), mimetype="application/pdf", headers={"Content-Disposition": f'inline; filename="{name}.pdf"'}
    )


@bp.get("/purchase-orders/<pid>/comments")
@require("po.view")
def list_comments(pid: str) -> dict[str, Any]:
    return {"items": svc.comments(_po(pid))}


@bp.post("/purchase-orders/<pid>/comments")
@require("po.view")
def add_comment(pid: str) -> tuple[dict[str, Any], int]:
    po = _po(pid)
    guard(svc.add_comment, g.org, g.membership, po, str(body().get("body") or ""))
    return {"items": svc.comments(po)}, 201


@bp.delete("/purchase-orders/<pid>/comments/<cid>")
@require("po.view")
def delete_comment(pid: str, cid: str) -> tuple[str, int]:
    guard(svc.delete_comment, g.org, g.membership, _po(pid), cid)
    return "", 204


# ---- addresses (r252) -----------------------------------------------------------------------------
@bp.get("/addresses")
@require("po.view")
def list_addresses() -> dict[str, Any]:
    return {"items": svc.list_addresses(g.org.id)}


@bp.post("/addresses")
@require("po.settings")
def create_address() -> tuple[dict[str, Any], int]:
    return svc.address_dict(guard(svc.save_address, g.org, body())), 201


@bp.patch("/addresses/<aid>")
@require("po.settings")
def patch_address(aid: str) -> dict[str, Any]:
    return svc.address_dict(guard(svc.save_address, g.org, body(), get_scoped(Address, aid)))


@bp.delete("/addresses/<aid>")
@require("po.settings")
def delete_address(aid: str) -> tuple[str, int]:
    svc.delete_address(g.org, get_scoped(Address, aid))
    return "", 204


# ---- budgets (r268) ---------------------------------------------------------------------------------
@bp.get("/budgets")
@require("po.view")
def list_budgets() -> dict[str, Any]:
    return {"items": svc.list_budgets(g.org.id, svc.sees_costs(g.membership))}


@bp.post("/budgets")
@require("po.settings")
def create_budget() -> tuple[dict[str, Any], int]:
    return svc.budget_dict(guard(svc.save_budget, g.org, body())), 201


@bp.patch("/budgets/<bid>")
@require("po.settings")
def patch_budget(bid: str) -> dict[str, Any]:
    return svc.budget_dict(guard(svc.save_budget, g.org, body(), get_scoped(Budget, bid)))


@bp.delete("/budgets/<bid>")
@require("po.settings")
def delete_budget(bid: str) -> tuple[str, int]:
    svc.delete_budget(g.org, get_scoped(Budget, bid))
    return "", 204


# ---- approval rules (r230) ---------------------------------------------------------------------------
@bp.get("/approval-rules")
@require("po.view")
def list_rules() -> dict[str, Any]:
    """Query: applies_to = purchase_order | vendor_invoice."""
    at = request.args.get("applies_to")
    if at and at not in ("purchase_order", "vendor_invoice"):
        abort(422, message="applies_to must be purchase_order or vendor_invoice.")
    return {"items": svc.list_rules(g.org.id, at)}


@bp.post("/approval-rules")
@require("po.settings")
def create_rule() -> tuple[dict[str, Any], int]:
    """{applies_to, name, conditions: [...], action: approvers|auto_approve, approver_user_ids, approver_team_ids,
    active}"""
    return svc.rule_dict(guard(svc.save_rule, g.org, body())), 201


@bp.patch("/approval-rules/<rid>")
@require("po.settings")
def patch_rule(rid: str) -> dict[str, Any]:
    return svc.rule_dict(guard(svc.save_rule, g.org, body(), get_scoped(ApprovalRule, rid)))


@bp.delete("/approval-rules/<rid>")
@require("po.settings")
def delete_rule(rid: str) -> tuple[str, int]:
    svc.delete_rule(g.org, get_scoped(ApprovalRule, rid))
    return "", 204


# ---- search and file access ---------------------------------------------------------------------------
@provider("purchase_orders", "Purchase orders", "po.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    from mpro.vendors.models import Vendor

    prefix = svc.settings(g.org.id)["number_prefix"]
    conds: list[Any] = [
        func.lower(PurchaseOrder.title).like(like(q), escape="\\"),
        func.lower(PurchaseOrder.custom_number).like(like(q), escape="\\"),
        PurchaseOrder.vendor_id.in_(
            select(Vendor.id).where(Vendor.org_id == g.org.id, func.lower(Vendor.name).like(like(q), escape="\\"))
        ),
    ]
    digits = q.strip().lstrip("#").removeprefix(prefix)
    if digits.isdigit():
        conds.append(PurchaseOrder.number == int(digits))
    rows = db.session.scalars(
        scoped(PurchaseOrder).where(or_(*conds)).order_by(PurchaseOrder.created_at.desc()).limit(limit)
    ).all()
    return [
        {
            "id": str(p.id),
            "title": f"{svc.po_number(p, prefix)} {p.title}".strip(),
            "subtitle": svc.STATUS_LABELS[p.status],
            "url": f"/purchase-orders/{p.id}",
        }
        for p in rows
    ]


def _po_ok(pid: uuid.UUID, edit: bool) -> bool:
    po = db.session.get(PurchaseOrder, pid)
    if po is None or po.org_id != g.org.id or po.deleted_at is not None:
        return False
    return svc.can_edit(g.membership, po) if edit else can(g.membership, "po.view")


register_entity("purchase_order", lambda pid: _po_ok(pid, False), lambda pid: _po_ok(pid, True))


# ---------------------------------------------------------------- vendor acknowledgment (r261), no sign-in
# The secret link in the PO email is the credential: no session, exempt from the session CSRF check, rate limited
# per IP and per link (shared with external work-order links), and it only ever touches its own purchase order.
@bp.get("/vendor-po/<token>")
@bp.doc(security=[])
def vendor_po(token: str) -> dict[str, Any]:
    from mpro.purchasing import vendor_ack

    link, po, org = guard(vendor_ack.resolve, token)
    return guard(vendor_ack.public_view, link, po, org)


@bp.post("/vendor-po/<token>/respond")
@bp.doc(security=[])
def vendor_po_respond(token: str) -> dict[str, Any]:
    """{response: acknowledged | proposed_date | declined, name, date? (YYYY-MM-DD), note?}"""
    from mpro.purchasing import vendor_ack

    link, po, org = guard(vendor_ack.resolve, token, True)
    return {"answer": guard(vendor_ack.respond, link, po, org, body())}


def _exempt_vendor_links() -> None:
    from mpro.auth.api import CSRF_EXEMPT

    CSRF_EXEMPT.update({"purchasing.vendor_po", "purchasing.vendor_po_respond"})


_exempt_vendor_links()
