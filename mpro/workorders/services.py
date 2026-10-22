"""Work-order business rules (guideline G-04: logic lives in services, API views stay thin).

Covers create / edit / delete, statuses and completion (signature, approval, summary), numbering,
optimistic concurrency, assignees, categories, custom fields, sub-work orders, templates, settings,
saved views, bulk edits and read state. Comments, time, costs and files live in `activity.py`;
list filters, serialization and the workload view live in `queries.py`.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, update

from mpro.core.events import emit
from mpro.core.files import FileObject, attach, save_file
from mpro.core.ids import uuid7
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import RuleError, members_query
from mpro.workorders.models import (
    FIELD_TYPES,
    LINK_KINDS,
    PRIORITIES,
    PRIORITY_LABELS,
    STATUS_LABELS,
    STATUSES,
    WORK_TYPES,
    Category,
    CostEntry,
    Counter,
    CustomField,
    ReadMark,
    SavedView,
    StatusChange,
    Template,
    TimeEntry,
    WorkOrder,
    WorkOrderAssetTask,
    WorkOrderAssignee,
    WorkOrderCategory,
    WorkOrderLink,
)

COMMENT_RULES = ("none", "optional", "mandatory")
REQUIRABLE = ("description", "due_date", "priority", "categories", "assignees", "attachment", "estimated_time")
REQUIRABLE_LABELS = {
    "description": "Description",
    "due_date": "Due date",
    "priority": "Priority",
    "categories": "Categories",
    "assignees": "Assignees",
    "attachment": "A picture or file",
    "estimated_time": "Estimated time",
}

WO_SETTINGS: dict[str, Any] = {
    "required_fields": [],  # subset of REQUIRABLE (MaintainX "Required default fields")
    "require_time_to_complete": False,
    "require_cost_to_complete": False,
    "require_signature": False,
    "require_approval": False,
    "completion_summary": "none",  # none | optional | mandatory
    "comment_on_hold": "optional",  # none | optional | mandatory
    "comment_on_cancel": "optional",
    "mention_assigns": False,
    "todo_by_start_date_only": False,
    "time_types": ["Inspection", "Work", "Other"],
    "cost_types": ["Labor", "Travel", "Other"],
    "default_hourly_rate_cents": 0,
    "rates_visible_to_all": False,
    "sub_statuses": {"open": [], "on_hold": ["Waiting on parts", "Waiting on vendor"], "in_progress": [], "done": []},
    "default_start_time": "00:00",
    "default_due_time": "12:00",
    "workday_minutes": 480,
    "categories_seeded": False,
}
register_defaults("work_orders", WO_SETTINGS)

DEFAULT_CATEGORIES = [
    ("Damage", "#c4302b"),
    ("Electrical", "#b8560b"),
    ("Inspection", "#0a7f96"),
    ("Mechanical", "#1b5bd4"),
    ("Preventive", "#13805a"),
    ("Project", "#7a52c9"),
    ("Refrigeration", "#3d6fb6"),
    ("Safety", "#c37a06"),
    ("Standard Operating Procedure", "#5d6880"),
]

MENTION_RE = re.compile(r"@\[([^\]]{1,200})\]\((user|team):([0-9a-fA-F-]{36})\)")


class Conflict(RuleError):
    """Raised when a save started from an older version of the record (HTTP 409 with the current record)."""

    def __init__(self, wo: WorkOrder) -> None:
        super().__init__("Someone else changed this work order. Review their changes and try again.", 409)
        self.wo = wo


# ---- small helpers ---------------------------------------------------------------------------
def wo_settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "work_orders")


def label(wo: WorkOrder) -> str:
    return f"#{wo.number} {wo.title}"


def _uuid(v: Any, what: str = "record") -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _dt(v: Any, field: str) -> datetime | None:
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        dt = v
    else:
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError as e:
            raise RuleError(f"{field} must be a date and time.", 422) from e
    if dt.tzinfo is None:
        raise RuleError(f"{field} needs a time zone (send ISO 8601 with Z or an offset).", 422)
    return dt


def touch(wo: WorkOrder, actor_id: uuid.UUID | None) -> None:
    """New activity: others see the work order as unread; the actor has read it."""
    wo.activity_at = utcnow()
    if actor_id:
        mark_read(wo, actor_id)


def mark_read(wo: WorkOrder, user_id: uuid.UUID) -> None:
    rm = db.session.scalars(select(ReadMark).where(ReadMark.entity_id == wo.id, ReadMark.user_id == user_id)).first()
    if rm is None:
        db.session.add(ReadMark(org_id=wo.org_id, entity_id=wo.id, user_id=user_id, read_at=utcnow()))
    else:
        rm.read_at = utcnow()


# ---- visibility ------------------------------------------------------------------------------
def team_ids_of(org_id: uuid.UUID, user_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        db.session.scalars(
            select(TeamMember.team_id)
            .join(Team, Team.id == TeamMember.team_id)
            .where(TeamMember.org_id == org_id, TeamMember.user_id == user_id, Team.deleted_at.is_(None))
        ).all()
    )


def visibility_clause(m: Membership) -> Any:
    """SQL condition for work orders this member may see (None = everything)."""
    if m.wo_visibility != "limited" or m.role in ("admin", "limited_admin"):
        return None
    teams = team_ids_of(m.org_id, m.user_id)
    assigned = select(WorkOrderAssignee.work_order_id).where(
        (WorkOrderAssignee.user_id == m.user_id) | (WorkOrderAssignee.team_id.in_(teams or [uuid.uuid4()]))
    )
    return (WorkOrder.created_by_id == m.user_id) | WorkOrder.id.in_(assigned)


def visibility_filter(m: Membership) -> Any:
    """Like visibility_clause, but always usable in .where() (true when the member sees everything)."""
    from sqlalchemy import true

    clause = visibility_clause(m)
    return true() if clause is None else clause


def can_see(m: Membership | None, wo: WorkOrder) -> bool:
    if m is None or not can(m, "wo.view", wo):
        return False
    if m.wo_visibility != "limited" or m.role in ("admin", "limited_admin"):
        return True
    if wo.created_by_id == m.user_id:
        return True
    teams = set(team_ids_of(m.org_id, m.user_id))
    return any(a.user_id == m.user_id or (a.team_id in teams) for a in wo.assignees)


# ---- numbering -------------------------------------------------------------------------------
def _counter(org_id: uuid.UUID, key: str, lock: bool = True) -> Counter:
    q = select(Counter).where(Counter.org_id == org_id, Counter.key == key)
    if lock and db.engine.dialect.name == "postgresql":
        q = q.with_for_update()
    c = db.session.scalars(q).first()
    if c is None:
        from sqlalchemy.exc import IntegrityError

        current_max = db.session.scalar(select(func.max(WorkOrder.number)).where(WorkOrder.org_id == org_id)) or 0
        try:
            with db.session.begin_nested():  # two first work orders at once: one creates the row, the other reuses it
                db.session.add(Counter(org_id=org_id, key=key, value=int(current_max)))
        except IntegrityError:
            pass
        c = db.session.scalars(q).first()
        assert c is not None
    return c


def next_number(org_id: uuid.UUID) -> int:
    """Hand out the next work-order number. Row-locked on PostgreSQL; SQLite serializes writers."""
    c = _counter(org_id, "work_order")
    res = db.session.execute(
        update(Counter).where(Counter.id == c.id).values(value=Counter.value + 1).returning(Counter.value)
    )
    return int(res.scalar_one())


def peek_next_number(org_id: uuid.UUID) -> int:
    c = db.session.scalars(select(Counter).where(Counter.org_id == org_id, Counter.key == "work_order")).first()
    if c is not None:
        return int(c.value) + 1
    return int(db.session.scalar(select(func.max(WorkOrder.number)).where(WorkOrder.org_id == org_id)) or 0) + 1


def set_next_number(org: Organization, n: int) -> int:
    """MaintainX "Next Work Order ID": org-wide, irreversible, must be above every existing number."""
    current = peek_next_number(org.id)
    if n < current:
        raise RuleError(f"The next number must be at least {current}.", 422)
    if n > 10**12:
        raise RuleError("That number is too large.", 422)
    c = _counter(org.id, "work_order")
    c.value = n - 1
    emit(
        "wo.numbering_changed",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary=f"Set the next work order number to #{n}",
        changes={"next_number": (current, n)},
        org_id=org.id,
    )
    db.session.commit()
    return n


# ---- categories ------------------------------------------------------------------------------
def ensure_default_categories(org_id: uuid.UUID) -> None:
    s = wo_settings(org_id)
    if s["categories_seeded"]:
        return
    have = db.session.scalar(select(func.count()).select_from(Category).where(Category.org_id == org_id)) or 0
    if not have:
        for name, color in DEFAULT_CATEGORIES:
            db.session.add(Category(org_id=org_id, name=name, color=color, is_default=True))
    save_settings(org_id, "work_orders", {"categories_seeded": True})
    db.session.commit()


def category_dict(c: Category, usage: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(c.id), "name": c.name, "color": c.color, "description": c.description}
    if usage is not None:
        out["work_order_count"] = usage
    return out


def _check_category_name(org_id: uuid.UUID, name: str, exclude: uuid.UUID | None = None) -> str:
    name = name.strip()
    if not name:
        raise RuleError("The category needs a name.", 422)
    q = select(Category.id).where(
        Category.org_id == org_id, Category.deleted_at.is_(None), func.lower(Category.name) == name.lower()
    )
    if exclude:
        q = q.where(Category.id != exclude)
    if db.session.scalar(q):
        raise RuleError(f"There's already a category called {name}.", 409)
    return name[:80]


def _check_color(color: str) -> str:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise RuleError("Use a colour like #1b5bd4.", 422)
    return color


def create_category(org: Organization, name: str, color: str = "#5d6880", description: str = "") -> Category:
    c = Category(
        org_id=org.id,
        name=_check_category_name(org.id, name),
        color=_check_color(color),
        description=description.strip()[:500],
    )
    db.session.add(c)
    db.session.flush()
    emit(
        "category.created",
        entity_type="category",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Created category {c.name}",
    )
    db.session.commit()
    return c


def update_category(org: Organization, c: Category, data: dict[str, Any]) -> Category:
    before = {"name": c.name, "color": c.color, "description": c.description}
    if "name" in data:
        c.name = _check_category_name(org.id, str(data["name"]), exclude=c.id)
    if "color" in data:
        c.color = _check_color(str(data["color"]))
    if "description" in data:
        c.description = str(data["description"]).strip()[:500]
    after = {"name": c.name, "color": c.color, "description": c.description}
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes:
        emit(
            "category.updated",
            entity_type="category",
            entity_id=c.id,
            entity_label=c.name,
            summary="Changed " + ", ".join(changes),
            changes=changes,
        )
    db.session.commit()
    return c


def delete_category(org: Organization, c: Category) -> None:
    c.deleted_at = utcnow()
    emit(
        "category.deleted",
        entity_type="category",
        entity_id=c.id,
        entity_label=c.name,
        summary=f"Deleted category {c.name}",
    )
    db.session.commit()


# ---- assignees, categories and custom fields on a work order ---------------------------------
def _resolve_assignees(org_id: uuid.UUID, items: list[Any]) -> list[tuple[str, uuid.UUID]]:
    out: list[tuple[str, uuid.UUID]] = []
    for it in items or []:
        if isinstance(it, str):  # "user:<id>" / "team:<id>" shorthand
            kind, _, ident = it.partition(":")
        else:
            kind, ident = str(it.get("type", "")), str(it.get("id", ""))
        if kind not in ("user", "team"):
            raise RuleError("Assignees must be people or teams.", 422)
        uid = _uuid(ident, kind)
        if kind == "user":
            ok = db.session.scalar(
                members_query(org_id).with_only_columns(Membership.id).where(Membership.user_id == uid)
            )
            if not ok:
                raise RuleError("One of the assignees isn't in this organization.", 422)
            role = db.session.scalar(
                select(Membership.role).where(Membership.org_id == org_id, Membership.user_id == uid)
            )
            if role in ("requester", "viewer"):
                raise RuleError("Requesters and view-only users can't be assigned work orders.", 422)
        else:
            ok = db.session.scalar(
                select(Team.id).where(Team.org_id == org_id, Team.id == uid, Team.deleted_at.is_(None))
            )
            if not ok:
                raise RuleError("One of the teams doesn't exist.", 422)
        if (kind, uid) not in out:
            out.append((kind, uid))
    return out


def _set_assignees(wo: WorkOrder, pairs: list[tuple[str, uuid.UUID]]) -> tuple[list[str], list[str]]:
    """Replace assignees. Returns (added, removed) as 'user:<id>' strings."""
    have = {("user", a.user_id) if a.user_id else ("team", a.team_id): a for a in wo.assignees}
    want = set(pairs)
    added, removed = [], []
    for key, a in list(have.items()):
        if key not in want:
            wo.assignees.remove(a)
            removed.append(f"{key[0]}:{key[1]}")
    for kind, uid in pairs:
        if (kind, uid) not in have:
            wo.assignees.append(
                WorkOrderAssignee(
                    org_id=wo.org_id, user_id=uid if kind == "user" else None, team_id=uid if kind == "team" else None
                )
            )
            added.append(f"{kind}:{uid}")
    return added, removed


def _set_categories(wo: WorkOrder, ids: list[Any]) -> None:
    want: list[uuid.UUID] = []
    for raw in ids or []:
        cid = _uuid(raw, "category")
        ok = db.session.scalar(
            select(Category.id).where(Category.org_id == wo.org_id, Category.id == cid, Category.deleted_at.is_(None))
        )
        if not ok:
            raise RuleError("One of the categories doesn't exist.", 422)
        if cid not in want:
            want.append(cid)
    for link in list(wo.category_links):
        if link.category_id not in want:
            wo.category_links.remove(link)
    have = {link.category_id for link in wo.category_links}
    for cid in want:
        if cid not in have:
            wo.category_links.append(WorkOrderCategory(org_id=wo.org_id, category_id=cid))


def custom_fields(org_id: uuid.UUID, entity_type: str = "work_order") -> list[CustomField]:
    return list(
        db.session.scalars(
            select(CustomField)
            .where(
                CustomField.org_id == org_id, CustomField.entity_type == entity_type, CustomField.deleted_at.is_(None)
            )
            .order_by(CustomField.sort, CustomField.created_at)
        ).all()
    )


def _clean_custom(
    org_id: uuid.UUID,
    values: dict[str, Any],
    existing: dict[str, Any] | None = None,
    entity_type: str = "work_order",
) -> dict[str, Any]:
    fields = {str(f.id): f for f in custom_fields(org_id, entity_type)}
    out = {k: v for k, v in (existing or {}).items() if k in fields}
    for fid, v in (values or {}).items():
        f = fields.get(str(fid))
        if f is None:  # the field was deleted: forget its value instead of blocking the save
            out.pop(str(fid), None)
            continue
        if existing is not None and existing.get(str(fid)) == v:
            continue  # unchanged (it may predate a removed select option); keep as is
        if v in (None, "", []):
            out.pop(str(fid), None)
            continue
        if f.type in ("text", "link") and (not isinstance(v, str) or len(v) > 4096):
            raise RuleError(f"{f.name} must be text up to 4,096 characters.", 422)
        if f.type == "link" and not re.match(r"^(https?://|tel:|mailto:)", str(v), re.I):
            raise RuleError(f"{f.name} must be a web address (https://…) or a phone link (tel:…).", 422)
        if f.type == "textarea" and (not isinstance(v, str) or len(v) > 20000):
            raise RuleError(f"{f.name} is too long.", 422)
        if f.type == "number":
            try:
                v = float(v)
            except (TypeError, ValueError) as e:
                raise RuleError(f"{f.name} must be a number.", 422) from e
            v = int(v) if v.is_integer() else v
        if f.type == "select" and v not in (f.options or []):
            raise RuleError(f"Pick one of the options for {f.name}.", 422)
        if f.type == "checkbox":
            v = bool(v)
        if f.type == "date" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(v)):
            raise RuleError(f"{f.name} must be a date (YYYY-MM-DD).", 422)
        if f.type == "datetime":
            _dt(v, f.name)
        out[str(fid)] = v
    return out


def _check_required(org_id: uuid.UUID, wo: WorkOrder, attachment_count: int | None = None) -> None:
    s = wo_settings(org_id)
    empty = {
        "description": not wo.description.strip(),
        "due_date": wo.due_at is None,
        "priority": wo.priority == "none",
        "categories": not wo.category_links,
        "assignees": not wo.assignees,
        "estimated_time": not wo.estimated_minutes,
        "attachment": attachment_count is not None and attachment_count == 0,
    }
    missing = [k for k in s["required_fields"] if empty.get(k)]
    for f in custom_fields(org_id):
        if f.required and (wo.custom or {}).get(str(f.id)) in (None, ""):
            missing.append(f.name)
    if missing:
        names = [REQUIRABLE_LABELS.get(m, m) for m in missing]
        raise RuleError("Fill in the required fields: " + ", ".join(names) + ".", 422)


# ---- create / update -------------------------------------------------------------------------
def new_work_order(org_id: uuid.UUID, **kw: Any) -> WorkOrder:
    """An unsaved work order with Python-side defaults filled in (column defaults only apply on flush)."""
    now = utcnow()
    base: dict[str, Any] = {
        "id": uuid7(),
        "org_id": org_id,
        "number": 0,
        "title": "",
        "description": "",
        "status": "open",
        "sub_status": "",
        "priority": "none",
        "work_type": "reactive",
        "custom": {},
        "completion_summary": "",
        "cancel_reason": "",
        "signed_by_name": "",
        "approval_status": "none",
        "version": 1,
        "status_changed_at": now,
        "activity_at": now,
    }
    base.update(kw)
    return WorkOrder(**base)


EDITABLE = ("title", "description", "priority", "work_type", "start_at", "due_at", "estimated_minutes", "sub_status")


def _apply_fields(wo: WorkOrder, data: dict[str, Any]) -> None:
    if "title" in data:
        t = str(data["title"] or "").strip()
        if not t:
            raise RuleError("What needs to be done? A title is required.", 422)
        if len(t) > 255:
            raise RuleError("Titles can be up to 255 characters.", 422)
        wo.title = t
    if "description" in data:
        d = str(data["description"] or "")
        if len(d) > 4096:
            raise RuleError("Descriptions can be up to 4,096 characters.", 422)
        wo.description = d
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            raise RuleError("Priority must be None, Low, Medium or High.", 422)
        wo.priority = data["priority"]
    if "work_type" in data:
        if data["work_type"] not in WORK_TYPES:
            raise RuleError("Work type must be Reactive, Preventive or Other.", 422)
        wo.work_type = data["work_type"]
    if "start_at" in data:
        wo.start_at = _dt(data["start_at"], "Start date")
    if "due_at" in data:
        wo.due_at = _dt(data["due_at"], "Due date")
    if wo.start_at and wo.due_at and wo.start_at > wo.due_at:
        raise RuleError("The start date must be before the due date.", 422)
    if "estimated_minutes" in data:
        v = data["estimated_minutes"]
        if v in (None, ""):
            wo.estimated_minutes = None
        else:
            try:
                n = int(v)
            except (TypeError, ValueError) as e:
                raise RuleError("Estimated time must be a number of minutes.", 422) from e
            if n < 0 or n > 60 * 24 * 365:
                raise RuleError("Estimated time must be between 0 minutes and a year.", 422)
            wo.estimated_minutes = n
    if "sub_status" in data:
        sub = str(data["sub_status"] or "").strip()
        allowed = wo_settings(wo.org_id)["sub_statuses"].get(wo.status, [])
        if sub and sub not in allowed:
            raise RuleError(f"{sub!r} isn't a sub-status of {STATUS_LABELS[wo.status]}.", 422)
        wo.sub_status = sub


def _set_parent(wo: WorkOrder, parent_id: Any, m: Membership | None = None) -> None:
    if parent_id in (None, ""):
        wo.parent_id = None
        return
    pid = _uuid(parent_id, "work order")
    if pid == wo.id:
        raise RuleError("A work order can't be its own parent.", 422)
    parent = db.session.scalars(
        select(WorkOrder).where(WorkOrder.org_id == wo.org_id, WorkOrder.id == pid, WorkOrder.deleted_at.is_(None))
    ).first()
    if parent is None or (m is not None and not can_see(m, parent)):
        raise RuleError("The parent work order doesn't exist.", 422)
    if parent.parent_id is not None:
        raise RuleError("Sub-work orders can't have their own sub-work orders.", 422)
    if wo.id and db.session.scalar(
        select(func.count()).select_from(WorkOrder).where(WorkOrder.parent_id == wo.id, WorkOrder.deleted_at.is_(None))
    ):
        raise RuleError("This work order has sub-work orders, so it can't become one.", 422)
    wo.parent_id = parent.id


ASSET_TASK_STATUSES = ("open", "in_progress", "on_hold", "done")


def _set_asset_location(wo: WorkOrder, data: dict[str, Any], m: Membership | None = None) -> None:
    """Asset and location. Picking an asset fills in its location unless one was chosen too (MP-098)."""
    from mpro.assets.services import get_asset, get_location

    if "asset_id" in data:
        if data["asset_id"]:
            a = get_asset(wo.org_id, data["asset_id"])
            if m is not None and not can(m, "assets.view"):
                raise RuleError("You can't pick assets.", 403)
            changed = a.id != wo.asset_id
            wo.asset_id = a.id
            if changed and "location_id" not in data and a.location_id:
                wo.location_id = a.location_id
        else:
            wo.asset_id = None
    if "location_id" in data:
        wo.location_id = get_location(wo.org_id, data["location_id"]).id if data["location_id"] else None


def asset_task_ids(wo: WorkOrder) -> list[str]:
    return [
        str(t.asset_id)
        for t in db.session.scalars(
            select(WorkOrderAssetTask)
            .where(WorkOrderAssetTask.work_order_id == wo.id)
            .order_by(WorkOrderAssetTask.sort)
        ).all()
    ]


def _set_asset_tasks(wo: WorkOrder, ids: list[Any], m: Membership) -> None:
    """The work order's asset task list (MP-099): one row per asset, kept in the order given."""
    from mpro.assets.services import get_asset

    if not isinstance(ids, list) or len(ids) > 500:
        raise RuleError("Asset task lists can have up to 500 assets.", 422)
    want: list[uuid.UUID] = []
    for raw in ids:
        aid = get_asset(wo.org_id, raw).id
        if aid not in want:
            want.append(aid)
    have = {
        t.asset_id: t
        for t in db.session.scalars(select(WorkOrderAssetTask).where(WorkOrderAssetTask.work_order_id == wo.id)).all()
    }
    for aid, t in have.items():
        if aid not in want:
            db.session.delete(t)
    for n, aid in enumerate(want):
        task = have.get(aid)
        if task is None:
            db.session.add(
                WorkOrderAssetTask(
                    org_id=wo.org_id,
                    work_order_id=wo.id,
                    asset_id=aid,
                    status="open",
                    note="",
                    sort=n,
                    updated_by_id=m.user_id,
                )
            )
        else:
            task.sort = n


