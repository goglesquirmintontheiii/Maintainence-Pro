"""Work-order lists: filters (MaintainX "One of / None of / Is empty / Contains"), To Do rules, sorting,
paging, serialization, time in status and the workload view."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Numeric, Select, and_, case, cast, func, not_, or_, select

from mpro.auth.models import User
from mpro.core.files import link_dict, links_for
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.search import like
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team
from mpro.orgs.services import RuleError
from mpro.workorders.models import (
    ACTIVE_STATUSES,
    CLOSED_STATUSES,
    PRIORITY_LABELS,
    PRIORITY_RANK,
    STATUS_LABELS,
    WORK_TYPE_LABELS,
    Category,
    ReadMark,
    StatusChange,
    WorkOrder,
    WorkOrderAssignee,
    WorkOrderCategory,
    WorkOrderLink,
)
from mpro.workorders.services import asset_tasks, can_see, custom_fields, team_ids_of, visibility_clause, wo_settings

FILTER_FIELDS = {
    "status": ("in", "not_in"),
    "priority": ("in", "not_in"),
    "work_type": ("in", "not_in"),
    "assignee": ("in", "not_in", "empty", "not_empty"),
    "team": ("in", "not_in", "empty", "not_empty"),
    "category": ("in", "not_in", "empty", "not_empty"),
    "created_by": ("in", "not_in"),
    "completed_by": ("in", "not_in"),
    "due_at": ("between", "before", "after", "empty", "not_empty", "overdue"),
    "start_at": ("between", "before", "after", "empty", "not_empty"),
    "created_at": ("between", "before", "after"),
    "completed_at": ("between", "before", "after", "empty", "not_empty"),
    "title": ("contains", "not_contains"),
    "description": ("contains", "not_contains", "empty", "not_empty"),
    "approval": ("in",),
    "parent": ("empty", "not_empty", "in"),
    "unread": ("is",),
    "asset": ("in", "not_in", "within", "empty", "not_empty"),
    "location": ("in", "not_in", "within", "empty", "not_empty"),
    "procedure_result": ("in", "not_in"),  # work orders with a procedure step marked fail / flag / pass (r085)
}
CUSTOM_OPS = ("in", "not_in", "empty", "not_empty", "contains", "not_contains", "between", "before", "after")
SORTS = {
    "number": WorkOrder.number,
    "title": func.lower(WorkOrder.title),
    "due_at": WorkOrder.due_at,
    "start_at": WorkOrder.start_at,
    "created_at": WorkOrder.created_at,
    "updated_at": WorkOrder.updated_at,
    "completed_at": WorkOrder.completed_at,
    "status": case(
        {s: i for i, s in enumerate(("open", "in_progress", "on_hold", "done", "canceled"))}, value=WorkOrder.status
    ),
    "priority": case(PRIORITY_RANK, value=WorkOrder.priority),
    "estimated_minutes": WorkOrder.estimated_minutes,
}


def validate_filters(raw: Any) -> list[dict[str, Any]]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > 40:
        raise RuleError("Filters must be a list.", 422)
    out = []
    for f in raw:
        if not isinstance(f, dict):
            raise RuleError("Each filter needs a field and an operator.", 422)
        field, op = str(f.get("field", "")), str(f.get("op", ""))
        ops = CUSTOM_OPS if field.startswith("custom.") else FILTER_FIELDS.get(field)
        if ops is None:
            raise RuleError(f"Can't filter by {field!r}.", 422)
        if op not in ops:
            raise RuleError(f"Can't use {op!r} on {field}.", 422)
        out.append({"field": field, "op": op, "value": f.get("value")})
    return out


def _ids(v: Any) -> list[uuid.UUID]:
    vals = v if isinstance(v, list) else [v]
    out = []
    for x in vals:
        try:
            out.append(uuid.UUID(str(x)))
        except ValueError:
            continue
    return out


def _date_bound(v: Any, end: bool = False) -> datetime | None:
    if v in (None, ""):
        return None
    s = str(v)
    try:
        if len(s) == 10:
            d = datetime.fromisoformat(s).replace(tzinfo=UTC)
            return d + timedelta(days=1) if end else d
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError as e:
        raise RuleError(f"{s!r} isn't a date.", 422) from e


def _date_clause(col: Any, op: str, value: Any) -> Any:
    if op == "empty":
        return col.is_(None)
    if op == "not_empty":
        return col.is_not(None)
    if op == "overdue":
        return and_(col.is_not(None), col < utcnow(), WorkOrder.status.in_(ACTIVE_STATUSES))
    if op == "before":
        return col < _date_bound(value)
    if op == "after":
        return col >= _date_bound(value, end=True)
    lo, hi = (value or [None, None]) if isinstance(value, list) else (None, None)
    conds = []
    if lo:
        conds.append(col >= _date_bound(lo))
    if hi:
        conds.append(col < _date_bound(hi, end=True))
    return and_(*conds) if conds else None


def _apply_filter(q: Select[Any], f: dict[str, Any], m: Membership) -> Select[Any]:
    field, op, value = f["field"], f["op"], f.get("value")
    vals = value if isinstance(value, list) else ([] if value in (None, "") else [value])
    cond: Any = None
    if field in ("status", "priority", "work_type"):
        col = getattr(WorkOrder, field)
        cond = col.in_([str(v) for v in vals]) if op == "in" else col.not_in([str(v) for v in vals])
    elif field in ("assignee", "team"):
        col = WorkOrderAssignee.user_id if field == "assignee" else WorkOrderAssignee.team_id
        base = select(WorkOrderAssignee.work_order_id).where(col.is_not(None))
        if op in ("empty", "not_empty"):
            cond = WorkOrder.id.not_in(base) if op == "empty" else WorkOrder.id.in_(base)
        else:
            ids = _ids([m.user_id if v == "me" else v for v in vals])
            include_none = "none" in vals
            sub: Any = WorkOrder.id.in_(base.where(col.in_(ids or [uuid.uuid4()])))
            if include_none:
                sub = or_(sub, WorkOrder.id.not_in(base))
            cond = sub if op == "in" else not_(sub)
    elif field == "category":
        base = select(WorkOrderCategory.work_order_id)
        if op in ("empty", "not_empty"):
            cond = WorkOrder.id.not_in(base) if op == "empty" else WorkOrder.id.in_(base)
        else:
            sub = WorkOrder.id.in_(base.where(WorkOrderCategory.category_id.in_(_ids(vals) or [uuid.uuid4()])))
            cond = sub if op == "in" else not_(sub)
    elif field in ("created_by", "completed_by"):
        col = WorkOrder.created_by_id if field == "created_by" else WorkOrder.completed_by_id
        ids = _ids([m.user_id if v == "me" else v for v in vals])
        cond = col.in_(ids) if op == "in" else or_(col.is_(None), col.not_in(ids))
    elif field in ("due_at", "start_at", "created_at", "completed_at"):
        cond = _date_clause(getattr(WorkOrder, field), op, value)
    elif field in ("title", "description"):
        col = func.lower(getattr(WorkOrder, field))
        if op == "empty":
            cond = WorkOrder.description == ""
        elif op == "not_empty":
            cond = WorkOrder.description != ""
        else:
            c = col.like(like(str(value or "")), escape="\\")
            cond = c if op == "contains" else not_(c)
    elif field == "approval":
        cond = WorkOrder.approval_status.in_([str(v) for v in vals])
    elif field == "parent":
        if op == "empty":
            cond = WorkOrder.parent_id.is_(None)
        elif op == "not_empty":
            cond = WorkOrder.parent_id.is_not(None)
        else:
            cond = WorkOrder.parent_id.in_(_ids(vals))
    elif field in ("asset", "location"):
        from mpro.core.hierarchy import TreePath

        col = WorkOrder.asset_id if field == "asset" else WorkOrder.location_id
        ids = _ids(vals)
        if op == "empty":
            cond = col.is_(None)
        elif op == "not_empty":
            cond = col.is_not(None)
        elif op == "within":  # the record and everything under it
            cond = col.in_(
                select(TreePath.descendant_id).where(
                    TreePath.kind == field, TreePath.ancestor_id.in_(ids or [uuid.uuid4()])
                )
            )
        else:
            cond = col.in_(ids) if op == "in" else or_(col.is_(None), col.not_in(ids))
    elif field == "procedure_result":
        from mpro.procedures.models import ProcedureAnswer

        results = [str(v) for v in vals if str(v) in ("fail", "flag", "pass")] or ["fail", "flag"]
        sub = select(ProcedureAnswer.work_order_id).where(ProcedureAnswer.result.in_(results))
        cond = WorkOrder.id.not_in(sub) if op == "not_in" else WorkOrder.id.in_(sub)
    elif field == "unread":
        read = select(ReadMark.entity_id).where(
            ReadMark.user_id == m.user_id, ReadMark.read_at >= WorkOrder.activity_at
        )
        cond = WorkOrder.id.not_in(read) if value else WorkOrder.id.in_(read)
    elif field.startswith("custom."):
        from mpro.workorders.models import CustomField

        cf = db.session.scalars(
            select(CustomField).where(CustomField.org_id == m.org_id, CustomField.id == _ids([field[7:]])[0])
        ).first() if _ids([field[7:]]) else None  # fmt: skip
        cond = _custom_clause(field[7:], op, value, vals, cf.type if cf else "text") if cf else None
    return q.where(cond) if cond is not None else q


def _custom_clause(fid: str, op: str, value: Any, vals: list[Any], ftype: str) -> Any:
    """Custom-field filters, typed by the field so numbers, checkboxes and dates compare correctly on
    PostgreSQL and SQLite alike (JSON path access via SQLAlchemy)."""
    node = WorkOrder.custom[fid]
    col = node.as_string()
    if op == "empty":
        return or_(col.is_(None), col == "")
    if op == "not_empty":
        return and_(col.is_not(None), col != "")
    if ftype == "checkbox":
        want = [str(v).lower() in ("true", "1", "yes") for v in vals]
        b = node.as_boolean()
        conds = [b.is_(True) if w else or_(b.is_(None), b.is_(False)) for w in set(want)]
        cond = or_(*conds) if conds else None
        return cond if op == "in" or cond is None else not_(cond)
    if ftype in ("number", "currency"):
        # currency values are exact decimal strings ("1250.00", MP-108); numbers are JSON numbers
        num = node.as_float() if ftype == "number" else cast(col, Numeric(18, 2))

        def f(x: Any) -> float | None:
            try:
                return float(x)
            except (TypeError, ValueError):
                return None

        if op in ("between", "before", "after"):
            lo, hi = (value or [None, None]) if isinstance(value, list) else (value, value)
            conds = []
            if op in ("between", "after") and f(lo) is not None:
                conds.append(num >= f(lo))
            if op in ("between", "before") and f(hi) is not None:
                conds.append(num <= f(hi))
            return and_(*conds) if conds else None
        nums = [x for x in (f(v) for v in vals) if x is not None]
        return num.in_(nums) if op == "in" else or_(num.is_(None), num.not_in(nums))
    if op in ("contains", "not_contains"):
        c = func.lower(col).like(like(str(value or "")), escape="\\")
        return c if op == "contains" else or_(col.is_(None), not_(c))
    if op in ("between", "before", "after"):  # dates (ISO strings sort correctly) and text
        lo, hi = (value or [None, None]) if isinstance(value, list) else (value, value)
        conds = []
        if op in ("between", "after") and lo not in (None, ""):
            conds.append(col >= str(lo))
        if op == "between" and hi not in (None, ""):
            conds.append(col <= str(hi) + "\uffff")
        if op == "before" and hi not in (None, ""):
            conds.append(col < str(hi))
        return and_(*conds) if conds else None
    strs = [str(v) for v in vals]
    return col.in_(strs) if op == "in" else or_(col.is_(None), col.not_in(strs))


def base_query(m: Membership, include_deleted: bool = False) -> Select[Any]:
    q = select(WorkOrder).where(WorkOrder.org_id == m.org_id)
    if not include_deleted:
        q = q.where(WorkOrder.deleted_at.is_(None))
    vis = visibility_clause(m)
    if vis is not None:
        q = q.where(vis)
    return q


def todo_clause(org_id: uuid.UUID) -> Any:
    """To Do = active work whose start date has come. When "To Do by start date only" is off, work that is
    due within a day or overdue shows up too, even if its start date is later (MaintainX r027 / r084)."""
    now = utcnow()
    started = or_(WorkOrder.start_at.is_(None), WorkOrder.start_at <= now)
    if not wo_settings(org_id)["todo_by_start_date_only"]:
        started = or_(started, and_(WorkOrder.due_at.is_not(None), WorkOrder.due_at <= now + timedelta(days=1)))
    return and_(WorkOrder.status.in_(ACTIVE_STATUSES), started)


def build_query(m: Membership, params: dict[str, Any]) -> Select[Any]:
    include_deleted = str(params.get("include_deleted", "")).lower() in ("1", "true", "yes")
    q = base_query(m, include_deleted=include_deleted)
    if include_deleted and str(params.get("only_deleted", "")).lower() in ("1", "true"):
        q = q.where(WorkOrder.deleted_at.is_not(None))
    tab = params.get("tab") or "all"
    if tab == "todo":
        upcoming = str(params.get("upcoming", "")).lower() in ("1", "true", "yes")
        q = q.where(WorkOrder.status.in_(ACTIVE_STATUSES) if upcoming else todo_clause(m.org_id))
    elif tab == "done":
        q = q.where(WorkOrder.status.in_(CLOSED_STATUSES))
    elif tab == "upcoming":
        q = q.where(WorkOrder.status.in_(ACTIVE_STATUSES), not_(todo_clause(m.org_id)))
    scope = params.get("scope") or "all"
    if scope == "assigned_me":
        q = q.where(
            WorkOrder.id.in_(select(WorkOrderAssignee.work_order_id).where(WorkOrderAssignee.user_id == m.user_id))
        )
    elif scope == "my_teams":
        teams = team_ids_of(m.org_id, m.user_id)
        q = q.where(
            WorkOrder.id.in_(
                select(WorkOrderAssignee.work_order_id).where(WorkOrderAssignee.team_id.in_(teams or [uuid.uuid4()]))
            )
        )
    elif scope == "created_me":
        q = q.where(WorkOrder.created_by_id == m.user_id)
    text = str(params.get("q") or "").strip()
    if text:
        num = text.lstrip("#")
        cond = or_(
            func.lower(WorkOrder.title).like(like(text), escape="\\"),
            func.lower(WorkOrder.description).like(like(text), escape="\\"),
        )
        if num.isdigit():
            cond = or_(cond, WorkOrder.number == int(num))
        q = q.where(cond)
    for f in validate_filters(params.get("filters")):
        q = _apply_filter(q, f, m)
    return q


def apply_sort(q: Select[Any], sort: str | None) -> Select[Any]:
    sort = sort or "-priority"
    keys: list[Any] = []
    for part in sort.split(","):
        part = part.strip()
        desc = part.startswith("-")
        name = part.lstrip("-")
        col = SORTS.get(name)
        if col is None:
            raise RuleError(f"Can't sort by {name!r}.", 422)
        if name in ("due_at", "start_at", "completed_at", "estimated_minutes"):
            keys.append(case((col.is_(None), 1), else_=0))  # empty dates last either way
        keys.append(col.desc() if desc else col.asc())
    if not any(p.strip().lstrip("-") == "due_at" for p in sort.split(",")):
        keys += [case((WorkOrder.due_at.is_(None), 1), else_=0), WorkOrder.due_at.asc()]
    keys.append(WorkOrder.number.desc())
    return q.order_by(*keys)


# ---- serialization ---------------------------------------------------------------------------
def _person(u: User | None) -> dict[str, Any] | None:
    from mpro.orgs.services import avatar_url

    return {"id": str(u.id), "name": u.name, "initials": u.initials, "avatar_url": avatar_url(u)} if u else None


def assignees_list(wo: WorkOrder) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in wo.assignees:
        if a.user is not None:
            out.append({**(_person(a.user) or {}), "type": "user"})
        elif a.team is not None:
            out.append({"type": "team", "id": str(a.team.id), "name": a.team.name, "color": a.team.color})
    out.sort(key=lambda x: (x["type"] != "user", x["name"].lower()))
    return out


def read_map(m: Membership, ids: list[uuid.UUID]) -> dict[uuid.UUID, datetime]:
    if not ids:
        return {}
    rows = db.session.execute(
        select(ReadMark.entity_id, ReadMark.read_at).where(ReadMark.user_id == m.user_id, ReadMark.entity_id.in_(ids))
    ).all()
    return {r[0]: r[1] for r in rows}


def summary_dict(wo: WorkOrder, read_at: datetime | None = None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    now = utcnow()
    d = {
        "id": str(wo.id),
        "number": wo.number,
        "title": wo.title,
        "status": wo.status,
        "status_label": STATUS_LABELS[wo.status],
        "sub_status": wo.sub_status,
        "priority": wo.priority,
        "priority_label": PRIORITY_LABELS[wo.priority],
        "work_type": wo.work_type,
        "start_at": iso(wo.start_at),
        "due_at": iso(wo.due_at),
        "overdue": bool(wo.due_at and wo.due_at < now and wo.status in ACTIVE_STATUSES),
        "estimated_minutes": wo.estimated_minutes,
        "assignees": assignees_list(wo),
        "categories": [
            {"id": str(c.category.id), "name": c.category.name, "color": c.category.color}
            for c in wo.category_links
            if c.category.deleted_at is None
        ],
        "parent_id": str(wo.parent_id) if wo.parent_id else None,
        "created_by": _person(wo.created_by),
        "created_at": iso(wo.created_at),
        "updated_at": iso(wo.updated_at),
        "completed_at": iso(wo.completed_at),
        "approval_status": wo.approval_status,
        "custom": wo.custom or {},
        "asset": {"id": str(wo.asset.id), "name": wo.asset.name, "status": wo.asset.status}
        if wo.asset is not None and wo.asset.deleted_at is None
        else None,
        "location": {"id": str(wo.location.id), "name": wo.location.name}
        if wo.location is not None and wo.location.deleted_at is None
        else None,
        "source_type": wo.source_type,
        "unread": read_at is None or read_at < wo.activity_at,
        "deleted": wo.deleted_at is not None,
        "version": wo.version,
    }
    if extra:
        d.update(extra)
    return d


def list_page(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    from mpro.workorders.activity import counts_for

    q = build_query(m, params)
    total = db.session.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    try:
        per_page = max(1, min(int(params.get("per_page") or 50), 500))
        page = max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("page and per_page must be numbers.", 422) from e
    rows = db.session.scalars(apply_sort(q, params.get("sort")).limit(per_page).offset((page - 1) * per_page)).all()
    ids = [w.id for w in rows]
    reads = read_map(m, ids)
    comments = counts_for(ids)
    sub_counts = _sub_counts(ids)
    from mpro.workorders.cover import cover_map

    covers = cover_map(list(rows))
    parents = _parent_map(list(rows))  # sub-work orders show their parent's name in the Table (MP-118)
    return {
        "items": [
            summary_dict(
                w,
                reads.get(w.id),
                {"comment_count": comments.get(w.id, 0), "sub_work_orders": sub_counts.get(w.id),
                 "cover_url": covers.get(w.id),
                 "parent": parents.get(w.parent_id) if w.parent_id else None},  # fmt: skip
            )
            for w in rows
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def _parent_map(rows: list[WorkOrder]) -> dict[uuid.UUID, dict[str, Any]]:
    pids = {w.parent_id for w in rows if w.parent_id}
    if not pids:
        return {}
    got = db.session.execute(
        select(WorkOrder.id, WorkOrder.number, WorkOrder.title).where(WorkOrder.id.in_(pids))
    ).all()
    return {i: {"id": str(i), "number": n, "title": t} for i, n, t in got}


def _sub_counts(ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, int]]:
    if not ids:
        return {}
    rows = db.session.execute(
        select(
            WorkOrder.parent_id,
            func.count(),
            func.sum(case((WorkOrder.status.in_(CLOSED_STATUSES), 1), else_=0)),
        )
        .where(WorkOrder.parent_id.in_(ids), WorkOrder.deleted_at.is_(None))
        .group_by(WorkOrder.parent_id)
    ).all()
    return {r[0]: {"total": int(r[1]), "closed": int(r[2] or 0)} for r in rows}


def time_in_status(wo: WorkOrder) -> dict[str, int]:
    """Seconds spent in each status, from the status history (MaintainX r057)."""
    changes = db.session.scalars(
        select(StatusChange).where(StatusChange.work_order_id == wo.id).order_by(StatusChange.at, StatusChange.id)
    ).all()
    totals = {s: 0 for s in ("open", "in_progress", "on_hold")}
    for i, c in enumerate(changes):
        end = changes[i + 1].at if i + 1 < len(changes) else (utcnow() if wo.status in ACTIVE_STATUSES else c.at)
        if c.to_status in totals:
            totals[c.to_status] += max(0, int((end - c.at).total_seconds()))
    return totals


def detail_dict(m: Membership, wo: WorkOrder) -> dict[str, Any]:
    from mpro.workorders.activity import attachments_for, costs_summary
    from mpro.workorders.cover import cover_info

    reads = read_map(m, [wo.id])
    d = summary_dict(wo, reads.get(wo.id), cover_info(wo))
    s = wo_settings(m.org_id)
    children = db.session.scalars(
        select(WorkOrder).where(WorkOrder.parent_id == wo.id, WorkOrder.deleted_at.is_(None)).order_by(WorkOrder.number)
    ).all()
    children = [c for c in children if can_see(m, c)]  # limited-visibility users only see what they may open
    parent = db.session.get(WorkOrder, wo.parent_id) if wo.parent_id else None
    if parent is not None and not can_see(m, parent):
        parent = None
    links = db.session.scalars(
        select(WorkOrderLink).where(or_(WorkOrderLink.from_id == wo.id, WorkOrderLink.to_id == wo.id))
    ).all()
    other_ids = [lk.to_id if lk.from_id == wo.id else lk.from_id for lk in links]
    others = {w.id: w for w in db.session.scalars(select(WorkOrder).where(WorkOrder.id.in_(other_ids))).all()}
    link_items = []
    for lk in links:
        oid = lk.to_id if lk.from_id == wo.id else lk.from_id
        o = others.get(oid)
        if o is None or o.deleted_at is not None or not can_see(m, o):
            continue
        rel = "related" if lk.kind == "related" else ("blocks" if lk.from_id == wo.id else "blocked_by")
        link_items.append({"id": str(lk.id), "relation": rel, "work_order": _mini(o)})
    sig = [x for x in links_for("work_order", wo.id, {"signature"}) if x.file_id == wo.signature_file_id]
    d.update(
        {
            "description": wo.description,
            "completed_by": _person(wo.completed_by),
            "completion_summary": wo.completion_summary,
            "cancel_reason": wo.cancel_reason,
            "signature": {"file": link_dict(sig[-1]), "name": wo.signed_by_name, "signed_at": iso(wo.signed_at)}
            if sig
            else None,
            "approved_by": _person(wo.approved_by),
            "approved_at": iso(wo.approved_at),
            "status_changed_at": iso(wo.status_changed_at),
            "parent": _mini(parent) if parent and parent.deleted_at is None else None,
            "sub_work_orders": [_mini(c) for c in children],
            "links": link_items,
            "attachments": [
                a for a in attachments_for(wo) if a["role"] not in ("signature", "procedure", "procedure_signature")
            ],
            "time_in_status": time_in_status(wo),
            "costs": costs_summary(m, wo),
            "sub_statuses": s["sub_statuses"],
            "asset_tasks": asset_tasks(wo),
            "recurrence": _recurrence(wo),
            "procedures": _procedure_runs(m, wo),
        }
    )
    return d


def _procedure_runs(m: Membership, wo: WorkOrder) -> list[dict[str, Any]]:
    from mpro.procedures.services import runs_for

    return runs_for(m, wo)


def _mini(wo: WorkOrder) -> dict[str, Any]:
    return {
        "id": str(wo.id),
        "number": wo.number,
        "title": wo.title,
        "status": wo.status,
        "priority": wo.priority,
        "due_at": iso(wo.due_at),
        "assignees": assignees_list(wo),
    }


# ---- workload --------------------------------------------------------------------------------
def workload(
    m: Membership,
    org: Organization,
    start: date,
    days: int,
    team_id: uuid.UUID | None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Scheduled hours per person per day (MaintainX Workload view). Work counts on its due date, using
    its estimated time. Team-only assignments show in their own row so they can be handed to a person."""
    days = max(1, min(days, 42))
    tz = ZoneInfo(org.timezone or "UTC")
    lo = datetime.combine(start, datetime.min.time(), tz).astimezone(UTC)
    hi = lo + timedelta(days=days)
    # the search box and filter chips apply here too (0.3.0 review of the Workload view)
    q = (
        build_query(m, {"tab": "all", "q": (params or {}).get("q"), "filters": (params or {}).get("filters")})
        .where(WorkOrder.status.in_(ACTIVE_STATUSES), WorkOrder.due_at.is_not(None))
        .where(WorkOrder.due_at >= lo, WorkOrder.due_at < hi)
    )
    wos = db.session.scalars(q.order_by(WorkOrder.due_at)).all()
    members = db.session.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(
            Membership.org_id == org.id,
            Membership.deleted_at.is_(None),
            User.deleted_at.is_(None),
            Membership.role.in_(("owner", "admin", "limited_admin", "technician", "operator", "custom")),
        )
        .order_by(func.lower(User.name))
    ).all()
    team_members: set[uuid.UUID] | None = None
    if team_id:
        from mpro.orgs.models import TeamMember

        team_members = set(db.session.scalars(select(TeamMember.user_id).where(TeamMember.team_id == team_id)).all())
    people = [
        {"id": str(u.id), "name": u.name, "initials": u.initials, "job_title": mm.job_title}
        for mm, u in members
        if team_members is None or u.id in team_members
    ]
    pid = {p["id"] for p in people}
    cells: dict[str, dict[str, dict[str, Any]]] = {}
    team_rows: dict[str, dict[str, Any]] = {}
    for w in wos:
        assert w.due_at is not None
        day = w.due_at.astimezone(tz).date().isoformat()
        item = {
            "id": str(w.id),
            "number": w.number,
            "title": w.title,
            "priority": w.priority,
            "minutes": w.estimated_minutes or 0,
        }
        users = [str(a.user_id) for a in w.assignees if a.user_id]
        teams = [a.team for a in w.assignees if a.team_id and a.team is not None]
        targets = [u for u in users if u in pid]
        if not users and teams:
            for t in teams:
                if team_id and t.id != team_id:
                    continue
                row = team_rows.setdefault(str(t.id), {"id": str(t.id), "name": t.name, "color": t.color, "days": {}})
                cell = row["days"].setdefault(day, {"minutes": 0, "items": []})
                cell["minutes"] += item["minutes"]
                cell["items"].append(item)
        if not users and not teams:
            row = team_rows.setdefault("none", {"id": "none", "name": "Unassigned", "color": "#8a94a8", "days": {}})
            cell = row["days"].setdefault(day, {"minutes": 0, "items": []})
            cell["minutes"] += item["minutes"]
            cell["items"].append(item)
        for u in targets:
            cell = cells.setdefault(u, {}).setdefault(day, {"minutes": 0, "items": []})
            cell["minutes"] += item["minutes"]
            cell["items"].append(item)
    return {
        "start": start.isoformat(),
        "days": [(start + timedelta(days=i)).isoformat() for i in range(days)],
        "capacity_minutes": wo_settings(org.id)["workday_minutes"],
        "people": people,
        "totals": {u: sum(c["minutes"] for c in d.values()) for u, d in cells.items()},
        "cells": cells,
        "unassigned": list(team_rows.values()),
    }


