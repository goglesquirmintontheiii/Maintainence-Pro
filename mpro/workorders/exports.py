"""Work-order PDF (MaintainX "Export to PDF" with content toggles) and CSV exports.

A single PDF downloads straight away; PDFs of many work orders and CSV exports run in the background
and land in the Download Center.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from flask import current_app
from sqlalchemy import select

from mpro.core.files import Export, FileObject, exporter, storage
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.workorders.models import PRIORITY_LABELS, STATUS_LABELS, WORK_TYPE_LABELS, WorkOrder

PDF_SECTIONS = (
    "basic_info",
    "description",
    "custom_fields",
    "sub_work_orders",
    "costs",
    "attachments",
    "comments",
    "history",
    "estimated_time",
    "signature_line",
    "export_info",
)
IMAGE_SIZES = {"small": 90, "regular": 160, "large": 260, "original": 480, "links": 0}
DEFAULT_PDF = {"sections": list(PDF_SECTIONS), "image_size": "regular"}


def clean_pdf_options(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    sections = raw.get("sections")
    if not isinstance(sections, list):
        sections = list(PDF_SECTIONS)
    size = raw.get("image_size", "regular")
    return {
        "sections": [s for s in sections if s in PDF_SECTIONS],
        "image_size": size if size in IMAGE_SIZES else "regular",
    }


def _fmt_dt(dt: datetime | None, tz: ZoneInfo) -> str:
    return dt.astimezone(tz).strftime("%b %d, %Y %I:%M %p").replace(" 0", " ") if dt else "—"


def _money(cents: int | None, currency: str) -> str:
    if cents is None:
        return "—"
    return f"{currency} {cents / 100:,.2f}"


def render_pdf(m: Membership, org: Organization, wos: list[WorkOrder], options: dict[str, Any]) -> bytes:
    """One PDF with one work order per page group."""
    from xml.sax.saxutils import escape

    import segno
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        Image,
        KeepTogether,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    from mpro.workorders.activity import costs_summary, fmt_minutes
    from mpro.workorders.queries import detail_dict

    opts = clean_pdf_options(options)
    sec = set(opts["sections"])
    img_w = IMAGE_SIZES[opts["image_size"]]
    tz = ZoneInfo(org.timezone or "UTC")
    base = current_app.config.get("MPRO_BASE_URL", "").rstrip("/")
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "h1", parent=ss["Heading1"], fontSize=16, leading=20, spaceAfter=4, textColor=colors.HexColor("#172033")
    )
    h2 = ParagraphStyle(
        "h2",
        parent=ss["Heading2"],
        fontSize=11.5,
        leading=14,
        spaceBefore=10,
        spaceAfter=4,
        textColor=colors.HexColor("#172033"),
    )
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9.5, leading=12.5, alignment=TA_LEFT)
    small = ParagraphStyle("s", parent=body, fontSize=8, leading=10, textColor=colors.HexColor("#56627a"))
    grid = TableStyle(
        [
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#56627a")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
        ]
    )
    rows_style = TableStyle(
        [
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f5")),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#dde2ea")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]
    )

    def p(text: str, style: ParagraphStyle = body) -> Paragraph:
        return Paragraph(escape(text or "").replace("\n", "<br/>"), style)

    story: list[Any] = []
    for idx, wo in enumerate(wos):
        d = detail_dict(m, wo)
        url = f"{base}/work-orders/{wo.id}"
        qr = segno.make(url, error="m")
        qbuf = io.BytesIO()
        qr.save(qbuf, kind="png", scale=4, border=1)
        qbuf.seek(0)
        head = Table(
            [[
                [p(f"Work Order #{wo.number}", small), Paragraph(escape(wo.title), h1),
                 p(f"{STATUS_LABELS[wo.status]}{' · ' + wo.sub_status if wo.sub_status else ''} · "
                   f"Priority {PRIORITY_LABELS[wo.priority]}", body)],
                Image(qbuf, width=0.95 * inch, height=0.95 * inch),
            ]],
            colWidths=[5.6 * inch, 1.1 * inch],
        )  # fmt: skip
        head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (1, 0), (1, 0), "RIGHT")]))
        story.append(head)
        if "basic_info" in sec:
            assignees = ", ".join(a["name"] for a in d["assignees"]) or "Unassigned"
            info = [
                ["Assigned to", assignees],
                ["Due", _fmt_dt(wo.due_at, tz)],
                ["Start", _fmt_dt(wo.start_at, tz)],
                ["Work type", WORK_TYPE_LABELS[wo.work_type]],
                ["Categories", ", ".join(c["name"] for c in d["categories"]) or "—"],
                ["Asset", d["asset"]["name"] if d["asset"] else "—"],
                ["Location", d["location"]["name"] if d["location"] else "—"],
                ["Created", f"{_fmt_dt(wo.created_at, tz)} by {d['created_by']['name'] if d['created_by'] else '—'}"],
            ]
            if "estimated_time" in sec and wo.estimated_minutes:
                info.append(["Estimated time", fmt_minutes(wo.estimated_minutes)])
            if wo.completed_at:
                info.append(
                    [
                        "Completed",
                        f"{_fmt_dt(wo.completed_at, tz)} by {d['completed_by']['name'] if d['completed_by'] else '—'}",
                    ]
                )
            if d["parent"]:
                info.append(["Parent", f"#{d['parent']['number']} {d['parent']['title']}"])
            t = Table([[p(a, small), p(b)] for a, b in info], colWidths=[1.3 * inch, 5.4 * inch])
            t.setStyle(grid)
            story += [Spacer(1, 6), t]
        if "description" in sec and wo.description:
            story += [Paragraph("Description", h2), p(wo.description)]
        if "custom_fields" in sec:
            from mpro.workorders.services import custom_fields

            vals = [(f.name, wo.custom.get(str(f.id))) for f in custom_fields(org.id)]
            vals = [(n, v) for n, v in vals if v not in (None, "")]
            if vals:
                t = Table([[p(n, small), p("Yes" if v is True else "No" if v is False else str(v))] for n, v in vals],
                          colWidths=[1.8 * inch, 4.9 * inch])  # fmt: skip
                t.setStyle(grid)
                story += [Paragraph("Custom fields", h2), t]
        if wo.completion_summary:
            story += [Paragraph("Completion summary", h2), p(wo.completion_summary)]
        if wo.cancel_reason:
            story += [Paragraph("Cancel reason", h2), p(wo.cancel_reason)]
        if d.get("asset_tasks"):
            rows = [["Asset", "Status", "Notes"]] + [
                [p(x["asset"]["name"]), STATUS_LABELS[x["status"]], p(x["note"] or "—")] for x in d["asset_tasks"]
            ]
            t = Table(rows, colWidths=[2.4 * inch, 1.1 * inch, 3.2 * inch], repeatRows=1)
            t.setStyle(rows_style)
            story += [Paragraph("Asset tasks", h2), t]
        if "sub_work_orders" in sec and d["sub_work_orders"]:
            rows = [["#", "Title", "Status", "Due"]] + [
                [str(s["number"]), p(s["title"]), STATUS_LABELS[s["status"]], s["due_at"][:10] if s["due_at"] else "—"]
                for s in d["sub_work_orders"]
            ]
            t = Table(rows, colWidths=[0.6 * inch, 4.0 * inch, 1.0 * inch, 1.1 * inch], repeatRows=1)
            t.setStyle(rows_style)
            story += [Paragraph("Sub-work orders", h2), t]
        if "costs" in sec:
            c = costs_summary(m, wo)
            if c["time"] or c["costs"]:
                rows = [["Who", "What", "Amount"]]
                for te in c["time"]:
                    rows.append([te["user"]["name"], f"{te['time_type']} · {fmt_minutes(te['minutes'])}",
                                 _money(te["cost_cents"], org.currency)])  # fmt: skip
                for ce in c["costs"]:
                    rows.append([ce["user"]["name"] if ce["user"] else "—", f"{ce['cost_type']} · {ce['description']}",
                                 _money(ce["amount_cents"], org.currency)])  # fmt: skip
                rows.append(
                    [
                        "",
                        "Total",
                        _money(c["total_cents"], org.currency)
                        if c["total_cents"] is not None
                        else _money(c["other_cents"], org.currency),
                    ]
                )
                t = Table([[p(str(x)) if i else x for i, x in enumerate(r)] for r in rows],
                          colWidths=[1.8 * inch, 3.6 * inch, 1.3 * inch], repeatRows=1)  # fmt: skip
                t.setStyle(rows_style)
                story += [Paragraph(f"Time and costs ({fmt_minutes(c['total_minutes'])} logged)", h2), t]
        if "attachments" in sec and d["attachments"]:
            story.append(Paragraph("Pictures and files", h2))
            imgs: list[Any] = []
            for a in d["attachments"]:
                if a["is_image"] and img_w:
                    f = db.session.get(FileObject, uuid.UUID(a["id"]))
                    try:
                        raw = storage().get(f.thumb_key or f.storage_key) if f else b""
                        ib = Image(io.BytesIO(raw))
                        ratio = ib.imageHeight / ib.imageWidth if ib.imageWidth else 1
                        ib.drawWidth, ib.drawHeight = img_w, img_w * ratio
                        imgs.append(ib)
                    except Exception:
                        story.append(p(f"{a['name']} (image could not be included)", small))
                else:
                    story.append(p(f"{a['name']} — {base}{a['url']}", small))
            if imgs:
                per_row = max(1, int(6.7 * inch // (img_w + 6)))
                rows = [imgs[i : i + per_row] for i in range(0, len(imgs), per_row)]
                t = Table(rows)
                t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
                story.append(t)
        if "comments" in sec:
            from mpro.workorders.activity import comments_for

            cs = [c for c in comments_for(wo) if not c["deleted"]]
            if cs:
                story.append(Paragraph("Comments", h2))
                for c in cs:
                    who = c["author"]["name"] if c["author"] else "Someone"
                    when = _fmt_dt(datetime.fromisoformat(c["created_at"].replace("Z", "+00:00")), tz)
                    story += [p(f"{who} · {when}", small), p(_plain_mentions(c["body"])), Spacer(1, 4)]
        if "history" in sec:
            from mpro.core.events import DomainEvent

            evs = db.session.scalars(
                select(DomainEvent)
                .where(DomainEvent.entity_type == "work_order", DomainEvent.entity_id == str(wo.id))
                .order_by(DomainEvent.created_at)
            ).all()
            if evs:
                rows = [["When", "Who", "What"]] + [
                    [_fmt_dt(e.created_at, tz), e.actor_label, p(e.summary)] for e in evs
                ]
                t = Table(rows, colWidths=[1.6 * inch, 1.5 * inch, 3.6 * inch], repeatRows=1)
                t.setStyle(rows_style)
                story += [Paragraph("History", h2), t]
        if d["signature"]:
            f = db.session.get(FileObject, uuid.UUID(d["signature"]["file"]["id"]))
            try:
                ib = Image(io.BytesIO(storage().get(f.storage_key)) if f else io.BytesIO())
                ratio = ib.imageHeight / ib.imageWidth if ib.imageWidth else 0.4
                ib.drawWidth, ib.drawHeight = 2.2 * inch, 2.2 * inch * ratio
                story += [
                    Paragraph("Signature", h2),
                    ib,
                    p(f"{d['signature']['name']} · {_fmt_dt(wo.signed_at, tz)}", small),
                ]
            except Exception:
                pass
        elif "signature_line" in sec:
            sig = Table(
                [["", "", ""], [p("Signature", small), "", p("Date", small)]],
                colWidths=[3.6 * inch, 0.4 * inch, 2.0 * inch],
                rowHeights=[0.45 * inch, None],
            )
            sig.setStyle(
                TableStyle(
                    [
                        ("LINEBELOW", (0, 0), (0, 0), 0.8, colors.HexColor("#172033")),
                        ("LINEBELOW", (2, 0), (2, 0), 0.8, colors.HexColor("#172033")),
                        ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ]
                )
            )
            story.append(KeepTogether([Spacer(1, 18), sig]))
        if "export_info" in sec:
            story += [
                Spacer(1, 12),
                p(f"Exported {_fmt_dt(utcnow(), tz)} by {m.user.name} · {org.name} · {url}", small),
            ]
        if idx < len(wos) - 1:
            story.append(PageBreak())

    buf = io.BytesIO()

    def footer(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#8a94a8"))
        canvas.drawString(0.6 * inch, 0.45 * inch, f"Maintenance Pro · {org.name}")
        canvas.drawRightString(LETTER[0] - 0.6 * inch, 0.45 * inch, f"Page {doc.page}")
        canvas.restoreState()

    margins = {"leftMargin": 0.6 * inch, "rightMargin": 0.6 * inch, "topMargin": 0.6 * inch, "bottomMargin": 0.7 * inch}
    title = f"Work Order #{wos[0].number}" if len(wos) == 1 else f"{len(wos)} work orders"
    doc = SimpleDocTemplate(buf, pagesize=LETTER, title=title, author="Maintenance Pro", **margins)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()


def _plain_mentions(body: str) -> str:
    from mpro.workorders.services import MENTION_RE

    return MENTION_RE.sub(lambda mm: "@" + mm.group(1), body or "")


CSV_COLUMNS = [
    ("ID", lambda w, d: w.number),
    ("Title", lambda w, d: w.title),
    ("Status", lambda w, d: STATUS_LABELS[w.status]),
    ("Sub-status", lambda w, d: w.sub_status),
    ("Priority", lambda w, d: PRIORITY_LABELS[w.priority]),
    ("Work type", lambda w, d: WORK_TYPE_LABELS[w.work_type]),
    ("Assigned to", lambda w, d: "; ".join(a["name"] for a in d["assignees"])),
    ("Categories", lambda w, d: "; ".join(c["name"] for c in d["categories"])),
    ("Asset", lambda w, d: d["asset"]["name"] if d["asset"] else ""),
    ("Location", lambda w, d: d["location"]["name"] if d["location"] else ""),
    ("Start date", lambda w, d: d["start_at"] or ""),
    ("Due date", lambda w, d: d["due_at"] or ""),
    ("Estimated minutes", lambda w, d: w.estimated_minutes or ""),
    ("Created by", lambda w, d: d["created_by"]["name"] if d["created_by"] else ""),
    ("Created at", lambda w, d: d["created_at"] or ""),
    ("Completed at", lambda w, d: d["completed_at"] or ""),
    ("Description", lambda w, d: w.description),
]


def _safe_cell(v: Any) -> Any:
    """Stop spreadsheet formula injection (cells starting with = + - @)."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _member(ex: Export) -> tuple[Membership, Organization]:
    m = db.session.scalars(
        select(Membership).where(
            Membership.org_id == ex.org_id, Membership.user_id == ex.user_id, Membership.deleted_at.is_(None)
        )
    ).first()
    org = db.session.get(Organization, ex.org_id)
    if m is None or org is None:
        raise PermissionError("The person who asked for this export is no longer in the organization.")
    return m, org


