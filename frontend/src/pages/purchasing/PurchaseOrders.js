import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Purchase Orders (0.5.0, MP-042–044): MaintainX list + detail. Status tabs (Open, Awaiting approval, Overdue,
// Completed, All), search, vendor filter, a restock suggestions view (low stock → POs), CSV export.
// Mobile (r232): the list and the detail take the whole screen in turn. "Order this part" lands here with
// ?new=1&part_id=…&vendor_id=…&quantity=… and opens the form prefilled.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Lightbulb, MoreHorizontal, Plus, Search, Settings2, ShoppingCart } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Input, ListSkeleton, Select } from "../../components/ui";
import { PODetailView, POStatusPill } from "./PODetail";
import { POForm, useVendorsLite } from "./POForm";
import { q as fmtQ, usePOOptions } from "./types";
import "./purchasing.css";
const TABS = [["open", "Open"], ["awaiting_me", "Awaiting my approval"], ["overdue", "Overdue"], ["complete", "Completed"], ["", "All"]];
export function PurchaseOrdersPage() {
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const nav = useNavigate();
    const { toast } = useToast();
    const opts = usePOOptions();
    const can = opts.data?.can;
    const [tab, setTab] = useState(() => { try {
        return sessionStorage.getItem("po.tab") ?? "open";
    }
    catch {
        return "open";
    } });
    const [search, setSearch] = useState("");
    const [vendorId, setVendorId] = useState("");
    const [prefill, setPrefill] = useState(null);
    useEffect(() => { try {
        sessionStorage.setItem("po.tab", tab);
    }
    catch { /* private mode */ } }, [tab]);
    useEffect(() => {
        if (params.get("new") !== "1")
            return;
        setPrefill({ part_id: params.get("part_id") ?? undefined, vendor_id: params.get("vendor_id") ?? undefined, quantity: params.get("quantity") ?? undefined,
            work_order_id: params.get("work_order_id") ?? undefined });
        const p = new URLSearchParams(params);
        ["new", "part_id", "vendor_id", "quantity", "work_order_id"].forEach((k) => p.delete(k));
        setParams(p, { replace: true });
    }, [params, setParams]);
    const exportCsv = useMutation({
        mutationFn: () => api("/purchase-orders/export", { method: "POST", body: {} }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const canCreate = !!(can?.manage || can?.request);
    const suggestionsView = id === "suggestions";
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Purchase Orders" }), _jsxs("div", { className: "row", children: [_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 250, children: (close) => _jsxs(_Fragment, { children: [canCreate && _jsxs(Link, { className: "menu-item", to: "/purchase-orders/suggestions", onClick: close, children: [_jsx(Lightbulb, { size: 15 }), "Restock suggestions"] }), can?.export && _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate(); }, children: [_jsx(Download, { size: 15 }), "Export to CSV"] }), _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(FileSpreadsheet, { size: 15 }), "Download Center"] })] }), can?.settings && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs(Link, { className: "menu-item", to: "/settings/purchasing", onClick: close, children: [_jsx(Settings2, { size: 15 }), "Purchasing settings"] })] })] }) }), canCreate && _jsxs(Button, { variant: "primary", onClick: () => setPrefill({}), "aria-label": "New Purchase Order", children: [_jsx(Plus, { size: 16 }), "New"] })] })] }), _jsx("div", { className: "seg po-tabs", role: "tablist", "aria-label": "Status", children: TABS.map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": tab === k, className: "seg-btn" + (tab === k ? " on" : ""), onClick: () => setTab(k), children: l }, k)) }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs("div", { className: "search-in grow", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search number, title, vendor or item", value: search, onChange: (e) => setSearch(e.target.value), "aria-label": "Search purchase orders" })] }), _jsx(VendorFilter, { value: vendorId, onChange: setVendorId })] })] }), _jsx("div", { className: "list", "aria-label": "Purchase orders", children: _jsx(POListView, { status: tab, q: search, vendorId: vendorId, activeId: id }) })] }), _jsx("div", { className: "split-detail", children: suggestionsView ? _jsx(SuggestionsView, {})
                            : id ? _jsx(PODetailView, { id: id }, id)
                                : _jsx(EmptyState, { icon: _jsx(ShoppingCart, { size: 28 }), title: "Select a purchase order", children: "Pick one from the list to see its items, approvals and what's arrived." }) })] }), prefill && _jsx(POForm, { prefill: prefill, onClose: () => setPrefill(null), onSaved: (po) => { setPrefill(null); nav(`/purchase-orders/${po.id}`); } })] }));
}
function VendorFilter({ value, onChange }) {
    const v = useVendorsLite();
    if (!(v.data?.items ?? []).length)
        return null;
    return _jsxs(Select, { "aria-label": "Vendor", value: value, onChange: (e) => onChange(e.target.value), style: { maxWidth: 160 }, children: [_jsx("option", { value: "", children: "All vendors" }), (v.data?.items ?? []).map((x) => _jsx("option", { value: x.id, children: x.name }, x.id))] });
}
function POListView({ status, q, vendorId, activeId }) {
    const [page, setPage] = useState(1);
    const { session } = useSession();
    const qs = useMemo(() => new URLSearchParams(Object.entries({ status, q, vendor_id: vendorId, page: String(page), per_page: "50" }).filter(([, v]) => v)).toString(), [status, q, vendorId, page]);
    useEffect(() => setPage(1), [status, q, vendorId]);
    const list = useQuery({ queryKey: ["pos", qs], queryFn: () => api(`/purchase-orders?${qs}`), placeholderData: (p) => p });
    if (list.isLoading)
        return _jsx(ListSkeleton, {});
    if (list.isError)
        return _jsx(EmptyState, { title: "Couldn't load purchase orders", children: list.error.message });
    const items = list.data?.items ?? [];
    const total = list.data?.total ?? 0;
    if (!items.length)
        return q || vendorId || status ? _jsx(EmptyState, { title: "Nothing here", children: status === "awaiting_me" ? "No purchase orders are waiting for you." : "No purchase orders match." })
            : _jsx(EmptyState, { icon: _jsx(ShoppingCart, { size: 26 }), title: "No purchase orders yet", children: "Order parts and services from your vendors. Press New to start." });
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "small muted", style: { padding: "6px 16px" }, children: [total, " purchase order", total === 1 ? "" : "s"] }), items.map((p) => (_jsxs(Link, { to: `/purchase-orders/${p.id}`, className: "list-row po-row" + (p.id === activeId ? " active" : ""), children: [_jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsxs("span", { className: "row", style: { gap: 6 }, children: [_jsx("span", { className: "mono small faint", children: p.display_number }), _jsx("span", { className: "t grow", children: p.title })] }), _jsx("span", { className: "s", children: [p.vendor?.name, p.due_on && `Due ${new Date(p.due_on + "T00:00").toLocaleDateString()}`, timeAgo(p.created_at)].filter(Boolean).join(" · ") }), _jsx("span", { className: "row", style: { gap: 6, marginTop: 4 }, children: _jsx(POStatusPill, { status: p.status, label: p.status_label, overdue: p.overdue }) })] }), p.total !== null && _jsx("span", { className: "po-row-total", children: currency(p.total, p.currency || session.org?.currency) })] }, p.id))), total > page * 50 && _jsx("div", { className: "card-body", children: _jsx(Button, { size: "sm", onClick: () => setPage(page + 1), children: "Next page" }) }), page > 1 && _jsx("div", { className: "card-body", style: { paddingTop: 0 }, children: _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setPage(page - 1), children: "Previous page" }) })] }));
}
// ---------------------------------------------------------------- restock suggestions (MP-044)
function SuggestionsView() {
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const { session } = useSession();
    const s = useQuery({ queryKey: ["po-suggestions"], queryFn: () => api("/purchase-orders/suggestions") });
    const [picked, setPicked] = useState({});
    const make = useMutation({
        mutationFn: (g) => api("/purchase-orders/from-suggestions", { method: "POST",
            body: { vendor_id: g.vendor_id, part_ids: picked[g.vendor_id ?? ""] ?? g.lines.map((l) => l.part_id) } }),
        onSuccess: (po) => { qc.invalidateQueries({ queryKey: ["po-suggestions"] }); qc.invalidateQueries({ queryKey: ["pos"] }); toast(`Created ${po.display_number}`); nav(`/purchase-orders/${po.id}`); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (s.isLoading)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, {}) });
    if (s.isError)
        return _jsx(EmptyState, { title: "Can't show suggestions", children: s.error.message });
    const groups = s.data?.groups ?? [];
    return (_jsxs("div", { className: "detail", children: [_jsx(Link, { to: "/purchase-orders", className: "small mobile-only", children: "All purchase orders" }), _jsxs("div", { children: [_jsx("h1", { className: "wo-title", children: "Restock suggestions" }), _jsx("p", { className: "muted small", children: "Parts below their minimum, grouped by preferred vendor. Quantities fill each location back to its maximum, minus what's already on order." })] }), groups.length === 0 && _jsx(EmptyState, { icon: _jsx(Lightbulb, { size: 26 }), title: "Nothing to restock", children: "Every part with a minimum has enough in stock or on order." }), groups.map((g) => {
                const key = g.vendor_id ?? "";
                const sel = picked[key] ?? g.lines.map((l) => l.part_id);
                return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: g.vendor_name ?? "No vendor" }), _jsxs(Button, { size: "sm", variant: "primary", disabled: !sel.length || make.isPending, onClick: () => make.mutate(g), children: [_jsx(ShoppingCart, { size: 14 }), "Create PO (", sel.length, ")"] })] }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", {}), _jsx("th", { children: "Part" }), _jsx("th", { children: "Location" }), _jsx("th", { className: "num", children: "In stock" }), _jsx("th", { className: "num", children: "Min / Max" }), _jsx("th", { className: "num", children: "On order" }), _jsx("th", { className: "num", children: "Order" }), _jsx("th", { className: "num", children: "Unit cost" })] }) }), _jsx("tbody", { children: g.lines.map((l) => _jsxs("tr", { children: [_jsx("td", { children: _jsx("input", { type: "checkbox", "aria-label": `Include ${l.name}`, checked: sel.includes(l.part_id), onChange: (e) => setPicked((p) => ({ ...p, [key]: e.target.checked ? [...sel, l.part_id] : sel.filter((x) => x !== l.part_id) })) }) }), _jsxs("td", { children: [_jsx(Link, { to: `/parts/${l.part_id}`, children: l.name }), (l.vendor_part_number || l.part_number) && _jsx("span", { className: "small faint mono", style: { display: "block" }, children: l.vendor_part_number || l.part_number })] }), _jsx("td", { children: l.location_name ?? _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { className: "num", children: fmtQ(l.on_hand) }), _jsxs("td", { className: "num", children: [fmtQ(l.min_qty), " / ", fmtQ(l.max_qty)] }), _jsx("td", { className: "num", children: fmtQ(l.ordered) }), _jsxs("td", { className: "num", children: [_jsx("b", { children: fmtQ(l.quantity) }), " ", _jsx("span", { className: "small faint", children: l.unit })] }), _jsx("td", { className: "num", children: l.unit_cost === null ? "—" : currency(l.unit_cost, session.org?.currency) })] }, l.part_id + (l.location_id ?? ""))) })] }) })] }, key));
            })] }));
}