def stats(m: Membership) -> dict[str, int]:
    """Numbers for the Overview tiles."""
    q = base_query(m)
    now = utcnow()

    def count(*conds: Any) -> int:
        return int(db.session.scalar(select(func.count()).select_from(q.where(*conds).order_by(None).subquery())) or 0)

    mine = WorkOrder.id.in_(select(WorkOrderAssignee.work_order_id).where(WorkOrderAssignee.user_id == m.user_id))
    return {
        "open": count(WorkOrder.status.in_(ACTIVE_STATUSES)),
        "overdue": count(WorkOrder.status.in_(ACTIVE_STATUSES), WorkOrder.due_at < now),
        "high_priority": count(WorkOrder.status.in_(ACTIVE_STATUSES), WorkOrder.priority == "high"),
        "due_today": count(
            WorkOrder.status.in_(ACTIVE_STATUSES),
            WorkOrder.due_at >= now - timedelta(hours=12),
            WorkOrder.due_at < now + timedelta(hours=12),
        ),
        "completed_7d": count(WorkOrder.status == "done", WorkOrder.completed_at >= now - timedelta(days=7)),
        "assigned_to_me": count(WorkOrder.status.in_(ACTIVE_STATUSES), mine),
        "awaiting_approval": count(WorkOrder.approval_status == "pending"),
    }


