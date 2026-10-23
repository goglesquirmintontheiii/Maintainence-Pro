"""QR codes and barcodes: create, assign, move, retire, resolve (MP-095)."""

from __future__ import annotations

import re
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from flask import current_app
from sqlalchemy import func, select

from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError
from mpro.qr.models import QrCode

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O, 1/I/L: easy to read aloud and type
CODE_LEN = 10
SYMBOLOGIES = ("qr", "code128", "datamatrix", "code39", "ean13", "upca", "other")


@dataclass
class Target:
    model: Any
    label: Callable[[Any], str]
    url: Callable[[Any], str]
    view: str  # permission to see it


_targets: dict[str, Target] = {}


def register_target(
    entity_type: str, model: Any, label: Callable[[Any], str], url: Callable[[Any], str], view: str
) -> None:
    """Modules say which records can carry a code (assets, locations, meters; parts in 0.5.0)."""
    _targets[entity_type] = Target(model, label, url, view)


def code_url(value: str) -> str:
    return current_app.config["MPRO_BASE_URL"].rstrip("/") + "/q/" + value


def new_value(org_id: uuid.UUID) -> str:
    for _ in range(20):
        v = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))
        if not db.session.scalar(select(QrCode.id).where(QrCode.org_id == org_id, QrCode.value == v)):
            return v
    raise RuleError("Couldn't make a unique code. Try again.", 500)  # pragma: no cover


def _target(org_id: uuid.UUID, entity_type: str, entity_id: Any) -> Any:
    t = _targets.get(entity_type)
    if t is None:
        raise RuleError("Codes can go on assets, locations and meters.", 422)
    try:
        eid = entity_id if isinstance(entity_id, uuid.UUID) else uuid.UUID(str(entity_id))
    except ValueError as e:
        raise RuleError("That record doesn't exist.", 422) from e
    rec = db.session.get(t.model, eid)
    if rec is None or rec.org_id != org_id or getattr(rec, "deleted_at", None) is not None:
        raise RuleError("That record doesn't exist.", 422)
    return rec


def code_dict(c: QrCode, with_target: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(c.id),
        "kind": c.kind,
        "value": c.value,
        "symbology": c.symbology,
        "url": code_url(c.value) if c.kind == "mpro" else None,
        "entity_type": c.entity_type,
        "entity_id": str(c.entity_id) if c.entity_id else None,
        "note": c.note,
        "batch": c.batch,
        "retired": c.retired_at is not None,
        "retired_at": iso(c.retired_at),
        "assigned_at": iso(c.assigned_at),
        "created_at": iso(c.created_at),
    }
    if with_target and c.entity_type and c.entity_id:
        t = _targets.get(c.entity_type)
        rec = db.session.get(t.model, c.entity_id) if t else None
        d["target"] = (
            {"label": t.label(rec), "url": t.url(rec)}
            if t and rec is not None and getattr(rec, "deleted_at", None) is None
            else None
        )
    return d


def codes_for(
    org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID, include_retired: bool = False
) -> list[dict[str, Any]]:
    q = select(QrCode).where(QrCode.org_id == org_id, QrCode.entity_type == entity_type, QrCode.entity_id == entity_id)
    if not include_retired:
        q = q.where(QrCode.retired_at.is_(None))
    return [code_dict(c) for c in db.session.scalars(q.order_by(QrCode.created_at)).all()]


def ensure_code(org: Organization, m: Membership, entity_type: str, entity_id: Any, commit: bool = True) -> QrCode:
    """The record's MPro code, created if it has none (used when printing labels)."""
    rec = _target(org.id, entity_type, entity_id)
    c = db.session.scalars(
        select(QrCode)
        .where(
            QrCode.org_id == org.id,
            QrCode.entity_type == entity_type,
            QrCode.entity_id == rec.id,
            QrCode.kind == "mpro",
            QrCode.retired_at.is_(None),
        )
        .order_by(QrCode.created_at)
    ).first()
    if c is None:
        c = QrCode(
            org_id=org.id,
            kind="mpro",
            value=new_value(org.id),
            symbology="qr",
            entity_type=entity_type,
            entity_id=rec.id,
            assigned_at=utcnow(),
            created_by_id=m.user_id,
            note="",
            batch="",
        )
        db.session.add(c)
        db.session.flush()
        emit(
            "qr.created",
            entity_type=entity_type,
            entity_id=rec.id,
            entity_label=_targets[entity_type].label(rec),
            summary=f"Created QR code {c.value}",
        )
    if commit:
        db.session.commit()
    return c


