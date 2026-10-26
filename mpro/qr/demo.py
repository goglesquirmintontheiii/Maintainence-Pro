"""Demo scans (0.6.0, MP-097): check-ins on an inspection round, as proof of visit."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.qr import services as qsvc
from mpro.qr.models import ScanEvent
from mpro.qr.scan import _record


def seed_scans(org: Any, admin: Any) -> None:
    if db.session.scalar(select(ScanEvent.id).where(ScanEvent.org_id == org.id).limit(1)) is not None:
        return
    from mpro.procedures.models import ProcedureRun
    from mpro.workorders.models import WorkOrder, WorkOrderAsset

    m = db.session.scalars(select(Membership).filter_by(org_id=org.id, user_id=admin.id)).first()
    if m is None:
        return
    runs = select(ProcedureRun.work_order_id)
    wos = db.session.scalars(
        select(WorkOrder)
        .where(WorkOrder.org_id == org.id, WorkOrder.deleted_at.is_(None), WorkOrder.id.in_(runs))
        .order_by(WorkOrder.status != "done", WorkOrder.number)
        .limit(3)
    ).all()
    for i, wo in enumerate(wos):
        start = wo.created_at + timedelta(minutes=20 + i * 7)
        if wo.location is not None:
            c = qsvc.ensure_code(org, m, "location", wo.location_id, commit=False)
            _record(org.id, admin.id, "location", wo.location, "check_in", code_id=c.id, work_order_id=wo.id,
                    scanned_at=start)  # fmt: skip
        asset_ids = list(
            db.session.scalars(select(WorkOrderAsset.asset_id).where(WorkOrderAsset.work_order_id == wo.id)).all()
        ) or ([wo.asset_id] if wo.asset_id else [])
        from mpro.assets.models import Asset

        for n, aid in enumerate(asset_ids[:4]):
            a = db.session.get(Asset, aid)
            if a is None:
                continue
            c = qsvc.ensure_code(org, m, "asset", a.id, commit=False)
            _record(org.id, admin.id, "asset", a, "scan", code_id=c.id, work_order_id=wo.id,
                    scanned_at=start + timedelta(minutes=6 * (n + 1)))  # fmt: skip
    db.session.flush()
