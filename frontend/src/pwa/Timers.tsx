// Running timers on phones (0.6.0, r090/r316): start, pause, resume and stop, several at once, offline too.
// The bar sits above the bottom tabs and follows the technician around the app.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square, Timer } from "lucide-react";
import { api, ApiError, type WODetail } from "../lib/api";
import { patchCachedWO, queueMutation } from "../lib/offline";
import { useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui";

export type MyTimer = { work_order_id: string; number: number; title: string; started_at: string; paused?: boolean; elapsed_seconds?: number };

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
}

/** Seconds on a timer now, from what the server said and when we heard it. */
export function useTicking(t: { elapsed_seconds?: number; paused?: boolean; started_at: string } | null, fetchedAt: number): number {
  const [, tick] = useState(0);
  useEffect(() => { if (!t || t.paused) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, [t]);
  if (!t) return 0;
  const base = t.elapsed_seconds ?? (Date.now() - Date.parse(t.started_at)) / 1000;
  return t.paused ? base : base + (Date.now() - fetchedAt) / 1000;
}

/** Pause / resume / stop a timer: sent now, or saved on the device with the time it happened. */
export function useTimerActions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const local = (woId: string, fn: (t: MyTimer) => MyTimer | null) => qc.setQueryData<{ items: MyTimer[] }>(["my-timers"], (prev) =>
    prev ? { items: prev.items.map((t) => (t.work_order_id === woId ? fn(t) : t)).filter((t): t is MyTimer => !!t) } : prev);
  const after = (woId: string) => { void qc.invalidateQueries({ queryKey: ["my-timers"] }); void qc.invalidateQueries({ queryKey: ["work-order", woId] }); };
  const run = async (woId: string, number: number, what: "pause" | "resume" | "stop", seconds: number) => {
    const at = new Date().toISOString();
    try {
      const r = what === "stop"
        ? await queueMutation({ method: "DELETE", path: `/work-orders/${woId}/timer?at=${encodeURIComponent(at)}`, label: `#${number}: stop timer`, woId })
        : await queueMutation({ method: "POST", path: `/work-orders/${woId}/timer/${what}`, body: { at }, label: `#${number}: ${what} timer`, woId });
      if (r.queued) {
        local(woId, (t) => what === "stop" ? null : { ...t, paused: what === "pause", elapsed_seconds: seconds, started_at: at });
        toast(what === "stop" ? "Saved on this device. The time is logged when you're back online." : "Saved on this device.");
      } else {
        after(woId);
        if (what === "stop") toast("Time logged");
      }
    } catch (e) {
      toast((e as ApiError).message, { kind: "error" });
    }
  };
  return run;
}

export function RunningTimers() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ["my-timers"], queryFn: async () => ({ ...(await api<{ items: MyTimer[] }>("/me/timers")), at: Date.now() }),
    enabled: can("wo.time"), refetchInterval: 60_000 });
  const items = q.data?.items ?? [];
  useEffect(() => {
    document.querySelector(".shell")?.classList.toggle("has-timers", items.length > 0);
    document.documentElement.style.setProperty("--timers-h", `${items.length * 53}px`);
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div className="timers-bar" aria-label="Running timers">
      {items.map((t) => <TimerRow key={t.work_order_id} t={t} fetchedAt={(q.data as { at?: number } | undefined)?.at ?? Date.now()} />)}
    </div>);
}

