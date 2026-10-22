// PM calendar (MP-033): a month of preventive work, both created work orders and the forecast of visits not created yet.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { addDays, startOfDay, ymd } from "../../lib/wo";
import { Button, ListSkeleton } from "../../components/ui";
import { OCC_LABEL, WEEKDAYS, type Occurrence } from "./types";

function monthGrid(month: Date): Date[] {
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
    queryFn: () => api<{ items: (Occurrence & { plan: NonNullable<Occurrence["plan"]> })[] }>(`/pm/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
    placeholderData: (p) => p,
  });
  const byDay = useMemo(() => {
    const m: Record<string, (Occurrence & { plan: NonNullable<Occurrence["plan"]> })[]> = {};
    for (const it of q.data?.items ?? []) if (it.due_at) (m[ymd(new Date(it.due_at))] ??= []).push(it);
    return m;
  }, [q.data]);
  const today = ymd(new Date());
  const step = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const count = q.data?.items.length ?? 0;
  return (
    <section className="card pm-cal">
      <div className="card-head">
        <div className="row">
          <Button icon variant="ghost" aria-label="Previous month" onClick={() => step(-1)}><ChevronLeft size={18} /></Button>
          <h2 className="pm-cal-title">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
          <Button icon variant="ghost" aria-label="Next month" onClick={() => step(1)}><ChevronRight size={18} /></Button>
          <Button size="sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</Button>
        </div>
        <div className="pm-legend small muted" aria-label="Legend">
          <span><i className="st upcoming" />Forecast</span><span><i className="st generated" />Created</span><span><i className="st completed" />Done</span><span><i className="st skipped" />Skipped</span>
        </div>
      </div>
      {q.isError && <div className="card-body banner warning">{(q.error as ApiError).message}</div>}
      {q.isLoading ? <div className="card-body"><ListSkeleton rows={5} /></div> : <>
        <div className="pm-cal-grid" role="grid" aria-label="PM calendar">
          {WEEKDAYS.map((w) => <div key={w} className="pm-cal-wd" role="columnheader">{w}</div>)}
          {days.map((d) => {
            const k = ymd(d);
            const items = byDay[k] ?? [];
            const out = d.getMonth() !== month.getMonth();
            return (
              <div key={k} role="gridcell" className={"pm-cal-day" + (out ? " out" : "") + (k === today ? " today" : "") + (items.length ? "" : " none")}>
                <div className="pm-cal-n"><span className="mobile-only">{d.toLocaleDateString(undefined, { weekday: "short" })} </span>{d.getDate()}</div>
                {items.slice(0, 4).map((it) => <CalItem key={it.plan.id + it.key} it={it} />)}
                {items.length > 4 && <span className="small faint">+{items.length - 4} more</span>}
              </div>);
          })}
        </div>
        {count === 0 && <div className="card-body small faint">No preventive work this month.</div>}
      </>}
    </section>
  );
}

function CalItem({ it }: { it: Occurrence & { plan: NonNullable<Occurrence["plan"]> } }) {
  const status = it.work_order && it.work_order.status === "done" ? "completed" : it.status;
  const label = (it.work_order ? `#${it.work_order.number} ` : "") + it.plan.name;
  const title = `${label} · ${OCC_LABEL[status]}${it.tasks.some((t) => t.name) ? " · " + it.tasks.map((t) => t.name).filter(Boolean).join(", ") : ""}`;
  const to = it.work_order ? `/work-orders/${it.work_order.id}` : `/preventive-maintenance/${it.plan.id}`;
  return <Link to={to} className={"pm-cal-item " + status} title={title}>{label}</Link>;
}
