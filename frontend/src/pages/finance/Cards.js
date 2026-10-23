import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Company cards (MP-091): import the bank's statement CSV, match charges to receipts, and chase the card holder for
import { DropZone } from "../../components/DropZone";
// the receipts still missing. Approved reimbursements export to CSV for payroll from here too.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CreditCard, Download, FileUp, Mail, Plus, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { day, money, postForm } from "./types";
export function CardsTab({ me, id }) {
    const nav = useNavigate();
    const { toast } = useToast();
    const [adding, setAdding] = useState(false);
    const list = useQuery({ queryKey: ["finance", "cards"], queryFn: () => api("/finance/cards") });
    const exportR = useMutation({ mutationFn: () => api("/finance/reimbursements/export", { method: "POST", body: {} }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsxs("div", { className: "split fin-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Cards" }), me.can["finance.invoices"] && _jsxs(Button, { variant: "primary", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 16 }), "Add card"] })] }), me.can["finance.invoices.approve"] && _jsxs(Button, { size: "sm", onClick: () => exportR.mutate(), children: [_jsx(Download, { size: 14 }), "Export approved reimbursements"] })] }), _jsx("div", { className: "list", "aria-label": "Cards", children: list.isLoading ? _jsx(ListSkeleton, {}) : !list.data?.items.length ? _jsx(EmptyState, { icon: _jsx(CreditCard, { size: 28 }), title: "No company cards", children: "Add a card, then import its statement to see which charges still need a receipt." })
                            : list.data.items.map((c) => (_jsxs(Link, { to: `/finance/cards/${c.id}`, className: "list-row" + (c.id === id ? " active" : ""), children: [_jsx(CreditCard, { size: 18 }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [c.name, " \u2022\u2022", c.last4] }), _jsxs("div", { className: "s", children: [c.holder?.name ?? "No holder", c.active ? "" : " · inactive"] })] }), c.unmatched > 0 && _jsxs(Pill, { tone: "warning", children: [c.unmatched, " missing"] })] }, c.id))) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(CardDetail, { id: id, me: me, onBack: () => nav("/finance/cards") }) : _jsx(EmptyState, { title: "Pick a card" }) }), adding && _jsx(CardForm, { onClose: () => setAdding(false), onSaved: (c) => { setAdding(false); nav(`/finance/cards/${c.id}`); } })] }));
}
function CardForm({ edit, onClose, onSaved }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const users = useQuery({ queryKey: ["users", "lite"], staleTime: 60_000, queryFn: () => api("/users?per_page=500") });
    const [f, setF] = useState({ name: edit?.name ?? "", last4: edit?.last4 ?? "", holder_user_id: edit?.holder?.id ?? "" });
    const save = useMutation({ mutationFn: () => edit ? api(`/finance/cards/${edit.id}`, { method: "PATCH", body: f }) : api("/finance/cards", { method: "POST", body: f }),
        onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["finance", "cards"] }); onSaved(c); }, onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsx(Modal, { title: edit ? "Edit card" : "Add company card", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => save.mutate(), disabled: save.isPending, children: "Save" })] }), children: _jsxs("div", { className: "fin-form-grid", children: [_jsx(Field, { label: "Name", children: (fid) => _jsx(Input, { id: fid, value: f.name, onChange: (e) => setF({ ...f, name: e.target.value }), placeholder: "Maintenance Amex" }) }), _jsx(Field, { label: "Last 4 digits", children: (fid) => _jsx(Input, { id: fid, inputMode: "numeric", maxLength: 4, value: f.last4, onChange: (e) => setF({ ...f, last4: e.target.value }) }) }), _jsx(Field, { label: "Card holder", hint: "Gets the missing-receipt reminders", children: (fid) => _jsxs(Select, { id: fid, value: f.holder_user_id, onChange: (e) => setF({ ...f, holder_user_id: e.target.value }), children: [_jsx("option", { value: "", children: "\u2014" }), users.data?.items.map((u) => _jsx("option", { value: u.id, children: u.name }, u.id))] }) })] }) }));
}
function CardDetail({ id, me, onBack }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [filter, setFilter] = useState("missing");
    const [edit, setEdit] = useState(false);
    const q = useQuery({ queryKey: ["finance", "card", id, filter], queryFn: () => api(`/finance/cards/${id}/transactions?status=${filter}`) });
    const refresh = () => { void qc.invalidateQueries({ queryKey: ["finance", "card", id] }); void qc.invalidateQueries({ queryKey: ["finance", "cards"] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const imp = useMutation({ mutationFn: (file) => postForm(`/finance/cards/${id}/statement`, { file }),
        onSuccess: (r) => { refresh(); toast(`Imported ${r.added} charge${r.added === 1 ? "" : "s"}; ${r.matched} matched a receipt${r.skipped ? `, ${r.skipped} skipped` : ""}.`); }, onError: err });
    const act = useMutation({ mutationFn: (path) => api(`/finance/cards/${id}/${path}`, { method: "POST", body: {} }),
        onSuccess: (r) => { refresh(); toast(r.chased !== undefined ? `Asked for ${r.chased} receipt${r.chased === 1 ? "" : "s"}` : `${r.matched ?? 0} matched`); }, onError: err });
    const setTxn = useMutation({ mutationFn: ({ tid, body }) => api(`/finance/card-transactions/${tid}`, { method: "PATCH", body }), onSuccess: refresh, onError: err });
    const card = q.data?.card;
    const writer = me.can["finance.invoices"];
    return (_jsxs("div", { className: "detail fin-detail", children: [_jsxs("div", { className: "detail-head", children: [_jsx(Button, { icon: true, className: "fin-back", "aria-label": "Back", onClick: onBack, children: _jsx(ArrowLeft, { size: 18 }) }), _jsx("h2", { className: "grow", children: card ? `${card.name} ••${card.last4}` : "Card" }), writer && card && _jsx(Button, { onClick: () => setEdit(true), children: "Edit" })] }), writer && _jsx(DropZone, { accept: ".csv,text/csv", multiple: false, label: "Drop the statement CSV", onFiles: (fs) => imp.mutate(fs[0]), children: _jsxs("div", { className: "row wrap fin-actions", children: [_jsxs("label", { className: "btn primary", children: [_jsx(FileUp, { size: 15 }), "Import statement (CSV)", _jsx("input", { type: "file", accept: ".csv,text/csv", hidden: true, onChange: (e) => { const f = e.target.files?.[0]; if (f)
                                        imp.mutate(f); e.target.value = ""; } })] }), _jsxs(Button, { onClick: () => act.mutate("reconcile"), children: [_jsx(RefreshCw, { size: 15 }), "Match receipts"] }), _jsxs(Button, { onClick: () => act.mutate("chase"), disabled: !card?.holder, children: [_jsx(Mail, { size: 15 }), "Chase missing receipts"] })] }) }), _jsx("div", { className: "seg fin-seg", role: "tablist", "aria-label": "Filter", children: [["missing", "Missing receipt"], ["matched", "Matched"], ["ignored", "Ignored"], ["", "All"]].map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": filter === k, className: "seg-btn" + (filter === k ? " on" : ""), onClick: () => setFilter(k), children: l }, k)) }), _jsx("section", { className: "card", children: q.isLoading ? _jsx(ListSkeleton, { rows: 4 }) : !q.data?.items.length ? _jsx(EmptyState, { title: filter === "missing" ? "Nothing missing" : "No charges", children: "Import the card statement to see its charges." })
                    : _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table fin-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Date" }), _jsx("th", { children: "Merchant" }), _jsx("th", { className: "num", children: "Amount" }), _jsx("th", { children: "Receipt" }), _jsx("th", {})] }) }), _jsx("tbody", { children: q.data.items.map((t) => _jsxs("tr", { children: [_jsx("td", { children: day(t.posted_on) }), _jsx("td", { children: t.merchant || "—" }), _jsx("td", { className: "num", children: money(t.amount, t.currency) }), _jsx("td", { children: t.receipt_id ? _jsx(Link, { to: `/finance/receipts/${t.receipt_id}`, children: "Open" }) : t.status === "chased" ? _jsxs(Pill, { tone: "warning", children: ["Asked ", day(t.chased_at)] }) : t.status === "ignored" ? _jsx(Pill, { children: "Ignored" }) : _jsx(Pill, { tone: "warning", children: "Missing" }) }), _jsx("td", { children: writer && (t.status === "ignored" ? _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setTxn.mutate({ tid: t.id, body: { status: "unmatched" } }), children: "Undo" })
                                                    : !t.receipt_id && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setTxn.mutate({ tid: t.id, body: { status: "ignored" } }), children: "Ignore" })) })] }, t.id)) })] }) }) }), edit && card && _jsx(CardForm, { edit: card, onClose: () => setEdit(false), onSaved: () => { setEdit(false); refresh(); } })] }));
}
