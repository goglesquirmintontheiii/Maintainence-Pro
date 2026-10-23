"""Customer invoices for service work (MP-093), statements and the ageing report.

An invoice is built from one or several completed work orders: labour from logged time at the customer's billing rate
(else the organization's, else the person's cost rate), parts used with the markup, and other costs. Tax follows the
customer's location (Settings → tax rates by country-region), or is zero when the customer's own exemption certificate
is on file. Online payment links are an MPro Cloud feature (mpro.cloud.payments).
"""

from __future__ import annotations

import io
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy import update as sa_update

from mpro.core.events import emit
from mpro.core.files import FileLink, FileObject, attach, file_dict, links_for, save_file
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.finance import vault
from mpro.finance.common import (
    ZERO,
    cents,
    customer_label,
    get_in_org,
    money,
    org_currency,
    paged,
    parse_date,
    s,
    today,
    user_label,
)
from mpro.finance.models import CustomerInvoice, CustomerInvoiceLine, Payment
from mpro.orgs.services import RuleError

HOUR = Decimal("60")


def _settings(org_id: uuid.UUID) -> dict[str, Any]:
    from mpro.finance.settings import finance_settings

    return finance_settings(org_id)


def number_label(org_id: uuid.UUID, ci: CustomerInvoice) -> str:
    prefix = str(_settings(org_id).get("invoice_prefix") or "")
    return ("CN-" if ci.kind == "credit_note" else prefix) + str(ci.number)


def _next_number(org_id: uuid.UUID) -> int:
    from mpro.workorders.models import Counter

    key = "customer_invoice"
    q = select(Counter).where(Counter.org_id == org_id, Counter.key == key)
    if db.engine.dialect.name == "postgresql":
        q = q.with_for_update()
    c = db.session.scalars(q).first()
    if c is None:
        current = (
            db.session.scalar(select(func.max(CustomerInvoice.number)).where(CustomerInvoice.org_id == org_id)) or 0
        )
        from sqlalchemy.exc import IntegrityError

        try:
            with db.session.begin_nested():
                db.session.add(Counter(org_id=org_id, key=key, value=int(current)))
        except IntegrityError:
            pass
        c = db.session.scalars(q).first()
        assert c is not None
    res = db.session.execute(
        sa_update(Counter).where(Counter.id == c.id).values(value=Counter.value + 1).returning(Counter.value)
    )
    return int(res.scalar_one())


def _customer_region(cust: Any) -> tuple[str, str, uuid.UUID | None]:
    from mpro.assets.models import Location
    from mpro.finance.certificates import norm_country, norm_region

    loc = db.session.get(Location, cust.default_location_id) if cust.default_location_id else None
    if loc is not None and (loc.country or loc.region):
        return norm_country(loc.country) or "US", norm_region(loc.region), loc.id
    a = cust.billing_address or {}
    return norm_country(str(a.get("country") or "")) or "US", norm_region(str(a.get("region") or "")), None


def tax_for(org_id: uuid.UUID, cust: Any) -> tuple[Decimal, uuid.UUID | None]:
    """(rate %, exemption certificate id). The customer's valid certificate for its region means no tax."""
    from mpro.finance.certificates import covering_certificate

    country, region, loc_id = _customer_region(cust)
    cert = covering_certificate(
        org_id,
        vendor_id=None,
        country=country,
        region=region,
        location_id=loc_id,
        customer_id=cust.id,
        require_vendor=False,
    )
    if cert is not None:
        return ZERO, cert.id
    cfg = _settings(org_id)
    rates = cfg.get("tax_rates") or {}
    rate = rates.get(f"{country}-{region}") or rates.get(country) or cfg.get("default_tax_rate_pct") or "0"
    return Decimal(str(rate)), None


def _rate_for(cust: Any, cfg: dict[str, Any], entry: Any) -> Decimal:
    if cust.labor_rate is not None:
        return Decimal(cust.labor_rate)
    if cfg.get("labor_rate"):
        return Decimal(str(cfg["labor_rate"]))
    return Decimal(entry.effective_rate_cents or 0) / 100


