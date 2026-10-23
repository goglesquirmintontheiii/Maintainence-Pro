"""Branded PDFs for purchase orders (MP-043) and customer quotes (r235), with reportlab."""

from __future__ import annotations

import io
from decimal import Decimal
from typing import Any
from xml.sax.saxutils import escape

from sqlalchemy import select

from mpro.extensions import db
from mpro.orgs.models import Organization


def _money(d: Decimal | None, cur: str) -> str:
    if d is None:
        return ""
    return f"{cur} {Decimal(d).quantize(Decimal('0.01')):,}".strip()


def _qty(d: Decimal | None) -> str:
    if d is None:
        return ""
    d = Decimal(d)
    return str(d.quantize(Decimal("1"))) if d == d.to_integral() else format(d.normalize(), "f")


def _addr(a: Any) -> str:
    if a is None:
        return ""
    if isinstance(a, dict):
        parts = [
            a.get("line1"),
            a.get("line2"),
            " ".join(x for x in [a.get("city"), a.get("region"), a.get("postal_code")] if x),
            a.get("country"),
        ]
        return "\n".join(x for x in parts if x)
    parts = [
        a.company,
        a.attention and f"Attn: {a.attention}",
        a.line1,
        a.line2,
        " ".join(x for x in [a.city, a.region, a.postal_code] if x),
        a.country,
        a.phone,
    ]
    return "\n".join(x for x in parts if x)


def _doc(
    title_small: str,
    title: str,
    org: Organization,
    blocks: list[tuple[str, str]],
    head: list[str],
    rows: list[list[str]],
    totals: list[tuple[str, str]],
    notes: str,
    banner: str = "",
) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ss = getSampleStyleSheet()
    ink = colors.HexColor("#172033")
    dim = colors.HexColor("#56627a")
    h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontSize=17, leading=21, textColor=ink, spaceAfter=2)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9.5, leading=12.5)
    small = ParagraphStyle("s", parent=body, fontSize=8, leading=10, textColor=dim)
    strong = ParagraphStyle("st", parent=body, fontName="Helvetica-Bold")

    def p(t: str, st: ParagraphStyle = body) -> Paragraph:
        return Paragraph(escape(t or "").replace("\n", "<br/>"), st)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title=title,
        author=org.name,
    )
    story: list[Any] = [
        Table(
            [[[p(org.name, strong), p(title_small, small)], [p(title, h1)]]],
            colWidths=[3.6 * inch, 3.5 * inch],
            style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (1, 0), (1, 0), "RIGHT")]),
        ),
        Spacer(1, 8),
    ]
    if banner:
        story += [
            Table(
                [[p(banner, strong)]],
                colWidths=[7.1 * inch],
                style=TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#dcf2e8")),
                        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#13805a")),
                    ]
                ),
            ),
            Spacer(1, 8),
        ]
    cells = [[p(k, small), p(v)] for k, v in blocks if v]
    if cells:
        grid_rows = []
        for i in range(0, len(cells), 2):
            left = cells[i]
            right = cells[i + 1] if i + 1 < len(cells) else ["", ""]
            grid_rows.append([left[0], left[1], right[0], right[1]])
        story.append(
            Table(
                grid_rows,
                colWidths=[0.95 * inch, 2.6 * inch, 0.95 * inch, 2.6 * inch],
                style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]),
            )
        )
        story.append(Spacer(1, 10))
    widths = [2.9 * inch, 1.2 * inch, 0.8 * inch, 1.1 * inch, 1.1 * inch][: len(head)]
    t = Table(
        [[p(h, small) for h in head]] + [[p(c) for c in r] for r in rows] or [[p("No lines")]],
        colWidths=widths,
        repeatRows=1,
    )
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f5")),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#dde2ea")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
            ]
        )
    )
    story += [t, Spacer(1, 8)]
    if totals:
        tt = Table(
            [
                [p(k, strong if i == len(totals) - 1 else body), p(v, strong if i == len(totals) - 1 else body)]
                for i, (k, v) in enumerate(totals)
            ],
            colWidths=[1.8 * inch, 1.3 * inch],
            hAlign="RIGHT",
        )
        tt.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("LINEABOVE", (0, -1), (-1, -1), 0.5, ink)]))
        story.append(tt)
    if notes:
        story += [Spacer(1, 12), p("Notes", small), p(notes)]
    doc.build(story)
    return buf.getvalue()


