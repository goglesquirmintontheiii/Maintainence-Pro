"""Work requests and request portals: HTTP API (thin views over services)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, current_app, g, jsonify, request
from sqlalchemy import func, select

from mpro.core.files import FileError, links_for, register_entity
from mpro.core.jobs import job, periodic
from mpro.core.permissions import can
from mpro.core.search import like
from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.orgs.models import Membership, Team
from mpro.orgs.services import RuleError
from mpro.workrequests import guests
from mpro.workrequests import services as svc
from mpro.workrequests.models import WorkRequest

bp = APIBlueprint("workrequests", __name__, url_prefix="/api/v1", tag="Requests")


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


def _req(rid: str) -> WorkRequest:
    return guard(svc.get_request, g.membership, rid)


def _detail(r: WorkRequest) -> dict[str, Any]:
    return svc.request_dict(r, g.membership, links_for("work_request", r.id), full=True)


# ---- the request form (requesters can't browse assets or locations, so the form has its own pickers) ------------
@bp.get("/requests/form")
@require("requests.create")
def form_config() -> dict[str, Any]:
    from mpro.workorders.services import custom_field_dict, custom_fields

    s = svc.settings(g.org.id)
    wanted = set(svc.request_field_ids(g.org.id))
    teams = []
    if s["assign_to"] != "hidden":
        teams = [
            {"id": str(t.id), "name": t.name, "color": t.color}
            for t in db.session.scalars(
                select(Team).where(Team.org_id == g.org.id, Team.deleted_at.is_(None)).order_by(Team.name)
            ).all()
        ]
    return {
        "fields": s["fields"],
        "assign_to": s["assign_to"],
        "allow_other": s["allow_other"],
        "teams": teams,
        "custom_fields": [custom_field_dict(f) for f in custom_fields(g.org.id) if str(f.id) in wanted],
        "guest": guests.is_guest(g.membership),
    }


@bp.get("/requests/form/locations")
@require("requests.create")
def form_locations() -> dict[str, Any]:
    from mpro.assets.models import Location

    q = select(Location).where(Location.org_id == g.org.id, Location.deleted_at.is_(None))
    if guests.is_guest(g.membership):
        q = q.where(Location.id.in_(guests.location_scope(g.membership)))
    text = (request.args.get("q") or "").strip()
    if text:
        q = q.where(func.lower(Location.name).like(like(text), escape="\\"))
    rows = db.session.scalars(q.order_by(Location.name).limit(500)).all()
    return {"items": [{"id": str(x.id), "name": x.name} for x in rows]}


@bp.get("/requests/form/assets")
@require("requests.create")
def form_assets() -> dict[str, Any]:
    from mpro.assets.models import Asset, Location

    q = (
        select(Asset, Location.name)
        .outerjoin(Location, Location.id == Asset.location_id)
        .where(Asset.org_id == g.org.id, Asset.deleted_at.is_(None))
    )
    if guests.is_guest(g.membership):
        q = q.where(Asset.location_id.in_(guests.location_scope(g.membership)))
    text = (request.args.get("q") or "").strip()
    if text:
        q = q.where(func.lower(Asset.name).like(like(text), escape="\\"))
    if request.args.get("location_id"):
        from mpro.core.hierarchy import subtree_ids

        try:
            q = q.where(Asset.location_id.in_(subtree_ids("location", uuid.UUID(request.args["location_id"]))))
        except ValueError:
            abort(422, message="That location doesn't exist.")
    rows = db.session.execute(q.order_by(Asset.name).limit(500)).all()
    return {
        "items": [
            {
                "id": str(a.id),
                "name": a.name,
                "location_id": str(a.location_id) if a.location_id else None,
                "location": ln or "",
            }  # fmt: skip
            for a, ln in rows
        ]
    }


@bp.get("/requests/form/prefill")
@require("requests.create")
def form_prefill() -> dict[str, Any]:
    """Names for a pre-filled form (`/requests/new?asset_id=` from a QR sticker, r276)."""
    out: dict[str, Any] = {"asset": None, "location": None}
    m = g.membership
    if request.args.get("asset_id"):
        try:
            a = svc._asset(g.org.id, request.args["asset_id"])
            if not guests.is_guest(m) or guests.can_see_location(m, a.location_id):
                out["asset"] = {"id": str(a.id), "name": a.name, "location_id": str(a.location_id or "") or None}
                if a.location_id:
                    from mpro.assets.models import Location

                    loc = db.session.get(Location, a.location_id)
                    if loc is not None:
                        out["location"] = {"id": str(loc.id), "name": loc.name}
        except RuleError:
            pass
    elif request.args.get("location_id"):
        try:
            loc = svc._location(g.org.id, request.args["location_id"])
            if not guests.is_guest(m) or guests.can_see_location(m, loc.id):
                out["location"] = {"id": str(loc.id), "name": loc.name}
        except RuleError:
            pass
    return out


# ---- requests -------------------------------------------------------------------------------------------
@bp.get("/requests")
@require("requests.view")
def list_requests() -> dict[str, Any]:
    return guard(svc.list_requests, g.membership, request.args.to_dict())


@bp.get("/requests/badge")
@require("requests.view")
def requests_badge() -> dict[str, Any]:
    return svc.badge(g.membership)


@bp.post("/requests")
@require("requests.create")
def create_request() -> tuple[dict[str, Any], int]:
    data = body()
    source = "qr" if data.pop("source", None) == "qr" else "app"
    r = guard(svc.create_request, g.org, g.membership, data, source)
    return _detail(r), 201


@bp.get("/requests/<rid>")
@require("requests.view")
def get_request(rid: str) -> dict[str, Any]:
    r = _req(rid)
    svc.mark_seen(g.membership, r)
    return _detail(r)


@bp.patch("/requests/<rid>")
@require("requests.view")
def patch_request(rid: str) -> dict[str, Any]:
    return _detail(guard(svc.update_request, g.org, g.membership, _req(rid), body()))


@bp.post("/requests/<rid>/files")
@require("requests.view")
def add_files(rid: str) -> dict[str, Any]:
    r = _req(rid)
    guard(svc.add_files, g.org, g.membership, r, body().get("file_ids") or [])
    return _detail(r)


@bp.post("/requests/<rid>/approve")
@require("requests.approve")
def approve(rid: str) -> dict[str, Any]:
    """{template_id?, title?, description?, priority?, assignees?, due_at?, start_at?, categories?}"""
    r = _req(rid)
    wo = guard(svc.approve, g.org, g.membership, r, body())
    db.session.refresh(r)
    return {**_detail(r), "work_order": {"id": str(wo.id), "number": wo.number, "status": wo.status}}


@bp.post("/requests/<rid>/decline")
@require("requests.approve")
def decline(rid: str) -> dict[str, Any]:
    r = guard(svc.decline, g.org, g.membership, _req(rid), str(body().get("reason") or ""))
    return _detail(r)


@bp.post("/requests/<rid>/duplicate")
@require("requests.create")
def duplicate(rid: str) -> tuple[dict[str, Any], int]:
    return _detail(guard(svc.duplicate_request, g.org, g.membership, _req(rid))), 201


@bp.post("/requests/<rid>/cancel")
@require("requests.view")
def cancel(rid: str) -> dict[str, Any]:
    r = _req(rid)
    guard(svc.cancel_request, g.org, g.membership, r)
    return _detail(r)


@bp.post("/requests/<rid>/comments")
@require("requests.view")
def comment(rid: str) -> tuple[dict[str, Any], int]:
    return guard(svc.add_comment, g.org, g.membership, _req(rid), str(body().get("body") or "")), 201


# ---- settings (r275, r278, r295) --------------------------------------------------------------------------
@bp.get("/request-settings")
@require("requests.settings")
def get_settings() -> dict[str, Any]:
    return svc.settings(g.org.id)


@bp.patch("/request-settings")
@require("requests.settings")
def patch_settings() -> dict[str, Any]:
    return guard(svc.update_settings, g.org, body())


# ---- portals (r279, r300, r265) ---------------------------------------------------------------------------
@bp.get("/request-portals")
@require("requests.portals")
def list_portals() -> dict[str, Any]:
    return {"items": svc.list_portals(g.org.id, request.args.get("customer_id"))}


@bp.post("/request-portals")
@require("requests.portals")
def create_portal() -> tuple[dict[str, Any], int]:
    return svc.portal_dict(guard(svc.save_portal, g.org, g.membership, body())), 201


@bp.patch("/request-portals/<pid>")
@require("requests.portals")
def patch_portal(pid: str) -> dict[str, Any]:
    p = guard(svc.get_portal, g.org.id, pid)
    return svc.portal_dict(guard(svc.save_portal, g.org, g.membership, body(), p))


@bp.delete("/request-portals/<pid>")
@require("requests.portals")
def delete_portal(pid: str) -> tuple[str, int]:
    guard(svc.delete_portal, g.org, guard(svc.get_portal, g.org.id, pid))
    return "", 204


@bp.get("/request-portals/<pid>/qr.svg")
@require("requests.portals")
def portal_qr(pid: str) -> Response:
    p = guard(svc.get_portal, g.org.id, pid)
    base = str(current_app.config.get("MPRO_BASE_URL") or request.host_url)
    svg = guard(svc.portal_qr_svg, p, base, request.args.get("asset_id"), request.args.get("location_id"))
    return Response(svg, mimetype="image/svg+xml")


# ---- guests (r236) -------------------------------------------------------------------------------------------
@bp.get("/guests")
@require("users.manage")
def list_guests() -> dict[str, Any]:
    return {"items": guests.list_guests(g.org.id)}


@bp.put("/guests/<user_id>")
@require("users.manage")
def set_guest(user_id: str) -> dict[str, Any]:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        abort(404)
    m = db.session.scalars(
        select(Membership).where(
            Membership.org_id == g.org.id, Membership.user_id == uid, Membership.deleted_at.is_(None)
        )
    ).first()
    if m is None:
        abort(404)
    return guard(guests.set_access, g.org, m, body())


def _guest_only() -> None:
    if not guests.is_guest(g.membership):
        abort(403, message="This is for guests.")


@bp.get("/guest/home")
@require("requests.view")
def guest_home() -> dict[str, Any]:
    _guest_only()
    return {
        "assets": guests.guest_assets(g.membership),
        "quotes": guests.guest_quotes(g.membership) if can(g.membership, "quotes.approve") else [],
        "access": guests.guest_dict(g.membership),
    }


@bp.get("/guest/assets/<aid>")
@require("requests.view")
def guest_asset(aid: str) -> dict[str, Any]:
    _guest_only()
    return guard(guests.guest_asset_history, g.membership, aid)


@bp.post("/guest/quotes/<qid>/decide")
@require("quotes.approve")
def guest_quote(qid: str) -> dict[str, Any]:
    _guest_only()
    data = body()
    return guard(guests.decide_quote, g.membership, qid, bool(data.get("approve")), str(data.get("comment") or ""))


# ---- public (no login; the portal slug or status token is the only key) --------------------------------
def _ip() -> str:
    return (request.remote_addr or "")[:64]


def _no_store(data: Any, status: int = 200) -> Any:
    resp = jsonify(data)
    resp.status_code = status
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


def _public_portal(slug: str) -> tuple[Any, Any]:
    p, org = guard(svc.resolve_portal, slug, _ip())
    g.org = org
    g.membership = None
    g.user = None  # never the actor, even if a staff member opens the form
    return p, org


@bp.get("/portal/<slug>")
def public_portal(slug: str) -> Any:
    p, org = _public_portal(slug)
    return _no_store(svc.public_portal(p, org, request.args.get("asset"), request.args.get("location")))


@bp.post("/portal/<slug>/requests")
def public_submit(slug: str) -> Any:
    p, org = _public_portal(slug)
    return _no_store(guard(svc.public_submit, p, org, body(), _ip()), 201)


@bp.post("/portal/<slug>/files")
def public_upload(slug: str) -> Any:
    p, org = _public_portal(slug)
    up = request.files.get("file")
    if up is None or not up.filename:
        abort(422, message="Choose a file to upload.")
    return _no_store(guard(svc.public_upload, p, org, up, _ip()), 201)


@bp.get("/request-status/<token>")
def public_status(token: str) -> Any:
    return _no_store(guard(svc.status_by_token, token, _ip()))


# ---- wiring ---------------------------------------------------------------------------------------------
def _can_view_request(rid: uuid.UUID) -> bool:
    r = db.session.get(WorkRequest, rid)
    return r is not None and svc.can_view(getattr(g, "membership", None), r)


def _can_edit_request(rid: uuid.UUID) -> bool:
    r = db.session.get(WorkRequest, rid)
    return r is not None and svc.can_edit(getattr(g, "membership", None), r)


register_entity("work_request", _can_view_request, _can_edit_request)


@job("requests.cleanup_portal_uploads")
def _cleanup_uploads(_: dict[str, Any]) -> None:
    svc.cleanup_portal_uploads()


periodic("requests.cleanup_portal_uploads", timedelta(hours=6))


def _register() -> None:
    from mpro.auth.api import CSRF_EXEMPT
    from mpro.workorders.services import STATUS_HOOKS
    from mpro.workrequests import emails as _emails  # noqa: F401  (event consumers)

    CSRF_EXEMPT.update({"workrequests.public_submit", "workrequests.public_upload"})
    if svc.on_wo_status not in STATUS_HOOKS:
        STATUS_HOOKS.append(svc.on_wo_status)


_register()
