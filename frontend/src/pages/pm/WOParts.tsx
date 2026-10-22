// Preventive-maintenance pieces that live on work-order screens (0.4.0):
// the form's Repeat control, the detail's recurrence chip, the sub-work-order roll-up and the "close the subs too?" offer.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { CalendarClock, Repeat, SkipForward, StopCircle } from "lucide-react";
import { api, ApiError, type WODetail } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fmtMinutes, money, shortDate } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Modal, Select } from "../../components/ui";
import { ScheduleInput } from "./ScheduleInput";
import type { Recurrence, Rollup, Spec } from "./types";
import "../../styles/pm.css";

// ---- form: Repeat -----------------------------------------------------------------------------------
export type RepeatValue = (Spec & { based_on: "due" | "completion"; days_ahead?: number }) | null;

/** What the form starts with: the work order's current repeat, or "Does not repeat". */
export function repeatFrom(rec: Recurrence | null | undefined): RepeatValue {
  if (!rec || rec.kind !== "repeat" || !rec.active || !("freq" in rec.spec)) return null;
  return { ...(rec.spec as Spec), based_on: rec.interval_mode === "floating" ? "completion" : "due", days_ahead: rec.horizon_days };
}

/** Compact Repeat control for the work-order form. Sub-work orders repeat with their parent; plan work is changed on the plan. */
export function RepeatField({ value, onChange, rec, dueAt, isSub }: {
  value: RepeatValue; onChange: (v: RepeatValue) => void; rec?: Recurrence | null; dueAt?: string | null; isSub?: boolean;
}) {
  if (isSub) return null;
  if (rec && rec.kind === "plan") {
    return <Field label="Repeat" className="full">{() => (
      <span className="small muted row" style={{ gap: 6 }}><CalendarClock size={14} />From maintenance plan <Link to={`/preventive-maintenance/${rec.plan_id}`}>{rec.name}</Link></span>)}</Field>;
  }
  return (
    <Field label="Repeat" className="full" hint={value && !dueAt ? "No due date yet, so the first one is due tomorrow." : undefined}>{(id) => (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <Select id={id} value={value ? "on" : ""} style={{ width: 180 }}
            onChange={(e) => onChange(e.target.value ? { freq: "weekly", interval: 1, based_on: "due" } : null)}>
            <option value="">Does not repeat</option><option value="on">Repeats…</option>
          </Select>
          {value && <Select aria-label="Schedule the next one" value={value.based_on} style={{ width: 230 }}
            onChange={(e) => onChange({ ...value, based_on: e.target.value as "due" | "completion" })}>
            <option value="due">From the due date (fixed)</option><option value="completion">After this one is completed</option>
          </Select>}
        </div>
        {value && <ScheduleInput value={value} anchor={dueAt} floating={value.based_on === "completion"} onChange={(s) => onChange({ ...value, ...s })} />}
      </div>)}</Field>
  );
}

/** Save the Repeat choice after the work order itself is saved. Returns the fresh work order when something changed.
 *  The work order is already saved by then, so a failure is reported through onError instead of failing the save. */
export async function applyRepeat(wo: WODetail, value: RepeatValue | undefined, before: RepeatValue, onError?: (message: string) => void): Promise<WODetail> {
  if (value === undefined || wo.parent_id) return wo;
  if (JSON.stringify(value) === JSON.stringify(before)) return wo;
  try {
    if (value) await api(`/work-orders/${wo.id}/repeat`, { method: "PUT", body: value });
    else if (before) await api(`/work-orders/${wo.id}/repeat`, { method: "DELETE" });
    else return wo;
    return await api<WODetail>(`/work-orders/${wo.id}`);
  } catch (e) {
    onError?.(`Work order #${wo.number} was saved, but its repeat wasn't: ${(e as ApiError).message}`);
    return wo;
  }
}

