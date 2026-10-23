"""Work orders shared outside the organization (0.5.0, roadmap r058–r060, r088, r092) and emailing a work order PDF
to vendors (r094).

A share is a secret link (`/x/<token>`) to one work order. Only the token's sha256 is stored, so a link can't be read
back: it's shown once when created (or reset). Each field is Hidden, Can view, or — for procedures and comments only —
Can view and interact. People with the link complete procedures, comment, attach files and mark the work finished, all
without an account. The link turns off by itself when the work order is Done; admins can disable it (reversible) or
reset it (the old link stops working and a new one is made). Admins are notified when an outside contact marks the
work finished.

The public side never uses the visitor's session: it acts as `ExternalActor`, a stand-in membership with no
permissions, and only on the shared work order.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select

from mpro.core.events import emit
from mpro.core.files import FileLink, FileObject
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.workorders.models import Comment, ExternalHit, ExternalShare, WorkOrder

# field -> (label, default access)
FIELDS: dict[str, tuple[str, str]] = {
    "description": ("Description", "view"),
    "status": ("Status and priority", "view"),
    "dates": ("Start and due dates", "view"),
    "location": ("Location", "view"),
    "asset": ("Assets", "view"),
    "assignees": ("Assigned to", "hidden"),
    "categories": ("Categories", "hidden"),
    "files": ("Files and photos", "view"),
    "procedures": ("Procedures", "interact"),
    "comments": ("Comments", "interact"),
}
INTERACTIVE = {"procedures", "comments"}
ACCESS = ("hidden", "view", "interact")
MAX_ACTIVE_PER_WO = 20

# Rate limits for the public endpoints (per IP unless noted).
LIMIT_PER_MINUTE = 120
LIMIT_FAILED_15MIN = 20  # wrong or dead links
LIMIT_WRITES_PER_HOUR = 60  # per link: comments, uploads, answers


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def clean_fields(raw: Any, base: dict[str, str] | None = None) -> dict[str, str]:
    out = dict(base or {k: v[1] for k, v in FIELDS.items()})
    if raw is None:
        return out
    if not isinstance(raw, dict):
        raise RuleError("Field access must be an object.", 422)
    for k, v in raw.items():
        if k not in FIELDS:
            raise RuleError(f"Unknown field: {k}.", 422)
        if v not in ACCESS:
            raise RuleError("Field access is hidden, view or interact.", 422)
        if v == "interact" and k not in INTERACTIVE:
            raise RuleError(f"{FIELDS[k][0]} can only be hidden or viewed.", 422)
        out[k] = v
    return out


def _emails(raw: Any) -> list[str]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > 20:
        raise RuleError("Send up to 20 email addresses.", 422)
    out = []
    for e in raw:
        e = str(e or "").strip()
        if not e or "@" not in e or len(e) > 320 or any(c in e for c in " \r\n,;<>"):
            raise RuleError(f"{e or 'An address'} isn't a valid email address.", 422)
        out.append(e)
    return out


def _vendor(org_id: uuid.UUID, vid: Any) -> Any:
    if not vid:
        return None
    from mpro.vendors.models import Vendor

    try:
        v = db.session.get(Vendor, uuid.UUID(str(vid)))
    except ValueError:
        v = None
    if v is None or v.org_id != org_id or v.deleted_at is not None:
        raise RuleError("That vendor doesn't exist.", 422)
    return v


def vendor_contact_emails(org_id: uuid.UUID, contact_ids: Any) -> list[str]:
    """Emails of vendor contacts picked by id (checked against the organization)."""
    if not contact_ids:
        return []
    from mpro.vendors.models import VendorContact

    if not isinstance(contact_ids, list) or len(contact_ids) > 20:
        raise RuleError("Pick up to 20 contacts.", 422)
    out = []
    for cid in contact_ids:
        try:
            c = db.session.get(VendorContact, uuid.UUID(str(cid)))
        except ValueError:
            c = None
        if c is None or c.org_id != org_id or c.deleted_at is not None:
            raise RuleError("One of the contacts doesn't exist.", 422)
        if c.email:
            out.append(c.email)
    return out


def share_dict(s: ExternalShare, token: str | None = None) -> dict[str, Any]:
    from mpro.auth.models import User

    by = db.session.get(User, s.created_by_id) if s.created_by_id else None
    d: dict[str, Any] = {
        "id": str(s.id),
        "status": s.status,
        "fields": clean_fields(s.fields, None) if s.fields else clean_fields(None),
        "vendor_id": str(s.vendor_id) if s.vendor_id else None,
        "recipients": list(s.recipients or []),
        "message": s.message,
        "last_viewed_at": iso(s.last_viewed_at),
        "finished_at": iso(s.finished_at),
        "finished_by_name": s.finished_by_name,
        "created_at": iso(s.created_at),
        "created_by": {"id": str(by.id), "name": by.name} if by else None,
    }
    if token:  # only right after creating or resetting
        d["token"] = token
        d["path"] = f"/x/{token}"
    return d


def shares_for(wo: WorkOrder) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        select(ExternalShare)
        .where(ExternalShare.work_order_id == wo.id, ExternalShare.status != "revoked")
        .order_by(ExternalShare.created_at.desc())
    ).all()
    return [share_dict(s) for s in rows]


def _link(token: str) -> str:
    from flask import current_app

    return current_app.config.get("MPRO_BASE_URL", "").rstrip("/") + f"/x/{token}"


def _send_share(org: Organization, wo: WorkOrder, s: ExternalShare, token: str, sender: str) -> None:
    for to in s.recipients or []:
        body = (
            f"{sender} at {org.name} shared work order #{wo.number} with you: {wo.title}\n\n"
            + (f"{s.message}\n\n" if s.message else "")
            + f"Open it here (no account needed):\n{_link(token)}\n\n"
            "You can see the details they shared, fill in procedures, comment, add photos and mark the work "
            "finished. Keep this link private: anyone with it can do the same."
        )
        send_email(to, f"Work order #{wo.number}: {wo.title}", body, org_id=org.id)


def create_share(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> tuple[ExternalShare, str]:
    if wo.deleted_at is not None:
        raise RuleError("This work order was deleted.", 409)
    if wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to share it.", 409)
    active = (
        db.session.scalar(
            select(func.count())
            .select_from(ExternalShare)
            .where(ExternalShare.work_order_id == wo.id, ExternalShare.status == "active")
        )
        or 0
    )
    if active >= MAX_ACTIVE_PER_WO:
        raise RuleError(f"A work order can have up to {MAX_ACTIVE_PER_WO} active links.", 422)
    vendor = _vendor(org.id, data.get("vendor_id"))
    recipients = _emails(data.get("emails")) + vendor_contact_emails(org.id, data.get("contact_ids"))
    message = str(data.get("message") or "").strip()[:2000]
    token = new_token()
    s = ExternalShare(
        org_id=org.id,
        work_order_id=wo.id,
        token_hash=token_hash(token),
        status="active",
        fields=clean_fields(data.get("fields")),
        vendor_id=vendor.id if vendor else None,
        recipients=sorted(set(recipients)),
        message=message,
        created_by_id=m.user_id,
    )
    db.session.add(s)
    db.session.flush()
    if recipients:
        _send_share(org, wo, s, token, m.user.name if m.user else "Someone")
    emit(
        "wo.shared_externally",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Shared outside the organization" + (f" with {', '.join(s.recipients)}" if s.recipients else ""),
        data={"share_id": s.id, "vendor_id": s.vendor_id, "recipients": s.recipients},
    )
    db.session.commit()
    return s, token


def get_share(wo: WorkOrder, share_id: str) -> ExternalShare:
    try:
        s = db.session.get(ExternalShare, uuid.UUID(share_id))
    except ValueError:
        s = None
    if s is None or s.work_order_id != wo.id or s.status == "revoked":
        raise RuleError("That link doesn't exist.", 404)
    return s


def update_share(org: Organization, m: Membership, wo: WorkOrder, s: ExternalShare, data: dict[str, Any]) -> None:
    """{fields?, status?: active|disabled}. Turning a link back on isn't possible once the work order is Done."""
    changes: dict[str, Any] = {}
    if "fields" in data:
        new = clean_fields(data["fields"], clean_fields(s.fields) if s.fields else None)
        changes["fields"] = (s.fields, new)
        s.fields = new
    if "status" in data:
        st = data["status"]
        if st not in ("active", "disabled"):
            raise RuleError("A link is active or disabled.", 422)
        if st == "active" and wo.status in ("done", "canceled"):
            raise RuleError("Reopen the work order to turn the link back on.", 409)
        changes["status"] = (s.status, st)
        s.status = st
    emit(
        "wo.external_link_changed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Turned off an outside link"
        if s.status == "disabled" and "status" in changes
        else "Changed an outside link",
        changes=changes,
        data={"share_id": s.id},
    )
    db.session.commit()


