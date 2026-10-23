import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Vendor invoices (MP-092): upload or email in, read, 3-way match against the purchase order and what was received,
// work the exceptions queue, approve (purchasing approval rules, applies_to vendor_invoice), pay.
// Statuses: Received → Matched → Approved → Paid, plus Disputed and Void.
import { useEffect, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Copy, FileUp, Mail, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { readPages } from "./capture";
import { day, money, postForm, todayISO, VI_STATUS } from "./types";
const FILTERS = [["exceptions", "Exceptions"], ["pending", "Waiting for approval"], ["unpaid", "To pay"], ["overdue", "Overdue"], ["paid", "Paid"],
    ["disputed", "Disputed"], ["", "All"]];
export const useVendors = () => useQuery({ queryKey: ["vendors", "lite"], staleTime: 30_000,
    queryFn: () => api("/vendors?per_page=500&sort=name") });
export function VendorInvoicesTab({ me, id }) {
    const [filter, setFilter] = useState(() => { try {
        return sessionStorage.getItem("finance.vi") ?? "exceptions";
    }
    catch {
        return "exceptions";
    } });
    const [q, setQ] = useState("");
    const [adding, setAdding] = useState(false);
    const nav = useNavigate();
    const { toast } = useToast();
    useEffect(() => { try {
        sessionStorage.setItem("finance.vi", filter);
    }
    catch { /* private mode */ } }, [filter]);
    const params = new URLSearchParams({ per_page: "100" });
    if (filter)
        params.set("status", filter);
    if (q.trim())
        params.set("q", q.trim());
    const list = useQuery({ queryKey: ["finance", "vendor-invoices", params.toString()], queryFn: () => api(`/finance/vendor-invoices?${params}`) });
    return (_jsxs("div", { className: "split fin-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Vendor invoices" }), me.can["finance.invoices"] && _jsxs(Button, { variant: "primary", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 16 }), "New"] })] }), me.invoices_address && _jsxs("button", { type: "button", className: "fin-email", onClick: () => { void navigator.clipboard?.writeText(me.invoices_address); toast("Address copied"); }, children: [_jsx(Mail, { size: 14 }), _jsx("span", { className: "grow", children: me.invoices_address }), _jsx(Copy, { size: 13 })] }), _jsx("div", { className: "seg fin-seg", role: "tablist", "aria-label": "Filter", children: FILTERS.map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": filter === k, className: "seg-btn" + (filter === k ? " on" : ""), onClick: () => setFilter(k), children: l }, k)) }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Invoice number", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search invoices" })] })] }), _jsx("div", { className: "list", "aria-label": "Vendor invoices", children: list.isLoading ? _jsx(ListSkeleton, {}) : !list.data?.items.length
                            ? _jsx(EmptyState, { title: filter === "exceptions" ? "No exceptions" : "No invoices here", children: filter === "exceptions" ? "Every invoice matches its purchase order." : "Upload a vendor invoice or email it in." })
                            : list.data.items.map((inv) => {
                                const [label, tone] = VI_STATUS[inv.status];
                                return (_jsxs(Link, { to: `/finance/vendor-invoices/${inv.id}`, className: "list-row" + (inv.id === id ? " active" : ""), children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [inv.vendor?.name ?? "Vendor?", " \u00B7 ", inv.number || "no number"] }), _jsxs("div", { className: "s", children: [inv.due_date ? `Due ${day(inv.due_date)}` : day(inv.invoice_date || inv.created_at), inv.purchase_orders.length ? ` · ${inv.purchase_orders.map((p) => p.number).join(", ")}` : ""] }), _jsxs("div", { className: "row wrap fin-pills", children: [_jsx(Pill, { tone: tone, children: label }), inv.overdue && _jsx(Pill, { tone: "danger", children: "Overdue" }), inv.exceptions.length > 0 && inv.status === "received" && _jsxs(Pill, { tone: "warning", children: [inv.exceptions.length, " exception", inv.exceptions.length > 1 ? "s" : ""] })] })] }), _jsx("div", { className: "fin-amt", children: money(inv.total, inv.currency) })] }, inv.id));
                            }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(InvoiceDetail, { id: id, me: me, onBack: () => nav("/finance/vendor-invoices") }) : _jsx(EmptyState, { title: "Pick an invoice", children: "The exceptions queue lists invoices that don't match their purchase order." }) }), adding && _jsx(NewInvoice, { onClose: () => setAdding(false), onSaved: (inv) => { setAdding(false); nav(`/finance/vendor-invoices/${inv.id}`); } })] }));
}
function NewInvoice({ onClose, onSaved }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState("");
    const vendors = useVendors();
    const [f, setF] = useState({ vendor_id: "", number: "", invoice_date: todayISO(), terms: "", tax: "", shipping: "" });
    const [poIds, setPoIds] = useState([]);
    const [lines, setLines] = useState([]);
    const pos = useQuery({ queryKey: ["finance", "pos-for", f.vendor_id], enabled: !!f.vendor_id,
        queryFn: () => api(`/purchase-orders?vendor_id=${f.vendor_id}&status=approved,partially_fulfilled,complete&per_page=50`) });
    const save = useMutation({
        mutationFn: async () => {
            const fields = { ...f, purchase_order_ids: poIds };
            if (!f.vendor_id)
                delete fields.vendor_id;
            if (lines.length)
                fields.lines = lines;
            for (const k of ["tax", "shipping", "terms", "number"])
                if (!f[k])
                    delete fields[k];
            if (!file)
                return api("/finance/vendor-invoices", { method: "POST", body: fields });
            let text = "";
            if (file.type.startsWith("image/")) {
                setBusy("Reading…");
                try {
                    text = await readPages([file]);
                }
                catch { /* type it in */ }
            }
            setBusy("Uploading…");
            return postForm("/finance/vendor-invoices", { file, ocr_text: text || undefined, fields: JSON.stringify(fields) });
        },
        onSuccess: (inv) => { void qc.invalidateQueries({ queryKey: ["finance"] }); toast(inv.exceptions.length ? "Saved — it has exceptions to check" : "Saved and matched"); onSaved(inv); },
        onError: (e) => { setBusy(""); toast(e.message, { kind: "error" }); },
    });
    const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
    return (_jsx(Modal, { title: "New vendor invoice", onClose: onClose, width: 640, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !!busy || (!file && !f.vendor_id), onClick: () => save.mutate(), children: busy || "Save" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(DropZone, { accept: "application/pdf,image/*", multiple: false, label: "Drop the invoice", onFiles: (fs) => setFile(fs[0]), children: _jsxs("label", { className: "fin-drop", children: [_jsx(FileUp, { size: 20 }), _jsx("span", { className: "grow", children: file ? file.name : "Upload the invoice (PDF or picture). We read the number, dates, PO and totals." }), _jsx("input", { type: "file", accept: "application/pdf,image/*", hidden: true, onChange: (e) => setFile(e.target.files?.[0] ?? null) })] }) }), _jsxs("div", { className: "fin-form-grid", children: [_jsx(Field, { label: "Vendor", children: (fid) => _jsxs(Select, { id: fid, value: f.vendor_id, onChange: (e) => { set("vendor_id")(e); setPoIds([]); }, children: [_jsx("option", { value: "", children: file ? "From the invoice" : "Pick a vendor" }), vendors.data?.items.map((v) => _jsx("option", { value: v.id, children: v.name }, v.id))] }) }), _jsx(Field, { label: "Invoice number", children: (fid) => _jsx(Input, { id: fid, value: f.number, onChange: set("number") }) }), _jsx(Field, { label: "Invoice date", children: (fid) => _jsx(Input, { id: fid, type: "date", value: f.invoice_date, onChange: set("invoice_date") }) }), _jsx(Field, { label: "Terms", hint: 'e.g. "Net 30" or "2/10 net 30"', children: (fid) => _jsx(Input, { id: fid, value: f.terms, onChange: set("terms") }) }), _jsx(Field, { label: "Tax", children: (fid) => _jsx(Input, { id: fid, inputMode: "decimal", value: f.tax, onChange: set("tax") }) }), _jsx(Field, { label: "Shipping", children: (fid) => _jsx(Input, { id: fid, inputMode: "decimal", value: f.shipping, onChange: set("shipping") }) })] }), !!pos.data?.items.length && _jsxs("div", { className: "stack fin-tight", children: [_jsx("span", { className: "fin-label", children: "Purchase orders" }), _jsx("div", { className: "fin-chips", children: pos.data.items.map((p) => _jsxs("button", { type: "button", className: "fin-chip" + (poIds.includes(p.id) ? " on" : ""), onClick: () => setPoIds((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]), children: [p.display_number, " \u00B7 ", p.title] }, p.id)) })] }), _jsx(LinesEditor, { lines: lines, onChange: setLines })] }) }));
}
function LinesEditor({ lines, onChange }) {
    const upd = (i, k, v) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
    return (_jsxs("div", { className: "stack fin-tight", children: [_jsx("span", { className: "fin-label", children: "Lines" }), lines.map((l, i) => (_jsxs("div", { className: "fin-line", children: [_jsx(Input, { placeholder: "Description", value: l.description, onChange: (e) => upd(i, "description", e.target.value), "aria-label": "Description" }), _jsx(Input, { placeholder: "Part #", value: l.part_number, onChange: (e) => upd(i, "part_number", e.target.value), "aria-label": "Part number" }), _jsx(Input, { placeholder: "Qty", inputMode: "decimal", value: l.quantity, onChange: (e) => upd(i, "quantity", e.target.value), "aria-label": "Quantity" }), _jsx(Input, { placeholder: "Unit price", inputMode: "decimal", value: l.unit_price, onChange: (e) => upd(i, "unit_price", e.target.value), "aria-label": "Unit price" }), _jsx(Button, { icon: true, "aria-label": "Remove line", onClick: () => onChange(lines.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 15 }) })] }, i))), _jsx("div", { children: _jsxs(Button, { size: "sm", onClick: () => onChange([...lines, { description: "", part_number: "", quantity: "1", unit_price: "" }]), children: [_jsx(Plus, { size: 14 }), "Add line"] }) })] }));
}
function InvoiceDetail({ id, me, onBack }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["finance", "vendor-invoice", id], queryFn: () => api(`/finance/vendor-invoices/${id}`) });
    const [override, setOverride] = useState(false);
    const [pay, setPay] = useState(false);
    const [dispute, setDispute] = useState(false);
    const [editLines, setEditLines] = useState(null);
    const done = (x, msg) => {
        qc.setQueryData(["finance", "vendor-invoice", id], x);
        void qc.invalidateQueries({ queryKey: ["finance", "vendor-invoices"] });
        void qc.invalidateQueries({ queryKey: ["finance", "summary"] });
        if (msg)
            toast(msg);
    };
    const err = (e) => toast(e.message, { kind: "error" });
    const act = useMutation({ mutationFn: ({ path, body }) => api(`/finance/vendor-invoices/${id}/${path}`, { method: "POST", body: body ?? {} }),
        onSuccess: (x) => done(x), onError: err });
    const patch = useMutation({ mutationFn: (body) => api(`/finance/vendor-invoices/${id}`, { method: "PATCH", body }),
        onSuccess: (x) => { setEditLines(null); done(x, "Saved"); }, onError: err });
    const del = useMutation({ mutationFn: () => api(`/finance/vendor-invoices/${id}`, { method: "DELETE" }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
    const inv = q.data;
    if (q.isLoading)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    if (!inv)
        return _jsx("div", { className: "detail", children: _jsx(EmptyState, { title: "Invoice not found" }) });
    const [label, tone] = VI_STATUS[inv.status];
    const writer = me.can["finance.invoices"];
    const approver = me.can["finance.invoices.approve"];
    const open = inv.status === "received" || inv.status === "matched";
    const pending = inv.status === "pending"; // locked while the approvers decide
    return (_jsxs("div", { className: "detail fin-detail", children: [_jsxs("div", { className: "detail-head", children: [_jsx(Button, { icon: true, className: "fin-back", "aria-label": "Back", onClick: onBack, children: _jsx(ArrowLeft, { size: 18 }) }), _jsxs("div", { className: "grow", children: [_jsxs("h2", { children: [inv.vendor?.name ?? "Vendor?", " \u00B7 ", inv.number || "no number"] }), _jsxs("div", { className: "muted fin-small", children: [inv.invoice_date ? `Invoiced ${day(inv.invoice_date)}` : "No invoice date", inv.due_date ? ` · due ${day(inv.due_date)}` : "", inv.terms ? ` · ${inv.terms}` : "", inv.discount_until ? ` · ${Number(inv.discount_pct)}% off if paid by ${day(inv.discount_until)}` : ""] })] }), _jsx(Pill, { tone: tone, children: label }), writer && !inv.locked && _jsx(Button, { icon: true, "aria-label": "Delete invoice", onClick: () => { if (confirm("Delete this invoice?"))
                            del.mutate(); }, children: _jsx(Trash2, { size: 16 }) })] }), inv.exceptions.length > 0 && open && (_jsxs("div", { className: "fin-banner warn stack fin-tight", children: [_jsxs("div", { className: "row", children: [_jsx(AlertTriangle, { size: 16 }), _jsxs("strong", { className: "grow", children: ["Doesn't match (", inv.exceptions.length, ")"] }), writer && _jsxs(Button, { size: "sm", onClick: () => act.mutate({ path: "match" }), children: [_jsx(RefreshCw, { size: 14 }), "Match again"] })] }), _jsx("ul", { className: "fin-exc", children: inv.exceptions.map((e, i) => _jsxs("li", { children: [_jsxs("strong", { children: [e.label, ":"] }), " ", e.message] }, i)) })] })), inv.source === "email" && inv.sender_verified === false && _jsxs("div", { className: "fin-banner warn", children: [_jsx(AlertTriangle, { size: 16 }), "Sender not verified: emailed from ", inv.email_from || "an unknown address", ", which its mail server didn't confirm. Check it really came from them."] }), inv.status === "disputed" && inv.dispute_note && _jsxs("div", { className: "fin-banner warn", children: [_jsx(AlertTriangle, { size: 16 }), "Disputed: ", inv.dispute_note] }), _jsxs("div", { className: "row wrap", children: [inv.purchase_orders.map((p) => _jsxs(Link, { className: "fin-chip", to: `/purchase-orders/${p.id}`, children: [p.number, p.tax_exempt ? " · tax-exempt" : ""] }, p.id)), inv.file && _jsxs("a", { className: "fin-chip", href: inv.file.url, target: "_blank", rel: "noreferrer", children: [_jsx(FileUp, { size: 13 }), inv.file.name] })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table fin-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Item" }), _jsx("th", { className: "num", children: "Qty" }), _jsx("th", { className: "num", children: "Price" }), _jsx("th", { className: "num", children: "Amount" }), _jsx("th", { children: "PO" })] }) }), _jsxs("tbody", { children: [(inv.lines ?? []).map((l) => (_jsxs("tr", { className: l.match_status && l.match_status !== "ok" ? "fin-bad" : "", children: [_jsxs("td", { children: [l.description, l.part_number ? _jsxs("span", { className: "faint", children: [" \u00B7 ", l.part_number] }) : null] }), _jsx("td", { className: "num", children: Number(l.quantity) }), _jsx("td", { className: "num", children: money(l.unit_price, inv.currency) }), _jsx("td", { className: "num", children: money(l.amount, inv.currency) }), _jsx("td", { className: "fin-small", children: l.po_line ? _jsxs(_Fragment, { children: [money(l.po_line.unit_cost, inv.currency), " \u00B7 received ", Number(l.po_line.received), " of ", Number(l.po_line.quantity)] }) : _jsx("span", { className: "faint", children: "\u2014" }) })] }, l.id))), !inv.lines?.length && _jsx("tr", { children: _jsx("td", { colSpan: 5, className: "muted", children: "No lines. Add them to match against the purchase order." }) })] })] }) }), _jsxs("div", { className: "po-totals", children: [_jsxs("div", { children: [_jsx("span", { children: "Subtotal" }), _jsx("span", { children: money(inv.subtotal, inv.currency) })] }), _jsxs("div", { children: [_jsx("span", { children: "Tax" }), _jsx("span", { children: money(inv.tax, inv.currency) })] }), Number(inv.shipping) > 0 && _jsxs("div", { children: [_jsx("span", { children: "Shipping" }), _jsx("span", { children: money(inv.shipping, inv.currency) })] }), _jsxs("div", { className: "tot", children: [_jsx("span", { children: "Total" }), _jsx("span", { children: money(inv.total, inv.currency) })] }), Number(inv.paid) > 0 && _jsxs("div", { children: [_jsx("span", { children: "Balance" }), _jsx("span", { children: money(inv.balance, inv.currency) })] })] })] }), writer && open && !inv.locked && (editLines
                ? _jsxs("section", { className: "card card-pad stack", children: [_jsx(LinesEditor, { lines: editLines, onChange: setEditLines }), _jsxs("div", { className: "row", children: [_jsx(Button, { onClick: () => setEditLines(null), children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => patch.mutate({ lines: editLines }), children: "Save lines" })] })] })
                : _jsx("div", { children: _jsx(Button, { size: "sm", onClick: () => setEditLines((inv.lines ?? []).map((l) => ({ description: l.description, part_number: l.part_number, quantity: String(Number(l.quantity)), unit_price: l.unit_price }))), children: "Edit lines" }) })), _jsxs("div", { className: "row wrap fin-actions", children: [open && writer && !pending && _jsxs(_Fragment, { children: [inv.exceptions.length > 0 && approver && _jsx(Checkbox, { checked: override, onChange: setOverride, label: "Approve despite the exceptions" }), _jsx(Button, { variant: "primary", disabled: inv.exceptions.length > 0 && !override, onClick: () => act.mutate({ path: "submit", body: { override } }), children: approver ? "Approve" : "Send for approval" })] }), pending && _jsxs(_Fragment, { children: [_jsx("span", { className: "muted grow", children: "Waiting for approval." }), _jsx(Button, { onClick: () => { const c = prompt("Why is it rejected?"); if (c !== null)
                                    act.mutate({ path: "decide", body: { approve: false, comment: c } }); }, children: "Reject" }), _jsx(Button, { variant: "primary", onClick: () => act.mutate({ path: "decide", body: { approve: true } }), children: "Approve" })] }), writer && inv.status === "approved" && _jsx(Button, { variant: "primary", onClick: () => setPay(true), children: "Record payment" }), writer && !["paid", "void", "disputed"].includes(inv.status) && _jsx(Button, { onClick: () => setDispute(true), children: "Dispute" }), writer && inv.status === "disputed" && _jsx(Button, { onClick: () => act.mutate({ path: "status", body: { action: "reopen" } }), children: "Reopen" }), writer && inv.status !== "paid" && inv.status !== "void" && _jsx(Button, { variant: "ghost", onClick: () => { if (confirm("Void this invoice?"))
                            act.mutate({ path: "status", body: { action: "void" } }); }, children: "Void" })] }), (inv.payments ?? []).length > 0 && _jsxs("section", { className: "card card-pad", children: [_jsx("h3", { className: "sec-h", children: "Payments" }), (inv.payments ?? []).map((p) => _jsxs("div", { className: "row fin-small", children: [_jsxs("span", { className: "grow", children: [day(p.paid_on), " \u00B7 ", p.method || "payment", p.reference ? ` · ${p.reference}` : ""] }), money(p.amount, inv.currency)] }, p.id))] }), pay && _jsx(PaymentModal, { currency: inv.currency, balance: inv.balance, onClose: () => setPay(false), onSave: (body) => act.mutate({ path: "payments", body }, { onSuccess: () => setPay(false) }) }), dispute && _jsx(Modal, { title: "Dispute invoice", onClose: () => setDispute(false), footer: null, children: _jsxs("form", { className: "stack", onSubmit: (e) => { e.preventDefault(); const note = String(new FormData(e.currentTarget).get("note") || ""); act.mutate({ path: "status", body: { action: "dispute", note } }, { onSuccess: () => setDispute(false) }); }, children: [_jsx(Field, { label: "What's wrong?", children: (fid) => _jsx("textarea", { id: fid, name: "note", className: "input", rows: 3, required: true }) }), _jsx("div", { className: "row", children: _jsx(Button, { type: "submit", variant: "primary", children: "Dispute" }) })] }) })] }));
}
export function PaymentModal({ currency, balance, onClose, onSave }) {
    const [f, setF] = useState({ amount: balance, paid_on: todayISO(), method: "ach", reference: "" });
    return (_jsx(Modal, { title: "Record payment", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => onSave(f), children: "Save" })] }), children: _jsxs("div", { className: "fin-form-grid", children: [_jsx(Field, { label: `Amount (${currency})`, children: (fid) => _jsx(Input, { id: fid, inputMode: "decimal", value: f.amount, onChange: (e) => setF({ ...f, amount: e.target.value }) }) }), _jsx(Field, { label: "Date", children: (fid) => _jsx(Input, { id: fid, type: "date", value: f.paid_on, onChange: (e) => setF({ ...f, paid_on: e.target.value }) }) }), _jsx(Field, { label: "Method", children: (fid) => _jsx(Select, { id: fid, value: f.method, onChange: (e) => setF({ ...f, method: e.target.value }), children: [["ach", "ACH / bank transfer"], ["check", "Check"], ["card", "Card"], ["wire", "Wire"], ["cash", "Cash"], ["other", "Other"]].map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), _jsx(Field, { label: "Reference", children: (fid) => _jsx(Input, { id: fid, value: f.reference, onChange: (e) => setF({ ...f, reference: e.target.value }) }) })] }) }));
}