// ---- detail: recurrence chip ----------------------------------------------------------------------------
export function RecurrenceChip({ wo, editable, onChange }: { wo: WODetail; editable: boolean; onChange: () => void }) {
  const rec = (wo as WODetail & { recurrence?: Recurrence | null }).recurrence;
  const { session, can } = useSession();
  const { toast } = useToast();
  const [ask, setAsk] = useState<null | "skip" | "stop">(null);
  const [reason, setReason] = useState("");
  const tz = session.org?.timezone;
  const act = useMutation({
    mutationFn: (what: "skip" | "stop") => what === "skip"
      ? api(`/work-orders/${wo.id}/repeat/skip-next`, { method: "POST", body: { reason } })
      : api(`/work-orders/${wo.id}/repeat`, { method: "DELETE" }),
    onSuccess: (_r, what) => { setAsk(null); setReason(""); onChange(); toast(what === "skip" ? "Skipped the next one" : "This work order no longer repeats"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!rec) return null;
  const isPlan = rec.kind === "plan";
  const label = isPlan ? rec.name : rec.summary;
  const chip = <span className={"pm-chip" + (rec.active ? "" : " off")}>{isPlan ? <CalendarClock size={13} /> : <Repeat size={13} />}{label}{!rec.active && " (stopped)"}</span>;
  const canAct = editable && rec.kind === "repeat" && rec.active && !wo.parent_id;
  return <>
    {canAct ? (
      <Dropdown align="left" width={260} trigger={(_, t) => <button type="button" className="pm-chip-btn" onClick={t} aria-label={`Repeats: ${label}`}>{chip}</button>}>
        {(close) => <>
          <div className="small muted" style={{ padding: "6px 10px" }}>{rec.next_due_at ? `Next one due ${shortDate(rec.next_due_at, tz)}` : "No next one scheduled"}</div>
          {can("pm.skip") && rec.next_key && <button className="menu-item" onClick={() => { close(); setAsk("skip"); }}><SkipForward size={15} />Skip next</button>}
          <button className="menu-item" onClick={() => { close(); setAsk("stop"); }}><StopCircle size={15} />Stop repeating</button>
        </>}
      </Dropdown>)
      : isPlan ? <Link to={`/preventive-maintenance/${rec.plan_id}`} className="pm-chip-btn" title="Open the maintenance plan">{chip}</Link> : chip}
    {ask && <Modal title={ask === "skip" ? "Skip the next one?" : "Stop repeating?"} onClose={() => setAsk(null)}
      footer={<><Button onClick={() => setAsk(null)}>Back</Button>
        <Button variant={ask === "stop" ? "danger" : "primary"} className={ask === "stop" ? "solid" : ""} disabled={act.isPending || (ask === "skip" && !reason.trim())}
          onClick={() => act.mutate(ask)}>{ask === "skip" ? "Skip it" : "Stop repeating"}</Button></>}>
      {ask === "skip"
        ? <><p>The one due {rec.next_due_at ? shortDate(rec.next_due_at, tz) : "next"} won't be created (or is canceled if it already was). It counts as skipped in PM compliance.</p>
          <Field label="Reason *">{(id) => <textarea id={id} className="textarea" rows={2} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Line down for retooling" />}</Field></>
        : <p>No more copies of “{wo.title}” will be created. This one and the ones already created stay as they are.</p>}
    </Modal>}
  </>;
}

// ---- detail: sub-work order roll-up ------------------------------------------------------------------
export function SubRollup({ wo }: { wo: WODetail }) {
  const { session } = useSession();
  const subs = wo.sub_work_orders.length;
  const q = useQuery({ queryKey: ["wo-rollup", wo.id, wo.version], queryFn: () => api<Rollup>(`/work-orders/${wo.id}/rollup`), enabled: subs > 0 });
  if (!subs || !q.data) return null;
  const r = q.data;
  const cur = session.org?.currency;
  const anyTime = r.total.minutes > 0 || (r.total.total_cents ?? 0) > 0 || r.total.other_cents > 0;
  if (!anyTime) return null;
  return (
    <section className="card">
      <div className="card-head"><h2>Totals with sub-work orders</h2></div>
      <div className="table-wrap"><table className="table pm-rollup">
        <thead><tr><th>Work order</th><th className="num">Time</th><th className="num">Cost</th></tr></thead>
        <tbody>
          <tr><td>This work order</td><td className="num">{fmtMinutes(r.own.minutes)}</td><td className="num">{money(r.own.total_cents, cur)}</td></tr>
          {r.subs.map((s) => <tr key={s.id}><td><Link to={`/work-orders/${s.id}`}>#{s.number} {s.title}</Link></td>
            <td className="num">{fmtMinutes(s.minutes)}</td><td className="num">{money(s.total_cents, cur)}</td></tr>)}
        </tbody>
        <tfoot><tr><td className="t">Total</td><td className="num t">{fmtMinutes(r.total.minutes)}</td><td className="num t">{money(r.total.total_cents, cur)}</td></tr></tfoot>
      </table></div>
    </section>
  );
}

// ---- detail: offer to close open subs when the parent is marked Done ---------------------------------------
export function offerCloseSubs(wo: WODetail, toast: ReturnType<typeof useToast>["toast"], qc: QueryClient) {
  const open = wo.sub_work_orders.filter((s) => s.status !== "done" && s.status !== "canceled").length;
  if (wo.status !== "done" || !open) return;
  toast(`${open} sub-work order${open === 1 ? " is" : "s are"} still open`, {
    action: {
      label: open === 1 ? "Close it" : "Close them",
      run: () => {
        api<{ closed: number[]; failed: { number: number; message: string }[] }>(`/work-orders/${wo.id}/close-subs`, { method: "POST", body: { status: "done" } })
          .then((r) => {
            qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] });
            toast(r.failed.length ? `Closed ${r.closed.length}; #${r.failed[0].number}: ${r.failed[0].message}` : `Closed ${r.closed.length} sub-work order${r.closed.length === 1 ? "" : "s"}`,
              r.failed.length ? { kind: "error" } : undefined);
          })
          .catch((e) => toast((e as ApiError).message, { kind: "error" }));
      },
    },
  });
}