def reset_share(org: Organization, m: Membership, wo: WorkOrder, s: ExternalShare) -> tuple[ExternalShare, str]:
    """Revoke the link and make a new one with the same settings (r060)."""
    if wo.status in ("done", "canceled"):
        raise RuleError("Reopen the work order to share it.", 409)
    s.status = "revoked"
    token = new_token()
    n = ExternalShare(
        org_id=org.id,
        work_order_id=wo.id,
        token_hash=token_hash(token),
        status="active",
        fields=dict(s.fields or {}),
        vendor_id=s.vendor_id,
        recipients=list(s.recipients or []),
        message=s.message,
        created_by_id=m.user_id,
    )
    db.session.add(n)
    db.session.flush()
    emit(
        "wo.external_link_reset",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Reset an outside link (the old one no longer works)",
        data={"old_share_id": s.id, "share_id": n.id},
    )
    db.session.commit()
    return n, token


def revoke_share(org: Organization, m: Membership, wo: WorkOrder, s: ExternalShare) -> None:
    s.status = "revoked"
    emit(
        "wo.external_link_removed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary="Removed an outside link",
        data={"share_id": s.id},
    )
    db.session.commit()


def _on_status(org: Organization, m: Membership, wo: WorkOrder, old: str, new: str) -> None:
    """r060: links turn off by themselves when the work order is Done (and when it's canceled)."""
    if new not in ("done", "canceled"):
        return
    rows = db.session.scalars(
        select(ExternalShare).where(ExternalShare.work_order_id == wo.id, ExternalShare.status == "active")
    ).all()
    for s in rows:
        s.status = "disabled"
    if rows:
        emit(
            "wo.external_links_disabled",
            entity_type="work_order",
            entity_id=wo.id,
            entity_label=f"#{wo.number} {wo.title}",
            summary=f"Turned off {len(rows)} outside link{'s' if len(rows) != 1 else ''} (work order {new})",
            org_id=org.id,
        )


