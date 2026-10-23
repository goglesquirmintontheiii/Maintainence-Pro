import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// The customer's quote page (r235): opened from the emailed link, no sign-in. The customer reads the quote,
// downloads the PDF, asks a question, and approves or rejects it with their name.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileDown, X } from "lucide-react";
import { api } from "../../lib/api";
import { currency, timeAgo } from "../../lib/format";
import { LogoMark } from "../../components/Logo";
import { Button, EmptyState, Field, Input, ListSkeleton, Pill } from "../../components/ui";
import { QUOTE_TONE } from "./Customers";
import "../purchasing/purchasing.css";
export function PublicQuotePage() {
    const { token = "" } = useParams();
    const qc = useQueryClient();
    const key = ["public-quote", token];
    const q = useQuery({ queryKey: key, queryFn: () => api(`/public/quotes/${encodeURIComponent(token)}`), retry: false });
    const [name, setName] = useState("");
    const [comment, setComment] = useState("");
    const [rejecting, setRejecting] = useState(false);
    const [err, setErr] = useState("");
    const decide = useMutation({
        mutationFn: (approve) => api(`/public/quotes/${encodeURIComponent(token)}/decision`, { method: "POST", body: { approve, name, comment } }),
        onSuccess: (d) => { qc.setQueryData(key, d); setErr(""); setComment(""); }, onError: (e) => setErr(e.message),
    });
    const ask = useMutation({
        mutationFn: () => api(`/public/quotes/${encodeURIComponent(token)}/comments`, { method: "POST", body: { name, body: comment } }),
        onSuccess: (d) => { qc.setQueryData(key, d); setComment(""); setErr(""); }, onError: (e) => setErr(e.message),
    });
    if (q.isLoading)
        return _jsx("div", { className: "pq-page", children: _jsx("div", { className: "pq-card", children: _jsx(ListSkeleton, { rows: 5 }) }) });
    if (q.isError || !q.data)
        return _jsx("div", { className: "pq-page", children: _jsx("div", { className: "pq-card", children: _jsx(EmptyState, { title: "This link isn't valid", children: "It may have expired or been replaced by a newer quote. Ask the sender for a new link." }) }) });
    const d = q.data;
    const open = d.status === "sent" && !d.expired;
    const status = d.expired && d.status === "sent" ? "expired" : d.status;
    return (_jsx("div", { className: "pq-page", children: _jsxs("div", { className: "pq-card", children: [_jsxs("div", { className: "row", style: { gap: 10 }, children: [_jsx(LogoMark, { size: 28 }), _jsx("b", { className: "grow", children: d.organization }), _jsxs("a", { className: "btn btn-sm", href: `/api/v1/public/quotes/${encodeURIComponent(token)}/pdf`, target: "_blank", rel: "noopener noreferrer", children: [_jsx(FileDown, { size: 14 }), "PDF"] })] }), _jsxs("div", { children: [_jsxs("div", { className: "small muted", children: ["Quote ", d.number, " for ", d.customer] }), _jsx("h1", { className: "wo-title", style: { margin: "4px 0" }, children: d.title }), _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Pill, { tone: QUOTE_TONE[status], children: status === "sent" ? "Waiting for your decision" : status[0].toUpperCase() + status.slice(1) }), d.valid_until && _jsxs("span", { className: "small muted", children: ["Valid until ", new Date(d.valid_until + "T00:00").toLocaleDateString()] })] })] }), d.scope && _jsx("p", { className: "prewrap", style: { margin: 0 }, children: d.scope }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Item" }), _jsx("th", { className: "num", children: "Qty" }), _jsx("th", { className: "num", children: "Price" }), _jsx("th", { className: "num", children: "Amount" })] }) }), _jsx("tbody", { children: d.lines.map((l, i) => _jsxs("tr", { children: [_jsxs("td", { children: [l.description, _jsx("span", { className: "small faint", style: { display: "block" }, children: l.kind[0].toUpperCase() + l.kind.slice(1) })] }), _jsx("td", { className: "num", children: +Number(l.quantity).toFixed(4) }), _jsx("td", { className: "num", children: currency(l.unit_price, d.currency) }), _jsx("td", { className: "num", children: currency(l.amount, d.currency) })] }, i)) })] }) }), _jsxs("div", { className: "po-totals", children: [_jsxs("div", { children: [_jsx("span", { children: "Subtotal" }), _jsx("span", { children: currency(d.subtotal, d.currency) })] }), _jsxs("div", { children: [_jsx("span", { children: "Tax" }), _jsx("span", { children: currency(d.tax, d.currency) })] }), _jsxs("div", { className: "tot", children: [_jsx("span", { children: "Total" }), _jsx("span", { children: currency(d.total, d.currency) })] })] }), d.decided_by_name && _jsxs("div", { className: "banner " + (d.status === "approved" ? "info" : "warning"), children: [d.status === "approved" ? "Approved" : "Rejected", " by ", d.decided_by_name, d.decided_at ? `, ${timeAgo(d.decided_at)}` : "", d.decision_comment ? `: “${d.decision_comment}”` : ""] }), d.comments.length > 0 && _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Questions and answers" }), d.comments.map((c, i) => _jsx("div", { className: "list-row", style: { alignItems: "flex-start", paddingInline: 0 }, children: _jsxs("span", { className: "grow", children: [_jsxs("span", { className: "small", children: [_jsx("b", { children: c.author }), " ", _jsx("span", { className: "faint", children: timeAgo(c.created_at) })] }), _jsx("span", { className: "prewrap", style: { display: "block" }, children: c.body })] }) }, i))] }), (open || d.status === "sent") && _jsxs("section", { className: "stack", style: { gap: 10 }, children: [_jsx(Field, { label: "Your name", children: (id) => _jsx(Input, { id: id, value: name, maxLength: 200, autoComplete: "name", onChange: (e) => setName(e.target.value) }) }), _jsx(Field, { label: rejecting ? "Why are you rejecting it?" : "Comment or question (optional)", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 3, value: comment, maxLength: 4000, onChange: (e) => setComment(e.target.value) }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err }), _jsxs("div", { className: "row wrap", style: { gap: 8 }, children: [open && !rejecting && _jsxs(Button, { variant: "primary", disabled: !name.trim() || decide.isPending, onClick: () => decide.mutate(true), children: [_jsx(Check, { size: 15 }), "Approve quote"] }), open && (rejecting
                                    ? _jsxs(_Fragment, { children: [_jsxs(Button, { variant: "danger", disabled: !name.trim() || !comment.trim() || decide.isPending, onClick: () => decide.mutate(false), children: [_jsx(X, { size: 15 }), "Reject quote"] }), _jsx(Button, { variant: "ghost", onClick: () => setRejecting(false), children: "Back" })] })
                                    : _jsxs(Button, { onClick: () => setRejecting(true), children: [_jsx(X, { size: 15 }), "Reject"] })), !rejecting && _jsx(Button, { variant: "ghost", disabled: !name.trim() || !comment.trim() || ask.isPending, onClick: () => ask.mutate(), children: "Send question" })] })] })] }) }));
}
