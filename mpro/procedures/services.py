"""Procedure rules: library, versions, runs on work orders, answers, scoring, corrective actions (0.4.0)."""

from __future__ import annotations

import contextlib
import copy
import csv
import io
import logging
import math
import re
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select

from mpro.core.events import emit
from mpro.core.files import FileLink, FileObject, attach, file_dict, save_file
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, TeamMember
from mpro.orgs.services import RuleError
from mpro.procedures import schema as sch
from mpro.procedures.models import (
    Procedure,
    ProcedureAnswer,
    ProcedureRun,
    ProcedureVersion,
)
from mpro.workorders.models import WorkOrder

CORRECTIVE_POLICIES = ("prompt", "auto", "none")
register_defaults(
    "procedures",
    {
        # corrective action work orders (MaintainX "Corrective action policy", r179)
        "on_fail": "prompt",
        "on_flag": "prompt",
        "on_low_score": "prompt",
        # updating a procedure step on an Open work order sets it In Progress (r074)
        "auto_in_progress": True,
    },
)
MAX_RUNS_PER_WO = 20

log = logging.getLogger(__name__)


def proc_settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "procedures")


def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    cur = proc_settings(org.id)
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k in ("on_fail", "on_flag", "on_low_score"):
            if v not in CORRECTIVE_POLICIES:
                raise RuleError("Choose automatic with a prompt, automatic, or none.", 422)
            clean[k] = v
        elif k == "auto_in_progress":
            clean[k] = bool(v)
        else:
            raise RuleError(f"Unknown setting {k!r}.", 422)
    changes = {k: (cur[k], v) for k, v in clean.items() if cur[k] != v}
    out = save_settings(org.id, "procedures", clean)
    if changes:
        emit(
            "procedures.settings_changed",
            entity_type="org",
            entity_id=org.id,
            entity_label=org.name,
            summary="Changed procedure settings",
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return out


def _uuid(v: Any, what: str = "procedure") -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def get_procedure(org_id: uuid.UUID, pid: Any, include_deleted: bool = False) -> Procedure:
    p = db.session.get(Procedure, _uuid(pid))
    if p is None or p.org_id != org_id or (p.deleted_at is not None and not include_deleted):
        raise RuleError("That procedure doesn't exist.", 404)
    return p


def latest_version(p: Procedure) -> ProcedureVersion | None:
    return db.session.scalars(
        select(ProcedureVersion)
        .where(ProcedureVersion.procedure_id == p.id)
        .order_by(ProcedureVersion.number.desc())
        .limit(1)
    ).first()


def current_version(p: Procedure) -> ProcedureVersion | None:
    return db.session.get(ProcedureVersion, p.current_version_id) if p.current_version_id else None


def _field_count(schema: dict[str, Any]) -> int:
    return len(sch.fields(schema))


# ---- serialization -------------------------------------------------------------------------------
def procedure_dict(p: Procedure, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    d = {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "status": p.status,
        "category": p.category,
        "tags": p.tags or [],
        "variants": p.variants or [],
        "one_off": p.work_order_id is not None,
        "current_version_id": str(p.current_version_id) if p.current_version_id else None,
        "created_at": iso(p.created_at),
        "updated_at": iso(p.updated_at),
        "deleted": p.deleted_at is not None,
    }
    if extra:
        d.update(extra)
    return d


def version_dict(v: ProcedureVersion) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "number": v.number,
        "schema": v.schema,
        "published_at": iso(v.published_at),
        "changes": v.changes or {},
        "created_at": iso(v.created_at),
        "field_count": _field_count(v.schema or {}),
    }


def detail(p: Procedure) -> dict[str, Any]:
    latest = latest_version(p)
    cur = current_version(p)
    used = (
        db.session.scalar(select(func.count()).select_from(ProcedureRun).where(ProcedureRun.procedure_id == p.id)) or 0
    )
    files = db.session.scalars(
        select(FileLink)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(FileLink.entity_type == "procedure", FileLink.entity_id == p.id, FileObject.deleted_at.is_(None))
    ).all()
    return procedure_dict(
        p,
        {
            "draft": version_dict(latest) if latest and latest.published_at is None else None,
            "published": version_dict(cur) if cur else None,
            "has_unpublished_changes": bool(latest and latest.published_at is None and cur is not None),
            "work_order_count": int(used),
            "files": [file_dict(link.file, link.role, link.id) for link in files],
        },
    )


# ---- library -------------------------------------------------------------------------------------
def _clean_meta(p: Procedure, data: dict[str, Any]) -> None:
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise RuleError("The procedure needs a name.", 422)
        if len(name) > 255:
            raise RuleError("Names can be up to 255 characters.", 422)
        p.name = name
    if "description" in data:
        p.description = str(data["description"] or "")[:10000]
    if "category" in data:
        p.category = str(data["category"] or "").strip()[:80]
    if "tags" in data:
        tags = data["tags"] or []
        if not isinstance(tags, list):
            raise RuleError("Tags must be a list.", 422)
        clean: list[str] = []
        for t in tags:
            s = str(t).strip()[:40]
            if s and s.lower() not in [x.lower() for x in clean]:
                clean.append(s)
        p.tags = clean[:20]
    if "variants" in data:
        p.variants = _clean_variants(p, data["variants"] or [])


def _clean_variants(p: Procedure, raw: Any) -> list[dict[str, Any]]:
    """Seasonal variants (r598): [{name, months: [1..12], procedure_id}] picked automatically by date."""
    if not isinstance(raw, list) or len(raw) > 12:
        raise RuleError("Seasonal variants must be a list (up to 12).", 422)
    out: list[dict[str, Any]] = []
    taken: set[int] = set()
    for v in raw:
        if not isinstance(v, dict):
            raise RuleError("Each seasonal variant needs a name, months and a procedure.", 422)
        months = sorted({int(x) for x in (v.get("months") or []) if str(x).isdigit() and 1 <= int(x) <= 12})
        if not months:
            raise RuleError("Pick the months for each seasonal variant.", 422)
        if taken & set(months):
            raise RuleError("Two seasonal variants share a month.", 422)
        taken |= set(months)
        other = get_procedure(p.org_id, v.get("procedure_id"))
        if other.id == p.id:
            raise RuleError("A variant must be a different procedure.", 422)
        out.append(
            {
                "name": str(v.get("name") or "").strip()[:60] or other.name,
                "months": months,
                "procedure_id": str(other.id),
            }
        )
    return out


def _check_refs(org: Organization, m: Membership, p: Procedure, schema: dict[str, Any]) -> None:
    """Reference pictures and files on fields must be this org's files; link them to the procedure."""
    linked = set(
        db.session.scalars(
            select(FileLink.file_id).where(FileLink.entity_type == "procedure", FileLink.entity_id == p.id)
        ).all()
    )
    for f in sch.walk(schema.get("items") or [], include_structure=True):
        for fid in f.get("reference_file_ids") or []:
            fo = db.session.get(FileObject, _uuid(fid, "file"))
            if fo is None or fo.org_id != org.id or fo.deleted_at is not None:
                raise RuleError("One of the reference files couldn't be found. Upload it again.", 422)
            if fo.id not in linked:
                if fo.uploaded_by_id != m.user_id:
                    raise RuleError("One of the reference files couldn't be found. Upload it again.", 422)
                attach(fo, "procedure", p.id, "reference")
                linked.add(fo.id)
    for f in sch.fields(schema):
        if f["type"] == "meter_reading" and f.get("meter_id"):
            from mpro.meters.models import Meter

            mt = db.session.get(Meter, _uuid(f["meter_id"], "meter"))
            if mt is None or mt.org_id != org.id or mt.deleted_at is not None:
                raise RuleError(f"The meter on {f['label']} doesn't exist.", 422)
    for f in sch.walk(schema.get("items") or [], include_structure=True):
        if f["type"] == "procedure":
            other = get_procedure(org.id, f["procedure_id"])
            if other.id == p.id:
                raise RuleError("A procedure can't include itself.", 422)
            if other.current_version_id is None:
                raise RuleError(f"Publish {other.name} before including it.", 422)


def create_procedure(
    org: Organization, m: Membership, data: dict[str, Any], *, work_order: WorkOrder | None = None, commit: bool = True
) -> Procedure:
    p = Procedure(
        org_id=org.id,
        name="",
        description="",
        status="draft",
        category="",
        tags=[],
        variants=[],
        created_by_id=m.user_id,
        work_order_id=work_order.id if work_order else None,
    )
    _clean_meta(
        p, {"name": data.get("name", ""), **{k: data[k] for k in ("description", "category", "tags") if k in data}}
    )
    db.session.add(p)
    db.session.flush()
    schema = sch.validate(data.get("schema") or {})
    _check_refs(org, m, p, schema)
    db.session.add(
        ProcedureVersion(org_id=org.id, procedure_id=p.id, number=1, schema=schema, changes={}, created_by_id=m.user_id)
    )
    if "variants" in data:
        p.variants = _clean_variants(p, data["variants"] or [])
    emit(
        "procedure.created",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Created procedure {p.name}",
    )
    if commit:
        db.session.commit()
    return p


def update_procedure(org: Organization, m: Membership, p: Procedure, data: dict[str, Any]) -> Procedure:
    if p.deleted_at is not None:
        raise RuleError("This procedure was deleted. Restore it first.", 409)
    before = {"name": p.name, "description": p.description, "category": p.category, "tags": list(p.tags or [])}
    _clean_meta(p, data)
    changed = [k for k in before if before[k] != getattr(p, k)]
    if "schema" in data:
        schema = sch.validate(data["schema"])
        _check_refs(org, m, p, schema)
        draft = latest_version(p)
        if draft is None or draft.published_at is not None:  # published versions never change (r154)
            draft = ProcedureVersion(
                org_id=org.id,
                procedure_id=p.id,
                number=(draft.number + 1 if draft else 1),
                schema=schema,
                changes={},
                created_by_id=m.user_id,
            )
            db.session.add(draft)
        else:
            draft.schema = schema
        changed.append("steps")
    if changed or "variants" in data:
        emit(
            "procedure.updated",
            entity_type="procedure",
            entity_id=p.id,
            entity_label=p.name,
            summary="Changed " + ", ".join(changed or ["seasonal variants"]),
        )
    db.session.commit()
    return p


def _resolve_nested(org_id: uuid.UUID, items: list[dict[str, Any]], depth: int = 0) -> list[dict[str, Any]]:
    """Snapshot included library procedures into the version being published (r185)."""
    out = []
    for it in items:
        it = dict(it)
        if it["type"] == "section":
            it["items"] = _resolve_nested(org_id, it.get("items") or [], depth)
        elif it["type"] == "procedure":
            other = get_procedure(org_id, it["procedure_id"])
            cur = current_version(other)
            if cur is None:
                raise RuleError(f"Publish {other.name} before including it.", 422)
            if depth >= 2:
                raise RuleError("Included procedures can only be nested two levels deep.", 422)
            prefix = it["id"] + "_"
            kids = _prefix_ids(copy.deepcopy(cur.schema.get("items") or []), prefix)
            it["items"] = _resolve_nested(org_id, kids, depth + 1)
            it["label"] = it.get("label") or other.name
            it["version_number"] = cur.number
        out.append(it)
    return out


def _prefix_ids(items: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
    for it in items:
        it["id"] = (prefix + it["id"])[:40]
        if it.get("condition"):
            it["condition"]["field"] = (prefix + it["condition"]["field"])[:40]
        if it.get("items"):
            _prefix_ids(it["items"], prefix)
    return items


def publish(org: Organization, m: Membership, p: Procedure) -> Procedure:
    draft = latest_version(p)
    if draft is None or draft.published_at is not None:
        raise RuleError("There are no unpublished changes.", 409)
    schema = dict(draft.schema)
    schema["items"] = _resolve_nested(org.id, schema.get("items") or [])
    schema = sch.validate(schema)
    if not sch.fields(schema):
        raise RuleError("Add at least one field before publishing.", 422)
    prev = current_version(p)
    draft.schema = schema
    draft.changes = sch.diff(prev.schema if prev else None, schema)
    draft.published_at = utcnow()
    p.current_version_id = draft.id
    p.status = "published"
    emit(
        "procedure.published",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Published version {draft.number}",
        data={"changes": draft.changes},
    )
    db.session.commit()
    return p


def set_archived(org: Organization, m: Membership, p: Procedure, archived: bool) -> Procedure:
    if archived:
        p.status = "archived"
    else:
        p.status = "published" if p.current_version_id else "draft"
    emit(
        "procedure.archived" if archived else "procedure.unarchived",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary=("Archived" if archived else "Restored from archive") + f" {p.name}",
    )
    db.session.commit()
    return p


def delete_procedure(org: Organization, m: Membership, p: Procedure) -> None:
    p.deleted_at = utcnow()
    emit(
        "procedure.deleted",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Deleted procedure {p.name}",
    )
    db.session.commit()


def restore_procedure(org: Organization, m: Membership, p: Procedure) -> Procedure:
    p.deleted_at = None
    emit(
        "procedure.restored",
        entity_type="procedure",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Restored procedure {p.name}",
    )
    db.session.commit()
    return p


def copy_procedure(org: Organization, m: Membership, p: Procedure) -> Procedure:
    src = latest_version(p)
    return create_procedure(
        org,
        m,
        {
            "name": f"Copy - {p.name}"[:255],
            "description": p.description,
            "category": p.category,
            "tags": list(p.tags or []),
            "schema": copy.deepcopy(src.schema) if src else {},
        },
    )


def library_query(org_id: uuid.UUID, params: dict[str, Any]) -> Any:
    from mpro.core.search import like

    q = select(Procedure).where(Procedure.org_id == org_id, Procedure.work_order_id.is_(None))
    if str(params.get("include_deleted")) in ("1", "true"):
        pass
    else:
        q = q.where(Procedure.deleted_at.is_(None))
    status = params.get("status")
    if status in ("draft", "published", "archived"):
        q = q.where(Procedure.status == status)
    elif status != "all":
        q = q.where(Procedure.status != "archived")
    if params.get("q"):
        pat = like(str(params["q"]))
        q = q.where(
            func.lower(Procedure.name).like(pat, escape="\\") | func.lower(Procedure.description).like(pat, escape="\\")
        )
    if params.get("category"):
        q = q.where(Procedure.category == str(params["category"]))
    return q


def library(org_id: uuid.UUID, params: dict[str, Any]) -> dict[str, Any]:
    rows = list(db.session.scalars(library_query(org_id, params).order_by(func.lower(Procedure.name))).all())
    tag = params.get("tag")
    if tag:
        rows = [p for p in rows if tag.lower() in [t.lower() for t in (p.tags or [])]]
    ids = [p.id for p in rows]
    counts = (
        dict(
            db.session.execute(
                select(ProcedureRun.procedure_id, func.count())
                .where(ProcedureRun.procedure_id.in_(ids))
                .group_by(ProcedureRun.procedure_id)
            ).all()
        )
        if ids
        else {}
    )
    latest: dict[uuid.UUID, ProcedureVersion] = {}
    for v in (
        db.session.scalars(select(ProcedureVersion).where(ProcedureVersion.procedure_id.in_(ids))).all() if ids else []
    ):
        if v.procedure_id not in latest or v.number > latest[v.procedure_id].number:
            latest[v.procedure_id] = v
    all_tags = sorted(
        {t for p in db.session.scalars(library_query(org_id, {"status": "all"})).all() for t in (p.tags or [])},
        key=str.lower,
    )
    cats = sorted({p.category for p in rows if p.category}, key=str.lower)
    return {
        "items": [
            procedure_dict(
                p,
                {
                    "work_order_count": int(counts.get(p.id, 0)),
                    "field_count": _field_count(latest[p.id].schema) if p.id in latest else 0,
                    "version": latest[p.id].number if p.id in latest else 0,
                    "has_unpublished_changes": bool(
                        p.id in latest and latest[p.id].published_at is None and p.current_version_id
                    ),
                },
            )
            for p in rows
        ],
        "tags": all_tags,
        "categories": cats,
    }


# ---- runs on work orders -------------------------------------------------------------------------
def _pick_variant(p: Procedure, when: date) -> Procedure:
    for v in p.variants or []:
        if when.month in v.get("months", []):
            other = db.session.get(Procedure, _uuid(v["procedure_id"]))
            if (
                other is not None
                and other.deleted_at is None
                and other.current_version_id
                and other.status != "archived"
            ):
                return other
    return p


def attach_procedures(
    org: Organization, m: Membership, wo: WorkOrder, procedure_ids: list[Any], commit: bool = False
) -> list[ProcedureRun]:
    """Attach published procedures (or their seasonal variant for the due month) to a work order."""
    if not isinstance(procedure_ids, list):
        raise RuleError("Procedures must be a list.", 422)
    existing = (
        db.session.scalar(select(func.count()).select_from(ProcedureRun).where(ProcedureRun.work_order_id == wo.id))
        or 0
    )
    if existing + len(procedure_ids) > MAX_RUNS_PER_WO:
        raise RuleError(f"A work order can have up to {MAX_RUNS_PER_WO} procedures.", 422)
    when = (wo.due_at or utcnow()).date()
    runs = []
    for n, raw in enumerate(procedure_ids):
        p = get_procedure(org.id, raw)
        if p.status == "archived":
            raise RuleError(f"{p.name} is archived.", 422)
        p = _pick_variant(p, when)
        if p.current_version_id is None:
            raise RuleError(f"{p.name} is a draft. Publish it before using it on work orders.", 422)
        run = ProcedureRun(
            org_id=org.id,
            work_order_id=wo.id,
            procedure_id=p.id,
            version_id=p.current_version_id,
            sort=existing + n,
            status="not_started",
        )
        db.session.add(run)
        runs.append(run)
        emit(
            "wo.procedure_added",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=f"#{wo.number} {wo.title}",
            summary=f"Added procedure {p.name}",
            data={"procedure_id": p.id},
            org_id=org.id,
        )
    db.session.flush()
    if commit:
        db.session.commit()
    return runs


def attach_one_off(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> ProcedureRun:
    """Build a procedure inside a work order (r210): published at once, hidden from the library."""
    p = create_procedure(
        org,
        m,
        {"name": data.get("name") or "Checklist", "schema": data.get("schema") or {}},
        work_order=wo,
        commit=False,
    )
    v = latest_version(p)
    assert v is not None
    schema = sch.validate({**v.schema, "items": _resolve_nested(org.id, v.schema.get("items") or [])})
    if not sch.fields(schema):
        raise RuleError("Add at least one field.", 422)
    v.schema, v.published_at, p.current_version_id, p.status = schema, utcnow(), v.id, "published"
    db.session.flush()
    runs = attach_procedures(org, m, wo, [p.id])
    db.session.commit()
    return runs[0]


def get_run(wo: WorkOrder, run_id: Any) -> ProcedureRun:
    r = db.session.get(ProcedureRun, _uuid(run_id, "procedure"))
    if r is None or r.work_order_id != wo.id:
        raise RuleError("That procedure isn't on this work order.", 404)
    return r


def remove_run(org: Organization, m: Membership, wo: WorkOrder, run: ProcedureRun) -> None:
    if wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to change its procedures.", 409)
    n = (
        db.session.scalar(select(func.count()).select_from(ProcedureAnswer).where(ProcedureAnswer.run_id == run.id))
        or 0
    )
    if n and not can(m, "procedures.manage"):
        raise RuleError("This procedure has answers. Ask someone who manages procedures to remove it.", 403)
    p = db.session.get(Procedure, run.procedure_id)
    for a in db.session.scalars(select(ProcedureAnswer).where(ProcedureAnswer.run_id == run.id)).all():
        db.session.delete(a)
    db.session.delete(run)
    emit(
        "wo.procedure_removed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"Removed procedure {p.name if p else ''}".strip(),
    )
    db.session.commit()


def answers_of(run: ProcedureRun) -> dict[str, ProcedureAnswer]:
    return {
        a.field_id: a for a in db.session.scalars(select(ProcedureAnswer).where(ProcedureAnswer.run_id == run.id)).all()
    }


def _answer_values(rows: dict[str, ProcedureAnswer]) -> dict[str, Any]:
    return {k: (a.value if not a.skipped else "__skipped__") for k, a in rows.items()}


def live_assignees(org_id: uuid.UUID | None, who: list[str]) -> list[str]:
    """Field assignees still in the organization (#13): removed members and deleted teams are ignored."""
    if not who or org_id is None:
        return list(who or [])
    from mpro.orgs.models import Team

    users: list[uuid.UUID] = []
    teams: list[uuid.UUID] = []
    for w in who:
        kind, _, raw = str(w).partition(":")
        try:
            u = uuid.UUID(raw)
        except ValueError:
            continue
        if kind == "user":
            users.append(u)
        elif kind == "team":
            teams.append(u)
    live_users = (
        set(
            db.session.scalars(
                select(Membership.user_id).where(
                    Membership.org_id == org_id, Membership.user_id.in_(users), Membership.deleted_at.is_(None)
                )
            ).all()
        )
        if users
        else set()
    )
    live_teams = (
        set(
            db.session.scalars(
                select(Team.id).where(Team.org_id == org_id, Team.id.in_(teams), Team.deleted_at.is_(None))
            ).all()
        )
        if teams
        else set()
    )
    return [f"user:{u}" for u in users if u in live_users] + [f"team:{t}" for t in teams if t in live_teams]


def progress(
    schema: dict[str, Any], rows: dict[str, ProcedureAnswer], org_id: uuid.UUID | None = None
) -> dict[str, Any]:
    values = _answer_values(rows)
    vis = sch.visible_ids(schema, values)
    fs = [f for f in sch.fields(schema) if f["id"] in vis]
    done = [f for f in fs if f["id"] in rows and sch.answered(f, rows[f["id"]].value, rows[f["id"]].skipped)]
    missing = [
        f
        for f in fs
        if (f.get("required") or (f.get("assignees") and live_assignees(org_id, f["assignees"]))) and f not in done
    ]
    return {
        "answered": len(done),
        "total": len(fs),
        "visible": sorted(vis),
        "missing_required": [f["label"] for f in missing],
    }


def _answer_dict(a: ProcedureAnswer, names: dict[uuid.UUID, str]) -> dict[str, Any]:
    files = []
    for fid in a.file_ids or []:
        fo = db.session.get(FileObject, _uuid(fid, "file"))
        if fo is not None and fo.deleted_at is None:
            files.append(file_dict(fo))
    return {
        "value": a.value,
        "result": a.result,
        "note": a.note,
        "files": files,
        "skipped": a.skipped,
        "answered_by": names.get(a.answered_by_id) if a.answered_by_id else None,
        "answered_at": iso(a.answered_at),
    }


def run_dict(run: ProcedureRun, m: Membership | None = None) -> dict[str, Any]:
    from mpro.auth.models import User

    v = db.session.get(ProcedureVersion, run.version_id)
    p = db.session.get(Procedure, run.procedure_id)
    schema = v.schema if v else {"items": []}
    rows = answers_of(run)
    ids = {a.answered_by_id for a in rows.values() if a.answered_by_id}
    names = dict(db.session.execute(select(User.id, User.name).where(User.id.in_(ids))).all()) if ids else {}
    prog = progress(schema, rows, run.org_id)
    refs: dict[str, Any] = {}
    for f in sch.walk(schema.get("items") or []):
        for fid in f.get("reference_file_ids") or []:
            fo = db.session.get(FileObject, _uuid(fid, "file"))
            if fo is not None and fo.deleted_at is None and fo.org_id == run.org_id:
                refs[str(fid)] = file_dict(fo)
    return {
        "id": str(run.id),
        "procedure": {"id": str(p.id), "name": p.name, "one_off": p.work_order_id is not None} if p else None,
        "version": v.number if v else None,
        "schema": schema,
        "status": run.status,
        "score": float(run.score) if run.score is not None else None,
        "goal": (schema.get("scoring") or {}).get("goal"),
        "progress": prog,
        "answers": {k: _answer_dict(a, names) for k, a in rows.items()},
        "reference_files": refs,
        "completed_at": iso(run.completed_at),
        "sort": run.sort,
    }


def runs_for(m: Membership | None, wo: WorkOrder) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        select(ProcedureRun)
        .where(ProcedureRun.work_order_id == wo.id)
        .order_by(ProcedureRun.sort, ProcedureRun.created_at)
    ).all()
    return [run_dict(r, m) for r in rows]


# ---- answering -----------------------------------------------------------------------------------
def _find_field(schema: dict[str, Any], field_id: str) -> dict[str, Any]:
    for f in sch.fields(schema):
        if f["id"] == field_id:
            return f
    raise RuleError("That field isn't in this procedure.", 404)


def _is_assignee(m: Membership, f: dict[str, Any]) -> bool:
    """Assigned fields are answered by their assignees, or by people who manage procedures (#13)."""
    who = live_assignees(m.org_id, f.get("assignees") or [])
    if not who or can(m, "procedures.manage"):
        return True
    if f"user:{m.user_id}" in who:
        return True
    teams = {
        str(t)
        for t in db.session.scalars(
            select(TeamMember.team_id).where(TeamMember.user_id == m.user_id, TeamMember.org_id == m.org_id)
        ).all()
    }
    return any(w.startswith("team:") and w[5:] in teams for w in who)


def _dec(v: Any, label: str) -> Decimal:
    if isinstance(v, bool):
        raise RuleError(f"{label} must be a number.", 422)
    try:
        d = Decimal(str(v))
    except (InvalidOperation, ValueError) as e:
        raise RuleError(f"{label} must be a number.", 422) from e
    if not d.is_finite() or abs(d) >= Decimal("1e14"):
        raise RuleError(f"{label} must be a number.", 422)
    return d.quantize(Decimal("0.0001"))


def _files(org: Organization, m: Membership, wo: WorkOrder, ids: Any, label: str) -> list[str]:
    if ids in (None, ""):
        return []
    if not isinstance(ids, list) or len(ids) > 20:
        raise RuleError(f"Attach up to 20 files to {label}.", 422)
    out = []
    for raw in ids:
        fo = db.session.get(FileObject, _uuid(raw, "file"))
        if fo is None or fo.org_id != org.id or fo.deleted_at is not None:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        already = db.session.scalar(
            select(FileLink.id).where(
                FileLink.file_id == fo.id, FileLink.entity_type == "work_order", FileLink.entity_id == wo.id
            )
        )
        if not already:
            if fo.uploaded_by_id != m.user_id:
                raise RuleError("One of the files couldn't be found. Upload it again.", 422)
            attach(fo, "work_order", wo.id, "procedure")
        out.append(str(fo.id))
    return out


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _wo_coordinates(wo: WorkOrder) -> tuple[float, float, str] | None:
    from mpro.assets.models import Location

    loc = db.session.get(Location, wo.location_id) if wo.location_id else None
    if loc is None and wo.asset is not None and wo.asset.location_id:
        loc = db.session.get(Location, wo.asset.location_id)
    if loc is None or loc.latitude is None or loc.longitude is None:
        return None
    return loc.latitude, loc.longitude, loc.name


def _clean_answer(
    org: Organization,
    m: Membership,
    wo: WorkOrder,
    f: dict[str, Any],
    body: dict[str, Any],
    prev: ProcedureAnswer | None,
) -> dict[str, Any]:
    """Validate one answer. Returns column values: value, value_number, value_text, result, skipped, note."""
    t, label = f["type"], f["label"]
    v = body.get("value")
    out: dict[str, Any] = {"value": v, "value_number": None, "value_text": "", "result": "", "skipped": False}
    if v in (None, "", []) and t not in ("location_check_in", "signature", "file"):
        out["value"] = None
        return out
    if t == "checkbox":
        out["value"] = bool(v)
    elif t == "text":
        if not isinstance(v, str) or len(v) > 10000:
            raise RuleError(f"{label} must be text up to 10,000 characters.", 422)
        out["value_text"] = v
    elif t in ("number", "amount"):
        d = _dec(v, label)
        if f.get("min") is not None and d < Decimal(str(f["min"])):
            raise RuleError(f"{label} must be at least {f['min']:g}.", 422)
        if f.get("max") is not None and d > Decimal(str(f["max"])):
            raise RuleError(f"{label} must be at most {f['max']:g}.", 422)
        out["value_number"], out["value"] = d, float(d)
    elif t == "multiple_choice":
        if str(v) not in f.get("options", []):
            raise RuleError(f"Pick one of the options for {label}.", 422)
        out["value"] = out["value_text"] = str(v)
    elif t == "checklist":
        if not isinstance(v, list) or any(str(x) not in f.get("options", []) for x in v):
            raise RuleError(f"Tick items from the list for {label}.", 422)
        out["value"] = [o for o in f["options"] if o in [str(x) for x in v]]
    elif t == "inspection":
        if v not in sch.INSPECTION_RESULTS:
            raise RuleError(f"{label} is Pass, Flag or Fail.", 422)
        out["result"] = v
    elif t == "yes_no_na":
        if v not in sch.YES_NO_NA:
            raise RuleError(f"{label} is Yes, No or N/A.", 422)
        out["result"] = v
    elif t == "date":
        s = str(v)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?", s):
            raise RuleError(f"{label} must be a date.", 422)
        out["value"] = out["value_text"] = s
    elif t == "file":
        ids = _files(org, m, wo, body.get("file_ids", v), label)
        out["value"] = ids or None
    elif t == "signature":
        if body.get("signature"):
            from mpro.workorders.services import _decode_signature

            png = _decode_signature(str(body["signature"]))
            fo = save_file(org.id, "signature.png", png, m.user_id, content_type="image/png")
            attach(fo, "work_order", wo.id, "procedure_signature")
            name = str(body.get("signed_by") or m.user.name).strip()[:200]
            out["value"] = {"file_id": str(fo.id), "name": name, "signed_at": iso(utcnow())}
        elif v in (None, "", {}):
            out["value"] = None
        else:
            raise RuleError("Sign in the box to answer this field.", 422)
    elif t == "meter_reading":
        from mpro.meters.models import Meter
        from mpro.meters.services import add_reading, delete_reading

        raw = v if isinstance(v, dict) else {"value": v}
        d = _dec(raw.get("value"), label)
        mid = f.get("meter_id") or raw.get("meter_id")
        if not mid:
            raise RuleError(f"Pick the meter for {label}.", 422)
        mt = db.session.get(Meter, _uuid(mid, "meter"))
        if mt is None or mt.org_id != org.id or mt.deleted_at is not None:
            raise RuleError("That meter doesn't exist.", 422)
        if not can(m, "meters.read"):
            raise RuleError("You can't record meter readings.", 403)
        if prev and isinstance(prev.value, dict) and prev.value.get("reading_id") and prev.value.get("meter_id"):
            old = db.session.get(Meter, _uuid(prev.value["meter_id"], "meter"))
            if old is not None:
                with contextlib.suppress(RuleError):
                    delete_reading(org, m, old, prev.value["reading_id"])
        r = add_reading(org, m, mt, {"value": str(d), "work_order_id": str(wo.id)}, commit=False)
        out["value"] = {
            "meter_id": str(mt.id),
            "value": float(d),
            "unit": mt.unit,
            "reading_id": str(r.id),
            "level": r.level,
        }
        out["value_number"] = d
        if r.level == "alarm":
            out["result"] = "fail"
        elif r.level == "warning":
            out["result"] = "flag"
    elif t == "location_check_in":
        raw = v if isinstance(v, dict) else {}
        target = _wo_coordinates(wo)
        if raw.get("skip"):
            if not f.get("allow_skip", True):
                raise RuleError(f"{label} can't be skipped.", 422)
            out["skipped"] = True
            out["value"] = {"skipped": True, "reason": str(raw.get("reason") or "")[:500]}
            out["note"] = "Check-in skipped" + (f": {out['value']['reason']}" if out["value"]["reason"] else "")
            return out
        if raw in ({}, None) or raw.get("lat") is None:
            out["value"] = None
            return out
        try:
            lat, lng, acc = float(raw["lat"]), float(raw["lng"]), float(raw.get("accuracy") or 0)
        except (TypeError, ValueError, KeyError) as e:
            raise RuleError("Your position couldn't be read. Try again.", 422) from e
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise RuleError("Your position couldn't be read. Try again.", 422)
        val: dict[str, Any] = {"lat": round(lat, 6), "lng": round(lng, 6), "accuracy": round(acc, 1)}
        if target is None:
            val["note"] = "The location has no coordinates, so the distance wasn't checked."
        else:
            dist = _haversine(lat, lng, target[0], target[1])
            val["distance_m"] = round(dist, 1)
            allowed = f.get("buffer_m", 10) + min(max(acc, 0), 25)
            if dist > allowed:
                raise RuleError(
                    f"You're about {dist:,.0f} m from {target[2]}. Move within {f.get('buffer_m', 10)} m to check in"
                    + (", or skip the check-in." if f.get("allow_skip", True) else "."),
                    422,
                )
        out["value"] = val
    return out


def answer(
    org: Organization, m: Membership, wo: WorkOrder, run: ProcedureRun, field_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    """Save one answer. Returns {"run": ..., "corrective": prompt or created WO or None}."""
    from mpro.workorders.services import set_status

    if wo.deleted_at is not None or wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to change its procedure answers.", 409)
    v = db.session.get(ProcedureVersion, run.version_id)
    if v is None:
        raise RuleError("This procedure version is missing.", 409)
    f = _find_field(v.schema, field_id)
    if not _is_assignee(m, f):
        raise RuleError(f"{f['label']} is assigned to someone else.", 403)
    rows = answers_of(run)
    values = _answer_values(rows)
    if field_id not in sch.visible_ids(v.schema, values):
        raise RuleError(f"{f['label']} doesn't apply with the current answers.", 409)
    prev = rows.get(field_id)
    clean = _clean_answer(org, m, wo, f, body, prev)
    note = str(body.get("note", prev.note if prev else "") or "")[:4000]
    if clean.get("note"):
        note = clean.pop("note")
    file_ids = prev.file_ids if prev else []
    if f["type"] == "file":
        file_ids = list(clean["value"] or [])
    elif "file_ids" in body:
        file_ids = _files(org, m, wo, body["file_ids"], f["label"])
    a = prev or ProcedureAnswer(
        org_id=org.id,
        run_id=run.id,
        procedure_id=run.procedure_id,
        work_order_id=wo.id,
        field_id=field_id,
        field_type=f["type"],
    )
    old_result = prev.result if prev else ""
    a.value, a.value_number, a.value_text, a.result, a.skipped = (
        clean["value"],
        clean["value_number"],
        clean["value_text"],
        clean["result"],
        clean["skipped"],
    )
    a.note, a.file_ids = note, file_ids
    a.answered_by_id, a.answered_at = m.user_id, utcnow()
    if prev is None:
        db.session.add(a)
    db.session.flush()
    rows[field_id] = a
    run.score = sch.score(v.schema, _answer_values(rows))
    if run.status == "not_started":
        run.status = "in_progress"
    # r074: updating a step on an Open work order moves it to In Progress
    if wo.status == "open" and proc_settings(org.id)["auto_in_progress"] and sch.answered(f, a.value, a.skipped):
        set_status(org, m, wo, "in_progress", commit=False)
    emit(
        "wo.procedure_answered",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"Answered {f['label'][:120]}"
        + (f" — {a.result.capitalize()}" if a.result in ("fail", "flag") else ""),
        data={"run_id": run.id, "field_id": field_id, "result": a.result},
    )
    corrective = None
    if a.result in ("fail", "flag") and a.result != old_result:
        corrective = _corrective_policy(org, m, wo, run, f, a)
    if corrective is None and run.score is not None:
        goal = (v.schema.get("scoring") or {}).get("goal")
        prog = progress(v.schema, rows, run.org_id)
        scorable_left = [
            x
            for x in sch.fields(v.schema)
            if x["type"] in sch.SCORABLE and x["id"] in prog["visible"] and x["id"] not in rows
        ]
        if goal is not None and run.score < goal and not scorable_left:
            corrective = _score_policy(org, m, wo, run, v.schema, goal)
    db.session.commit()
    return {"run": run_dict(run, m), "corrective": corrective}


def _existing_corrective(source_type: str, source_id: uuid.UUID) -> WorkOrder | None:
    return db.session.scalars(
        select(WorkOrder).where(
            WorkOrder.source_type == source_type, WorkOrder.source_id == source_id, WorkOrder.deleted_at.is_(None)
        )
    ).first()


def _corrective_policy(
    org: Organization, m: Membership, wo: WorkOrder, run: ProcedureRun, f: dict[str, Any], a: ProcedureAnswer
) -> dict[str, Any] | None:
    policy = proc_settings(org.id)["on_fail" if a.result == "fail" else "on_flag"]
    if _existing_corrective("procedure_answer", a.id):
        return None
    if policy == "auto":
        new = create_corrective(org, m, wo, run, f["id"], commit=False)
        return {"created": {"id": str(new.id), "number": new.number, "title": new.title}}
    if policy == "prompt":
        return {
            "prompt": {
                "field_id": f["id"],
                "label": f["label"],
                "result": a.result,
                "title": f"Corrective action: {f['label']}"[:255],
            }
        }
    _note(org, m, wo, f"⚠ {f['label']} was marked {a.result.capitalize()} in the procedure.")
    return None


def _score_policy(
    org: Organization, m: Membership, wo: WorkOrder, run: ProcedureRun, schema: dict[str, Any], goal: int
) -> dict[str, Any] | None:
    if _existing_corrective("procedure_score", run.id):
        return None
    policy = proc_settings(org.id)["on_low_score"]
    p = db.session.get(Procedure, run.procedure_id)
    name = p.name if p else "procedure"
    if policy == "auto":
        new = create_corrective(org, m, wo, run, None, commit=False)
        return {"created": {"id": str(new.id), "number": new.number, "title": new.title}}
    if policy == "prompt":
        return {
            "prompt": {
                "field_id": None,
                "label": name,
                "result": "low_score",
                "score": float(run.score or 0),
                "goal": goal,
                "title": f"Corrective action: {name} scored {float(run.score or 0):g}% (goal {goal}%)"[:255],
            }
        }
    _note(org, m, wo, f"⚠ {name} scored {float(run.score or 0):g}%, below the {goal}% goal.")
    return None


def _note(org: Organization, m: Membership, wo: WorkOrder, text: str) -> None:
    from mpro.workorders.models import Comment

    db.session.add(
        Comment(
            org_id=org.id,
            entity_type="work_order",
            entity_id=wo.id,
            author_id=m.user_id,
            body=text,
            mentions={"users": [], "teams": []},
        )
    )


def create_corrective(
    org: Organization,
    m: Membership,
    wo: WorkOrder,
    run: ProcedureRun,
    field_id: str | None,
    commit: bool = True,
    title: str | None = None,
) -> WorkOrder:
    """A follow-up work order for a failed/flagged step or a low score, linked to the original (r044)."""
    from mpro.workorders.models import WorkOrderLink
    from mpro.workorders.services import create_work_order

    v = db.session.get(ProcedureVersion, run.version_id)
    p = db.session.get(Procedure, run.procedure_id)
    if field_id:
        f = _find_field(v.schema if v else {}, field_id)
        a = answers_of(run).get(field_id)
        if a is None or a.result not in ("fail", "flag"):
            raise RuleError("Corrective actions are for failed or flagged steps.", 409)
        existing = _existing_corrective("procedure_answer", a.id)
        source_type, source_id = "procedure_answer", a.id
        what = f"{f['label']} was marked {a.result.capitalize()}" + (f": {a.note}" if a.note else "")
        default_title = f"Corrective action: {f['label']}"
        prio = "high" if a.result == "fail" else "medium"
    else:
        existing = _existing_corrective("procedure_score", run.id)
        source_type, source_id = "procedure_score", run.id
        what = f"{p.name if p else 'The procedure'} scored {float(run.score or 0):g}%"
        default_title = f"Corrective action: {p.name if p else 'procedure'} below goal"
        prio = "medium"
    if existing is not None:
        return existing
    data: dict[str, Any] = {
        "title": (title or default_title)[:255],
        "description": f"Follow-up from work order #{wo.number} ({wo.title}). {what}."[:4096],
        "priority": prio,
        "work_type": "reactive",
    }
    if wo.asset_id:
        data["asset_id"] = str(wo.asset_id)
    if wo.location_id:
        data["location_id"] = str(wo.location_id)
    new = create_work_order(org, m, data, commit=False, check_required=False)
    new.source_type, new.source_id = source_type, source_id
    db.session.add(WorkOrderLink(org_id=org.id, from_id=wo.id, to_id=new.id, kind="related"))
    emit(
        "wo.corrective_created",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"Created corrective work order #{new.number}",
        data={"work_order_id": new.id},
        org_id=org.id,
    )
    if commit:
        db.session.commit()
    return new


# ---- work-order hooks ----------------------------------------------------------------------------
def completion_check(org: Organization, m: Membership, wo: WorkOrder) -> str | None:
    """Required fields (visible ones) and fields assigned to people must be answered before Done (r183)."""
    problems = []
    for run in db.session.scalars(
        select(ProcedureRun).where(ProcedureRun.work_order_id == wo.id).order_by(ProcedureRun.sort)
    ).all():
        v = db.session.get(ProcedureVersion, run.version_id)
        if v is None:
            continue
        prog = progress(v.schema, answers_of(run), run.org_id)
        if prog["missing_required"]:
            p = db.session.get(Procedure, run.procedure_id)
            names = ", ".join(prog["missing_required"][:5]) + (" …" if len(prog["missing_required"]) > 5 else "")
            problems.append(f"{p.name if p else 'Procedure'}: {names}")
    if problems:
        return "Answer the required procedure fields first — " + "; ".join(problems)
    return None


def on_status(org: Organization, m: Membership, wo: WorkOrder, from_status: str, to_status: str) -> None:
    runs = db.session.scalars(select(ProcedureRun).where(ProcedureRun.work_order_id == wo.id)).all()
    for run in runs:
        if to_status == "done":
            run.status, run.completed_at, run.completed_by_id = "done", utcnow(), m.user_id
        elif from_status == "done":
            run.status = "in_progress"
            run.completed_at = run.completed_by_id = None


def on_create(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> None:
    ids = data.get("procedures")
    if ids:
        attach_procedures(org, m, wo, ids)


def check_template_procedures(org_id: uuid.UUID, ids: Any) -> list[str]:
    if ids in (None, ""):
        return []
    if not isinstance(ids, list) or len(ids) > MAX_RUNS_PER_WO:
        raise RuleError(f"Templates can have up to {MAX_RUNS_PER_WO} procedures.", 422)
    out = []
    for raw in ids:
        p = get_procedure(org_id, raw)
        if p.current_version_id is None:
            raise RuleError(f"{p.name} is a draft. Publish it first.", 422)
        out.append(str(p.id))
    return out


def _register_hooks() -> None:
    from mpro.workorders import services as wo_svc

    if completion_check not in wo_svc.COMPLETION_CHECKS:
        wo_svc.COMPLETION_CHECKS.append(completion_check)
    if on_status not in wo_svc.STATUS_HOOKS:
        wo_svc.STATUS_HOOKS.append(on_status)
    if on_create not in wo_svc.CREATE_HOOKS:
        wo_svc.CREATE_HOOKS.append(on_create)


# ---- history, analytics, import ------------------------------------------------------------------
def _range(params: dict[str, Any]) -> tuple[datetime | None, datetime | None]:
    from mpro.workorders.services import _dt

    return (
        _dt(params.get("from"), "From") if params.get("from") else None,
        _dt(params.get("to"), "To") if params.get("to") else None,
    )


def can_see_procedure(m: Membership, p: Procedure) -> bool:
    """Library procedures are visible to anyone with procedures.view; one-off procedures built inside a work
    order (r210) only to people who can see that work order."""
    if p.work_order_id is None:
        return True
    from mpro.workorders.services import can_see

    wo = db.session.get(WorkOrder, p.work_order_id)
    return wo is not None and wo.org_id == p.org_id and can_see(m, wo)


def wo_history(m: Membership, p: Procedure, params: dict[str, Any]) -> dict[str, Any]:
    """Work orders created and completed with this procedure in a date range (r207)."""
    from mpro.workorders.services import visibility_filter

    lo, hi = _range(params)
    q = (
        select(ProcedureRun, WorkOrder)
        .join(WorkOrder, WorkOrder.id == ProcedureRun.work_order_id)
        .where(ProcedureRun.procedure_id == p.id, WorkOrder.deleted_at.is_(None), visibility_filter(m))
    )
    rows = db.session.execute(q.order_by(WorkOrder.created_at.desc())).all()
    created = [w for _, w in rows if (lo is None or w.created_at >= lo) and (hi is None or w.created_at <= hi)]
    completed = [
        w
        for _, w in rows
        if w.completed_at and (lo is None or w.completed_at >= lo) and (hi is None or w.completed_at <= hi)
    ]
    return {
        "created": len(created),
        "completed": len(completed),
        "recent": [
            {
                "id": str(w.id),
                "number": w.number,
                "title": w.title,
                "status": w.status,
                "completed_at": iso(w.completed_at),
                "score": float(r.score) if r.score is not None else None,
            }
            for r, w in rows[:25]
        ],
    }


def analytics(m: Membership, p: Procedure, params: dict[str, Any]) -> dict[str, Any]:
    """Step fail/flag rates (r596) and numeric answers over time (MP-037), over work orders the member can see."""
    from mpro.workorders.services import visibility_filter

    lo, hi = _range(params)
    q = (
        select(ProcedureAnswer, WorkOrder.number)
        .join(WorkOrder, WorkOrder.id == ProcedureAnswer.work_order_id)
        .where(ProcedureAnswer.procedure_id == p.id, WorkOrder.deleted_at.is_(None), visibility_filter(m))
    )
    if lo:
        q = q.where(ProcedureAnswer.answered_at >= lo)
    if hi:
        q = q.where(ProcedureAnswer.answered_at <= hi)
    rows = db.session.execute(q.order_by(ProcedureAnswer.answered_at)).all()
    labels: dict[str, str] = {}
    for v in db.session.scalars(
        select(ProcedureVersion).where(ProcedureVersion.procedure_id == p.id).order_by(ProcedureVersion.number)
    ).all():
        for f in sch.fields(v.schema or {}):
            labels[f["id"]] = f["label"]
    steps: dict[str, dict[str, Any]] = {}
    series: dict[str, list[dict[str, Any]]] = {}
    for a, number in rows:
        if a.result in ("pass", "flag", "fail"):
            s = steps.setdefault(
                a.field_id,
                {"field_id": a.field_id, "label": labels.get(a.field_id, a.field_id), "pass": 0, "flag": 0, "fail": 0},
            )
            s[a.result] += 1
        if a.value_number is not None:
            series.setdefault(a.field_id, []).append(
                {"at": iso(a.answered_at), "value": float(a.value_number), "work_order": number}
            )
    out_steps = []
    for s in steps.values():
        total = s["pass"] + s["flag"] + s["fail"]
        s["total"] = total
        s["problem_rate"] = round(100 * (s["flag"] + s["fail"]) / total, 1) if total else 0.0
        out_steps.append(s)
    out_steps.sort(key=lambda s: (-s["problem_rate"], -s["total"]))
    scores = db.session.execute(
        select(ProcedureRun.score, ProcedureRun.completed_at)
        .join(WorkOrder, WorkOrder.id == ProcedureRun.work_order_id)
        .where(
            ProcedureRun.procedure_id == p.id,
            ProcedureRun.score.is_not(None),
            ProcedureRun.completed_at.is_not(None),
            WorkOrder.deleted_at.is_(None),
            visibility_filter(m),
        )
        .order_by(ProcedureRun.completed_at)
    ).all()
    return {
        "steps": out_steps,
        "numeric": [{"field_id": k, "label": labels.get(k, k), "points": v[-500:]} for k, v in series.items()],
        "scores": [{"at": iso(t), "score": float(s or 0)} for s, t in scores][-500:],
    }


TYPE_ALIASES = {
    "checkbox": "checkbox",
    "check": "checkbox",
    "text": "text",
    "number": "number",
    "amount": "amount",
    "currency": "amount",
    "multiple choice": "multiple_choice",
    "multiple_choice": "multiple_choice",
    "choice": "multiple_choice",
    "checklist": "checklist",
    "inspection": "inspection",
    "inspection check": "inspection",
    "pass/flag/fail": "inspection",
    "yes/no/n/a": "yes_no_na",
    "yes_no_na": "yes_no_na",
    "yes/no": "yes_no_na",
    "date": "date",
    "file": "file",
    "picture": "file",
    "photo": "file",
    "signature": "signature",
    "meter": "meter_reading",
    "meter reading": "meter_reading",
    "meter_reading": "meter_reading",
    "location check-in": "location_check_in",
    "location_check_in": "location_check_in",
    "heading": "heading",
    "section": "section",
}


def import_csv(data: bytes) -> dict[str, Any]:
    """CSV with columns type, label, options (separated by |), required, description. Returns a schema to review."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "label" not in [h.strip().lower() for h in reader.fieldnames]:
        raise RuleError("The CSV needs a header row with at least a 'label' column (and usually 'type').", 422)
    items: list[dict[str, Any]] = []
    section: dict[str, Any] | None = None
    for n, row in enumerate(reader, start=2):
        r = {str(k).strip().lower(): (v or "").strip() for k, v in row.items() if k}
        if not r.get("label"):
            continue
        t = TYPE_ALIASES.get(r.get("type", "checkbox").lower() or "checkbox")
        if t is None:
            raise RuleError(f"Row {n}: unknown type {r.get('type')!r}.", 422)
        if t == "section":
            section = {"type": "section", "label": r["label"][:512], "items": []}
            items.append(section)
            continue
        item: dict[str, Any] = {"type": t, "label": r["label"][:512]}
        if r.get("description"):
            item["description"] = r["description"]
        if r.get("required", "").lower() in ("1", "yes", "y", "true", "required"):
            item["required"] = True
        if t in ("multiple_choice", "checklist"):
            opts = [o.strip() for o in r.get("options", "").split("|") if o.strip()]
            item["options"] = opts or ["Option 1"]
        if len(items) > 400:
            break
        (section["items"] if section is not None and t != "heading" else items).append(item)
        if t == "heading":
            section = None
    if not items:
        raise RuleError("No fields were found in the CSV.", 422)
    return sch.validate({"items": items})


_BULLET = re.compile(r"^\s*(?:\(?\d{1,3}[.)]|[a-zA-Z][.)]|[-•*▪◦●□☐✓]|\[\s?\])\s+(.{3,})$")


def import_pdf(data: bytes) -> dict[str, Any]:
    """Turn a PDF's numbered or bulleted lines into checkbox / inspection fields; other short lines become headings."""
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise RuleError("This PDF is password-protected. Remove the password and try again.", 422)
        lines: list[str] = []
        for page in reader.pages[:50]:
            lines.extend((page.extract_text() or "").splitlines())
    except RuleError:
        raise
    except PdfReadError as e:
        raise RuleError("This PDF couldn't be read.", 422) from e
    except Exception as e:  # pypdf raises many kinds of errors on damaged or hostile files (#16)
        log.warning("PDF import failed: %s", e.__class__.__name__)
        raise RuleError("This PDF couldn't be read.", 422) from e
    items: list[dict[str, Any]] = []
    inspect_words = re.compile(r"\b(inspect|check|verify|ensure|confirm|examine|test)\b", re.I)
    for raw in lines:
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        mt = _BULLET.match(line)
        if mt:
            label = mt.group(1).strip()[:512]
            items.append({"type": "inspection" if inspect_words.search(label) else "checkbox", "label": label})
        elif 3 <= len(line) <= 80 and (line.isupper() or line.endswith(":")) and not re.search(r"\d{3,}", line):
            items.append({"type": "heading", "label": line.rstrip(":")[:512]})
        if len(items) >= sch.MAX_FIELDS:
            break
    # drop headings with nothing after them
    clean = [
        it
        for i, it in enumerate(items)
        if it["type"] != "heading" or (i + 1 < len(items) and items[i + 1]["type"] != "heading")
    ]
    if not any(it["type"] != "heading" for it in clean):
        raise RuleError("No checklist lines (numbered or bulleted) were found in the PDF.", 422)
    return sch.validate({"items": clean})


# ---- built-in templates (r209) -------------------------------------------------------------------
def builtin_templates() -> list[dict[str, Any]]:
    from mpro.procedures.demo import TEMPLATES

    return [
        {
            "key": k,
            "name": t["name"],
            "description": t.get("description", ""),
            "category": t.get("category", ""),
            "field_count": len(sch.fields(sch.validate(t["schema"]))),
        }
        for k, t in TEMPLATES.items()
    ]


def from_builtin(org: Organization, m: Membership, key: str) -> Procedure:
    from mpro.procedures.demo import TEMPLATES

    t = TEMPLATES.get(key)
    if t is None:
        raise RuleError("That template doesn't exist.", 404)
    return create_procedure(
        org,
        m,
        {
            "name": t["name"],
            "description": t.get("description", ""),
            "category": t.get("category", ""),
            "tags": t.get("tags", []),
            "schema": copy.deepcopy(t["schema"]),
        },
    )


_ = UTC