def shared_filter_ids(org_id: uuid.UUID) -> Any:
    """Subquery of work orders shared externally (r088): any link that isn't revoked."""
    return select(ExternalShare.work_order_id).where(
        ExternalShare.org_id == org_id, ExternalShare.status.in_(("active", "disabled"))
    )


# ---------------------------------------------------------------- public side


@dataclass
class ExternalActor:
    """Stands in for a membership in the procedure and comment services: no permissions, no user."""

    org_id: uuid.UUID
    name: str = ""
    user_id: None = None
    role: str = "external"
    role_id: None = None
    custom_role: None = None
    deleted_at: None = None
    wo_visibility: str = "limited"
    user: None = None
    extra: dict[str, Any] = field(default_factory=dict)


class LinkError(RuleError):
    """Wrong, revoked or turned-off link (the public side never says which)."""


def _ip() -> str:
    from flask import request

    # the TCP peer (or what trusted proxies report, via ProxyFix): a raw X-Forwarded-For would dodge rate limits
    return (request.remote_addr or "")[:64] or "?"


def throttle(share: ExternalShare | None, ok: bool, write: bool = False) -> None:
    """Record the hit and refuse when over a limit (429). Commits the hit so failed attempts count too."""
    ip = _ip()
    now = utcnow()
    per_min = (
        db.session.scalar(
            select(func.count())
            .select_from(ExternalHit)
            .where(ExternalHit.ip == ip, ExternalHit.at >= now - timedelta(minutes=1))
        )
        or 0
    )
    failed = (
        db.session.scalar(
            select(func.count())
            .select_from(ExternalHit)
            .where(ExternalHit.ip == ip, ExternalHit.ok.is_(False), ExternalHit.at >= now - timedelta(minutes=15))
        )
        or 0
    )
    writes = 0
    if write and share is not None:
        writes = (
            db.session.scalar(
                select(func.count())
                .select_from(ExternalHit)
                .where(
                    ExternalHit.share_id == share.id,
                    ExternalHit.write.is_(True),
                    ExternalHit.at >= now - timedelta(hours=1),
                )
            )
            or 0
        )
    db.session.add(ExternalHit(ip=ip, share_id=share.id if share else None, ok=ok, write=write, at=now))
    db.session.execute(delete(ExternalHit).where(ExternalHit.at < now - timedelta(days=1)))  # keep the table small
    db.session.commit()
    if per_min >= LIMIT_PER_MINUTE or failed >= LIMIT_FAILED_15MIN:
        raise RuleError("Too many requests. Wait a few minutes and try again.", 429)
    if write and writes >= LIMIT_WRITES_PER_HOUR:
        raise RuleError("Too many changes through this link in the last hour. Try again later.", 429)


