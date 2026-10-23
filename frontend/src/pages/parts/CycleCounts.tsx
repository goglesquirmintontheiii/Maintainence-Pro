// Cycle counts (r222): scheduled counts create a work order; counters enter what's on the shelf; finishing the work
// order (or "Apply") records the differences as "count" corrections in the ledger.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck, Download, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, ApiError, type ExportItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWOOptions } from "../../lib/wo";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssigneePicker, MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { usePartOptions, type CountRun, type CycleCount } from "./types";
import "./parts.css";

const SCHEDULES: [string, string][] = [["", "Only when started by hand"], ["FREQ=WEEKLY;BYDAY=MO", "Every week (Monday)"], ["FREQ=MONTHLY;BYMONTHDAY=1", "Every month (1st)"],
  ["FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", "Every 3 months"], ["FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1", "Every year (January 1)"]];
const scheduleLabel = (r: string) => SCHEDULES.find(([k]) => k === r)?.[1] ?? (r ? "Custom schedule" : "Started by hand");

export function CycleCountsPage({ runId }: { runId?: string }) {
  const { can, session } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["cycle-counts"], queryFn: () => api<{ items: CycleCount[] }>("/cycle-counts") });
  const [edit, setEdit] = useState<CycleCount | "new" | null>(null);
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const start = useMutation({ mutationFn: (c: CycleCount) => api<CountRun>(`/cycle-counts/${c.id}/start`, { method: "POST" }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["cycle-counts"] }); toast("Count started. It's on a work order now.", { action: r.work_order_id ? { label: "Open", run: () => nav(`/work-orders/${r.work_order_id}`) } : undefined }); },
    onError: err });
  const del = useMutation({ mutationFn: (c: CycleCount) => api(`/cycle-counts/${c.id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["cycle-counts"] }), onError: err });
  const tz = session.org?.timezone;
  if (runId) return <div className="wo-page"><div className="wo-scroll page-narrow"><Link to="/parts/cycle-counts" className="row small"><ArrowLeft size={14} />Cycle counts</Link><RunPanel runId={runId} /></div></div>;
  return (
    <div className="wo-page"><div className="wo-scroll page-narrow">
      <Link to="/parts" className="row small"><ArrowLeft size={14} />Parts</Link>
      <div className="row" style={{ justifyContent: "space-between", margin: "8px 0 12px" }}>
        <h1>Cycle counts</h1>
        {can("parts.counts") && <Button variant="primary" onClick={() => setEdit("new")}><Plus size={16} />New count</Button>}
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Count part of your stock regularly instead of everything at once. Each count becomes a work order; when it's done, the differences correct the stock.</p>
      {!q.data ? <ListSkeleton rows={3} /> : q.data.items.length === 0 ? <EmptyState icon={<ClipboardCheck size={26} />} title="No cycle counts yet">
        {can("parts.counts") ? "Set one up for a storeroom, a part type or an aisle." : "Counts your team schedules show here."}</EmptyState>
        : <section className="card">{q.data.items.map((c) => (
          <div key={c.id} className="list-row part-count-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="t">{c.name} {!c.active && <Pill>Paused</Pill>}</div>
              <div className="s">{[c.location?.name ?? "Every location", scheduleLabel(c.rrule), c.next_at ? `next ${dateTime(c.next_at, tz)}` : ""].filter(Boolean).join(" · ")}</div>
              {c.last_run && <div className="s">Last: {c.last_run.status === "open" ? "in progress" : c.last_run.status}{" · "}
                <Link to={`/parts/cycle-counts/${c.last_run.id}`}>see counts</Link>{c.last_run.work_order_id && <> · <Link to={`/work-orders/${c.last_run.work_order_id}`}>work order</Link></>}</div>}
            </div>
            {can("parts.counts") && <div className="row" style={{ gap: 4 }}>
              <Button size="sm" onClick={() => start.mutate(c)} disabled={start.isPending}><Play size={14} /><span className="desktop-only">Start now</span></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)}><Pencil size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${c.name}`} onClick={() => del.mutate(c)}><Trash2 size={14} /></Button></div>}
          </div>))}</section>}
      {edit && <CountForm c={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </div></div>
  );
}

