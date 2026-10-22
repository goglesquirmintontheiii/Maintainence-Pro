// Automation builder: When (trigger + targets) → How often (sensitivity) → Only if (conditions) → Then (actions),
// with a live plain-language summary from the server (POST /automations/describe).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Clock, Gauge, Mail, Plus, Sparkles, Trash2, Wrench } from "lucide-react";
import { api, ApiError, type Template } from "../../lib/api";
import { useWOOptions, PRIORITY_LABEL } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select, Toggle } from "../../components/ui";
import { AssigneePicker, CategoryPicker, MultiPicker, assigneeOptions } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import {
  ACTION_LABEL, ASSET_STATUS, COND_LABEL, RECURRING, TRIGGER_LABEL, WEEKDAYS, WO_STATUS, emptyDoc, useMeterList,
  type Action, type AssetStatus, type Automation, type AutomationDoc, type Condition, type MeterCondition, type TriggerType,
} from "./types";

const MAX_TARGETS = 250;

export function AutomationBuilder({ edit, init, onClose, onSaved }: {
  edit?: Automation; init?: Partial<AutomationDoc>; onClose: () => void; onSaved: (a: Automation) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [doc, setDoc] = useState<AutomationDoc>(() => {
    if (edit) {
      const { name, description, active, trigger, targets, conditions, actions, sensitivity, rerun_minutes } = edit;
      return { name, description, active, trigger, targets, conditions, actions, sensitivity, rerun_minutes };
    }
    return { ...emptyDoc(init?.trigger?.type ?? "meter_reading"), ...init };
  });
  const [err, setErr] = useState("");
  const set = (p: Partial<AutomationDoc>) => setDoc((d) => ({ ...d, ...p }));
  const kind = doc.trigger.type;

  // live summary, debounced
  const [summary, setSummary] = useState(edit?.summary ?? "");
  const describeKey = JSON.stringify([doc.trigger, doc.targets, doc.conditions, doc.actions, doc.sensitivity]);
  useEffect(() => {
    const ctl = new AbortController();
    const h = setTimeout(() => {
      api<{ summary: string }>("/automations/describe", { method: "POST", body: doc, signal: ctl.signal })
        .then((r) => setSummary(r.summary)).catch(() => undefined);
    }, 300);
    return () => { clearTimeout(h); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describeKey]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...doc, name: doc.name.trim() || autoName(doc) };
      return edit ? api<Automation>(`/automations/${edit.id}`, { method: "PATCH", body }) : api<Automation>("/automations", { method: "POST", body });
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["automations"] }); qc.invalidateQueries({ queryKey: ["automation", a.id] }); qc.invalidateQueries({ queryKey: ["meter"] });
      toast(edit ? "Automation saved" : "Automation created"); onSaved(a);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const switchKind = (k: TriggerType) => {
    if (k === kind) return;
    const fresh = emptyDoc(k);
    // keep actions that still make sense; targets switch between meters and assets so they're cleared
    setDoc((d) => ({ ...d, trigger: fresh.trigger, sensitivity: fresh.sensitivity, targets: [], conditions: d.conditions }));
  };

  return (
    <Drawer title={edit ? "Edit automation" : "New automation"} onClose={onClose} width={640}
      footer={<>
        {err && <span className="small grow" role="alert" style={{ color: "var(--c-danger)" }}>{err}</span>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Saving…" : edit ? "Save" : "Create"}</Button>
      </>}>
      <div className="stack auto-builder">
        <Field label="Name">{(id) => <Input id={id} value={doc.name} maxLength={255} placeholder={autoName(doc) || "e.g. Compressor running hot"} onChange={(e) => set({ name: e.target.value })} />}</Field>

        <div className="auto-summary" aria-live="polite"><Sparkles size={16} aria-hidden="true" /><span>{summary || "Fill in the steps below and a summary appears here."}</span></div>

        <Step n={1} title="When">
          <div className="seg auto-kind" role="radiogroup" aria-label="Trigger">
            {(Object.keys(TRIGGER_LABEL) as TriggerType[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={"seg-btn" + (kind === k ? " on" : "")} onClick={() => switchKind(k)}>
                {k === "meter_reading" ? <Gauge size={14} /> : k === "asset_status" ? <Boxes size={14} /> : <Wrench size={14} />}{TRIGGER_LABEL[k]}</button>))}
          </div>
          <TriggerFields doc={doc} set={set} />
        </Step>

        {kind === "meter_reading" && !RECURRING.includes((doc.trigger as { condition: MeterCondition }).condition) && (
          <Step n={2} title="How often">
            <SensitivityFields doc={doc} set={set} />
          </Step>)}

        <Step n={kind === "meter_reading" && !RECURRING.includes((doc.trigger as { condition: MeterCondition }).condition) ? 3 : 2} title="Only if (optional)">
          <ConditionsFields value={doc.conditions} onChange={(conditions) => set({ conditions })} />
        </Step>

        <Step n={kind === "meter_reading" && !RECURRING.includes((doc.trigger as { condition: MeterCondition }).condition) ? 4 : 3} title="Then">
          <ActionsFields value={doc.actions} kind={kind} onChange={(actions) => set({ actions })} />
          <Field label="Don't run again for the same meter or asset within" hint="Leave empty to run every time it triggers.">
            {(id) => <MinutesInput id={id} value={doc.rerun_minutes} onChange={(rerun_minutes) => set({ rerun_minutes })} />}
          </Field>
        </Step>

        <Toggle checked={doc.active} onChange={(active) => set({ active })} label="On" hint="Turned-off automations keep their history but don't run." />
        <Field label="Notes (optional)">{(id) => <textarea id={id} className="textarea" rows={2} maxLength={4000} value={doc.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}

function autoName(doc: AutomationDoc): string {
  const a = doc.actions[0];
  if (a?.type === "create_work_order" && a.title) return a.title.replace(/\{\w+\}/g, "").trim();
  if (a?.type === "send_email" && a.subject) return a.subject.replace(/\{\w+\}/g, "").trim();
  return "";
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="auto-step" aria-label={title}>
      <h3 className="auto-step-h"><span className="auto-step-n" aria-hidden="true">{n}</span>{title}</h3>
      <div className="stack">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- trigger
function TriggerFields({ doc, set }: { doc: AutomationDoc; set: (p: Partial<AutomationDoc>) => void }) {
  const t = doc.trigger;
  const meters = useMeterList();
  const opts = useWOOptions();
  const unit = useMemo(() => meters.data?.items.find((m) => m.id === doc.targets[0])?.unit ?? "", [meters.data, doc.targets]);
  const meterOpts = useMemo(() => (meters.data?.items ?? []).map((m) => ({
    key: m.id, label: m.name, sub: [m.asset?.name, m.unit].filter(Boolean).join(" · "), icon: <Gauge size={14} className="faint" />,
  })), [meters.data]);
  const tooMany = doc.targets.length > MAX_TARGETS;
  if (t.type === "meter_reading") {
    const rec = RECURRING.includes(t.condition);
    return <>
      <Field label="Meters" hint={`Up to ${MAX_TARGETS}. Each meter is tracked on its own.`} error={tooMany ? `Pick ${MAX_TARGETS} or fewer.` : undefined}>
        {(id) => <MultiPicker id={id} label="Meters" placeholder="Pick meters" options={meterOpts} value={doc.targets} onChange={(targets) => set({ targets })}
          searchPlaceholder="Search meters"
          renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip"><Gauge size={12} />{s.label}</span>)}</span>} />}
      </Field>
      <div className="auto-grid">
        <Field label="Reading">{(id) => (
          <Select id={id} value={t.condition} onChange={(e) => {
            const condition = e.target.value as MeterCondition;
            set({ trigger: { ...t, condition }, sensitivity: RECURRING.includes(condition) ? {} : doc.sensitivity.mode ? doc.sensitivity : { mode: "once" } });
          }}>{(Object.keys(COND_LABEL) as MeterCondition[]).map((c) => <option key={c} value={c}>{COND_LABEL[c]}</option>)}</Select>)}</Field>
        <Field label={rec ? "Every" : t.condition.endsWith("_from_last") ? "Amount" : "Value"}>{(id) => (
          <span className="auto-unit"><Input id={id} type="number" step="any" inputMode="decimal" value={String(t.value ?? "")} onChange={(e) => set({ trigger: { ...t, value: e.target.value } })} />
            {unit && <span className="small muted">{unit}</span>}</span>)}</Field>
        {rec && <Field label="Starting at" hint="The first reading that triggers it. Empty = one step from now.">{(id) => (
          <Input id={id} type="number" step="any" inputMode="decimal" value={String(t.first_at ?? "")} onChange={(e) => set({ trigger: { ...t, first_at: e.target.value } })} />)}</Field>}
      </div>
    </>;
  }
  const statuses = t.type === "asset_status" ? ASSET_STATUS : WO_STATUS;
  const sOpts = Object.entries(statuses).map(([k, l]) => ({ key: k, label: l }));
  return <>
    <Field label={t.type === "asset_status" ? "Assets" : "Work orders on these assets"} hint={`Leave empty for all. Up to ${MAX_TARGETS}.`} error={tooMany ? `Pick ${MAX_TARGETS} or fewer.` : undefined}>
      {(id) => <AssetPicker id={id} multi value={doc.targets} onChange={(targets) => set({ targets })} placeholder={t.type === "asset_status" ? "Any asset" : "Any asset"} />}
    </Field>
    <div className="auto-grid">
      <Field label="From">{(id) => <MultiPicker id={id} label="From" placeholder="Any status" options={sOpts} value={t.from}
        onChange={(v) => set({ trigger: { ...t, from: v } as typeof t })} />}</Field>
      <Field label="To">{(id) => <MultiPicker id={id} label="To" placeholder="Any status" options={sOpts} value={t.to}
        onChange={(v) => set({ trigger: { ...t, to: v } as typeof t })} />}</Field>
    </div>
    {t.type === "work_order_status" && <div className="auto-grid">
      <Field label="Priority">{(id) => <MultiPicker id={id} label="Priority" placeholder="Any priority" options={Object.entries(PRIORITY_LABEL).map(([k, l]) => ({ key: k, label: l }))}
        value={t.priorities} onChange={(priorities) => set({ trigger: { ...t, priorities } })} />}</Field>
      <Field label="Category">{(id) => <CategoryPicker id={id} options={opts.data} value={t.categories} onChange={(categories) => set({ trigger: { ...t, categories } })} />}</Field>
    </div>}
  </>;
}

// ---------------------------------------------------------------- sensitivity
function SensitivityFields({ doc, set }: { doc: AutomationDoc; set: (p: Partial<AutomationDoc>) => void }) {
  const s = doc.sensitivity;
  const mode = s.mode ?? "once";
  const modes = [
    ["once", "Once, then again after a reading back in range"],
    ["every", "Every reading that matches"],
    ["n_of_m", "When enough of the last readings match"],
    ["duration", "When it stays that way for a while"],
  ] as const;
  return <>
    <div className="auto-radios" role="radiogroup" aria-label="How often">
      {modes.map(([k, l]) => (
        <label key={k} className={"auto-radio" + (mode === k ? " on" : "")}>
          <input type="radio" name="sens" checked={mode === k} onChange={() => set({ sensitivity: k === "n_of_m" ? { mode: k, n: s.n ?? 3, m: s.m ?? 5 } : k === "duration" ? { mode: k, minutes: s.minutes ?? 30 } : { mode: k } })} />{l}
        </label>))}
    </div>
    {mode === "n_of_m" && <div className="row wrap small" style={{ gap: 6 }}>
      <Input aria-label="Readings that must match" type="number" min={1} max={50} style={{ width: 70 }} value={s.n ?? ""} onChange={(e) => set({ sensitivity: { ...s, n: Number(e.target.value) || undefined } })} />
      <span>of the last</span>
      <Input aria-label="Readings to look at" type="number" min={1} max={50} style={{ width: 70 }} value={s.m ?? ""} onChange={(e) => set({ sensitivity: { ...s, m: Number(e.target.value) || undefined } })} />
      <span>readings</span></div>}
    {mode === "duration" && <div className="row wrap small" style={{ gap: 6 }}><span>For longer than</span>
      <MinutesInput value={s.minutes ?? 0} onChange={(minutes) => set({ sensitivity: { ...s, minutes } })} label="Duration" /></div>}
  </>;
}

// ---------------------------------------------------------------- conditions
function ConditionsFields({ value, onChange }: { value: Condition[]; onChange: (v: Condition[]) => void }) {
  const upd = (i: number, c: Condition) => onChange(value.map((x, j) => (j === i ? c : x)));
  const has = (t: Condition["type"]) => value.some((c) => c.type === t);
  return <>
    {value.length === 0 && <div className="small faint">Runs whenever the trigger happens. Add a condition to narrow it down.</div>}
    {value.map((c, i) => (
      <div key={i} className="auto-cond">
        <span className="auto-cond-k small">{c.type === "asset_status" ? "Asset is" : c.type === "weekday" ? "Day is" : "Time is between"}</span>
        <div className="grow">
          {c.type === "asset_status" && <MultiPicker label="Asset status" placeholder="Pick statuses" options={Object.entries(ASSET_STATUS).map(([k, l]) => ({ key: k, label: l }))}
            value={c.in} onChange={(v) => upd(i, { ...c, in: v as AssetStatus[] })} />}
          {c.type === "weekday" && <div className="auto-days" role="group" aria-label="Weekdays">{WEEKDAYS.map((d, n) => (
            <button key={d} type="button" aria-pressed={c.days.includes(n)} className={"auto-day" + (c.days.includes(n) ? " on" : "")}
              onClick={() => upd(i, { ...c, days: c.days.includes(n) ? c.days.filter((x) => x !== n) : [...c.days, n].sort() })}>{d}</button>))}</div>}
          {c.type === "time_window" && <div className="row" style={{ gap: 6 }}>
            <Input type="time" aria-label="From" value={c.from} onChange={(e) => upd(i, { ...c, from: e.target.value })} style={{ width: 130 }} />
            <span className="small">and</span>
            <Input type="time" aria-label="To" value={c.to} onChange={(e) => upd(i, { ...c, to: e.target.value })} style={{ width: 130 }} />
            <span className="small faint desktop-only">org time</span></div>}
        </div>
        <Button size="sm" variant="ghost" icon aria-label="Remove condition" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
      </div>))}
    {value.length < 10 && <div className="row wrap" style={{ gap: 6 }}>
      {!has("asset_status") && <Button size="sm" onClick={() => onChange([...value, { type: "asset_status", in: ["online"] }])}><Plus size={14} />Asset status</Button>}
      {!has("weekday") && <Button size="sm" onClick={() => onChange([...value, { type: "weekday", days: [0, 1, 2, 3, 4] }])}><Plus size={14} />Weekdays</Button>}
      {!has("time_window") && <Button size="sm" onClick={() => onChange([...value, { type: "time_window", from: "07:00", to: "17:00" }])}><Clock size={14} />Time of day</Button>}
    </div>}
  </>;
}

// ---------------------------------------------------------------- actions
function ActionsFields({ value, kind, onChange }: { value: Action[]; kind: TriggerType; onChange: (v: Action[]) => void }) {
  const upd = (i: number, a: Action) => onChange(value.map((x, j) => (j === i ? a : x)));
  const add = (t: Action["type"]) => onChange([...value, t === "create_work_order" ? { type: t, title: "", priority: "medium" }
    : t === "change_asset_status" ? { type: t, status: "offline", downtime_type: "unplanned" } : { type: t, recipients: [], subject: "" }]);
  const ph = kind === "meter_reading" ? "{meter} {value} {unit} {asset}" : kind === "asset_status" ? "{asset} {status}" : "{work_order} {asset} {status}";
  return <>
    {value.map((a, i) => (
      <div key={i} className="card auto-action">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b className="row" style={{ gap: 6 }}>{a.type === "create_work_order" ? <Wrench size={15} /> : a.type === "send_email" ? <Mail size={15} /> : <Boxes size={15} />}{ACTION_LABEL[a.type]}</b>
          {value.length > 1 && <Button size="sm" variant="ghost" icon aria-label={`Remove ${ACTION_LABEL[a.type]}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>}
        </div>
        {a.type === "create_work_order" && <WOAction a={a} ph={ph} onChange={(x) => upd(i, x)} />}
        {a.type === "change_asset_status" && <div className="auto-grid">
          <Field label="Set the asset to">{(id) => <Select id={id} value={a.status} onChange={(e) => upd(i, { ...a, status: e.target.value as AssetStatus, downtime_type: e.target.value === "offline" ? a.downtime_type || "unplanned" : "" })}>
            {Object.entries(ASSET_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          {a.status === "offline" && <Field label="Downtime">{(id) => <Select id={id} value={a.downtime_type || "unplanned"} onChange={(e) => upd(i, { ...a, downtime_type: e.target.value as "planned" | "unplanned" })}>
            <option value="unplanned">Unplanned</option><option value="planned">Planned</option></Select>}</Field>}
          <Field label="Reason (optional)">{(id) => <Input id={id} maxLength={80} value={a.reason ?? ""} onChange={(e) => upd(i, { ...a, reason: e.target.value })} />}</Field>
          {kind === "meter_reading" || kind === "asset_status" ? null : <div className="small faint" style={{ alignSelf: "end" }}>Uses the work order's asset.</div>}
        </div>}
        {a.type === "send_email" && <EmailAction a={a} ph={ph} onChange={(x) => upd(i, x)} />}
        <Field label="Then wait before doing this again" hint="Per meter or asset. Empty = no wait.">
          {(id) => <MinutesInput id={id} value={a.rerun_minutes ?? 0} onChange={(rerun_minutes) => upd(i, { ...a, rerun_minutes })} />}</Field>
      </div>))}
    {value.length < 5 && <div className="row wrap" style={{ gap: 6 }}>
      <Button size="sm" onClick={() => add("create_work_order")}><Plus size={14} />Work order</Button>
      <Button size="sm" onClick={() => add("change_asset_status")}><Plus size={14} />Asset status</Button>
      <Button size="sm" onClick={() => add("send_email")}><Plus size={14} />Email</Button>
    </div>}
  </>;
}

function WOAction({ a, ph, onChange }: { a: Extract<Action, { type: "create_work_order" }>; ph: string; onChange: (a: Action) => void }) {
  const opts = useWOOptions();
  const tpls = useQuery({ queryKey: ["wo-templates"], queryFn: () => api<{ items: Template[] }>("/work-order-templates") });
  return <>
    <Field label="From a template (optional)">{(id) => <Select id={id} value={a.template_id ?? ""} onChange={(e) => onChange({ ...a, template_id: e.target.value || undefined })}>
      <option value="">No template</option>{(tpls.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
    <Field label={a.template_id ? "Title (overrides the template)" : "Title"} hint={`You can use ${ph}.`}>
      {(id) => <Input id={id} maxLength={255} value={a.title ?? ""} placeholder={a.template_id ? "Template title" : "e.g. Check {meter}: {value} {unit}"} onChange={(e) => onChange({ ...a, title: e.target.value })} />}</Field>
    <Field label="Description (optional)">{(id) => <textarea id={id} className="textarea" rows={2} maxLength={4000} value={a.description ?? ""} onChange={(e) => onChange({ ...a, description: e.target.value })} />}</Field>
    <div className="auto-grid">
      <Field label="Priority">{(id) => <Select id={id} value={a.priority ?? ""} onChange={(e) => onChange({ ...a, priority: e.target.value || undefined })}>
        {a.template_id && <option value="">From the template</option>}
        {Object.entries(PRIORITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
      <Field label="Due in (days)">{(id) => <Input id={id} type="number" min={0} max={3650} value={a.due_in_days ?? ""} placeholder="No due date"
        onChange={(e) => onChange({ ...a, due_in_days: e.target.value === "" ? "" : Number(e.target.value) })} />}</Field>
    </div>
    <Field label="Assign to">{(id) => <AssigneePicker id={id} options={opts.data} value={a.assignees ?? []} onChange={(assignees) => onChange({ ...a, assignees })} />}</Field>
    <Field label="Categories">{(id) => <CategoryPicker id={id} options={opts.data} value={a.categories ?? []} onChange={(categories) => onChange({ ...a, categories })} />}</Field>
    <div className="small faint">The work order goes on the meter's or asset's own asset and location. A new one isn't created while the last one is still open.</div>
  </>;
}

function EmailAction({ a, ph, onChange }: { a: Extract<Action, { type: "send_email" }>; ph: string; onChange: (a: Action) => void }) {
  const opts = useWOOptions();
  const people = useMemo(() => assigneeOptions(opts.data), [opts.data]);
  return <>
    <Field label="To">{(id) => <MultiPicker id={id} label="Recipients" placeholder="Pick people or teams" options={people} value={a.recipients}
      onChange={(recipients) => onChange({ ...a, recipients })} searchPlaceholder="Search people and teams"
      renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />}</Field>
    <Field label="Subject" hint={`You can use ${ph}.`}>{(id) => <Input id={id} maxLength={200} value={a.subject} placeholder="e.g. {meter} is at {value} {unit}" onChange={(e) => onChange({ ...a, subject: e.target.value })} />}</Field>
    <Field label="Message (optional)" hint="Empty sends the automation's summary.">{(id) => <textarea id={id} className="textarea" rows={3} maxLength={5000} value={a.body ?? ""} onChange={(e) => onChange({ ...a, body: e.target.value })} />}</Field>
  </>;
}

// ---------------------------------------------------------------- minutes
const UNITS = [[1, "minutes"], [60, "hours"], [1440, "days"]] as const;

export function MinutesInput({ value, onChange, id, label = "Interval" }: { value: number; onChange: (v: number) => void; id?: string; label?: string }) {
  const best = UNITS.slice().reverse().find(([f]) => value && value % f === 0)?.[0] ?? 60;
  const [unit, setUnit] = useState<number>(value ? best : 60);
  const shown = value ? String(value / unit) : "";
  return (
    <span className="row" style={{ gap: 6 }}>
      <Input id={id} aria-label={label} type="number" min={0} step="any" style={{ width: 90 }} value={shown} placeholder="—"
        onChange={(e) => onChange(e.target.value === "" ? 0 : Math.max(0, Math.round(Number(e.target.value) * unit)))} />
      <Select aria-label={`${label} unit`} value={unit} style={{ width: 110 }} onChange={(e) => { const u = Number(e.target.value); setUnit(u); if (value) onChange(Math.round((value / unit) * u)); }}>
        {UNITS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}</Select>
    </span>
  );
}

