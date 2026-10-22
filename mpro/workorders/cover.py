"""Work order cover picture (MP-112): the first picture uploaded, unless someone picked another one."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.files import IMAGE_TYPES, FileLink, FileObject
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.workorders.models import WorkOrder

COVER_ROLES = ("file", "photo", "before", "after")  # not signatures, receipts or comment attachments


def _thumb(fid: uuid.UUID) -> str:
    return f"/api/v1/files/{fid}/thumb"


def cover_map(wos: list[WorkOrder]) -> dict[uuid.UUID, str | None]:
    """Cover thumbnail URL per work order, in one query."""
    ids = [w.id for w in wos]
    if not ids:
        return {}
    rows = db.session.execute(
        select(FileLink.entity_id, FileLink.file_id)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(
            FileLink.entity_type == "work_order",
            FileLink.entity_id.in_(ids),
            FileLink.role.in_(COVER_ROLES),
            FileObject.deleted_at.is_(None),
            FileObject.content_type.in_(IMAGE_TYPES),
        )
        .order_by(FileLink.sort, FileLink.created_at)
    ).all()
    images: dict[uuid.UUID, list[uuid.UUID]] = {}
    for wid, fid in rows:
        images.setdefault(wid, []).append(fid)
    out: dict[uuid.UUID, str | None] = {}
    for w in wos:
        mine = images.get(w.id, [])
        chosen = w.cover_file_id if w.cover_file_id in mine else (mine[0] if mine else None)
        out[w.id] = _thumb(chosen) if chosen else None
    return out


def cover_info(wo: WorkOrder) -> dict[str, Any]:
    url = cover_map([wo]).get(wo.id)
    return {"cover_url": url, "cover_file_id": str(wo.cover_file_id) if wo.cover_file_id else None}


def set_cover(org: Organization, m: Membership, wo: WorkOrder, file_id: Any) -> WorkOrder:
    """Pick the cover picture (`None` goes back to the first picture)."""
    if file_id in (None, ""):
        wo.cover_file_id = None
        db.session.commit()
        return wo
    try:
        fid = uuid.UUID(str(file_id))
    except ValueError as e:
        raise RuleError("That picture isn't on this work order.", 422) from e
    link = db.session.scalars(
        select(FileLink)
        .join(FileObject, FileObject.id == FileLink.file_id)
        .where(
            FileLink.entity_type == "work_order",
            FileLink.entity_id == wo.id,
            FileLink.file_id == fid,
            FileLink.role.in_(COVER_ROLES),
            FileObject.deleted_at.is_(None),
        )
    ).first()
    if link is None or not link.file.is_image:
        raise RuleError("Pick one of this work order's pictures.", 422)
    wo.cover_file_id = fid
    emit("wo.cover_changed", entity_type="work_order", entity_id=wo.id, entity_label=f"#{wo.number} {wo.title}",
         summary=f"Set the work order image to {link.file.name}")  # fmt: skip
    db.session.commit()
    return wo