def resolve(token: str, write: bool = False) -> tuple[ExternalShare, WorkOrder, Organization]:
    """The active share for a token, or LinkError (404) — counted towards the failed-attempt limit."""
    s = None
    if token and len(token) <= 100:
        s = db.session.scalars(select(ExternalShare).where(ExternalShare.token_hash == token_hash(token))).first()
    wo = db.session.get(WorkOrder, s.work_order_id) if s is not None else None
    org = db.session.get(Organization, s.org_id) if s is not None else None
    ok = (
        s is not None
        and s.status == "active"
        and wo is not None
        and wo.deleted_at is None
        and wo.status not in ("done", "canceled")
        and org is not None
        and org.deleted_at is None
    )
    throttle(s if ok else None, ok, write and ok)
    if not ok or s is None or wo is None or org is None:
        raise LinkError("This link doesn't work. It may have been turned off or replaced.", 404)
    return s, wo, org


def can_field(s: ExternalShare, name: str, want: str = "view") -> bool:
    access = (s.fields or {}).get(name, FIELDS[name][1])
    return access == "interact" if want == "interact" else access in ("view", "interact")


def _file_out(token: str, f: FileObject) -> dict[str, Any]:
    base = f"/api/v1/external/{token}/files/{f.id}"
    return {
        "id": str(f.id),
        "name": f.name,
        "content_type": f.content_type,
        "size": f.size,
        "is_image": f.is_image,
        "url": base,
        "thumb_url": base + "/thumb" if f.is_image or f.thumb_key else None,
    }


def _files_of(entity_type: str, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[FileObject]]:
    if not ids:
        return {}
    rows = db.session.execute(
        select(FileLink.entity_id, FileObject)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(FileLink.entity_type == entity_type, FileLink.entity_id.in_(ids), FileObject.deleted_at.is_(None))
        .order_by(FileLink.sort, FileLink.created_at)
    ).all()
    out: dict[uuid.UUID, list[FileObject]] = {}
    for eid, f in rows:
        out.setdefault(eid, []).append(f)
    return out


