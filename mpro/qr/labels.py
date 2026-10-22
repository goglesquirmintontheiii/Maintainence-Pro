"""Printable labels: Avery sheets (PDF), single thermal labels (PDF) and Zebra ZPL (MP-096).

Sheet geometry comes from the Avery templates (inches): page, label size, margins and pitch.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

from mpro.orgs.services import RuleError


@dataclass(frozen=True)
class SheetTemplate:
    name: str
    label_w: float
    label_h: float
    cols: int
    rows: int
    left: float
    top: float
    h_pitch: float
    v_pitch: float
    page_w: float = 8.5
    page_h: float = 11.0

    @property
    def per_sheet(self) -> int:
        return self.cols * self.rows


@dataclass(frozen=True)
class ThermalTemplate:
    name: str
    w: float  # inches
    h: float
    dpi: int = 203


SHEETS: dict[str, SheetTemplate] = {
    # 2" x 2" square, 12 per sheet (Avery 94107 / 22806)
    "avery_94107": SheetTemplate("Avery 94107 · 2″ × 2″ · 12 per sheet", 2.0, 2.0, 3, 4, 0.625, 0.625, 2.625, 2.625),
    # 1" x 2-5/8" address, 30 per sheet (Avery 5160 / 94200)
    "avery_5160": SheetTemplate(
        "Avery 5160 / 94200 · 1″ × 2⅝″ · 30 per sheet", 2.625, 1.0, 3, 10, 0.1875, 0.5, 2.75, 1.0
    ),
    # 1" x 4", 20 per sheet (Avery 94202 / 5161)
    "avery_94202": SheetTemplate(
        "Avery 94202 / 5161 · 1″ × 4″ · 20 per sheet", 4.0, 1.0, 2, 10, 0.15625, 0.5, 4.1875, 1.0
    ),
    # 2" x 4" shipping, 10 per sheet (Avery 5163)
    "avery_5163": SheetTemplate("Avery 5163 · 2″ × 4″ · 10 per sheet", 4.0, 2.0, 2, 5, 0.15625, 0.5, 4.1875, 2.0),
}
THERMAL: dict[str, ThermalTemplate] = {
    "zebra_2x1": ThermalTemplate("Zebra · 2″ × 1″", 2.0, 1.0),
    "zebra_4x6": ThermalTemplate("Zebra · 4″ × 6″", 4.0, 6.0),
    "zebra_2x2": ThermalTemplate("Zebra · 2″ × 2″", 2.0, 2.0),
    "brother_62x29": ThermalTemplate("Brother DK-11209 · 62 × 29 mm", 62 / 25.4, 29 / 25.4, 300),
}


def templates() -> dict[str, Any]:
    return {
        "sheets": [
            {
                "id": k,
                "name": t.name,
                "per_sheet": t.per_sheet,
                "cols": t.cols,
                "rows": t.rows,
                "w": t.label_w,
                "h": t.label_h,
            }
            for k, t in SHEETS.items()
        ],
        "thermal": [
            {"id": k, "name": t.name, "w": t.w, "h": t.h, "zpl": k.startswith("zebra")} for k, t in THERMAL.items()
        ],
    }


@dataclass
class LabelItem:
    url: str  # what the QR code holds
    title: str
    subtitle: str = ""
    code: str = ""  # human-readable code under the QR
    barcode: str = ""  # optional Code 128 value


def _draw(c: Any, item: LabelItem, x: float, y: float, w: float, h: float, opts: dict[str, Any]) -> None:
    """Draw one label with its bottom-left corner at (x, y), in points."""
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode import code128
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib.units import inch
    from reportlab.pdfbase.pdfmetrics import stringWidth

    pad = min(w, h) * 0.07
    qr_side = min(h - 2 * pad, w * (0.95 if h >= w * 0.9 else 0.42))
    show_text = opts.get("show_name", True) or opts.get("show_code", True)
    stacked = h >= w * 0.9  # square/tall labels: QR on top, text underneath
    if stacked and show_text:
        qr_side = min(w - 2 * pad, h * 0.66)
    widget = QrCodeWidget(item.url, barLevel="M", barBorder=0)
    bx0, by0, bx1, by1 = widget.getBounds()
    scale = qr_side / max(bx1 - bx0, by1 - by0)
    d = Drawing(qr_side, qr_side, transform=[scale, 0, 0, scale, 0, 0])
    d.add(widget)
    if stacked:
        qx, qy = x + (w - qr_side) / 2, y + h - pad - qr_side
        tx, ty, tw = x + pad, qy - 4, w - 2 * pad
    else:
        qx, qy = x + pad, y + (h - qr_side) / 2
        tx, ty, tw = qx + qr_side + pad, y + h - pad, w - qr_side - 3 * pad
    renderPDF.draw(d, c, qx, qy)

    def fit(text: str, font: str, size: float) -> tuple[str, float]:
        while size > 5 and stringWidth(text, font, size) > tw:
            size -= 0.5
        while text and stringWidth(text, font, size) > tw:
            text = text[:-2] + "…"
        return text, size

    lines: list[tuple[str, float, str]] = []
    base = max(6.0, min(14.0, h / inch * 9))
    for on, text, font, size in (
        (opts.get("show_name", True), item.title, "Helvetica-Bold", base),
        (opts.get("show_subtitle", True), item.subtitle, "Helvetica", base * 0.8),
        (opts.get("show_code", True), item.code, "Courier-Bold", base * 0.85),
    ):
        if on and text:
            fitted, fsize = fit(text, font, size)
            lines.append((fitted, fsize, font))
    cy = ty
    for text, size, font in lines:
        cy -= size * 1.1
        if cy < y + pad * 0.5:
            break
        c.setFont(font, size)
        if stacked:
            c.drawCentredString(x + w / 2, cy, text)
        else:
            c.drawString(tx, cy, text)
    if opts.get("barcode") and item.barcode and not stacked and cy - 0.3 * inch > y + pad:
        bc = code128.Code128(item.barcode, barHeight=min(0.28 * inch, cy - y - 2 * pad), barWidth=0.6, quiet=False)
        if bc.width <= tw:
            bc.drawOn(c, tx, y + pad)


def _opts(opts: dict[str, Any]) -> dict[str, Any]:
    return {
        "show_name": bool(opts.get("show_name", True)),
        "show_subtitle": bool(opts.get("show_subtitle", True)),
        "show_code": bool(opts.get("show_code", True)),
        "barcode": bool(opts.get("barcode", False)),
        "outline": bool(opts.get("outline", False)),
    }


def sheet_pdf(
    items: list[LabelItem], template: str, start: int = 1, copies: int = 1, options: dict[str, Any] | None = None
) -> bytes:
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas

    t = SHEETS.get(template)
    if t is None:
        raise RuleError("Pick a label sheet.", 422)
    if not 1 <= start <= t.per_sheet:
        raise RuleError(f"Start at a label between 1 and {t.per_sheet}.", 422)
    if not 1 <= copies <= 20:
        raise RuleError("Print 1 to 20 copies of each label.", 422)
    opts = _opts(options or {})
    labels = [i for i in items for _ in range(copies)]
    if not labels:
        raise RuleError("There's nothing to print.", 422)
    if len(labels) > 5000:
        raise RuleError("Print up to 5,000 labels at a time.", 422)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(t.page_w * inch, t.page_h * inch))
    c.setTitle("MPro labels")
    pos = start - 1
    for item in labels:
        if pos == t.per_sheet:
            c.showPage()
            pos = 0
        col, row = pos % t.cols, pos // t.cols
        x = (t.left + col * t.h_pitch) * inch
        y = (t.page_h - t.top - row * t.v_pitch - t.label_h) * inch
        if opts["outline"]:
            c.setStrokeGray(0.8)
            c.setLineWidth(0.25)
            c.roundRect(x, y, t.label_w * inch, t.label_h * inch, 4)
        _draw(c, item, x, y, t.label_w * inch, t.label_h * inch, opts)
        pos += 1
    c.save()
    return buf.getvalue()


def thermal_pdf(items: list[LabelItem], template: str, copies: int = 1, options: dict[str, Any] | None = None) -> bytes:
    """One label per page, page size = label size, for Brother/Dymo/Zebra drivers."""
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas

    t = THERMAL.get(template)
    if t is None:
        raise RuleError("Pick a label size.", 422)
    if not 1 <= copies <= 20:
        raise RuleError("Print 1 to 20 copies of each label.", 422)
    labels = [i for i in items for _ in range(copies)]
    if not labels or len(labels) > 5000:
        raise RuleError("Print between 1 and 5,000 labels.", 422)
    opts = _opts(options or {})
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(t.w * inch, t.h * inch))
    for n, item in enumerate(labels):
        if n:
            c.showPage()
        _draw(c, item, 0, 0, t.w * inch, t.h * inch, opts)
    c.save()
    return buf.getvalue()


def _zpl_text(s: str) -> str:
    # ^FH lets us escape the control characters ^ and ~ as hex
    return "".join(f"_{ord(ch):02X}" if ch in "^~_" or ord(ch) < 32 else ch for ch in s)


def zpl(items: list[LabelItem], template: str, copies: int = 1, options: dict[str, Any] | None = None) -> str:
    """ZPL II for Zebra printers. Text uses font 0 (scalable); UTF-8 via ^CI28."""
    t = THERMAL.get(template)
    if t is None or not template.startswith("zebra"):
        raise RuleError("ZPL is for Zebra label sizes.", 422)
    if not 1 <= copies <= 20 or not items or len(items) > 5000:
        raise RuleError("Print between 1 and 5,000 labels, up to 20 copies each.", 422)
    opts = _opts(options or {})
    W, H = round(t.w * t.dpi), round(t.h * t.dpi)
    pad = round(min(W, H) * 0.06)
    stacked = H >= W * 0.9
    out = []
    for item in items:
        # QR magnification: modules ≈ 33 for a typical URL (version 4, M), so pick the largest that fits
        side = (W - 2 * pad) if stacked else (H - 2 * pad)
        if stacked:
            side = min(side, round(H * 0.62))
        mag = max(1, min(10, side // 37))
        qr_px = mag * 33
        if stacked:
            qx, qy = (W - qr_px) // 2, pad
            tx, ty, tw = pad, qy + qr_px + pad // 2, W - 2 * pad
        else:
            qx, qy = pad, (H - qr_px) // 2
            tx, ty, tw = qx + qr_px + pad, pad, W - qr_px - 3 * pad
        fs = max(18, min(48, H // 6 if not stacked else H // 14))
        z = ["^XA", "^CI28", f"^PW{W}", f"^LL{H}", "^LH0,0"]
        # ^BQ adds ~10 dots of quiet zone at the top; offset y by the field origin
        z.append(f"^FO{qx},{max(0, qy - 10)}^BQN,2,{mag}^FH^FDMA,{_zpl_text(item.url)}^FS")
        lines = []
        if opts["show_name"] and item.title:
            lines.append((item.title, fs))
        if opts["show_subtitle"] and item.subtitle:
            lines.append((item.subtitle, round(fs * 0.8)))
        if opts["show_code"] and item.code:
            lines.append((item.code, round(fs * 0.85)))
        y = ty
        just = "C" if stacked else "L"
        for text, size in lines:
            if y + size > H - pad // 2:
                break
            z.append(f"^FO{tx},{y}^A0N,{size},{size}^FB{tw},1,0,{just}^FH^FD{_zpl_text(text[:120])}^FS")
            y += round(size * 1.15)
        z.append(f"^PQ{copies}")
        z.append("^XZ")
        out.append("\n".join(z))
    return "\n".join(out) + "\n"
