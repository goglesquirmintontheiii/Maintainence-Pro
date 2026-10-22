// Meter readings chart in plain SVG: line (or min/max band when bucketed), warning/alarm bands, hover tooltip, table fallback.
import { useMemo, useRef, useState } from "react";
import type { ChartData } from "../../lib/assets";
import { dateTime } from "../../lib/format";

const W = 800, H = 240, PL = 48, PR = 12, PT = 12, PB = 26;

function nice(n: number): string {
  const a = Math.abs(n);
  return a >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a >= 10 ? n.toFixed(1).replace(/\.0$/, "") : String(+n.toFixed(3));
}

export function MeterChart({ data, from, to, tz }: { data: ChartData; from: Date; to: Date; tz?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pts = data.points.map((p) => ({ ...p, t: new Date(p.at).getTime() }));
  const L = data.limits;
  const geo = useMemo(() => {
    const vals = pts.flatMap((p) => [p.value, p.min ?? p.value, p.max ?? p.value]);
    const lims = [L.warning_low, L.warning_high, L.alarm_low, L.alarm_high].filter((x): x is number => x !== null);
    let lo = Math.min(...vals, ...(vals.length ? lims : [0]));
    let hi = Math.max(...vals, ...(vals.length ? lims : [1]));
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const t0 = from.getTime(), t1 = to.getTime();
    const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - PR);
    const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    return { lo, hi, x, y, ticks, t0, t1 };
  }, [pts, L, from, to]);
  const { x, y, lo, hi } = geo;
  const clampY = (v: number) => y(Math.max(lo, Math.min(hi, v)));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const band = data.bucketed && pts.length
    ? pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.max ?? p.value).toFixed(1)}`).join(" ")
      + " " + [...pts].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.min ?? p.value).toFixed(1)}`).join(" ") + " Z" : "";
  const xTicks = Array.from({ length: 5 }, (_, i) => geo.t0 + ((geo.t1 - geo.t0) * i) / 4);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!pts.length || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };
  const h = hover !== null ? pts[hover] : null;
  const summary = pts.length
    ? `${pts.length} ${data.bucketed ? "averaged points" : "readings"} from ${nice(Math.min(...pts.map((p) => p.value)))} to ${nice(Math.max(...pts.map((p) => p.value)))} ${data.unit}`
    : "No readings in this range";
  const band2 = (a: number | null, b: number | null, cls: string) => {
    if (a === null && b === null) return null;
    const top = b === null ? PT : clampY(b), bottom = a === null ? H - PB : clampY(a);
    return bottom > top ? <rect x={PL} y={top} width={W - PL - PR} height={bottom - top} className={cls} /> : null;
  };
  return (
    <div className="mchart">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chart: ${summary}`} preserveAspectRatio="none"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* bands: alarm beyond alarm limits, warning between warning and alarm */}
        {L.alarm_high !== null && band2(L.alarm_high, null, "band-alarm")}
        {L.alarm_low !== null && band2(lo, L.alarm_low, "band-alarm")}
        {L.warning_high !== null && band2(L.warning_high, L.alarm_high, "band-warn")}
        {L.warning_low !== null && band2(L.alarm_low ?? lo, L.warning_low, "band-warn")}
        {geo.ticks.map((t) => <g key={t}><line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PL - 6} y={y(t) + 4} className="axis" textAnchor="end">{nice(t)}</text></g>)}
        {xTicks.map((t, i) => <text key={t} x={x(t)} y={H - 8} className="axis" textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>
          {new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz })}</text>)}
        {([["warning_high", "lim-warn"], ["warning_low", "lim-warn"], ["alarm_high", "lim-alarm"], ["alarm_low", "lim-alarm"]] as const).map(([k, c]) =>
          L[k] !== null && L[k]! >= lo && L[k]! <= hi ? <line key={k} x1={PL} x2={W - PR} y1={y(L[k]!)} y2={y(L[k]!)} className={c} /> : null)}
        {band && <path d={band} className="minmax" />}
        {pts.length > 0 && <path d={line} className="series" vectorEffect="non-scaling-stroke" />}
        {pts.length <= 60 && pts.map((p) => <circle key={p.at} cx={x(p.t)} cy={y(p.value)} r={2.6} className="pt" />)}
        {h && <><line x1={x(h.t)} x2={x(h.t)} y1={PT} y2={H - PB} className="cursor" /><circle cx={x(h.t)} cy={y(h.value)} r={4.5} className="pt hi" /></>}
      </svg>
      {h && (
        <div className="mchart-tip" style={{ left: `${(x(h.t) / W) * 100}%` }}>
          <b>{nice(h.value)} {data.unit}</b>{h.count ? <span> avg of {h.count} (min {nice(h.min!)}, max {nice(h.max!)})</span> : null}
          <span className="faint">{dateTime(h.at, tz)}</span>
        </div>)}
      {pts.length === 0 && <div className="mchart-empty small muted">No readings in this range</div>}
      <details className="small">
        <summary>Show as a table</summary>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
          <table className="table"><thead><tr><th>When</th><th>Value ({data.unit})</th>{data.bucketed && <><th>Min</th><th>Max</th><th>Readings</th></>}</tr></thead>
            <tbody>{pts.map((p) => <tr key={p.at}><td>{dateTime(p.at, tz)}</td><td className="tnum">{nice(p.value)}</td>
              {data.bucketed && <><td className="tnum">{nice(p.min!)}</td><td className="tnum">{nice(p.max!)}</td><td className="tnum">{p.count}</td></>}</tr>)}</tbody></table>
        </div>
      </details>
    </div>
  );
}

export { nice as fmtNum };
