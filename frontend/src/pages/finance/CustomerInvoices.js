import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Customer invoices (MP-093): bill one or several completed work orders — labour at the customer's billing rate,
// parts with the markup, other costs — with tax by the customer's location (none when their exemption certificate
// is on file). Draft → Sent (numbered PDF, emailed, read-only) → Partially paid / Paid / Overdue; credit notes,
// statements. Online payment links are an MPro Cloud feature.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileText, Plus, Search, Send, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { PaymentModal } from "./VendorInvoices";
import { CI_STATUS, day, money } from "./types";
const FILTERS = [["", "All"], ["draft", "Drafts"], ["sent,partially_paid", "Open"], ["overdue", "Overdue"], ["paid", "Paid"]];
const useCustomers = () => useQuery({ queryKey: ["customers", "lite"], staleTime: 30_000,
    queryFn: () => api("/customers?per_page=500") });
export function CustomerInvoicesTab({ me, id }) {
    const [filter, setFilter] = useState("");
    const [q, setQ] = useState("");
    const [adding, setAdding] = useState(false);
    const nav = useNavigate();
    const params = new URLSearchParams({ per_page: "100" });
    if (filter)
        params.set("status", filter);
    const list = useQuery({ queryKey: ["finance", "customer-invoices", params.toString()], queryFn: () => api(`/finance/customer-invoices?${params}`) });
    const items = (list.data?.items ?? []).filter((i) => !q.trim() || `${i.label} ${i.customer?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
    return (_jsxs("div", { className: "split fin-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Customer invoices" }), me.can["finance.customer_invoices"] && _jsxs(Button, { variant: "primary", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 16 }), "New"] })] }), _jsx("div", { className: "seg fin-seg", role: "tablist", "aria-label": "Filter", children: FILTERS.map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": filter === k, className: "seg-btn" + (filter === k ? " on" : ""), onClick: () => setFilter(k), children: l }, k)) }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Number or customer", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search invoices" })] })] }), _jsx("div", { className: "list", "aria-label": "Customer invoices", children: list.isLoading ? _jsx(ListSkeleton, {}) : !items.length ? _jsx(EmptyState, { title: "No invoices", children: "Bill completed work orders to your customers." })
                            : items.map((ci) => {
                                const [label, tone] = CI_STATUS[ci.status];
                                return (_jsxs(Link, { to: `/finance/customer-invoices/${ci.id}`, className: "list-row" + (ci.id === id ? " active" : ""), children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [ci.label, " \u00B7 ", ci.customer?.name ?? ""] }), _jsxs("div", { className: "s", children: [ci.kind === "credit_note" ? "Credit note" : ci.due_date ? `Due ${day(ci.due_date)}` : "Not sent", Number(ci.balance) > 0 && ci.status !== "draft" ? ` · ${money(ci.balance, ci.currency)} due` : ""] }), _jsxs("div", { className: "row wrap fin-pills", children: [_jsx(Pill, { tone: tone, children: label }), ci.tax_exempt && _jsx(Pill, { children: "Tax-exempt" })] })] }), _jsx("div", { className: "fin-amt", children: money(ci.kind === "credit_note" ? `-${ci.total}` : ci.total, ci.currency) })] }, ci.id));
                            }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(InvoiceDetail, { id: id, me: me, onBack: () => nav("/finance/customer-invoices") }) : _jsx(EmptyState, { title: "Pick an invoice" }) }), adding && _jsx(NewInvoice, { onClose: () => setAdding(false), onSaved: (ci) => { setAdding(false); nav(`/finance/customer-invoices/${ci.id}`); } })] }));
}
function NewInvoice({ onClose, onSaved }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const customers = useCustomers();
    const [cust, setCust] = useState("");
    const [wos, setWos] = useState([]);
    const [inc, setInc] = useState({ labor: true, parts: true, costs: true });
    const billable = useQuery({ queryKey: ["finance", "billable", cust], enabled: !!cust,
        queryFn: () => api(`/finance/billable-work-orders?customer_id=${cust}`) });
    useEffect(() => { setWos(billable.data?.items.map((w) => w.id) ?? []); }, [billable.data]);
    const save = useMutation({ mutationFn: () => api("/finance/customer-invoices", { method: "POST", body: { customer_id: cust, work_order_ids: wos, include: inc } }),
        onSuccess: (ci) => { void qc.invalidateQueries({ queryKey: ["finance"] }); onSaved(ci); }, onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsx(Modal, { title: "New customer invoice", onClose: onClose, width: 560, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !cust || save.isPending, onClick: () => save.mutate(), children: "Create draft" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Field, { label: "Customer", children: (fid) => _jsxs(Select, { id: fid, value: cust, onChange: (e) => setCust(e.target.value), children: [_jsx("option", { value: "", children: "Pick a customer" }), customers.data?.items.map((c) => _jsx("option", { value: c.id, children: c.name }, c.id))] }) }), cust && _jsxs("div", { className: "stack fin-tight", children: [_jsx("span", { className: "fin-label", children: "Completed work orders not billed yet" }), billable.isLoading ? _jsx(ListSkeleton, { rows: 2 }) : billable.data?.items.length
                            ? billable.data.items.map((w) => _jsx(Checkbox, { checked: wos.includes(w.id), label: `#${w.number} ${w.title}`, onChange: (v) => setWos((x) => (v ? [...x, w.id] : x.filter((y) => y !== w.id))) }, w.id))
                            : _jsx("p", { className: "muted", children: "None. You can still create the invoice and add lines yourself." })] }), wos.length > 0 && _jsxs("div", { className: "row wrap", children: [_jsx(Checkbox, { checked: inc.labor, onChange: (v) => setInc({ ...inc, labor: v }), label: "Labour" }), _jsx(Checkbox, { checked: inc.parts, onChange: (v) => setInc({ ...inc, parts: v }), label: "Parts" }), _jsx(Checkbox, { checked: inc.costs, onChange: (v) => setInc({ ...inc, costs: v }), label: "Other costs" })] })] }) }));
}
function InvoiceDetail({ id, me, onBack }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const nav = useNavigate();
    const q = useQuery({ queryKey: ["finance", "customer-invoice", id], queryFn: () => api(`/finance/customer-invoices/${id}`) });
    const [lines, setLines] = useState(null);
    const [pay, setPay] = useState(false);
    const [send, setSend] = useState(false);
    const done = (x, msg) => {
        qc.setQueryData(["finance", "customer-invoice", x.id], x);
        void qc.invalidateQueries({ queryKey: ["finance", "customer-invoices"] });
        void qc.invalidateQueries({ queryKey: ["finance", "summary"] });
        if (msg)
            toast(msg);
    };
    const err = (e) => toast(e.message, { kind: "error" });
    const act = useMutation({ mutationFn: ({ path, body }) => api(`/finance/customer-invoices/${id}/${path}`, { method: "POST", body: body ?? {} }),
        onError: err });
    const patch = useMutation({ mutationFn: (body) => api(`/finance/customer-invoices/${id}`, { method: "PATCH", body }),
        onSuccess: (x) => { setLines(null); done(x, "Saved"); }, onError: err });
    const del = useMutation({ mutationFn: () => api(`/finance/customer-invoices/${id}`, { method: "DELETE" }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
    const ci = q.data;
    if (q.isLoading)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    if (!ci)
        return _jsx("div", { className: "detail", children: _jsx(EmptyState, { title: "Invoice not found" }) });
    const [label, tone] = CI_STATUS[ci.status];
    const writer = me.can["finance.customer_invoices"];
    const draft = ci.status === "draft";
    const upd = (i, k, v) => setLines((ls) => (ls ?? []).map((l, j) => (j === i ? { ...l, [k]: v } : l)));
    return (_jsxs("div", { className: "detail fin-detail", children: [_jsxs("div", { className: "detail-head", children: [_jsx(Button, { icon: true, className: "fin-back", "aria-label": "Back", onClick: onBack, children: _jsx(ArrowLeft, { size: 18 }) }), _jsxs("div", { className: "grow", children: [_jsxs("h2", { children: [ci.kind === "credit_note" ? "Credit note" : "Invoice", " ", ci.label] }), _jsxs("div", { className: "muted fin-small", children: [ci.customer?.name, ci.issue_date ? ` · issued ${day(ci.issue_date)}` : "", ci.due_date ? ` · due ${day(ci.due_date)}` : ""] })] }), _jsx(Pill, { tone: tone, children: label }), _jsx("a", { className: "btn icon", href: `/api/v1/finance/customer-invoices/${ci.id}/pdf`, target: "_blank", rel: "noreferrer", "aria-label": "PDF", title: "PDF", children: _jsx(FileText, { size: 16 }) }), writer && draft && _jsx(Button, { icon: true, "aria-label": "Delete draft", onClick: () => { if (confirm("Delete this draft?"))
                            del.mutate(); }, children: _jsx(Trash2, { size: 16 }) })] }), ci.tax_exempt && _jsx("div", { className: "fin-banner", children: "The customer's tax exemption certificate is on file: no tax is charged." }), ci.credit_for_id && _jsxs("div", { className: "fin-banner", children: ["Credit note for ", _jsx(Link, { to: `/finance/customer-invoices/${ci.credit_for_id}`, children: "this invoice" }), "."] }), _jsxs("section", { className: "card", children: [lines ? (_jsxs("div", { className: "card-body stack", children: [lines.map((l, i) => (_jsxs("div", { className: "fin-line ci", children: [_jsxs(Select, { value: l.kind, onChange: (e) => upd(i, "kind", e.target.value), "aria-label": "Kind", children: [_jsx("option", { value: "labor", children: "Labour" }), _jsx("option", { value: "part", children: "Part" }), _jsx("option", { value: "cost", children: "Cost" }), _jsx("option", { value: "other", children: "Other" })] }), _jsx(Input, { value: l.description, onChange: (e) => upd(i, "description", e.target.value), "aria-label": "Description" }), _jsx(Input, { inputMode: "decimal", value: l.quantity, onChange: (e) => upd(i, "quantity", e.target.value), "aria-label": "Quantity" }), _jsx(Input, { inputMode: "decimal", value: l.unit_price, onChange: (e) => upd(i, "unit_price", e.target.value), "aria-label": "Unit price" }), _jsx(Checkbox, { checked: l.taxable, onChange: (v) => upd(i, "taxable", v), label: "Tax" }), _jsx(Button, { icon: true, "aria-label": "Remove line", onClick: () => setLines((ls) => (ls ?? []).filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 15 }) })] }, i))), _jsxs("div", { className: "row", children: [_jsxs(Button, { size: "sm", onClick: () => setLines((ls) => [...(ls ?? []), { kind: "other", description: "", quantity: "1", unit_price: "0", taxable: true }]), children: [_jsx(Plus, { size: 14 }), "Add line"] }), _jsx("span", { className: "grow" }), _jsx(Button, { onClick: () => setLines(null), children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => patch.mutate({ lines: lines.map((l) => ({ ...l, work_order_id: l.work_order_id ?? undefined })) }), children: "Save" })] })] })) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table fin-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Description" }), _jsx("th", { className: "num", children: "Qty" }), _jsx("th", { className: "num", children: "Price" }), _jsx("th", { className: "num", children: "Amount" })] }) }), _jsxs("tbody", { children: [(ci.lines ?? []).map((l) => _jsxs("tr", { children: [_jsxs("td", { children: [l.description, !l.taxable && !ci.tax_exempt ? _jsx("span", { className: "faint", children: " \u00B7 no tax" }) : null] }), _jsx("td", { className: "num", children: Number(l.quantity) }), _jsx("td", { className: "num", children: money(l.unit_price, ci.currency) }), _jsx("td", { className: "num", children: money(l.amount ?? "0", ci.currency) })] }, l.id)), !ci.lines?.length && _jsx("tr", { children: _jsx("td", { colSpan: 4, className: "muted", children: "No lines yet." }) })] })] }) })), _jsxs("div", { className: "po-totals", children: [_jsxs("div", { children: [_jsx("span", { children: "Subtotal" }), _jsx("span", { children: money(ci.subtotal, ci.currency) })] }), _jsxs("div", { children: [_jsx("span", { children: ci.tax_exempt ? "Tax (exempt)" : `Tax (${Number(ci.tax_rate_pct ?? 0)}%)` }), _jsx("span", { children: money(ci.tax, ci.currency) })] }), _jsxs("div", { className: "tot", children: [_jsx("span", { children: "Total" }), _jsx("span", { children: money(ci.total, ci.currency) })] }), ci.status !== "draft" && ci.kind === "invoice" && _jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("span", { children: "Paid and credited" }), _jsx("span", { children: money(ci.paid, ci.currency) })] }), _jsxs("div", { className: "tot", children: [_jsx("span", { children: "Balance due" }), _jsx("span", { children: money(ci.balance, ci.currency) })] })] })] })] }), ci.payment_link_url && _jsxs("a", { className: "fin-chip", href: ci.payment_link_url, target: "_blank", rel: "noreferrer", children: [_jsx(ExternalLink, { size: 13 }), "Online payment link"] }), writer && _jsxs("div", { className: "row wrap fin-actions", children: [draft && !lines && _jsx(Button, { onClick: () => setLines((ci.lines ?? []).map((l) => ({ ...l, quantity: String(Number(l.quantity)), unit_price: String(Number(l.unit_price)) }))), children: "Edit lines" }), draft && _jsxs(Button, { variant: "primary", onClick: () => setSend(true), children: [_jsx(Send, { size: 15 }), "Send"] }), !draft && ci.status !== "void" && _jsxs(Button, { onClick: () => setSend(true), children: [_jsx(Send, { size: 15 }), "Send again"] }), ci.kind === "invoice" && ["sent", "partially_paid", "overdue"].includes(ci.status) && _jsx(Button, { variant: "primary", onClick: () => setPay(true), children: "Record payment" }), ci.kind === "invoice" && !draft && ci.status !== "void" && _jsx(Button, { onClick: () => {
                            const reason = prompt("Reason for the credit note?", "");
                            if (reason !== null)
                                act.mutate({ path: "credit-note", body: { reason } }, { onSuccess: (cn) => { done(cn); nav(`/finance/customer-invoices/${cn.id}`); } });
                        }, children: "Credit note" }), !draft && ci.status !== "void" && ci.status !== "paid" && Number(ci.paid) === 0 &&
                        _jsx(Button, { variant: "ghost", onClick: () => { if (confirm("Void this invoice?"))
                                act.mutate({ path: "void" }, { onSuccess: (x) => done(x) }); }, children: "Void" }), ci.customer && _jsx("a", { className: "btn ghost", href: `/api/v1/finance/customers/${ci.customer.id}/statement?format=csv`, children: "Customer statement" })] }), (ci.credit_notes ?? []).length > 0 && _jsxs("section", { className: "card card-pad", children: [_jsx("h3", { className: "sec-h", children: "Credit notes" }), ci.credit_notes.map((c) => _jsxs(Link, { to: `/finance/customer-invoices/${c.id}`, className: "row fin-small", children: [_jsxs("span", { className: "grow", children: [c.label, " \u00B7 ", c.status] }), money(c.total, ci.currency)] }, c.id))] }), (ci.payments ?? []).length > 0 && _jsxs("section", { className: "card card-pad", children: [_jsx("h3", { className: "sec-h", children: "Payments" }), ci.payments.map((p) => _jsxs("div", { className: "row fin-small", children: [_jsxs("span", { className: "grow", children: [day(p.paid_on), " \u00B7 ", p.method || "payment", p.reference ? ` · ${p.reference}` : ""] }), money(p.amount, ci.currency)] }, p.id))] }), pay && _jsx(PaymentModal, { currency: ci.currency, balance: ci.balance, onClose: () => setPay(false), onSave: (body) => act.mutate({ path: "payments", body }, { onSuccess: (x) => { setPay(false); done(x, "Payment recorded"); } }) }), send && _jsx(SendModal, { onClose: () => setSend(false), onSend: (body) => act.mutate({ path: "send", body }, { onSuccess: (x) => { setSend(false); done(x, "Sent"); } }) })] }));
}
function SendModal({ onClose, onSend }) {
    const [to, setTo] = useState("");
    const [message, setMessage] = useState("");
    return (_jsx(Modal, { title: "Send invoice", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => onSend({ to, message }), children: "Send" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Field, { label: "To", hint: "Leave empty to use the customer's billing email.", children: (fid) => _jsx(Input, { id: fid, type: "email", value: to, onChange: (e) => setTo(e.target.value) }) }), _jsx(Field, { label: "Message (optional)", children: (fid) => _jsx("textarea", { id: fid, className: "input", rows: 3, value: message, onChange: (e) => setMessage(e.target.value) }) }), _jsx("p", { className: "faint fin-small", children: "The PDF is attached. Once sent, the invoice is numbered and read-only; fix mistakes with a credit note." })] }) }));
}
