import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
// Print QR labels: Avery sheets (PDF), single thermal labels (PDF) or Zebra ZPL (MP-096).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer, QrCode } from "lucide-react";
import "../styles/scan.css";
import { api } from "../lib/api";
import { postForFile } from "../lib/assets";
import { Button, Field, Input, Modal, Select, Toggle } from "./ui";
const NOUN = { asset: "asset", location: "location", meter: "meter", part: "part" };
function loadPrefs() {
    try {
        const v = localStorage.getItem("mpro.labels");
        return v ? JSON.parse(v) : null;
    }
    catch {
        return null;
    }
}
export function LabelDialog({ entityType, ids, query, codeIds, onClose }) {
    const t = useQuery({ queryKey: ["label-templates"], queryFn: () => api("/labels/templates"), staleTime: Infinity });
    const prefs = useMemo(loadPrefs, []);
    const [fmt, setFmt] = useState(prefs?.fmt ?? "sheet");
    const [sheet, setSheet] = useState(prefs?.sheet ?? "avery_5160");
    const [thermal, setThermal] = useState(prefs?.thermal ?? "zebra_2x1");
    const [start, setStart] = useState(1);
    const [copies, setCopies] = useState(1);
    const [opt, setOpt] = useState({ show_name: !codeIds, show_subtitle: !codeIds, show_code: true, barcode: false, outline: false });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const zebras = (t.data?.thermal ?? []).filter((x) => x.zpl);
    useEffect(() => { if (fmt === "zpl" && zebras.length && !zebras.some((z) => z.id === thermal))
        setThermal(zebras[0].id); }, [fmt, zebras, thermal]);
    const sheetT = t.data?.sheets.find((s) => s.id === sheet);
    const thermT = t.data?.thermal.find((s) => s.id === thermal);
    const size = fmt === "sheet" ? sheetT : thermT;
    const count = codeIds?.length ?? ids?.length;
    const what = codeIds ? `${codeIds.length} blank code${codeIds.length === 1 ? "" : "s"}` : count !== undefined
        ? `${count} ${NOUN[entityType]}${count === 1 ? "" : "s"}` : `every ${NOUN[entityType]} matching your filters`;
    const print = async () => {
        setBusy(true);
        setErr("");
        try {
            localStorage.setItem("mpro.labels", JSON.stringify({ fmt, sheet, thermal }));
        }
        catch { /* private mode */ }
        const body = { format: fmt, template: fmt === "sheet" ? sheet : thermal, start: fmt === "sheet" ? start : 1, copies, options: opt };
        if (codeIds)
            body.code_ids = codeIds;
        else {
            body.entity_type = entityType;
            if (ids)
                body.ids = ids;
            else
                body.query = query ?? {};
        }
        try {
            await postForFile("/labels", body, fmt === "zpl" ? "labels.zpl" : "labels.pdf");
            onClose();
        }
        catch (e) {
            setErr(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    const cols = sheetT ? sheetT.cols ?? Math.max(1, Math.floor(8 / sheetT.w)) : 3;
    const set = (k) => (v) => setOpt((o) => ({ ...o, [k]: v }));
    return (_jsx(Modal, { title: "Print labels", onClose: onClose, width: 640, footer: _jsxs(_Fragment, { children: [_jsx("span", { className: "grow small", role: "alert", style: { color: "var(--c-danger)" }, children: err }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", onClick: () => void print(), disabled: busy || !t.data, children: [_jsx(Printer, { size: 15 }), busy ? "Preparing…" : fmt === "zpl" ? "Download ZPL" : "Print"] })] }), children: _jsxs("div", { className: "stack", children: [_jsxs("p", { className: "muted", style: { margin: 0 }, children: ["Labels for ", what, ".", !codeIds && " Records without a QR code get one."] }), _jsx("div", { className: "seg", role: "radiogroup", "aria-label": "Printer", children: [["sheet", "Label sheets (Avery)"], ["thermal", "Label printer (PDF)"], ["zpl", "Zebra (ZPL)"]].map(([k, l]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": fmt === k, className: "seg-btn" + (fmt === k ? " on" : ""), onClick: () => setFmt(k), children: l }, k))) }), _jsxs("div", { className: "lbl-grid", children: [_jsxs("div", { className: "stack", children: [fmt === "sheet" ? (_jsx(Field, { label: "Sheet", children: (id) => _jsx(Select, { id: id, value: sheet, onChange: (e) => { setSheet(e.target.value); setStart(1); }, children: (t.data?.sheets ?? []).map((s) => _jsx("option", { value: s.id, children: s.name }, s.id)) }) })) : (_jsx(Field, { label: "Label size", hint: fmt === "zpl" ? "Send the file to the printer, e.g. with the Zebra Setup Utilities or `lp -o raw`." : "One label per page. Pick the same size in the printer driver.", children: (id) => (_jsx(Select, { id: id, value: thermal, onChange: (e) => setThermal(e.target.value), children: (fmt === "zpl" ? zebras : t.data?.thermal ?? []).map((s) => _jsx("option", { value: s.id, children: s.name }, s.id)) })) })), _jsx(Field, { label: "Copies of each", children: (id) => _jsx(Input, { id: id, type: "number", min: 1, max: 20, value: copies, onChange: (e) => setCopies(Math.max(1, Math.min(20, Number(e.target.value) || 1))), style: { width: 90 } }) }), _jsxs("div", { className: "stack", style: { gap: 10 }, children: [_jsx(Toggle, { checked: opt.show_name, onChange: set("show_name"), label: "Name" }), _jsx(Toggle, { checked: opt.show_subtitle, onChange: set("show_subtitle"), label: "Location / serial" }), _jsx(Toggle, { checked: opt.show_code, onChange: set("show_code"), label: "Code under the QR" }), fmt !== "zpl" && _jsx(Toggle, { checked: opt.barcode, onChange: set("barcode"), label: "Code 128 barcode", hint: "On wide labels, for handheld scanners" }), fmt === "sheet" && _jsx(Toggle, { checked: opt.outline, onChange: set("outline"), label: "Outline (test print on plain paper)" })] })] }), _jsxs("div", { className: "stack", children: [_jsx("span", { className: "small muted", children: "Preview" }), size && _jsx(LabelPreview, { w: size.w, h: size.h, opt: opt, sample: codeIds ? "" : entityType === "asset" ? "Air Compressor 2" : entityType === "meter" ? "Run hours" : "Compressor Room" }), fmt === "sheet" && sheetT && _jsxs(_Fragment, { children: [_jsxs("span", { className: "small muted", id: "lbl-start", children: ["Start at label ", start, " ", _jsx("span", { className: "faint", children: "(skip used labels on a part-used sheet)" })] }), _jsx("div", { className: "lbl-sheet", role: "radiogroup", "aria-labelledby": "lbl-start", style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${Math.ceil(sheetT.per_sheet / cols)}, 1fr)`, aspectRatio: "8.5 / 11" }, children: Array.from({ length: sheetT.per_sheet }, (_, i) => (_jsx("button", { type: "button", role: "radio", "aria-checked": start === i + 1, "aria-label": `Start at label ${i + 1}`, className: "lbl-cell" + (i + 1 < start ? " used" : "") + (start === i + 1 ? " on" : ""), onClick: () => setStart(i + 1) }, i))) })] })] })] })] }) }));
}
function LabelPreview({ w, h, opt, sample }) {
    const stacked = h >= w * 0.9;
    const scale = Math.min(220 / w, 160 / h);
    return (_jsxs("div", { className: "lbl-prev" + (stacked ? " stacked" : ""), style: { width: w * scale, height: h * scale }, "aria-hidden": "true", children: [_jsx("span", { className: "lbl-qr", children: _jsx(QrCode, { size: Math.min(w, h) * scale * 0.55 }) }), _jsxs("span", { className: "lbl-text", children: [opt.show_name && sample && _jsx("b", { children: sample }), opt.show_subtitle && sample && _jsx("span", { children: "Compressor Room \u00B7 S/N AIF-071144" }), opt.show_code && _jsx("span", { className: "mono", children: "7KQ2M9XH4P" }), opt.barcode && !stacked && _jsx("span", { className: "lbl-bars" })] })] }));
}
