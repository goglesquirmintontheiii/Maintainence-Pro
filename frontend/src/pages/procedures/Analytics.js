import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Procedure analytics (MP-037, r596): which steps fail or get flagged most, numeric answers over time, and scores.
// Plain SVG; every chart has a table fallback.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { EmptyState, ListSkeleton } from "../../components/ui";
import { fmtNum } from "../meters/MeterChart";
import "../../styles/meters.css";
export function ProcedureAnalytics({ id, from, to, tz }) {
    const qs = `${from ? `from=${encodeURIComponent(new Date(from).toISOString())}&` : ""}${to ? `to=${encodeURIComponent(new Date(to + "T23:59:59").toISOString())}` : ""}`;
    const q = useQuery({ queryKey: ["procedure", id, "analytics", qs], queryFn: () => api(`/procedures/${id}/analytics?${qs}`), placeholderData: (p) => p });
    if (q.isLoading || !q.data)
        return _jsx(ListSkeleton, { rows: 4 });
    const a = q.data;
    if (!a.steps.length && !a.numeric.length && !a.scores.length)
        return _jsx(EmptyState, { icon: _jsx(BarChart3, { size: 26 }), title: "No answers yet", children: "Charts appear once technicians answer this procedure on work orders." });
    return (_jsxs("div", { className: "stack", style: { gap: 16 }, children: [a.steps.length > 0 && _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Steps by problems" }), _jsx("span", { className: "small faint", children: "Flag and Fail share of answers" })] }), _jsx("div", { className: "card-body", children: _jsx(StepBars, { steps: a.steps }) })] }), a.scores.length > 0 && _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Scores" }), _jsx("span", { className: "small faint", children: "Completed work orders" })] }), _jsx("div", { className: "card-body", children: _jsx(LineChart, { points: a.scores.map((s) => ({ at: s.at, value: s.score })), unit: "%", tz: tz, label: "Score" }) })] }), a.numeric.map((s) => _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: s.label }), _jsxs("span", { className: "small faint", children: [s.points.length, " answer", s.points.length === 1 ? "" : "s"] })] }), _jsx("div", { className: "card-body", children: _jsx(LineChart, { points: s.points, tz: tz, label: s.label }) })] }, s.field_id))] }));
}
function StepBars({ steps }) {
    const shown = steps.slice(0, 15);
    return (_jsxs("div", { className: "pa-bars", children: [_jsxs("div", { className: "pa-legend small", children: [_jsxs("span", { children: [_jsx("i", { className: "pass" }), "Pass"] }), _jsxs("span", { children: [_jsx("i", { className: "flag" }), "Flag"] }), _jsxs("span", { children: [_jsx("i", { className: "fail" }), "Fail"] })] }), shown.map((s) => (_jsxs("div", { className: "pa-bar-row", children: [_jsx("div", { className: "pa-bar-label small", title: s.label, children: s.label }), _jsxs("svg", { className: "pa-bar", viewBox: "0 0 100 10", preserveAspectRatio: "none", role: "img", "aria-label": `${s.label}: ${s.pass} pass, ${s.flag} flag, ${s.fail} fail`, children: [_jsx("rect", { x: 0, y: 0, width: (100 * s.pass) / s.total, height: 10, className: "pass" }), _jsx("rect", { x: (100 * s.pass) / s.total, y: 0, width: (100 * s.flag) / s.total, height: 10, className: "flag" }), _jsx("rect", { x: (100 * (s.pass + s.flag)) / s.total, y: 0, width: (100 * s.fail) / s.total, height: 10, className: "fail" })] }), _jsxs("div", { className: "pa-bar-val small tnum", children: [s.problem_rate, "%"] })] }, s.field_id))), _jsxs("details", { className: "small", children: [_jsx("summary", { children: "Show as a table" }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Step" }), _jsx("th", { children: "Pass" }), _jsx("th", { children: "Flag" }), _jsx("th", { children: "Fail" }), _jsx("th", { children: "Problems" })] }) }), _jsx("tbody", { children: steps.map((s) => _jsxs("tr", { children: [_jsx("td", { children: s.label }), _jsx("td", { className: "tnum", children: s.pass }), _jsx("td", { className: "tnum", children: s.flag }), _jsx("td", { className: "tnum", children: s.fail }), _jsxs("td", { className: "tnum", children: [s.problem_rate, "%"] })] }, s.field_id)) })] }) })] })] }));
}
const PL = 44, PR = 12, PT = 10, PB = 24;
function LineChart({ points, unit = "", tz, label }) {
    const wrap = useRef(null);
    const [W, setW] = useState(700);
    const [hover, setHover] = useState(null);
    useEffect(() => {
        const el = wrap.current;
        if (!el)
            return;
        const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0)
            setW(w); });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const H = W < 500 ? 170 : 200;
    const pts = points.map((p, i) => ({ ...p, i }));
    const vals = pts.map((p) => p.value);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (unit === "%") {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 100);
    }
    if (hi === lo) {
        hi += 1;
        lo -= 1;
    }
    const pad = (hi - lo) * 0.08;
    if (unit !== "%") {
        lo -= pad;
        hi += pad;
    }
    // evenly spaced by answer (work orders), so bursts on one day stay readable
    const x = (i) => PL + (pts.length <= 1 ? (W - PL - PR) / 2 : (i / (pts.length - 1)) * (W - PL - PR));
    const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    const ticks = Array.from({ length: 4 }, (_, k) => lo + ((hi - lo) * k) / 3);
    const d = pts.map((p) => `${p.i ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const h = hover !== null ? pts[hover] : null;
    return (_jsxs("div", { className: "mchart", ref: wrap, children: [_jsxs("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${label}: ${pts.length} values from ${fmtNum(Math.min(...vals))} to ${fmtNum(Math.max(...vals))}${unit}`, onMouseLeave: () => setHover(null), onMouseMove: (e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const px = ((e.clientX - r.left) / r.width) * W;
                    let best = 0, bd = Infinity;
                    pts.forEach((p) => { const dd = Math.abs(x(p.i) - px); if (dd < bd) {
                        bd = dd;
                        best = p.i;
                    } });
                    setHover(best);
                }, children: [ticks.map((t) => _jsxs("g", { children: [_jsx("line", { x1: PL, x2: W - PR, y1: y(t), y2: y(t), className: "grid" }), _jsx("text", { x: PL - 6, y: y(t) + 4, className: "axis", textAnchor: "end", children: fmtNum(t) })] }, t)), pts.length > 0 && [pts[0], pts[pts.length - 1]].filter((p, k, arr) => k === 0 || p.i !== arr[0].i).map((p, k) => _jsx("text", { x: x(p.i), y: H - 6, className: "axis", textAnchor: k === 0 ? "start" : "end", children: new Date(p.at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz }) }, k)), _jsx("path", { d: d, className: "series" }), pts.length <= 80 && pts.map((p) => _jsx("circle", { cx: x(p.i), cy: y(p.value), r: 2.6, className: "pt" }, p.i)), h && _jsxs(_Fragment, { children: [_jsx("line", { x1: x(h.i), x2: x(h.i), y1: PT, y2: H - PB, className: "cursor" }), _jsx("circle", { cx: x(h.i), cy: y(h.value), r: 4.5, className: "pt hi" })] })] }), h && _jsxs("div", { className: "mchart-tip", style: { left: `${(x(h.i) / W) * 100}%` }, children: [_jsxs("b", { children: [fmtNum(h.value), unit] }), h.work_order ? _jsxs("span", { children: ["Work order #", h.work_order] }) : null, _jsx("span", { className: "faint", children: dateTime(h.at, tz) })] }), _jsxs("details", { className: "small", children: [_jsx("summary", { children: "Show as a table" }), _jsx("div", { className: "table-wrap", style: { maxHeight: 240, overflowY: "auto" }, children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "When" }), pts.some((p) => p.work_order) && _jsx("th", { children: "Work order" }), _jsx("th", { children: label })] }) }), _jsx("tbody", { children: pts.map((p) => _jsxs("tr", { children: [_jsx("td", { children: dateTime(p.at, tz) }), pts.some((q) => q.work_order) && _jsxs("td", { children: ["#", p.work_order] }), _jsxs("td", { className: "tnum", children: [fmtNum(p.value), unit] })] }, p.i)) })] }) })] })] }));
}