def lines_from_work_orders(
    org_id: uuid.UUID, cust: Any, wos: list[Any], include: dict[str, bool]
) -> list[dict[str, Any]]:
    from mpro.auth.models import User
    from mpro.parts.models import Part, WorkOrderPart
    from mpro.workorders.models import CostEntry, TimeEntry

    cfg = _settings(org_id)
    markup = Decimal(
        str(cust.parts_markup_pct if cust.parts_markup_pct is not None else cfg.get("parts_markup_pct") or "0")
    )
    out: list[dict[str, Any]] = []
    for wo in wos:
        if include.get("labor", True):
            for te in db.session.scalars(
                select(TimeEntry).where(TimeEntry.work_order_id == wo.id).order_by(TimeEntry.created_at)
            ):
                u = db.session.get(User, te.user_id)
                hours = (Decimal(te.minutes) / HOUR).quantize(Decimal("0.01"))
                rate = _rate_for(cust, cfg, te)
                out.append(
                    {
                        "kind": "labor",
                        "work_order_id": wo.id,
                        "source_id": te.id,
                        "description": f"#{wo.number} {wo.title}: {te.time_type} — {u.name if u else 'Technician'}",
                        "quantity": hours,
                        "unit_price": rate,
                        "taxable": False,
                    }
                )
        if include.get("parts", True):
            at_use = _ledger_part_costs(org_id, wo.id)
            for wp in db.session.scalars(select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id)):
                if not wp.used:
                    continue
                part = db.session.get(Part, wp.part_id)
                if wp.unit_cost_override is not None:
                    unit = wp.unit_cost_override
                elif wp.part_id in at_use:
                    unit = at_use[wp.part_id]
                else:
                    unit = part.unit_cost if part else ZERO
                price = (unit * (1 + markup / 100)).quantize(Decimal("0.0001"))
                out.append(
                    {
                        "kind": "part",
                        "work_order_id": wo.id,
                        "source_id": wp.id,
                        "description": f"#{wo.number} {part.name if part else 'Part'}"
                        + (f" ({part.part_number})" if part and part.part_number else ""),
                        "quantity": wp.used,
                        "unit_price": price,
                        "taxable": True,
                    }
                )
        if include.get("costs", True):
            for ce in db.session.scalars(select(CostEntry).where(CostEntry.work_order_id == wo.id)):
                out.append(
                    {
                        "kind": "cost",
                        "work_order_id": wo.id,
                        "source_id": ce.id,
                        "description": f"#{wo.number} {ce.cost_type}"
                        + (f": {ce.description}" if ce.description else ""),
                        "quantity": Decimal("1"),
                        "unit_price": Decimal(ce.amount_cents) / 100,
                        "taxable": True,
                    }
                )
    return out


def billed_work_order_ids(org_id: uuid.UUID) -> set[str]:
    """Work orders already on an invoice that isn't void (a work order is billed once; review #6)."""
    billed: set[str] = set()
    for ids in db.session.scalars(
        select(CustomerInvoice.work_order_ids).where(
            CustomerInvoice.org_id == org_id,
            CustomerInvoice.deleted_at.is_(None),
            CustomerInvoice.kind == "invoice",
            CustomerInvoice.status != "void",
        )
    ):
        billed |= {str(x) for x in (ids or [])}
    return billed


def _ledger_part_costs(org_id: uuid.UUID, wo_id: uuid.UUID) -> dict[uuid.UUID, Decimal]:
    """Average cost per unit of each part as it was when used on the work order (from the ledger rows, review #11)."""
    from mpro.parts.models import InventoryTransaction

    qty: dict[uuid.UUID, Decimal] = {}
    cost: dict[uuid.UUID, Decimal] = {}
    for t in db.session.scalars(
        select(InventoryTransaction).where(
            InventoryTransaction.org_id == org_id,
            InventoryTransaction.work_order_id == wo_id,
            InventoryTransaction.kind.in_(("use", "return")),
        )
    ):
        used = -(t.quantity or ZERO)  # use rows are negative, returns positive
        qty[t.part_id] = qty.get(t.part_id, ZERO) + used
        cost[t.part_id] = cost.get(t.part_id, ZERO) + used * (t.unit_cost or ZERO)
    return {pid: (cost[pid] / q).quantize(Decimal("0.0001")) for pid, q in qty.items() if q > ZERO}


