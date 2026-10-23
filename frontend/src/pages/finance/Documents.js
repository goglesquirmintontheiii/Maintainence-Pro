import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Documents vault (MP-094): every finance document in one searchable index — receipts, vendor and customer invoices,
// certificates. Kept for the retention period (7 years by default); approved documents are read-only; a legal hold
// stops deletion. The accountant export is a monthly ZIP (PDFs + CSV) or CSV for QuickBooks Online, Xero, NetSuite, Sage.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Lock, Search, ShieldAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { day, money } from "./types";
const KINDS = [["", "All"], ["receipt", "Receipts"], ["vendor_invoice", "Vendor invoices"], ["customer_invoice", "Customer invoices"],
    ["certificate", "Certificates"]];
const LINK = { receipt: "receipts", vendor_invoice: "vendor-invoices", customer_invoice: "customer-invoices", tax_certificate: "certificates" };
export function DocumentsTab({ me }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [kind, setKind] = useState("");
    const [q, setQ] = useState("");
    const [hold, setHold] = useState(false);
    const [exporting, setExporting] = useState(false);
    const params = new URLSearchParams({ per_page: "100" });
    if (kind)
        params.set("kind", kind);
    if (q.trim())
        params.set("q", q.trim());
    if (hold)
        params.set("hold", "1");
    const list = useQuery({ queryKey: ["finance", "documents", params.toString()], queryFn: () => api(`/finance/documents?${params}`) });
    const setHoldM = useMutation({ mutationFn: ({ id, on }) => api(`/finance/documents/${id}/hold`, { method: "POST", body: { hold: on } }),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ["finance", "documents"] }), onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsxs("div", { className: "fin-wide stack", children: [_jsxs("div", { className: "row wrap", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Documents" }), me.can["finance.export"] && _jsxs(Button, { variant: "primary", onClick: () => setExporting(true), children: [_jsx(Download, { size: 16 }), "Accountant export"] })] }), _jsxs("div", { className: "row wrap", children: [_jsx("div", { className: "seg fin-seg", role: "tablist", "aria-label": "Kind", children: KINDS.map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": kind === k, className: "seg-btn" + (kind === k ? " on" : ""), onClick: () => setKind(k), children: l }, k)) }), _jsxs("button", { type: "button", className: "fin-chip" + (hold ? " on" : ""), onClick: () => setHold(!hold), children: [_jsx(ShieldAlert, { size: 13 }), "On legal hold"] })] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search vendor, number, text\u2026", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search documents" })] }), _jsx("section", { className: "card", children: list.isLoading ? _jsx(ListSkeleton, {}) : !list.data?.items.length ? _jsx(EmptyState, { icon: _jsx(FileText, { size: 28 }), title: "Nothing found" }) : (_jsx("div", { className: "fin-docs", children: list.data.items.map((d) => (_jsxs("div", { className: "list-row fin-doc", children: [_jsx(FileText, { size: 18, className: "faint" }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "t", children: d.record_id && LINK[d.record_type] ? _jsx(Link, { to: `/finance/${LINK[d.record_type]}/${d.record_id}`, children: d.title }) : d.title }), _jsxs("div", { className: "s", children: [day(d.doc_date || d.created_at), d.amount ? ` · ${money(d.amount, d.currency)}` : "", d.retain_until ? ` · keep until ${day(d.retain_until)}` : ""] }), _jsxs("div", { className: "row wrap fin-pills", children: [d.locked && _jsxs(Pill, { children: [_jsx(Lock, { size: 11 }), " Read-only"] }), d.legal_hold && _jsx(Pill, { tone: "danger", children: "Legal hold" })] })] }), d.file && d.kind !== "certificate" && _jsx("a", { className: "btn sm ghost", href: d.file.url, target: "_blank", rel: "noreferrer", children: "Open" }), me.can["finance.export"] && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setHoldM.mutate({ id: d.id, on: !d.legal_hold }), children: d.legal_hold ? "Release hold" : "Legal hold" })] }, d.id))) })) }), exporting && _jsx(ExportModal, { onClose: () => setExporting(false) })] }));
}
function ExportModal({ onClose }) {
    const nav = useNavigate();
    const { toast } = useToast();
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const [month, setMonth] = useState(`${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`);
    const [format, setFormat] = useState("zip");
    const go = useMutation({ mutationFn: () => api("/finance/exports", { method: "POST", body: { kind: "accounting", month, format } }),
        onSuccess: () => { onClose(); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsx(Modal, { title: "Accountant export", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => go.mutate(), children: "Export" })] }), children: _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "fin-form-grid", children: [_jsx(Field, { label: "Month", children: (fid) => _jsx(Input, { id: fid, type: "month", value: month, onChange: (e) => setMonth(e.target.value) }) }), _jsx(Field, { label: "Format", children: (fid) => _jsxs(Select, { id: fid, value: format, onChange: (e) => setFormat(e.target.value), children: [_jsx("option", { value: "zip", children: "ZIP: PDFs and CSV" }), _jsx("option", { value: "qbo", children: "QuickBooks Online (CSV)" }), _jsx("option", { value: "xero", children: "Xero (CSV)" }), _jsx("option", { value: "netsuite", children: "NetSuite (CSV)" }), _jsx("option", { value: "sage", children: "Sage (CSV)" })] }) })] }), _jsx("p", { className: "faint fin-small", children: "Approved and paid vendor bills, sent customer invoices, receipts and payments for the month." })] }) }));
}
