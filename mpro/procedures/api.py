"""Procedures REST API (/api/v1). Built in 0.4.0."""

from __future__ import annotations

import uuid
from typing import Any

from apiflask import APIBlueprint, abort
from flask import g, request
from sqlalchemy import func, select

from mpro.core.files import FileError, export_dict, register_entity, request_export
from mpro.core.permissions import can, can_on, can_some
from mpro.core.search import like, provider
from mpro.core.tenancy import enforce_own_scope, require
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.procedures import exports as _exports  # noqa: F401  (registers the CSV exporter)
from mpro.procedures import schema as sch
from mpro.procedures import services as svc
from mpro.procedures.models import FIELD_TYPES, Procedure, ProcedureRun, ProcedureVersion
from mpro.workorders.models import WorkOrder

bp = APIBlueprint("procedures", __name__, url_prefix="/api/v1", tag="Procedures")


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


def _proc(pid: str, include_deleted: bool = False) -> Procedure:
    p = guard(svc.get_procedure, g.org.id, pid, include_deleted)
    if not svc.can_see_procedure(g.membership, p):  # one-off procedures follow their work order's visibility
        abort(404)
    enforce_own_scope(p)
    return p


def _wo(wo_id: str) -> WorkOrder:
    from mpro.workorders.api import _wo as wo_lookup

    return wo_lookup(wo_id)


# ---- library -------------------------------------------------------------------------------------
@bp.get("/procedures")
@require("procedures.view")
def list_procedures() -> dict[str, Any]:
    """Query: q, status (draft|published|archived|all; default hides archived), tag, category, include_deleted."""
    return guard(svc.library, g.org.id, dict(request.args.items()))


@bp.get("/procedures/options")
@require("procedures.view")
def options() -> dict[str, Any]:
    return {
        "field_types": list(FIELD_TYPES),
        "limits": {"fields": sch.MAX_FIELDS, "label": sch.MAX_LABEL},
        "templates": svc.builtin_templates(),
        "settings": svc.proc_settings(g.org.id),
        "can": {k: can(g.membership, f"procedures.{k}") for k in ("manage", "delete", "fill")},
    }


@bp.post("/procedures")
@require("procedures.manage")
def create_procedure() -> tuple[dict[str, Any], int]:
    """{name, description, category, tags, schema: {items: [...], scoring: {enabled, goal}}},
    or {template: key} (built-in template), or {copy_of: id}."""
    b = body()
    if b.get("template"):
        p = guard(svc.from_builtin, g.org, g.membership, str(b["template"]))
    elif b.get("copy_of"):
        p = guard(svc.copy_procedure, g.org, g.membership, _proc(str(b["copy_of"])))
    else:
        p = guard(svc.create_procedure, g.org, g.membership, b)
    return svc.detail(p), 201


@bp.get("/procedures/settings")
@require("procedures.view")
def get_settings() -> dict[str, Any]:
    return svc.proc_settings(g.org.id)


@bp.patch("/procedures/settings")
@require("wo.settings")
def patch_settings() -> dict[str, Any]:
    """{on_fail, on_flag, on_low_score: prompt|auto|none, auto_in_progress: bool}"""
    return guard(svc.update_settings, g.org, body())


@bp.post("/procedures/import")
@require("procedures.manage")
def import_file() -> dict[str, Any]:
    """Upload a CSV or PDF (multipart `file`); returns a proposed schema to review — nothing is saved."""
    f = request.files.get("file")
    if f is None:
        abort(422, message="Choose a CSV or PDF file.")
    data = f.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        abort(413, message="Import files can be up to 10 MB.")
    name = (f.filename or "").lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        schema = guard(svc.import_pdf, data)
    elif name.endswith(".csv") or name.endswith(".txt"):
        schema = guard(svc.import_csv, data)
    else:
        abort(422, message="Import a CSV or PDF file.")
    return {"schema": schema, "name": (f.filename or "Imported procedure").rsplit(".", 1)[0][:255]}


@bp.post("/procedures/export")
@require("procedures.view")
def export_answers() -> tuple[dict[str, Any], int]:
    """{procedure_id, from?, to?} — answers across work orders as CSV in the Download Center."""
    if not can(g.membership, "exports.use"):
        abort(403, message="You don't have permission to export.")
    b = body()
    p = _proc(str(b.get("procedure_id") or ""))
    params = {"procedure_id": str(p.id), "from": b.get("from") or None, "to": b.get("to") or None}
    ex = guard(request_export, g.org.id, g.user.id, "procedures.csv", f"{p.name} answers (CSV)", params)
    db.session.commit()
    return export_dict(ex), 202


@bp.get("/procedures/<pid>")
@require("procedures.view")
def get_procedure(pid: str) -> dict[str, Any]:
    return svc.detail(_proc(pid, include_deleted=True))


@bp.patch("/procedures/<pid>")
@require("procedures.manage")
def patch_procedure(pid: str) -> dict[str, Any]:
    """Metadata, seasonal `variants`, and/or `schema` (saved to the draft; published versions never change)."""
    p = guard(svc.update_procedure, g.org, g.membership, _proc(pid), body())
    return svc.detail(p)


@bp.post("/procedures/<pid>/publish")
@require("procedures.manage")
def publish(pid: str) -> dict[str, Any]:
    return svc.detail(guard(svc.publish, g.org, g.membership, _proc(pid)))


@bp.post("/procedures/<pid>/archive")
@require("procedures.manage")
def archive(pid: str) -> dict[str, Any]:
    archived = body().get("archived", True) is not False
    return svc.detail(guard(svc.set_archived, g.org, g.membership, _proc(pid), archived))


