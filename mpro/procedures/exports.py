"""Procedure answers across work orders as CSV in the Download Center (MP-037)."""

from __future__ import annotations

import csv
import io
import uuid
from typing import Any

from sqlalchemy import select

from mpro.core.files import Export, exporter
from mpro.core.models import iso, utcnow
from mpro.core.permissions import can
from mpro.extensions import db
from mpro.procedures import schema as sch
from mpro.procedures.models import Procedure, ProcedureAnswer, ProcedureRun, ProcedureVersion
from mpro.workorders.models import WorkOrder


def _safe(v: Any) -> Any:
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _cell(a: ProcedureAnswer | None) -> Any:
    if a is None:
        return ""
    if a.skipped:
        return "Skipped"
    v = a.value
    if a.result in ("pass", "flag", "fail"):
        return a.result.capitalize()
    if a.result in ("yes", "no"):
        return a.result.capitalize()
    if a.result == "na":
        return "N/A"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, list):
        return "; ".join(str(x) for x in v) if a.field_type != "file" else f"{len(v)} file(s)"
    if isinstance(v, dict):
        if "value" in v:
            return v["value"]
        if "name" in v:
            return f"Signed by {v['name']}"
        if "distance_m" in v:
            return f"Checked in ({v['distance_m']} m)"
        return "Checked in"
    return v if v is not None else ""


@exporter("procedures.csv")
def _export(ex: Export) -> tuple[str, bytes, str]:
    from mpro.workorders.exports import _member
    from mpro.workorders.services import _dt, visibility_filter

    m, _org = _member(ex)
    if not can(m, "procedures.view"):
        raise PermissionError("You no longer have access to procedures.")
    p = db.session.get(Procedure, uuid.UUID(ex.params["procedure_id"]))
    if p is None or p.org_id != m.org_id:
        raise ValueError("That procedure no longer exists.")
    q = (
        select(ProcedureRun, WorkOrder)
        .join(WorkOrder, WorkOrder.id == ProcedureRun.work_order_id)
        .where(ProcedureRun.procedure_id == p.id, WorkOrder.deleted_at.is_(None), visibility_filter(m))
    )
    if ex.params.get("from"):
        q = q.where(WorkOrder.created_at >= _dt(ex.params["from"], "From"))
    if ex.params.get("to"):
        q = q.where(WorkOrder.created_at <= _dt(ex.params["to"], "To"))
    rows = db.session.execute(q.order_by(WorkOrder.number)).all()
    # columns: every field ever in the procedure, in the order of the newest version
    order: list[str] = []
    labels: dict[str, str] = {}
    versions = db.session.scalars(
        select(ProcedureVersion).where(ProcedureVersion.procedure_id == p.id).order_by(ProcedureVersion.number.desc())
    ).all()
    vnum = {v.id: v.number for v in versions}
    for v in versions:
        for f in sch.fields(v.schema or {}):
            if f["id"] not in labels:
                labels[f["id"]] = f["label"]
                order.append(f["id"])
    run_ids = [r.id for r, _ in rows]
    answers: dict[Any, dict[str, ProcedureAnswer]] = {}
    if run_ids:
        for a in db.session.scalars(select(ProcedureAnswer).where(ProcedureAnswer.run_id.in_(run_ids))).all():
            answers.setdefault(a.run_id, {})[a.field_id] = a
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            _safe(x)
            for x in [
                "Work order",
                "Title",
                "Status",
                "Asset",
                "Location",
                "Completed",
                "Version",
                "Score %",
                *[labels[k] for k in order],
            ]
        ]
    )
    for run, wo in rows:
        got = answers.get(run.id, {})
        w.writerow(
            [
                _safe(x)
                for x in [
                    wo.number,
                    wo.title,
                    wo.status,
                    wo.asset.name if wo.asset else "",
                    wo.location.name if wo.location else "",
                    iso(wo.completed_at) or "",
                    vnum.get(run.version_id, ""),
                    float(run.score) if run.score is not None else "",
                    *[_cell(got.get(k)) for k in order],
                ]
            ]
        )
    safe_name = "".join(c if c.isalnum() else "-" for c in p.name.lower()).strip("-")[:50] or "procedure"
    return f"{safe_name}-answers-{utcnow():%Y-%m-%d}.csv", ("﻿" + out.getvalue()).encode("utf-8"), "text/csv"


def pdf_story(wo: WorkOrder, h2: Any, body: Any, small: Any, rows_style: Any) -> list[Any]:
    """The work order PDF's Procedures section: every step with its answer, and signatures (r204)."""
    from xml.sax.saxutils import escape

    from reportlab.lib.units import inch
    from reportlab.platypus import Image, Paragraph, Table

    from mpro.core.files import FileObject, storage

    story: list[Any] = []
    runs = db.session.scalars(
        select(ProcedureRun).where(ProcedureRun.work_order_id == wo.id).order_by(ProcedureRun.sort)
    ).all()
    for run in runs:
        p = db.session.get(Procedure, run.procedure_id)
        v = db.session.get(ProcedureVersion, run.version_id)
        if p is None or v is None:
            continue
        answers = {
            a.field_id: a
            for a in db.session.scalars(select(ProcedureAnswer).where(ProcedureAnswer.run_id == run.id)).all()
        }
        title = escape(p.name) + (f" — score {float(run.score):g}%" if run.score is not None else "")
        story.append(Paragraph(title, h2))
        rows: list[list[Any]] = [["Step", "Answer"]]
        sigs: list[Any] = []
        for f in sch.walk(v.schema.get("items") or [], include_structure=True):
            if f["type"] in ("heading", "section", "procedure"):
                if f.get("label"):
                    rows.append([Paragraph(f"<b>{escape(f['label'])}</b>", body), ""])
                continue
            a = answers.get(f["id"])
            val = _cell(a)
            if a is not None and a.note:
                val = f"{val} — {a.note}" if val != "" else a.note
            rows.append([Paragraph(escape(f["label"]), body), Paragraph(escape(str(val)) if val != "" else "—", body)])
            if f["type"] == "signature" and a is not None and isinstance(a.value, dict) and a.value.get("file_id"):
                fo = db.session.get(FileObject, uuid.UUID(a.value["file_id"]))
                if fo is not None:
                    try:
                        img = Image(io.BytesIO(storage().get(fo.storage_key)), width=1.8 * inch, height=0.6 * inch)
                        sigs.append(
                            Table(
                                [[img, Paragraph(f"Signed by {escape(a.value.get('name', ''))}", small)]],
                                colWidths=[2 * inch, 4.7 * inch],
                            )
                        )
                    except Exception:  # noqa: BLE001 - a missing signature image shouldn't break the PDF
                        pass
        t = Table(rows, colWidths=[3.2 * inch, 3.5 * inch], repeatRows=1)
        t.setStyle(rows_style)
        story += [t, *sigs]
    return story