def create(org_id: uuid.UUID, user: Any, data: dict[str, Any]) -> CustomerInvoice:
    """{customer_id, work_order_ids?: [...], include?: {labor, parts, costs}, lines?: [...], notes?, due_date?}"""
    from mpro.vendors.models import Customer
    from mpro.workorders.models import WorkOrder

    cust = get_in_org(Customer, org_id, data.get("customer_id"), "customer", allow_none=False)
    ids = data.get("work_order_ids") or []
    if not isinstance(ids, list) or len(ids) > 100:
        raise RuleError("Work orders must be a list (at most 100).", 422)
    wos = [get_in_org(WorkOrder, org_id, x, "work order", allow_none=False) for x in ids]
    for wo in wos:
        if wo.status != "done":
            raise RuleError(f"Work order #{wo.number} isn't done yet.", 422)
        if wo.customer_id is not None and wo.customer_id != cust.id:
            raise RuleError(f"Work order #{wo.number} belongs to another customer.", 422)
    if len({w.id for w in wos}) != len(wos):
        raise RuleError("A work order is listed twice.", 422)
    already = billed_work_order_ids(org_id)
    for wo in wos:
        if str(wo.id) in already:
            raise RuleError(f"Work order #{wo.number} is already on an invoice.", 409)
    rate, cert_id = tax_for(org_id, cust)
    cfg = _settings(org_id)
    ci = CustomerInvoice(
        org_id=org_id,
        number=_next_number(org_id),
        customer_id=cust.id,
        status="draft",
        kind="invoice",
        currency=cust.currency or org_currency(org_id),
        work_order_ids=[str(w.id) for w in wos],
        tax_rate_pct=rate,
        tax_certificate_id=cert_id,
        notes=str(data.get("notes") or cfg.get("invoice_footer") or "")[:4000],
        created_by_id=user.id,
    )
    ci.due_date = parse_date(data.get("due_date"), "due date")
    db.session.add(ci)
    db.session.flush()
    rows = lines_from_work_orders(org_id, cust, wos, data.get("include") or {})
    rows += _parse_lines(data.get("lines") or [])
    for i, r in enumerate(rows):
        db.session.add(_line(org_id, ci.id, i, r))
    db.session.flush()
    recompute(ci)
    _index(ci)
    emit(
        "customer_invoice.created",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=number_label(org_id, ci),
        summary=f"Draft for {cust.name}",
        org_id=org_id,
    )
    return ci


def _parse_lines(lines: Any) -> list[dict[str, Any]]:
    if not isinstance(lines, list) or len(lines) > 500:
        raise RuleError("Lines must be a list (at most 500).", 422)
    out = []
    for ln in lines:
        if not isinstance(ln, dict) or not str(ln.get("description") or "").strip():
            raise RuleError("Each line needs a description.", 422)
        kind = ln.get("kind") or "other"
        if kind not in ("labor", "part", "cost", "other"):
            raise RuleError("Unknown line kind.", 422)
        out.append(
            {
                "kind": kind,
                "description": str(ln["description"]).strip()[:500],
                "quantity": money(ln.get("quantity", 1), "quantity"),
                "unit_price": money(ln.get("unit_price", 0), "price"),
                "taxable": bool(ln.get("taxable", kind != "labor")),
                "work_order_id": ln.get("work_order_id"),
                "source_id": ln.get("source_id"),
            }
        )
    return out


def _line(org_id: uuid.UUID, inv_id: uuid.UUID, sort: int, r: dict[str, Any]) -> CustomerInvoiceLine:
    def u(v: Any) -> uuid.UUID | None:
        try:
            return v if isinstance(v, uuid.UUID) else (uuid.UUID(str(v)) if v else None)
        except ValueError:
            return None

    qty, price = Decimal(r["quantity"]), Decimal(r["unit_price"])
    return CustomerInvoiceLine(
        org_id=org_id,
        invoice_id=inv_id,
        sort=sort,
        kind=r["kind"],
        work_order_id=u(r.get("work_order_id")),
        source_id=u(r.get("source_id")),
        description=r["description"][:500],
        quantity=qty,
        unit_price=price,
        amount=cents(qty * price),
        taxable=bool(r.get("taxable", True)),
    )


def lines(ci: CustomerInvoice) -> list[CustomerInvoiceLine]:
    return list(
        db.session.scalars(
            select(CustomerInvoiceLine)
            .where(CustomerInvoiceLine.invoice_id == ci.id)
            .order_by(CustomerInvoiceLine.sort)
        )
    )


def recompute(ci: CustomerInvoice) -> None:
    ls = lines(ci)
    ci.subtotal = cents(sum((ln.amount for ln in ls), ZERO))
    taxable = sum((ln.amount for ln in ls if ln.taxable), ZERO)
    ci.tax = cents(taxable * (ci.tax_rate_pct or ZERO) / 100)
    ci.total = cents(ci.subtotal + ci.tax)


def update(org_id: uuid.UUID, ci: CustomerInvoice, data: dict[str, Any]) -> CustomerInvoice:
    if ci.status != "draft":
        raise RuleError("Only draft invoices can be edited. Void it or issue a credit note instead.", 409)
    if "lines" in data:
        for old in lines(ci):
            db.session.delete(old)
        db.session.flush()
        for i, r in enumerate(_parse_lines(data["lines"])):
            db.session.add(_line(org_id, ci.id, i, r))
        db.session.flush()
    if "tax_rate_pct" in data:
        if ci.tax_certificate_id and data["tax_rate_pct"] not in (None, "", "0", 0):
            raise RuleError("This customer is tax-exempt (certificate on file).", 409)
        ci.tax_rate_pct = money(data["tax_rate_pct"], "tax rate")
    for k in ("issue_date", "due_date"):
        if k in data:
            setattr(ci, k, parse_date(data[k], k.replace("_", " ")))
    if "notes" in data:
        ci.notes = str(data["notes"] or "")[:4000]
    recompute(ci)
    if ci.kind == "credit_note" and ci.credit_for_id:
        inv = db.session.get(CustomerInvoice, ci.credit_for_id)
        if inv is not None and (ci.total or ZERO) > credit_room(inv, exclude_id=ci.id):
            raise RuleError("The credit is larger than what's left to credit on the invoice.", 422)
    _index(ci)
    emit(
        "customer_invoice.updated",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=number_label(org_id, ci),
        summary="Edited",
        org_id=org_id,
    )
    return ci


