import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Preventive Maintenance (0.4.0, MP-033/MP-104): plans list + detail split like Work Orders, a month calendar forecast
// and a compliance report. Repeating work orders show here too (kind "repeat"); they're edited on the work order.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, CalendarOff, Gauge, MoreHorizontal, PauseCircle, PieChart, Plus, Repeat, Search, Trash2 } from "lucide-react";
import "../../styles/workorders.css";
import "../../styles/pm.css";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { shortDate } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { PlanDetail } from "./PlanDetail";
import { PlanForm } from "./PlanForm";
import { PMCalendar } from "./Calendar";
import { CompliancePage } from "./Compliance";
import { pctLabel, pctTone, useHolidays } from "./types";
const TABS = [
    { id: "plans", label: "Plans", icon: CalendarClock }, { id: "calendar", label: "Calendar", icon: CalendarDays }, { id: "compliance", label: "Compliance", icon: PieChart },
];
export function PMPage() {
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const nav = useNavigate();
    const tab = id ? "plans" : (params.get("tab") || "plans");
    const [creating, setCreating] = useState(false);
    const [holidays, setHolidays] = useState(false);
    useEffect(() => { if (params.get("new") === "1") {
        setCreating(true);
        params.delete("new");
        setParams(params, { replace: true });
    } }, [params, setParams]);
    const setTab = (t) => { if (id)
        nav(`/preventive-maintenance?tab=${t}`);
    else {
        const p = new URLSearchParams(params);
        p.set("tab", t);
        setParams(p);
    } };
    const tabs = (_jsx("div", { className: "seg views", role: "tablist", "aria-label": "Preventive maintenance", children: TABS.map((t) => {
            const Icon = t.icon;
            return (_jsxs("button", { type: "button", role: "tab", "aria-selected": tab === t.id, className: "seg-btn" + (tab === t.id ? " on" : ""), onClick: () => setTab(t.id), children: [_jsx(Icon, { size: 15 }), _jsx("span", { children: t.label })] }, t.id));
        }) }));
    const more = (_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 230, children: (close) => _jsxs("button", { className: "menu-item", onClick: () => { close(); setHolidays(true); }, children: [_jsx(CalendarOff, { size: 15 }), "Holidays and shutdowns\u2026"] }) }));
    const newBtn = can("pm.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New maintenance plan", children: [_jsx(Plus, { size: 16 }), _jsx("span", { children: "New plan" })] });
    return (_jsxs("div", { className: "wo-page", children: [tab === "plans" ? _jsx(PlansSplit, { id: id, head: _jsxs(_Fragment, { children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { style: { fontSize: "var(--fs-lg)" }, children: "Preventive Maintenance" }), _jsxs("div", { className: "row", children: [more, newBtn] })] }), tabs] }) })
                : _jsx("div", { className: "wo-scroll", children: _jsxs("div", { className: "pm-page", children: [_jsxs("div", { className: "page-head", children: [_jsx("div", { children: _jsx("h1", { children: "Preventive Maintenance" }) }), _jsxs("div", { className: "row", children: [more, newBtn] })] }), tabs, tab === "calendar" ? _jsx(PMCalendar, {}) : _jsx(CompliancePage, {})] }) }), creating && _jsx(PlanForm, { onClose: () => setCreating(false), onSaved: (p) => nav(`/preventive-maintenance/${p.id}`) }), holidays && _jsx(HolidaysDialog, { onClose: () => setHolidays(false) })] }));
}
function PlansSplit({ id, head }) {
    const [q, setQ] = useState("");
    const [kind, setKind] = useState("");
    const [active, setActive] = useState("");
    const qs = `per_page=50&q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}${active ? `&active=${active}` : ""}`;
    const list = useInfiniteQuery({
        queryKey: ["pm-plans", qs], initialPageParam: 1,
        queryFn: ({ pageParam }) => api(`/pm/plans?${qs}&page=${pageParam}`),
        getNextPageParam: (l) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
        placeholderData: (p) => p,
    });
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    const total = list.data?.pages[0]?.total;
    const filtered = !!(q || kind || active);
    return (_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [head, _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search plans", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search plans" })] }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs(Select, { "aria-label": "Kind", value: kind, onChange: (e) => setKind(e.target.value), className: "grow", children: [_jsx("option", { value: "", children: "Plans and repeating work" }), _jsx("option", { value: "plan", children: "Maintenance plans" }), _jsx("option", { value: "repeat", children: "Repeating work orders" })] }), _jsxs(Select, { "aria-label": "Status", value: active, onChange: (e) => setActive(e.target.value), style: { width: 130 }, children: [_jsx("option", { value: "", children: "Any status" }), _jsx("option", { value: "1", children: "Active" }), _jsx("option", { value: "0", children: "Paused" })] })] }), _jsxs("div", { className: "row small muted", style: { justifyContent: "space-between" }, children: [_jsxs("span", { children: [total === undefined ? " " : `${total} plan${total === 1 ? "" : "s"}`, filtered && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx("button", { className: "linkbtn small", onClick: () => { setQ(""); setKind(""); setActive(""); }, children: "Clear" })] })] }), _jsx("span", { className: "faint", children: "Compliance: last 90 days" })] })] }), _jsxs("div", { className: "list", role: "list", children: [list.isLoading ? _jsx(ListSkeleton, {}) : list.isError ? _jsx("div", { className: "card-body banner warning", children: list.error.message })
                                : items.length === 0 ? _jsx(EmptyState, { icon: _jsx(CalendarClock, { size: 26 }), title: filtered ? "No plans match" : "No maintenance plans yet", children: filtered ? "Try other filters." : "Plans create preventive work orders on a schedule or from meter readings. Make any work order repeat from its Repeat setting." })
                                    : items.map((p) => _jsx(PlanRow, { p: p, active: p.id === id }, p.id)), list.hasNextPage && _jsx("div", { className: "card-body", children: _jsx(Button, { block: true, onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: "Show more" }) })] })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(PlanDetail, { id: id }) : _jsx("div", { className: "desktop-only", children: _jsx(EmptyState, { icon: _jsx(CalendarClock, { size: 26 }), title: "Pick a plan", children: "See its schedule, the next visits and how often it's done on time." }) }) })] }));
}
function PlanRow({ p, active }) {
    const { session } = useSession();
    const pct = p.compliance?.percent;
    const Icon = p.kind === "repeat" ? Repeat : p.schedule_kind === "usage" ? Gauge : CalendarClock;
    return (_jsxs(Link, { role: "listitem", to: `/preventive-maintenance/${p.id}`, className: "list-row pm-row" + (active ? " active" : "") + (p.active ? "" : " paused"), children: [_jsx("span", { className: "pm-row-ic " + p.kind, children: _jsx(Icon, { size: 16 }) }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "t", children: p.name }), _jsxs("div", { className: "s", children: [p.frequency || "—", p.asset ? ` · ${p.asset.name}` : ""] })] }), _jsxs("div", { className: "pm-row-side", children: [p.active ? _jsx("span", { className: "small muted", children: p.next_due_at ? `Next ${shortDate(p.next_due_at, session.org?.timezone)}` : "Nothing scheduled" })
                        : _jsxs(Pill, { tone: "warning", children: [_jsx(PauseCircle, { size: 12 }), "Paused"] }), pct !== null && pct !== undefined && _jsx("span", { className: "pm-pct " + pctTone(pct), title: "Done on time, last 90 days", children: pctLabel(pct) })] })] }));
}
function HolidaysDialog({ onClose }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const list = useHolidays();
    const [day, setDay] = useState("");
    const [name, setName] = useState("");
    const add = useMutation({
        mutationFn: () => api("/pm/holidays", { method: "POST", body: { day, name } }),
        onSuccess: () => { setDay(""); setName(""); qc.invalidateQueries({ queryKey: ["pm-holidays"] }); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const del = useMutation({
        mutationFn: (hid) => api(`/pm/holidays/${hid}`, { method: "DELETE" }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["pm-holidays"] }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const manage = can("pm.manage");
    return (_jsxs(Modal, { title: "Holidays and shutdowns", onClose: onClose, width: 520, footer: _jsx(Button, { onClick: onClose, children: "Done" }), children: [_jsx("p", { className: "small muted", children: "Plans set to skip holidays move or skip visits that land on these days." }), manage && _jsxs("div", { className: "row wrap pm-hol-add", children: [_jsx(Field, { label: "Date", children: (id) => _jsx(Input, { id: id, type: "date", value: day, onChange: (e) => setDay(e.target.value) }) }), _jsx(Field, { label: "Name", className: "grow", children: (id) => _jsx(Input, { id: id, value: name, maxLength: 120, placeholder: "e.g. Plant shutdown", onChange: (e) => setName(e.target.value) }) }), _jsx(Button, { variant: "primary", disabled: !day || add.isPending, onClick: () => add.mutate(), children: "Add" })] }), list.isLoading ? _jsx(ListSkeleton, { rows: 3 }) : (list.data?.items.length ?? 0) === 0 ? _jsx("p", { className: "small faint", children: "No holidays yet." }) : (_jsx("ul", { className: "pm-hol-list", children: list.data.items.map((h) => (_jsxs("li", { className: "row", children: [_jsx("span", { className: "mono small", children: h.day }), _jsx("span", { className: "grow", children: h.name || "Holiday" }), manage && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Remove ${h.day}`, onClick: () => del.mutate(h.id), children: _jsx(Trash2, { size: 14 }) })] }, h.id))) }))] }));
}
