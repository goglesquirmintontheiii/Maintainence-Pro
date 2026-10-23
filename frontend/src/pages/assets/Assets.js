import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Assets: tree (list + detail, MaintainX layout) or table, with filters, bulk actions, labels and CSV export.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, ChevronDown, ChevronRight, Download, FileSpreadsheet, ListFilter, ListTree, MoreHorizontal, Plus, Printer, Search, Settings2, Table2, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAssetOptions } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { shortDate } from "../../lib/wo";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { AssetForm } from "./AssetForm";
import { ASSET_TABS, AssetDetailView, StatusModal } from "./AssetDetail";
import { AssetStatusPill } from "./shared";
const EMPTY = { q: "", status: "", criticality: "", location_id: "", type_id: "", warranty: "", label: "" };
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
export function filterQuery(f) {
    const out = {};
    for (const [k, v] of Object.entries(f)) {
        if (!v)
            continue;
        if (k === "warranty" && v === "expiring")
            out.warranty_expiring_days = "60";
        else
            out[k] = v;
    }
    return out;
}
const qsOf = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
export function AssetsPage() {
    const { id, tab } = useParams();
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const nav = useNavigate();
    const { toast } = useToast();
    const [view, setView] = useState(() => (id ? "tree" : load("assets.view", "tree")));
    // Links like /assets?status=offline (from Overview) set the filters; otherwise the last filters are kept.
    const [filters, setFilters] = useState(() => {
        const keys = Object.keys(EMPTY);
        if (!keys.some((k) => params.get(k)) && !params.get("warranty_expiring_days"))
            return load("assets.filters", EMPTY);
        const f = { ...EMPTY };
        for (const k of keys)
            f[k] = params.get(k) ?? "";
        if (params.get("warranty_expiring_days"))
            f.warranty = "expiring";
        return f;
    });
    useEffect(() => {
        const keys = [...Object.keys(EMPTY), "warranty_expiring_days"];
        if (keys.some((k) => params.has(k))) {
            const p = new URLSearchParams(params);
            keys.forEach((k) => p.delete(k));
            setParams(p, { replace: true });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const [creating, setCreating] = useState(params.get("new") === "1");
    const [labels, setLabels] = useState(false);
    useEffect(() => { keep("assets.view", view); }, [view]);
    useEffect(() => { keep("assets.filters", filters); }, [filters]);
    useEffect(() => { if (params.get("new") === "1") {
        setCreating(true);
        const p = new URLSearchParams(params);
        p.delete("new");
        setParams(p, { replace: true });
    } }, [params, setParams]);
    useEffect(() => { if (id && view === "table" && !params.get("open"))
        setView("tree"); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
    const query = useMemo(() => filterQuery(filters), [filters]);
    const filtered = Object.keys(query).length > 0;
    const exportCsv = useMutation({
        mutationFn: () => api("/assets/export", { method: "POST", body: { query } }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const set = (p) => setFilters((f) => ({ ...f, ...p }));
    const openId = params.get("open");
    const closeDrawer = useCallback(() => { const p = new URLSearchParams(params); p.delete("open"); p.delete("otab"); setParams(p); }, [params, setParams]);
    const header = (_jsxs("div", { className: "wo-toolbar" + (view === "tree" ? " compact" : ""), children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Assets" }), _jsxs("div", { className: "row", children: [_jsxs("div", { className: "seg views asset-views", role: "tablist", "aria-label": "View", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": view === "tree", className: "seg-btn" + (view === "tree" ? " on" : ""), onClick: () => setView("tree"), title: "Tree", "aria-label": "Tree", children: _jsx(ListTree, { size: 15 }) }), _jsx("button", { type: "button", role: "tab", "aria-selected": view === "table", className: "seg-btn" + (view === "table" ? " on" : ""), onClick: () => { setView("table"); if (id)
                                            nav("/assets"); }, title: "Table", "aria-label": "Table", children: _jsx(Table2, { size: 15 }) })] }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 250, children: (close) => _jsxs(_Fragment, { children: [can("exports.use") && _jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate(); }, children: [_jsx(Download, { size: 15 }), "Export to CSV", filtered ? " (filtered)" : ""] }), can("exports.use") && _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(FileSpreadsheet, { size: 15 }), "Download Center"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setLabels(true); }, children: [_jsx(Printer, { size: 15 }), "Print QR labels", filtered ? " (filtered)" : " (all)"] }), _jsxs(Link, { className: "menu-item", to: "/settings/assets", onClick: close, children: [_jsx(Settings2, { size: 15 }), "Asset settings"] }), can("assets.packages") && _jsxs(Link, { className: "menu-item", to: "/asset-hub", onClick: close, children: [_jsx(Boxes, { size: 15 }), "Asset Hub"] })] }) }), can("assets.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New Asset", children: [_jsx(Plus, { size: 16 }), _jsx("span", { className: view === "tree" ? "" : "desktop-only", children: view === "tree" ? "New" : "New Asset" })] })] })] }), _jsx(AssetFilterBar, { f: filters, set: set, clear: () => setFilters({ ...EMPTY, q: filters.q }) })] }));
    return (_jsxs("div", { className: "wo-page", children: [view === "tree" ? (_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsx("div", { className: "list-tools wo-list-tools", children: header }), _jsx("div", { className: "list", role: "tree", "aria-label": "Assets", children: filtered ? _jsx(FlatList, { query: query, activeId: id }) : _jsx(Tree, { activeId: id }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(AssetDetailView, { id: id, tab: (ASSET_TABS.some(([k]) => k === tab) ? tab : "details"), onTab: (t) => nav(t === "details" ? `/assets/${id}` : `/assets/${id}/${t}`, { replace: true }) }, id)
                            : _jsxs(EmptyState, { icon: _jsx(Boxes, { size: 28 }), title: "Select an asset", children: ["Pick one from the list to see its details, work orders, downtime and photos.", can("assets.manage") && _jsxs(_Fragment, { children: [_jsx("br", {}), _jsx("span", { className: "small faint", children: "Drag an asset onto another to make it a sub-asset." })] })] }) })] })) : (_jsxs("div", { className: "wo-scroll", children: [header, _jsx(AssetTable, { query: query, onOpen: (aid) => { const p = new URLSearchParams(params); p.set("open", aid); setParams(p); } })] })), openId && view === "table" && _jsx(DrawerDetail, { id: openId, onClose: closeDrawer }), creating && _jsx(AssetForm, { onClose: () => setCreating(false), onSaved: (a) => { setCreating(false); if (view === "tree")
                    nav(`/assets/${a.id}`); } }), labels && _jsx(LabelDialog, { entityType: "asset", query: query, onClose: () => setLabels(false) })] }));
}
function DrawerDetail({ id, onClose }) {
    const [tab, setTab] = useState("details");
    return (_jsx("div", { className: "drawer-wrap", onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("aside", { className: "drawer", style: { width: "min(820px, 100%)" }, role: "dialog", "aria-label": "Asset", children: [_jsxs("div", { className: "drawer-head", children: [_jsx(Link, { to: `/assets/${id}`, className: "small", children: "Open full page" }), _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Close", onClick: onClose, children: _jsx(X, { size: 18 }) })] }), _jsx("div", { className: "drawer-body", children: _jsx(AssetDetailView, { id: id, tab: tab, onTab: setTab }) })] }) }));
}
function AssetFilterBar({ f, set, clear }) {
    const opts = useAssetOptions();
    const active = [f.status, f.criticality, f.location_id, f.type_id, f.warranty, f.label].filter(Boolean).length;
    const [open, setOpen] = useState(false); // phone: filters fold away behind a Filter button (MP-126)
    return (_jsxs("div", { className: "stack asset-filterbar" + (open ? " open" : ""), style: { gap: 8 }, children: [_jsxs("div", { className: "row", style: { gap: 8 }, children: [_jsxs("div", { className: "search-in grow", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search name, serial, model or barcode", value: f.q, onChange: (e) => set({ q: e.target.value }), "aria-label": "Search assets" })] }), _jsxs(Button, { icon: true, className: "mobile-only wo-phone-btn" + (open || active ? " on" : ""), "aria-expanded": open, "aria-label": active ? `Filter (${active} on)` : "Filter", onClick: () => setOpen((o) => !o), children: [_jsx(ListFilter, { size: 20 }), active > 0 && _jsx("span", { className: "wo-phone-count", children: active })] })] }), _jsxs("div", { className: "asset-filters", children: [_jsxs(Select, { "aria-label": "Status", value: f.status, onChange: (e) => set({ status: e.target.value }), children: [_jsx("option", { value: "", children: "Any status" }), (opts.data?.statuses ?? []).map((s) => _jsx("option", { value: s.id, children: s.label }, s.id))] }), _jsxs(Select, { "aria-label": "Criticality", value: f.criticality, onChange: (e) => set({ criticality: e.target.value }), children: [_jsx("option", { value: "", children: "Any criticality" }), (opts.data?.criticality ?? []).filter((c) => c.id).map((c) => _jsx("option", { value: c.id, children: c.label }, c.id)), _jsx("option", { value: "none", children: "None set" })] }), _jsxs(Select, { "aria-label": "Asset type", value: f.type_id, onChange: (e) => set({ type_id: e.target.value }), children: [_jsx("option", { value: "", children: "Any type" }), (opts.data?.types ?? []).map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] }), _jsxs(Select, { "aria-label": "Warranty", value: f.warranty, onChange: (e) => set({ warranty: e.target.value }), children: [_jsx("option", { value: "", children: "Any warranty" }), _jsx("option", { value: "active", children: "Under warranty" }), _jsx("option", { value: "expiring", children: "Ends within 60 days" }), _jsx("option", { value: "expired", children: "Warranty ended" })] }), _jsx("div", { className: "asset-filter-loc", children: _jsx(LocationPicker, { value: f.location_id || null, onChange: (v) => set({ location_id: v ?? "" }), placeholder: "Any location" }) }), _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: f.label === "none", onChange: (e) => set({ label: e.target.checked ? "none" : "" }) }), _jsx("span", { children: "Without a label" })] }), active > 0 && _jsx("button", { type: "button", className: "linkbtn small", onClick: clear, children: "Clear filters" })] })] }));
}
// ---------------------------------------------------------------- tree
function useReparent() {
    const qc = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: ({ id, parent }) => api(`/assets/${id}`, { method: "PATCH", body: { parent_id: parent } }),
        onSuccess: (_, v) => {
            qc.invalidateQueries({ queryKey: ["asset-tree"] });
            qc.invalidateQueries({ queryKey: ["asset"] });
            qc.invalidateQueries({ queryKey: ["assets"] });
            toast(v.parent ? `Moved ${v.name}` : `${v.name} is now a top-level asset`);
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
}
function Tree({ activeId }) {
    const roots = useQuery({ queryKey: ["asset-tree", "root"], queryFn: () => api("/assets?parent_id=root&per_page=500&sort=name") });
    const reparent = useReparent();
    const { can } = useSession();
    const [over, setOver] = useState(false);
    if (roots.isLoading)
        return _jsx(ListSkeleton, {});
    const items = roots.data?.items ?? [];
    if (!items.length)
        return _jsx(EmptyState, { icon: _jsx(Boxes, { size: 26 }), title: "No assets yet", children: can("assets.manage") ? "Add your equipment, machines and buildings systems. Press New to start." : "Assets your team adds show here." });
    return (_jsxs(_Fragment, { children: [items.map((a) => _jsx(TreeNode, { a: a, depth: 0, activeId: activeId, onDrop: (src, name) => reparent.mutate({ id: src, parent: a.id, name }) }, a.id)), can("assets.manage") && _jsx("div", { className: "tree-drop-root small" + (over ? " over" : ""), onDragOver: (e) => { e.preventDefault(); setOver(true); }, onDragLeave: () => setOver(false), onDrop: (e) => {
                    e.preventDefault();
                    setOver(false);
                    const src = e.dataTransfer.getData("text/mpro-asset");
                    const name = e.dataTransfer.getData("text/mpro-asset-name");
                    if (src)
                        reparent.mutate({ id: src, parent: null, name });
                }, children: "Drop here to make an asset top level" })] }));
}
function TreeNode({ a, depth, activeId, onDrop }) {
    const [open, setOpen] = useState(false);
    const [over, setOver] = useState(false);
    const { can } = useSession();
    const reparent = useReparent();
    const kids = useQuery({ queryKey: ["asset-tree", a.id], queryFn: () => api(`/assets?parent_id=${a.id}&per_page=500&sort=name`), enabled: open && a.child_count > 0 });
    const dnd = can("assets.manage");
    return (_jsxs("div", { role: "treeitem", "aria-expanded": a.child_count ? open : undefined, "aria-selected": a.id === activeId, children: [_jsxs("div", { className: "tree-row" + (a.id === activeId ? " active" : "") + (over ? " drop-over" : ""), style: { paddingLeft: 8 + depth * 18 }, draggable: dnd, onDragStart: (e) => { e.dataTransfer.setData("text/mpro-asset", a.id); e.dataTransfer.setData("text/mpro-asset-name", a.name); e.dataTransfer.effectAllowed = "move"; }, onDragOver: (e) => { if (dnd && e.dataTransfer.types.includes("text/mpro-asset")) {
                    e.preventDefault();
                    setOver(true);
                } }, onDragLeave: () => setOver(false), onDrop: (e) => { e.preventDefault(); setOver(false); const src = e.dataTransfer.getData("text/mpro-asset"); if (src && src !== a.id)
                    onDrop(src, e.dataTransfer.getData("text/mpro-asset-name")); }, children: [a.child_count > 0 ? _jsx("button", { type: "button", className: "tree-tog", "aria-label": open ? `Collapse ${a.name}` : `Expand ${a.name}`, onClick: () => setOpen((o) => !o), children: open ? _jsx(ChevronDown, { size: 15 }) : _jsx(ChevronRight, { size: 15 }) }) : _jsx("span", { className: "tree-tog" }), _jsx(AssetRowBody, { a: a })] }), open && (kids.isLoading ? _jsx("div", { style: { paddingLeft: 30 + depth * 18 }, children: _jsx(ListSkeleton, { rows: 1 }) })
                : (kids.data?.items ?? []).map((c) => _jsx(TreeNode, { a: c, depth: depth + 1, activeId: activeId, onDrop: (src, name) => reparent.mutate({ id: src, parent: c.id, name }) }, c.id)))] }));
}
function AssetRowBody({ a, showPath }) {
    return (_jsxs(Link, { to: `/assets/${a.id}`, className: "tree-link", children: [a.thumb_url ? _jsx("img", { className: "asset-thumb", src: a.thumb_url, alt: "", loading: "lazy" }) : _jsx("span", { className: "asset-thumb ph", "aria-hidden": "true", children: _jsx(Boxes, { size: 15 }) }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsxs("span", { className: "t row", style: { gap: 6 }, children: [_jsx("span", { className: "astat-dot " + a.status, "aria-label": a.status_label }), a.name] }), _jsx("span", { className: "s", children: [showPath && a.path.length ? a.path.map((p) => p.name).join(" › ") : "", a.location?.name, a.child_count ? `${a.child_count} sub-asset${a.child_count === 1 ? "" : "s"}` : ""]
                            .filter(Boolean).join(" · ") || " " })] }), a.open_work_orders > 0 && _jsx("span", { className: "wo-count", title: `${a.open_work_orders} open work orders`, children: a.open_work_orders })] }));
}
function FlatList({ query, activeId }) {
    const q = useQuery({ queryKey: ["assets", "flat", query], queryFn: () => api(`/assets?per_page=200&sort=name&${qsOf(query)}`), placeholderData: (p) => p });
    if (q.isLoading)
        return _jsx(ListSkeleton, {});
    const items = q.data?.items ?? [];
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "small muted", style: { padding: "6px 16px" }, children: [q.data?.total ?? 0, " matching asset", q.data?.total === 1 ? "" : "s"] }), items.length === 0 ? _jsx(EmptyState, { title: "No assets match", children: "Try clearing filters." })
                : items.map((a) => _jsx("div", { className: "tree-row" + (a.id === activeId ? " active" : ""), style: { paddingLeft: 12 }, children: _jsx(AssetRowBody, { a: a, showPath: true }) }, a.id))] }));
}
const COLS = [
    { id: "name", label: "Name", sort: "name", cell: (a) => _jsxs("span", { className: "row", style: { gap: 8 }, children: [a.thumb_url ? _jsx("img", { className: "asset-thumb sm", src: a.thumb_url, alt: "", loading: "lazy" }) : null, _jsxs("span", { children: [_jsx("span", { className: "t", children: a.name }), a.path.length > 0 && _jsx("span", { className: "small faint", style: { display: "block" }, children: a.path.map((p) => p.name).join(" › ") })] })] }) },
    { id: "status", label: "Status", sort: "status", cell: (a) => _jsx(AssetStatusPill, { status: a.status, reason: a.status_reason }) },
    { id: "location", label: "Location", cell: (a) => a.location?.name ?? _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "criticality", label: "Criticality", sort: "criticality", cell: (a) => a.criticality_label || _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "types", label: "Types", cell: (a) => a.types.length ? _jsx("span", { className: "row wrap", style: { gap: 4 }, children: a.types.map((t) => _jsxs("span", { className: "chip", children: [_jsx("span", { className: "sw lg", style: { background: t.color } }), t.name] }, t.id)) }) : _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "manufacturer", label: "Manufacturer / model", sort: "manufacturer", cell: (a) => [a.manufacturer, a.model].filter(Boolean).join(" ") || _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "serial", label: "Serial", cell: (a) => a.serial_number ? _jsx("span", { className: "mono", children: a.serial_number }) : _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "warranty", label: "Warranty end", sort: "warranty_end", cell: (a) => a.warranty_end ? _jsx("span", { className: a.warranty_active ? "" : "faint", children: shortDate(a.warranty_end) }) : _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "open", label: "Open WOs", cell: (a) => a.open_work_orders || _jsx("span", { className: "faint", children: "0" }) },
    { id: "updated", label: "Updated", sort: "updated_at", cell: (a) => _jsx("span", { className: "small", children: timeAgo(a.updated_at) }) },
];
function AssetTable({ query, onOpen }) {
    const [sort, setSort] = useState(() => load("assets.table.sort", "name"));
    const [page, setPage] = useState(1);
    const [sel, setSel] = useState([]);
    const [showDeleted, setShowDeleted] = useState(false);
    const { can } = useSession();
    useEffect(() => { keep("assets.table.sort", sort); }, [sort]);
    useEffect(() => { setPage(1); setSel([]); }, [query, sort, showDeleted]);
    const qs = `sort=${sort}&per_page=50&page=${page}${showDeleted ? "&include_deleted=1" : ""}&${qsOf(query)}`;
    const data = useQuery({ queryKey: ["assets", "table", qs], queryFn: () => api(`/assets?${qs}`), placeholderData: (p) => p });
    const items = data.data?.items ?? [];
    const total = data.data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / 50));
    const toggle = (c) => { if (c.sort)
        setSort(sort === c.sort ? `-${c.sort}` : c.sort); };
    return (_jsxs("div", { className: "wo-table card", children: [_jsxs("div", { className: "card-head wrap", children: [_jsxs("span", { className: "small muted", children: [total, " asset", total === 1 ? "" : "s"] }), can("assets.delete") && _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: showDeleted, onChange: (e) => setShowDeleted(e.target.checked) }), _jsx("span", { children: "Show deleted" })] })] }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table asset-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { width: 36 }, children: _jsx(Checkbox, { checked: items.length > 0 && sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((a) => a.id) : []), label: _jsx("span", { className: "sr-only", children: "Select all" }) }) }), COLS.map((c) => _jsx("th", { "aria-sort": c.sort && sort.replace("-", "") === c.sort ? (sort.startsWith("-") ? "descending" : "ascending") : undefined, children: _jsxs("button", { type: "button", className: "th-btn", disabled: !c.sort, onClick: () => toggle(c), children: [c.label, c.sort && sort.replace("-", "") === c.sort && (sort.startsWith("-") ? _jsx(ArrowDown, { size: 12 }) : _jsx(ArrowUp, { size: 12 }))] }) }, c.id))] }) }), _jsxs("tbody", { children: [data.isLoading && _jsx("tr", { children: _jsx("td", { colSpan: COLS.length + 1, children: _jsx(ListSkeleton, { rows: 4 }) }) }), !data.isLoading && items.length === 0 && _jsx("tr", { children: _jsx("td", { colSpan: COLS.length + 1, children: _jsx(EmptyState, { title: "No assets match", children: "Try clearing filters." }) }) }), items.map((a) => (_jsxs("tr", { className: "clickable" + (a.deleted ? " deleted" : ""), onClick: () => onOpen(a.id), tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter")
                                        onOpen(a.id); }, children: [_jsx("td", { onClick: (e) => e.stopPropagation(), children: _jsx(Checkbox, { checked: sel.includes(a.id), onChange: (c) => setSel((s) => (c ? [...s, a.id] : s.filter((x) => x !== a.id))), label: _jsxs("span", { className: "sr-only", children: ["Select ", a.name] }) }) }), COLS.map((c) => _jsx("td", { children: c.cell(a) }, c.id))] }, a.id)))] })] }) }), pages > 1 && _jsxs("div", { className: "card-head", style: { borderTop: "1px solid var(--c-border-soft)", borderBottom: 0 }, children: [_jsxs("span", { className: "small muted", children: ["Page ", page, " of ", pages] }), _jsxs("div", { className: "row", children: [_jsx(Button, { size: "sm", disabled: page <= 1, onClick: () => setPage(page - 1), children: "Previous" }), _jsx(Button, { size: "sm", disabled: page >= pages, onClick: () => setPage(page + 1), children: "Next" })] })] }), sel.length > 0 && _jsx(AssetBulkBar, { ids: sel, items: items, onDone: () => setSel([]) })] }));
}
function AssetBulkBar({ ids, items, onDone }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [mode, setMode] = useState(null);
    const chosen = items.filter((a) => ids.includes(a.id));
    const refresh = () => { qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["asset-tree"] }); qc.invalidateQueries({ queryKey: ["asset"] }); };
    const del = useMutation({
        mutationFn: () => api("/assets/bulk", { method: "POST", body: { ids, action: "delete" } }),
        onSuccess: (r) => { refresh(); setMode(null); onDone(); toast(r.failed.length ? `Deleted ${r.done.length}. ${r.failed[0].name}: ${r.failed[0].message}` : `Deleted ${r.done.length} asset${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" }); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsxs("div", { className: "bulkbar", role: "toolbar", "aria-label": "Bulk actions", children: [_jsxs("b", { className: "small", children: [ids.length, " selected"] }), _jsx("span", { className: "grow" }), can("assets.manage") && _jsx(Button, { size: "sm", onClick: () => setMode("edit"), children: "Edit" }), can("assets.status") && _jsx(Button, { size: "sm", onClick: () => setMode("status"), children: "Change status" }), _jsxs(Button, { size: "sm", onClick: () => setMode("labels"), children: [_jsx(Printer, { size: 14 }), "Print labels"] }), can("assets.delete") && _jsxs(Button, { size: "sm", variant: "danger", onClick: () => setMode("delete"), children: [_jsx(Trash2, { size: 14 }), "Delete"] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: onDone, children: "Clear" }), mode === "edit" && _jsx(BulkEdit, { ids: ids, onClose: () => setMode(null), onDone: () => { refresh(); setMode(null); onDone(); } }), mode === "status" && _jsx(StatusModal, { assets: chosen, onClose: () => setMode(null), onDone: () => { refresh(); setMode(null); onDone(); } }), mode === "labels" && _jsx(LabelDialog, { entityType: "asset", ids: ids, onClose: () => { setMode(null); refresh(); } }), mode === "delete" && _jsx(Modal, { title: `Delete ${ids.length} asset${ids.length === 1 ? "" : "s"}?`, onClose: () => setMode(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setMode(null), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsx("p", { children: "Assets with sub-assets are skipped. Deleted assets can be restored by an administrator." }) })] }));
}
function BulkEdit({ ids, onClose, onDone }) {
    const opts = useAssetOptions();
    const { toast } = useToast();
    const [on, setOn] = useState({});
    const [location, setLocation] = useState(null);
    const [parent, setParent] = useState([]);
    const [crit, setCrit] = useState("");
    const [types, setTypes] = useState([]);
    const [err, setErr] = useState("");
    const patch = () => {
        const p = {};
        if (on.location)
            p.location_id = location;
        if (on.parent)
            p.parent_id = parent[0] ?? null;
        if (on.criticality)
            p.criticality = crit;
        if (on.types)
            p.types = types;
        return p;
    };
    const m = useMutation({
        mutationFn: () => api("/assets/bulk", { method: "POST", body: { ids, action: "edit", patch: patch() } }),
        onSuccess: (r) => { toast(r.failed.length ? `Updated ${r.done.length}. ${r.failed[0].name}: ${r.failed[0].message}` : `Updated ${r.done.length} asset${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" }); onDone(); },
        onError: (e) => setErr(e.message),
    });
    const row = (k, label, control) => (_jsxs("div", { className: "bulk-edit-row", children: [_jsx(Checkbox, { checked: !!on[k], onChange: (c) => setOn((o) => ({ ...o, [k]: c })), label: label }), on[k] && _jsx("div", { className: "grow", children: control })] }));
    return (_jsxs(Modal, { title: `Edit ${ids.length} asset${ids.length === 1 ? "" : "s"}`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !Object.values(on).some(Boolean) || m.isPending, onClick: () => m.mutate(), children: "Apply" })] }), children: [_jsx("p", { className: "small muted", children: "Tick what to change. Everything else stays as it is." }), row("location", "Location", _jsx(LocationPicker, { value: location, onChange: setLocation, placeholder: "No location" })), row("parent", "Parent asset", _jsx(AssetPicker, { value: parent, onChange: setParent, exclude: ids, placeholder: "None (top level)" })), row("criticality", "Criticality", _jsx(Select, { "aria-label": "Criticality", value: crit, onChange: (e) => setCrit(e.target.value), children: (opts.data?.criticality ?? []).map((c) => _jsx("option", { value: c.id, children: c.label }, c.id)) })), row("types", "Asset types", _jsx(MultiPicker, { label: "Asset types", placeholder: "No types", value: types, onChange: setTypes, options: (opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: _jsx("span", { className: "sw lg", style: { background: t.color } }) })) })), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