def asset_tasks(wo: WorkOrder) -> list[dict[str, Any]]:
    from mpro.assets.models import Asset

    rows = db.session.execute(
        select(WorkOrderAssetTask, Asset)
        .join(Asset, Asset.id == WorkOrderAssetTask.asset_id)
        .where(WorkOrderAssetTask.work_order_id == wo.id)
        .order_by(WorkOrderAssetTask.sort)
    ).all()
    return [
        {
            "id": str(t.id),
            "asset": {
                "id": str(a.id),
                "name": a.name,
                "status": a.status,
                "deleted": a.deleted_at is not None,
                "location": a.location.name if a.location else None,
            },
            "status": t.status,
            "note": t.note,
            "updated_at": iso(t.updated_at),
            "status_changed_at": iso(t.status_changed_at),
        }
        for t, a in rows
    ]


def update_asset_task(
    org: Organization, m: Membership, wo: WorkOrder, task_id: Any, data: dict[str, Any]
) -> WorkOrderAssetTask:
    t = db.session.get(WorkOrderAssetTask, _uuid(task_id, "task"))
    if t is None or t.work_order_id != wo.id:
        raise RuleError("That task isn't on this work order.", 404)
    if wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to change its tasks.", 409)
    from mpro.assets.models import Asset

    a = db.session.get(Asset, t.asset_id)
    parts = []
    if "status" in data and data["status"] != t.status:
        if data["status"] not in ASSET_TASK_STATUSES:
            raise RuleError("Task status is Open, In Progress, On Hold or Done.", 422)
        parts.append(f"{a.name if a else 'asset'} to {STATUS_LABELS[data['status']]}")
        t.status, t.status_changed_at = data["status"], utcnow()
    if "note" in data:
        note = str(data["note"] or "")
        if len(note) > 4096:
            raise RuleError("Notes can be up to 4,096 characters.", 422)
        if note != t.note:
            parts.append(f"notes for {a.name if a else 'asset'}")
            t.note = note
    if parts:
        t.updated_by_id = m.user_id
        touch(wo, m.user_id)
        emit(
            "wo.asset_task_updated",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Changed " + ", ".join(parts),
            data={"task_id": t.id, "asset_id": t.asset_id, "status": t.status},
        )
        db.session.commit()
    return t