def public_view(token: str, s: ExternalShare, wo: WorkOrder, org: Organization) -> dict[str, Any]:
    """What the outside contact sees: only the fields the link allows."""
    from mpro.procedures.services import runs_for
    from mpro.workorders.queries import summary_dict

    s.last_viewed_at = utcnow()
    full = summary_dict(wo, None, None)
    out: dict[str, Any] = {
        "organization": org.name,
        "number": wo.number,
        "title": wo.title,
        "access": {k: (s.fields or {}).get(k, v[1]) for k, v in FIELDS.items()},
        "finished_at": iso(s.finished_at),
        "finished_by_name": s.finished_by_name,
    }
    if can_field(s, "description"):
        out["description"] = wo.description
    if can_field(s, "status"):
        out.update({k: full.get(k) for k in ("status", "status_label", "sub_status", "priority", "priority_label")})
    if can_field(s, "dates"):
        out.update({"start_at": full.get("start_at"), "due_at": full.get("due_at"), "overdue": full.get("overdue")})
    if can_field(s, "location"):
        out["location"] = full.get("location")
    if can_field(s, "asset"):
        out["assets"] = full.get("assets") or ([full["asset"]] if full.get("asset") else [])
    if can_field(s, "assignees"):
        out["assignees"] = [{"name": a.get("name"), "type": a.get("type")} for a in full.get("assignees") or []]
    if can_field(s, "categories"):
        out["categories"] = [{"name": c.get("name"), "color": c.get("color")} for c in full.get("categories") or []]
    if can_field(s, "files"):
        out["files"] = [_file_out(token, f) for f in _files_of("work_order", [wo.id]).get(wo.id, [])]
    if can_field(s, "procedures"):
        runs = runs_for(None, wo)
        for r in runs:  # file links in answers and reference files point at the public download
            for a in (r.get("answers") or {}).values():
                for fobj in a.get("files") or []:
                    if isinstance(fobj, dict) and fobj.get("id"):
                        fobj["url"] = f"/api/v1/external/{token}/files/{fobj['id']}"
                        fobj["thumb_url"] = fobj["url"] + "/thumb" if fobj.get("thumb_url") else None
            for fid, ref in (r.get("reference_files") or {}).items():
                ref["url"] = f"/api/v1/external/{token}/files/{fid}"
                ref["thumb_url"] = ref["url"] + "/thumb" if ref.get("thumb_url") else None
        out["procedures"] = runs
    if can_field(s, "comments"):
        cs = db.session.scalars(
            select(Comment)
            .where(Comment.entity_type == "work_order", Comment.entity_id == wo.id, Comment.deleted_at.is_(None))
            .order_by(Comment.created_at)
        ).all()
        files = _files_of("comment", [c.id for c in cs])
        out["comments"] = [
            {
                "id": str(c.id),
                "body": c.body,
                "author": c.external_name + " (outside)"
                if c.external_name
                else (c.author.name if c.author else "Someone"),
                "external": bool(c.external_name),
                "files": [_file_out(token, f) for f in files.get(c.id, [])],
                "created_at": iso(c.created_at),
            }
            for c in cs
        ]
    db.session.commit()
    return out


def file_allowed(s: ExternalShare, wo: WorkOrder, f: FileObject) -> bool:
    """A file is reachable through the link only if it belongs to something the link shows."""
    if f.org_id != wo.org_id or f.deleted_at is not None:
        return False
    links = db.session.execute(select(FileLink.entity_type, FileLink.entity_id).where(FileLink.file_id == f.id)).all()
    for et, eid in links:
        if et == "external_share" and eid == s.id:
            return True
        if et == "work_order" and eid == wo.id and can_field(s, "files"):
            return True
        if et == "comment" and can_field(s, "comments"):
            c = db.session.get(Comment, eid)
            if c is not None and c.entity_type == "work_order" and c.entity_id == wo.id and c.deleted_at is None:
                return True
    return can_field(s, "procedures") and (_in_answers(wo, f.id) or _in_references(wo, f.id))


def _in_answers(wo: WorkOrder, fid: uuid.UUID) -> bool:
    from mpro.procedures.models import ProcedureAnswer

    rows = db.session.scalars(select(ProcedureAnswer.file_ids).where(ProcedureAnswer.work_order_id == wo.id)).all()
    return any(str(fid) in (ids or []) for ids in rows)


def _in_references(wo: WorkOrder, fid: uuid.UUID) -> bool:
    from mpro.procedures.models import ProcedureRun, ProcedureVersion
    from mpro.procedures.schema import walk

    for (schema,) in db.session.execute(
        select(ProcedureVersion.schema)
        .join(ProcedureRun, ProcedureRun.version_id == ProcedureVersion.id)
        .where(ProcedureRun.work_order_id == wo.id)
    ).all():
        for f in walk((schema or {}).get("items") or []):
            if str(fid) in [str(x) for x in f.get("reference_file_ids") or []]:
                return True
    return False


def _uploaded_here(s: ExternalShare, ids: Any) -> list[uuid.UUID]:
    """File ids sent by the outside contact must be ones they uploaded through this link."""
    if ids in (None, ""):
        return []
    if not isinstance(ids, list) or len(ids) > 20:
        raise RuleError("Attach up to 20 files.", 422)
    out = []
    for raw in ids:
        try:
            fid = uuid.UUID(str(raw))
        except ValueError as e:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422) from e
        ok = db.session.scalar(
            select(FileLink.id).where(
                FileLink.file_id == fid, FileLink.entity_type == "external_share", FileLink.entity_id == s.id
            )
        )
        if not ok:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        out.append(fid)
    return out