def po_pdf(po: Any) -> bytes:
    from mpro.purchasing.models import Address, PurchaseOrderCost
    from mpro.purchasing.services import compute_totals, costs_of, lines_of, po_number
    from mpro.vendors.models import Vendor, VendorContact

    org = db.session.get(Organization, po.org_id)
    assert org is not None
    v = db.session.get(Vendor, po.vendor_id) if po.vendor_id else None
    contacts = (
        [
            c
            for c in db.session.scalars(
                select(VendorContact).where(VendorContact.vendor_id == po.vendor_id, VendorContact.deleted_at.is_(None))
            )
        ]
        if v
        else []
    )
    chosen = [c for c in contacts if str(c.id) in (po.vendor_contact_ids or [])] or [
        c for c in contacts if c.is_po_contact
    ]
    ship = db.session.get(Address, po.shipping_address_id) if po.shipping_address_id else None
    bill = db.session.get(Address, po.billing_address_id) if po.billing_address_id else None
    lines, costs = lines_of(po), costs_of(po)
    t = compute_totals(lines, costs)
    cur = po.currency or org.currency
    vendor_txt = "\n".join(
        x
        for x in [
            v.name if v else "",
            _addr(v.address) if v else "",
            v.email if v else "",
            ", ".join(f"{c.name} <{c.email}>" for c in chosen),
        ]
        if x
    )
    blocks = [
        ("Vendor", vendor_txt),
        ("Ship to", _addr(ship)),
        ("Bill to", _addr(bill)),
        ("Date", po.created_at.date().isoformat()),
        ("Due", po.due_on.isoformat() if po.due_on else ""),
        ("Account #", v.account_number if v else ""),
        ("Terms", v.payment_terms if v else ""),
    ]
    rows = [
        [
            ln.description + (f"\n{ln.part_number}" if ln.part_number else ""),
            ln.unit,
            _qty(ln.quantity),
            _money(ln.unit_cost, cur),
            _money((ln.quantity * ln.unit_cost).quantize(Decimal("0.01")), cur),
        ]
        for ln in lines
    ]
    totals = [("Subtotal", _money(t["subtotal"], cur))]
    for c in costs:
        assert isinstance(c, PurchaseOrderCost)
        label = c.label + (f" ({_qty(c.value)}%)" if c.kind == "percent" else "")
        totals.append((label, _money(t["amounts"].get(c.id), cur)))
    totals.append(("Total", _money(t["total"], cur)))
    banner = ""
    if po.tax_exempt:
        num = ""
        if po.tax_certificate_id:
            try:
                from mpro.finance.models import TaxCertificate

                cert = db.session.get(TaxCertificate, po.tax_certificate_id)
                num = cert.number if cert else ""
            except Exception:  # noqa: BLE001
                num = ""
        banner = f"Tax exempt – certificate #{num}" if num else "Tax exempt"
    return _doc(
        po.title or "Purchase Order",
        po_number(po),
        org,
        blocks,
        ["Item", "Unit", "Qty", "Unit cost", "Amount"],
        rows,
        totals,
        po.notes,
        banner,
    )


def quote_pdf(q: Any) -> bytes:
    from mpro.vendors.models import Customer, QuoteLine

    org = db.session.get(Organization, q.org_id)
    assert org is not None
    cust = db.session.get(Customer, q.customer_id)
    lines = list(db.session.scalars(select(QuoteLine).where(QuoteLine.quote_id == q.id).order_by(QuoteLine.sort)))
    cur = q.currency or org.currency
    blocks = [
        (
            "Customer",
            "\n".join(x for x in [cust.name if cust else "", _addr(cust.billing_address) if cust else ""] if x),
        ),
        ("Date", q.created_at.date().isoformat()),
        ("Valid until", q.valid_until.isoformat() if q.valid_until else ""),
        ("Status", q.status.capitalize()),
    ]
    rows = [
        [
            ln.description,
            ln.kind.capitalize(),
            _qty(ln.quantity),
            _money(ln.unit_price, cur),
            _money((ln.quantity * ln.unit_price).quantize(Decimal("0.01")), cur),
        ]
        for ln in lines
    ]
    totals = [("Subtotal", _money(q.subtotal, cur)), ("Tax", _money(q.tax, cur)), ("Total", _money(q.total, cur))]
    banner = f"Approved by {q.decided_by_name}" if q.status == "approved" and q.decided_by_name else ""
    return _doc(
        "Quote",
        f"Quote {q.number}: {q.title}",
        org,
        blocks,
        ["Item", "Type", "Qty", "Price", "Amount"],
        rows,
        totals,
        q.scope,
        banner,
    )