def _asset_status_from_wo(org: Organization, m: Membership, wo: WorkOrder, data: Any) -> None:
    """Change the asset's status from the work order (MaintainX asks when you create or close one)."""
    from mpro.assets.models import Asset
    from mpro.assets.services import set_status as set_asset_status

    if not data:
        return
    if not isinstance(data, dict) or not wo.asset_id:
        raise RuleError("Pick an asset before changing its status.", 422)
    if not can(m, "assets.status"):
        raise RuleError("You can't change asset statuses.", 403)
    a = db.session.get(Asset, wo.asset_id)
    if a is None:
        return
    set_asset_status(
        org,
        m,
        a,
        str(data.get("status") or ""),
        reason=str(data.get("reason") or ""),
        downtime_type=str(data.get("downtime_type") or ""),
        note=str(data.get("note") or ""),
        work_order_id=wo.id,
        commit=False,
    )


def _snapshot(wo: WorkOrder) -> dict[str, Any]:
    return {
        "title": wo.title,
        "description": wo.description,
        "priority": wo.priority,
        "work_type": wo.work_type,
        "start_at": wo.start_at,
        "due_at": wo.due_at,
        "estimated_minutes": wo.estimated_minutes,
        "sub_status": wo.sub_status,
        "parent_id": wo.parent_id,
        "assignees": sorted(f"user:{a.user_id}" if a.user_id else f"team:{a.team_id}" for a in wo.assignees),
        "categories": sorted(str(c.category_id) for c in wo.category_links),
        "custom": dict(wo.custom or {}),
        "asset_id": wo.asset_id,
        "location_id": wo.location_id,
        "asset_tasks": asset_task_ids(wo) if wo.id else [],
    }