def _export_wos(ex: Export, m: Membership) -> list[WorkOrder]:
    from mpro.workorders.queries import apply_sort, build_query

    params = dict(ex.params.get("query") or {})
    ids = ex.params.get("ids")
    q = build_query(m, params)
    if ids:
        q = q.where(WorkOrder.id.in_([uuid.UUID(i) for i in ids]))
    return list(db.session.scalars(apply_sort(q, params.get("sort")).limit(5000)).all())


@exporter("work_orders.csv")
def _csv(ex: Export) -> tuple[str, bytes, str]:
    from mpro.workorders.queries import summary_dict
    from mpro.workorders.services import custom_fields

    m, org = _member(ex)
    wos = _export_wos(ex, m)
    fields = custom_fields(org.id)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow([_safe_cell(c[0]) for c in CSV_COLUMNS] + [_safe_cell(f.name) for f in fields])
    for wo in wos:
        d = summary_dict(wo)
        w.writerow(
            [_safe_cell(fn(wo, d)) for _, fn in CSV_COLUMNS]
            + [_safe_cell((wo.custom or {}).get(str(f.id), "")) for f in fields]
        )
    return f"work-orders-{utcnow():%Y-%m-%d}.csv", ("﻿" + out.getvalue()).encode("utf-8"), "text/csv"


@exporter("work_orders.pdf")
def _pdf(ex: Export) -> tuple[str, bytes, str]:
    m, org = _member(ex)
    wos = _export_wos(ex, m)[:500]
    if not wos:
        raise ValueError("No work orders matched.")
    data = render_pdf(m, org, wos, ex.params.get("options") or {})
    name = f"work-order-{wos[0].number}.pdf" if len(wos) == 1 else f"work-orders-{utcnow():%Y-%m-%d}.pdf"
    return name, data, "application/pdf"
