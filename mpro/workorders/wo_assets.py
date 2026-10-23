"""Several assets on one work order (0.5.0, MP-124).

`work_order_assets` holds every asset in order; `WorkOrder.asset_id` stays the first one so existing filters, PM,
automations and old API clients keep working. Code that sets `wo.asset_id` directly (demo data, older paths) still
counts: every query here treats "the primary asset OR a work_order_assets row" as "on this work order".
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, delete, or_, select

from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.workorders.models import WorkOrder, WorkOrderAsset

MAX_ASSETS = 50


def asset_ids_of(wo: WorkOrder) -> list[uuid.UUID]:
    """The work order's assets, primary first."""
    ids = list(
        db.session.scalars(
            select(WorkOrderAsset.asset_id)
            .where(WorkOrderAsset.work_order_id == wo.id)
            .order_by(WorkOrderAsset.sort, WorkOrderAsset.id)
        ).all()
    )
    if wo.asset_id and wo.asset_id not in ids:
        ids.insert(0, wo.asset_id)
    elif wo.asset_id and ids and ids[0] != wo.asset_id:
        ids.remove(wo.asset_id)
        ids.insert(0, wo.asset_id)
    return ids


def asset_ids_for(wos: list[WorkOrder]) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Batch version for lists (no N+1)."""
    out: dict[uuid.UUID, list[uuid.UUID]] = {w.id: ([w.asset_id] if w.asset_id else []) for w in wos}
    if not wos:
        return out
    rows = db.session.execute(
        select(WorkOrderAsset.work_order_id, WorkOrderAsset.asset_id)
        .where(WorkOrderAsset.work_order_id.in_([w.id for w in wos]))
        .order_by(WorkOrderAsset.work_order_id, WorkOrderAsset.sort, WorkOrderAsset.id)
    ).all()
    for wid, aid in rows:
        lst = out.setdefault(wid, [])
        if aid not in lst:
            lst.append(aid)
    return out


def on_assets(asset_ids: Any) -> ColumnElement[bool]:
    """SQL condition: the work order has any of `asset_ids` (a list or a subquery of ids)."""
    sub = select(WorkOrderAsset.work_order_id).where(WorkOrderAsset.asset_id.in_(asset_ids))
    return or_(WorkOrder.asset_id.in_(asset_ids), WorkOrder.id.in_(sub))


def parse_asset_ids(org_id: uuid.UUID, raw: Any) -> list[uuid.UUID]:
    """Validate a list of asset ids from a request: all in this organization, no duplicates, at most 50."""
    from mpro.assets.services import get_asset

    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError("Assets must be a list.", 422)
    out: list[uuid.UUID] = []
    for x in raw:
        if not x:
            continue
        a = get_asset(org_id, x)
        if a.id not in out:
            out.append(a.id)
    if len(out) > MAX_ASSETS:
        raise RuleError(f"A work order can have up to {MAX_ASSETS} assets.", 422)
    return out


def sync_rows(wo: WorkOrder, ids: list[uuid.UUID]) -> None:
    """Make work_order_assets match `ids` (in order). Caller sets wo.asset_id = ids[0]."""
    if wo.id is None:
        raise RuntimeError("work order without an id")
    existing = {
        r.asset_id: r for r in db.session.scalars(select(WorkOrderAsset).where(WorkOrderAsset.work_order_id == wo.id))
    }
    gone = [aid for aid in existing if aid not in ids]
    if gone:
        db.session.execute(
            delete(WorkOrderAsset).where(WorkOrderAsset.work_order_id == wo.id, WorkOrderAsset.asset_id.in_(gone))
        )
    for i, aid in enumerate(ids):
        row = existing.get(aid)
        if row is None:
            db.session.add(WorkOrderAsset(org_id=wo.org_id, work_order_id=wo.id, asset_id=aid, sort=i))
        elif row.sort != i:
            row.sort = i


def assets_map(wos: list[WorkOrder]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """{work order id: [{id, name, status}, …]} for serializing lists (deleted assets left out)."""
    from mpro.assets.models import Asset

    ids = asset_ids_for(wos)
    all_ids = {a for lst in ids.values() for a in lst}
    if not all_ids:
        return {w.id: [] for w in wos}
    assets = {
        a.id: a
        for a in db.session.scalars(select(Asset).where(Asset.id.in_(all_ids), Asset.deleted_at.is_(None))).all()
    }
    return {
        wid: [{"id": str(a), "name": assets[a].name, "status": assets[a].status} for a in lst if a in assets]
        for wid, lst in ids.items()
    }
