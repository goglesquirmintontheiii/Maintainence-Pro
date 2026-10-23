import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Parts & Inventory (0.5.0, MP-039–041): list + detail (MaintainX layout) or table with per-location rows,
// filters, saved filter presets, exports, labels. /parts/cycle-counts and /parts/transactions are sub-pages.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bookmark, ClipboardCheck, Download, FileSpreadsheet, History, List, MoreHorizontal, Package, Plus, Printer, Search, Settings2, Table2, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { PartDetailView, PART_TABS } from "./PartDetail";
import { PartForm } from "./PartForm";
import { CycleCountsPage } from "./CycleCounts";
import { TransactionsPage } from "./Transactions";
import { qsOf, qty, usePartOptions } from "./types";
import "./parts.css";
const EMPTY = { q: "", stock: "", type_id: "", location_id: "", critical: "", non_stock: "" };
function load(k, d) { try {
    const v = sessionStorage.getItem(k);
    return v ? JSON.parse(v) : d;
}
catch {
    return d;
} }
function keep(k, v) { try {
    sessionStorage.setItem(k, JSON.stringify(v));
}
catch { /* private mode */ } }
export function PartsPage() {
    const { id, tab } = useParams();
    if (id === "cycle-counts")
        return _jsx(CycleCountsPage, { runId: tab });
    if (id === "transactions")
        return _jsx(TransactionsPage, {});
    return _jsx(PartsMain, { id: id, tab: tab });
}
function PartsMain({ id, tab }) {
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const nav = useNavigate();
    const { toast } = useToast();
    const [view, setView] = useState(() => (id ? "list" : load("parts.view", "list")));
    const [filters, setFilters] = useState(() => {
        const keys = Object.keys(EMPTY);
        if (!keys.some((k) => params.get(k)))
            return load("parts.filters", EMPTY);
        const f = { ...EMPTY };
        for (const k of keys)
            f[k] = params.get(k) ?? "";
        return f;
    });
    useEffect(() => {
        const keys = Object.keys(EMPTY);
        if (keys.some((k) => params.has(k))) {
            const p = new URLSearchParams(params);
            keys.forEach((k) => p.delete(k));
            setParams(p, { replace: true });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const [creating, setCreating] = useState(params.get("new") === "1");
    const [labels, setLabels] = useState(false);
    useEffect(() => { keep("parts.view", view); }, [view]);
    useEffect(() => { keep("parts.filters", filters); }, [filters]);
    useEffect(() => { if (params.get("new") === "1") {
        setCreating(true);
        const p = new URLSearchParams(params);
        p.delete("new");
        setParams(p, { replace: true });
    } }, [params, setParams]);
    const query = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters]);
    const filtered = Object.keys(query).length > 0;
    const exportCsv = useMutation({
        mutationFn: (report) => api("/parts/export", { method: "POST", body: { report, query: report === "transactions" ? {} : query } }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const set = (p) => setFilters((f) => ({ ...f, ...p }));
    const header = (_jsxs("div", { className: "wo-toolbar" + (view === "list" ? " compact" : ""), children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Parts" }), _jsxs("div", { className: "row", children: [_jsxs("div", { className: "seg views", role: "tablist", "aria-label": "View", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": view === "list", className: "seg-btn" + (view === "list" ? " on" : ""), onClick: () => setView("list"), title: "List", "aria-label": "List", children: _jsx(List, { size: 15 }) }), _jsx("button", { type: "button", role: "tab", "aria-selected": view === "table", className: "seg-btn" + (view === "table" ? " on" : ""), onClick: () => { setView("table"); if (id)
                                            nav("/parts"); }, title: "Table", "aria-label": "Table", children: _jsx(Table2, { size: 15 }) })] }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 260, children: (close) => _jsxs(_Fragment, { children: [_jsxs(Link, { className: "menu-item", to: "/parts/transactions", onClick: close, children: [_jsx(History, { size: 15 }), "Transactions log"] }), _jsxs(Link, { className: "menu-item", to: "/parts/cycle-counts", onClick: close, children: [_jsx(ClipboardCheck, { size: 15 }), "Cycle counts"] }), can("exports.use") && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate("parts"); }, children: [_jsx(Download, { size: 15 }), "Export parts", filtered ? " (filtered)" : ""] }), can("costs.view") && _jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate("valuation"); }, children: [_jsx(Download, { size: 15 }), "Inventory valuation"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate("slow_moving"); }, children: [_jsx(Download, { size: 15 }), "Slow-moving parts"] }), _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(FileSpreadsheet, { size: 15 }), "Download Center"] })] }), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setLabels(true); }, children: [_jsx(Printer, { size: 15 }), "Print QR labels", filtered ? " (filtered)" : ""] }), _jsxs(Link, { className: "menu-item", to: "/settings/parts", onClick: close, children: [_jsx(Settings2, { size: 15 }), "Parts settings"] })] }) }), can("parts.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New Part", children: [_jsx(Plus, { size: 16 }), _jsx("span", { className: view === "list" ? "" : "desktop-only", children: view === "list" ? "New" : "New Part" })] })] })] }), _jsx(FilterBar, { f: filters, set: set, replace: setFilters, clear: () => setFilters({ ...EMPTY, q: filters.q }) })] }));
    return (_jsxs("div", { className: "wo-page", children: [view === "list" ? (_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsx("div", { className: "list-tools wo-list-tools", children: header }), _jsx("div", { className: "list", "aria-label": "Parts", children: _jsx(PartList, { query: query, activeId: id }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(PartDetailView, { id: id, tab: (PART_TABS.some(([k]) => k === tab) ? tab : "details"), onTab: (t) => nav(t === "details" ? `/parts/${id}` : `/parts/${id}/${t}`, { replace: true }) }, id)
                            : _jsx(EmptyState, { icon: _jsx(Package, { size: 28 }), title: "Select a part", children: "Pick one from the list to see its stock, where it's kept and where it was used." }) })] })) : (_jsxs("div", { className: "wo-scroll", children: [header, _jsx(PartTable, { query: query })] })), creating && _jsx(PartForm, { onClose: () => setCreating(false), onSaved: (p) => { setCreating(false); nav(`/parts/${p.id}`); } }), labels && _jsx(LabelDialog, { entityType: "part", ids: undefined, query: query, onClose: () => setLabels(false) })] }));
}
// ---------------------------------------------------------------- filters and presets (r226)
function FilterBar({ f, set, replace, clear }) {
    const opts = usePartOptions();
    const active = [f.stock, f.type_id, f.location_id, f.critical, f.non_stock].filter(Boolean).length;
    return (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs("div", { className: "search-in grow", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search name, part number, barcode or vendor", value: f.q, onChange: (e) => set({ q: e.target.value }), "aria-label": "Search parts" })] }), _jsx(Presets, { f: f, apply: replace })] }), _jsxs("div", { className: "asset-filters part-filters", children: [_jsx("div", { className: "seg part-stock-seg", role: "radiogroup", "aria-label": "Stock", children: [["", "All"], ["needs_restock", "Needs restock"], ["out_of_stock", "Out of stock"], ["in_stock", "In stock"]].map(([k, l]) => _jsx("button", { type: "button", role: "radio", "aria-checked": f.stock === k, className: "seg-btn" + (f.stock === k ? " on" : ""), onClick: () => set({ stock: k }), children: l }, k)) }), _jsxs(Select, { "aria-label": "Part type", value: f.type_id, onChange: (e) => set({ type_id: e.target.value }), children: [_jsx("option", { value: "", children: "Any type" }), (opts.data?.types ?? []).map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] }), _jsx("div", { className: "asset-filter-loc", children: _jsx(LocationPicker, { value: f.location_id || null, onChange: (v) => set({ location_id: v ?? "" }), placeholder: "Any location" }) }), _jsxs(Select, { "aria-label": "Stocked", value: f.non_stock, onChange: (e) => set({ non_stock: e.target.value }), children: [_jsx("option", { value: "", children: "Stock and non-stock" }), _jsx("option", { value: "0", children: "Stocked parts" }), _jsx("option", { value: "1", children: "Non-stock parts" })] }), _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: f.critical === "1", onChange: (e) => set({ critical: e.target.checked ? "1" : "" }) }), _jsx("span", { children: "Critical only" })] }), active > 0 && _jsx("button", { type: "button", className: "linkbtn small", onClick: clear, children: "Clear filters" })] })] }));
}
function Presets({ f, apply }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const { can } = useSession();
    const q = useQuery({ queryKey: ["part-presets"], queryFn: () => api("/parts/presets") });
    const [saving, setSaving] = useState(false);
    const del = useMutation({ mutationFn: (p) => api(`/parts/presets/${p.id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["part-presets"] }),
        onError: (e) => toast(e.message, { kind: "error" }) });
    const items = q.data?.items ?? [];
    return (_jsxs(_Fragment, { children: [_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "Saved filters", title: "Saved filters", onClick: t, children: _jsx(Bookmark, { size: 16 }) }), width: 260, children: (close) => _jsxs(_Fragment, { children: [items.length === 0 && _jsx("div", { className: "menu-item small faint", style: { cursor: "default" }, children: "No saved filters yet" }), items.map((p) => _jsxs("div", { className: "row part-preset", children: [_jsxs("button", { className: "menu-item grow", onClick: () => { close(); apply({ ...EMPTY, ...p.filters }); }, children: [p.name, p.shared && _jsx("span", { className: "small faint", children: " \u00B7 shared" })] }), (!p.shared || can("parts.settings")) && _jsx("button", { type: "button", className: "chip-x", "aria-label": `Delete ${p.name}`, onClick: () => del.mutate(p), children: _jsx(Trash2, { size: 13 }) })] }, p.id)), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setSaving(true); }, children: [_jsx(Plus, { size: 15 }), "Save current filters"] })] }) }), saving && _jsx(SavePreset, { f: f, onClose: () => setSaving(false) })] }));
}
function SavePreset({ f, onClose }) {
    const qc = useQueryClient();
    const { can } = useSession();
    const [name, setName] = useState("");
    const [shared, setShared] = useState(false);
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => api("/parts/presets", { method: "POST", body: { name, shared, filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["part-presets"] }); onClose(); },
        onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: "Save filters", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Input, { "aria-label": "Name", autoFocus: true, value: name, maxLength: 80, onChange: (e) => setName(e.target.value), placeholder: "e.g. Warehouse restock" }), can("parts.settings") && _jsx(Checkbox, { checked: shared, onChange: setShared, label: "Share with everyone" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
// ---------------------------------------------------------------- list
export function StockBadge({ p }) {
    if (p.non_stock)
        return _jsx("span", { className: "part-stock ns", children: "Non-stock" });
    const cls = p.negative ? "neg" : p.out_of_stock ? "out" : p.needs_restock ? "low" : "ok";
    return _jsx("span", { className: "part-stock " + cls, title: p.needs_restock ? "Needs restock" : undefined, children: qty(p.on_hand, p.unit) });
}
function PartRowBody({ p }) {
    return (_jsxs(Link, { to: `/parts/${p.id}`, className: "tree-link", children: [p.thumb_url ? _jsx("img", { className: "asset-thumb", src: p.thumb_url, alt: "", loading: "lazy" }) : _jsx("span", { className: "asset-thumb ph", "aria-hidden": "true", children: _jsx(Package, { size: 15 }) }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("span", { className: "t", children: p.name }), _jsx("span", { className: "s", children: [p.part_number, p.types.map((t) => t.name).join(", "), p.needs_restock ? "Needs restock" : ""].filter(Boolean).join(" · ") || " " })] }), _jsx(StockBadge, { p: p })] }));
}
function PartList({ query, activeId }) {
    const [page, setPage] = useState(1);
    useEffect(() => setPage(1), [query]);
    const q = useQuery({ queryKey: ["parts", "list", query, page], queryFn: () => api(`/parts?per_page=100&page=${page}&sort=name&${qsOf(query)}`), placeholderData: (p) => p });
    const { can } = useSession();
    if (q.isLoading)
        return _jsx(ListSkeleton, {});
    const items = q.data?.items ?? [];
    const total = q.data?.total ?? 0;
    if (!items.length)
        return Object.keys(query).length ? _jsx(EmptyState, { title: "No parts match", children: "Try clearing filters." })
            : _jsx(EmptyState, { icon: _jsx(Package, { size: 26 }), title: "No parts yet", children: can("parts.manage") ? "Add the spare parts and supplies you keep. Press New to start." : "Parts your team adds show here." });
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "small muted", style: { padding: "6px 16px" }, children: [total, " part", total === 1 ? "" : "s"] }), items.map((p) => _jsx("div", { className: "tree-row" + (p.id === activeId ? " active" : ""), style: { paddingLeft: 12 }, children: _jsx(PartRowBody, { p: p }) }, p.id)), total > page * 100 && _jsx("div", { className: "card-body", children: _jsx(Button, { size: "sm", onClick: () => setPage(page + 1), children: "Next page" }) }), page > 1 && _jsx("div", { className: "card-body", style: { paddingTop: 0 }, children: _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setPage(page - 1), children: "Previous page" }) })] }));
}
// ---------------------------------------------------------------- table (with "Show per location", r218)
const SORTS = { name: "name", part_number: "part_number", on_hand: "on_hand", unit_cost: "unit_cost", updated: "updated_at" };
function PartTable({ query }) {
    const [sort, setSort] = useState(() => load("parts.table.sort", "name"));
    const [page, setPage] = useState(1);
    const [perLoc, setPerLoc] = useState(() => load("parts.table.perloc", false));
    const [showDeleted, setShowDeleted] = useState(false);
    const { can } = useSession();
    const nav = useNavigate();
    useEffect(() => { keep("parts.table.sort", sort); keep("parts.table.perloc", perLoc); }, [sort, perLoc]);
    useEffect(() => { setPage(1); }, [query, sort, showDeleted]);
    const qs = `sort=${sort}&per_page=50&page=${page}${perLoc ? "&per_location=1" : ""}${showDeleted ? "&include_deleted=1" : ""}&${qsOf(query)}`;
    const data = useQuery({ queryKey: ["parts", "table", qs], queryFn: () => api(`/parts?${qs}`), placeholderData: (p) => p });
    const items = data.data?.items ?? [];
    const total = data.data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / 50));
    const costs = can("costs.view");
    const th = (label, key) => {
        const s = key ? SORTS[key] : undefined;
        return _jsx("th", { "aria-sort": s && sort.replace("-", "") === s ? (sort.startsWith("-") ? "descending" : "ascending") : undefined, children: _jsxs("button", { type: "button", className: "th-btn", disabled: !s, onClick: () => s && setSort(sort === s ? `-${s}` : s), children: [label, s && sort.replace("-", "") === s && (sort.startsWith("-") ? _jsx(ArrowDown, { size: 12 }) : _jsx(ArrowUp, { size: 12 }))] }) });
    };
    return (_jsxs("div", { className: "wo-table card", children: [_jsxs("div", { className: "card-head wrap", children: [_jsxs("span", { className: "small muted", children: [total, " part", total === 1 ? "" : "s"] }), _jsxs("span", { className: "row", style: { gap: 12 }, children: [_jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: perLoc, onChange: (e) => setPerLoc(e.target.checked) }), _jsx("span", { children: "Show per location" })] }), can("parts.delete") && _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: showDeleted, onChange: (e) => setShowDeleted(e.target.checked) }), _jsx("span", { children: "Show deleted" })] })] })] }), _jsx("div", { className: "table-wrap", children: perLoc ? (_jsxs("table", { className: "table part-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Part" }), _jsx("th", { children: "Location" }), _jsx("th", { children: "Area" }), _jsx("th", { className: "num", children: "In stock" }), _jsx("th", { className: "num", children: "Reserved" }), _jsx("th", { className: "num", children: "Available" }), _jsx("th", { className: "num", children: "Min" }), _jsx("th", { className: "num", children: "Max" })] }) }), _jsxs("tbody", { children: [(data.data?.per_location ?? []).map((r) => (_jsxs("tr", { className: "clickable", onClick: () => nav(`/parts/${r.part.id}`), children: [_jsxs("td", { children: [_jsx("span", { className: "t", children: r.part.name }), r.part.part_number && _jsx("span", { className: "small faint", style: { display: "block" }, children: r.part.part_number })] }), _jsx("td", { children: r.location?.name ?? _jsx("span", { className: "faint", children: "No location" }) }), _jsx("td", { children: r.area || _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { className: "num" + (r.negative ? " part-neg" : r.needs_restock ? " part-low" : ""), children: r.on_hand }), _jsx("td", { className: "num", children: r.reserved }), _jsx("td", { className: "num", children: r.available }), _jsx("td", { className: "num", children: r.min_qty ?? "—" }), _jsx("td", { className: "num", children: r.max_qty ?? "—" })] }, r.id))), !data.isLoading && !(data.data?.per_location ?? []).length && _jsx("tr", { children: _jsx("td", { colSpan: 8, children: _jsx(EmptyState, { title: "No stock rows", children: "These parts aren't stocked at a location yet." }) }) })] })] })) : (_jsxs("table", { className: "table part-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [th("Name", "name"), th("Part number", "part_number"), _jsx("th", { children: "Types" }), th("In stock", "on_hand"), _jsx("th", { className: "num", children: "Available" }), _jsx("th", { className: "num", children: "Min / Max" }), costs && th("Unit cost", "unit_cost"), th("Updated", "updated")] }) }), _jsxs("tbody", { children: [data.isLoading && _jsx("tr", { children: _jsx("td", { colSpan: 8, children: _jsx(ListSkeleton, { rows: 4 }) }) }), !data.isLoading && items.length === 0 && _jsx("tr", { children: _jsx("td", { colSpan: 8, children: _jsx(EmptyState, { title: "No parts match", children: "Try clearing filters." }) }) }), items.map((p) => (_jsxs("tr", { className: "clickable" + (p.deleted ? " deleted" : ""), onClick: () => nav(`/parts/${p.id}`), tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter")
                                        nav(`/parts/${p.id}`); }, children: [_jsx("td", { children: _jsxs("span", { className: "row", style: { gap: 8 }, children: [p.thumb_url ? _jsx("img", { className: "asset-thumb sm", src: p.thumb_url, alt: "", loading: "lazy" }) : null, _jsx("span", { className: "t", children: p.name })] }) }), _jsx("td", { className: "mono", children: p.part_number || _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { children: p.types.length ? _jsx("span", { className: "row wrap", style: { gap: 4 }, children: p.types.map((t) => _jsxs("span", { className: "chip", children: [_jsx("span", { className: "sw lg", style: { background: t.color } }), t.name] }, t.id)) }) : _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { children: _jsx(StockBadge, { p: p }) }), _jsx("td", { className: "num", children: p.non_stock ? "—" : p.available }), _jsxs("td", { className: "num", children: [p.min_qty ?? "—", " / ", p.max_qty ?? "—"] }), costs && _jsx("td", { className: "num", children: p.unit_cost ?? "—" }), _jsx("td", { children: _jsx("span", { className: "small", children: timeAgo(p.updated_at) }) })] }, p.id)))] })] })) }), pages > 1 && _jsxs("div", { className: "card-head", style: { borderTop: "1px solid var(--c-border-soft)", borderBottom: 0 }, children: [_jsxs("span", { className: "small muted", children: ["Page ", page, " of ", pages] }), _jsxs("div", { className: "row", children: [_jsx(Button, { size: "sm", disabled: page <= 1, onClick: () => setPage(page - 1), children: "Previous" }), _jsx(Button, { size: "sm", disabled: page >= pages, onClick: () => setPage(page + 1), children: "Next" })] })] })] }));
}
export function CloseX({ onClick }) {
    return _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Close", onClick: onClick, children: _jsx(X, { size: 18 }) });
}