def add_external(
    org: Organization, m: Membership, entity_type: str, entity_id: Any, value: str, symbology: str = "other"
) -> QrCode:
    """Link an existing barcode or QR code (e.g. a MaintainX label) so scanning it finds the record."""
    rec = _target(org.id, entity_type, entity_id)
    value = (value or "").strip()
    if not value or len(value) > 200:
        raise RuleError("Scan or type the barcode (up to 200 characters).", 422)
    if symbology not in SYMBOLOGIES:
        raise RuleError("Unknown barcode type.", 422)
    existing = db.session.scalars(select(QrCode).where(QrCode.org_id == org.id, QrCode.value == value)).first()
    if existing is not None and existing.retired_at is None and existing.entity_id:
        raise RuleError("That code is already on another record. Move it instead.", 409)
    if existing is not None:
        c = existing
        c.retired_at = None
    else:
        c = QrCode(org_id=org.id, kind="external", value=value, created_by_id=m.user_id, note="", batch="")
        db.session.add(c)
    c.symbology, c.entity_type, c.entity_id, c.assigned_at = symbology, entity_type, rec.id, utcnow()
    db.session.flush()
    emit(
        "qr.linked",
        entity_type=entity_type,
        entity_id=rec.id,
        entity_label=_targets[entity_type].label(rec),
        summary=f"Linked barcode {value}",
    )
    db.session.commit()
    return c


def generate_batch(org: Organization, m: Membership, count: int, note: str = "") -> list[QrCode]:
    """Blank codes to stick on equipment first and assign later by scanning (tag first)."""
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 1000:
        raise RuleError("Make between 1 and 1,000 codes at a time.", 422)
    batch = utcnow().strftime("%Y%m%d-%H%M%S")
    codes = []
    for _ in range(count):
        c = QrCode(
            org_id=org.id,
            kind="mpro",
            value=new_value(org.id),
            symbology="qr",
            created_by_id=m.user_id,
            note=(note or "").strip()[:200],
            batch=batch,
        )
        db.session.add(c)
        db.session.flush()
        codes.append(c)
    emit(
        "qr.batch_created",
        entity_type="org",
        entity_id=org.id,
        entity_label=org.name,
        summary=f"Created {count} blank QR codes",
        data={"batch": batch},
    )
    db.session.commit()
    return codes


def get_code(org_id: uuid.UUID, code_id: Any) -> QrCode:
    try:
        cid = uuid.UUID(str(code_id))
    except ValueError as e:
        raise RuleError("That code doesn't exist.", 404) from e
    c = db.session.get(QrCode, cid)
    if c is None or c.org_id != org_id:
        raise RuleError("That code doesn't exist.", 404)
    return c


def assign(org: Organization, m: Membership, c: QrCode, entity_type: str, entity_id: Any, move: bool = False) -> QrCode:
    if c.retired_at is not None:
        raise RuleError("This code was retired. Print a new one.", 409)
    rec = _target(org.id, entity_type, entity_id)
    if c.entity_id and not move:
        t_old = _targets.get(c.entity_type or "")
        old = db.session.get(t_old.model, c.entity_id) if t_old else None
        if old is None or getattr(old, "deleted_at", None) is not None:
            move = True  # the record it was on is gone: treat the code as free
    if c.entity_id and not move:
        if c.entity_id == rec.id:
            return c
        raise RuleError("This code is already on another record. Move it instead.", 409)
    prev = (c.entity_type, c.entity_id)
    c.entity_type, c.entity_id, c.assigned_at = entity_type, rec.id, utcnow()
    emit(
        "qr.assigned" if not prev[1] else "qr.moved",
        entity_type=entity_type,
        entity_id=rec.id,
        entity_label=_targets[entity_type].label(rec),
        summary=("Moved" if prev[1] else "Assigned") + f" code {c.value} here",
        data={"from_type": prev[0], "from_id": prev[1]},
    )
    db.session.commit()
    return c


def retire(org: Organization, m: Membership, c: QrCode) -> QrCode:
    if c.retired_at is None:
        c.retired_at = utcnow()
        emit(
            "qr.retired",
            entity_type=c.entity_type or "org",
            entity_id=c.entity_id or org.id,
            entity_label=c.value,
            summary=f"Retired code {c.value}",
        )
        db.session.commit()
    return c


_URL_CODE = re.compile(r"/q/([A-Za-z0-9]{6,20})/?(?:[?#].*)?$")