def _name(raw: Any) -> str:
    name = " ".join(str(raw or "").split())[:120]
    if not name:
        raise RuleError("Type your name so they know who wrote this.", 422)
    return name


def add_comment(s: ExternalShare, wo: WorkOrder, org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    from mpro.core.files import attach
    from mpro.workorders.services import touch

    if not can_field(s, "comments", "interact"):
        raise RuleError("This link doesn't allow comments.", 403)
    name = _name(data.get("name"))
    body = str(data.get("body") or "").strip()
    fids = _uploaded_here(s, data.get("file_ids"))
    if not body and not fids:
        raise RuleError("Write a comment or attach a file.", 422)
    if len(body) > 10000:
        raise RuleError("Comments can be up to 10,000 characters.", 422)
    c = Comment(
        org_id=org.id, entity_type="work_order", entity_id=wo.id, author_id=None, body=body,
        mentions={"users": [], "teams": []}, external_name=name,
    )  # fmt: skip
    db.session.add(c)
    db.session.flush()
    for fid in fids:
        f = db.session.get(FileObject, fid)
        if f is not None:
            attach(f, "comment", c.id, "comment")
    touch(wo, None)
    emit(
        "wo.commented",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"{name} (outside) commented",
        data={"comment_id": c.id, "external": True, "share_id": s.id, "excerpt": body[:200]},
        org_id=org.id,
    )
    db.session.commit()
    return {"id": str(c.id)}


def answer(s: ExternalShare, wo: WorkOrder, org: Organization, run_id: str, field_id: str, data: dict[str, Any]) -> Any:
    from mpro.procedures import services as psvc

    if not can_field(s, "procedures", "interact"):
        raise RuleError("This link doesn't allow filling in procedures.", 403)
    name = _name(data.get("name"))
    run = psvc.get_run(wo, run_id)
    v = db.session.get(psvc.ProcedureVersion, run.version_id)
    f = psvc._find_field(v.schema, field_id) if v else None
    if f is not None and f.get("type") in ("file",):
        data = {**data, "value": [str(x) for x in _uploaded_here(s, data.get("value"))]}
    if "file_ids" in data:
        data = {**data, "file_ids": [str(x) for x in _uploaded_here(s, data.get("file_ids"))]}
    if f is not None and f.get("type") == "signature" and not data.get("signed_by"):
        data = {**data, "signed_by": name}
    actor: Any = ExternalActor(org_id=org.id, name=name)
    # files uploaded through the link must be attached to the work order for the procedure services' checks
    from mpro.core.files import attach

    for fid in (data.get("value") if f is not None and f.get("type") == "file" else []) or []:
        fo = db.session.get(FileObject, uuid.UUID(fid))
        if fo is not None and not db.session.scalar(
            select(FileLink.id).where(
                FileLink.file_id == fo.id, FileLink.entity_type == "work_order", FileLink.entity_id == wo.id
            )
        ):
            attach(fo, "work_order", wo.id, "file")
    res = psvc.answer(org, actor, wo, run, field_id, {k: v for k, v in data.items() if k != "name"})
    emit(
        "wo.external_answered",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"{name} (outside) answered {(f or {}).get('label', 'a procedure step')[:120]}",
        data={"share_id": s.id, "run_id": run_id, "field_id": field_id},
        org_id=org.id,
    )
    db.session.commit()
    return res


def upload(s: ExternalShare, wo: WorkOrder, org: Organization, up: Any) -> dict[str, Any]:
    from mpro.core.files import attach, save_file_stream

    if not (can_field(s, "comments", "interact") or can_field(s, "procedures", "interact")):
        raise RuleError("This link doesn't allow adding files.", 403)
    n = (
        db.session.scalar(
            select(func.count())
            .select_from(FileLink)
            .where(FileLink.entity_type == "external_share", FileLink.entity_id == s.id)
        )
        or 0
    )
    if n >= 200:
        raise RuleError("This link has reached its limit of 200 files.", 422)
    f = save_file_stream(org.id, up.filename, up.stream, None, org)
    attach(f, "external_share", s.id, "upload")
    emit(
        "file.attached",
        entity_type="work_order",
        entity_id=wo.id,
        summary=f"Outside contact uploaded {f.name}",
        data={"file_id": f.id, "share_id": s.id},
        org_id=org.id,
    )
    db.session.commit()
    return _file_out("", f) | {"url": None, "thumb_url": None}


def finish(s: ExternalShare, wo: WorkOrder, org: Organization, data: dict[str, Any]) -> None:
    """r092: the outside contact says the work is finished; admins get an email and the work order a comment."""
    name = _name(data.get("name"))
    note = str(data.get("note") or "").strip()[:4000]
    s.finished_at, s.finished_by_name = utcnow(), name
    c = Comment(
        org_id=org.id, entity_type="work_order", entity_id=wo.id, author_id=None,
        body="Marked the work finished." + (f"\n\n{note}" if note else ""), mentions={"users": [], "teams": []},
        external_name=name,
    )  # fmt: skip
    db.session.add(c)
    emit(
        "wo.external_finished",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"{name} (outside) marked the work finished",
        data={"share_id": s.id, "note": note[:500]},
        org_id=org.id,
    )
    from mpro.auth.models import User

    admins = db.session.scalars(
        select(User)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == org.id, Membership.deleted_at.is_(None), Membership.role.in_(("owner", "admin")))
    ).all()
    from flask import current_app

    url = current_app.config.get("MPRO_BASE_URL", "").rstrip("/") + f"/work-orders/{wo.id}"
    for u in admins:
        send_email(
            u.email,
            f"#{wo.number} {wo.title}: marked finished by {name}",
            f"{name}, working through a shared link, marked work order #{wo.number} ({wo.title}) finished."
            + (f"\n\nTheir note:\n{note}" if note else "")
            + f"\n\nReview it and close it in Maintenance Pro:\n{url}",
            org_id=org.id,
        )
    db.session.commit()


