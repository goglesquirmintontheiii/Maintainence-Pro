import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Table, Calendar, Workload and Board views.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, GripVertical, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, dateTime } from "../../lib/format";
import { addDays, filtersParam, fmtMinutes, shortDate, startOfDay, STATUS_LABEL, useWOOptions, WORK_TYPE_LABEL, ymd } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Checkbox, Dropdown, EmptyState, ListSkeleton, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { AssigneeChips, CategoryChips } from "../../components/pickers";
import { BulkBar } from "./Bulk";
import "../../styles/viewer.css";
import { PeriodBar } from "../../components/PeriodBar";
function pref(k, d) { try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
}
catch {
    return d;
} }
function setPref(k, v) { try {
    localStorage.setItem(k, JSON.stringify(v));
}
catch { /* ignore */ } }
function usePatchWO() {
    const qc = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: ({ id, body }) => api(`/work-orders/${id}`, { method: "PATCH", body }),
        onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["wo-workload"] }); qc.invalidateQueries({ queryKey: ["work-order", v.id] }); },
        onError: (e) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast(e.message, { kind: "error" }); },
    });
}
const BASE_COLS = [
    { id: "cover", label: "Picture", cell: (w) => (w.cover_url ? _jsx("img", { className: "wo-cover sm", src: w.cover_url, alt: "", loading: "lazy", decoding: "async" }) : _jsx("span", { className: "wo-cover sm", "aria-hidden": true })) },
    { id: "number", label: "ID", sort: "number", cell: (w) => _jsxs("span", { className: "mono", children: ["#", w.number] }) },
    { id: "title", label: "Title", sort: "title", cell: (w) => _jsxs("span", { className: "t", children: [w.unread && _jsx("span", { className: "unread-dot" }), " ", w.title] }) },
    { id: "parent", label: "Parent", cell: (w) => (w.parent ? _jsxs("span", { title: w.parent.title, children: [_jsxs("span", { className: "mono", children: ["#", w.parent.number] }), " ", w.parent.title] }) : _jsx("span", { className: "faint", children: "\u2014" })) },
    { id: "status", label: "Status", sort: "status", cell: (w) => _jsx(StatusPill, { status: w.status, sub: w.sub_status }) },
    { id: "priority", label: "Priority", sort: "priority", cell: (w) => _jsx(PriorityBadge, { priority: w.priority }) },
    { id: "assignees", label: "Assigned to", cell: (w) => _jsx(AssigneeChips, { items: w.assignees, max: 2 }) },
    { id: "due_at", label: "Due date", sort: "due_at", cell: (w, tz) => w.due_at ? _jsx("span", { className: w.overdue ? "due danger" : "", children: shortDate(w.due_at, tz) }) : _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "start_at", label: "Start date", sort: "start_at", cell: (w, tz) => w.start_at ? shortDate(w.start_at, tz) : _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "categories", label: "Categories", cell: (w) => _jsx(CategoryChips, { items: w.categories }) },
    { id: "work_type", label: "Work type", cell: (w) => WORK_TYPE_LABEL[w.work_type] },
    { id: "asset", label: "Asset", cell: (w) => {
            const list = w.assets?.length ? w.assets : w.asset ? [w.asset] : [];
            if (!list.length)
                return _jsx("span", { className: "faint", children: "\u2014" });
            return _jsxs("span", { className: "row", style: { gap: 6 }, title: list.map((a) => a.name).join(", "), children: [_jsx("span", { className: "astat-dot " + list[0].status }), list[0].name, list.length > 1 && _jsxs("span", { className: "small faint", children: ["+", list.length - 1] })] });
        } },
    { id: "location", label: "Location", cell: (w) => w.location?.name ?? _jsx("span", { className: "faint", children: "\u2014" }) },
    { id: "estimated", label: "Estimated", sort: "estimated_minutes", num: true, cell: (w) => (w.estimated_minutes ? fmtMinutes(w.estimated_minutes) : _jsx("span", { className: "faint", children: "\u2014" })) },
    { id: "created_by", label: "Created by", cell: (w) => w.created_by?.name ?? "—" },
    { id: "created_at", label: "Created", sort: "created_at", cell: (w, tz) => dateTime(w.created_at, tz) },
    { id: "updated_at", label: "Updated", sort: "updated_at", cell: (w, tz) => dateTime(w.updated_at, tz) },
    { id: "completed_at", label: "Completed", sort: "completed_at", cell: (w, tz) => (w.completed_at ? dateTime(w.completed_at, tz) : _jsx("span", { className: "faint", children: "\u2014" })) },
];
const DEFAULT_COLS = ["cover", "number", "title", "status", "priority", "assignees", "due_at", "categories"];
export function TableView({ query, onOpen }) {
    const { session, can } = useSession();
    const opts = useWOOptions();
    const [cols, setCols] = useState(() => pref("wo.table.cols", DEFAULT_COLS));
    const [sort, setSort] = useState(() => pref("wo.table.sort", "-number"));
    const [perPage, setPerPage] = useState(() => pref("wo.table.pp", 50));
    const [page, setPage] = useState(1);
    const [showDeleted, setShowDeleted] = useState(false);
    const [showUpcoming, setShowUpcoming] = useState(true);
    const [sel, setSel] = useState([]);
    const [dragCol, setDragCol] = useState(null);
    useEffect(() => { setPref("wo.table.cols", cols); setPref("wo.table.sort", sort); setPref("wo.table.pp", perPage); }, [cols, sort, perPage]);
    const all = useMemo(() => [...BASE_COLS, ...(opts.data?.custom_fields ?? []).map((f) => ({ id: `cf:${f.id}`, label: f.name,
            cell: (w) => { const v = w.custom[f.id]; return v === undefined || v === "" ? _jsx("span", { className: "faint", children: "\u2014" }) : f.type === "checkbox" ? (v ? "Yes" : "No") : f.type === "currency" ? currency(v, session.org?.currency) : String(v); } }))], [opts.data, session.org?.currency]);
    const shown = cols.map((c) => all.find((x) => x.id === c)).filter(Boolean);
    const qs = `sort=${sort}&per_page=${perPage}&page=${page}&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}${showDeleted ? "&include_deleted=1" : ""}${showUpcoming ? "" : "&tab=todo"}`;
    useEffect(() => { setPage(1); setSel([]); }, [query.q, query.filters, sort, perPage, showDeleted, showUpcoming]);
    const data = useQuery({ queryKey: ["work-orders", "table", qs], queryFn: () => api(`/work-orders?${qs}`), placeholderData: (p) => p });
    const items = data.data?.items ?? [];
    const total = data.data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const toggleSort = (c) => { if (!c.sort)
        return; setSort(sort === c.sort ? `-${c.sort}` : sort === `-${c.sort}` ? c.sort : c.id === "number" ? `-${c.sort}` : c.sort); };
    const moveCol = (from, to) => { if (from === to)
        return; const next = cols.filter((c) => c !== from); next.splice(next.indexOf(to), 0, from); setCols(next); };
    return (_jsxs("div", { className: "wo-table card", children: [_jsxs("div", { className: "card-head", style: { flexWrap: "wrap" }, children: [_jsxs("span", { className: "small muted", children: [total, " work order", total === 1 ? "" : "s"] }), _jsxs("div", { className: "row wrap", children: [_jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: showUpcoming, onChange: (e) => setShowUpcoming(e.target.checked) }), _jsx("span", { children: "Show upcoming and done" })] }), can("wo.delete") && _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: showDeleted, onChange: (e) => setShowDeleted(e.target.checked) }), _jsx("span", { children: "Show deleted" })] }), _jsx(Dropdown, { width: 250, trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(Columns3, { size: 14 }), "Columns"] }), children: () => _jsxs("div", { style: { maxHeight: 360, overflowY: "auto", padding: 6 }, children: [all.map((c) => _jsx("div", { style: { padding: "3px 4px" }, children: _jsx(Checkbox, { checked: cols.includes(c.id), disabled: c.id === "title", label: c.label, onChange: (v) => setCols(v ? [...cols, c.id] : cols.filter((x) => x !== c.id)) }) }, c.id)), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => setCols(DEFAULT_COLS), children: [_jsx(RotateCcw, { size: 14 }), "Restore defaults"] })] }) })] })] }), _jsxs("div", { className: "table-wrap", children: [_jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { width: 34 }, children: _jsx(Checkbox, { checked: items.length > 0 && sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((w) => w.id) : []), label: _jsx("span", { className: "sr-only", children: "Select all" }) }) }), shown.map((c) => (_jsx("th", { draggable: true, onDragStart: () => setDragCol(c.id), onDragOver: (e) => e.preventDefault(), onDrop: () => { if (dragCol)
                                                moveCol(dragCol, c.id); setDragCol(null); }, className: (c.sort ? "sortable" : "") + (c.num ? " num" : ""), "aria-sort": sort === c.sort ? "ascending" : sort === `-${c.sort}` ? "descending" : undefined, children: _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx(GripVertical, { size: 12, className: "faint grip" }), _jsx("button", { type: "button", className: "th-btn", onClick: () => toggleSort(c), disabled: !c.sort, children: c.label }), sort === c.sort && _jsx(ArrowUp, { size: 12 }), sort === `-${c.sort}` && _jsx(ArrowDown, { size: 12 })] }) }, c.id)))] }) }), _jsxs("tbody", { children: [data.isLoading && _jsx("tr", { children: _jsx("td", { colSpan: shown.length + 1, children: _jsx(ListSkeleton, { rows: 4 }) }) }), items.map((w) => (_jsxs("tr", { className: "clickable" + (w.deleted ? " deleted" : ""), onClick: () => onOpen(w.id), children: [_jsx("td", { onClick: (e) => e.stopPropagation(), children: _jsx(Checkbox, { checked: sel.includes(w.id), onChange: (c) => setSel(c ? [...sel, w.id] : sel.filter((x) => x !== w.id)), label: _jsxs("span", { className: "sr-only", children: ["Select #", w.number] }) }) }), shown.map((c) => _jsx("td", { className: c.num ? "num" : "", children: c.cell(w, session.org?.timezone) }, c.id))] }, w.id)))] })] }), !data.isLoading && items.length === 0 && _jsx(EmptyState, { title: "No work orders match", children: "Try different filters." })] }), _jsxs("div", { className: "card-body row", style: { justifyContent: "space-between", paddingTop: 10, paddingBottom: 10 }, children: [_jsx(Select, { value: perPage, onChange: (e) => setPerPage(Number(e.target.value)), "aria-label": "Results per page", style: { width: 150 }, children: [25, 50, 100, 200].map((n) => _jsxs("option", { value: n, children: [n, " per page"] }, n)) }), _jsxs("div", { className: "row", children: [_jsx(Button, { size: "sm", icon: true, "aria-label": "Previous page", disabled: page <= 1, onClick: () => setPage(page - 1), children: _jsx(ChevronLeft, { size: 16 }) }), _jsxs("span", { className: "small", children: ["Page ", page, " of ", pages] }), _jsx(Button, { size: "sm", icon: true, "aria-label": "Next page", disabled: page >= pages, onClick: () => setPage(page + 1), children: _jsx(ChevronRight, { size: 16 }) })] })] }), sel.length > 0 && _jsx(BulkBar, { ids: sel, items: items, onDone: () => setSel([]) })] }));
}
// ---------------------------------------------------------------- calendar
export function CalendarView({ query, onOpen }) {
    const { session } = useSession();
    const tz = session.org?.timezone;
    const [mode, setMode] = useState(() => pref("wo.cal.mode", "month"));
    const [weekStart, setWeekStart] = useState(() => pref("mpro.weekStart", 0));
    const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
    const [dragId, setDragId] = useState(null);
    const patch = usePatchWO();
    useEffect(() => { setPref("wo.cal.mode", mode); setPref("mpro.weekStart", weekStart); }, [mode, weekStart]);
    const { from, days } = useMemo(() => {
        if (mode === "week") {
            const s = addDays(anchor, -((anchor.getDay() - weekStart + 7) % 7));
            return { from: s, days: 7 };
        }
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        const s = addDays(first, -((first.getDay() - weekStart + 7) % 7));
        return { from: s, days: 42 };
    }, [mode, anchor, weekStart]);
    const to = addDays(from, days);
    const f = [...query.filters, { field: "due_at", op: "between", value: [ymd(from), ymd(addDays(to, -1))] }, { field: "status", op: "not_in", value: ["canceled"] }];
    const qs = `per_page=500&sort=due_at&q=${encodeURIComponent(query.q)}${filtersParam(f)}`;
    const data = useQuery({ queryKey: ["work-orders", "cal", qs], queryFn: () => api(`/work-orders?${qs}`), placeholderData: (p) => p });
    const byDay = useMemo(() => {
        const m = {};
        for (const w of data.data?.items ?? [])
            if (w.due_at)
                (m[ymd(new Date(w.due_at))] ??= []).push(w);
        return m;
    }, [data.data]);
    const move = (dir) => setAnchor(mode === "week" ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    const drop = (day) => {
        const w = data.data?.items.find((x) => x.id === dragId);
        setDragId(null);
        if (!w || !w.due_at)
            return;
        const old = new Date(w.due_at);
        const nd = new Date(day);
        nd.setHours(old.getHours(), old.getMinutes(), 0, 0);
        if (ymd(nd) === ymd(old))
            return;
        const body = { due_at: nd.toISOString(), version: w.version };
        if (w.start_at && new Date(w.start_at) > nd)
            body.start_at = null;
        patch.mutate({ id: w.id, body });
    };
    const title = mode === "month" ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
        : `${shortDate(from.toISOString())} – ${shortDate(addDays(from, 6).toISOString())}`;
    const today = ymd(new Date());
    const heads = Array.from({ length: 7 }, (_, i) => addDays(from, i).toLocaleDateString(undefined, { weekday: "short" }));
    return (_jsxs("div", { className: "card cal", children: [_jsx(PeriodBar, { label: title, onToday: () => setAnchor(startOfDay(new Date())), onMove: move, rangeLabel: "Calendar range", range: mode, ranges: [{ id: "month", label: "Month" }, { id: "week", label: "Week" }], onRange: setMode, children: _jsxs(Select, { value: weekStart, onChange: (e) => setWeekStart(Number(e.target.value)), "aria-label": "First day of week", style: { height: 30 }, children: [_jsx("option", { value: 0, children: "Sunday first" }), _jsx("option", { value: 1, children: "Monday first" })] }) }), _jsxs("div", { className: "cal-grid " + mode, children: [heads.map((h) => _jsx("div", { className: "cal-head", children: h }, h)), Array.from({ length: days }, (_, i) => {
                        const d = addDays(from, i), key = ymd(d), list = byDay[key] ?? [];
                        const other = mode === "month" && d.getMonth() !== anchor.getMonth();
                        const max = mode === "month" ? 3 : 30;
                        return (_jsxs("div", { className: "cal-day" + (other ? " other" : "") + (key === today ? " today" : "") + (dragId ? " droppable" : ""), onDragOver: (e) => e.preventDefault(), onDrop: () => drop(d), children: [_jsx("div", { className: "cal-num", children: d.getDate() }), list.slice(0, max).map((w) => (_jsxs("button", { type: "button", draggable: true, onDragStart: () => setDragId(w.id), onClick: () => onOpen(w.id), className: "cal-ev " + w.status + (w.overdue ? " overdue" : ""), title: `#${w.number} ${w.title}\n${STATUS_LABEL[w.status]} · ${dateTime(w.due_at, tz)}${w.assignees.length ? "\n" + w.assignees.map((a) => a.name).join(", ") : ""}`, children: [_jsx("span", { className: "dot" }), mode === "week" && _jsx("span", { className: "faint", children: new Date(w.due_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }) }), _jsx("span", { className: "cal-t", children: w.title })] }, w.id))), list.length > max && _jsxs("button", { type: "button", className: "linkbtn small", onClick: () => { setMode("week"); setAnchor(d); }, children: ["+", list.length - max, " more"] })] }, key));
                    })] }), _jsxs("div", { className: "card-body small faint row", style: { gap: 14, paddingTop: 10, paddingBottom: 10 }, children: [_jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "legend open" }), "Open"] }), _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "legend in_progress" }), "In progress"] }), _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "legend on_hold" }), "On hold"] }), _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "legend done" }), "Done"] }), _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx("span", { className: "legend overdue" }), "Overdue"] }), _jsx("span", { className: "grow" }), "Drag a work order to another day to reschedule it."] })] }));
}
// ---------------------------------------------------------------- workload
export function WorkloadView({ query, onOpen }) {
    const opts = useWOOptions();
    const [start, setStart] = useState(() => { const d = startOfDay(new Date()); return addDays(d, -((d.getDay() + 6) % 7)); });
    const [days, setDays] = useState(7);
    const [team, setTeam] = useState("");
    const [drag, setDrag] = useState(null);
    const patch = usePatchWO();
    const qc = useQueryClient();
    const fq = `&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}`;
    const data = useQuery({ queryKey: ["wo-workload", ymd(start), days, team, fq], queryFn: () => api(`/work-orders/workload?start=${ymd(start)}&days=${days}${team ? `&team=${team}` : ""}${fq}`), placeholderData: (p) => p });
    const w = data.data;
    const drop = async (toUser, day) => {
        if (!drag)
            return;
        const d = drag;
        setDrag(null);
        try {
            const wo = await qc.fetchQuery({ queryKey: ["work-order", d.id], queryFn: () => api(`/work-orders/${d.id}?mark_read=0`), staleTime: 0 });
            const cur = wo.assignees.map((a) => `${a.type}:${a.id}`);
            let next = cur;
            if (toUser && d.from !== toUser)
                next = [...cur.filter((x) => x !== `user:${d.from}`), `user:${toUser}`].filter((x, i, a) => a.indexOf(x) === i);
            const old = wo.due_at ? new Date(wo.due_at) : new Date();
            const nd = new Date(`${day}T00:00`);
            nd.setHours(old.getHours(), old.getMinutes());
            patch.mutate({ id: d.id, body: { assignees: next, due_at: nd.toISOString(), version: wo.version } });
        }
        catch { /* toast in mutation */ }
    };
    const cap = w?.capacity_minutes ?? 480;
    const cell = (userKey, day, c) => (_jsxs("td", { className: "wl-cell" + (drag ? " droppable" : ""), onDragOver: (e) => e.preventDefault(), onDrop: () => void drop(userKey, day), children: [c && c.minutes > 0 && _jsx("div", { className: "wl-bar" + (c.minutes > cap ? " over" : ""), title: `${fmtMinutes(c.minutes)} of ${fmtMinutes(cap)}`, children: _jsx("span", { style: { width: `${Math.min(100, (c.minutes / cap) * 100)}%` } }) }), c && _jsx("div", { className: "small faint", children: c.minutes ? fmtMinutes(c.minutes) : "" }), c?.items.map((it) => _jsxs("button", { type: "button", className: "wl-item prio-" + it.priority, draggable: true, onDragStart: () => setDrag({ id: it.id, from: userKey ?? "" }), onClick: () => onOpen(it.id), title: `#${it.number} ${it.title}${it.minutes ? ` · ${fmtMinutes(it.minutes)}` : " · no estimate"}`, children: ["#", it.number, " ", it.title] }, it.id))] }, day));
    return (_jsxs("div", { className: "card", children: [_jsx(PeriodBar, { label: `${shortDate(start.toISOString())} – ${shortDate(addDays(start, days - 1).toISOString())}`, rangeLabel: "Workload range", onToday: () => { const d = startOfDay(new Date()); setStart(addDays(d, -((d.getDay() + 6) % 7))); }, onMove: (d) => setStart(addDays(start, d * days)), range: days, ranges: [{ id: 7, label: "1 week" }, { id: 14, label: "2 weeks" }], onRange: setDays, children: _jsxs(Select, { value: team, onChange: (e) => setTeam(e.target.value), "aria-label": "Team", style: { height: 30 }, children: [_jsx("option", { value: "", children: "Everyone" }), (opts.data?.teams ?? []).map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] }) }), !w ? _jsx(ListSkeleton, { rows: 5 }) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table wl", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { minWidth: 180 }, children: "Person" }), w.days.map((d) => {
                                        const dd = new Date(`${d}T00:00`);
                                        return (_jsxs("th", { className: d === ymd(new Date()) ? "today" : "", children: [dd.toLocaleDateString(undefined, { weekday: "short" }), " ", dd.getDate()] }, d));
                                    }), _jsx("th", { className: "num", children: "Total" })] }) }), _jsxs("tbody", { children: [w.people.map((p) => _jsxs("tr", { children: [_jsx("td", { children: _jsxs("span", { className: "row", children: [_jsx(Avatar, { name: p.name, initials: p.initials, size: "sm" }), _jsxs("span", { children: [_jsx("div", { style: { fontWeight: 600 }, children: p.name }), _jsx("div", { className: "small faint", children: p.job_title })] })] }) }), w.days.map((d) => cell(p.id, d, w.cells[p.id]?.[d])), _jsxs("td", { className: "num small", children: [_jsx("b", { children: fmtMinutes(w.totals?.[p.id] ?? 0) }), _jsxs("div", { className: "faint", children: ["of ", fmtMinutes(cap * w.days.length)] })] })] }, p.id)), w.unassigned.map((r) => _jsxs("tr", { className: "wl-unassigned", children: [_jsx("td", { children: _jsxs("span", { className: "row", children: [_jsx("span", { className: "sw lg", style: { background: r.color } }), _jsxs("span", { children: [_jsx("div", { style: { fontWeight: 600 }, children: r.name }), _jsx("div", { className: "small faint", children: r.id === "none" ? "Nobody assigned" : "Team, no person yet" })] })] }) }), w.days.map((d) => cell(null, d, r.days[d])), _jsx("td", { className: "num small", children: _jsx("b", { children: fmtMinutes(Object.values(r.days).reduce((n, c) => n + c.minutes, 0)) }) })] }, r.id))] })] }) })), _jsxs("div", { className: "card-body small faint", style: { paddingTop: 10, paddingBottom: 10 }, children: ["Hours come from each work order's estimated time on its due date. Capacity is ", fmtMinutes(cap), " a day. Drag work to another person or day to reassign or reschedule it."] })] }));
}
// ---------------------------------------------------------------- board
const BOARD = ["open", "on_hold", "in_progress", "done"];
export function BoardView({ query, onOpen }) {
    const { session } = useSession();
    const opts = useWOOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [drag, setDrag] = useState(null);
    const since = ymd(addDays(new Date(), -14));
    const qs = `per_page=300&sort=-priority&q=${encodeURIComponent(query.q)}${filtersParam([...query.filters, { field: "status", op: "not_in", value: ["canceled"] }])}`;
    const data = useQuery({ queryKey: ["work-orders", "board", qs], queryFn: () => api(`/work-orders?${qs}`), placeholderData: (p) => p });
    const status = useMutation({
        mutationFn: ({ w, to }) => api(`/work-orders/${w.id}/status`, { method: "POST", body: { status: to, version: w.version } }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["work-orders"] }),
        onError: (e, v) => { toast(e.message + (v.to === "done" ? " Open the work order to complete it." : ""), { kind: "error" }); if (v.to === "done")
            onOpen(v.w.id); },
    });
    const cols = useMemo(() => {
        const m = { open: [], on_hold: [], in_progress: [], done: [] };
        for (const w of data.data?.items ?? [])
            if (m[w.status] && (w.status !== "done" || (w.completed_at ?? "") >= since))
                m[w.status].push(w);
        return m;
    }, [data.data, since]);
    const needsDialog = (to) => to === "done" ? !!(opts.data?.settings.require_signature || opts.data?.settings.completion_summary === "mandatory")
        : to === "on_hold" && opts.data?.settings.comment_on_hold === "mandatory";
    return (_jsx("div", { className: "board", children: BOARD.map((s) => (_jsxs("div", { className: "board-col " + s, onDragOver: (e) => e.preventDefault(), onDrop: () => {
                const w = data.data?.items.find((x) => x.id === drag);
                setDrag(null);
                if (!w || w.status === s)
                    return;
                if (needsDialog(s)) {
                    toast("This needs a comment, summary or signature. Opening the work order…");
                    onOpen(w.id);
                    return;
                }
                qc.setQueryData(["work-orders", "board", qs], (old) => old && { ...old, items: old.items.map((x) => (x.id === w.id ? { ...x, status: s } : x)) });
                status.mutate({ w, to: s });
            }, children: [_jsxs("div", { className: "board-head", children: [_jsx(StatusPill, { status: s }), _jsx("span", { className: "faint small", children: cols[s].length }), s === "done" && _jsx("span", { className: "small faint", children: "last 14 days" })] }), _jsxs("div", { className: "board-list", children: [cols[s].map((w) => (_jsxs("button", { type: "button", className: "board-card", draggable: true, onDragStart: () => setDrag(w.id), onClick: () => onOpen(w.id), children: [w.cover_url && _jsx("img", { className: "board-cover", src: w.cover_url, alt: "", loading: "lazy", decoding: "async", draggable: false }), _jsxs("div", { className: "row small faint", style: { justifyContent: "space-between" }, children: [_jsxs("span", { className: "mono", children: ["#", w.number] }), _jsx(PriorityBadge, { priority: w.priority })] }), _jsx("div", { className: "t", children: w.title }), _jsxs("div", { className: "row small", style: { justifyContent: "space-between" }, children: [_jsx("span", { className: w.overdue ? "due danger" : "faint", children: w.due_at ? shortDate(w.due_at, session.org?.timezone) : "" }), _jsx("span", { className: "avatars", children: w.assignees.filter((a) => a.type === "user").slice(0, 3).map((a) => _jsx(Avatar, { name: a.name, initials: a.initials, size: "sm" }, a.id)) })] })] }, w.id))), cols[s].length === 0 && _jsx("div", { className: "small faint", style: { padding: 8 }, children: "Drop work orders here" })] })] }, s))) }));
}