def resolve(m: Membership, raw: str) -> dict[str, Any]:
    """What a scanned value points at. Accepts MPro URLs, bare codes, external barcodes and serial numbers."""
    from mpro.core.permissions import can

    raw = (raw or "").strip()[:500]
    if not raw:
        raise RuleError("Scan or type a code.", 422)
    match = _URL_CODE.search(raw)
    candidates = [match.group(1).upper()] if match else []
    candidates += [raw, raw.upper()]
    c = db.session.scalars(
        select(QrCode)
        .where(QrCode.org_id == m.org_id, QrCode.value.in_(candidates))
        .order_by(QrCode.retired_at.is_not(None))
    ).first()
    if c is not None:
        if c.retired_at is not None:
            return {"status": "retired", "code": code_dict(c)}
        if not c.entity_id:
            return {"status": "unassigned", "code": code_dict(c)}
        t = _targets.get(c.entity_type or "")
        rec = db.session.get(t.model, c.entity_id) if t else None
        if t is None or rec is None or getattr(rec, "deleted_at", None) is not None:
            return {"status": "unassigned", "code": code_dict(c)}
        if not can(m, t.view):
            raise RuleError("You don't have access to this record.", 403)
        return {
            "status": "found",
            "code": code_dict(c),
            "entity_type": c.entity_type,
            "entity_id": str(rec.id),
            "label": t.label(rec),
            "url": t.url(rec),
        }
    # Not a code: try an asset barcode or serial number (labels made before MPro).
    from mpro.assets.models import Asset

    if can(m, "assets.view"):
        hits = db.session.scalars(
            select(Asset)
            .where(
                Asset.org_id == m.org_id,
                Asset.deleted_at.is_(None),
                (func.lower(Asset.barcode) == raw.lower()) | (func.lower(Asset.serial_number) == raw.lower()),
            )
            .limit(5)
        ).all()
        if len(hits) == 1:
            return {
                "status": "found",
                "entity_type": "asset",
                "entity_id": str(hits[0].id),
                "label": hits[0].name,
                "url": f"/assets/{hits[0].id}",
                "matched": "barcode" if hits[0].barcode.lower() == raw.lower() else "serial_number",
            }
        if hits:
            return {
                "status": "several",
                "results": [
                    {"entity_type": "asset", "entity_id": str(a.id), "label": a.name, "url": f"/assets/{a.id}"}
                    for a in hits
                ],
            }
    # Part barcodes (0.5.0, MP-039): a scanned barcode opens the part.
    from mpro.parts.models import Part

    if can(m, "parts.view"):
        parts = db.session.scalars(
            select(Part)
            .where(Part.org_id == m.org_id, Part.deleted_at.is_(None), func.lower(Part.barcode) == raw.lower())
            .limit(5)
        ).all()
        if len(parts) == 1:
            return {
                "status": "found",
                "entity_type": "part",
                "entity_id": str(parts[0].id),
                "label": parts[0].name,
                "url": f"/parts/{parts[0].id}",
                "matched": "barcode",
            }
        if parts:
            return {
                "status": "several",
                "results": [
                    {"entity_type": "part", "entity_id": str(p.id), "label": p.name, "url": f"/parts/{p.id}"}
                    for p in parts
                ],
            }
    return {"status": "unknown", "value": raw}


def list_codes(org_id: uuid.UUID, params: dict[str, Any]) -> dict[str, Any]:
    q = select(QrCode).where(QrCode.org_id == org_id)
    state = params.get("state") or "all"
    if state == "unassigned":
        q = q.where(QrCode.entity_id.is_(None), QrCode.retired_at.is_(None))
    elif state == "assigned":
        q = q.where(QrCode.entity_id.is_not(None), QrCode.retired_at.is_(None))
    elif state == "retired":
        q = q.where(QrCode.retired_at.is_not(None))
    if params.get("batch"):
        q = q.where(QrCode.batch == str(params["batch"]))
    total = db.session.scalar(select(func.count()).select_from(q.subquery())) or 0
    try:
        per_page, page = max(1, min(int(params.get("per_page") or 100), 1000)), max(1, int(params.get("page") or 1))
    except ValueError as e:
        raise RuleError("page and per_page must be numbers.", 422) from e
    rows = db.session.scalars(
        q.order_by(QrCode.created_at.desc(), QrCode.value).limit(per_page).offset((page - 1) * per_page)
    ).all()
    return {"items": [code_dict(c, with_target=True) for c in rows], "total": total, "page": page, "per_page": per_page}
