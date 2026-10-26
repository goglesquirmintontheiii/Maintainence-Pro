"""Work requests and request portals: business rules (G-04).

MaintainX parity (r273–r300): anyone with `requests.create` reports a problem; people with `requests.approve` turn it
into a work order (optionally from a template) or decline it with a reason the requester sees. The request then
follows its work order: Done when the work order is done, Canceled when it's canceled or deleted. Requesters see the
work order's number and status, never the work order itself.

Public portals (r279, r300, r265) take requests from people without an account; they may leave an email to hear
about approval, decline and completion (r280) and always get a no-login status link (r603).
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, false, func, or_, select, update

from mpro.core.events import emit
from mpro.core.files import FileLink, FileObject, attach, file_dict, links_for, links_for_many
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.core.search import like
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team
from mpro.orgs.services import RuleError
from mpro.workorders.models import PRIORITIES, Comment, Counter, WorkOrder
from mpro.workrequests.models import STATUS_LABELS, PortalHit, RequestPortal, WorkRequest

# ---- settings (r275, r278, r295) --------------------------------------------------------------------
FIELD_KEYS = ("description", "priority", "location", "asset", "attachments")
FIELD_STATES = ("optional", "required", "hidden")
DEFAULTS: dict[str, Any] = {
    "fields": {k: "optional" for k in FIELD_KEYS},
    "assign_to": "optional",  # optional | required | hidden (r278)
    "allow_other": True,  # "Other" routes to every administrator
    "default_template_id": "",  # pre-selected when approving (r277)
}
register_defaults("requests", DEFAULTS)

TITLE_MAX = 255
DESCRIPTION_MAX = 4000
MAX_FILES = 10
ASSET_STATUSES = ("", "online", "offline")

# public portal limits (per IP unless noted)
LIMIT_PER_MINUTE = 60
LIMIT_FAILED_15MIN = 20
LIMIT_SUBMITS_PER_HOUR_IP = 10
LIMIT_SUBMITS_PER_HOUR_PORTAL = 200
LIMIT_UPLOADS_PER_HOUR_IP = 30


def request_field_ids(org_id: uuid.UUID) -> list[str]:
    """Work-order custom fields marked "Show on request forms" in Settings → Work orders (r295)."""
    from mpro.workorders.services import custom_fields

    return [str(f.id) for f in custom_fields(org_id) if f.on_request_form]


def settings(org_id: uuid.UUID) -> dict[str, Any]:
    s = get_settings(org_id, "requests")
    fields = {k: "optional" for k in FIELD_KEYS}
    fields.update({k: v for k, v in (s.get("fields") or {}).items() if k in FIELD_KEYS and v in FIELD_STATES})
    s["fields"] = fields
    return s


def _uuid(v: Any, what: str = "record") -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _custom_field_ids(org_id: uuid.UUID, raw: Any) -> list[str]:
    from mpro.workorders.services import custom_fields

    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > 50:
        raise RuleError("Pick up to 50 custom fields.", 422)
    known = {str(f.id) for f in custom_fields(org_id)}
    out = []
    for fid in raw:
        if str(fid) not in known:
            raise RuleError("One of the custom fields doesn't exist.", 422)
        if str(fid) not in out:
            out.append(str(fid))
    return out


def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    vals: dict[str, Any] = {}
    if "fields" in data:
        f = data["fields"]
        if not isinstance(f, dict) or any(k not in FIELD_KEYS or v not in FIELD_STATES for k, v in f.items()):
            raise RuleError("Each request field is optional, required or hidden.", 422)
        vals["fields"] = {**settings(org.id)["fields"], **f}
    if "assign_to" in data:
        if data["assign_to"] not in FIELD_STATES:
            raise RuleError("Assign to is optional, required or hidden.", 422)
        vals["assign_to"] = data["assign_to"]
    if "allow_other" in data:
        vals["allow_other"] = bool(data["allow_other"])
    if "default_template_id" in data:
        tid = data["default_template_id"] or ""
        if tid:
            _template(org.id, tid)
        vals["default_template_id"] = str(tid)
    unknown = set(data) - set(DEFAULTS)
    if unknown:
        raise RuleError("Unknown setting: " + ", ".join(sorted(unknown)) + ".", 422)
    out = save_settings(org.id, "requests", vals)
    emit("requests.settings_changed", entity_type="organization", entity_id=org.id, summary="Request settings changed",
         data={"keys": sorted(vals)}, org_id=org.id)  # fmt: skip
    db.session.commit()
    return {**settings(org.id), **{k: v for k, v in out.items() if k != "fields"}}


def _template(org_id: uuid.UUID, tid: Any) -> Any:
    from mpro.workorders.models import Template

    t = db.session.get(Template, _uuid(tid, "template"))
    if t is None or t.org_id != org_id or t.deleted_at is not None:
        raise RuleError("That template doesn't exist.", 422)
    return t


# ---- numbering ---------------------------------------------------------------------------------------
def _next_number(org_id: uuid.UUID) -> int:
    from sqlalchemy.exc import IntegrityError

    q = select(Counter).where(Counter.org_id == org_id, Counter.key == "work_request")
    if db.engine.dialect.name == "postgresql":
        q = q.with_for_update()
    c = db.session.scalars(q).first()
    if c is None:
        current = db.session.scalar(select(func.max(WorkRequest.number)).where(WorkRequest.org_id == org_id)) or 0
        try:
            with db.session.begin_nested():
                db.session.add(Counter(org_id=org_id, key="work_request", value=int(current)))
        except IntegrityError:
            pass
        c = db.session.scalars(q).first()
        assert c is not None
    res = db.session.execute(
        update(Counter).where(Counter.id == c.id).values(value=Counter.value + 1).returning(Counter.value)
    )
    return int(res.scalar_one())


# ---- validation shared by the app and portals --------------------------------------------------------
def _location(org_id: uuid.UUID, lid: Any) -> Any:
    from mpro.assets.models import Location

    loc = db.session.get(Location, _uuid(lid, "location"))
    if loc is None or loc.org_id != org_id or loc.deleted_at is not None:
        raise RuleError("That location doesn't exist.", 422)
    return loc


def _asset(org_id: uuid.UUID, aid: Any) -> Any:
    from mpro.assets.models import Asset

    a = db.session.get(Asset, _uuid(aid, "asset"))
    if a is None or a.org_id != org_id or a.deleted_at is not None:
        raise RuleError("That asset doesn't exist.", 422)
    return a


def _team(org_id: uuid.UUID, tid: Any) -> Team:
    t = db.session.get(Team, _uuid(tid, "team"))
    if t is None or t.org_id != org_id or t.deleted_at is not None:
        raise RuleError("That team doesn't exist.", 422)
    return t


def _customer(org_id: uuid.UUID, cid: Any) -> Any:
    from mpro.vendors.models import Customer

    c = db.session.get(Customer, _uuid(cid, "customer"))
    if c is None or c.org_id != org_id or c.deleted_at is not None:
        raise RuleError("That customer doesn't exist.", 422)
    return c


def _text(v: Any, limit: int, what: str, required: bool = False) -> str:
    s = str(v or "").strip()
    if required and not s:
        raise RuleError(f"{what} is required.", 422)
    if len(s) > limit:
        raise RuleError(f"{what} can be up to {limit:,} characters.", 422)
    return s


def _apply(
    org_id: uuid.UUID,
    r: WorkRequest,
    data: dict[str, Any],
    fields: dict[str, str],
    custom_ids: list[str],
    *,
    routing: tuple[str, bool] | None,
    m: Membership | None,
) -> None:
    """Fill a request from the form. `fields`: field -> optional/required/hidden; routing: (assign_to, allow_other)."""
    from mpro.workorders.services import _clean_custom

    if "title" in data or not r.title:
        r.title = _text(data.get("title"), TITLE_MAX, "Title", required=True)
    if fields["description"] != "hidden" and "description" in data:
        r.description = _text(data.get("description"), DESCRIPTION_MAX, "Description")
    if fields["priority"] != "hidden" and "priority" in data:
        p = data.get("priority") or "none"
        if p not in PRIORITIES:
            raise RuleError("Priority is none, low, medium or high.", 422)
        r.priority = p
    if fields["location"] != "hidden" and "location_id" in data:
        r.location_id = _location(org_id, data["location_id"]).id if data.get("location_id") else None
    if fields["asset"] != "hidden" and "asset_id" in data:
        if data.get("asset_id"):
            a = _asset(org_id, data["asset_id"])
            r.asset_id = a.id
            if r.location_id is None and a.location_id is not None:
                r.location_id = a.location_id  # the asset's location comes along, like on work orders
        else:
            r.asset_id = None
    if "asset_status" in data and fields["asset"] != "hidden":
        st = str(data.get("asset_status") or "")
        if st not in ASSET_STATUSES:
            raise RuleError("Asset status is online or offline.", 422)
        r.asset_status = st if r.asset_id else ""
    if routing is not None and routing[0] != "hidden" and ("team_id" in data or "route_other" in data):
        if data.get("route_other"):
            if not routing[1]:
                raise RuleError("Pick a team.", 422)
            r.team_id, r.route_other = None, True
        else:
            r.team_id = _team(org_id, data["team_id"]).id if data.get("team_id") else None
            r.route_other = False
    if "custom" in data:
        raw = data.get("custom") or {}
        if not isinstance(raw, dict):
            raise RuleError("Custom fields must be an object.", 422)
        raw = {k: v for k, v in raw.items() if str(k) in custom_ids}  # only the fields this form shows
        r.custom = _clean_custom(org_id, raw, existing=r.custom or {})
    # required checks
    missing = []
    if fields["description"] == "required" and not r.description:
        missing.append("Description")
    if fields["priority"] == "required" and r.priority == "none":
        missing.append("Priority")
    if fields["location"] == "required" and r.location_id is None:
        missing.append("Location")
    if fields["asset"] == "required" and r.asset_id is None:
        missing.append("Asset")
    if routing is not None and routing[0] == "required" and r.team_id is None and not r.route_other:
        missing.append("Assign to")
    from mpro.workorders.services import custom_fields

    for f in custom_fields(org_id):
        if str(f.id) in custom_ids and f.required and (r.custom or {}).get(str(f.id)) in (None, ""):
            missing.append(f.name)
    if missing:
        raise RuleError("Fill in the required fields: " + ", ".join(missing) + ".", 422)


def _attach_files(r: WorkRequest, file_ids: Any, uploader: uuid.UUID | None, portal_id: uuid.UUID | None) -> int:
    """Attach files uploaded earlier: by this person (app), or through this portal (public)."""
    if not file_ids:
        return 0
    if not isinstance(file_ids, list) or len(file_ids) > MAX_FILES:
        raise RuleError(f"Attach up to {MAX_FILES} files.", 422)
    n = 0
    for fid in file_ids:
        f = db.session.get(FileObject, _uuid(fid, "file"))
        ok = f is not None and f.org_id == r.org_id and f.deleted_at is None
        if ok and uploader is not None:
            ok = f is not None and f.uploaded_by_id == uploader
        if ok and uploader is None and f is not None:  # a portal upload: still parked on this portal
            ok = portal_id is not None and bool(
                db.session.scalar(
                    select(func.count())
                    .select_from(FileLink)
                    .where(
                        FileLink.file_id == f.id,
                        FileLink.entity_type == "request_portal_upload",
                        FileLink.entity_id == portal_id,
                    )
                )
            )
        if not ok or f is None:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        attach(f, "work_request", r.id, "photo" if f.is_image else "file")
        if uploader is None:
            db.session.execute(
                delete(FileLink).where(
                    FileLink.file_id == f.id,
                    FileLink.entity_type == "request_portal_upload",
                    FileLink.entity_id == portal_id,
                )
            )
        n += 1
    return n


# ---- visibility ------------------------------------------------------------------------------------
def can_view(m: Membership | None, r: WorkRequest) -> bool:
    if m is None or r.org_id != m.org_id or r.deleted_at is not None:
        return False
    if can(m, "requests.view_all") and m.role != "guest":
        return True
    return can(m, "requests.view") and r.created_by_id == m.user_id


def can_edit(m: Membership | None, r: WorkRequest) -> bool:
    if m is None or not can_view(m, r) or r.status != "pending":
        return False
    return can(m, "requests.approve") or r.created_by_id == m.user_id


def visibility(m: Membership) -> Any:
    if can(m, "requests.view_all") and m.role != "guest":
        return None
    return WorkRequest.created_by_id == m.user_id


def get_request(m: Membership, rid: Any) -> WorkRequest:
    try:
        r = db.session.get(WorkRequest, uuid.UUID(str(rid)))
    except ValueError:
        r = None
    if r is None or not can_view(m, r):
        raise RuleError("That request doesn't exist.", 404)
    return r


# ---- serialization -------------------------------------------------------------------------------------
def _person(uid: uuid.UUID | None) -> dict[str, Any] | None:
    from mpro.auth.models import User
    from mpro.workorders.queries import _person as person

    return person(db.session.get(User, uid)) if uid else None


def request_dict(
    r: WorkRequest, m: Membership | None, files: list[Any] | None = None, full: bool = False
) -> dict[str, Any]:
    from mpro.assets.models import Asset, Location

    loc = db.session.get(Location, r.location_id) if r.location_id else None
    asset = db.session.get(Asset, r.asset_id) if r.asset_id else None
    team = db.session.get(Team, r.team_id) if r.team_id else None
    wo = db.session.get(WorkOrder, r.work_order_id) if r.work_order_id else None
    wo_out = None
    if wo is not None and wo.deleted_at is None:
        from mpro.workorders.services import can_see

        wo_out = {
            "number": wo.number,
            "status": wo.status,
            # the requester sees the number and status only (r277); people who may see the work order get its id
            "id": str(wo.id) if m is not None and can_see(m, wo) else None,
        }
    elif wo is not None:
        wo_out = {"number": wo.number, "status": "deleted", "id": None}
    staff = m is not None and can(m, "requests.view_all") and m.role != "guest"
    out: dict[str, Any] = {
        "id": str(r.id),
        "number": r.number,
        "title": r.title,
        "description": r.description,
        "priority": r.priority,
        "status": r.status,
        "status_label": STATUS_LABELS.get(r.status, r.status),
        "location": {"id": str(loc.id), "name": loc.name} if loc is not None and loc.deleted_at is None else None,
        "asset": {"id": str(asset.id), "name": asset.name} if asset is not None and asset.deleted_at is None else None,
        "asset_status": r.asset_status,
        "team": {"id": str(team.id), "name": team.name, "color": team.color} if team is not None else None,
        "route_other": r.route_other,
        "custom": r.custom or {},
        "source": r.source,
        "work_order": wo_out,
        "decline_reason": r.decline_reason,
        "created_by": _person(r.created_by_id),
        "submitter": (
            {
                "name": r.submitter_name,
                "email": r.submitter_email if staff else "",
                "phone": r.submitter_phone if staff else "",
            }
            if r.created_by_id is None
            else None
        ),
        "portal_id": str(r.portal_id) if r.portal_id and staff else None,
        "customer_id": str(r.customer_id) if r.customer_id and staff else None,
        "decided_by": _person(r.decided_by_id),
        "decided_at": iso(r.decided_at),
        "new": r.status == "pending" and r.seen_at is None,
        "created_at": iso(r.created_at),
        "updated_at": iso(r.updated_at),
        "can_edit": can_edit(m, r),
        "can_decide": m is not None and r.status == "pending" and can(m, "requests.approve"),
        "files": [file_dict(link.file, link.role, link.id) for link in (files or [])],
    }
    if full:
        out["comments"] = comments(r)
        if r.customer_id and staff:
            from mpro.vendors.models import Customer

            c = db.session.get(Customer, r.customer_id)
            out["customer"] = {"id": str(c.id), "name": c.name} if c is not None else None
        if r.portal_id and staff:
            p = db.session.get(RequestPortal, r.portal_id)
            out["portal"] = {"id": str(p.id), "name": p.name} if p is not None else None
    return out


# ---- list / search (r298) ----------------------------------------------------------------------------
def list_requests(m: Membership, params: dict[str, Any]) -> dict[str, Any]:
    q = select(WorkRequest).where(WorkRequest.org_id == m.org_id, WorkRequest.deleted_at.is_(None))
    vis = visibility(m)
    if vis is not None:
        q = q.where(vis)
    status = params.get("status") or ""
    if status == "open":
        q = q.where(WorkRequest.status == "pending")
    elif status:
        sts = [s for s in str(status).split(",") if s in STATUS_LABELS]
        if sts:
            q = q.where(WorkRequest.status.in_(sts))
    if params.get("mine") == "1":
        q = q.where(WorkRequest.created_by_id == m.user_id)
    if params.get("team") == "mine":
        from mpro.workorders.services import team_ids_of

        teams = team_ids_of(m.org_id, m.user_id)
        team_conds: list[Any] = [WorkRequest.team_id.in_(teams or [uuid.uuid4()])]
        if can(m, "requests.approve") and m.role in ("owner", "admin"):
            team_conds.append(WorkRequest.route_other.is_(True))
        q = q.where(or_(*team_conds))
    for key, col in (("location_id", WorkRequest.location_id), ("asset_id", WorkRequest.asset_id),
                     ("portal_id", WorkRequest.portal_id), ("customer_id", WorkRequest.customer_id)):  # fmt: skip
        if params.get(key):
            try:
                q = q.where(col == uuid.UUID(str(params[key])))
            except ValueError:
                q = q.where(false())
    text = str(params.get("q") or "").strip()
    if text:
        num = text.lstrip("#")
        conds: list[Any] = [
            func.lower(WorkRequest.title).like(like(text), escape="\\"),
            func.lower(WorkRequest.description).like(like(text), escape="\\"),
        ]
        if num.isdigit():
            n = int(num)
            conds.append(WorkRequest.number == n)
            wo_ids = select(WorkOrder.id).where(WorkOrder.org_id == m.org_id, WorkOrder.number == n)
            conds.append(WorkRequest.work_order_id.in_(wo_ids))  # search by linked work order ID (r298)
        q = q.where(or_(*conds))
    total = db.session.scalar(select(func.count()).select_from(q.subquery())) or 0
    sort = params.get("sort") or "-created_at"
    order: Any = {
        "-created_at": WorkRequest.created_at.desc(),
        "created_at": WorkRequest.created_at.asc(),
        "-updated_at": WorkRequest.updated_at.desc(),
        "-number": WorkRequest.number.desc(),
    }.get(sort, WorkRequest.created_at.desc())
    try:
        per_page = max(1, min(100, int(params.get("per_page") or 40)))
        page = max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("Page and per_page must be numbers.", 422) from e
    rows = db.session.scalars(
        q.order_by(order, WorkRequest.id.desc()).limit(per_page).offset((page - 1) * per_page)
    ).all()
    files = links_for_many("work_request", [r.id for r in rows])
    return {
        "items": [request_dict(r, m, files.get(r.id, [])) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def badge(m: Membership) -> dict[str, int]:
    """The sidebar badge (r299): new requests to review for approvers; otherwise nothing."""
    if not can(m, "requests.approve"):
        return {"new": 0}
    n = db.session.scalar(
        select(func.count())
        .select_from(WorkRequest)
        .where(
            WorkRequest.org_id == m.org_id,
            WorkRequest.deleted_at.is_(None),
            WorkRequest.status == "pending",
            WorkRequest.seen_at.is_(None),
        )
    )
    return {"new": int(n or 0)}


def mark_seen(m: Membership, r: WorkRequest) -> None:
    if r.seen_at is None and r.status == "pending" and can(m, "requests.approve"):
        r.seen_at = utcnow()
        db.session.commit()


# ---- create / edit ----------------------------------------------------------------------------------
def _emit(r: WorkRequest, type_: str, summary: str, **data: Any) -> None:
    emit(
        type_,
        entity_type="work_request",
        entity_id=r.id,
        entity_label=f"Request #{r.number}: {r.title}"[:300],
        summary=summary,
        data={
            "number": r.number,
            "status": r.status,
            "created_by_id": r.created_by_id,
            "team_id": r.team_id,
            "route_other": r.route_other,
            "location_id": r.location_id,
            "asset_id": r.asset_id,
            "priority": r.priority,
            "portal_id": r.portal_id,
            "customer_id": r.customer_id,
            "work_order_id": r.work_order_id,
            "notify_email": bool(r.notify_email and r.submitter_email),
            **data,
        },
        org_id=r.org_id,
    )


def create_request(org: Organization, m: Membership, data: dict[str, Any], source: str = "app") -> WorkRequest:
    s = settings(org.id)
    src = source if source in ("app", "qr") else "app"
    r = WorkRequest(org_id=org.id, created_by_id=m.user_id, status="pending", source=src,
                    custom={}, priority="none", description="", asset_status="")  # fmt: skip
    _apply(org.id, r, data, s["fields"], request_field_ids(org.id), routing=(s["assign_to"], s["allow_other"]), m=m)
    if m.role == "guest" and r.location_id is not None:
        from mpro.workrequests.guests import access_of, can_see_location

        if not can_see_location(m, r.location_id):
            raise RuleError("Pick one of your locations.", 422)
        a = access_of(org.id, m.user_id)
        r.customer_id = a.customer_id if a is not None else None
    files = data.get("file_ids") or []
    if s["fields"]["attachments"] == "required" and not files:
        raise RuleError("Fill in the required fields: Attachments.", 422)
    if s["fields"]["attachments"] == "hidden":
        files = []
    r.number = _next_number(org.id)
    db.session.add(r)
    db.session.flush()
    _attach_files(r, files, m.user_id, None)
    _emit(r, "request.created", f"Request #{r.number} submitted", source=r.source)
    db.session.commit()
    return r


EDITABLE = (
    "title",
    "description",
    "priority",
    "location_id",
    "asset_id",
    "asset_status",
    "team_id",
    "route_other",
    "custom",
)


def update_request(org: Organization, m: Membership, r: WorkRequest, data: dict[str, Any]) -> WorkRequest:
    if not can_edit(m, r):
        raise RuleError(
            "Only pending requests can be changed." if r.status != "pending" else "You can't change this request.",
            403 if r.status == "pending" else 409,
        )
    bad = set(data) - set(EDITABLE)
    if bad:
        raise RuleError("Can't change " + ", ".join(sorted(bad)) + ".", 422)
    s = settings(org.id)
    before = {k: getattr(r, k) for k in ("title", "description", "priority", "location_id", "asset_id", "team_id")}
    _apply(org.id, r, data, s["fields"], request_field_ids(org.id), routing=(s["assign_to"], s["allow_other"]), m=m)
    if m.role == "guest" and r.location_id is not None:
        from mpro.workrequests.guests import can_see_location

        if not can_see_location(m, r.location_id):
            raise RuleError("Pick one of your locations.", 422)
    changes = {k: (v, getattr(r, k)) for k, v in before.items() if getattr(r, k) != v}
    r.updated_at = utcnow()
    emit("request.updated", entity_type="work_request", entity_id=r.id, entity_label=f"Request #{r.number}",
         summary=f"Edited request #{r.number}", changes=changes, org_id=org.id)  # fmt: skip
    db.session.commit()
    return r


def add_files(org: Organization, m: Membership, r: WorkRequest, file_ids: Any) -> None:
    if not can_edit(m, r):
        raise RuleError("You can't add files to this request.", 403)
    have = len(links_for("work_request", r.id))
    if have + len(file_ids or []) > MAX_FILES:
        raise RuleError(f"A request can have up to {MAX_FILES} files.", 422)
    _attach_files(r, file_ids, m.user_id, None)
    db.session.commit()


def duplicate_request(org: Organization, m: Membership, r: WorkRequest) -> WorkRequest:
    """Copy a pending or declined request (r296) as a new pending one by this person."""
    if r.status not in ("pending", "declined"):
        raise RuleError("Only pending or declined requests can be duplicated.", 409)
    if not can(m, "requests.create"):
        raise RuleError("You can't submit requests.", 403)
    data: dict[str, Any] = {
        "title": r.title, "description": r.description, "priority": r.priority,
        "location_id": str(r.location_id) if r.location_id else None,
        "asset_id": str(r.asset_id) if r.asset_id else None, "asset_status": r.asset_status,
        "team_id": str(r.team_id) if r.team_id else None, "route_other": r.route_other, "custom": dict(r.custom or {}),
    }  # fmt: skip
    new = create_request(org, m, data)
    for link in links_for("work_request", r.id):  # the same pictures, without uploading them again
        attach(link.file, "work_request", new.id, link.role)
    db.session.commit()
    return new


def cancel_request(org: Organization, m: Membership, r: WorkRequest) -> None:
    """The requester takes back a pending request (or an approver removes it)."""
    if r.status != "pending":
        raise RuleError("Only pending requests can be canceled.", 409)
    if not (r.created_by_id == m.user_id or can(m, "requests.approve")):
        raise RuleError("You can't cancel this request.", 403)
    _set_status(r, "canceled", m.user_id)
    _emit(r, "request.canceled", f"Request #{r.number} canceled")
    db.session.commit()


def _set_status(r: WorkRequest, status: str, actor_id: uuid.UUID | None) -> str:
    old = r.status
    r.status = status
    r.status_changed_at = utcnow()
    r.updated_at = utcnow()
    return old


# ---- approve / decline (r277, r297) --------------------------------------------------------------------
def _lock(r: WorkRequest) -> WorkRequest:
    q = select(WorkRequest).where(WorkRequest.id == r.id)
    if db.engine.dialect.name == "postgresql":
        q = q.with_for_update()
    db.session.refresh(r)
    locked = db.session.scalars(q).first()
    assert locked is not None
    return locked


APPROVE_KEYS = {"template_id", "title", "description", "priority", "assignees", "due_at", "start_at", "categories"}


def approve(org: Organization, m: Membership, r: WorkRequest, data: dict[str, Any]) -> WorkOrder:
    from mpro.workorders.services import create_work_order, due_days

    if not can(m, "requests.approve"):
        raise RuleError("You can't approve requests.", 403)
    bad = set(data) - APPROVE_KEYS
    if bad:
        raise RuleError("Can't set " + ", ".join(sorted(bad)) + " when approving.", 422)
    r = _lock(r)
    if r.status != "pending":
        raise RuleError("This request has already been " + STATUS_LABELS.get(r.status, r.status).lower() + ".", 409)
    wo_data: dict[str, Any] = {}
    t = None
    if data.get("template_id"):
        t = _template(org.id, data["template_id"])
        wo_data = {k: v for k, v in (t.data or {}).items() if k != "due_in_days"}
        if (t.data or {}).get("due_in_days") not in (None, ""):
            due = utcnow().replace(hour=17, minute=0, second=0, microsecond=0) + timedelta(
                days=due_days(t.data["due_in_days"])
            )
            wo_data["due_at"] = due.isoformat()
        wo_data.pop("asset_id", None)
        wo_data.pop("asset_ids", None)
        wo_data.pop("location_id", None)
        wo_data["template_id"] = str(t.id)
    # the request's own fields win over the template's (the requester described this problem)
    wo_data["title"] = r.title
    if r.description:
        wo_data["description"] = r.description
    if r.priority != "none" or "priority" not in wo_data:
        wo_data["priority"] = r.priority
    if r.asset_id:
        wo_data["asset_id"] = str(r.asset_id)
    if r.location_id:
        wo_data["location_id"] = str(r.location_id)
    if r.custom:
        wo_data["custom"] = {**(wo_data.get("custom") or {}), **r.custom}
    if r.team_id and not data.get("assignees") and not wo_data.get("assignees"):
        wo_data["assignees"] = [f"team:{r.team_id}"]  # routed to a team: the team gets the work (r278)
    for k in ("title", "description", "priority", "assignees", "due_at", "start_at", "categories"):
        if k in data:
            wo_data[k] = data[k]
    if r.asset_status and r.asset_id and can(m, "assets.status"):
        wo_data["asset_status"] = {"status": r.asset_status, "reason": f"Reported in request #{r.number}"}
    wo = create_work_order(org, m, wo_data, commit=False, check_required=True)
    for link in links_for("work_request", r.id):  # the requester's photos come along to the work order
        attach(link.file, "work_order", wo.id, link.role)
    if t is not None:
        t.use_count = (t.use_count or 0) + 1
        t.last_used_at = utcnow()
    r.work_order_id = wo.id
    r.decided_by_id = m.user_id
    r.decided_at = utcnow()
    _set_status(r, "approved", m.user_id)
    _emit(r, "request.approved", f"Approved request #{r.number} as work order #{wo.number}",
          work_order_number=wo.number, decided_by_id=m.user_id)  # fmt: skip
    emit("wo.from_request", entity_type="work_order", entity_id=wo.id, entity_label=f"#{wo.number} {wo.title}"[:300],
         summary=f"Created from request #{r.number}", data={"request_id": r.id, "request_number": r.number},
         org_id=org.id)  # fmt: skip
    db.session.commit()
    return wo


def decline(org: Organization, m: Membership, r: WorkRequest, reason: str) -> WorkRequest:
    if not can(m, "requests.approve"):
        raise RuleError("You can't decline requests.", 403)
    reason = _text(reason, 2000, "A reason", required=True)
    r = _lock(r)
    if r.status != "pending":
        raise RuleError("This request has already been " + STATUS_LABELS.get(r.status, r.status).lower() + ".", 409)
    r.decline_reason = reason
    r.decided_by_id = m.user_id
    r.decided_at = utcnow()
    _set_status(r, "declined", m.user_id)
    _emit(r, "request.declined", f"Declined request #{r.number}", reason=reason, decided_by_id=m.user_id)
    db.session.commit()
    return r


# ---- follow the work order (r273) -------------------------------------------------------------------
WO_TO_REQUEST = {"done": "done", "canceled": "canceled"}


def _follow(wo: WorkOrder, to: str) -> None:
    rows = db.session.scalars(
        select(WorkRequest).where(
            WorkRequest.org_id == wo.org_id, WorkRequest.work_order_id == wo.id, WorkRequest.deleted_at.is_(None)
        )
    ).all()
    for r in rows:
        if r.status == to or r.status in ("declined",):
            continue
        old = _set_status(r, to, None)
        _emit(r, "request.status_changed", f"Request #{r.number} is now {STATUS_LABELS[to]}",
              **{"from": old, "to": to, "work_order_number": wo.number, "work_order_status": wo.status})  # fmt: skip


def on_wo_status(org: Organization, m: Membership, wo: WorkOrder, from_status: str, to_status: str) -> None:
    """STATUS_HOOK: Done / Canceled close the request; reopening the work order brings it back to Approved."""
    if to_status in WO_TO_REQUEST:
        _follow(wo, WO_TO_REQUEST[to_status])
    elif from_status in WO_TO_REQUEST:
        _follow(wo, "approved")
    else:  # status moved between open states: requesters still hear about it (r282)
        for r in db.session.scalars(
            select(WorkRequest).where(WorkRequest.work_order_id == wo.id, WorkRequest.deleted_at.is_(None))
        ).all():
            _emit(r, "request.work_order_status", f"Work order #{wo.number} is {wo.status.replace('_', ' ')}",
                  work_order_number=wo.number, work_order_status=to_status, **{"from": from_status})  # fmt: skip


def on_wo_deleted(wo_id: uuid.UUID, restored: bool) -> None:
    wo = db.session.get(WorkOrder, wo_id)
    if wo is None:
        return
    if restored:
        _follow(wo, WO_TO_REQUEST.get(wo.status, "approved"))
    else:
        _follow(wo, "canceled")
    db.session.commit()


# ---- comments ------------------------------------------------------------------------------------------
def comments(r: WorkRequest) -> list[dict[str, Any]]:
    from mpro.workorders.activity import comment_dict

    rows = db.session.scalars(
        select(Comment)
        .where(Comment.org_id == r.org_id, Comment.entity_type == "work_request", Comment.entity_id == r.id)
        .order_by(Comment.created_at)
    ).all()
    return [comment_dict(c) for c in rows]


def add_comment(org: Organization, m: Membership, r: WorkRequest, body: str) -> dict[str, Any]:
    from mpro.workorders.activity import comment_dict, parse_mentions

    if not can_view(m, r):
        raise RuleError("That request doesn't exist.", 404)
    body = _text(body, 10000, "Comment", required=True)
    mentions = (
        parse_mentions(org.id, body)
        if can(m, "requests.view_all") and m.role != "guest"
        else {"users": [], "teams": []}
    )
    c = Comment(
        org_id=org.id, entity_type="work_request", entity_id=r.id, author_id=m.user_id, body=body, mentions=mentions
    )
    db.session.add(c)
    db.session.flush()
    r.updated_at = utcnow()
    _emit(r, "request.commented", f"Comment on request #{r.number}", comment_id=c.id, author_id=m.user_id,
          mentions=mentions, excerpt=body[:200])  # fmt: skip
    db.session.commit()
    return comment_dict(c)


# ---- portals (r279, r300, r265) -------------------------------------------------------------------------
def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "requests"
    return f"{base}-{secrets.token_hex(3)}"


def portal_dict(p: RequestPortal, full: bool = True) -> dict[str, Any]:
    from mpro.assets.models import Asset, Location

    loc = db.session.get(Location, p.location_id) if p.location_id else None
    asset = db.session.get(Asset, p.asset_id) if p.asset_id else None
    team = db.session.get(Team, p.team_id) if p.team_id else None
    cust = None
    if p.customer_id:
        from mpro.vendors.models import Customer

        cust = db.session.get(Customer, p.customer_id)
    fields = {k: "optional" for k in FIELD_KEYS}
    fields.update({k: v for k, v in (p.fields or {}).items() if k in FIELD_KEYS and v in FIELD_STATES})
    out: dict[str, Any] = {
        "id": str(p.id),
        "name": p.name,
        "slug": p.slug,
        "path": f"/portal/{p.slug}",
        "intro": p.intro,
        "active": p.active,
        "fields": fields,
        "custom_field_ids": list(p.custom_field_ids or []),
        "location": {"id": str(loc.id), "name": loc.name} if loc is not None else None,
        "asset": {"id": str(asset.id), "name": asset.name} if asset is not None else None,
        "team": {"id": str(team.id), "name": team.name} if team is not None else None,
        "customer": {"id": str(cust.id), "name": cust.name} if cust is not None else None,
        "require_email": p.require_email,
        "created_at": iso(p.created_at),
    }
    if full:
        out["request_count"] = int(
            db.session.scalar(
                select(func.count())
                .select_from(WorkRequest)
                .where(WorkRequest.portal_id == p.id, WorkRequest.deleted_at.is_(None))
            )
            or 0
        )
    return out


def check_portals_entitled(org: Organization) -> None:
    from mpro.core.entitlements import entitlements_for

    if not entitlements_for(org).can_use("request_portals"):
        raise RuleError("Request portals aren't included in this plan.", 403)


def list_portals(org_id: uuid.UUID, customer_id: str | None = None) -> list[dict[str, Any]]:
    q = select(RequestPortal).where(RequestPortal.org_id == org_id, RequestPortal.deleted_at.is_(None))
    if customer_id:
        try:
            q = q.where(RequestPortal.customer_id == uuid.UUID(customer_id))
        except ValueError:
            return []
    return [portal_dict(p) for p in db.session.scalars(q.order_by(RequestPortal.name)).all()]


def get_portal(org_id: uuid.UUID, pid: Any) -> RequestPortal:
    try:
        p = db.session.get(RequestPortal, uuid.UUID(str(pid)))
    except ValueError:
        p = None
    if p is None or p.org_id != org_id or p.deleted_at is not None:
        raise RuleError("That portal doesn't exist.", 404)
    return p


def save_portal(
    org: Organization, m: Membership, data: dict[str, Any], p: RequestPortal | None = None
) -> RequestPortal:
    check_portals_entitled(org)
    allowed = {"name", "intro", "active", "fields", "custom_field_ids", "location_id", "asset_id", "team_id",
               "customer_id", "require_email"}  # fmt: skip
    bad = set(data) - allowed
    if bad:
        raise RuleError("Unknown portal setting: " + ", ".join(sorted(bad)) + ".", 422)
    new = p is None
    if p is None:
        p = RequestPortal(org_id=org.id, created_by_id=m.user_id, fields={k: "optional" for k in FIELD_KEYS},
                          custom_field_ids=[], active=True, intro="", require_email=False)  # fmt: skip
    if "name" in data or new:
        p.name = _text(data.get("name"), 200, "Name", required=True)
    if "intro" in data:
        p.intro = _text(data.get("intro"), 4000, "Intro")
    if "active" in data:
        p.active = bool(data["active"])
    if "require_email" in data:
        p.require_email = bool(data["require_email"])
    if "fields" in data:
        f = data["fields"]
        if not isinstance(f, dict) or any(k not in FIELD_KEYS or v not in FIELD_STATES for k, v in f.items()):
            raise RuleError("Each portal field is optional, required or hidden.", 422)
        p.fields = {**(p.fields or {}), **f}
    if "custom_field_ids" in data:
        p.custom_field_ids = _custom_field_ids(org.id, data["custom_field_ids"])
    if "location_id" in data:
        p.location_id = _location(org.id, data["location_id"]).id if data["location_id"] else None
    if "asset_id" in data:
        p.asset_id = _asset(org.id, data["asset_id"]).id if data["asset_id"] else None
    if "team_id" in data:
        p.team_id = _team(org.id, data["team_id"]).id if data["team_id"] else None
    if "customer_id" in data:
        p.customer_id = _customer(org.id, data["customer_id"]).id if data["customer_id"] else None
    if new:
        p.slug = _slugify(p.name)
        while db.session.scalar(select(RequestPortal.id).where(RequestPortal.slug == p.slug)):
            p.slug = _slugify(p.name)
        db.session.add(p)
    db.session.flush()
    verb = "Created" if new else "Changed"
    emit("request_portal.created" if new else "request_portal.updated", entity_type="request_portal", entity_id=p.id,
         entity_label=p.name, summary=f"{verb} request portal {p.name}", org_id=org.id)  # fmt: skip
    db.session.commit()
    return p


def delete_portal(org: Organization, p: RequestPortal) -> None:
    p.deleted_at = utcnow()
    p.active = False
    emit("request_portal.deleted", entity_type="request_portal", entity_id=p.id, entity_label=p.name,
         summary=f"Deleted request portal {p.name}", org_id=org.id)  # fmt: skip
    db.session.commit()


def portal_qr_svg(p: RequestPortal, base_url: str, asset_id: str | None, location_id: str | None) -> str:
    import io

    import segno

    url = base_url.rstrip("/") + f"/portal/{p.slug}"
    if asset_id:
        url += f"?asset={_asset(p.org_id, asset_id).id}"
    elif location_id:
        url += f"?location={_location(p.org_id, location_id).id}"
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=8, border=2)
    return buf.getvalue().decode()


# ---- public side (no login) -------------------------------------------------------------------------------
def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_rate(ip: str, portal: RequestPortal | None, ok: bool, kind: str = "") -> None:
    """Count this public request and refuse when an IP (or a portal) is too busy. Wrong links count towards the
    failed-attempt limit, so guessing portal slugs or status tokens gets blocked quickly."""
    now = utcnow()
    ip = (ip or "")[:64]

    def n(*conds: Any) -> int:
        return int(db.session.scalar(select(func.count()).select_from(PortalHit).where(*conds)) or 0)

    per_min = n(PortalHit.ip == ip, PortalHit.at >= now - timedelta(minutes=1))
    failed = n(PortalHit.ip == ip, PortalHit.ok.is_(False), PortalHit.at >= now - timedelta(minutes=15))
    submits_ip = (
        n(PortalHit.ip == ip, PortalHit.write.is_(True), PortalHit.at >= now - timedelta(hours=1)) if kind else 0
    )
    submits_portal = (
        n(PortalHit.portal_id == portal.id, PortalHit.write.is_(True), PortalHit.at >= now - timedelta(hours=1))
        if kind == "submit" and portal is not None
        else 0
    )
    db.session.add(PortalHit(ip=ip, portal_id=portal.id if portal else None, ok=ok, write=bool(kind), at=now))
    db.session.execute(delete(PortalHit).where(PortalHit.at < now - timedelta(days=1)))
    db.session.commit()
    if per_min >= LIMIT_PER_MINUTE or failed >= LIMIT_FAILED_15MIN:
        raise RuleError("Too many requests. Wait a few minutes and try again.", 429)
    if kind == "submit" and (
        submits_ip >= LIMIT_SUBMITS_PER_HOUR_IP or submits_portal >= LIMIT_SUBMITS_PER_HOUR_PORTAL
    ):
        raise RuleError("Too many requests from here in the last hour. Try again later.", 429)
    if kind == "upload" and submits_ip >= LIMIT_UPLOADS_PER_HOUR_IP:
        raise RuleError("Too many uploads from here in the last hour. Try again later.", 429)


def resolve_portal(slug: str, ip: str) -> tuple[RequestPortal, Organization]:
    p = None
    if slug and len(slug) <= 80:
        p = db.session.scalars(select(RequestPortal).where(RequestPortal.slug == slug)).first()
    org = db.session.get(Organization, p.org_id) if p is not None else None
    ok = (
        p is not None
        and p.deleted_at is None
        and p.active
        and org is not None
        and getattr(org, "deleted_at", None) is None
    )
    check_rate(ip, p if ok else None, ok)
    if not ok or p is None or org is None:
        raise RuleError("This request form isn't available.", 404)
    from mpro.core.entitlements import entitlements_for

    if not entitlements_for(org).can_use("request_portals"):
        raise RuleError("This request form isn't available.", 404)
    return p, org


def public_portal(p: RequestPortal, org: Organization, asset_id: str | None, location_id: str | None) -> dict[str, Any]:
    """What the public form needs, and nothing more: no lists of the organization's assets or locations."""
    from mpro.workorders.services import custom_fields

    out = portal_dict(p, full=False)
    out = {k: out[k] for k in ("name", "intro", "fields", "require_email")}
    out["org_name"] = org.name
    # a pre-targeted portal (r300) or a sticker link (?asset= / ?location=) names the one place it's about
    target_asset = p.asset_id
    target_loc = p.location_id
    if asset_id:
        try:
            a = _asset(p.org_id, asset_id)
            if p.location_id is None or _within(a.location_id, p.location_id):
                target_asset, target_loc = a.id, a.location_id
        except RuleError:
            pass
    elif location_id:
        try:
            loc = _location(p.org_id, location_id)
            if p.location_id is None or _within(loc.id, p.location_id):
                target_loc = loc.id
        except RuleError:
            pass
    from mpro.assets.models import Asset, Location

    a = db.session.get(Asset, target_asset) if target_asset else None
    loc = db.session.get(Location, target_loc) if target_loc else None
    out["asset"] = {"id": str(a.id), "name": a.name} if a is not None and a.deleted_at is None else None
    out["location"] = {"id": str(loc.id), "name": loc.name} if loc is not None and loc.deleted_at is None else None
    wanted = set(p.custom_field_ids or [])
    out["custom_fields"] = [
        {
            "id": str(f.id),
            "name": f.name,
            "type": f.type,
            "options": list(f.options or []),
            "required": bool(f.required),
        }
        for f in custom_fields(p.org_id)
        if str(f.id) in wanted and f.type not in ("currency",)
    ]
    return out


