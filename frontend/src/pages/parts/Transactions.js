import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// The transactions log (r223): every stock change from the ledger, filterable and exportable.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Input, ListSkeleton, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { qsOf } from "./types";
import "./parts.css";
const KINDS = [["", "All changes"], ["restock,receive", "Restocks and receipts"], ["use,return", "Used and returned"], ["adjust,count", "Adjustments and counts"],
    ["transfer_out,transfer_in", "Moves"], ["initial", "Opening stock"]];
export function TxnTable({ filters, hidePart }) {
    const { session } = useSession();
    const tz = session.org?.timezone;
    const qs = qsOf(filters);
    const q = useInfiniteQuery({
        queryKey: ["part-txns", qs],
        queryFn: ({ pageParam }) => api(`/parts/transactions?limit=50&${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
        initialPageParam: "",
        getNextPageParam: (last) => last.next_cursor ?? undefined,
    });
    if (q.isLoading)
        return _jsx(ListSkeleton, { rows: 4 });
    if (q.isError)
        return _jsx("div", { className: "banner warning", children: q.error.message });
    const rows = (q.data?.pages ?? []).flatMap((p) => p.items);
    if (!rows.length)
        return _jsx(EmptyState, { title: "No transactions yet", children: "Restocks, parts used on work orders, adjustments and moves show here." });
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table part-txn-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "When" }), !hidePart && _jsx("th", { children: "Part" }), _jsx("th", { children: "Change" }), _jsx("th", { className: "num", children: "Quantity" }), _jsx("th", { className: "num", children: "After" }), _jsx("th", { children: "Location" }), _jsx("th", { children: "By" }), _jsx("th", { children: "Details" })] }) }), _jsx("tbody", { children: rows.map((t) => (_jsxs("tr", { children: [_jsx("td", { className: "small", style: { whiteSpace: "nowrap" }, children: dateTime(t.at, tz) }), !hidePart && _jsx("td", { children: t.part ? _jsx(Link, { to: `/parts/${t.part.id}`, children: t.part.name }) : _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { children: _jsx("span", { className: "part-kind k-" + t.kind, children: t.kind_label }) }), _jsxs("td", { className: "num " + (t.direction === "in" ? "part-in" : t.direction === "out" ? "part-out" : ""), children: [t.direction === "in" ? "+" : "", t.quantity] }), _jsx("td", { className: "num", children: t.after ?? "—" }), _jsx("td", { children: t.location?.name ?? _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { className: "small", children: t.user?.name ?? _jsx("span", { className: "faint", children: "System" }) }), _jsxs("td", { className: "small", children: [t.work_order ? _jsxs(Link, { to: `/work-orders/${t.work_order.id}`, children: ["#", t.work_order.number, " ", t.work_order.title] }) : null, t.purchase_order_id && _jsx(Link, { to: `/purchase-orders/${t.purchase_order_id}`, children: "Purchase order" }), t.note && _jsxs("span", { className: "faint", children: [t.work_order || t.purchase_order_id ? " · " : "", t.note] })] })] }, t.id))) })] }) }), q.hasNextPage && _jsx("div", { className: "card-body", children: _jsx(Button, { size: "sm", disabled: q.isFetchingNextPage, onClick: () => q.fetchNextPage(), children: "Load more" }) })] }));
}
export function TransactionsPage() {
    const { can } = useSession();
    const { toast } = useToast();
    const nav = useNavigate();
    const [kind, setKind] = useState("");
    const [loc, setLoc] = useState(null);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const filters = { kind, location_id: loc ?? "", from: from ? new Date(from).toISOString() : "", to: to ? new Date(to + "T23:59:59").toISOString() : "" };
    const exp = useMutation({
        mutationFn: () => api("/parts/export", { method: "POST", body: { report: "transactions", query: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) } }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsx("div", { className: "wo-page", children: _jsxs("div", { className: "wo-scroll page-narrow", children: [_jsxs(Link, { to: "/parts", className: "row small", children: [_jsx(ArrowLeft, { size: 14 }), "Parts"] }), _jsxs("div", { className: "row", style: { justifyContent: "space-between", margin: "8px 0 12px" }, children: [_jsx("h1", { children: "Transactions" }), can("exports.use") && _jsxs(Button, { onClick: () => exp.mutate(), disabled: exp.isPending, children: [_jsx(Download, { size: 15 }), "Export CSV"] })] }), _jsxs("div", { className: "asset-filters part-filters", style: { marginBottom: 12 }, children: [_jsx(Select, { "aria-label": "Kind of change", value: kind, onChange: (e) => setKind(e.target.value), children: KINDS.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }), _jsx("div", { className: "asset-filter-loc", children: _jsx(LocationPicker, { value: loc, onChange: setLoc, placeholder: "Any location" }) }), _jsxs("label", { className: "row small", style: { gap: 6 }, children: ["From", _jsx(Input, { type: "date", "aria-label": "From", value: from, onChange: (e) => setFrom(e.target.value) })] }), _jsxs("label", { className: "row small", style: { gap: 6 }, children: ["To", _jsx(Input, { type: "date", "aria-label": "To", value: to, onChange: (e) => setTo(e.target.value) })] })] }), _jsx(TxnTable, { filters: filters })] }) }));
}