function TimerRow({ t, fetchedAt }: { t: MyTimer; fetchedAt: number }) {
  const seconds = useTicking(t, fetchedAt);
  const act = useTimerActions();
  const [busy, setBusy] = useState(false);
  const go = async (what: "pause" | "resume" | "stop") => { setBusy(true); try { await act(t.work_order_id, t.number, what, seconds); } finally { setBusy(false); } };
  return (
    <div className="timer-row">
      <span className={"timer-clock" + (t.paused ? " paused" : "")} aria-label={t.paused ? "Paused" : "Running"}>{clock(seconds)}</span>
      <Link className="t" to={`/work-orders/${t.work_order_id}`}>#{t.number} {t.title}</Link>
      {t.paused
        ? <Button icon variant="ghost" disabled={busy} aria-label={`Resume timer on #${t.number}`} onClick={() => void go("resume")}><Play size={18} /></Button>
        : <Button icon variant="ghost" disabled={busy} aria-label={`Pause timer on #${t.number}`} onClick={() => void go("pause")}><Pause size={18} /></Button>}
      <Button icon variant="ghost" disabled={busy} aria-label={`Stop timer on #${t.number} and log the time`} onClick={() => void go("stop")}><Square size={18} /></Button>
    </div>);
}

type DetailTimer = { user: { id: string }; started_at: string; time_type: string; paused?: boolean; elapsed_seconds?: number };

/** The timer buttons on a work order: Start, then Pause / Resume and Stop (logs the time). Works offline. */
export function WOTimerButtons({ wo, onChange }: { wo: WODetail; onChange: (w?: WODetail) => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const mine = (wo.costs.timers as DetailTimer[]).find((t) => t.user.id === session.user?.id) ?? null;
  useEffect(() => setFetchedAt(Date.now()), [mine?.started_at, mine?.paused, mine?.elapsed_seconds]);
  const seconds = useTicking(mine, fetchedAt);
  const go = async (what: "start" | "pause" | "resume" | "stop") => {
    setBusy(true);
    const at = new Date().toISOString();
    try {
      const r = what === "stop"
        ? await queueMutation<WODetail>({ method: "DELETE", path: `/work-orders/${wo.id}/timer?at=${encodeURIComponent(at)}`, label: `#${wo.number}: stop timer`, woId: wo.id })
        : await queueMutation<WODetail>({ method: "POST", path: `/work-orders/${wo.id}/timer${what === "start" ? "" : "/" + what}`, body: { at }, label: `#${wo.number}: ${what} timer`, woId: wo.id });
      void qc.invalidateQueries({ queryKey: ["my-timers"] });
      if (r.queued) {
        const me = session.user!;
        const next = await patchCachedWO(wo.id, (d) => {
          const others = (d.costs.timers as DetailTimer[]).filter((t) => t.user.id !== me.id);
          const t: DetailTimer | null = what === "stop" ? null : { user: { id: me.id, name: me.name, initials: me.initials } as DetailTimer["user"],
            started_at: at, time_type: mine?.time_type ?? "Work", paused: what === "pause", elapsed_seconds: what === "start" ? 0 : seconds };
          return { ...d, status: what === "start" && d.status === "open" ? "in_progress" : d.status, costs: { ...d.costs, timers: (t ? [...others, t] : others) as WODetail["costs"]["timers"] } };
        });
        if (next) onChange(next);
        toast("Saved on this device. It syncs when you're back online.");
      } else {
        onChange(r.result);
        toast({ start: "Timer started", pause: "Timer paused", resume: "Timer resumed", stop: "Time logged" }[what]);
      }
    } catch (e) {
      toast((e as ApiError).message, { kind: "error" });
    } finally { setBusy(false); }
  };
  if (!mine) return <Button size="sm" className="wo-timer" onClick={() => void go("start")} disabled={busy}><Timer size={14} />Start timer</Button>;
  return <span className="row wo-timer" style={{ gap: 6 }}>
    <span className={"timer-clock" + (mine.paused ? " paused" : "")} aria-label={mine.paused ? "Timer paused" : "Timer running"}>{clock(seconds)}</span>
    {mine.paused
      ? <Button size="sm" onClick={() => void go("resume")} disabled={busy}><Play size={13} />Resume</Button>
      : <Button size="sm" onClick={() => void go("pause")} disabled={busy}><Pause size={13} />Pause</Button>}
    <Button size="sm" variant="primary" onClick={() => void go("stop")} disabled={busy}><Square size={13} />Stop</Button>
  </span>;
}