def filter_options(m: Membership) -> dict[str, Any]:
    """Everything the filter bar needs in one call."""
    cats = db.session.scalars(
        select(Category)
        .where(Category.org_id == m.org_id, Category.deleted_at.is_(None))
        .order_by(func.lower(Category.name))
    ).all()
    teams = db.session.scalars(
        select(Team).where(Team.org_id == m.org_id, Team.deleted_at.is_(None)).order_by(func.lower(Team.name))
    ).all()
    from mpro.orgs.services import members_query

    ms = db.session.scalars(members_query(m.org_id).order_by(func.lower(User.name))).all()
    return {
        "statuses": [{"id": k, "label": v} for k, v in STATUS_LABELS.items()],
        "priorities": [{"id": k, "label": v} for k, v in PRIORITY_LABELS.items()],
        "work_types": [{"id": k, "label": v} for k, v in WORK_TYPE_LABELS.items()],
        "categories": [{"id": str(c.id), "name": c.name, "color": c.color} for c in cats],
        "teams": [{"id": str(t.id), "name": t.name, "color": t.color} for t in teams],
        "people": [
            {
                "id": str(x.user_id),
                "name": x.user.name,
                "initials": x.user.initials,
                "avatar_url": (_person(x.user) or {}).get("avatar_url"),
                "role": x.role,
                "assignable": x.role not in ("requester", "viewer"),
            }
            for x in ms
        ],
        "custom_fields": [
            {"id": str(f.id), "name": f.name, "type": f.type, "options": f.options or [], "required": f.required}
            for f in custom_fields(m.org_id)
        ],
        "assets": _tree_options(m, "asset") if can(m, "assets.view") else [],
        "locations": _tree_options(m, "location") if can(m, "locations.view") else [],
    }


def _tree_options(m: Membership, kind: str) -> list[dict[str, Any]]:
    """Assets or locations for filter pickers, with their parent path (up to 2,000)."""
    from mpro.assets.models import Asset, Location
    from mpro.assets.queries import paths_for

    model: Any = Asset if kind == "asset" else Location
    rows = db.session.execute(
        select(model.id, model.name)
        .where(model.org_id == m.org_id, model.deleted_at.is_(None))
        .order_by(func.lower(model.name))
        .limit(2000)
    ).all()
    paths = paths_for(kind, model, [r[0] for r in rows])
    return [{"id": str(i), "name": n, "path": " › ".join(p["name"] for p in paths.get(i, []))} for i, n in rows]


def _recurrence(wo: WorkOrder) -> dict[str, Any] | None:
    """How a repeating or planned work order repeats (MP-032), e.g. "Every 2 weeks on Mon, Thu"."""
    from mpro.pm.services import recurrence_summary

    return recurrence_summary(wo)
