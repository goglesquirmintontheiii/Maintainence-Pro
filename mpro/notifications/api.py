"""Notifications: HTTP API (thin views over services)."""

from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import Response, g, request

from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.notifications import services as svc
from mpro.notifications.models import EscalationRule
from mpro.orgs.services import RuleError

bp = APIBlueprint("notifications", __name__, url_prefix="/api/v1", tag="Notifications")


def guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except RuleError as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def _body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        abort(422, message="Send a JSON object.")
    return data


# ---- inbox ------------------------------------------------------------------------------------------
@bp.get("/notifications")
@require("org.view")
def list_notifications() -> dict[str, Any]:
    try:
        limit = int(request.args.get("limit", 30))
    except ValueError:
        limit = 30
    return guard(
        svc.inbox,
        g.org.id,
        g.user.id,
        unread=request.args.get("unread") in ("1", "true"),
        limit=limit,
        before=request.args.get("before", ""),
    )


@bp.get("/notifications/unread-count")
@require("org.view")
def unread_count() -> dict[str, Any]:
    return {"unread": svc.unread_count(g.org.id, g.user.id)}


@bp.post("/notifications/read")
@require("org.view")
def mark_read() -> dict[str, Any]:
    """{ids: [...]} marks those read; {all: true} marks everything read; {ids, unread: true} marks unread."""
    b = _body()
    ids = b.get("ids")
    if ids is not None and (not isinstance(ids, list) or len(ids) > 500):
        abort(422, message="ids must be a list.")
    if ids is None and not b.get("all"):
        abort(422, message="Say which notifications to mark.")
    n = svc.mark_read(g.org.id, g.user.id, None if b.get("all") else ids, read=not b.get("unread"))
    return {"updated": n, "unread": svc.unread_count(g.org.id, g.user.id)}


@bp.post("/notifications/read-entity")
@require("org.view")
def mark_entity_read() -> dict[str, Any]:
    b = _body()
    et, eid = str(b.get("entity_type") or ""), str(b.get("entity_id") or "")
    if not et or not eid:
        abort(422, message="Say which record was opened.")
    n = svc.mark_entity_read(g.org.id, g.user.id, et[:40], eid[:64])
    return {"updated": n, "unread": svc.unread_count(g.org.id, g.user.id)}


# ---- personal settings ------------------------------------------------------------------------------
@bp.get("/notifications/settings")
@require("org.view")
def get_settings() -> dict[str, Any]:
    out = svc.settings_dict(g.org.id, g.user)
    db.session.commit()  # the server's push key is created on first use
    return out


@bp.patch("/notifications/settings")
@require("org.view")
def patch_settings() -> dict[str, Any]:
    return guard(svc.save_prefs, g.org.id, g.user, _body())


@bp.post("/notifications/pause")
@require("org.view")
def pause() -> dict[str, Any]:
    raw = _body().get("minutes")
    try:
        minutes = int(raw) if raw else None
    except (TypeError, ValueError):
        abort(422, message="minutes must be a number.")
    return guard(svc.pause, g.org.id, g.user, minutes)


# ---- web push ---------------------------------------------------------------------------------------
@bp.get("/notifications/push/key")
@require("org.view")
def push_key() -> dict[str, Any]:
    key = svc.vapid_public_key()
    db.session.commit()
    return {"public_key": key}


@bp.post("/notifications/push/subscriptions")
@require("org.view")
def push_subscribe() -> tuple[dict[str, Any], int]:
    return guard(svc.subscribe, g.user, _body(), request.headers.get("User-Agent", "")), 201


@bp.delete("/notifications/push/subscriptions")
@require("org.view")
def push_unsubscribe() -> dict[str, Any]:
    b = _body()
    endpoint, sid = b.get("endpoint"), b.get("id")
    if not endpoint and not sid:
        abort(422, message="Say which device to turn off.")
    return {"removed": svc.unsubscribe(g.user, str(endpoint) if endpoint else None, str(sid) if sid else None)}


@bp.post("/notifications/push/test")
@require("org.view")
def push_test() -> dict[str, Any]:
    sent = svc.test_push(g.user, g.org)
    if not sent:
        abort(409, message="No device accepted the test. Turn push on in this browser and try again.")
    return {"sent": sent}


# ---- organization settings (admins) -----------------------------------------------------------------
@bp.get("/notifications/org-settings")
@require("notifications.rules")
def get_org_settings() -> dict[str, Any]:
    return svc.org_settings(g.org.id)


@bp.patch("/notifications/org-settings")
@require("notifications.rules")
def patch_org_settings() -> dict[str, Any]:
    return guard(svc.save_org_settings, g.org, g.user, _body())


@bp.get("/notifications/weekly-report")
@require("notifications.rules")
def weekly_report_preview() -> dict[str, Any]:
    return svc.weekly_report(g.org)


@bp.get("/notifications/brand-logo/<org_id>")
@bp.doc(hide=True)
def brand_logo(org_id: str) -> Response:
    """Public: the logo shown in emails (only the file chosen as the organization's email logo)."""
    from mpro.core.files import FileObject, read_bytes
    from mpro.core.settings import get_settings as org_get

    try:
        oid = uuid.UUID(org_id)
    except ValueError:
        abort(404)
    fid = org_get(oid, "notifications").get("brand_logo_file_id")
    f = db.session.get(FileObject, uuid.UUID(fid)) if fid else None
    if f is None or f.org_id != oid or f.deleted_at is not None or not f.is_image:
        abort(404)
    try:
        data = read_bytes(f, f.storage_key)
    except Exception:  # noqa: BLE001
        abort(404)
    resp = Response(data, mimetype=f.content_type)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ---- escalation rules (MP-052) ----------------------------------------------------------------------
def _rule(rule_id: str) -> EscalationRule:
    try:
        rid = uuid.UUID(rule_id)
    except ValueError:
        abort(404, message="Escalation rule not found.")
    r = db.session.get(EscalationRule, rid)
    if r is None or r.org_id != g.org.id or r.deleted_at is not None:
        abort(404, message="Escalation rule not found.")
    return r


@bp.get("/escalation-rules")
@require("notifications.rules")
def list_rules() -> dict[str, Any]:
    return {"items": [svc.rule_dict(r) for r in svc.rules(g.org.id)]}


@bp.post("/escalation-rules")
@require("notifications.rules")
def create_rule() -> tuple[dict[str, Any], int]:
    r = guard(svc.save_rule, g.org.id, g.user, _body())
    return svc.rule_dict(r), 201


@bp.patch("/escalation-rules/<rule_id>")
@require("notifications.rules")
def patch_rule(rule_id: str) -> dict[str, Any]:
    r = _rule(rule_id)
    return svc.rule_dict(guard(svc.save_rule, g.org.id, g.user, _body(), r))


@bp.delete("/escalation-rules/<rule_id>")
@require("notifications.rules")
def delete_rule(rule_id: str) -> tuple[str, int]:
    svc.delete_rule(g.org.id, g.user, _rule(rule_id))
    return "", 204