def create_work_order(
    org: Organization, m: Membership, data: dict[str, Any], *, commit: bool = True, check_required: bool = True
) -> WorkOrder:
    ensure_default_categories(org.id)
    wo = new_work_order(org.id, created_by_id=m.user_id)
    _apply_fields(wo, {"title": data.get("title", ""), **{k: data[k] for k in EDITABLE if k in data and k != "title"}})
    if data.get("parent_id"):
        _set_parent(wo, data["parent_id"], m)
    _set_asset_location(wo, {k: data[k] for k in ("asset_id", "location_id") if k in data}, m)
    wo.custom = _clean_custom(org.id, data.get("custom") or {})
    if data.get("template_id"):
        wo.template_id = _uuid(data["template_id"], "template")
    pairs = _resolve_assignees(org.id, data.get("assignees") or [])
    _set_categories(wo, data.get("categories") or [])
    _set_assignees(wo, pairs)
    if check_required:
        _check_required(org.id, wo, attachment_count=len(data.get("file_ids") or []) if "file_ids" in data else None)
    wo.number = next_number(org.id)
    db.session.add(wo)
    db.session.flush()  # the status history row references the work order (no ORM relationship orders it)
    db.session.add(
        StatusChange(org_id=org.id, work_order_id=wo.id, from_status="", to_status="open", actor_id=m.user_id)
    )
    db.session.flush()
    for fid in data.get("file_ids") or []:
        _attach_existing(wo, fid, "file", m)
    if data.get("asset_tasks"):
        _set_asset_tasks(wo, data["asset_tasks"], m)
    _asset_status_from_wo(org, m, wo, data.get("asset_status"))
    touch(wo, m.user_id)
    emit(
        "wo.created",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Created work order #{wo.number}",
        data={"assignees": [f"{k}:{v}" for k, v in pairs], "priority": wo.priority, "parent_id": wo.parent_id},
    )
    if pairs:
        emit(
            "wo.assigned",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Assigned " + _assignee_names(pairs),
            data={"added": [f"{k}:{v}" for k, v in pairs]},
        )
    if commit:
        db.session.commit()
    return wo


def _attach_existing(wo: WorkOrder, file_id: Any, role: str, m: Membership) -> None:
    """Attach a file the member uploaded earlier (e.g. from the create form)."""
    f = db.session.get(FileObject, _uuid(file_id, "file"))
    if f is None or f.org_id != wo.org_id or f.deleted_at is not None or f.uploaded_by_id != m.user_id:
        raise RuleError("One of the files couldn't be found. Upload it again.", 422)
    attach(f, "work_order", wo.id, role)


def _assignee_names(pairs: list[tuple[str, uuid.UUID]] | list[str]) -> str:
    from mpro.auth.models import User

    names = []
    for p in pairs:
        kind, uid = p.split(":", 1) if isinstance(p, str) else (p[0], str(p[1]))
        if kind == "user":
            u = db.session.get(User, uuid.UUID(uid))
            names.append(u.name if u else "someone")
        else:
            t = db.session.get(Team, uuid.UUID(uid))
            names.append(f"team {t.name}" if t else "a team")
    return ", ".join(names)


def update_work_order(
    org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any], expected_version: int | None = None
) -> WorkOrder:
    if wo.deleted_at is not None:
        raise RuleError("This work order was deleted. Restore it before editing.", 409)
    if expected_version is not None and expected_version != wo.version:
        raise Conflict(wo)
    before = _snapshot(wo)
    fields = {k: data[k] for k in EDITABLE if k in data}
    _apply_fields(wo, fields)
    if "parent_id" in data:
        _set_parent(wo, data["parent_id"], m)
    added: list[str] = []
    removed: list[str] = []
    if "assignees" in data:
        added, removed = _set_assignees(wo, _resolve_assignees(org.id, data["assignees"]))
    if "categories" in data:
        _set_categories(wo, data["categories"])
    if "custom" in data:
        wo.custom = _clean_custom(org.id, data["custom"] or {}, wo.custom)
    _set_asset_location(wo, {k: data[k] for k in ("asset_id", "location_id") if k in data}, m)
    if "asset_tasks" in data:
        _set_asset_tasks(wo, data["asset_tasks"] or [], m)
        db.session.flush()
    _asset_status_from_wo(org, m, wo, data.get("asset_status"))
    after = _snapshot(wo)
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if not changes:
        if data.get("asset_status"):
            db.session.commit()
        return wo
    _check_required(org.id, wo)
    wo.version += 1
    touch(wo, m.user_id)
    emit(
        "wo.updated",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary="Changed " + ", ".join(_FIELD_NAMES.get(k, k) for k in changes),
        changes=changes,
    )
    if added:
        emit(
            "wo.assigned",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Assigned " + _assignee_names(added),
            data={"added": added},
        )
    if removed:
        emit(
            "wo.unassigned",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Unassigned " + _assignee_names(removed),
            data={"removed": removed},
        )
    db.session.commit()
    return wo


