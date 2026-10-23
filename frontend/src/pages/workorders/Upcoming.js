import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Upcoming tab next to To Do and Done (0.5.0, MP-125): open work orders due or starting in the next N days plus
// planned preventive maintenance that hasn't been created yet, grouped by day. The window (7/14/30/60/90 or a custom
// number of days) is saved on the person's account, so it follows them between devices.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Repeat } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { addDays, filtersParam, startOfDay, ymd } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton } from "../../components/ui";
import { NumberInput } from "../../components/NumberInput";
import { useWOList, WORow } from "./WorkOrders";
const WINDOWS = [7, 14, 30, 60, 90];
export function useUpcomingDays() {
    const { session, set } = useSession();
    const { toast } = useToast();
    const days = session.user?.prefs?.upcoming_days ?? 30;
    const save = (n) => {
        if (n === days)
            return;
        if (session.user)
            set({ ...session, user: { ...session.user, prefs: { ...session.user.prefs, upcoming_days: n } } }); // show it straight away
        api("/auth/preferences", { method: "PATCH", body: { prefs: { upcoming_days: n } } })
            .then(set).catch((e) => toast(e.message, { kind: "error" }));
    };
    return [days, save];
}
export function dayLabel(key, today) {
    if (key === ymd(today))
        return "Today";
    if (key === ymd(addDays(today, 1)))
        return "Tomorrow";
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(y !== today.getFullYear() ? { year: "numeric" } : {}) });
}
export function UpcomingWindow({ days, onChange }) {
    const [custom, setCustom] = useState(!WINDOWS.includes(days));
    const [n, setN] = useState(days);
    return (_jsxs("div", { className: "row wrap upcoming-window", children: [_jsx("span", { className: "small muted", "aria-hidden": true, children: "Next" }), _jsxs("div", { className: "seg sm", role: "radiogroup", "aria-label": "Show the next number of days", children: [WINDOWS.map((w) => (_jsx("button", { type: "button", role: "radio", "aria-checked": !custom && days === w, className: "seg-btn" + (!custom && days === w ? " on" : ""), onClick: () => { setCustom(false); onChange(w); }, "aria-label": `${w} days`, children: w }, w))), _jsx("button", { type: "button", role: "radio", "aria-checked": custom, className: "seg-btn" + (custom ? " on" : ""), onClick: () => { setCustom(true); setN(days); }, children: "Custom" })] }), _jsx("span", { className: "small muted", "aria-hidden": true, children: "days" }), custom && (_jsxs("form", { className: "row", style: { gap: 6 }, onSubmit: (e) => { e.preventDefault(); if (n)
                    onChange(n); }, children: [_jsx(NumberInput, { value: n, onValue: setN, min: 1, max: 365, integer: true, "aria-label": "Number of days", style: { width: 80 } }), _jsx(Button, { size: "sm", type: "submit", disabled: !n || n === days, children: "Show" })] }))] }));
}
export function UpcomingList({ id, scope, query, tz }) {
    const { can } = useSession();
    const [days, setDays] = useUpcomingDays();
    const today = startOfDay(new Date());
    const from = today.toISOString();
    const to = addDays(today, days).toISOString();
    const qs = `tab=upcoming&days=${days}&from=${encodeURIComponent(from)}&scope=${scope}&sort=due_at&per_page=100&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}`;
    const list = useWOList(qs);
    // planned PM only makes sense for the unfiltered list: plans aren't work orders yet, so WO filters don't apply
    const withPM = can("pm.view") && scope === "all" && !query.q && !query.filters.length;
    const pm = useQuery({
        queryKey: ["pm-calendar", from, to],
        queryFn: () => api(`/pm/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        enabled: withPM, staleTime: 60_000,
    });
    const groups = useMemo(() => {
        const start = today.getTime(), end = addDays(today, days).getTime();
        const inWin = (s) => !!s && new Date(s).getTime() >= start && new Date(s).getTime() < end;
        const out = [];
        for (const w of list.data?.pages.flatMap((p) => p.items) ?? []) {
            const when = inWin(w.due_at) ? w.due_at : inWin(w.start_at) ? w.start_at : w.due_at ?? w.start_at;
            if (when)
                out.push({ day: ymd(new Date(when)), at: new Date(when).getTime(), wo: w });
        }
        if (withPM)
            for (const it of pm.data?.items ?? []) {
                if (!it.due_at || it.work_order || !["upcoming", "planned"].includes(it.status))
                    continue;
                out.push({ day: ymd(new Date(it.due_at)), at: new Date(it.due_at).getTime(), pm: it });
            }
        out.sort((a, b) => a.at - b.at);
        const g = [];
        for (const e of out) {
            const last = g[g.length - 1];
            if (last && last[0] === e.day)
                last[1].push(e);
            else
                g.push([e.day, [e]]);
        }
        return g;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list.data, pm.data, withPM, days, from]);
    const count = groups.reduce((n, [, es]) => n + es.length, 0);
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "upcoming-head", children: [_jsx(UpcomingWindow, { days: days, onChange: setDays }), _jsx("span", { className: "small muted", children: list.isLoading ? " " : `${count} in the next ${days} day${days === 1 ? "" : "s"}` })] }), list.isLoading ? _jsx(ListSkeleton, {}) : groups.length === 0 ? (_jsx(EmptyState, { icon: _jsx(CalendarClock, { size: 26 }), title: "Nothing coming up", children: query.filters.length || query.q || scope !== "all" ? "No work orders match. Try clearing filters." : `No work orders or preventive maintenance in the next ${days} days.` })) : groups.map(([day, es]) => (_jsxs("section", { className: "upcoming-day", "aria-label": dayLabel(day, today), children: [_jsxs("h3", { className: "upcoming-date" + (day === ymd(today) ? " today" : ""), children: [dayLabel(day, today), _jsx("span", { className: "faint", children: es.length })] }), es.map((e) => e.wo ? _jsx(WORow, { w: e.wo, active: e.wo.id === id, tz: tz }, e.wo.id)
                        : _jsx(PMRow, { it: e.pm }, e.pm.plan.id + e.pm.key))] }, day))), list.hasNextPage && _jsx("div", { style: { padding: 12, textAlign: "center" }, children: _jsx(Button, { size: "sm", onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: list.isFetchingNextPage ? "Loading…" : "Load more" }) }), withPM && pm.isError && _jsx("div", { className: "banner warning small", children: pm.error.message })] }));
}
function PMRow({ it }) {
    const tasks = it.tasks.map((t) => t.name).filter((n) => n && n !== it.plan.name);
    return (_jsxs(Link, { to: `/preventive-maintenance/${it.plan.id}`, className: "list-row wo-row upcoming-pm", role: "listitem", children: [_jsxs("div", { className: "grow wo-row-main", children: [_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Repeat, { size: 14, className: "faint", "aria-hidden": true }), _jsx("span", { className: "t", children: it.plan.name })] }), _jsxs("div", { className: "s row", style: { gap: 8 }, children: [_jsx("span", { children: "Planned preventive maintenance" }), tasks.length > 0 && _jsx("span", { className: "faint", children: tasks.join(", ") })] })] }), _jsx("div", { className: "wo-row-side", children: _jsx("span", { className: "pill upcoming-pill", children: "Not created yet" }) })] }));
}