function CountForm({ c, onClose }: { c?: CycleCount; onClose: () => void }) {
  const qc = useQueryClient();
  const opts = usePartOptions();
  const wo = useWOOptions();
  const [name, setName] = useState(c?.name ?? "");
  const [loc, setLoc] = useState<string | null>(c?.location?.id ?? null);
  const [mode, setMode] = useState<"all" | "types" | "area">(c?.selection.type_ids?.length ? "types" : c?.selection.area ? "area" : "all");
  const [types, setTypes] = useState<string[]>(c?.selection.type_ids ?? []);
  const [area, setArea] = useState(c?.selection.area ?? "");
  const [rrule, setRrule] = useState(c?.rrule ?? "");
  const [assignees, setAssignees] = useState<string[]>(c?.assignees ?? []);
  const [active, setActive] = useState(c?.active ?? true);
  const [err, setErr] = useState("");
  const selection = mode === "types" ? { type_ids: types } : mode === "area" ? { area } : { all: true };
  const m = useMutation({
    mutationFn: () => api(c ? `/cycle-counts/${c.id}` : "/cycle-counts", { method: c ? "PATCH" : "POST",
      body: { name, location_id: loc, selection, rrule, assignees, active, ...(c && c.rrule !== rrule ? { next_at: null } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cycle-counts"] }); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const custom = rrule && !SCHEDULES.some(([k]) => k === rrule);
  return (
    <Modal title={c ? "Edit cycle count" : "New cycle count"} onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Storeroom bearings" />}</Field>
      <Field label="Location">{() => <LocationPicker value={loc} onChange={setLoc} placeholder="Every location" />}</Field>
      <Field label="What to count">{(id) => <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <option value="all">Every part stocked there</option><option value="types">Parts of some types</option><option value="area">One area or bin</option></Select>}</Field>
      {mode === "types" && <MultiPicker label="Part types" placeholder="Pick part types" value={types} onChange={setTypes}
        options={(opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: <span className="sw lg" style={{ background: t.color }} /> }))} />}
      {mode === "area" && <Input aria-label="Area" value={area} maxLength={120} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Aisle 3" />}
      <Field label="Repeat">{(id) => <Select id={id} value={custom ? "custom" : rrule} onChange={(e) => setRrule(e.target.value === "custom" ? rrule : e.target.value)}>
        {SCHEDULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}{custom && <option value="custom">Custom ({rrule})</option>}</Select>}</Field>
      <Field label="Assign the work order to">{(id) => <AssigneePicker id={id} options={wo.data} value={assignees} onChange={setAssignees} />}</Field>
      <Checkbox checked={active} onChange={setActive} label="Active (start counts on schedule)" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

/** The lines of one count: shown on the count page and in the work order. */
export function RunPanel({ runId, run: given, onChange }: { runId?: string; run?: CountRun; onChange?: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["count-run", runId], queryFn: () => api<CountRun>(`/cycle-count-runs/${runId}`), enabled: !!runId && !given });
  const run = given ?? q.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["count-run"] }); qc.invalidateQueries({ queryKey: ["wo-count"] }); qc.invalidateQueries({ queryKey: ["cycle-counts"] }); onChange?.(); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const apply = useMutation({ mutationFn: () => api<{ corrections: number }>(`/cycle-count-runs/${run!.id}/apply`, { method: "POST" }),
    onSuccess: (r) => { refresh(); toast(r.corrections ? `Stock corrected on ${r.corrections} line${r.corrections === 1 ? "" : "s"}` : "Counts matched. Nothing to correct."); }, onError: err });
  const exp = useMutation({ mutationFn: () => api<ExportItem>(`/cycle-count-runs/${run!.id}/export`, { method: "POST" }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }), onError: err });
  if (!run) return q.isError ? <EmptyState title="Count not found" /> : <ListSkeleton rows={3} />;
  const open = run.status === "open";
  return (
    <section className="card part-run">
      <div className="card-head wrap"><h3 className="sec-h" style={{ margin: 0 }}>Cycle count</h3>
        <span className="row" style={{ gap: 8 }}>
          <span className="small muted">{run.progress.counted} of {run.progress.total} counted</span>
          {!open && <Pill tone={run.status === "done" ? "success" : "neutral"}>{run.status === "done" ? "Applied" : run.status === "canceled" ? "Canceled" : run.status}</Pill>}
          {can("exports.use") && <Button size="sm" variant="ghost" icon aria-label="Export count" onClick={() => exp.mutate()}><Download size={14} /></Button>}
          {open && can("parts.counts") && <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || run.progress.counted === 0}>Apply counts</Button>}
        </span></div>
      <div className="part-run-bar" aria-hidden="true"><span style={{ width: `${run.progress.total ? (100 * run.progress.counted) / run.progress.total : 0}%` }} /></div>
      {run.lines.length === 0 ? <div className="card-body small faint">Nothing matched this count's selection.</div>
        : run.lines.map((l) => <CountLineRow key={l.id} runId={run.id} l={l} open={open} onSaved={refresh} />)}
    </section>
  );
}

function CountLineRow({ runId, l, open, onSaved }: { runId: string; l: CountRun["lines"][number]; open: boolean; onSaved: () => void }) {
  const { can } = useSession();
  const { toast } = useToast();
  const [v, setV] = useState(l.counted ?? "");
  const save = useMutation({
    mutationFn: (counted: string) => api(`/cycle-count-runs/${runId}/lines/${l.id}`, { method: "PUT", body: { counted, note: l.note } }),
    onSuccess: onSaved, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const diff = l.difference !== null && l.difference !== "0" ? l.difference : null;
  return (
    <div className="list-row part-count-line">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t"><Link to={`/parts/${l.part.id}`}>{l.part.name}</Link></div>
        <div className="s">{[l.part.part_number, l.location?.name, l.area, l.expected !== null ? `expected ${l.expected}` : ""].filter(Boolean).join(" · ") || " "}</div>
      </div>
      {diff && <span className={"small " + (diff.startsWith("-") ? "part-out" : "part-in")}>{diff.startsWith("-") ? diff : `+${diff}`}</span>}
      {open && can("parts.use") ? <Input className="part-count-input" aria-label={`Counted ${l.part.name}`} inputMode="decimal" value={v} placeholder="Count"
        onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== (l.counted ?? "")) save.mutate(v); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        : <span className="num">{l.counted ?? "—"}</span>}
    </div>
  );
}