_FIELD_NAMES = {
    "title": "title",
    "description": "description",
    "priority": "priority",
    "work_type": "work type",
    "start_at": "start date",
    "due_at": "due date",
    "estimated_minutes": "estimated time",
    "sub_status": "sub-status",
    "parent_id": "parent work order",
    "assignees": "assignees",
    "categories": "categories",
    "custom": "custom fields",
    "asset_id": "asset",
    "location_id": "location",
    "asset_tasks": "asset tasks",
}


# ---- statuses and completion -----------------------------------------------------------------
def _comment_rule(s: dict[str, Any], status: str) -> str:
    return {"on_hold": s["comment_on_hold"], "canceled": s["comment_on_cancel"]}.get(status, "optional")


def _decode_signature(data_url: str) -> bytes:
    m = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=\s]+)", data_url or "")
    if not m:
        raise RuleError("The signature must be a PNG image.", 422)
    try:
        raw = base64.b64decode(m.group(1), validate=False)
    except (binascii.Error, ValueError) as e:
        raise RuleError("The signature couldn't be read. Sign again.", 422) from e
    if len(raw) > 2 * 1024 * 1024:
        raise RuleError("The signature image is too large.", 422)
    return raw


def set_status(
    org: Organization,
    m: Membership,
    wo: WorkOrder,
    status: str,
    *,
    comment: str = "",
    sub_status: str = "",
    summary: str | None = None,
    signature: str | None = None,
    signed_by: str = "",
    file_ids: list[Any] | None = None,
    expected_version: int | None = None,
    commit: bool = True,
    undo: bool = False,
) -> WorkOrder:
    """`undo=True` (Undo right after a change) skips the "comment required" rule; completion rules still apply."""
    if status not in STATUSES:
        raise RuleError("Unknown status.", 422)
    if wo.deleted_at is not None:
        raise RuleError("This work order was deleted. Restore it first.", 409)
    if expected_version is not None and expected_version != wo.version:
        raise Conflict(wo)
    s = wo_settings(org.id)
    comment = (comment or "").strip()
    if status == wo.status and (sub_status or "") == wo.sub_status:
        return wo
    rule = _comment_rule(s, status)
    if rule == "mandatory" and not comment and status != wo.status and not undo:
        what = {"on_hold": "putting it on hold", "canceled": "canceling"}[status]
        raise RuleError(f"Add a comment explaining why you're {what}.", 422)
    if sub_status and sub_status not in s["sub_statuses"].get(status, []):
        raise RuleError(f"{sub_status!r} isn't a sub-status of {STATUS_LABELS[status]}.", 422)
    from_status = wo.status
    if status == "done" and from_status != "done":
        _complete(org, m, wo, s, summary, signature, signed_by)
    if status == "canceled":
        wo.cancel_reason = comment
    if from_status == "done" and status != "done":  # leaving Done: completion, sign-off and approval start over
        wo.completed_at = wo.completed_by_id = None
        wo.approval_status, wo.approved_by_id, wo.approved_at = "none", None, None
        wo.signature_file_id, wo.signed_by_name, wo.signed_at = None, "", None
        wo.completion_summary = ""
    if from_status == "canceled" and status != "canceled":
        wo.cancel_reason = ""
    wo.status, wo.sub_status = status, sub_status
    if from_status != status:
        wo.status_changed_at = utcnow()
        db.session.add(
            StatusChange(
                org_id=org.id, work_order_id=wo.id, from_status=from_status, to_status=status,
                actor_id=m.user_id, comment=comment,
            )
        )  # fmt: skip
    for fid in file_ids or []:
        _attach_existing(wo, fid, "after" if status == "done" else "cancel" if status == "canceled" else "file", m)
    wo.version += 1
    touch(wo, m.user_id)
    verb = {
        ("done", "open"): "Reopened",
        ("canceled", "open"): "Reopened",
    }.get((from_status, status))
    emit(
        "wo.status_changed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=(verb or "Changed status to") + ("" if verb else f" {STATUS_LABELS[status]}")
        + (f" ({sub_status})" if sub_status else ""),
        changes={"status": (from_status, status)},
        data={"comment": comment, "sub_status": sub_status},
    )  # fmt: skip
    if commit:
        db.session.commit()
    return wo


def _complete(
    org: Organization,
    m: Membership,
    wo: WorkOrder,
    s: dict[str, Any],
    summary: str | None,
    signature: str | None,
    signed_by: str,
) -> None:
    problems = []
    if s["require_time_to_complete"] and not db.session.scalar(
        select(func.count()).select_from(TimeEntry).where(TimeEntry.work_order_id == wo.id)
    ):
        problems.append("log time")
    if s["require_cost_to_complete"] and not db.session.scalar(
        select(func.count()).select_from(CostEntry).where(CostEntry.work_order_id == wo.id)
    ):
        problems.append("add a cost")
    summary = (summary or "").strip()
    if s["completion_summary"] == "mandatory" and not summary:
        problems.append("write a completion summary")
    if s["require_signature"] and not signature and not wo.signature_file_id:
        problems.append("sign")
    if problems:
        raise RuleError("Before completing, " + ", ".join(problems) + ".", 422)
    if signature:
        raw = _decode_signature(signature)
        f = save_file(org.id, f"signature-{wo.number}.png", raw, m.user_id)
        attach(f, "work_order", wo.id, "signature")
        wo.signature_file_id = f.id
        wo.signed_by_name = (signed_by or m.user.name).strip()[:200]
        wo.signed_at = utcnow()
    if summary:
        wo.completion_summary = summary[:20000]
    wo.completed_at, wo.completed_by_id = utcnow(), m.user_id
    if s["require_approval"]:
        if can(m, "wo.approve"):
            wo.approval_status, wo.approved_by_id, wo.approved_at = "approved", m.user_id, utcnow()
        else:
            wo.approval_status = "pending"
    else:
        wo.approval_status = "none"


def decide_approval(org: Organization, m: Membership, wo: WorkOrder, approve: bool, comment: str = "") -> WorkOrder:
    if wo.status != "done" or wo.approval_status != "pending":
        raise RuleError("This work order isn't waiting for approval.", 409)
    if approve:
        wo.approval_status, wo.approved_by_id, wo.approved_at = "approved", m.user_id, utcnow()
        wo.version += 1
        touch(wo, m.user_id)
        emit(
            "wo.approved",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Approved the completed work",
            data={"comment": comment},
        )
        db.session.commit()
        return wo
    if not comment.strip():
        raise RuleError("Say what still needs doing so the assignees know.", 422)
    wo.approval_status = "rejected"
    set_status(org, m, wo, "in_progress", comment=comment, commit=False)
    wo.approval_status = "rejected"
    emit(
        "wo.rejected",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary="Sent back for more work",
        data={"comment": comment},
    )
    db.session.commit()
    return wo


# ---- delete / restore / duplicate ------------------------------------------------------------
def delete_work_order(org: Organization, m: Membership, wo: WorkOrder, commit: bool = True) -> None:
    if wo.deleted_at is not None:
        return
    wo.deleted_at = utcnow()
    emit(
        "wo.deleted",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Deleted work order #{wo.number}",
    )
    if commit:
        db.session.commit()


