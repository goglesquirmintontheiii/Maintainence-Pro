import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// PM calendar (MP-033): a month of preventive work, both created work orders and the forecast of visits not created yet.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { addDays, startOfDay, ymd } from "../../lib/wo";
import { Button, ListSkeleton } from "../../components/ui";
import { OCC_LABEL, WEEKDAYS } from "./types";
function monthGrid(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = addDays(first, -((first.getDay() + 6) % 7)); // weeks start on Monday
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const days = Math.ceil(((last.getTime() - start.getTime()) / 86400000 + 1) / 7) * 7;
    return Array.from({ length: days }, (_, i) => addDays(start, i));
}
export function PMCalendar() {
    const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
    const days = useMemo(() => monthGrid(month), [month]);
    const from = startOfDay(days[0]);
    const to = addDays(startOfDay(days[days.length - 1]), 1);
    const q = useQuery({
        queryKey: ["pm-calendar", from.toISOString()],
        queryFn: () => api(`/pm/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
        placeholderData: (p) => p,
    });
    const byDay = useMemo(() => {
        const m = {};
        for (const it of q.data?.items ?? [])
            if (it.due_at)
                (m[ymd(new Date(it.due_at))] ??= []).push(it);
        return m;
    }, [q.data]);
    const today = ymd(new Date());
    const step = (n) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
    const count = q.data?.items.length ?? 0;
    return (_jsxs("section", { className: "card pm-cal", children: [_jsxs("div", { className: "card-head pm-cal-head", children: [_jsxs("div", { className: "row", children: [_jsx(Button, { icon: true, variant: "ghost", "aria-label": "Previous month", onClick: () => step(-1), children: _jsx(ChevronLeft, { size: 18 }) }), _jsx("h2", { className: "pm-cal-title", children: month.toLocaleDateString(undefined, { month: "long", year: "numeric" }) }), _jsx(Button, { icon: true, variant: "ghost", "aria-label": "Next month", onClick: () => step(1), children: _jsx(ChevronRight, { size: 18 }) }), _jsx(Button, { size: "sm", onClick: () => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }, children: "Today" })] }), _jsxs("div", { className: "pm-legend small muted", "aria-label": "Legend", children: [_jsxs("span", { children: [_jsx("i", { className: "st upcoming" }), "Forecast"] }), _jsxs("span", { children: [_jsx("i", { className: "st generated" }), "Created"] }), _jsxs("span", { children: [_jsx("i", { className: "st completed" }), "Done"] }), _jsxs("span", { children: [_jsx("i", { className: "st skipped" }), "Skipped"] })] })] }), q.isError && _jsx("div", { className: "card-body banner warning", children: q.error.message }), q.isLoading ? _jsx("div", { className: "card-body", children: _jsx(ListSkeleton, { rows: 5 }) }) : _jsxs(_Fragment, { children: [_jsxs("div", { className: "pm-cal-grid", role: "grid", "aria-label": "PM calendar", children: [WEEKDAYS.map((w) => _jsx("div", { className: "pm-cal-wd", role: "columnheader", children: w }, w)), days.map((d) => {
                                const k = ymd(d);
                                const items = byDay[k] ?? [];
                                const out = d.getMonth() !== month.getMonth();
                                return (_jsxs("div", { role: "gridcell", className: "pm-cal-day" + (out ? " out" : "") + (k === today ? " today" : "") + (items.length ? "" : " none"), children: [_jsxs("div", { className: "pm-cal-n", children: [_jsx("span", { className: "mobile-only pm-cal-wdn", children: d.toLocaleDateString(undefined, { weekday: "short" }) }), d.getDate()] }), items.slice(0, 4).map((it) => _jsx(CalItem, { it: it }, it.plan.id + it.key)), items.length > 4 && _jsxs("span", { className: "small faint", children: ["+", items.length - 4, " more"] })] }, k));
                            })] }), count === 0 && _jsx("div", { className: "card-body small faint", children: "No preventive work this month." })] })] }));
}
function CalItem({ it }) {
    const status = it.work_order && it.work_order.status === "done" ? "completed" : it.status;
    const label = (it.work_order ? `#${it.work_order.number} ` : "") + it.plan.name;
    const title = `${label} · ${OCC_LABEL[status]}${it.tasks.some((t) => t.name) ? " · " + it.tasks.map((t) => t.name).filter(Boolean).join(", ") : ""}`;
    const to = it.work_order ? `/work-orders/${it.work_order.id}` : `/preventive-maintenance/${it.plan.id}`;
    return _jsx(Link, { to: to, className: "pm-cal-item " + status, title: title, children: label });
}