def _within(node: uuid.UUID | None, root: uuid.UUID) -> bool:
    if node is None:
        return False
    from mpro.core.hierarchy import TreePath

    return bool(
        db.session.scalar(
            select(TreePath.id).where(
                TreePath.kind == "location", TreePath.ancestor_id == root, TreePath.descendant_id == node
            )
        )
    )


def _email(v: Any, required: bool) -> str:
    e = str(v or "").strip()
    if not e:
        if required:
            raise RuleError("Enter your email address.", 422)
        return ""
    if len(e) > 320 or not re.fullmatch(r"[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+", e):
        raise RuleError("Enter a valid email address.", 422)
    return e


def public_submit(p: RequestPortal, org: Organization, data: dict[str, Any], ip: str) -> dict[str, Any]:
    """A request from someone without an account. Returns the status link token once (r603)."""
    check_rate(ip, p, True, "submit")
    fields = {k: "optional" for k in FIELD_KEYS}
    fields.update({k: v for k, v in (p.fields or {}).items() if k in FIELD_KEYS and v in FIELD_STATES})
    allowed = {"title", "description", "priority", "asset_id", "location_id", "asset_status", "custom", "file_ids",
               "name", "email", "phone", "notify_email", "website"}  # fmt: skip
    data = {k: v for k, v in data.items() if k in allowed}
    if str(data.get("website") or ""):  # a hidden field people never fill in: bots do
        raise RuleError("Request refused.", 422)
    r = WorkRequest(org_id=org.id, created_by_id=None, status="pending", source="portal", portal_id=p.id, custom={},
                    priority="none", description="", asset_status="", customer_id=p.customer_id)  # fmt: skip
    # pre-targeted portals keep their place; a sticker link may narrow it, but never outside it
    form = dict(data)
    if p.asset_id:
        form["asset_id"] = str(p.asset_id)
    if p.location_id:
        lid = form.get("location_id")
        if not lid or not _within(_uuid(lid, "location"), p.location_id):
            form["location_id"] = str(p.location_id)
        aid = form.get("asset_id")
        if aid and not p.asset_id:
            a = _asset(org.id, aid)
            if not _within(a.location_id, p.location_id):
                raise RuleError("That asset isn't covered by this form.", 422)
    if p.customer_id and not form.get("location_id"):
        from mpro.vendors.models import Customer

        c = db.session.get(Customer, p.customer_id)
        if c is not None and c.default_location_id:
            form["location_id"] = str(c.default_location_id)
    _apply(org.id, r, form, fields, list(p.custom_field_ids or []), routing=None, m=None)
    r.team_id = p.team_id
    r.submitter_name = _text(data.get("name"), 200, "Your name", required=True)
    r.submitter_email = _email(data.get("email"), p.require_email or bool(data.get("notify_email")))
    r.submitter_phone = _text(data.get("phone"), 60, "Phone")
    r.notify_email = bool(data.get("notify_email")) and bool(r.submitter_email)
    files = data.get("file_ids") or []
    if fields["attachments"] == "required" and not files:
        raise RuleError("Fill in the required fields: Attachments.", 422)
    if fields["attachments"] == "hidden":
        files = []
    token = secrets.token_urlsafe(24)
    r.status_token_hash = token_hash(token)
    r.number = _next_number(org.id)
    db.session.add(r)
    db.session.flush()
    _attach_files(r, files, None, p.id)
    from mpro.workrequests.emails import confirmation

    confirmation(r, token)
    _emit(r, "request.created", f"Request #{r.number} submitted through {p.name}", source="portal",
          submitter_name=r.submitter_name)  # fmt: skip
    db.session.commit()
    return {"number": r.number, "status_token": token, "status_path": f"/request-status/{token}"}


