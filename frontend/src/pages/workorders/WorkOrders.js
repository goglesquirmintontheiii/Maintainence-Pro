import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Work Orders: To Do (list + detail), Table, Calendar, Workload and Board views sharing one filter bar.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckSquare, ClipboardList, Columns3, Download, FileSpreadsheet, LayoutList, ListFilter, MessageSquare, MoreHorizontal, Plus, Search, Table2, Users } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dueLabel, filtersParam, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { AvatarStack, Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { FilterBar } from "./FilterBar";
import { WorkOrderDetail } from "./Detail";
import { WorkOrderForm } from "./Form";
import { BoardView, CalendarView, TableView, WorkloadView } from "./Views";
import { BulkBar } from "./Bulk";
import "../../styles/viewer.css";
import { SplitDivider, useSplitWidth } from "../../components/SplitDivider";
import { QuickTemplates } from "../../components/QuickTemplates";
import { UpcomingList } from "./Upcoming";
const VIEWS = [
    { id: "todo", label: "To Do", icon: LayoutList }, { id: "table", label: "Table", icon: Table2 }, { id: "calendar", label: "Calendar", icon: CalendarDays },
    { id: "workload", label: "Workload", icon: Users }, { id: "board", label: "Board", icon: Columns3 },
];
const SCOPES = [["all", "All work orders"], ["assigned_me", "Assigned to me"], ["my_teams", "Assigned to my teams"], ["created_me", "Created by me"]];
const SORTS = [["-priority", "Priority"], ["due_at", "Due date"], ["-created_at", "Newest"], ["created_at", "Oldest"], ["-updated_at", "Recently updated"], ["-number", "Number"]];
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
export function WorkOrdersPage() {
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const opts = useWOOptions();
    const nav = useNavigate();
    // A direct link to one work order (/work-orders/:id) always opens it in the To Do split.
    const view = params.get("view") || (id ? "todo" : load("wo.view", "todo"));
    const [filters, setFilters] = useState(() => load("wo.filters", []));
    const [activeView, setActiveView] = useState(() => load("wo.savedview", null));
    const [q, setQ] = useState("");
    const [creating, setCreating] = useState(params.get("new") === "1");
    const [exporting, setExporting] = useState(false);
    const [phoneFilters, setPhoneFilters] = useState(false);
    useEffect(() => { keep("wo.filters", filters); }, [filters]);
    useEffect(() => { keep("wo.savedview", activeView); }, [activeView]);
    useEffect(() => { keep("wo.view", view); }, [view]);
    // ?new=1 opens the form; &asset= / &location= / &template= prefill it (links from asset, location and scan pages)
    const readPrefill = () => {
        const a = params.get("asset"), l = params.get("location"), t = params.get("template");
        return a || l || t ? { ...(a ? { asset_id: a } : {}), ...(l ? { location_id: l } : {}), ...(t ? { template_id: t } : {}) } : undefined;
    };
    const [prefill, setPrefill] = useState(readPrefill);
    useEffect(() => {
        if (params.get("new") === "1") {
            const p = readPrefill();
            if (p)
                setPrefill(p);
            setCreating(true);
            ["new", "asset", "location", "template"].forEach((k) => params.delete(k));
            setParams(params, { replace: true });
        }
    }, [params, setParams]);
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay, .drawer-wrap"))
                return;
            if (e.key === "c" && !e.metaKey && !e.ctrlKey && can("wo.create")) {
                e.preventDefault();
                setCreating(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [can]);
    const setView = (v) => { const p = new URLSearchParams(params); p.set("view", v); setParams(p); if (id && v !== "todo")
        nav(`/work-orders?view=${v}&open=${id}`); };
    const openId = params.get("open");
    const closeDrawer = useCallback(() => { const p = new URLSearchParams(params); p.delete("open"); setParams(p); }, [params, setParams]);
    const openWO = (wid) => { const p = new URLSearchParams(params); p.set("open", wid); setParams(p); };
    const query = { filters, q };
    const compact = view === "todo";
    const viewSeg = (_jsx("div", { className: "seg views", role: "tablist", "aria-label": "View", children: VIEWS.map((v) => {
            const Icon = v.icon;
            return (_jsxs("button", { type: "button", role: "tab", "aria-selected": view === v.id, "aria-label": v.label, className: "seg-btn" + (view === v.id ? " on" : ""), onClick: () => setView(v.id), title: v.label, children: [_jsx(Icon, { size: 15 }), !compact && _jsx("span", { className: "desktop-only", children: v.label })] }, v.id));
        }) }));
    const more = (_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 240, children: (close) => _jsxs(_Fragment, { children: [can("exports.use") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setExporting(true); }, children: [_jsx(Download, { size: 15 }), "Export\u2026"] }), can("exports.use") && _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(FileSpreadsheet, { size: 15 }), "Download Center"] }), can("wo.settings") && _jsxs(Link, { className: "menu-item", to: "/settings/work-orders", onClick: close, children: [_jsx(ClipboardList, { size: 15 }), "Work order settings"] })] }) }));
    const newBtn = can("wo.create") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New Work Order", children: [_jsx(Plus, { size: 16 }), _jsx("span", { className: compact ? "" : "desktop-only", children: compact ? "New" : "New Work Order" })] });
    // Phone (MP-126): Calendar button – Search – Filter, MaintainX style; the full toolbar is for wider screens.
    const onCal = view === "calendar";
    const phoneHead = (_jsxs("div", { className: "wo-phone-head", children: [_jsx(Button, { icon: true, className: "wo-phone-btn" + (onCal ? " on" : ""), "aria-pressed": onCal, "aria-label": onCal ? "Back to the list" : "Calendar", onClick: () => setView(onCal ? "todo" : "calendar"), children: onCal ? _jsx(LayoutList, { size: 20 }) : _jsx(CalendarDays, { size: 20 }) }), _jsxs("div", { className: "search-in grow", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search work orders", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search work orders" })] }), _jsxs(Button, { icon: true, className: "wo-phone-btn" + (phoneFilters || filters.length ? " on" : ""), "aria-expanded": phoneFilters, "aria-label": filters.length ? `Filter (${filters.length} on)` : "Filter", onClick: () => setPhoneFilters((o) => !o), children: [_jsx(ListFilter, { size: 20 }), filters.length > 0 && _jsx("span", { className: "wo-phone-count", children: filters.length })] })] }));
    const header = (_jsxs("div", { className: "wo-toolbar" + (compact ? " compact" : "") + (phoneFilters ? " phone-filters" : ""), children: [phoneHead, _jsxs("div", { className: "row wo-wide-head", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Work Orders" }), _jsxs("div", { className: "row", children: [viewSeg, more, _jsx(QuickTemplates, { compact: compact }), newBtn] })] }), _jsxs("div", { className: "row wrap wo-search-row", children: [_jsxs("div", { className: "search-in wo-wide-head", style: { minWidth: 220, flex: "0 1 300px" }, children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search title, description or #number", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search work orders" })] }), _jsx(FilterBar, { filters: filters, onChange: setFilters, options: opts.data, activeView: activeView, onViewChange: setActiveView })] })] }));
    return (_jsxs("div", { className: "wo-page", children: [view === "todo" ? _jsx(ToDoView, { id: id, header: header, query: query }) : (_jsxs("div", { className: "wo-scroll", children: [header, view === "table" && _jsx(TableView, { query: query, onOpen: openWO }), view === "calendar" && _jsx(CalendarView, { query: query, onOpen: openWO }), view === "workload" && _jsx(WorkloadView, { query: query, onOpen: openWO }), view === "board" && _jsx(BoardView, { query: query, onOpen: openWO })] })), openId && view !== "todo" && (_jsx("div", { className: "drawer-wrap", onMouseDown: (e) => { if (e.target === e.currentTarget)
                    closeDrawer(); }, children: _jsx("aside", { className: "drawer", style: { width: "min(760px, 100%)" }, role: "dialog", "aria-label": "Work order", children: _jsx("div", { className: "drawer-body", style: { padding: 0 }, children: _jsx(WorkOrderDetail, { id: openId, inDrawer: true, onClose: closeDrawer }) }) }) })), creating && _jsx(WorkOrderForm, { init: prefill, onClose: () => { setCreating(false); setPrefill(undefined); }, onSaved: view === "todo" ? undefined : (wo) => openWO(wo.id) }), exporting && _jsx(ExportDialog, { query: query, onClose: () => setExporting(false) })] }));
}
export function useWOList(qs, enabled = true) {
    return useInfiniteQuery({
        queryKey: ["work-orders", qs],
        queryFn: ({ pageParam }) => api(`/work-orders?${qs}&page=${pageParam}`),
        initialPageParam: 1,
        getNextPageParam: (last) => (last.page * last.per_page < last.total ? last.page + 1 : undefined),
        placeholderData: (p) => p, enabled,
    });
}
function ToDoView({ id, header, query }) {
    const [tab, setTab] = useState(() => load("wo.tab", "todo"));
    const [scope, setScope] = useState(() => load("wo.scope", "all"));
    const [sort, setSort] = useState(() => load("wo.sort", "-priority"));
    const [selecting, setSelecting] = useState(false);
    const [sel, setSel] = useState([]);
    const { session } = useSession();
    const nav = useNavigate();
    useEffect(() => { keep("wo.tab", tab); keep("wo.scope", scope); keep("wo.sort", sort); }, [tab, scope, sort]);
    const qs = `tab=${tab}&scope=${scope}&sort=${tab === "done" && sort === "-priority" ? "-completed_at" : sort}&per_page=40&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}`;
    const upcoming = tab === "upcoming";
    const list = useWOList(qs, !upcoming);
    const items = upcoming ? [] : list.data?.pages.flatMap((p) => p.items) ?? [];
    const total = list.data?.pages[0]?.total;
    const listRef = useRef(null);
    useEffect(() => { setSel([]); }, [qs]);
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay, .drawer-wrap"))
                return;
            if (e.key !== "j" && e.key !== "k")
                return;
            const i = items.findIndex((w) => w.id === id);
            const next = items[e.key === "j" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
            if (next) {
                e.preventDefault();
                nav(`/work-orders/${next.id}`);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [items, id, nav]);
    useEffect(() => { listRef.current?.querySelector(".list-row.active")?.scrollIntoView({ block: "nearest" }); }, [id]);
    const split = useSplitWidth("wo.todo.width", { min: 340, max: 960 });
    return (_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), style: split.width ? { "--wo-list-w": `${split.width}px` } : undefined, children: [_jsxs("div", { className: "split-list", children: [_jsx(SplitDivider, { width: split.width, onChange: split.set, min: split.min, max: split.max, label: "Resize work order list" }), _jsxs("div", { className: "list-tools wo-list-tools", children: [header, _jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("div", { className: "tabs", role: "tablist", style: { border: 0 }, children: [_jsx("button", { type: "button", role: "tab", className: "tab", "aria-selected": tab === "todo", onClick: () => setTab("todo"), children: "To Do" }), _jsx("button", { type: "button", role: "tab", className: "tab", "aria-selected": tab === "done", onClick: () => setTab("done"), children: "Done" }), _jsx("button", { type: "button", role: "tab", className: "tab", "aria-selected": upcoming, onClick: () => { setTab("upcoming"); setSelecting(false); }, children: "Upcoming" })] }), !upcoming && _jsxs(Button, { size: "sm", variant: selecting ? "primary" : "ghost", onClick: () => { setSelecting((s) => !s); setSel([]); }, "aria-pressed": selecting, children: [_jsx(CheckSquare, { size: 14 }), "Select"] })] }), _jsxs("div", { className: "row", children: [_jsx(Select, { value: scope, onChange: (e) => setScope(e.target.value), "aria-label": "Show", children: SCOPES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }), !upcoming && _jsx(Select, { value: sort, onChange: (e) => setSort(e.target.value), "aria-label": "Sort by", style: { width: 170 }, children: SORTS.map(([k, l]) => _jsxs("option", { value: k, children: ["Sort: ", l] }, k)) })] }), !upcoming && _jsxs("div", { className: "row small muted", style: { justifyContent: "space-between" }, children: [_jsx("span", { children: total === undefined ? " " : `${total} work order${total === 1 ? "" : "s"}` }), selecting && items.length > 0 && _jsx(Checkbox, { checked: sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((w) => w.id) : []), label: "Select all" })] })] }), _jsxs("div", { className: "list", role: "list", ref: listRef, children: [upcoming ? _jsx(UpcomingList, { id: id, scope: scope, query: query, tz: session.org?.timezone }) : list.isLoading ? _jsx(ListSkeleton, {}) : items.length === 0 ? (_jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 26 }), title: tab === "todo" ? "Nothing to do" : "Nothing done yet", children: query.filters.length || query.q || scope !== "all" ? "No work orders match. Try clearing filters." : tab === "todo" ? "Create a work order to get started. Press C anytime." : "Completed and canceled work orders show here." })) : items.map((w) => _jsx(WORow, { w: w, active: w.id === id, tz: session.org?.timezone, selecting: selecting, selected: sel.includes(w.id), onSelect: (c) => setSel((s) => (c ? [...s, w.id] : s.filter((x) => x !== w.id))) }, w.id)), !upcoming && list.hasNextPage && _jsx("div", { style: { padding: 12, textAlign: "center" }, children: _jsx(Button, { size: "sm", onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: list.isFetchingNextPage ? "Loading…" : "Load more" }) })] }), sel.length > 0 && _jsx(BulkBar, { ids: sel, items: items, onDone: () => setSel([]) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(WorkOrderDetail, { id: id }, id) : _jsxs(EmptyState, { icon: _jsx(ClipboardList, { size: 28 }), title: "Select a work order", children: ["Pick one from the list to see its details, comments and time.", _jsx("br", {}), _jsxs("span", { className: "small faint", children: ["Shortcuts: ", _jsx("span", { className: "kbd", children: "C" }), " create \u00B7 ", _jsx("span", { className: "kbd", children: "J" }), "/", _jsx("span", { className: "kbd", children: "K" }), " move \u00B7 ", _jsx("span", { className: "kbd", children: "E" }), " edit \u00B7 ", _jsx("span", { className: "kbd", children: "?" }), " all shortcuts"] })] }) })] }));
}
export function WORow({ w, active, tz, selecting, selected, onSelect, onClick }) {
    const due = dueLabel(w.due_at, w.overdue, tz);
    const inner = (_jsxs(_Fragment, { children: [selecting && _jsx("span", { onClick: (e) => e.stopPropagation(), children: _jsx(Checkbox, { checked: !!selected, onChange: (c) => onSelect?.(c), label: _jsxs("span", { className: "sr-only", children: ["Select #", w.number] }) }) }), w.cover_url && _jsx("img", { className: "wo-cover", src: w.cover_url, alt: "", loading: "lazy", decoding: "async" }), _jsxs("div", { className: "grow wo-row-main", children: [_jsxs("div", { className: "row", style: { gap: 6 }, children: [w.unread && _jsx("span", { className: "unread-dot", "aria-label": "Unread" }), _jsx("span", { className: "t", children: w.title })] }), _jsxs("div", { className: "s row", style: { gap: 8 }, children: [_jsxs("span", { className: "mono", children: ["#", w.number] }), due && _jsx("span", { className: "due " + due.tone, children: due.text }), w.categories.slice(0, 2).map((c) => _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "sw", style: { background: c.color } }), c.name] }, c.id)), (w.comment_count ?? 0) > 0 && _jsxs("span", { className: "row", style: { gap: 3 }, children: [_jsx(MessageSquare, { size: 12 }), w.comment_count] }), w.sub_work_orders && _jsxs("span", { children: [w.sub_work_orders.closed, "/", w.sub_work_orders.total, " sub"] })] })] }), _jsxs("div", { className: "wo-row-side", children: [_jsx(StatusPill, { status: w.status }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(PriorityBadge, { priority: w.priority }), w.assignees.length > 0 && _jsx(AvatarStack, { people: w.assignees.map((a) => ({ name: a.name, initials: a.initials ?? a.name.slice(0, 2).toUpperCase() })), max: 3 })] })] })] }));
    const cls = "list-row wo-row" + (active ? " active" : "") + (w.unread ? " unread" : "") + (w.deleted ? " deleted" : "");
    if (onClick)
        return _jsx("div", { className: cls, role: "listitem", tabIndex: 0, onClick: onClick, onKeyDown: (e) => { if (e.key === "Enter")
                onClick(); }, children: inner });
    return _jsx(Link, { to: `/work-orders/${w.id}`, className: cls, role: "listitem", children: inner });
}
// ---------------------------------------------------------------- export
export function ExportDialog({ query, onClose, ids }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const nav = useNavigate();
    const [format, setFormat] = useState("csv");
    const m = useMutation({
        mutationFn: () => api("/work-orders/export", { method: "POST", body: { format, ids, query: { q: query.q, filters: query.filters } } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["exports"] }); onClose(); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsxs(Modal, { title: "Export work orders", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", onClick: () => m.mutate(), disabled: m.isPending, children: [_jsx(Download, { size: 15 }), "Export"] })] }), children: [_jsxs("p", { className: "muted", children: [ids ? `${ids.length} selected work orders.` : "Everything that matches your current search and filters, in any status (To Do and Done).", " Exports go to the Download Center and are kept for 14 days."] }), _jsxs("div", { className: "seg", role: "radiogroup", "aria-label": "Format", children: [_jsx("button", { type: "button", role: "radio", "aria-checked": format === "csv", className: "seg-btn" + (format === "csv" ? " on" : ""), onClick: () => setFormat("csv"), children: "CSV spreadsheet" }), _jsx("button", { type: "button", role: "radio", "aria-checked": format === "pdf", className: "seg-btn" + (format === "pdf" ? " on" : ""), onClick: () => setFormat("pdf"), children: "PDF (one per page)" })] })] }));
}
