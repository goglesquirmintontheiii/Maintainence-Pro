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

type Step = { field_id: string; label: string; pass: number; flag: number; fail: number; total: number; problem_rate: number };
type Series = { field_id: string; label: string; points: { at: string; value: number; work_order: number }[] };
export type AnalyticsData = { steps: Step[]; numeric: Series[]; scores: { at: string; score: number }[] };

export function ProcedureAnalytics({ id, from, to, tz }: { id: string; from: string; to: string; tz?: string }) {
  const qs = `${from ? `from=${encodeURIComponent(new Date(from).toISOString())}&` : ""}${to ? `to=${encodeURIComponent(new Date(to + "T23:59:59").toISOString())}` : ""}`;
  const q = useQuery({ queryKey: ["procedure", id, "analytics", qs], queryFn: () => api<AnalyticsData>(`/procedures/${id}/analytics?${qs}`), placeholderData: (p) => p });
  if (q.isLoading || !q.data) return <ListSkeleton rows={4} />;
  const a = q.data;
  if (!a.steps.length && !a.numeric.length && !a.scores.length)
    return <EmptyState icon={<BarChart3 size={26} />} title="No answers yet">Charts appear once technicians answer this procedure on work orders.</EmptyState>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      {a.steps.length > 0 && <section className="card">
        <div className="card-head"><h2>Steps by problems</h2><span className="small faint">Flag and Fail share of answers</span></div>
        <div className="card-body"><StepBars steps={a.steps} /></div>
      </section>}
      {a.scores.length > 0 && <section className="card">
        <div className="card-head"><h2>Scores</h2><span className="small faint">Completed work orders</span></div>
        <div className="card-body"><LineChart points={a.scores.map((s) => ({ at: s.at, value: s.score }))} unit="%" tz={tz} label="Score" /></div>
      </section>}
      {a.numeric.map((s) => <section className="card" key={s.field_id}>
        <div className="card-head"><h2>{s.label}</h2><span className="small faint">{s.points.length} answer{s.points.length === 1 ? "" : "s"}</span></div>
        <div className="card-body"><LineChart points={s.points} tz={tz} label={s.label} /></div>
      </section>)}
    </div>);
}

function StepBars({ steps }: { steps: Step[] }) {
  const shown = steps.slice(0, 15);
  return (
    <div className="pa-bars">
      <div className="pa-legend small"><span><i className="pass" />Pass</span><span><i className="flag" />Flag</span><span><i className="fail" />Fail</span></div>
      {shown.map((s) => (
        <div key={s.field_id} className="pa-bar-row">
          <div className="pa-bar-label small" title={s.label}>{s.label}</div>
          <svg className="pa-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={`${s.label}: ${s.pass} pass, ${s.flag} flag, ${s.fail} fail`}>
            <rect x={0} y={0} width={(100 * s.pass) / s.total} height={10} className="pass" />
            <rect x={(100 * s.pass) / s.total} y={0} width={(100 * s.flag) / s.total} height={10} className="flag" />
            <rect x={(100 * (s.pass + s.flag)) / s.total} y={0} width={(100 * s.fail) / s.total} height={10} className="fail" />
          </svg>
          <div className="pa-bar-val small tnum">{s.problem_rate}%</div>
        </div>))}
      <details className="small"><summary>Show as a table</summary>
        <div className="table-wrap"><table className="table"><thead><tr><th>Step</th><th>Pass</th><th>Flag</th><th>Fail</th><th>Problems</th></tr></thead>
          <tbody>{steps.map((s) => <tr key={s.field_id}><td>{s.label}</td><td className="tnum">{s.pass}</td><td className="tnum">{s.flag}</td><td className="tnum">{s.fail}</td><td className="tnum">{s.problem_rate}%</td></tr>)}</tbody></table></div>
      </details>
    </div>);
}

const PL = 44, PR = 12, PT = 10, PB = 24;
function LineChart({ points, unit = "", tz, label }: { points: { at: string; value: number; work_order?: number }[]; unit?: string; tz?: string; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(700);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setW(w); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 170 : 200;
  const pts = points.map((p, i) => ({ ...p, i }));
  const vals = pts.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (unit === "%") { lo = Math.min(lo, 0); hi = Math.max(hi, 100); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; if (unit !== "%") { lo -= pad; hi += pad; }
  // evenly spaced by answer (work orders), so bursts on one day stay readable
  const x = (i: number) => PL + (pts.length <= 1 ? (W - PL - PR) / 2 : (i / (pts.length - 1)) * (W - PL - PR));
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const ticks = Array.from({ length: 4 }, (_, k) => lo + ((hi - lo) * k) / 3);
  const d = pts.map((p) => `${p.i ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const h = hover !== null ? pts[hover] : null;
  return (
    <div className="mchart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${label}: ${pts.length} values from ${fmtNum(Math.min(...vals))} to ${fmtNum(Math.max(...vals))}${unit}`}
        onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0, bd = Infinity; pts.forEach((p) => { const dd = Math.abs(x(p.i) - px); if (dd < bd) { bd = dd; best = p.i; } }); setHover(best);
        }}>
        {ticks.map((t) => <g key={t}><line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className="grid" /><text x={PL - 6} y={y(t) + 4} className="axis" textAnchor="end">{fmtNum(t)}</text></g>)}
        {pts.length > 0 && [pts[0], pts[pts.length - 1]].filter((p, k, arr) => k === 0 || p.i !== arr[0].i).map((p, k) =>
          <text key={k} x={x(p.i)} y={H - 6} className="axis" textAnchor={k === 0 ? "start" : "end"}>{new Date(p.at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz })}</text>)}
        <path d={d} className="series" />
        {pts.length <= 80 && pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.value)} r={2.6} className="pt" />)}
        {h && <><line x1={x(h.i)} x2={x(h.i)} y1={PT} y2={H - PB} className="cursor" /><circle cx={x(h.i)} cy={y(h.value)} r={4.5} className="pt hi" /></>}
      </svg>
      {h && <div className="mchart-tip" style={{ left: `${(x(h.i) / W) * 100}%` }}><b>{fmtNum(h.value)}{unit}</b>{h.work_order ? <span>Work order #{h.work_order}</span> : null}<span className="faint">{dateTime(h.at, tz)}</span></div>}
      <details className="small"><summary>Show as a table</summary>
        <div className="table-wrap" style={{ maxHeight: 240, overflowY: "auto" }}><table className="table"><thead><tr><th>When</th>{pts.some((p) => p.work_order) && <th>Work order</th>}<th>{label}</th></tr></thead>
          <tbody>{pts.map((p) => <tr key={p.i}><td>{dateTime(p.at, tz)}</td>{pts.some((q) => q.work_order) && <td>#{p.work_order}</td>}<td className="tnum">{fmtNum(p.value)}{unit}</td></tr>)}</tbody></table></div>
      </details>
    </div>);
}