def render_pdf(org_id: uuid.UUID, ci: CustomerInvoice) -> bytes:
    """Branded PDF: organization, customer, lines, tax (or the exemption), totals and the footer."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from mpro.finance.models import TaxCertificate
    from mpro.orgs.models import Organization
    from mpro.vendors.models import Customer

    org = db.session.get(Organization, org_id)
    cust = db.session.get(Customer, ci.customer_id)
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontSize=18, textColor=colors.HexColor("#172033"))
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9.5, leading=12.5)
    small = ParagraphStyle("s", parent=body, fontSize=8, textColor=colors.HexColor("#56627a"))
    from xml.sax.saxutils import escape as e

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title=f"{'Credit note' if ci.kind == 'credit_note' else 'Invoice'} {number_label(org_id, ci)}",
    )
    story: list[Any] = [
        Paragraph(e(org.name if org else ""), small),
        Paragraph(("Credit note " if ci.kind == "credit_note" else "Invoice ") + e(number_label(org_id, ci)), h1),
    ]
    a = (cust.billing_address or {}) if cust else {}
    addr = "<br/>".join(
        e(str(x))
        for x in (
            cust.name if cust else "",
            a.get("line1"),
            a.get("line2"),
            " ".join(str(y) for y in (a.get("city"), a.get("region"), a.get("postal_code")) if y),
            a.get("country"),
        )
        if x
    )
    meta = (
        f"Issued: {ci.issue_date or today():%B %d, %Y}<br/>"
        + (f"Due: {ci.due_date:%B %d, %Y}<br/>" if ci.due_date else "")
        + f"Currency: {ci.currency}"
    )
    story.append(
        Table(
            [[Paragraph("<b>Bill to</b><br/>" + addr, body), Paragraph(meta, body)]],
            colWidths=[3.6 * inch, 3.3 * inch],
            style=[("VALIGN", (0, 0), (-1, -1), "TOP")],
        )
    )
    story.append(Spacer(1, 14))
    rows: list[list[Any]] = [["Description", "Qty", "Unit price", "Amount"]]
    for ln in lines(ci):
        rows.append([Paragraph(e(ln.description), body), _fmt(ln.quantity), _fmt(ln.unit_price, 2), _fmt(ln.amount, 2)])
    rows.append(["", "", "Subtotal", _fmt(ci.subtotal, 2)])
    if ci.tax_certificate_id:
        cert = db.session.get(TaxCertificate, ci.tax_certificate_id)
        rows.append(["", "", "Tax", "Exempt"])
        story_note = f"Tax exempt – certificate #{cert.number}" if cert and cert.number else "Tax exempt"
    else:
        rows.append(["", "", f"Tax ({_fmt(ci.tax_rate_pct or ZERO)}%)", _fmt(ci.tax, 2)])
        story_note = ""
    rows.append(["", "", "Total", _fmt(ci.total, 2)])
    if ci.paid:
        rows.append(["", "", "Paid", _fmt(ci.paid, 2)])
        rows.append(["", "", "Balance due", _fmt((ci.total or ZERO) - (ci.paid or ZERO), 2)])
    t = Table(rows, colWidths=[4.2 * inch, 0.7 * inch, 1.0 * inch, 1.0 * inch], repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#dde2ea")),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONT", (2, -1), (-1, -1), "Helvetica-Bold", 9),
            ]
        )
    )
    story.append(t)
    if story_note:
        story += [Spacer(1, 10), Paragraph(f"<b>{e(story_note)}</b>", body)]
    if ci.payment_link_url:
        story += [Spacer(1, 10), Paragraph(f"Pay online: {e(ci.payment_link_url)}", body)]
    if ci.notes:
        story += [Spacer(1, 14), Paragraph(e(ci.notes).replace("\n", "<br/>"), small)]
    doc.build(story)
    return buf.getvalue()


def _fmt(d: Decimal | None, places: int | None = None) -> str:
    d = d or ZERO
    if places is not None:
        return f"{d:,.{places}f}"
    return format(d.normalize(), "f") if d != d.to_integral() else f"{int(d):,}"


def _pdf_file(org_id: uuid.UUID, ci: CustomerInvoice, user_id: uuid.UUID | None) -> FileObject:
    data = render_pdf(org_id, ci)
    f = save_file(org_id, f"{number_label(org_id, ci)}.pdf", data, user_id, content_type="application/pdf")
    attach(f, "customer_invoice", ci.id, "pdf")
    return f


def _recipient(cust: Any) -> str:
    from mpro.vendors.models import CustomerContact

    for x in (
        cust.billing_email,
        *(
            c.email
            for c in db.session.scalars(
                select(CustomerContact)
                .where(CustomerContact.customer_id == cust.id, CustomerContact.deleted_at.is_(None))
                .order_by(CustomerContact.is_billing.desc())
            )
        ),
        cust.email,
    ):
        if x and "@" in x:
            return str(x)
    return ""


def send(org_id: uuid.UUID, ci: CustomerInvoice, user: Any, to: str = "", message: str = "") -> CustomerInvoice:
    """Issue (numbered PDF, read-only) and email it to the customer."""
    from mpro.cloud.payments import payment_link
    from mpro.orgs.models import Organization
    from mpro.vendors.models import Customer

    if ci.status not in ("draft", "sent", "partially_paid", "overdue"):
        raise RuleError(f"A {ci.status} invoice can't be sent.", 409)
    if not lines(ci):
        raise RuleError("Add at least one line first.", 422)
    cust = db.session.get(Customer, ci.customer_id)
    to = (to or (_recipient(cust) if cust else "")).strip()
    if "@" not in to:
        raise RuleError("The customer has no email address. Add a billing email first.", 422)
    if ci.status == "draft" and ci.kind == "credit_note" and ci.credit_for_id:
        inv = db.session.get(CustomerInvoice, ci.credit_for_id)
        if inv is not None and (ci.total or ZERO) > credit_room(inv, exclude_id=ci.id):
            raise RuleError("The credit is larger than what's left to credit on the invoice.", 422)
    if ci.status == "draft":
        ci.issue_date = ci.issue_date or today()
        ci.due_date = ci.due_date or ci.issue_date + timedelta(
            days=int(_settings(org_id).get("invoice_due_days") or 30)
        )
        ci.status = "sent"
        org = db.session.get(Organization, org_id)
        if org is not None and ci.kind == "invoice":
            ci.payment_link_url = payment_link(org, ci) or ""
        _index(ci)
        vault.lock(org_id, "customer_invoice", ci.id)
        issue_credit(org_id, ci)
    f = _pdf_file(org_id, ci, user.id)
    ci.sent_at = utcnow()
    org = db.session.get(Organization, org_id)
    label = number_label(org_id, ci)
    body = (
        f"Hello {cust.name if cust else ''},\n\n"
        f"Please find {('credit note' if ci.kind == 'credit_note' else 'invoice')} "
        f"{label} for {ci.currency} {ci.total} attached"
        + (f", due {ci.due_date:%B %d, %Y}" if ci.due_date and ci.kind == "invoice" else "")
        + ".\n"
        + (f"\nPay online: {ci.payment_link_url}\n" if ci.payment_link_url else "")
        + (f"\n{message.strip()}\n" if message.strip() else "")
        + f"\nThank you,\n{org.name if org else ''}"
    )
    send_email(
        to,
        f"{'Credit note' if ci.kind == 'credit_note' else 'Invoice'} {label} from {org.name if org else ''}",
        body,
        org_id=org_id,
        attachments=[{"file_id": f.id, "name": f.name}],
    )
    _index(ci, file_id=f.id)
    emit(
        "customer_invoice.sent",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=label,
        summary=f"Sent to {to}",
        org_id=org_id,
    )
    return ci


def paid_total(ci: CustomerInvoice) -> Decimal:
    return (
        db.session.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.customer_invoice_id == ci.id)
        )
        or ZERO
    )


def record_payment(org_id: uuid.UUID, ci: CustomerInvoice, data: dict[str, Any], user: Any) -> Payment:
    if ci.status not in ("sent", "partially_paid", "overdue") or ci.kind != "invoice":
        raise RuleError("Payments can be recorded on sent invoices only.", 409)
    amount = money(data.get("amount"), "amount")
    assert amount is not None
    if amount <= ZERO:
        raise RuleError("Enter the amount received.", 422)
    p = Payment(
        org_id=org_id,
        direction="in",
        customer_invoice_id=ci.id,
        paid_on=parse_date(data.get("paid_on"), "payment date") or today(),
        amount=cents(amount),
        currency=ci.currency,
        method=str(data.get("method") or "")[:30],
        reference=str(data.get("reference") or "")[:120],
        recorded_by_id=user.id,
    )
    db.session.add(p)
    db.session.flush()
    _refresh_paid(ci)
    emit(
        "customer_invoice.payment",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=number_label(org_id, ci),
        summary=f"Payment received: {ci.currency} {p.amount}",
        org_id=org_id,
    )
    return p


def _credits(ci: CustomerInvoice) -> Decimal:
    return (
        db.session.scalar(
            select(func.coalesce(func.sum(CustomerInvoice.total), 0)).where(
                CustomerInvoice.credit_for_id == ci.id,
                CustomerInvoice.status != "void",
                CustomerInvoice.status != "draft",
            )
        )
        or ZERO
    )


def _refresh_paid(ci: CustomerInvoice) -> None:
    ci.paid = cents(paid_total(ci) + _credits(ci))
    if ci.paid >= (ci.total or ZERO):
        ci.status = "paid"
    elif ci.paid > ZERO:
        ci.status = "partially_paid"


def void(org_id: uuid.UUID, ci: CustomerInvoice) -> CustomerInvoice:
    if ci.status == "paid":
        raise RuleError("A paid invoice can't be voided; issue a credit note instead.", 409)
    if paid_total(ci) > ZERO:
        raise RuleError("Payments are recorded on this invoice; issue a credit note instead.", 409)
    ci.status = "void"
    emit(
        "customer_invoice.void",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=number_label(org_id, ci),
        summary="Voided",
        org_id=org_id,
    )
    return ci


def credit_note(org_id: uuid.UUID, ci: CustomerInvoice, user: Any, data: dict[str, Any]) -> CustomerInvoice:
    """A credit note against a sent invoice: all of it, or the lines given. It lowers the balance due."""
    if ci.kind != "invoice" or ci.status in ("draft", "void"):
        raise RuleError("Credit notes are issued against sent invoices.", 409)
    cn = CustomerInvoice(
        org_id=org_id,
        number=_next_number(org_id),
        customer_id=ci.customer_id,
        status="draft",
        kind="credit_note",
        credit_for_id=ci.id,
        currency=ci.currency,
        work_order_ids=list(ci.work_order_ids or []),
        tax_rate_pct=ci.tax_rate_pct,
        tax_certificate_id=ci.tax_certificate_id,
        notes=str(data.get("reason") or f"Credit for invoice {number_label(org_id, ci)}")[:4000],
        created_by_id=user.id,
    )
    db.session.add(cn)
    db.session.flush()
    rows = (
        _parse_lines(data["lines"])
        if data.get("lines")
        else [
            {
                "kind": ln.kind,
                "description": ln.description,
                "quantity": ln.quantity,
                "unit_price": ln.unit_price,
                "taxable": ln.taxable,
                "work_order_id": ln.work_order_id,
                "source_id": ln.source_id,
            }
            for ln in lines(ci)
        ]
    )
    for i, r in enumerate(rows):
        db.session.add(_line(org_id, cn.id, i, r))
    db.session.flush()
    recompute(cn)
    if cn.total > credit_room(ci, exclude_id=cn.id):
        raise RuleError("The credit is larger than what's left to credit on the invoice.", 422)
    _index(cn)
    emit(
        "customer_invoice.credit_note",
        entity_type="customer_invoice",
        entity_id=cn.id,
        entity_label=number_label(org_id, cn),
        summary=f"Credit note for {number_label(org_id, ci)}",
        org_id=org_id,
    )
    return cn


def credit_room(ci: CustomerInvoice, exclude_id: uuid.UUID | None = None) -> Decimal:
    """What can still be credited on an invoice: its total minus every credit note that isn't void, drafts included
    (review #5: two full drafts sent one after the other must not credit it twice)."""
    q = select(func.coalesce(func.sum(CustomerInvoice.total), 0)).where(
        CustomerInvoice.credit_for_id == ci.id,
        CustomerInvoice.kind == "credit_note",
        CustomerInvoice.status != "void",
        CustomerInvoice.deleted_at.is_(None),
    )
    if exclude_id is not None:
        q = q.where(CustomerInvoice.id != exclude_id)
    return (ci.total or ZERO) - (db.session.scalar(q) or ZERO)


def issue_credit(org_id: uuid.UUID, cn: CustomerInvoice) -> None:
    """When a credit note is sent, it counts against its invoice; it's checked again first."""
    if cn.kind == "credit_note" and cn.credit_for_id:
        db.session.execute(select(CustomerInvoice.id).where(CustomerInvoice.id == cn.credit_for_id).with_for_update())
        inv = db.session.get(CustomerInvoice, cn.credit_for_id)
        if inv is not None:
            if (cn.total or ZERO) > credit_room(inv, exclude_id=cn.id):
                raise RuleError("The credit is larger than what's left to credit on the invoice.", 422)
            _refresh_paid(inv)


def delete(org_id: uuid.UUID, ci: CustomerInvoice) -> None:
    if ci.status != "draft":
        raise RuleError("Only drafts can be deleted; void sent invoices instead.", 409)
    vault.assert_deletable(org_id, "customer_invoice", ci.id)
    ci.deleted_at = utcnow()
    emit(
        "customer_invoice.deleted",
        entity_type="customer_invoice",
        entity_id=ci.id,
        entity_label=number_label(org_id, ci),
        summary="Deleted draft",
        org_id=org_id,
    )


def _index(ci: CustomerInvoice, file_id: uuid.UUID | None = None) -> None:
    if file_id is None:
        link = db.session.scalars(
            select(FileLink)
            .where(FileLink.entity_type == "customer_invoice", FileLink.entity_id == ci.id, FileLink.role == "pdf")
            .order_by(FileLink.created_at.desc())
        ).first()
        file_id = link.file_id if link else None
    vault.index(
        ci.org_id,
        "customer_invoice",
        "customer_invoice",
        ci.id,
        title=number_label(ci.org_id, ci) + f" · {(customer_label(ci.customer_id) or {}).get('name', '')}",
        file_id=file_id,
        customer_id=ci.customer_id,
        doc_date=ci.issue_date,
        amount=ci.total,
        currency=ci.currency,
        search_text=ci.notes[:500],
    )


def mark_overdue_and_remind(on: date | None = None) -> int:
    """Daily: sent invoices past due become Overdue; reminders go out N days after the due date (settings)."""
    on = on or today()
    n = 0
    rows = db.session.scalars(
        select(CustomerInvoice).where(
            CustomerInvoice.deleted_at.is_(None),
            CustomerInvoice.kind == "invoice",
            CustomerInvoice.status.in_(("sent", "partially_paid", "overdue")),
            CustomerInvoice.due_date < on,
        )
    ).all()
    from mpro.vendors.models import Customer

    for ci in rows:
        if ci.status != "overdue":
            ci.status = "overdue"
            emit(
                "customer_invoice.overdue",
                entity_type="customer_invoice",
                entity_id=ci.id,
                entity_label=number_label(ci.org_id, ci),
                summary="Overdue",
                org_id=ci.org_id,
            )
        assert ci.due_date is not None
        late = (on - ci.due_date).days
        steps = [int(x) for x in _settings(ci.org_id).get("reminder_days_after_due") or []]
        due = [str(x) for x in steps if late >= x and str(x) not in (ci.reminders_sent or [])]
        if not due:
            continue
        cust = db.session.get(Customer, ci.customer_id)
        to = _recipient(cust) if cust else ""
        if to:
            balance = (ci.total or ZERO) - (ci.paid or ZERO)
            send_email(
                to,
                f"Reminder: invoice {number_label(ci.org_id, ci)} is {late} days overdue",
                f"Hello {cust.name if cust else ''},\n\nInvoice {number_label(ci.org_id, ci)} was due on "
                f"{ci.due_date:%B %d, %Y}. The balance due is {ci.currency} {balance}."
                + (f"\n\nPay online: {ci.payment_link_url}" if ci.payment_link_url else "")
                + "\n\nThank you.",
                org_id=ci.org_id,
            )
            n += 1
        ci.reminders_sent = sorted(set((ci.reminders_sent or []) + due))
    db.session.commit()
    return n


def invoice_dict(ci: CustomerInvoice, *, detail: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(ci.id),
        "number": ci.number,
        "label": number_label(ci.org_id, ci),
        "kind": ci.kind,
        "credit_for_id": str(ci.credit_for_id) if ci.credit_for_id else None,
        "customer": customer_label(ci.customer_id),
        "status": ci.status,
        "issue_date": ci.issue_date.isoformat() if ci.issue_date else None,
        "due_date": ci.due_date.isoformat() if ci.due_date else None,
        "currency": ci.currency,
        "subtotal": s(ci.subtotal),
        "tax": s(ci.tax),
        "tax_rate_pct": s(ci.tax_rate_pct),
        "tax_exempt": bool(ci.tax_certificate_id),
        "total": s(ci.total),
        "paid": s(ci.paid),
        "balance": s((ci.total or ZERO) - (ci.paid or ZERO)),
        "work_order_ids": list(ci.work_order_ids or []),
        "payment_link_url": ci.payment_link_url,
        "sent_at": iso(ci.sent_at),
        "created_at": iso(ci.created_at),
    }
    if detail:
        d["notes"] = ci.notes
        d["lines"] = [
            {
                "id": str(ln.id),
                "kind": ln.kind,
                "description": ln.description,
                "quantity": s(ln.quantity),
                "unit_price": s(ln.unit_price),
                "amount": s(ln.amount),
                "taxable": ln.taxable,
                "work_order_id": str(ln.work_order_id) if ln.work_order_id else None,
            }
            for ln in lines(ci)
        ]
        d["payments"] = [
            {
                "id": str(p.id),
                "paid_on": p.paid_on.isoformat(),
                "amount": s(p.amount),
                "method": p.method,
                "reference": p.reference,
                "recorded_by": user_label(p.recorded_by_id),
            }
            for p in db.session.scalars(
                select(Payment).where(Payment.customer_invoice_id == ci.id).order_by(Payment.paid_on)
            )
        ]
        d["files"] = [file_dict(ln.file, ln.role, ln.id) for ln in links_for("customer_invoice", ci.id)]
        d["credit_notes"] = [
            {"id": str(c.id), "label": number_label(ci.org_id, c), "total": s(c.total), "status": c.status}
            for c in db.session.scalars(
                select(CustomerInvoice).where(
                    CustomerInvoice.credit_for_id == ci.id, CustomerInvoice.deleted_at.is_(None)
                )
            )
        ]
    return d


def list_invoices(org_id: uuid.UUID, args: dict[str, Any]) -> dict[str, Any]:
    q = select(CustomerInvoice).where(CustomerInvoice.org_id == org_id, CustomerInvoice.deleted_at.is_(None))
    if args.get("status"):
        q = q.where(CustomerInvoice.status.in_(str(args["status"]).split(",")))
    if args.get("customer_id"):
        try:
            q = q.where(CustomerInvoice.customer_id == uuid.UUID(str(args["customer_id"])))
        except ValueError:
            return {"items": [], "total": 0, "page": 1, "per_page": 50}
    if args.get("kind") in ("invoice", "credit_note"):
        q = q.where(CustomerInvoice.kind == args["kind"])
    q = q.order_by(CustomerInvoice.number.desc())
    return paged(q, args, invoice_dict)


def statement(org_id: uuid.UUID, cust: Any) -> dict[str, Any]:
    invs = db.session.scalars(
        select(CustomerInvoice).where(
            CustomerInvoice.org_id == org_id,
            CustomerInvoice.customer_id == cust.id,
            CustomerInvoice.deleted_at.is_(None),
            CustomerInvoice.status.notin_(("draft", "void")),
        )
    ).all()
    entries: list[dict[str, Any]] = []
    for ci in invs:
        sign = -1 if ci.kind == "credit_note" else 1
        entries.append(
            {
                "date": (ci.issue_date or ci.created_at.date()).isoformat(),
                "kind": ci.kind,
                "reference": number_label(org_id, ci),
                "amount": s(sign * (ci.total or ZERO)),
                "invoice_id": str(ci.id),
            }
        )
        for p in db.session.scalars(select(Payment).where(Payment.customer_invoice_id == ci.id)):
            entries.append(
                {
                    "date": p.paid_on.isoformat(),
                    "kind": "payment",
                    "reference": p.reference or p.method,
                    "amount": s(-p.amount),
                    "invoice_id": str(ci.id),
                }
            )
    entries.sort(key=lambda x: x["date"])
    bal = ZERO
    for e in entries:
        bal += Decimal(e["amount"])
        e["balance"] = s(bal)
    return {"customer": customer_label(cust.id), "entries": entries, "balance": s(bal), "as_of": today().isoformat()}


def ageing(org_id: uuid.UUID, on: date | None = None) -> list[dict[str, Any]]:
    """Open balances per customer by days past due: current, 1–30, 31–60, 61–90, over 90."""
    on = on or today()
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for ci in db.session.scalars(
        select(CustomerInvoice).where(
            CustomerInvoice.org_id == org_id,
            CustomerInvoice.deleted_at.is_(None),
            CustomerInvoice.kind == "invoice",
            CustomerInvoice.status.in_(("sent", "partially_paid", "overdue")),
        )
    ):
        bal = (ci.total or ZERO) - (ci.paid or ZERO)
        if bal <= ZERO:
            continue
        row = out.setdefault(
            ci.customer_id,
            {
                "customer": customer_label(ci.customer_id),
                "current": ZERO,
                "d1_30": ZERO,
                "d31_60": ZERO,
                "d61_90": ZERO,
                "d90_plus": ZERO,
                "total": ZERO,
            },
        )
        late = (on - ci.due_date).days if ci.due_date else 0
        key = (
            "current"
            if late <= 0
            else "d1_30"
            if late <= 30
            else "d31_60"
            if late <= 60
            else "d61_90"
            if late <= 90
            else "d90_plus"
        )
        row[key] += bal
        row["total"] += bal
    rows = sorted(out.values(), key=lambda r: r["total"], reverse=True)
    for r in rows:
        for k in ("current", "d1_30", "d31_60", "d61_90", "d90_plus", "total"):
            r[k] = s(cents(r[k]))
    return rows