def public_upload(p: RequestPortal, org: Organization, up: Any, ip: str) -> dict[str, Any]:
    from mpro.core.files import IMAGE_TYPES, save_file_stream

    check_rate(ip, p, True, "upload")
    name = str(up.filename or "").lower()
    if not name.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".avif", ".pdf", ".mp4", ".mov")):
        raise RuleError("Attach pictures, videos or PDFs.", 422)
    f = save_file_stream(org.id, up.filename, up.stream, None, org)
    if f.content_type not in IMAGE_TYPES | {"application/pdf", "video/mp4", "video/quicktime"}:
        db.session.rollback()
        raise RuleError("Attach pictures, videos or PDFs.", 422)
    attach(f, "request_portal_upload", p.id, "file")  # parked here until a request claims it
    db.session.commit()
    return {"id": str(f.id), "name": f.name, "is_image": f.is_image}


def status_by_token(token: str, ip: str) -> dict[str, Any]:
    r = None
    if token and 10 <= len(token) <= 100:
        r = db.session.scalars(select(WorkRequest).where(WorkRequest.status_token_hash == token_hash(token))).first()
    ok = r is not None and r.deleted_at is None
    check_rate(ip, None, ok)
    if r is None or not ok:
        raise RuleError("This status link isn't valid.", 404)
    org = db.session.get(Organization, r.org_id)
    wo = db.session.get(WorkOrder, r.work_order_id) if r.work_order_id else None
    return {
        "org_name": org.name if org is not None else "",
        "number": r.number,
        "title": r.title,
        "status": r.status,
        "status_label": STATUS_LABELS.get(r.status, r.status),
        "decline_reason": r.decline_reason if r.status == "declined" else "",
        "work_order": {"number": wo.number, "status": wo.status} if wo is not None and wo.deleted_at is None else None,
        "created_at": iso(r.created_at),
        "updated_at": iso(r.status_changed_at or r.updated_at),
    }


def cleanup_portal_uploads(older_than: timedelta = timedelta(days=1)) -> int:
    """Files uploaded on a portal but never sent with a request are removed after a day."""
    cutoff = utcnow() - older_than
    links = db.session.scalars(
        select(FileLink)
        .where(FileLink.entity_type == "request_portal_upload", FileLink.created_at < cutoff)
        .limit(1000)
    ).all()
    for link in links:
        f = db.session.get(FileObject, link.file_id)
        if f is not None and f.deleted_at is None:
            f.deleted_at = utcnow()
        db.session.delete(link)
    db.session.commit()
    return len(links)