# ---------------------------------------------------------------- r094: email the work order PDF to vendors


def email_pdf(org: Organization, m: Membership, wo: WorkOrder, data: dict[str, Any]) -> dict[str, Any]:
    """{vendor_ids?, contact_ids?, emails?, message?, options?: PDF options} → one email per address with the PDF."""
    from mpro.core.files import save_file
    from mpro.workorders.exports import clean_pdf_options, render_pdf

    recipients = list(_emails(data.get("emails")))
    recipients += vendor_contact_emails(org.id, data.get("contact_ids"))
    vids = data.get("vendor_ids") or []
    if not isinstance(vids, list) or len(vids) > 20:
        raise RuleError("Pick up to 20 vendors.", 422)
    from mpro.vendors.models import VendorContact

    for vid in vids:
        v = _vendor(org.id, vid)
        contacts = db.session.scalars(
            select(VendorContact).where(
                VendorContact.vendor_id == v.id, VendorContact.deleted_at.is_(None), VendorContact.email != ""
            )
        ).all()
        picked = [c.email for c in contacts if c.is_po_contact] or [c.email for c in contacts]
        if not picked and v.email:
            picked = [v.email]
        if not picked:
            raise RuleError(f"{v.name} has no email address. Add a contact with an email first.", 422)
        recipients += picked
    recipients = sorted(set(recipients))
    if not recipients:
        raise RuleError("Pick a vendor, a contact or an email address.", 422)
    message = str(data.get("message") or "").strip()[:4000]
    pdf = render_pdf(m, org, [wo], clean_pdf_options(data.get("options")))
    f = save_file(org.id, f"WO-{wo.number}.pdf", pdf, m.user_id, "application/pdf")
    sender = m.user.name if m.user else org.name
    for to in recipients:
        send_email(
            to,
            f"Work order #{wo.number}: {wo.title}",
            (message + "\n\n" if message else "")
            + f"{sender} at {org.name} sent you work order #{wo.number} ({wo.title}). The details are in the "
            "attached PDF.",
            org_id=org.id,
            attachments=[{"file_id": f.id, "name": f"WO-{wo.number}.pdf"}],
        )
    emit(
        "wo.emailed",
        entity_type="work_order",
        entity_id=wo.id,
        entity_label=f"#{wo.number} {wo.title}",
        summary=f"Emailed the PDF to {', '.join(recipients)}",
        data={"recipients": recipients, "file_id": f.id},
    )
    db.session.commit()
    return {"sent_to": recipients}


def register() -> None:
    from mpro.workorders.services import STATUS_HOOKS

    if _on_status not in STATUS_HOOKS:
        STATUS_HOOKS.append(_on_status)
