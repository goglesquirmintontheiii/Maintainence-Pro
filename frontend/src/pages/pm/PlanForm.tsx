// Create / edit a maintenance plan (MP-104): the work order it creates, nested tasks with their own schedules,
// time / meter / whichever-first, fixed or floating, how far ahead work is created, and calendar rules.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Gauge, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { Meter } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { fromLocalInput, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { ProcedurePicker } from "../procedures/Picker";
import { ScheduleInput } from "./ScheduleInput";
import { MONTHS, type Calendar, type Defaults, type Plan, type ScheduleKind, type Spec, type Task } from "./types";

const PRIOS = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]] as const;
const MAX_TASKS = 10;

type Draft = {
  name: string; description: string; asset_id: string | null; location_id: string | null; schedule_kind: ScheduleKind; interval_mode: "fixed" | "floating";
  horizon_days: number; start_offset_days: number; defaults: Defaults; calendar: Calendar; tasks: (Task & { key: string; customRule?: boolean })[];
};

let seq = 0;
const newKey = () => `n${++seq}`;
function tomorrowAt(hhmm = "08:00"): string { const d = new Date(Date.now() + 86400000); return new Date(`${d.toISOString().slice(0, 10)}T${hhmm}`).toISOString(); }
const blankTask = (): Draft["tasks"][number] => ({
  key: newKey(), name: "", spec: { freq: "monthly", interval: 1 }, anchor: tomorrowAt(), meter_id: null, every_units: null, lead_units: null, overrides: {}, procedure_ids: [],
});

function fromPlan(p?: Plan): Draft {
  if (!p) return { name: "", description: "", asset_id: null, location_id: null, schedule_kind: "time", interval_mode: "fixed", horizon_days: 14, start_offset_days: 0,
    defaults: { priority: "medium", assignees: [], categories: [] }, calendar: {}, tasks: [blankTask()] };
  return {
    name: p.name, description: p.description, asset_id: p.asset?.id ?? null, location_id: p.location?.id ?? null, schedule_kind: p.schedule_kind,
    interval_mode: p.interval_mode, horizon_days: p.horizon_days, start_offset_days: p.start_offset_days,
    defaults: { priority: "none", assignees: [], categories: [], ...p.defaults }, calendar: p.calendar ?? {},
    tasks: (p.tasks ?? []).map((t) => ({ ...t, key: t.id ?? newKey(), customRule: !!t.rrule && !("freq" in (t.spec ?? {})) })),
  };
}