def restore_work_order(org: Organization, m: Membership, wo: WorkOrder, commit: bool = True) -> None:
    if wo.deleted_at is None:
        return
    wo.deleted_at = None
    emit(
        "wo.restored",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Restored work order #{wo.number}",
    )
    if commit:
        db.session.commit()


def duplicate_work_order(org: Organization, m: Membership, wo: WorkOrder) -> WorkOrder:
    """MaintainX "Copy to New Work Order": same content, new number, Open, no history."""
    data = {
        "title": wo.title,
        "description": wo.description,
        "priority": wo.priority,
        "work_type": wo.work_type,
        "estimated_minutes": wo.estimated_minutes,
        "start_at": wo.start_at,
        "due_at": wo.due_at,
        "parent_id": wo.parent_id,
        "assignees": [f"user:{a.user_id}" if a.user_id else f"team:{a.team_id}" for a in wo.assignees],
        "categories": [str(c.category_id) for c in wo.category_links],
        "custom": dict(wo.custom or {}),
    }
    new = create_work_order(org, m, data, commit=False, check_required=False)
    emit(
        "wo.duplicated",
        entity_type="work_order",
        entity_id=new.id,
        entity_label=label(new),
        summary=f"Copied from #{wo.number}",
        data={"source_id": wo.id},
    )
    db.session.commit()
    return new


# ---- links between work orders ---------------------------------------------------------------
def add_link(org: Organization, m: Membership, wo: WorkOrder, other: WorkOrder, kind: str) -> WorkOrderLink:
    if kind not in LINK_KINDS:
        raise RuleError("Links are 'blocks' or 'related'.", 422)
    if other.id == wo.id:
        raise RuleError("A work order can't be linked to itself.", 422)
    exists = db.session.scalars(
        select(WorkOrderLink).where(
            ((WorkOrderLink.from_id == wo.id) & (WorkOrderLink.to_id == other.id))
            | ((WorkOrderLink.from_id == other.id) & (WorkOrderLink.to_id == wo.id))
        )
    ).first()
    if exists:
        raise RuleError(f"#{wo.number} and #{other.number} are already linked.", 409)
    link = WorkOrderLink(org_id=org.id, from_id=wo.id, to_id=other.id, kind=kind)
    db.session.add(link)
    touch(wo, m.user_id)
    emit(
        "wo.linked",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=(f"Marked as blocking #{other.number}" if kind == "blocks" else f"Linked to #{other.number}"),
        data={"other_id": other.id, "kind": kind},
    )
    db.session.commit()
    return link


def remove_link(org: Organization, m: Membership, wo: WorkOrder, link: WorkOrderLink) -> None:
    if wo.id not in (link.from_id, link.to_id):
        raise RuleError("That link isn't on this work order.", 404)
    other_id = link.to_id if link.from_id == wo.id else link.from_id
    other = db.session.get(WorkOrder, other_id)
    db.session.delete(link)
    touch(wo, m.user_id)
    emit(
        "wo.unlinked",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=label(wo),
        summary=f"Removed the link to #{other.number if other else '?'}",
        data={"other_id": other_id},
    )
    db.session.commit()


# ---- settings --------------------------------------------------------------------------------
def _types_list(v: Any, what: str) -> list[str]:
    if not isinstance(v, list) or not v:
        raise RuleError(f"Keep at least one {what}.", 422)
    out: list[str] = []
    for x in v:
        x = str(x).strip()[:60]
        if x and x.lower() not in {o.lower() for o in out}:
            out.append(x)
    if not out:
        raise RuleError(f"Keep at least one {what}.", 422)
    return out[:50]