@bp.post("/procedures/<pid>/copy")
@require("procedures.manage")
def copy(pid: str) -> tuple[dict[str, Any], int]:
    return svc.detail(guard(svc.copy_procedure, g.org, g.membership, _proc(pid))), 201


@bp.delete("/procedures/<pid>")
@require("procedures.delete")
def delete(pid: str) -> tuple[str, int]:
    guard(svc.delete_procedure, g.org, g.membership, _proc(pid))
    return "", 204


@bp.post("/procedures/<pid>/restore")
@require("procedures.delete")
def restore(pid: str) -> dict[str, Any]:
    return svc.detail(guard(svc.restore_procedure, g.org, g.membership, _proc(pid, include_deleted=True)))


@bp.get("/procedures/<pid>/versions")
@require("procedures.view")
def versions(pid: str) -> dict[str, Any]:
    p = _proc(pid, include_deleted=True)
    vs = db.session.scalars(
        select(ProcedureVersion).where(ProcedureVersion.procedure_id == p.id).order_by(ProcedureVersion.number.desc())
    ).all()
    used = dict(
        db.session.execute(
            select(ProcedureRun.version_id, func.count())
            .where(ProcedureRun.procedure_id == p.id)
            .group_by(ProcedureRun.version_id)
        ).all()
    )
    return {"items": [{**svc.version_dict(v), "work_order_count": int(used.get(v.id, 0))} for v in vs]}


@bp.get("/procedures/<pid>/history")
@require("procedures.view")
def history(pid: str) -> dict[str, Any]:
    """Work orders created/completed with this procedure. Query: from, to (ISO dates)."""
    return guard(svc.wo_history, g.membership, _proc(pid, include_deleted=True), dict(request.args.items()))


@bp.get("/procedures/<pid>/analytics")
@require("procedures.view")
def analytics(pid: str) -> dict[str, Any]:
    return guard(svc.analytics, g.membership, _proc(pid, include_deleted=True), dict(request.args.items()))


# ---- on work orders ------------------------------------------------------------------------------
def _fill_guard(wo: WorkOrder) -> None:
    from mpro.workorders.services import can_see

    if not can_see(g.membership, wo):
        abort(404)


@bp.post("/work-orders/<wo_id>/procedures")
@require("wo.edit")
def add_to_work_order(wo_id: str) -> tuple[dict[str, Any], int]:
    """{procedure_id} from the library, or {name, schema} to build a one-off procedure for this work order."""
    wo = _wo(wo_id)
    if wo.status in ("done", "canceled"):
        abort(409, message="Reopen the work order to add procedures.")
    b = body()
    if b.get("procedure_id"):
        if not can(g.membership, "procedures.view"):
            abort(403, message="You can't use procedures.")

        def run() -> Any:
            r = svc.attach_procedures(g.org, g.membership, wo, [b["procedure_id"]])[0]
            db.session.commit()
            return r

        r = guard(run)
    else:
        if not can_some(g.membership, "procedures.manage"):
            abort(403, message="You can't build procedures.")
        r = guard(svc.attach_one_off, g.org, g.membership, wo, b)
    return svc.run_dict(r, g.membership), 201


@bp.delete("/work-orders/<wo_id>/procedures/<run_id>")
@require("wo.edit")
def remove_from_work_order(wo_id: str, run_id: str) -> tuple[str, int]:
    wo = _wo(wo_id)
    guard(svc.remove_run, g.org, g.membership, wo, guard(svc.get_run, wo, run_id))
    return "", 204


@bp.put("/work-orders/<wo_id>/procedures/<run_id>/answers/<field_id>")
@require("procedures.fill")
def put_answer(wo_id: str, run_id: str, field_id: str) -> dict[str, Any]:
    """{value, note?, file_ids?, signature? (PNG data URL), signed_by?}. Location check-in: value {lat, lng, accuracy}
    or {skip: true, reason}. Meter reading: value {value, meter_id?}. Returns {run, corrective}."""
    wo = _wo(wo_id)
    _fill_guard(wo)
    run = guard(svc.get_run, wo, run_id)
    return guard(svc.answer, g.org, g.membership, wo, run, field_id, body())


@bp.post("/work-orders/<wo_id>/procedures/<run_id>/corrective")
@require("wo.create")
def corrective(wo_id: str, run_id: str) -> tuple[dict[str, Any], int]:
    """{field_id?, title?} — create the corrective work order for a failed/flagged step (or a low score)."""
    wo = _wo(wo_id)
    run = guard(svc.get_run, wo, run_id)
    b = body()
    new = guard(
        svc.create_corrective,
        g.org,
        g.membership,
        wo,
        run,
        b.get("field_id") or None,
        True,
        (str(b.get("title") or "") or None),
    )
    return {"id": str(new.id), "number": new.number, "title": new.title}, 201


# ---- search, files ---------------------------------------------------------------------------------
@provider("procedures", "Procedures", "procedures.view")
def _search(q: str, limit: int) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        svc.library_query(g.org.id, {"status": "all"})
        .where(func.lower(Procedure.name).like(like(q), escape="\\"))
        .order_by(func.lower(Procedure.name))
        .limit(limit)
    ).all()
    return [
        {
            "id": str(p.id),
            "title": p.name,
            "subtitle": p.status.capitalize() + (f" · {p.category}" if p.category else ""),
            "url": f"/procedures/{p.id}",
        }
        for p in rows
    ]


def _proc_visible(pid: uuid.UUID, perm: str) -> bool:
    p = db.session.get(Procedure, pid)
    return (
        p is not None
        and p.org_id == g.org.id
        and can_on(g.membership, perm, p)
        and svc.can_see_procedure(g.membership, p)
    )


register_entity(
    "procedure", lambda i: _proc_visible(i, "procedures.view"), lambda i: _proc_visible(i, "procedures.manage")
)
svc._register_hooks()
