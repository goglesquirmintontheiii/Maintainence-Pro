import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Meter readings chart in plain SVG: line (or min/max band when bucketed), warning/alarm bands, hover tooltip, table fallback.
import { useEffect, useMemo, useRef, useState } from "react";
import { dateTime } from "../../lib/format";
const PL = 48, PR = 12, PT = 12, PB = 26;
function nice(n) {
    const a = Math.abs(n);
    return a >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a >= 10 ? n.toFixed(1).replace(/\.0$/, "") : String(+n.toFixed(3));
}
export function MeterChart({ data, from, to, tz }) {
    const [hover, setHover] = useState(null);
    const svg = useRef(null);
    const wrap = useRef(null);
    // Draw at the real pixel width so text and points aren't stretched.
    const [W, setW] = useState(800);
    const H = W < 500 ? 200 : 240;
    useEffect(() => {
        const el = wrap.current;
        if (!el)
            return;
        const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0)
            setW(w); });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const pts = data.points.map((p) => ({ ...p, t: new Date(p.at).getTime() }));
    const L = data.limits;
    const geo = useMemo(() => {
        const vals = pts.flatMap((p) => [p.value, p.min ?? p.value, p.max ?? p.value]);
        const lims = [L.warning_low, L.warning_high, L.alarm_low, L.alarm_high].filter((x) => x !== null);
        let lo = Math.min(...vals, ...(vals.length ? lims : [0]));
        let hi = Math.max(...vals, ...(vals.length ? lims : [1]));
        if (!isFinite(lo) || !isFinite(hi)) {
            lo = 0;
            hi = 1;
        }
        if (hi === lo) {
            hi += 1;
            lo -= 1;
        }
        const pad = (hi - lo) * 0.08;
        lo -= pad;
        hi += pad;
        const t0 = from.getTime(), t1 = to.getTime();
        const x = (t) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - PR);
        const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
        const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
        return { lo, hi, x, y, ticks, t0, t1 };
    }, [pts, L, from, to, W, H]);
    const { x, y, lo, hi } = geo;
    const clampY = (v) => y(Math.max(lo, Math.min(hi, v)));
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const band = data.bucketed && pts.length
        ? pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.max ?? p.value).toFixed(1)}`).join(" ")
            + " " + [...pts].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.min ?? p.value).toFixed(1)}`).join(" ") + " Z" : "";
    const nx = W < 500 ? 3 : 5;
    const xTicks = Array.from({ length: nx }, (_, i) => geo.t0 + ((geo.t1 - geo.t0) * i) / (nx - 1));
    const onMove = (e) => {
        if (!pts.length || !svg.current)
            return;
        const r = svg.current.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        let best = 0, bd = Infinity;
        pts.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < bd) {
            bd = d;
            best = i;
        } });
        setHover(best);
    };
    const h = hover !== null ? pts[hover] : null;
    const summary = pts.length
        ? `${pts.length} ${data.bucketed ? "averaged points" : "readings"} from ${nice(Math.min(...pts.map((p) => p.value)))} to ${nice(Math.max(...pts.map((p) => p.value)))} ${data.unit}`
        : "No readings in this range";
    const band2 = (a, b, cls) => {
        if (a === null && b === null)
            return null;
        const top = b === null ? PT : clampY(b), bottom = a === null ? H - PB : clampY(a);
        return bottom > top ? _jsx("rect", { x: PL, y: top, width: W - PL - PR, height: bottom - top, className: cls }) : null;
    };
    return (_jsxs("div", { className: "mchart", ref: wrap, children: [_jsxs("svg", { ref: svg, viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Chart: ${summary}`, onMouseMove: onMove, onMouseLeave: () => setHover(null), children: [L.alarm_high !== null && band2(L.alarm_high, null, "band-alarm"), L.alarm_low !== null && band2(lo, L.alarm_low, "band-alarm"), L.warning_high !== null && band2(L.warning_high, L.alarm_high, "band-warn"), L.warning_low !== null && band2(L.alarm_low ?? lo, L.warning_low, "band-warn"), geo.ticks.map((t) => _jsxs("g", { children: [_jsx("line", { x1: PL, x2: W - PR, y1: y(t), y2: y(t), className: "grid" }), _jsx("text", { x: PL - 6, y: y(t) + 4, className: "axis", textAnchor: "end", children: nice(t) })] }, t)), xTicks.map((t, i) => _jsx("text", { x: x(t), y: H - 8, className: "axis", textAnchor: i === 0 ? "start" : i === nx - 1 ? "end" : "middle", children: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz }) }, t)), [["warning_high", "lim-warn"], ["warning_low", "lim-warn"], ["alarm_high", "lim-alarm"], ["alarm_low", "lim-alarm"]].map(([k, c]) => L[k] !== null && L[k] >= lo && L[k] <= hi ? _jsx("line", { x1: PL, x2: W - PR, y1: y(L[k]), y2: y(L[k]), className: c }, k) : null), band && _jsx("path", { d: band, className: "minmax" }), pts.length > 0 && _jsx("path", { d: line, className: "series" }), pts.length <= 60 && pts.map((p) => _jsx("circle", { cx: x(p.t), cy: y(p.value), r: 2.6, className: "pt" }, p.at)), h && _jsxs(_Fragment, { children: [_jsx("line", { x1: x(h.t), x2: x(h.t), y1: PT, y2: H - PB, className: "cursor" }), _jsx("circle", { cx: x(h.t), cy: y(h.value), r: 4.5, className: "pt hi" })] })] }), h && (_jsxs("div", { className: "mchart-tip", style: { left: `${(x(h.t) / W) * 100}%` }, children: [_jsxs("b", { children: [nice(h.value), " ", data.unit] }), h.count ? _jsxs("span", { children: [" avg of ", h.count, " (min ", nice(h.min), ", max ", nice(h.max), ")"] }) : null, _jsx("span", { className: "faint", children: dateTime(h.at, tz) })] })), pts.length === 0 && _jsx("div", { className: "mchart-empty small muted", children: "No readings in this range" }), _jsxs("details", { className: "small", children: [_jsx("summary", { children: "Show as a table" }), _jsx("div", { className: "table-wrap", style: { maxHeight: 260, overflowY: "auto" }, children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "When" }), _jsxs("th", { children: ["Value (", data.unit, ")"] }), data.bucketed && _jsxs(_Fragment, { children: [_jsx("th", { children: "Min" }), _jsx("th", { children: "Max" }), _jsx("th", { children: "Readings" })] })] }) }), _jsx("tbody", { children: pts.map((p) => _jsxs("tr", { children: [_jsx("td", { children: dateTime(p.at, tz) }), _jsx("td", { className: "tnum", children: nice(p.value) }), data.bucketed && _jsxs(_Fragment, { children: [_jsx("td", { className: "tnum", children: nice(p.min) }), _jsx("td", { className: "tnum", children: nice(p.max) }), _jsx("td", { className: "tnum", children: p.count })] })] }, p.at)) })] }) })] })] }));
}
export { nice as fmtNum };
