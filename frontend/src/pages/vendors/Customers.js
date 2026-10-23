import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Customers (0.5.0, MP-046, r234, r235): list + detail. A customer gets its own location, billing details, labor
// rate and parts markup, linked assets, work orders (the Customer field on a work order) and quotes the customer
// approves through a link — no account needed.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Copy, FileDown, FileText, MoreHorizontal, Pencil, Plus, Search, Send, Trash2, UserRound } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { copyText } from "../../lib/wo";
import { currency, dateTime, show, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import { ColorPicker } from "../../components/ColorPicker";
import { useLocationList } from "../../lib/assets";
import { AddressFields, addressText, ContactCard, ContactDialog, OrgAvatar } from "./Vendors";
import "../purchasing/purchasing.css";
export const QUOTE_TONE = {
    draft: "neutral", sent: "info", approved: "success", rejected: "danger", expired: "warning", canceled: "neutral"
};
const QUOTE_LABEL = { draft: "Draft", sent: "Sent", approved: "Approved", rejected: "Rejected", expired: "Expired", canceled: "Canceled" };
export function useCustomersLite() {
    const { can } = useSession();
    return useQuery({ queryKey: ["customers", "lite"], queryFn: () => api("/customers?per_page=500"), staleTime: 30_000, enabled: can("customers.view") });
}
export function CustomersPage() {
    const { id } = useParams();
    const nav = useNavigate();
    const { can } = useSession();
    const [search, setSearch] = useState("");
    const [creating, setCreating] = useState(false);
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Customers" }), can("customers.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New Customer", children: [_jsx(Plus, { size: 16 }), "New"] })] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search customers", value: search, onChange: (e) => setSearch(e.target.value), "aria-label": "Search customers" })] })] }), _jsx("div", { className: "list", "aria-label": "Customers", children: _jsx(CustomerList, { q: search, activeId: id }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(CustomerDetailView, { id: id }, id)
                            : _jsx(EmptyState, { icon: _jsx(UserRound, { size: 28 }), title: "Select a customer", children: "Pick one to see their locations, work orders and quotes." }) })] }), creating && _jsx(CustomerForm, { onClose: () => setCreating(false), onSaved: (c) => { setCreating(false); nav(`/customers/${c.id}`); } })] }));
}
function CustomerList({ q, activeId }) {
    const { can } = useSession();
    const list = useQuery({ queryKey: ["customers", "list", q], queryFn: () => api(`/customers?per_page=200&q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
    if (list.isLoading)
        return _jsx(ListSkeleton, {});
    const items = list.data?.items ?? [];
    if (!items.length)
        return q ? _jsx(EmptyState, { title: "No customers match", children: "Try another search." })
            : _jsx(EmptyState, { icon: _jsx(UserRound, { size: 26 }), title: "No customers yet", children: can("customers.manage") ? "Add the clients you do maintenance work for." : "Customers your team adds show here." });
    return _jsx(_Fragment, { children: items.map((c) => _jsxs(Link, { to: `/customers/${c.id}`, className: "list-row" + (c.id === activeId ? " active" : ""), children: [_jsx(OrgAvatar, { name: c.name, color: c.color }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("span", { className: "t", style: { display: "block" }, children: c.name }), _jsx("span", { className: "s", style: { display: "block" }, children: [c.contacts[0]?.name, c.email, c.phone].filter(Boolean).join(" · ") || " " })] })] }, c.id)) });
}
function CustomerDetailView({ id }) {
    const c = useQuery({ queryKey: ["customer", id], queryFn: () => api(`/customers/${id}`) });
    const qc = useQueryClient();
    const nav = useNavigate();
    const { session, can } = useSession();
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const [contact, setContact] = useState(null);
    const [quote, setQuote] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const refresh = () => { qc.invalidateQueries({ queryKey: ["customer", id] }); qc.invalidateQueries({ queryKey: ["customers"] }); };
    const del = useMutation({ mutationFn: () => api(`/customers/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); toast("Customer deleted"); nav("/customers"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    if (c.isError)
        return _jsx(EmptyState, { icon: _jsx(UserRound, { size: 28 }), title: "Customer not found", children: "It may have been deleted, or you don't have access." });
    const d = c.data;
    if (!d)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 5 }) });
    const cur = d.currency || session.org?.currency;
    const manage = can("customers.manage");
    return (_jsxs("div", { className: "detail", children: [_jsxs(Link, { to: "/customers", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All customers"] }), _jsxs("div", { className: "wo-head", children: [_jsx(OrgAvatar, { name: d.name, color: d.color, lg: true }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "small muted", children: _jsx(Link, { to: "/customers", children: "Customers" }) }), _jsx("h1", { className: "wo-title", children: d.name })] }), _jsxs("div", { className: "row", children: [can("quotes.manage") && _jsxs(Button, { onClick: () => setQuote("new"), children: [_jsx(FileText, { size: 15 }), _jsx("span", { className: "desktop-only", children: "New quote" })] }), manage && _jsx(Button, { icon: true, "aria-label": "Edit customer", title: "Edit", onClick: () => setEditing(true), children: _jsx(Pencil, { size: 15 }) }), manage && _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 200, children: (close) => _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirm(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] }) })] })] }), d.description && _jsx("section", { className: "card card-pad prewrap", children: d.description }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { children: [_jsx("dt", { children: "Email" }), _jsx("dd", { children: d.email ? _jsx("a", { href: `mailto:${d.email}`, children: d.email }) : "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Phone" }), _jsx("dd", { children: show(d.phone) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Billing email" }), _jsx("dd", { children: show(d.billing_email) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Billing address" }), _jsx("dd", { className: "prewrap small", children: addressText(d.billing_address) || "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Tax ID" }), _jsx("dd", { className: "mono", children: show(d.tax_id) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Payment terms" }), _jsx("dd", { children: show(d.payment_terms) })] }), can("costs.view") && _jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("dt", { children: "Labor rate" }), _jsx("dd", { children: d.labor_rate ? `${currency(d.labor_rate, cur)} / h` : "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Parts markup" }), _jsx("dd", { children: d.parts_markup_pct ? `${Number(d.parts_markup_pct)}%` : "—" })] })] }), _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Locations" }), _jsx("dd", { children: d.locations.length ? _jsx("span", { className: "vd-chips", children: d.locations.map((l) => _jsx(Link, { className: "chip", to: `/locations/${l.id}`, children: l.name }, l.id)) }) : "—" })] }), _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Assets" }), _jsx("dd", { children: d.assets.length ? _jsx("span", { className: "vd-chips", children: d.assets.map((a) => _jsx(Link, { className: "chip", to: `/assets/${a.id}`, children: a.name }, a.id)) }) : _jsx("span", { className: "faint", children: "None" }) })] })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Contacts" }), manage && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setContact("new"), children: [_jsx(Plus, { size: 14 }), "Add contact"] })] }), d.contacts.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No contacts yet." })
                        : _jsx("div", { className: "contact-grid", children: d.contacts.map((x) => _jsx(ContactCard, { c: x, onEdit: manage ? () => setContact(x) : undefined }, x.id)) })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Quotes" }), can("quotes.manage") && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setQuote("new"), children: [_jsx(Plus, { size: 14 }), "New quote"] })] }), d.quotes.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No quotes yet. A quote lists the labor and parts for a job; the customer approves it from a link." })
                        : d.quotes.map((x) => _jsxs("button", { type: "button", className: "list-row", style: { width: "100%", textAlign: "left", background: "none" }, onClick: () => setQuote(x.id), children: [_jsxs("span", { className: "mono small faint", children: ["Q-", x.number] }), _jsx("span", { className: "grow t", children: x.title }), _jsx("span", { className: "small", children: currency(x.total, x.currency || cur) }), _jsx(Pill, { tone: QUOTE_TONE[x.status], children: QUOTE_LABEL[x.status] })] }, x.id))] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Work orders" }) }), d.work_orders.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Work orders with this customer show here. Set the Customer field on a work order." })
                        : d.work_orders.map((w) => _jsxs(Link, { to: `/work-orders/${w.id}`, className: "list-row", children: [_jsxs("span", { className: "mono small faint", children: ["#", w.number] }), _jsx("span", { className: "grow t", children: w.title }), _jsx("span", { className: "small faint", children: w.status.replace("_", " ") })] }, w.id))] }), _jsxs("div", { className: "small faint", children: ["Added ", dateTime(d.created_at, session.org?.timezone)] }), editing && _jsx(CustomerForm, { edit: d, onClose: () => setEditing(false), onSaved: () => { setEditing(false); refresh(); } }), contact && _jsx(ContactDialog, { kind: "customer", parentId: d.id, edit: contact === "new" ? undefined : contact, onClose: () => setContact(null), onDone: () => { setContact(null); refresh(); } }), quote && _jsx(QuoteDrawer, { customer: d, quoteId: quote === "new" ? undefined : quote, onClose: () => { setQuote(null); refresh(); } }), confirm && _jsx(Modal, { title: "Delete customer?", onClose: () => setConfirm(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirm(false), children: "Cancel" }), _jsx(Button, { variant: "danger", disabled: del.isPending, onClick: () => del.mutate(), children: "Delete" })] }), children: _jsxs("p", { children: [d.name, " will be removed from lists. Work orders keep their history."] }) })] }));
}
function CustomerForm({ edit, onClose, onSaved }) {
    const locs = useLocationList();
    const [f, setF] = useState(() => ({
        name: edit?.name ?? "", color: edit?.color ?? "#5d6880", description: edit?.description ?? "", email: edit?.email ?? "", phone: edit?.phone ?? "",
        billing_email: edit?.billing_email ?? "", billing_address: edit?.billing_address ?? {}, tax_id: edit?.tax_id ?? "", payment_terms: edit?.payment_terms ?? "",
        currency: edit?.currency ?? "", labor_rate: edit?.labor_rate ?? "", parts_markup_pct: edit?.parts_markup_pct ?? "",
        location_ids: edit?.locations.map((l) => l.id) ?? [], asset_ids: edit?.assets.map((a) => a.id) ?? [],
    }));
    const [err, setErr] = useState("");
    const set = (p) => setF((x) => ({ ...x, ...p }));
    const locOpts = useMemo(() => (locs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name })), [locs.data]);
    const body = { ...f, labor_rate: f.labor_rate === "" ? null : f.labor_rate, parts_markup_pct: f.parts_markup_pct === "" ? null : f.parts_markup_pct,
        ...(edit ? {} : { location_ids: undefined }) };
    const save = useMutation({
        mutationFn: () => edit ? api(`/customers/${edit.id}`, { method: "PATCH", body }) : api("/customers", { method: "POST", body }),
        onSuccess: onSaved, onError: (e) => setErr(e.message),
    });
    return (_jsx(Drawer, { title: edit ? `Edit ${edit.name}` : "New Customer", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || save.isPending, onClick: () => save.mutate(), children: edit ? "Save" : "Create" })] }), children: _jsxs("div", { className: "stack", style: { gap: 12 }, children: [_jsxs("div", { className: "row", style: { gap: 10, alignItems: "flex-end" }, children: [_jsx(Field, { label: "Name", className: "grow", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: f.name, maxLength: 255, onChange: (e) => set({ name: e.target.value }) }) }), _jsx(ColorPicker, { value: f.color, onChange: (c) => set({ color: c }) })] }), !edit && _jsx("p", { className: "small muted", children: "A location with the customer's name is created for them, so their assets and work orders sit together." }), _jsx(Field, { label: "Description", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 2, value: f.description, onChange: (e) => set({ description: e.target.value }) }) }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", value: f.email, onChange: (e) => set({ email: e.target.value }) }) }), _jsx(Field, { label: "Phone", children: (id) => _jsx(Input, { id: id, type: "tel", value: f.phone, onChange: (e) => set({ phone: e.target.value }) }) }), _jsx(Field, { label: "Billing email", hint: "Quotes are sent here", children: (id) => _jsx(Input, { id: id, type: "email", value: f.billing_email, onChange: (e) => set({ billing_email: e.target.value }) }) }), _jsx(Field, { label: "Tax ID", children: (id) => _jsx(Input, { id: id, value: f.tax_id, onChange: (e) => set({ tax_id: e.target.value }) }) }), _jsx(Field, { label: "Payment terms", children: (id) => _jsx(Input, { id: id, value: f.payment_terms, placeholder: "Net 30", onChange: (e) => set({ payment_terms: e.target.value }) }) }), _jsx(Field, { label: "Currency", hint: "Empty: your organization's", children: (id) => _jsx(Input, { id: id, value: f.currency, maxLength: 3, onChange: (e) => set({ currency: e.target.value.toUpperCase() }) }) }), _jsx(Field, { label: "Labor rate (per hour)", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.labor_rate, onChange: (e) => set({ labor_rate: e.target.value }) }) }), _jsx(Field, { label: "Parts markup %", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.parts_markup_pct, onChange: (e) => set({ parts_markup_pct: e.target.value }) }) })] }), _jsx("h3", { className: "sec-h", children: "Billing address" }), _jsx(AddressFields, { value: f.billing_address, onChange: (a) => set({ billing_address: a }) }), edit && _jsx(Field, { label: "Locations", children: (id) => _jsx(MultiPicker, { id: id, label: "Locations", placeholder: "Add locations", value: f.location_ids, onChange: (v) => set({ location_ids: v }), options: locOpts }) }), _jsx(Field, { label: "Assets", children: (id) => _jsx(AssetPicker, { id: id, multi: true, value: f.asset_ids, onChange: (v) => set({ asset_ids: v }), placeholder: "Add assets" }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }) }));
}
// ---------------------------------------------------------------- quotes (r235)
function QuoteDrawer({ customer, quoteId, onClose }) {
    const q = useQuery({ queryKey: ["quote", quoteId], queryFn: () => api(`/quotes/${quoteId}`), enabled: !!quoteId });
    if (quoteId && !q.data)
        return _jsx(Drawer, { title: "Quote", onClose: onClose, children: _jsx(ListSkeleton, { rows: 4 }) });
    return _jsx(QuoteEditor, { customer: customer, quote: q.data, onClose: onClose }, q.data?.id ?? "new");
}
function QuoteEditor({ customer, quote, onClose }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const { can } = useSession();
    const editable = !quote || quote.status === "draft" || quote.status === "sent";
    const cur = quote?.currency || customer.currency || undefined;
    const [title, setTitle] = useState(quote?.title ?? "");
    const [scope, setScope] = useState(quote?.scope ?? "");
    const [validUntil, setValidUntil] = useState(quote?.valid_until ?? "");
    const [woId, setWoId] = useState(quote?.work_order_id ?? "");
    const [taxPct, setTaxPct] = useState("");
    const [lines, setLines] = useState(quote?.lines ?? [{ kind: "labor", description: "Labor (hours)", quantity: "1", unit_price: customer.labor_rate ?? "", taxable: true }]);
    const [err, setErr] = useState("");
    const [sending, setSending] = useState(false);
    const [link, setLink] = useState("");
    const sub = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
    const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
    const tax = taxPct !== "" ? taxable * (Number(taxPct) || 0) / 100 : Number(quote?.tax ?? 0);
    const refresh = () => { qc.invalidateQueries({ queryKey: ["quote", quote?.id] }); qc.invalidateQueries({ queryKey: ["customer", customer.id] }); };
    const save = useMutation({
        mutationFn: () => {
            const body = { title, scope, valid_until: validUntil || null, work_order_id: woId || null, lines, ...(taxPct !== "" ? { tax_pct: taxPct } : {}) };
            return quote ? api(`/quotes/${quote.id}`, { method: "PATCH", body }) : api("/quotes", { method: "POST", body: { ...body, customer_id: customer.id } });
        },
        onSuccess: () => { refresh(); toast("Quote saved"); onClose(); }, onError: (e) => setErr(e.message),
    });
    const cancel = useMutation({ mutationFn: () => api(`/quotes/${quote?.id}/cancel`, { method: "POST", body: {} }), onSuccess: () => { refresh(); onClose(); }, onError: (e) => setErr(e.message) });
    const setLine = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
    return (_jsxs(Drawer, { title: quote ? `Quote Q-${quote.number}` : `New quote for ${customer.name}`, onClose: onClose, width: 720, footer: _jsxs(_Fragment, { children: [quote && _jsxs("span", { className: "grow row", style: { gap: 6 }, children: [_jsx(Pill, { tone: QUOTE_TONE[quote.status], children: QUOTE_LABEL[quote.status] }), quote.decided_by_name && _jsxs("span", { className: "small muted", children: ["by ", quote.decided_by_name] })] }), !quote && _jsx("span", { className: "grow" }), _jsx(Button, { onClick: onClose, children: "Close" }), editable && can("quotes.manage") && _jsx(Button, { variant: "primary", disabled: !title.trim() || !lines.length || save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: [_jsxs("div", { className: "stack", style: { gap: 12 }, children: [quote && _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [editable && can("quotes.manage") && _jsxs(Button, { size: "sm", onClick: () => setSending(true), children: [_jsx(Send, { size: 14 }), quote.status === "sent" ? "Send again" : "Send to customer"] }), _jsxs("a", { className: "btn btn-sm", href: `/api/v1/quotes/${quote.id}/pdf`, target: "_blank", rel: "noopener noreferrer", children: [_jsx(FileDown, { size: 14 }), "PDF"] }), editable && can("quotes.manage") && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => cancel.mutate(), children: [_jsx(Ban, { size: 14 }), "Cancel quote"] }), quote.sent_at && _jsxs("span", { className: "small faint", children: ["Sent ", timeAgo(quote.sent_at)] })] }), link && _jsxs("div", { className: "banner info row", style: { gap: 8 }, children: [_jsx("span", { className: "grow small", style: { wordBreak: "break-all" }, children: link }), _jsxs(Button, { size: "sm", onClick: async () => toast((await copyText(link)) ? "Link copied" : "Couldn't copy"), children: [_jsx(Copy, { size: 14 }), "Copy"] })] }), quote?.decision_comment && _jsxs("div", { className: "banner info", children: ["\u201C", quote.decision_comment, "\u201D \u2014 ", quote.decided_by_name] }), _jsx(Field, { label: "Title", children: (id) => _jsx(Input, { id: id, value: title, disabled: !editable, maxLength: 255, onChange: (e) => setTitle(e.target.value), placeholder: "e.g. Replace rooftop unit compressor" }) }), _jsx(Field, { label: "Scope of work", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 3, disabled: !editable, value: scope, onChange: (e) => setScope(e.target.value) }) }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Valid until", children: (id) => _jsx(Input, { id: id, type: "date", disabled: !editable, value: validUntil, onChange: (e) => setValidUntil(e.target.value) }) }), _jsx(Field, { label: "Work order", hint: "Approved quotes attach to it", children: (id) => _jsxs(Select, { id: id, disabled: !editable, value: woId, onChange: (e) => setWoId(e.target.value), children: [_jsx("option", { value: "", children: "None" }), customer.work_orders.map((w) => _jsxs("option", { value: w.id, children: ["#", w.number, " ", w.title] }, w.id))] }) }), _jsx(Field, { label: "Tax %", hint: quote ? "Leave empty to keep the current tax" : undefined, children: (id) => _jsx(Input, { id: id, disabled: !editable, inputMode: "decimal", value: taxPct, onChange: (e) => setTaxPct(e.target.value) }) })] }), _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Lines" }), lines.map((l, i) => _jsxs("div", { className: "quote-line", children: [_jsxs(Select, { "aria-label": "Kind", disabled: !editable, value: l.kind, onChange: (e) => setLine(i, { kind: e.target.value }), children: [_jsx("option", { value: "labor", children: "Labor" }), _jsx("option", { value: "part", children: "Part" }), _jsx("option", { value: "other", children: "Other" })] }), _jsx(Input, { "aria-label": "Description", disabled: !editable, value: l.description, onChange: (e) => setLine(i, { description: e.target.value }) }), _jsx(Input, { "aria-label": "Quantity", disabled: !editable, inputMode: "decimal", value: l.quantity, onChange: (e) => setLine(i, { quantity: e.target.value }) }), _jsx(Input, { "aria-label": "Price", disabled: !editable, inputMode: "decimal", value: l.unit_price, onChange: (e) => setLine(i, { unit_price: e.target.value }) }), _jsx(Checkbox, { checked: l.taxable, disabled: !editable, onChange: (v) => setLine(i, { taxable: v }), label: "Tax" }), editable ? _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove line", onClick: () => setLines((ls) => ls.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) }) : _jsx("span", {})] }, i)), editable && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setLines((ls) => [...ls, { kind: "part", description: "", quantity: "1", unit_price: "", taxable: true }]), children: [_jsx(Plus, { size: 14 }), "Add line"] }), _jsxs("div", { className: "po-sum", children: [_jsx("span", { children: "Subtotal" }), _jsx("b", { children: currency(sub, cur) }), _jsx("span", { children: "Tax" }), _jsx("b", { children: currency(tax, cur) }), _jsx("span", { children: "Total" }), _jsx("b", { children: currency(sub + tax, cur) })] })] }), quote && quote.comments.length > 0 && _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Conversation" }) }), quote.comments.map((c, i) => _jsx("div", { className: "list-row", style: { alignItems: "flex-start" }, children: _jsxs("span", { className: "grow", children: [_jsxs("span", { className: "small", children: [_jsx("b", { children: c.author }), " ", _jsx("span", { className: "faint", children: timeAgo(c.created_at) })] }), _jsx("span", { className: "prewrap", style: { display: "block" }, children: c.body })] }) }, i))] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }), sending && quote && _jsx(SendQuoteDialog, { quote: quote, customer: customer, onClose: () => setSending(false), onSent: (url) => { setSending(false); setLink(url); refresh(); } })] }));
}
function SendQuoteDialog({ quote, customer, onClose, onSent }) {
    const [to, setTo] = useState(customer.billing_email || customer.email || "");
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => api(`/quotes/${quote.id}/send`, { method: "POST", body: { message: msg, to: to.split(/[,;\s]+/).filter(Boolean) } }),
        onSuccess: (r) => onSent(r.url), onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: "Send quote", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: m.isPending, onClick: () => m.mutate(), children: [_jsx(Send, { size: 14 }), "Send"] })] }), children: [_jsx("p", { className: "small muted", children: "The customer gets a link to review the quote, ask questions and approve or reject it \u2014 no account needed. Sending again makes a new link and turns off the old one." }), _jsx(Field, { label: "To", children: (id) => _jsx(Input, { id: id, value: to, onChange: (e) => setTo(e.target.value) }) }), _jsx(Field, { label: "Message", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 3, value: msg, onChange: (e) => setMsg(e.target.value) }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
