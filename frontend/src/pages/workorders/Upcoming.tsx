// Upcoming tab next to To Do and Done (0.5.0, MP-125): open work orders due or starting in the next N days plus
// planned preventive maintenance that hasn't been created yet, grouped by day. The window (7/14/30/60/90 or a custom
// number of days) is saved on the person's account, so it follows them between devices.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Repeat } from "lucide-react";
import { api, ApiError, type Session, type WorkOrder } from "../../lib/api";
import { useSession } from "../../lib/session";
import { addDays, filtersParam, startOfDay, ymd } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton } from "../../components/ui";
import { NumberInput } from "../../components/NumberInput";
import type { Occurrence } from "../pm/types";
import { useWOList, WORow, type ListQuery } from "./WorkOrders";

const WINDOWS = [7, 14, 30, 60, 90];
type PMItem = Occurrence & { plan: NonNullable<Occurrence["plan"]> };
type Entry = { day: string; at: number; wo?: WorkOrder; pm?: PMItem };

export function useUpcomingDays(): [number, (n: number) => void] {
  const { session, set } = useSession();
  const { toast } = useToast();
  const days = session.user?.prefs?.upcoming_days ?? 30;
  const save = (n: number) => {
    if (n === days) return;
    if (session.user) set({ ...session, user: { ...session.user, prefs: { ...session.user.prefs, upcoming_days: n } } }); // show it straight away
    api<Session>("/auth/preferences", { method: "PATCH", body: { prefs: { upcoming_days: n } } })
      .then(set).catch((e) => toast((e as ApiError).message, { kind: "error" }));
  };
  return [days, save];
}

export function dayLabel(key: string, today: Date): string {
  if (key === ymd(today)) return "Today";
  if (key === ymd(addDays(today, 1))) return "Tomorrow";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(y !== today.getFullYear() ? { year: "numeric" } : {}) });
}

export function UpcomingWindow({ days, onChange }: { days: number; onChange: (n: number) => void }) {
  const [custom, setCustom] = useState(!WINDOWS.includes(days));
  const [n, setN] = useState<number | null>(days);
  return (
    <div className="row wrap upcoming-window">
      <span className="small muted" aria-hidden>Next</span>
      <div className="seg sm" role="radiogroup" aria-label="Show the next number of days">
        {WINDOWS.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={!custom && days === w} className={"seg-btn" + (!custom && days === w ? " on" : "")}
            onClick={() => { setCustom(false); onChange(w); }} aria-label={`${w} days`}>{w}</button>))}
        <button type="button" role="radio" aria-checked={custom} className={"seg-btn" + (custom ? " on" : "")} onClick={() => { setCustom(true); setN(days); }}>Custom</button>
      </div>
      <span className="small muted" aria-hidden>days</span>
      {custom && (
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (n) onChange(n); }}>
          <NumberInput value={n} onValue={setN} min={1} max={365} integer aria-label="Number of days" style={{ width: 80 }} />
          <Button size="sm" type="submit" disabled={!n || n === days}>Show</Button>
        </form>)}
    </div>
  );
}

export function UpcomingList({ id, scope, query, tz }: { id?: string; scope: string; query: ListQuery; tz?: string }) {
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
    queryFn: () => api<{ items: PMItem[] }>(`/pm/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    enabled: withPM, staleTime: 60_000,
  });
  const groups = useMemo(() => {
    const start = today.getTime(), end = addDays(today, days).getTime();
    const inWin = (s: string | null) => !!s && new Date(s).getTime() >= start && new Date(s).getTime() < end;
    const out: Entry[] = [];
    for (const w of list.data?.pages.flatMap((p) => p.items) ?? []) {
      const when = inWin(w.due_at) ? w.due_at : inWin(w.start_at) ? w.start_at : w.due_at ?? w.start_at;
      if (when) out.push({ day: ymd(new Date(when)), at: new Date(when).getTime(), wo: w });
    }
    if (withPM) for (const it of pm.data?.items ?? []) {
      if (!it.due_at || it.work_order || !["upcoming", "planned"].includes(it.status)) continue;
      out.push({ day: ymd(new Date(it.due_at)), at: new Date(it.due_at).getTime(), pm: it });
    }
    out.sort((a, b) => a.at - b.at);
    const g: [string, Entry[]][] = [];
    for (const e of out) { const last = g[g.length - 1]; if (last && last[0] === e.day) last[1].push(e); else g.push([e.day, [e]]); }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, pm.data, withPM, days, from]);
  const count = groups.reduce((n, [, es]) => n + es.length, 0);
  return (
    <>
      <div className="upcoming-head"><UpcomingWindow days={days} onChange={setDays} />
        <span className="small muted">{list.isLoading ? " " : `${count} in the next ${days} day${days === 1 ? "" : "s"}`}</span></div>
      {list.isLoading ? <ListSkeleton /> : groups.length === 0 ? (
        <EmptyState icon={<CalendarClock size={26} />} title="Nothing coming up">
          {query.filters.length || query.q || scope !== "all" ? "No work orders match. Try clearing filters." : `No work orders or preventive maintenance in the next ${days} days.`}
        </EmptyState>
      ) : groups.map(([day, es]) => (
        <section key={day} className="upcoming-day" aria-label={dayLabel(day, today)}>
          <h3 className={"upcoming-date" + (day === ymd(today) ? " today" : "")}>{dayLabel(day, today)}<span className="faint">{es.length}</span></h3>
          {es.map((e) => e.wo ? <WORow key={e.wo.id} w={e.wo} active={e.wo.id === id} tz={tz} />
            : <PMRow key={e.pm!.plan.id + e.pm!.key} it={e.pm!} />)}
        </section>))}
      {list.hasNextPage && <div style={{ padding: 12, textAlign: "center" }}><Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
      {withPM && pm.isError && <div className="banner warning small">{(pm.error as ApiError).message}</div>}
    </>
  );
}

function PMRow({ it }: { it: PMItem }) {
  const tasks = it.tasks.map((t) => t.name).filter((n) => n && n !== it.plan.name);
  return (
    <Link to={`/preventive-maintenance/${it.plan.id}`} className="list-row wo-row upcoming-pm" role="listitem">
      <div className="grow wo-row-main">
        <div className="row" style={{ gap: 6 }}><Repeat size={14} className="faint" aria-hidden /><span className="t">{it.plan.name}</span></div>
        <div className="s row" style={{ gap: 8 }}><span>Planned preventive maintenance</span>{tasks.length > 0 && <span className="faint">{tasks.join(", ")}</span>}</div>
      </div>
      <div className="wo-row-side"><span className="pill upcoming-pill">Not created yet</span></div>
    </Link>
  );
}
