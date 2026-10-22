// PM compliance (MP-033): share of visits done by their due day. Postponed visits are judged against the original date,
// skipped ones count against compliance, and open ones that aren't due yet don't count either way.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { Select, ListSkeleton } from "../../components/ui";
import { pctLabel, pctTone, type ComplianceReport } from "./types";

const PERIODS = [[30, "Last 30 days"], [90, "Last 90 days"], [180, "Last 6 months"], [365, "Last 12 months"]] as const;

export function CompliancePage() {
  const [days, setDays] = useState(90);
  const from = new Date(Date.now() - days * 86400000);
  from.setHours(0, 0, 0, 0);
  const q = useQuery({
    queryKey: ["pm-compliance", days],
    queryFn: () => api<ComplianceReport>(`/pm/compliance?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`),
    placeholderData: (p) => p,
  });
  const r = q.data;
  const plans = [...(r?.plans ?? [])].sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101));
  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="small muted" style={{ maxWidth: "70ch" }}>Done by the end of the due day counts as on time. Postponed visits are judged against their original date, and skipped visits count against compliance.</p>
        <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 170 }}>
          {PERIODS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</Select>
      </div>
      {q.isError && <div className="banner warning">{(q.error as ApiError).message}</div>}
      {q.isLoading || !r ? <ListSkeleton rows={4} /> : <>
        <div className="tiles">
          <div className="card tile"><div className="k">PM compliance</div><div className={"v " + pctTone(r.percent)}>{pctLabel(r.percent)}</div></div>
          <div className="card tile"><div className="k">On time</div><div className="v">{r.on_time}</div></div>
          <div className="card tile"><div className="k">Late</div><div className={"v" + (r.late ? " warning" : "")}>{r.late}</div></div>
          <div className="card tile"><div className="k">Missed</div><div className={"v" + (r.missed ? " danger" : "")}>{r.missed}</div></div>
          <div className="card tile"><div className="k">Skipped</div><div className="v">{r.skipped}</div></div>
          <div className="card tile"><div className="k">Open, not due yet</div><div className="v">{r.open}</div></div>
        </div>
        <section className="card">
          <div className="card-head"><h2>By plan</h2><span className="small muted">Lowest first</span></div>
          {plans.length === 0 ? <div className="card-body small faint">No preventive work was due in this period.</div> : (
            <div className="table-wrap"><table className="table pm-comp-table">
              <thead><tr><th>Plan</th><th className="pm-bar-col">Done on time</th><th className="num">On time</th><th className="num">Late</th><th className="num">Missed</th><th className="num">Skipped</th></tr></thead>
              <tbody>{plans.map((p) => {
                const tot = p.on_time + p.late + p.missed + p.skipped;
                const w = (n: number) => (tot ? `${(n / tot) * 100}%` : "0");
                return (
                  <tr key={p.id} className={p.deleted ? "deleted" : ""}>
                    <td className="t">{p.deleted ? p.name : <Link to={`/preventive-maintenance/${p.id}`}>{p.name}</Link>}{p.kind === "repeat" && <span className="small faint"> · repeating</span>}</td>
                    <td className="pm-bar-col"><div className="row" style={{ gap: 8 }}>
                      <div className="pm-bar" role="img" aria-label={`${p.on_time} on time, ${p.late} late, ${p.missed} missed, ${p.skipped} skipped`}>
                        <span className="on" style={{ width: w(p.on_time) }} /><span className="late" style={{ width: w(p.late) }} /><span className="missed" style={{ width: w(p.missed) }} /><span className="skipped" style={{ width: w(p.skipped) }} />
                      </div><span className={"pm-pct " + pctTone(p.percent)}>{pctLabel(p.percent)}</span></div></td>
                    <td className="num">{p.on_time}</td><td className="num">{p.late}</td><td className="num">{p.missed}</td><td className="num">{p.skipped}</td>
                  </tr>);
              })}</tbody>
            </table></div>)}
        </section>
      </>}
    </div>
  );
}
