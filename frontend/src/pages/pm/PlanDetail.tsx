// One maintenance plan: what it creates and when, the next visits (move / reassign / postpone / skip each one) and history.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CalendarClock, CalendarPlus, Gauge, MapPin, MoreHorizontal, Package, Pause, Pencil, Play, Repeat, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { fmtMinutes, fromLocalInput, shortDate, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill } from "../../components/ui";
import { AssigneePicker } from "../../components/pickers";
import { PlanForm } from "./PlanForm";
import { fmtUnits, OCC_LABEL, OCC_TONE, pctLabel, pctTone, usePlan, type Occurrence } from "./types";

const KIND_LABEL = { time: "Time-based", usage: "Meter-based", time_or_usage: "Time or meter, whichever comes first" } as const;

export function PlanDetail({ id }: { id: string }) {
  const q = usePlan(id);
  const { session, can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const tz = session.org?.timezone;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const preview = useQuery({ queryKey: ["pm-preview", id, q.data?.version], queryFn: () => api<{ items: Occurrence[] }>(`/pm/plans/${id}/preview?count=12`), enabled: !!q.data });
  const history = useQuery({ queryKey: ["pm-history", id, q.data?.version], queryFn: () => api<{ items: Occurrence[] }>(`/pm/plans/${id}/history`), enabled: !!q.data });
  const refresh = () => {
    for (const k of ["pm-plan", "pm-preview", "pm-history"]) qc.invalidateQueries({ queryKey: [k, id] });
    qc.invalidateQueries({ queryKey: ["pm-plans"] }); qc.invalidateQueries({ queryKey: ["pm-calendar"] }); qc.invalidateQueries({ queryKey: ["work-orders"] });
  };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const pause = useMutation({
    mutationFn: (on: boolean) => api(`/pm/plans/${id}/${on ? "resume" : "pause"}`, { method: "POST" }),
    onSuccess: (_r, on) => { refresh(); toast(on ? "Plan resumed" : "Plan paused. No new work orders will be created."); }, onError: err,
  });
  const gen = useMutation({
    mutationFn: () => api<{ created: number }>(`/pm/plans/${id}/generate`, { method: "POST" }),
    onSuccess: (r) => { refresh(); toast(r.created ? `Created ${r.created} work order${r.created === 1 ? "" : "s"}` : "Nothing is due within the scheduling window yet"); }, onError: err,
  });
  const del = useMutation({
    mutationFn: () => api(`/pm/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pm-plans"] }); toast("Plan deleted"); nav("/preventive-maintenance"); }, onError: err,
  });

  if (q.isLoading) return <div className="detail"><ListSkeleton rows={8} /></div>;
  if (q.isError || !q.data) return <div className="detail"><EmptyState title="Can't open this plan">{(q.error as ApiError)?.message}</EmptyState></div>;
  const p = q.data;
  const manage = can("pm.manage") && !p.deleted;
  const repeat = p.kind === "repeat";
  const comp = p.compliance;
  return (
    <div className="detail pm-detail">
      <Link to="/preventive-maintenance" className="row small mobile-only"><ArrowLeft size={14} />All plans</Link>
      <div className="wo-head">
        <div className="grow">
          <div className="row small muted" style={{ gap: 6 }}>{repeat ? <><Repeat size={13} />Repeating work order</> : <><CalendarClock size={13} />Maintenance plan</>}</div>
          <h1 className="wo-title">{p.name}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            {p.active ? <Pill tone="success">Active</Pill> : <Pill tone="warning">Paused</Pill>}
            {p.deleted && <Pill tone="danger">Deleted</Pill>}
            <span className="small muted">{p.frequency}</span>
          </div>
        </div>
        {manage && <div className="row">
          {!repeat && <Button onClick={() => setEditing(true)} aria-label="Edit"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          <Button onClick={() => pause.mutate(!p.active)} disabled={pause.isPending}>{p.active ? <><Pause size={15} /><span className="desktop-only">Pause</span></> : <><Play size={15} /><span className="desktop-only">Resume</span></>}</Button>
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={250}>
            {(close) => <>
              <button className="menu-item" disabled={!p.active} onClick={() => { close(); gen.mutate(); }}><CalendarPlus size={15} />Create due work orders now</button>
              {can("pm.delete") && <button className="menu-item danger" onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete plan</button>}
            </>}
          </Dropdown>
        </div>}
      </div>
      {repeat && p.source_work_order_id && <div className="banner info small"><Repeat size={16} /><div className="grow">
        This repeats a work order. Change how often it repeats from the work order's <b>Edit</b> panel.</div>
        <Link to={`/work-orders/${p.source_work_order_id}`} className="linkbtn small">Open work order</Link></div>}
      {p.last_problem && <div className="banner warning small" role="status"><AlertTriangle size={16} /><div className="grow">
        <b>Problem with this plan:</b> {p.last_problem.replace(/\.$/, "")}. Check its details in <b>Edit</b>.</div></div>}
      {p.description && <p className="prewrap">{p.description}</p>}

      <div className="tiles pm-tiles">
        <div className="card tile"><div className="k">Next due</div><div className="v sm">{p.next_due_at ? shortDate(p.next_due_at, tz) : "—"}</div></div>
        <div className="card tile"><div className="k">On time (last 12 months)</div><div className={"v sm " + pctTone(comp?.percent)}>{pctLabel(comp?.percent)}</div>
          {comp && <div className="small muted">{comp.on_time} on time · {comp.late} late · {comp.missed} missed · {comp.skipped} skipped</div>}</div>
        <div className="card tile"><div className="k">Creates work</div><div className="v sm">{p.horizon_days} day{p.horizon_days === 1 ? "" : "s"} ahead</div>
          {p.start_offset_days > 0 && <div className="small muted">Starts {p.start_offset_days} day{p.start_offset_days === 1 ? "" : "s"} before due</div>}</div>
      </div>

      <dl className="meta-grid card card-pad">
        <div><dt>Schedule</dt><dd>{KIND_LABEL[p.schedule_kind]}{p.interval_mode === "floating" ? " · from last completion" : " · fixed dates"}</dd></div>
        {p.asset && <div><dt>Asset</dt><dd><Link to={`/assets/${p.asset.id}`} className="row" style={{ gap: 6 }}><Package size={14} className="faint" />{p.asset.name}</Link></dd></div>}
        {p.location && <div><dt>Location</dt><dd><Link to={`/locations/${p.location.id}`} className="row" style={{ gap: 6 }}><MapPin size={14} className="faint" />{p.location.name}</Link></dd></div>}
        <CalendarRules p={p} />
        {p.defaults.estimated_minutes ? <div><dt>Estimated time</dt><dd>{fmtMinutes(p.defaults.estimated_minutes)}</dd></div> : null}
        <div><dt>Time zone</dt><dd>{p.timezone}</dd></div>
      </dl>

      {!repeat && (p.tasks?.length ?? 0) > 0 && <section className="card">
        <div className="card-head"><h2>Tasks</h2><span className="small muted">Tasks due the same day go on one work order</span></div>
        <ul className="pm-tasks">{p.tasks!.map((t) => (
          <li key={t.id}>
            <div className="t">{t.name || p.name}</div>
            <div className="small muted row wrap" style={{ gap: 10 }}>
              {t.summary && <span className="row" style={{ gap: 4 }}><CalendarClock size={13} />{t.summary}</span>}
              {t.every_units ? <span className="row" style={{ gap: 4 }}><Gauge size={13} />Every {fmtUnits(t.every_units)} · next at {fmtUnits(t.next_units)}</span> : null}
              {t.overrides.priority && <span>Priority {t.overrides.priority}</span>}
              {t.overrides.estimated_minutes ? <span>{fmtMinutes(t.overrides.estimated_minutes)}</span> : null}
              {t.procedure_ids.length > 0 && <span>{t.procedure_ids.length} procedure{t.procedure_ids.length === 1 ? "" : "s"}</span>}
            </div>
          </li>))}</ul>
      </section>}

      <section className="card">
        <div className="card-head"><h2>Upcoming</h2><span className="small muted">Changing one visit leaves the rest of the schedule alone</span></div>
        {preview.isLoading ? <div className="card-body"><ListSkeleton rows={3} /></div>
          : (preview.data?.items.length ?? 0) === 0 ? <div className="card-body small faint">{p.active ? (p.schedule_kind === "usage" ? "Work is created when the meter gets close to the next interval." : "Nothing in the next year.") : "Paused."}</div>
          : <ul className="pm-occ">{preview.data!.items.map((o) => <OccRow key={o.key} planId={id} o={o} manage={manage} onDone={refresh} />)}</ul>}
      </section>

      {(history.data?.items.length ?? 0) > 0 && <section className="card">
        <div className="card-head"><h2>History</h2></div>
        <ul className="pm-occ">{history.data!.items.map((o) => <OccRow key={o.key} planId={id} o={o} manage={false} onDone={refresh} past />)}</ul>
      </section>}

      {editing && <PlanForm edit={p} onClose={() => setEditing(false)} onSaved={() => refresh()} />}
      {confirmDelete && <Modal title={`Delete ${p.name}?`} onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" className="solid" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>No more work orders will be created from this plan. Work orders it already created stay, and so does its compliance history.</p>
      </Modal>}
    </div>
  );
}

function CalendarRules({ p }: { p: { calendar: { months?: number[]; skip_weekends?: boolean; skip_holidays?: boolean; shift?: string } } }) {
  const c = p.calendar;
  const bits: string[] = [];
  if (c.months?.length && c.months.length < 12) bits.push("Only in " + c.months.map((m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]).join(", "));
  const skips = [c.skip_weekends && "weekends", c.skip_holidays && "holidays"].filter(Boolean);
  if (skips.length) bits.push(`Not on ${skips.join(" or ")} (${c.shift === "next" ? "moves to the next workday" : c.shift === "skip" ? "skipped" : "moves to the previous workday"})`);
  if (!bits.length) return null;
  return <div className="span2"><dt>Calendar</dt><dd>{bits.join(" · ")}</dd></div>;
}

type Act = "move" | "reassign" | "postpone" | "skip";

function OccRow({ planId, o, manage, onDone, past }: { planId: string; o: Occurrence; manage: boolean; onDone: () => void; past?: boolean }) {
  const { session, can } = useSession();
  const tz = session.org?.timezone;
  const [act, setAct] = useState<Act | null>(null);
  const closed = ["completed", "skipped", "canceled"].includes(o.status) || (o.work_order && ["done", "canceled"].includes(o.work_order.status));
  const { toast } = useToast();
  const unskip = useMutation({
    mutationFn: () => api(`/pm/plans/${planId}/occurrences/${encodeURIComponent(o.key)}`, { method: "POST", body: { action: "unskip" } }),
    onSuccess: () => { onDone(); toast("Back on the schedule"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const due = o.due_at ? shortDate(o.due_at, tz) : o.due_units !== null ? `at ${fmtUnits(o.due_units)}` : "—";
  return (
    <li className={"pm-occ-row" + (o.status === "skipped" ? " skipped" : "")}>
      <div className="pm-occ-date"><span className="d" title={o.due_at ? dateTime(o.due_at, tz) : undefined}>{due}</span>
        {o.original_due_at && <span className="small faint">was {shortDate(o.original_due_at, tz)}</span>}</div>
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <Pill tone={OCC_TONE[o.status]}>{OCC_LABEL[o.status]}</Pill>
          {o.work_order && <Link to={`/work-orders/${o.work_order.id}`} className="small">#{o.work_order.number}</Link>}
          {o.tasks.filter((t) => t.name).length > 0 && <span className="small muted">{o.tasks.map((t) => t.name).filter(Boolean).join(", ")}</span>}
        </div>
        {o.skip_reason && <div className="small muted">{o.status === "skipped" ? "Skipped" : "Postponed"}: {o.skip_reason}</div>}
        {past && o.completed_at && <div className="small faint">Completed {shortDate(o.completed_at, tz)}</div>}
      </div>
      {manage && !past && (o.status === "skipped"
        ? can("pm.skip") && <Button size="sm" variant="ghost" onClick={() => unskip.mutate()} disabled={unskip.isPending}>Unskip</Button>
        : !closed && o.due_at && <Dropdown trigger={(_, t) => <Button size="sm" icon variant="ghost" aria-label={`Change the visit due ${due}`} onClick={t}><MoreHorizontal size={16} /></Button>} width={200}>
          {(close) => <>
            <button className="menu-item" onClick={() => { close(); setAct("move"); }}>Move to another date</button>
            <button className="menu-item" onClick={() => { close(); setAct("reassign"); }}>Reassign</button>
            {can("pm.skip") && <button className="menu-item" onClick={() => { close(); setAct("postpone"); }}>Postpone</button>}
            {can("pm.skip") && <button className="menu-item danger" onClick={() => { close(); setAct("skip"); }}>Skip</button>}
          </>}
        </Dropdown>)}
      {act && <OccDialog planId={planId} o={o} act={act} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone(); }} />}
    </li>
  );
}

const ACT_TITLE: Record<Act, string> = { move: "Move this visit", reassign: "Reassign this visit", postpone: "Postpone this visit", skip: "Skip this visit" };

function OccDialog({ planId, o, act, onClose, onDone }: { planId: string; o: Occurrence; act: Act; onClose: () => void; onDone: () => void }) {
  const opts = useWOOptions();
  const { toast } = useToast();
  const [due, setDue] = useState(toLocalInput(o.due_at));
  const [who, setWho] = useState<string[]>(o.overrides.assignees ?? []);
  const [reason, setReason] = useState("");
  const needReason = act === "skip" || act === "postpone";
  const m = useMutation({
    mutationFn: () => api(`/pm/plans/${planId}/occurrences/${encodeURIComponent(o.key)}`, { method: "POST", body: {
      action: act, reason: reason || undefined, ...(act === "move" || act === "postpone" ? { due_at: fromLocalInput(due) } : {}), ...(act === "reassign" ? { assignees: who } : {}),
    } }),
    onSuccess: () => { toast(act === "skip" ? "Skipped" : act === "reassign" ? "Reassigned" : "Moved"); onDone(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const ok = (!needReason || reason.trim()) && ((act !== "move" && act !== "postpone") || due);
  return (
    <Modal title={ACT_TITLE[act]} onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Back</Button><Button variant={act === "skip" ? "danger" : "primary"} className={act === "skip" ? "solid" : ""} disabled={!ok || m.isPending} onClick={() => m.mutate()}>
        {act === "skip" ? "Skip visit" : "Save"}</Button></>}>
      {act === "skip" && <p className="small muted">{o.work_order ? `Work order #${o.work_order.number} will be canceled. ` : ""}It counts as skipped in compliance; the rest of the schedule stays.</p>}
      {act === "postpone" && <p className="small muted">Compliance still judges this visit against its original date.</p>}
      {act === "move" && <p className="small muted">Moves only this visit{o.work_order ? ` and work order #${o.work_order.number}` : ""}.</p>}
      {(act === "move" || act === "postpone") && <Field label="New due date">{(id) => <Input id={id} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>}
      {act === "reassign" && <Field label="Assign to">{(id) => <AssigneePicker id={id} options={opts.data} value={who} onChange={setWho} />}</Field>}
      {needReason && <Field label="Reason *">{(id) => <textarea id={id} className="textarea" rows={2} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Parts on back order" />}</Field>}
    </Modal>
  );
}