export function PlanForm({ edit, onClose, onSaved }: { edit?: Plan; onClose: () => void; onSaved?: (p: Plan) => void }) {
  const { can } = useSession();
  const opts = useWOOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [d, setD] = useState<Draft>(() => fromPlan(edit));
  const [err, setErr] = useState("");
  const set = (patch: Partial<Draft>) => { setErr(""); setD((x) => ({ ...x, ...patch })); };
  const setDef = (patch: Defaults) => set({ defaults: { ...d.defaults, ...patch } });
  const setCal = (patch: Calendar) => set({ calendar: { ...d.calendar, ...patch } });
  const setTask = (i: number, patch: Partial<Draft["tasks"][number]>) => set({ tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const timed = d.schedule_kind !== "usage";
  const usage = d.schedule_kind !== "time";
  const meters = useQuery({
    queryKey: ["meters", "pm-pick", d.asset_id], enabled: usage,
    queryFn: () => api<{ items: Meter[] }>(`/meters?per_page=200${d.asset_id ? `&asset_id=${d.asset_id}` : ""}`),
  });

  const payload = () => ({
    name: d.name.trim(), description: d.description, asset_id: d.asset_id, location_id: d.location_id, schedule_kind: d.schedule_kind,
    interval_mode: d.interval_mode, horizon_days: d.horizon_days, start_offset_days: d.start_offset_days, calendar: d.calendar,
    defaults: { ...d.defaults, title: d.defaults.title?.trim() || undefined, estimated_minutes: d.defaults.estimated_minutes || undefined },
    tasks: d.tasks.map((t) => ({
      ...(t.id ? { id: t.id } : {}), name: t.name.trim(), overrides: t.overrides, procedure_ids: t.procedure_ids,
      ...(timed ? (t.customRule ? { anchor: t.anchor } : { anchor: t.anchor, spec: t.spec }) : { spec: null, rrule: null }),
      ...(usage ? { meter_id: t.meter_id, every_units: t.every_units, lead_units: t.lead_units, ...(t.start_units ? { start_units: t.start_units } : {}) } : { meter_id: null, every_units: null }),
    })),
    ...(edit ? { version: edit.version } : {}),
  });
  const save = useMutation({
    mutationFn: () => edit ? api<Plan>(`/pm/plans/${edit.id}`, { method: "PATCH", body: payload() }) : api<Plan>("/pm/plans", { method: "POST", body: payload() }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["pm-plans"] }); qc.invalidateQueries({ queryKey: ["pm-plan", p.id] }); qc.invalidateQueries({ queryKey: ["pm-calendar"] });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
      toast(edit ? "Plan saved. Changes apply to work that hasn't been created yet." : "Maintenance plan created");
      onClose(); onSaved?.(p);
    },
    onError: (e) => setErr((e as ApiError).status === 409 ? "Someone else changed this plan. Close this panel and edit again." : (e as ApiError).message),
  });
  const missing = useMemo(() => {
    const m: string[] = [];
    if (!d.name.trim()) m.push("name");
    d.tasks.forEach((t, i) => {
      const label = d.tasks.length > 1 ? ` (task ${i + 1})` : "";
      if (timed && !t.anchor) m.push("first due date" + label);
      if (usage && (!t.meter_id || !t.every_units)) m.push("meter and interval" + label);
    });
    return m;
  }, [d, timed, usage]);
  const months = d.calendar.months ?? [];

  return (
    <Drawer title={edit ? `Edit ${edit.name}` : "New maintenance plan"} onClose={onClose} width={680}
      footer={<>
        <span className="small faint grow">{missing.length ? `Still needed: ${missing.join(", ")}` : edit ? "Only future work changes." : ""}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={missing.length > 0 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : edit ? "Save" : "Create plan"}</Button>
      </>}>
      <Field label="Plan name *">{(id) => <Input id={id} value={d.name} maxLength={255} placeholder="e.g. Chiller 1 preventive maintenance" onChange={(e) => set({ name: e.target.value })} />}</Field>
      <Field label="Description">{(id) => <textarea id={id} className="textarea" rows={2} maxLength={4096} value={d.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
      <div className="form-grid">
        {can("assets.view") && <Field label="Asset">{(id) => <AssetPicker id={id} value={d.asset_id ? [d.asset_id] : []} onChange={(v) => set({ asset_id: v[0] ?? null })} />}</Field>}
        {can("locations.view") && <Field label="Location">{(id) => <LocationPicker id={id} value={d.location_id} onChange={(v) => set({ location_id: v })} />}</Field>}
      </div>

      <fieldset className="pm-fs"><legend>Work order it creates</legend>
        <Field label="Title" hint="Leave empty to use the plan and task names.">{(id) => <Input id={id} value={d.defaults.title ?? ""} maxLength={255} placeholder={d.name || "Plan name"} onChange={(e) => setDef({ title: e.target.value })} />}</Field>
        <Field label="Instructions">{(id) => <textarea id={id} className="textarea" rows={2} value={d.defaults.description ?? ""} onChange={(e) => setDef({ description: e.target.value })} />}</Field>
        <div className="form-grid">
          <Field label="Assign to" className="full">{(id) => <AssigneePicker id={id} options={opts.data} value={d.defaults.assignees ?? []} onChange={(v) => setDef({ assignees: v })} />}</Field>
          <Field label="Priority">{() => <PrioritySeg value={d.defaults.priority ?? "none"} onChange={(v) => setDef({ priority: v })} />}</Field>
          <Field label="Estimated time (minutes)">{(id) => <Input id={id} type="number" min={0} step={5} value={d.defaults.estimated_minutes ?? ""} onChange={(e) => setDef({ estimated_minutes: Number(e.target.value) || null })} />}</Field>
          <Field label="Categories">{(id) => <CategoryPicker id={id} options={opts.data} value={d.defaults.categories ?? []} onChange={(v) => setDef({ categories: v })} />}</Field>
          {can("procedures.view") && <Field label="Procedures">{(id) => <ProcedurePicker id={id} value={d.defaults.procedure_ids ?? []} onChange={(v) => setDef({ procedure_ids: v })} />}</Field>}
          {usage && <Field label="Due" hint="For meter-triggered work.">{(id) => <div className="row"><Input id={id} type="number" min={0} max={365} style={{ width: 90 }} value={d.defaults.due_in_days ?? 7}
            onChange={(e) => setDef({ due_in_days: Math.max(0, Number(e.target.value) || 0) })} /><span className="small muted">days after it's created</span></div>}</Field>}
        </div>
      </fieldset>

      <fieldset className="pm-fs"><legend>Schedule</legend>
        <div className="seg" role="radiogroup" aria-label="Schedule by">
          {([["time", "Time", CalendarClock], ["usage", "Meter reading", Gauge], ["time_or_usage", "Whichever comes first", CalendarClock]] as const).map(([k, l, Icon]) => (
            <button type="button" key={k} role="radio" aria-checked={d.schedule_kind === k} className={"seg-btn" + (d.schedule_kind === k ? " on" : "")} onClick={() => set({ schedule_kind: k })}>
              <Icon size={14} />{l}</button>))}
        </div>
        {timed && <Field label="Next visit is planned from">{(id) => <Select id={id} value={d.interval_mode} style={{ maxWidth: 360 }} onChange={(e) => set({ interval_mode: e.target.value as Draft["interval_mode"] })}>
          <option value="fixed">The original schedule (fixed)</option><option value="floating">When the last one was completed (floating)</option></Select>}</Field>}

        <div className="stack pm-task-list">
          {d.tasks.map((t, i) => (
            <div key={t.key} className="pm-task card">
              <div className="row">
                <Input aria-label={`Task ${i + 1} name`} value={t.name} maxLength={255} placeholder={d.tasks.length > 1 ? `Task ${i + 1}, e.g. Quarterly inspection` : "Task name (optional)"}
                  onChange={(e) => setTask(i, { name: e.target.value })} className="grow" />
                {d.tasks.length > 1 && <Button icon variant="ghost" aria-label={`Remove task ${i + 1}`} onClick={() => set({ tasks: d.tasks.filter((_, j) => j !== i) })}><Trash2 size={15} /></Button>}
              </div>
              {timed && <div className="pm-task-grid">
                <Field label="First due">{(id) => <Input id={id} type="datetime-local" value={toLocalInput(t.anchor)} onChange={(e) => setTask(i, { anchor: fromLocalInput(e.target.value) })} />}</Field>
                {t.customRule
                  ? <Field label="Repeats">{() => <span className="small muted">{t.summary || t.rrule} <button type="button" className="linkbtn small" onClick={() => setTask(i, { customRule: false, spec: { freq: "monthly", interval: 1 } })}>Change</button></span>}</Field>
                  : <Field label="Repeats">{() => <ScheduleInput idPrefix={`t${i}`} value={t.spec as Spec} anchor={t.anchor} floating={d.interval_mode === "floating"} onChange={(s) => setTask(i, { spec: s })} />}</Field>}
              </div>}
              {usage && <div className="pm-task-grid three">
                <Field label="Meter">{(id) => <Select id={id} value={t.meter_id ?? ""} onChange={(e) => setTask(i, { meter_id: e.target.value || null })}>
                  <option value="">{meters.isLoading ? "Loading…" : (meters.data?.items.length ?? 0) ? "Pick a meter" : "No meters" + (d.asset_id ? " on this asset" : "")}</option>
                  {meters.data?.items.map((m) => <option key={m.id} value={m.id}>{m.name}{m.asset ? ` · ${m.asset.name}` : ""}{m.last_value !== null ? ` (now ${m.last_value.toLocaleString()} ${m.unit})` : ""}</option>)}</Select>}</Field>
                <Field label="Every">{(id) => <Input id={id} type="number" min={0} value={t.every_units ?? ""} placeholder="e.g. 2000" onChange={(e) => setTask(i, { every_units: Number(e.target.value) || null })} />}</Field>
                <Field label="Create ahead" hint="Units before it's due">{(id) => <Input id={id} type="number" min={0} value={t.lead_units ?? ""} placeholder="0" onChange={(e) => setTask(i, { lead_units: Number(e.target.value) || null })} />}</Field>
              </div>}
              <details className="pm-task-more"><summary className="small">Task details{(t.overrides.priority || t.overrides.estimated_minutes || t.procedure_ids.length) ? " (set)" : ""}</summary>
                <div className="form-grid">
                  <Field label="Priority" hint="The highest priority wins when tasks share a work order.">{(id) => <Select id={id} value={t.overrides.priority ?? ""} onChange={(e) => setTask(i, { overrides: { ...t.overrides, priority: e.target.value || undefined } })}>
                    <option value="">Same as the plan</option>{PRIOS.slice(1).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
                  <Field label="Estimated time (minutes)">{(id) => <Input id={id} type="number" min={0} step={5} value={t.overrides.estimated_minutes ?? ""} onChange={(e) => setTask(i, { overrides: { ...t.overrides, estimated_minutes: Number(e.target.value) || undefined } })} />}</Field>
                  <Field label="Instructions" className="full">{(id) => <textarea id={id} className="textarea" rows={2} value={t.overrides.description ?? ""} onChange={(e) => setTask(i, { overrides: { ...t.overrides, description: e.target.value || undefined } })} />}</Field>
                  {can("procedures.view") && <Field label="Procedures" className="full">{(id) => <ProcedurePicker id={id} value={t.procedure_ids} onChange={(v) => setTask(i, { procedure_ids: v })} />}</Field>}
                </div>
              </details>
            </div>))}
          {d.tasks.length < MAX_TASKS && <div><Button size="sm" onClick={() => set({ tasks: [...d.tasks, blankTask()] })}><Plus size={14} />Add a task</Button>
            <span className="small muted" style={{ marginLeft: 8 }}>e.g. monthly checks, a quarterly inspection and an annual overhaul in one plan</span></div>}
        </div>
      </fieldset>

      <fieldset className="pm-fs"><legend>When work is created</legend>
        <div className="form-grid">
          <Field label="Create work orders" hint="Scheduling window: how far ahead of the due date.">{(id) => <div className="row"><Input id={id} type="number" min={0} max={365} style={{ width: 90 }} value={d.horizon_days}
            onChange={(e) => set({ horizon_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} /><span className="small muted">days ahead</span></div>}</Field>
          <Field label="Start date" hint="Shows in To Do this many days before it's due.">{(id) => <div className="row"><Input id={id} type="number" min={0} max={365} style={{ width: 90 }} value={d.start_offset_days}
            onChange={(e) => set({ start_offset_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} /><span className="small muted">days before due</span></div>}</Field>
        </div>
        {timed && <>
          <Field label="Months" hint={months.length ? "Visits outside these months are skipped (seasonal)." : "All year."}>{() => (
            <div className="pm-months" role="group" aria-label="Months">{MONTHS.map((m, i) => {
              const on = !months.length || months.includes(i + 1);
              return <button type="button" key={m} className={"pm-day" + (on ? " on" : "")} aria-pressed={on}
                onClick={() => { const cur = months.length ? months : MONTHS.map((_, j) => j + 1); const next = on ? cur.filter((x) => x !== i + 1) : [...cur, i + 1].sort((a, b) => a - b);
                  setCal({ months: next.length === 12 ? [] : next.length ? next : cur }); }}>{m}</button>; })}</div>)}</Field>
          <div className="row wrap" style={{ gap: 16 }}>
            <Checkbox checked={!!d.calendar.skip_weekends} onChange={(v) => setCal({ skip_weekends: v })} label="Not on weekends" />
            <Checkbox checked={!!d.calendar.skip_holidays} onChange={(v) => setCal({ skip_holidays: v })} label="Not on holidays" />
            {(d.calendar.skip_weekends || d.calendar.skip_holidays) && <Select aria-label="When it lands on one" value={d.calendar.shift ?? "previous"} style={{ width: 230 }}
              onChange={(e) => setCal({ shift: e.target.value as Calendar["shift"] })}>
              <option value="previous">Move to the workday before</option><option value="next">Move to the workday after</option><option value="skip">Skip that visit</option></Select>}
          </div>
        </>}
      </fieldset>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Drawer>
  );
}

function PrioritySeg({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <div className="seg" role="radiogroup" aria-label="Priority">{PRIOS.map(([k, l]) => (
    <button type="button" key={k} role="radio" aria-checked={value === k} className={"seg-btn prio-" + k + (value === k ? " on" : "")} onClick={() => onChange(k)}>{l}</button>))}</div>;
}