def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    current = wo_settings(org.id)
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in WO_SETTINGS or k == "categories_seeded":
            raise RuleError(f"Unknown setting {k!r}.", 422)
        default = WO_SETTINGS[k]
        if isinstance(default, bool):
            clean[k] = bool(v)
        elif k == "required_fields":
            if not isinstance(v, list) or any(x not in REQUIRABLE for x in v):
                raise RuleError("Unknown required field.", 422)
            clean[k] = sorted(set(v), key=REQUIRABLE.index)
        elif k in ("completion_summary", "comment_on_hold", "comment_on_cancel"):
            if v not in COMMENT_RULES:
                raise RuleError("Use none, optional or mandatory.", 422)
            clean[k] = v
        elif k == "time_types":
            clean[k] = _types_list(v, "time type")
        elif k == "cost_types":
            clean[k] = _types_list(v, "cost type")
        elif k == "default_hourly_rate_cents":
            if not isinstance(v, int) or v < 0 or v > 10_000_000:
                raise RuleError("Enter an hourly rate between 0 and 100,000.", 422)
            clean[k] = v
        elif k == "workday_minutes":
            if not isinstance(v, int) or not 30 <= v <= 1440:
                raise RuleError("A work day is between 30 minutes and 24 hours.", 422)
            clean[k] = v
        elif k in ("default_start_time", "default_due_time"):
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(v)):
                raise RuleError("Use a time like 09:00.", 422)
            clean[k] = v
        elif k == "sub_statuses":
            if not isinstance(v, dict) or set(v) - {"open", "on_hold", "in_progress", "done"}:
                raise RuleError("Sub-statuses belong to Open, On Hold, In Progress or Done.", 422)
            subs = {}
            for st in ("open", "on_hold", "in_progress", "done"):
                items = v.get(st, current["sub_statuses"].get(st, []))
                if not isinstance(items, list):
                    raise RuleError("Sub-statuses must be a list.", 422)
                seen: list[str] = []
                for x in items:
                    x = str(x).strip()[:60]
                    if x and x not in seen:
                        seen.append(x)
                subs[st] = seen[:20]
            clean[k] = subs
    changes = {k: (current[k], v) for k, v in clean.items() if current[k] != v}
    result = save_settings(org.id, "work_orders", clean)
    if changes:
        emit(
            "wo.settings_changed",
            entity_type="org",
            entity_id=org.id,
            entity_label=org.name,
            summary="Changed work order settings: " + ", ".join(k.replace("_", " ") for k in changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return result


def set_member_work_settings(org: Organization, target: Membership, data: dict[str, Any]) -> Membership:
    before = {"hourly_rate_cents": target.hourly_rate_cents, "wo_visibility": target.wo_visibility}
    if "hourly_rate_cents" in data:
        v = data["hourly_rate_cents"]
        if v is not None and (not isinstance(v, int) or v < 0 or v > 10_000_000):
            raise RuleError("Enter an hourly rate between 0 and 100,000, or leave it empty for the default.", 422)
        target.hourly_rate_cents = v
    if "wo_visibility" in data:
        if data["wo_visibility"] not in ("all", "limited"):
            raise RuleError("Visibility is all or limited.", 422)
        target.wo_visibility = data["wo_visibility"]
    after = {"hourly_rate_cents": target.hourly_rate_cents, "wo_visibility": target.wo_visibility}
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes:
        emit(
            "member.updated",
            entity_type="user",
            entity_id=target.user_id,
            entity_label=target.user.name,
            summary="Changed " + ", ".join(k.replace("_cents", "").replace("_", " ") for k in changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return target


# ---- custom fields ---------------------------------------------------------------------------
def custom_field_dict(f: CustomField) -> dict[str, Any]:
    return {
        "id": str(f.id),
        "name": f.name,
        "type": f.type,
        "options": f.options or [],
        "required": f.required,
        "copy_on_repeat": f.copy_on_repeat,
        "on_request_form": f.on_request_form,
        "sort": f.sort,
        "entity_type": f.entity_type,
        "scope_id": str(f.scope_id) if f.scope_id else None,
    }


ENTITY_LABELS = {"work_order": "work order", "asset": "asset", "location": "location"}


def save_custom_field(
    org: Organization, data: dict[str, Any], f: CustomField | None = None, entity_type: str = "work_order"
) -> CustomField:
    entity_type = f.entity_type if f is not None else entity_type
    if entity_type not in ENTITY_LABELS:
        raise RuleError("Custom fields belong to work orders, assets or locations.", 422)
    name = str(data.get("name", f.name if f else "")).strip()
    if not name:
        raise RuleError("The field needs a name.", 422)
    ftype = data.get("type", f.type if f else "text")
    if ftype not in FIELD_TYPES:
        raise RuleError("Unknown field type.", 422)
    if f is not None and ftype != f.type:
        raise RuleError("A field's type can't change after it's created. Make a new field instead.", 422)
    options = data.get("options", f.options if f else [])
    if ftype == "select":
        if not isinstance(options, list):
            raise RuleError("Options must be a list.", 422)
        options = [str(o).strip()[:120] for o in options if str(o).strip()]
        if not options:
            raise RuleError("Add at least one option.", 422)
        if len(set(options)) != len(options):
            raise RuleError("Options must be different from each other.", 422)
    else:
        options = []
    dup = db.session.scalar(
        select(CustomField.id).where(
            CustomField.org_id == org.id,
            CustomField.entity_type == entity_type,
            CustomField.deleted_at.is_(None),
            func.lower(CustomField.name) == name.lower(),
            CustomField.id != (f.id if f else uuid.uuid4()),
        )
    )
    if dup:
        raise RuleError(f"There's already a field called {name}.", 409)
    created = f is None
    if f is None:
        n = len(custom_fields(org.id, entity_type))
        f = CustomField(org_id=org.id, entity_type=entity_type, type=ftype, sort=n)
        db.session.add(f)
    f.name, f.options = name[:120], options
    if "scope_id" in data:
        if entity_type != "asset":
            raise RuleError("Only asset fields can be limited to an asset type.", 422)
        sid = data.get("scope_id")
        if sid:
            from mpro.assets.models import AssetType

            sid = _uuid(sid, "asset type")
            if not db.session.scalar(
                select(AssetType.id).where(
                    AssetType.org_id == org.id, AssetType.id == sid, AssetType.deleted_at.is_(None)
                )
            ):
                raise RuleError("That asset type doesn't exist.", 422)
        f.scope_id = sid or None
    for k in ("required", "copy_on_repeat", "on_request_form"):
        if k in data:
            setattr(f, k, bool(data[k]))
    db.session.flush()
    emit(
        "custom_field.created" if created else "custom_field.updated",
        entity_type="custom_field",
        entity_id=f.id,
        entity_label=f.name,
        summary=("Created" if created else "Changed") + f" {ENTITY_LABELS[entity_type]} field {f.name}",
    )
    db.session.commit()
    return f


def reorder_custom_fields(org: Organization, ids: list[str], entity_type: str = "work_order") -> list[CustomField]:
    fields = {str(f.id): f for f in custom_fields(org.id, entity_type)}
    if set(ids) != set(fields):
        raise RuleError("Send every field once to reorder.", 422)
    for i, fid in enumerate(ids):
        fields[fid].sort = i
    db.session.commit()
    return custom_fields(org.id, entity_type)


def delete_custom_field(org: Organization, f: CustomField) -> None:
    f.deleted_at = utcnow()
    emit(
        "custom_field.deleted",
        entity_type="custom_field",
        entity_id=f.id,
        entity_label=f.name,
        summary=f"Deleted {ENTITY_LABELS.get(f.entity_type, 'record')} field {f.name}",
    )
    db.session.commit()


# ---- templates -------------------------------------------------------------------------------
TEMPLATE_KEYS = (
    "title",
    "description",
    "priority",
    "work_type",
    "estimated_minutes",
    "assignees",
    "categories",
    "custom",
    "asset_id",
    "location_id",
    "due_in_days",
)


def template_dict(t: Template) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "name": t.name,
        "description": t.description,
        "data": t.data,
        "pinned": t.pinned,
        "use_count": t.use_count,
        "last_used_at": iso(t.last_used_at),
        "updated_at": t.updated_at.isoformat(),
    }


def save_template(org: Organization, m: Membership, data: dict[str, Any], t: Template | None = None) -> Template:
    name = str(data.get("name", t.name if t else "")).strip()
    if not name:
        raise RuleError("The template needs a name.", 422)
    content = dict(data.get("data", t.data if t else {}) or {})
    unknown = set(content) - set(TEMPLATE_KEYS)
    if unknown:
        raise RuleError("Templates can't store " + ", ".join(sorted(unknown)) + ".", 422)
    # validate by applying to a throwaway work order
    probe = new_work_order(org.id, title=content.get("title") or "x")
    _apply_fields(
        probe, {k: content[k] for k in ("description", "priority", "work_type", "estimated_minutes") if k in content}
    )
    _resolve_assignees(org.id, content.get("assignees") or [])
    for cid in content.get("categories") or []:
        _uuid(cid, "category")
    content["custom"] = _clean_custom(org.id, content.get("custom") or {})
    _set_asset_location(probe, {k: content[k] for k in ("asset_id", "location_id") if k in content})
    if content.get("due_in_days") not in (None, ""):
        try:
            content["due_in_days"] = int(content["due_in_days"])
        except (TypeError, ValueError) as e:
            raise RuleError("Due in days must be a whole number.", 422) from e
        if not 0 <= content["due_in_days"] <= 3650:
            raise RuleError("Due in days must be between 0 and 3,650.", 422)
    created = t is None
    if t is None:
        t = Template(org_id=org.id, created_by_id=m.user_id)
        db.session.add(t)
    t.name, t.description, t.data = name[:120], str(data.get("description", t.description or "")).strip()[:500], content
    if "pinned" in data:
        t.pinned = bool(data["pinned"])
    db.session.flush()
    emit(
        "template.created" if created else "template.updated",
        entity_type="template",
        entity_id=t.id,
        entity_label=t.name,
        summary=("Created" if created else "Changed") + f" template {t.name}",
    )
    db.session.commit()
    return t


def create_from_template(org: Organization, m: Membership, t: Template, overrides: dict[str, Any]) -> WorkOrder:
    """One-tap create (MP-101): a work order straight from a template; overrides win (e.g. the scanned asset)."""
    from datetime import timedelta

    allowed = {
        "title",
        "description",
        "priority",
        "assignees",
        "asset_id",
        "location_id",
        "due_at",
        "start_at",
        "asset_tasks",
    }
    bad = set(overrides) - allowed
    if bad:
        raise RuleError("Can't override " + ", ".join(sorted(bad)) + ".", 422)
    data: dict[str, Any] = {k: v for k, v in (t.data or {}).items() if k != "due_in_days"}
    data.setdefault("title", t.name)
    if (t.data or {}).get("due_in_days") is not None and "due_at" not in overrides:
        due = utcnow().replace(hour=17, minute=0, second=0, microsecond=0) + timedelta(days=int(t.data["due_in_days"]))
        data["due_at"] = due.isoformat()
    if "asset_id" in overrides and "location_id" not in overrides:
        data.pop("location_id", None)  # the asset's own location follows it
    data.update(overrides)
    data["template_id"] = str(t.id)
    try:
        wo = create_work_order(org, m, data, commit=False)
    except RuleError as e:
        if e.status == 422 and "required" in e.message.lower():
            raise RuleError(e.message + " Open the full form to fill it in.", 422) from e
        raise
    t.use_count = (t.use_count or 0) + 1
    t.last_used_at = utcnow()
    db.session.commit()
    return wo


def delete_template(org: Organization, t: Template) -> None:
    t.deleted_at = utcnow()
    emit(
        "template.deleted",
        entity_type="template",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Deleted template {t.name}",
    )
    db.session.commit()


# ---- saved views -----------------------------------------------------------------------------
def view_dict(v: SavedView) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "name": v.name,
        "shared": v.owner_id is None,
        "filters": v.filters or [],
        "sort": v.sort,
        "columns": v.columns or [],
        "pinned": v.pinned,
    }


def save_view(org: Organization, m: Membership, data: dict[str, Any], v: SavedView | None = None) -> SavedView:
    from mpro.workorders.queries import validate_filters

    name = str(data.get("name", v.name if v else "")).strip()
    if not name:
        raise RuleError("Give the view a name.", 422)
    shared = bool(data.get("shared", v.owner_id is None if v else False))
    if shared and not can(m, "views.share"):
        raise RuleError("Only administrators can share views with the whole organization.", 403)
    if v is not None and v.owner_id is None and not can(m, "views.share"):
        raise RuleError("Only administrators can change shared views.", 403)
    if v is not None and v.owner_id not in (None, m.user_id):
        raise RuleError("That view belongs to someone else.", 403)
    filters = validate_filters(data.get("filters", v.filters if v else []))
    if v is None:
        v = SavedView(org_id=org.id, entity_type="work_order")
        db.session.add(v)
    v.owner_id = None if shared else m.user_id
    v.name, v.filters = name[:120], filters
    if "sort" in data:
        v.sort = str(data["sort"] or "")[:40]
    if "columns" in data:
        cols = data["columns"] or []
        if not isinstance(cols, list):
            raise RuleError("Columns must be a list.", 422)
        v.columns = [str(c)[:60] for c in cols][:40]
    if "pinned" in data:
        v.pinned = bool(data["pinned"])
    db.session.commit()
    return v


def delete_view(m: Membership, v: SavedView) -> None:
    if v.owner_id is None and not can(m, "views.share"):
        raise RuleError("Only administrators can delete shared views.", 403)
    if v.owner_id not in (None, m.user_id):
        raise RuleError("That view belongs to someone else.", 403)
    v.deleted_at = utcnow()
    db.session.commit()


def views_for(m: Membership) -> list[SavedView]:
    return list(
        db.session.scalars(
            select(SavedView)
            .where(
                SavedView.org_id == m.org_id,
                SavedView.entity_type == "work_order",
                SavedView.deleted_at.is_(None),
                (SavedView.owner_id == m.user_id) | SavedView.owner_id.is_(None),
            )
            .order_by(SavedView.pinned.desc(), func.lower(SavedView.name))
        ).all()
    )


# ---- bulk ------------------------------------------------------------------------------------
BULK_ACTIONS = (
    "set_status",
    "set_priority",
    "set_due",
    "clear_due",
    "clear_start",
    "add_assignees",
    "remove_assignees",
    "add_categories",
    "remove_categories",
    "mark_read",
    "mark_unread",
    "delete",
    "restore",
    "cancel",
    "revert",
)


def bulk(
    org: Organization, m: Membership, wos: list[WorkOrder], action: str, value: Any, comment: str = ""
) -> dict[str, Any]:
    """Apply one action to many work orders. Each one succeeds or fails on its own.

    Returns {"updated": [...ids], "errors": [{id, number, message}], "undo": [...]} where `undo` holds
    the previous values, which the client sends back with action "revert" for Undo.
    """
    if action not in BULK_ACTIONS:
        raise RuleError("Unknown bulk action.", 422)
    needs = {"delete": "wo.delete", "restore": "wo.delete", "mark_read": "wo.view", "mark_unread": "wo.view"}.get(
        action, "wo.edit"
    )
    if not can(m, needs):
        raise RuleError("You don't have permission to do that.", 403)
    updated: list[str] = []
    errors: list[dict[str, Any]] = []
    undo: list[dict[str, Any]] = []
    if action in (
        "add_assignees",
        "remove_assignees",
        "add_categories",
        "remove_categories",
        "revert",
    ) and not isinstance(value or [], list):
        raise RuleError("Send a list.", 422)
    revert_map: dict[str, dict[str, Any]] = {}
    if action == "revert":
        for x in value or []:
            if not isinstance(x, dict) or "id" not in x:
                raise RuleError("Undo data is malformed.", 422)
            revert_map[str(x["id"])] = x
    for wo in wos:
        snap = _snapshot(wo)
        try:
            with db.session.begin_nested():
                prev: dict[str, Any] = {"id": str(wo.id)}
                if action == "set_status":
                    prev["status"], prev["sub_status"] = wo.status, wo.sub_status
                    set_status(org, m, wo, str(value), comment=comment, commit=False)
                elif action == "cancel":
                    prev["status"], prev["sub_status"] = wo.status, wo.sub_status
                    set_status(org, m, wo, "canceled", comment=comment, commit=False)
                elif action == "delete":
                    delete_work_order(org, m, wo, commit=False)
                elif action == "restore":
                    restore_work_order(org, m, wo, commit=False)
                elif action == "mark_read":
                    mark_read(wo, m.user_id)
                elif action == "mark_unread":
                    db.session.execute(
                        ReadMark.__table__.delete().where(ReadMark.entity_id == wo.id, ReadMark.user_id == m.user_id)
                    )
                else:
                    patch: dict[str, Any] = {}
                    if action == "set_priority":
                        patch["priority"] = value
                    elif action == "set_due":
                        patch["due_at"] = value
                    elif action == "clear_due":
                        patch["due_at"] = None
                    elif action == "clear_start":
                        patch["start_at"] = None
                    elif action in ("add_assignees", "remove_assignees"):
                        cur = snap["assignees"]
                        items = []
                        for x in value or []:
                            if isinstance(x, str):
                                items.append(x)
                            elif isinstance(x, dict) and "type" in x and "id" in x:
                                items.append(f"{x['type']}:{x['id']}")
                            else:
                                raise RuleError("Assignees must be people or teams.", 422)
                        patch["assignees"] = (
                            cur + [x for x in items if x not in cur]
                            if action == "add_assignees"
                            else [x for x in cur if x not in items]
                        )
                    elif action in ("add_categories", "remove_categories"):
                        cur = snap["categories"]
                        items = [str(x) for x in (value or [])]
                        patch["categories"] = (
                            cur + [x for x in items if x not in cur]
                            if action == "add_categories"
                            else [x for x in cur if x not in items]
                        )
                    elif action == "revert":
                        r = revert_map.get(str(wo.id))
                        if not r:
                            continue
                        if "status" in r and (r["status"] != wo.status or r.get("sub_status", "") != wo.sub_status):
                            set_status(
                                org,
                                m,
                                wo,
                                str(r["status"]),
                                sub_status=str(r.get("sub_status") or ""),
                                commit=False,
                                undo=True,
                            )
                        patch = {
                            k: r[k] for k in ("priority", "due_at", "start_at", "assignees", "categories") if k in r
                        }
                    for k in patch:
                        prev[k] = _jsonable_prev(snap.get(k) if k in snap else getattr(wo, k))
                    if patch:
                        _bulk_patch(org, m, wo, patch)
                undo.append(prev)
                updated.append(str(wo.id))
        except RuleError as e:
            errors.append({"id": str(wo.id), "number": wo.number, "message": e.message})
    db.session.commit()
    return {"updated": updated, "errors": errors, "undo": undo}


def _jsonable_prev(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _bulk_patch(org: Organization, m: Membership, wo: WorkOrder, patch: dict[str, Any]) -> None:
    before = _snapshot(wo)
    _apply_fields(wo, {k: patch[k] for k in EDITABLE if k in patch})
    if "assignees" in patch:
        _set_assignees(wo, _resolve_assignees(org.id, patch["assignees"]))
    if "categories" in patch:
        _set_categories(wo, patch["categories"])
    after = _snapshot(wo)
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes:
        wo.version += 1
        touch(wo, m.user_id)
        emit(
            "wo.updated",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=label(wo),
            summary="Changed " + ", ".join(_FIELD_NAMES.get(k, k) for k in changes) + " (bulk edit)",
            changes=changes,
        )


__all__ = ["PRIORITY_LABELS", "Conflict", "RuleError"]
