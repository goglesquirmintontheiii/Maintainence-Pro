"""Work-order REST API (/api/v1). The web app uses exactly these endpoints."""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request
from sqlalchemy import func, select

from mpro.core.files import FileError, register_entity, request_export
from mpro.core.models import utcnow
from mpro.core.permissions import can
from mpro.core.search import like, provider
from mpro.core.tenancy import get_scoped, require, scoped
from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.orgs.services import RuleError, members_query
from mpro.workorders import activity as act
from mpro.workorders import queries as qry
from mpro.workorders import services as svc
from mpro.workorders.exports import clean_pdf_options, render_pdf
from mpro.workorders.models import (
    Category,
    Comment,
    CostEntry,
    CustomField,
    SavedView,
    Template,
    TimeEntry,
    WorkOrder,
    WorkOrderCategory,
    WorkOrderLink,
)

bp = APIBlueprint("work_orders", __name__, url_prefix="/api/v1", tag="Work orders")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except svc.Conflict as e:
        db.session.rollback()
        current = db.session.get(WorkOrder, e.wo.id)
        abort(409, message=e.message, detail={"current": qry.detail_dict(g.membership, current) if current else None})
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


def _uuid(v: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError:
        abort(404)


def _wo(wo_id: str, include_deleted: bool = False) -> WorkOrder:
    """Fetch a visible work order of the current org (accepts the UUID or the #number)."""
    q = select(WorkOrder).where(WorkOrder.org_id == g.org.id)
    if wo_id.lstrip("#").isdigit():
        q = q.where(WorkOrder.number == int(wo_id.lstrip("#")))
    else:
        q = q.where(WorkOrder.id == _uuid(wo_id))
    if not include_deleted:
        q = q.where(WorkOrder.deleted_at.is_(None))
    wo = db.session.scalars(q).first()
    if wo is None or not svc.can_see(g.membership, wo):
        abort(404)
    return wo


def _version(b: dict[str, Any] | None = None) -> int | None:
    """The version the client started from: `If-Match` header or `version` in the body."""
    m = re.search(r"\d+", request.headers.get("If-Match", ""))
    if m:
        return int(m.group())
    v = (b if b is not None else body()).get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _detail(wo: WorkOrder) -> dict[str, Any]:
    return qry.detail_dict(g.membership, wo)


def _params() -> dict[str, Any]:
    p: dict[str, Any] = {k: v for k, v in request.args.items()}
    if "filters" in p:
        try:
            p["filters"] = json.loads(p["filters"])
        except ValueError:
            abort(422, message="filters must be JSON.")
    return p


# ---- list, create, options, stats ------------------------------------------------------------
@bp.get("/work-orders")
@require("wo.view")
def list_work_orders() -> dict[str, Any]:
    """List work orders. Query: q, tab (todo|done|upcoming|all), scope (assigned_me|my_teams|created_me|all),
    filters (JSON list of {field, op, value}), sort (e.g. `-priority,due_at`), page, per_page (≤500),
    include_deleted, upcoming."""
    return guard(qry.list_page, g.membership, _params())


@bp.post("/work-orders")
@require("wo.create")
def create_work_order() -> tuple[dict[str, Any], int]:
    """Create a work order. Only `title` is required. Optional: description, priority, work_type, start_at,
    due_at, estimated_minutes, assignees ([{type: user|team, id}]), categories ([ids]), custom ({field: value}),
    parent_id, template_id, file_ids (uploaded via POST /files)."""
    wo = guard(svc.create_work_order, g.org, g.membership, body())
    return _detail(wo), 201


@bp.get("/work-orders/options")
@require("wo.view")
def options() -> dict[str, Any]:
    out = qry.filter_options(g.membership)
    s = svc.wo_settings(g.org.id)
    out["settings"] = {
        k: s[k]
        for k in (
            "required_fields",
            "completion_summary",
            "comment_on_hold",
            "comment_on_cancel",
            "require_signature",
            "require_approval",
            "time_types",
            "cost_types",
            "sub_statuses",
            "default_start_time",
            "default_due_time",
            "workday_minutes",
            "mention_assigns",
        )
    }
    out["next_number"] = svc.peek_next_number(g.org.id)
    return out


@bp.get("/work-orders/stats")
@require("wo.view")
def stats() -> dict[str, Any]:
    return qry.stats(g.membership)


@bp.get("/work-orders/workload")
@require("wo.view")
def workload() -> dict[str, Any]:
    try:
        start = date.fromisoformat(request.args.get("start") or utcnow().date().isoformat())
        days = int(request.args.get("days") or 7)
    except ValueError:
        abort(422, message="start must be YYYY-MM-DD and days a number.")
    team = request.args.get("team")
    return guard(qry.workload, g.membership, g.org, start, days, _uuid(team) if team else None, _params())


@bp.post("/work-orders/bulk")
@require("wo.view")
def bulk() -> dict[str, Any]:
    """Bulk edit: {ids, action, value, comment}. Actions: set_status, set_priority, set_due, clear_due,
    clear_start, add_assignees, remove_assignees, add_categories, remove_categories, mark_read, mark_unread,
    delete, restore, cancel, revert (Undo, with the `undo` list a previous call returned)."""
    b = body()
    ids = b.get("ids") or []
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        abort(422, message="Select between 1 and 500 work orders.")
    uids = [_uuid(i) for i in ids]
    q = select(WorkOrder).where(WorkOrder.org_id == g.org.id, WorkOrder.id.in_(uids))
    wos = [w for w in db.session.scalars(q).all() if svc.can_see(g.membership, w)]
    if b.get("action") not in ("restore", "revert"):
        wos = [w for w in wos if w.deleted_at is None]
    return guard(svc.bulk, g.org, g.membership, wos, str(b.get("action")), b.get("value"), str(b.get("comment") or ""))


@bp.post("/work-orders/export")
@require("exports.use")
def export() -> tuple[dict[str, Any], int]:
    """Export to the Download Center: {format: csv|pdf, ids?, query?, options?}."""
    from mpro.core.files import export_dict

    b = body()
    fmt = b.get("format")
    if fmt not in ("csv", "pdf"):
        abort(422, message="Choose CSV or PDF.")
    ids = b.get("ids") or None
    if ids is not None and (not isinstance(ids, list) or len(ids) > 5000):
        abort(422, message="ids must be a list.")
    if ids:
        ids = [str(_uuid(str(i))) for i in ids]
    query = b.get("query") or {}
    if not isinstance(query, dict):
        abort(422, message="query must be an object.")
    guard(qry.validate_filters, query.get("filters"))
    n = len(ids) if ids else None
    title = f"Work orders ({fmt.upper()}" + (f", {n} selected)" if n else ")")
    ex = guard(
        request_export,
        g.org.id,
        g.user.id,
        f"work_orders.{fmt}",
        title,
        {"ids": ids, "query": query, "options": clean_pdf_options(b.get("options"))},
    )
    db.session.commit()
    return export_dict(ex), 202


# ---- one work order --------------------------------------------------------------------------
@bp.get("/work-orders/<wo_id>")
@require("wo.view")
def get_work_order(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id, include_deleted=True)
    out = _detail(wo)
    if request.args.get("mark_read", "1") != "0":
        svc.mark_read(wo, g.user.id)
        db.session.commit()
        out["unread"] = False
    return out


@bp.patch("/work-orders/<wo_id>")
@require("wo.edit")
def patch_work_order(wo_id: str) -> dict[str, Any]:
    """Edit fields. Send the `version` you loaded (body or `If-Match`) to get 409 instead of overwriting
    someone else's change."""
    wo = _wo(wo_id)
    b = dict(body())
    version = _version(b)
    b.pop("version", None)
    for k in ("status", "number"):
        if k in b:
            abort(422, message=f"Change {k} with its own endpoint." if k == "status" else "Numbers can't be changed.")
    return _detail(guard(svc.update_work_order, g.org, g.membership, wo, b, version))


@bp.delete("/work-orders/<wo_id>")
@require("wo.delete")
def delete_work_order(wo_id: str) -> tuple[str, int]:
    guard(svc.delete_work_order, g.org, g.membership, _wo(wo_id))
    return "", 204


@bp.post("/work-orders/<wo_id>/restore")
@require("wo.delete")
def restore_work_order(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id, include_deleted=True)
    guard(svc.restore_work_order, g.org, g.membership, wo)
    return _detail(wo)


@bp.post("/work-orders/<wo_id>/status")
@require("wo.status")
def change_status(wo_id: str) -> dict[str, Any]:
    """{status, comment, sub_status, summary, signature (PNG data URL), signed_by, file_ids, version,
    asset_status: {status, reason, downtime_type, note}} — asset_status also changes the linked asset's status."""
    wo = _wo(wo_id)
    b = body()

    def run(*a: Any, **k: Any) -> None:
        svc.set_status(*a, **k, commit=False)
        svc._asset_status_from_wo(g.org, g.membership, wo, b.get("asset_status"))
        db.session.commit()

    guard(
        run,
        g.org,
        g.membership,
        wo,
        str(b.get("status") or ""),
        comment=str(b.get("comment") or ""),
        sub_status=str(b.get("sub_status") or ""),
        summary=b.get("summary"),
        signature=b.get("signature"),
        signed_by=str(b.get("signed_by") or ""),
        file_ids=b.get("file_ids") or [],
        expected_version=_version(b),
        undo=bool(b.get("undo")),
    )
    return _detail(wo)


@bp.patch("/work-orders/<wo_id>/asset-tasks/<task_id>")
@require("wo.status")
def patch_asset_task(wo_id: str, task_id: str) -> dict[str, Any]:
    """Set one asset's task status (open, in_progress, on_hold, done) and/or notes on a work order."""
    wo = _wo(wo_id)
    guard(svc.update_asset_task, g.org, g.membership, wo, task_id, body())
    return _detail(wo)


@bp.put("/work-orders/<wo_id>/cover")
@require("wo.edit")
def set_cover(wo_id: str) -> dict[str, Any]:
    """Pick the work order's picture for cards: {file_id} of one of its pictures, or null for the first one."""
    from mpro.workorders.cover import set_cover as _set_cover

    wo = _wo(wo_id)
    guard(_set_cover, g.org, g.membership, wo, body().get("file_id"))
    return _detail(wo)


@bp.post("/work-orders/<wo_id>/approval")
@require("wo.approve")
def approval(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    b = body()
    guard(svc.decide_approval, g.org, g.membership, wo, bool(b.get("approve")), str(b.get("comment") or ""))
    return _detail(wo)


@bp.post("/work-orders/<wo_id>/duplicate")
@require("wo.create")
def duplicate(wo_id: str) -> tuple[dict[str, Any], int]:
    return _detail(guard(svc.duplicate_work_order, g.org, g.membership, _wo(wo_id))), 201


@bp.post("/work-orders/<wo_id>/read")
@require("wo.view")
def mark_read(wo_id: str) -> tuple[str, int]:
    svc.mark_read(_wo(wo_id), g.user.id)
    db.session.commit()
    return "", 204


@bp.get("/work-orders/<wo_id>/activity")
@require("wo.view")
def activity(wo_id: str) -> dict[str, Any]:
    return {"items": act.activity(_wo(wo_id, include_deleted=True))}


@bp.get("/work-orders/<wo_id>/pdf")
@require("wo.view")
def pdf(wo_id: str) -> Response:
    """Download one work order as PDF. Query: sections (comma list), image_size."""
    wo = _wo(wo_id, include_deleted=True)
    opts: dict[str, Any] = {"image_size": request.args.get("image_size", "regular")}
    if request.args.get("sections") is not None:
        opts["sections"] = [s for s in request.args["sections"].split(",") if s]
    data = render_pdf(g.membership, g.org, [wo], opts)
    from mpro.core.events import emit

    emit(
        "wo.exported", entity_type="work_order", entity_id=wo.id, entity_label=svc.label(wo), summary="Exported to PDF"
    )
    db.session.commit()
    resp = Response(data, mimetype="application/pdf")
    disp = "attachment" if request.args.get("download") == "1" else "inline"
    resp.headers["Content-Disposition"] = f'{disp}; filename="work-order-{wo.number}.pdf"'
    # No "sandbox" CSP here: Chrome's PDF viewer won't render sandboxed documents. The app CSP still applies.
    return resp


# ---- comments --------------------------------------------------------------------------------
def _comment(wo: WorkOrder, cid: str) -> Comment:
    c = db.session.get(Comment, _uuid(cid))
    if c is None or c.entity_id != wo.id or c.org_id != g.org.id:
        abort(404)
    return c


@bp.post("/work-orders/<wo_id>/comments")
@require("wo.comment")
def add_comment(wo_id: str) -> tuple[dict[str, Any], int]:
    """{body, file_ids}. Mention people with `@[Name](user:<id>)` and teams with `@[Name](team:<id>)`."""
    wo = _wo(wo_id)
    b = body()
    c = guard(act.add_comment, g.org, g.membership, wo, str(b.get("body") or ""), b.get("file_ids") or [])
    from mpro.core.files import links_for

    return act.comment_dict(c, links_for("comment", c.id)), 201


@bp.patch("/work-orders/<wo_id>/comments/<cid>")
@require("wo.comment")
def edit_comment(wo_id: str, cid: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    c = guard(act.edit_comment, g.membership, wo, _comment(wo, cid), str(body().get("body") or ""))
    from mpro.core.files import links_for

    return act.comment_dict(c, links_for("comment", c.id))


@bp.delete("/work-orders/<wo_id>/comments/<cid>")
@require("wo.comment")
def delete_comment(wo_id: str, cid: str) -> tuple[str, int]:
    wo = _wo(wo_id)
    guard(act.delete_comment, g.membership, wo, _comment(wo, cid))
    return "", 204


@bp.post("/work-orders/<wo_id>/comments/<cid>/reactions")
@require("wo.comment")
def react(wo_id: str, cid: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    c = guard(act.react, g.membership, _comment(wo, cid), str(body().get("emoji") or ""))
    from mpro.core.files import links_for

    return act.comment_dict(c, links_for("comment", c.id))


# ---- time, timers, costs ---------------------------------------------------------------------
@bp.post("/work-orders/<wo_id>/time")
@require("wo.time")
def add_time(wo_id: str) -> tuple[dict[str, Any], int]:
    """{minutes, time_type, user_id?, rate_cents?, note?, started_at?}"""
    wo = _wo(wo_id)
    guard(act.add_time, g.org, g.membership, wo, body())
    return act.costs_summary(g.membership, wo), 201


@bp.delete("/work-orders/<wo_id>/time/<tid>")
@require("wo.time")
def delete_time(wo_id: str, tid: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    t = db.session.get(TimeEntry, _uuid(tid))
    if t is None or t.work_order_id != wo.id:
        abort(404)
    guard(act.delete_time, g.membership, wo, t)
    return act.costs_summary(g.membership, wo)


@bp.post("/work-orders/<wo_id>/timer")
@require("wo.time")
def start_timer(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    guard(act.start_timer, g.org, g.membership, wo, body().get("time_type"))
    return _detail(wo)


@bp.delete("/work-orders/<wo_id>/timer")
@require("wo.time")
def stop_timer(wo_id: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    guard(act.stop_timer, g.org, g.membership, wo, request.args.get("discard") == "1")
    return _detail(wo)


@bp.get("/me/timers")
@require("wo.view")
def my_timers() -> dict[str, Any]:
    return {"items": act.my_timers(g.membership)}


@bp.post("/work-orders/<wo_id>/costs")
@require("wo.time")
def add_cost(wo_id: str) -> tuple[dict[str, Any], int]:
    """{amount_cents, cost_type, description, user_id?, file_ids? (receipts)}"""
    wo = _wo(wo_id)
    guard(act.add_cost, g.org, g.membership, wo, body())
    return act.costs_summary(g.membership, wo), 201


@bp.delete("/work-orders/<wo_id>/costs/<cid>")
@require("wo.time")
def delete_cost(wo_id: str, cid: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    c = db.session.get(CostEntry, _uuid(cid))
    if c is None or c.work_order_id != wo.id:
        abort(404)
    guard(act.delete_cost, g.membership, wo, c)
    return act.costs_summary(g.membership, wo)


# ---- links -----------------------------------------------------------------------------------
@bp.post("/work-orders/<wo_id>/links")
@require("wo.edit")
def add_link(wo_id: str) -> dict[str, Any]:
    """{work_order_id (UUID or number), kind: blocks|related}"""
    wo = _wo(wo_id)
    b = body()
    other = _wo(str(b.get("work_order_id") or "0"))
    guard(svc.add_link, g.org, g.membership, wo, other, str(b.get("kind") or "related"))
    return _detail(wo)


@bp.delete("/work-orders/<wo_id>/links/<link_id>")
@require("wo.edit")
def remove_link(wo_id: str, link_id: str) -> dict[str, Any]:
    wo = _wo(wo_id)
    link = db.session.get(WorkOrderLink, _uuid(link_id))
    if link is None or link.org_id != g.org.id:
        abort(404)
    guard(svc.remove_link, g.org, g.membership, wo, link)
    return _detail(wo)


# ---- categories ------------------------------------------------------------------------------
@bp.get("/categories")
@require("wo.view")
def list_categories() -> dict[str, Any]:
    svc.ensure_default_categories(g.org.id)
    q = (request.args.get("q") or "").strip()
    query = scoped(Category)
    if q:
        query = query.where(func.lower(Category.name).like(like(q), escape="\\"))
    cats = db.session.scalars(query.order_by(func.lower(Category.name))).all()
    usage = dict(
        db.session.execute(
            select(WorkOrderCategory.category_id, func.count())
            .join(WorkOrder, WorkOrder.id == WorkOrderCategory.work_order_id)
            .where(WorkOrderCategory.org_id == g.org.id, WorkOrder.deleted_at.is_(None))
            .group_by(WorkOrderCategory.category_id)
        ).all()
    )
    return {"items": [svc.category_dict(c, int(usage.get(c.id, 0))) for c in cats], "total": len(cats)}


@bp.post("/categories")
@require("categories.manage")
def create_category() -> tuple[dict[str, Any], int]:
    b = body()
    c = guard(
        svc.create_category,
        g.org,
        str(b.get("name") or ""),
        str(b.get("color") or "#5d6880"),
        str(b.get("description") or ""),
    )
    return svc.category_dict(c, 0), 201


@bp.patch("/categories/<cid>")
@require("categories.manage")
def patch_category(cid: str) -> dict[str, Any]:
    return svc.category_dict(guard(svc.update_category, g.org, get_scoped(Category, cid), body()))


@bp.delete("/categories/<cid>")
@require("categories.manage")
def delete_category(cid: str) -> tuple[str, int]:
    svc.delete_category(g.org, get_scoped(Category, cid))
    return "", 204


# ---- custom fields ---------------------------------------------------------------------------
CF_PERMS = {
    "work_order": ("wo.view", "wo.settings"),
    "asset": ("assets.view", "assets.settings"),
    "location": ("locations.view", "assets.settings"),
}


def _cf_entity(manage: bool, entity: str | None = None) -> str:
    entity = (
        entity or request.args.get("entity") or (body().get("entity_type") if request.is_json else None) or "work_order"
    )
    if entity not in CF_PERMS:
        abort(422, message="Custom fields belong to work orders, assets or locations.")
    if not can(g.membership, CF_PERMS[entity][1 if manage else 0]):
        abort(403, message="You don't have permission to do that.")
    return entity


@bp.get("/custom-fields")
@require("org.view")
def list_custom_fields() -> dict[str, Any]:
    """Query `entity` = work_order (default) | asset | location."""
    entity = _cf_entity(False)
    return {"items": [svc.custom_field_dict(f) for f in svc.custom_fields(g.org.id, entity)]}


@bp.post("/custom-fields")
@require("org.view")
def create_custom_field() -> tuple[dict[str, Any], int]:
    entity = _cf_entity(True)
    return svc.custom_field_dict(guard(svc.save_custom_field, g.org, body(), None, entity)), 201


@bp.post("/custom-fields/reorder")
@require("org.view")
def reorder_custom_fields() -> dict[str, Any]:
    entity = _cf_entity(True)
    ids = body().get("ids") or []
    return {
        "items": [
            svc.custom_field_dict(f) for f in guard(svc.reorder_custom_fields, g.org, [str(i) for i in ids], entity)
        ]
    }


@bp.patch("/custom-fields/<fid>")
@require("org.view")
def patch_custom_field(fid: str) -> dict[str, Any]:
    f = get_scoped(CustomField, fid)
    _cf_entity(True, f.entity_type)
    return svc.custom_field_dict(guard(svc.save_custom_field, g.org, body(), f))


@bp.delete("/custom-fields/<fid>")
@require("org.view")
def delete_custom_field(fid: str) -> tuple[str, int]:
    f = get_scoped(CustomField, fid)
    _cf_entity(True, f.entity_type)
    svc.delete_custom_field(g.org, f)
    return "", 204


# ---- templates -------------------------------------------------------------------------------
@bp.get("/work-order-templates")
@require("wo.view")
def list_templates() -> dict[str, Any]:
    order = request.args.get("sort") or "name"
    q = scoped(Template)
    if order == "popular":  # pinned first, then most used (the Create menu's quick list)
        q = q.order_by(Template.pinned.desc(), Template.use_count.desc(), func.lower(Template.name))
    else:
        q = q.order_by(func.lower(Template.name))
    return {"items": [svc.template_dict(t) for t in db.session.scalars(q).all()]}


@bp.post("/work-order-templates/<tid>/create")
@require("wo.create")
def create_from_template(tid: str) -> tuple[dict[str, Any], int]:
    """One-tap create from a template. Optional overrides: asset_id, location_id, assignees, due_at, title…"""
    wo = guard(svc.create_from_template, g.org, g.membership, get_scoped(Template, tid), body())
    return _detail(wo), 201


@bp.post("/work-order-templates")
@require("templates.manage")
def create_template() -> tuple[dict[str, Any], int]:
    return svc.template_dict(guard(svc.save_template, g.org, g.membership, body())), 201


@bp.patch("/work-order-templates/<tid>")
@require("templates.manage")
def patch_template(tid: str) -> dict[str, Any]:
    return svc.template_dict(guard(svc.save_template, g.org, g.membership, body(), get_scoped(Template, tid)))


@bp.delete("/work-order-templates/<tid>")
@require("templates.manage")
def delete_template(tid: str) -> tuple[str, int]:
    svc.delete_template(g.org, get_scoped(Template, tid))
    return "", 204


# ---- settings --------------------------------------------------------------------------------
@bp.get("/work-orders/settings")
@require("wo.view")
def get_settings() -> dict[str, Any]:
    s = svc.wo_settings(g.org.id)
    s.pop("categories_seeded", None)
    if not can(g.membership, "wo.rates.view"):
        s["default_hourly_rate_cents"] = None
    s["next_number"] = svc.peek_next_number(g.org.id)
    return s


@bp.patch("/work-orders/settings")
@require("wo.settings")
def patch_settings() -> dict[str, Any]:
    b = body()
    b.pop("next_number", None)
    s = guard(svc.update_settings, g.org, b)
    s.pop("categories_seeded", None)
    s["next_number"] = svc.peek_next_number(g.org.id)
    return s


@bp.post("/work-orders/settings/next-number")
@require("wo.settings")
def set_next_number() -> dict[str, Any]:
    try:
        n = int(body().get("next_number"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        abort(422, message="Enter a whole number.")
    return {"next_number": guard(svc.set_next_number, g.org, n)}


@bp.get("/users/<user_id>/work-settings")
@require("users.view")
def get_member_work_settings(user_id: str) -> dict[str, Any]:
    m = db.session.scalars(members_query(g.org.id).where(Membership.user_id == _uuid(user_id))).first()
    if m is None:
        abort(404)
    show = can(g.membership, "wo.rates.view") or m.user_id == g.user.id
    return {
        "hourly_rate_cents": m.hourly_rate_cents if show else None,
        "default_hourly_rate_cents": svc.wo_settings(g.org.id)["default_hourly_rate_cents"] if show else None,
        "rates_visible": show,
        "wo_visibility": m.wo_visibility,
    }


@bp.patch("/users/<user_id>/work-settings")
@require("users.manage")
def patch_member_work_settings(user_id: str) -> dict[str, Any]:
    m = db.session.scalars(members_query(g.org.id).where(Membership.user_id == _uuid(user_id))).first()
    if m is None:
        abort(404)
    b = body()
    if "hourly_rate_cents" in b and not can(g.membership, "wo.rates.view"):
        abort(403, message="You can't set hourly rates.")
    guard(svc.set_member_work_settings, g.org, m, b)
    return get_member_work_settings(user_id)


# ---- saved views -----------------------------------------------------------------------------
@bp.get("/work-orders/views")
@require("wo.view")
def list_views() -> dict[str, Any]:
    return {"items": [svc.view_dict(v) for v in svc.views_for(g.membership)]}


@bp.post("/work-orders/views")
@require("wo.view")
def create_view() -> tuple[dict[str, Any], int]:
    return svc.view_dict(guard(svc.save_view, g.org, g.membership, body())), 201


def _view(vid: str) -> SavedView:
    v = get_scoped(SavedView, vid)
    if v.owner_id not in (None, g.user.id):
        abort(404)
    return v


@bp.patch("/work-orders/views/<vid>")
@require("wo.view")
def patch_view(vid: str) -> dict[str, Any]:
    return svc.view_dict(guard(svc.save_view, g.org, g.membership, body(), _view(vid)))


@bp.delete("/work-orders/views/<vid>")
@require("wo.view")
def delete_view(vid: str) -> tuple[str, int]:
    guard(svc.delete_view, g.membership, _view(vid))
    return "", 204


# ---- search and file access ------------------------------------------------------------------
@provider("work_orders", "Work orders", "wo.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    query = qry.base_query(g.membership)
    num = q.strip().lstrip("#")
    cond: Any = func.lower(WorkOrder.title).like(like(q), escape="\\")
    if num.isdigit():
        cond = cond | (WorkOrder.number == int(num))
    rows = db.session.scalars(
        query.where(cond).order_by(WorkOrder.status.in_(("done", "canceled")), WorkOrder.number.desc()).limit(limit)
    ).all()
    from mpro.workorders.models import STATUS_LABELS

    return [
        {
            "id": str(w.id),
            "title": f"#{w.number} {w.title}",
            "subtitle": STATUS_LABELS[w.status] + (f" · due {w.due_at:%b %d}" if w.due_at else ""),
            "url": f"/work-orders/{w.id}",
            "status": w.status,
        }
        for w in rows
    ]


def _wo_visible(wo_id: uuid.UUID) -> WorkOrder | None:
    wo = db.session.get(WorkOrder, wo_id)
    if wo is None or wo.org_id != g.org.id or wo.deleted_at is not None:
        return None
    return wo if svc.can_see(g.membership, wo) else None


def _wo_can_view(wo_id: uuid.UUID) -> bool:
    return _wo_visible(wo_id) is not None


def _wo_can_edit(wo_id: uuid.UUID) -> bool:
    wo = _wo_visible(wo_id)
    return wo is not None and can(g.membership, "wo.edit")


def _wo_changed(wo_id: uuid.UUID) -> None:
    wo = db.session.get(WorkOrder, wo_id)
    if wo is not None:
        svc.touch(wo, g.user.id)


def _comment_wo(cid: uuid.UUID) -> WorkOrder | None:
    c = db.session.get(Comment, cid)
    if c is None or c.org_id != g.org.id or c.deleted_at is not None:
        return None
    return _wo_visible(c.entity_id)


def _cost_wo(cid: uuid.UUID) -> WorkOrder | None:
    c = db.session.get(CostEntry, cid)
    return _wo_visible(c.work_order_id) if c is not None and c.org_id == g.org.id else None


register_entity("work_order", _wo_can_view, _wo_can_edit, _wo_changed)
register_entity(
    "comment",
    lambda cid: _comment_wo(cid) is not None,
    lambda cid: (
        (c := db.session.get(Comment, cid)) is not None and c.author_id == g.user.id and _comment_wo(cid) is not None
    ),
)
register_entity(
    "cost",
    lambda cid: _cost_wo(cid) is not None,
    lambda cid: _cost_wo(cid) is not None and can(g.membership, "wo.time"),
)

_ = timedelta  # keep import for type checkers
