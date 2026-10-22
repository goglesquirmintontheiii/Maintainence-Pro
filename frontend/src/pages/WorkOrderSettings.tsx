// Settings → Work orders: rules, required fields, time and cost types, sub-statuses, custom fields, templates and numbering.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { api, ApiError, type CustomFieldDef, type Template, type WOSettings } from "../lib/api";
import { useSession } from "../lib/session";
import { money, useWOOptions } from "../lib/wo";
import { useToast } from "../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../components/ui";
import { AssigneePicker, CategoryPicker } from "../components/pickers";
import { AssetPicker, LocationPicker } from "../components/assetPickers";

const REQUIRABLE: [string, string][] = [["description", "Description"], ["due_date", "Due date"], ["priority", "Priority"], ["categories", "Categories"],
  ["assignees", "Assignees"], ["attachment", "A picture or file"], ["estimated_time", "Estimated time"]];
const RULES = [["none", "Don't ask"], ["optional", "Optional"], ["mandatory", "Required"]] as const;
const FIELD_TYPES: [CustomFieldDef["type"], string][] = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
  ["date", "Date"], ["datetime", "Date and time"], ["checkbox", "Checkbox"], ["link", "Link (URL or phone)"]];

function useSettings() { return useQuery({ queryKey: ["wo-settings"], queryFn: () => api<WOSettings>("/work-orders/settings") }); }

export function WorkOrderSettings() {
  const { can, session } = useSession();
  const s = useSettings();
  const qc = useQueryClient();
  const { toast } = useToast();
  const ro = !can("wo.settings");
  const save = useMutation({
    mutationFn: (b: Partial<WOSettings>) => api<WOSettings>("/work-orders/settings", { method: "PATCH", body: b }),
    onSuccess: (x) => { qc.setQueryData(["wo-settings"], x); qc.invalidateQueries({ queryKey: ["wo-options"] }); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!s.data) return <ListSkeleton rows={6} />;
  const v = s.data;
  const set = (b: Partial<WOSettings>) => save.mutate(b);
  return (
    <div className="stack" style={{ gap: 20 }}>
      {ro && <div className="banner info">Only administrators can change work order settings. You can see how they're set up.</div>}
      <section className="card">
        <div className="card-head"><h2>Completing work</h2></div>
        <div className="card-body stack">
          <Toggle label="Require a signature" hint="Ask for a signature when someone marks a work order Done." checked={v.require_signature} disabled={ro} onChange={(x) => set({ require_signature: x })} />
          <Toggle label="Require approval" hint="Work completed by technicians waits for an administrator to approve it or send it back." checked={v.require_approval} disabled={ro} onChange={(x) => set({ require_approval: x })} />
          <Toggle label="Require logged time" checked={v.require_time_to_complete} disabled={ro} onChange={(x) => set({ require_time_to_complete: x })} />
          <Toggle label="Require a cost entry" checked={v.require_cost_to_complete} disabled={ro} onChange={(x) => set({ require_cost_to_complete: x })} />
          <div className="form-grid">
            <Field label="Completion summary">{(id) => <Select id={id} value={v.completion_summary} disabled={ro} onChange={(e) => set({ completion_summary: e.target.value as WOSettings["completion_summary"] })}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Comment when putting on hold">{(id) => <Select id={id} value={v.comment_on_hold} disabled={ro} onChange={(e) => set({ comment_on_hold: e.target.value as WOSettings["comment_on_hold"] })}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Reason when canceling">{(id) => <Select id={id} value={v.comment_on_cancel} disabled={ro} onChange={(e) => set({ comment_on_cancel: e.target.value as WOSettings["comment_on_cancel"] })}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2>Required fields</h2><span className="small muted">Must be filled in to create or save a work order</span></div>
        <div className="card-body check-grid">{REQUIRABLE.map(([k, l]) => <Checkbox key={k} label={l} disabled={ro} checked={v.required_fields.includes(k)}
          onChange={(c) => set({ required_fields: c ? [...v.required_fields, k] : v.required_fields.filter((x) => x !== k) })} />)}</div>
      </section>
      <section className="card">
        <div className="card-head"><h2>To Do and comments</h2></div>
        <div className="card-body stack">
          <Toggle label="To Do by start date only" hint="When on, work stays out of To Do until its start date, even if it's nearly due or overdue." checked={v.todo_by_start_date_only} disabled={ro} onChange={(x) => set({ todo_by_start_date_only: x })} />
          <Toggle label="Mentions assign" hint="People and teams @mentioned in a comment are added as assignees." checked={v.mention_assigns} disabled={ro} onChange={(x) => set({ mention_assigns: x })} />
          <div className="form-grid">
            <Field label="Default start time" hint="Used when you pick only a date.">{(id) => <Input id={id} type="time" disabled={ro} defaultValue={v.default_start_time} onBlur={(e) => e.target.value !== v.default_start_time && set({ default_start_time: e.target.value })} />}</Field>
            <Field label="Default due time">{(id) => <Input id={id} type="time" disabled={ro} defaultValue={v.default_due_time} onBlur={(e) => e.target.value !== v.default_due_time && set({ default_due_time: e.target.value })} />}</Field>
            <Field label="Hours in a work day" hint="Capacity in the Workload view.">{(id) => <Input id={id} type="number" min={1} max={24} step={0.5} disabled={ro} defaultValue={v.workday_minutes / 60}
              onBlur={(e) => { const m = Math.round(Number(e.target.value) * 60); if (m && m !== v.workday_minutes) set({ workday_minutes: m }); }} />}</Field>
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2>Time, costs and rates</h2></div>
        <div className="card-body stack">
          <div className="form-grid">
            <ListEditor label="Time types" items={v.time_types} disabled={ro} onChange={(x) => set({ time_types: x })} />
            <ListEditor label="Cost types" items={v.cost_types} disabled={ro} onChange={(x) => set({ cost_types: x })} />
          </div>
          {v.default_hourly_rate_cents !== null && <div className="form-grid">
            <Field label={`Default hourly rate (${session.org?.currency ?? "USD"})`} hint="Used for anyone without their own rate. Set personal rates on each person's page.">{(id) => (
              <Input id={id} type="number" min={0} step="0.01" disabled={ro} defaultValue={(v.default_hourly_rate_cents ?? 0) / 100}
                onBlur={(e) => { const c = Math.round(Number(e.target.value) * 100); if (c !== v.default_hourly_rate_cents) set({ default_hourly_rate_cents: c }); }} />)}</Field>
            <div className="field"><span className="label">Now</span><span>{money(v.default_hourly_rate_cents, session.org?.currency)} an hour</span></div>
          </div>}
          <Toggle label="Everyone can see labor costs" hint="Off: only administrators and limited administrators see rates and labor cost." checked={v.rates_visible_to_all} disabled={ro} onChange={(x) => set({ rates_visible_to_all: x })} />
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2>Sub-statuses</h2><span className="small muted">Extra detail that rolls up to the four MaintainX statuses</span></div>
        <div className="card-body form-grid">{(["open", "on_hold", "in_progress", "done"] as const).map((st) => (
          <ListEditor key={st} label={{ open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done" }[st]} items={v.sub_statuses[st] ?? []} allowEmpty disabled={ro}
            onChange={(x) => set({ sub_statuses: { ...v.sub_statuses, [st]: x } })} />))}</div>
      </section>
      <CustomFields ro={ro} />
      <Templates />
      <Numbering next={v.next_number} ro={ro} />
    </div>
  );
}

function ListEditor({ label, items, onChange, disabled, allowEmpty }: { label: string; items: string[]; onChange: (x: string[]) => void; disabled?: boolean; allowEmpty?: boolean }) {
  const [add, setAdd] = useState("");
  return (
    <div className="field"><span className="label">{label}</span>
      <div className="row wrap">{items.map((t) => <span key={t} className="chip">{t}{!disabled && (allowEmpty || items.length > 1) &&
        <button type="button" className="linkbtn" aria-label={`Remove ${t}`} onClick={() => onChange(items.filter((x) => x !== t))}><X size={12} /></button>}</span>)}
        {!items.length && <span className="small faint">None</span>}</div>
      {!disabled && <div className="row"><Input value={add} placeholder={`Add ${label.toLowerCase().replace(/s$/, "")}`} aria-label={`Add to ${label}`} onChange={(e) => setAdd(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { onChange([...items, add.trim()]); setAdd(""); } }} />
        <Button size="sm" disabled={!add.trim()} onClick={() => { onChange([...items, add.trim()]); setAdd(""); }}>Add</Button></div>}
    </div>
  );
}

function CustomFields({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const data = useQuery({ queryKey: ["custom-fields"], queryFn: () => api<{ items: CustomFieldDef[] }>("/custom-fields") });
  const [edit, setEdit] = useState<CustomFieldDef | "new" | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["custom-fields"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const del = useMutation({ mutationFn: (f: CustomFieldDef) => api(`/custom-fields/${f.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Field deleted"); }, onError: err });
  const order = useMutation({ mutationFn: (ids: string[]) => api("/custom-fields/reorder", { method: "POST", body: { ids } }), onSuccess: done, onError: err });
  const items = data.data?.items ?? [];
  const move = (i: number, d: number) => { const ids = items.map((f) => f.id); const [x] = ids.splice(i, 1); ids.splice(i + d, 0, x); order.mutate(ids); };
  return (
    <section className="card">
      <div className="card-head"><h2>Custom fields</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add field</Button>}</div>
      {items.length === 0 ? <div className="card-body small faint">Add your own fields, like a downtime cause or a cost center. They show on every work order, in filters, the table and exports.</div> : items.map((f, i) => (
        <div key={f.id} className="list-row" style={{ borderLeft: 0 }}>
          <div className="grow"><div className="t">{f.name} {f.required && <Pill tone="warning">Required</Pill>}</div>
            <div className="s">{FIELD_TYPES.find(([k]) => k === f.type)?.[1]}{f.type === "select" ? `: ${f.options.join(", ")}` : ""}</div></div>
          {!ro && <>
            <Button size="sm" variant="ghost" icon aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Edit ${f.name}`} onClick={() => setEdit(f)}><Pencil size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Delete ${f.name}`} onClick={() => del.mutate(f)}><Trash2 size={14} /></Button></>}
        </div>))}
      {edit && <FieldModal field={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={done} />}
    </section>
  );
}

function FieldModal({ field, onClose, onDone }: { field?: CustomFieldDef; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false,
    copy_on_repeat: field?.copy_on_repeat ?? true, on_request_form: field?.on_request_form ?? false });
  const [err, setErr] = useState("");
  const body = () => ({ ...f, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean) });
  const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
    onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={field ? "Edit field" : "New field"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Downtime cause" />}</Field>
      <Field label="Type" hint={field ? "A field's type can't change. Make a new field instead." : undefined}>{(id) => <Select id={id} value={f.type} disabled={!!field} onChange={(e) => setF({ ...f, type: e.target.value as CustomFieldDef["type"] })}>
        {FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
      {f.type === "select" && <Field label="Options (one per line)">{(id) => <textarea id={id} className="textarea" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} />}</Field>}
      <Checkbox checked={f.required} onChange={(x) => setF({ ...f, required: x })} label="Required" />
      <Checkbox checked={f.copy_on_repeat} onChange={(x) => setF({ ...f, copy_on_repeat: x })} label="Copy the value to repeating work orders (0.4.0)" />
      <Checkbox checked={f.on_request_form} onChange={(x) => setF({ ...f, on_request_form: x })} label="Show on request forms (0.6.0)" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function Templates() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const data = useQuery({ queryKey: ["wo-templates"], queryFn: () => api<{ items: Template[] }>("/work-order-templates") });
  const [edit, setEdit] = useState<Template | "new" | null>(null);
  const del = useMutation({ mutationFn: (t: Template) => api(`/work-order-templates/${t.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-templates"] }); toast("Template deleted"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const manage = can("templates.manage");
  const pin = useMutation({ mutationFn: (t: Template) => api(`/work-order-templates/${t.id}`, { method: "PATCH", body: { pinned: !t.pinned } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-templates"] }); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <section className="card">
      <div className="card-head"><h2>Work order templates</h2>{manage && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />New template</Button>}</div>
      {!data.data ? <ListSkeleton rows={2} /> : data.data.items.length === 0 ? <EmptyState title="No templates yet">Templates pre-fill the title, priority, assignees and more for work you create often, like “Replace filter”.</EmptyState>
        : data.data.items.map((t) => (
          <div key={t.id} className="list-row" style={{ borderLeft: 0 }}>
            <div className="grow"><div className="t">{t.pinned && <Pin size={13} className="faint" aria-label="Pinned" />} {t.name}</div>
              <div className="s">{String(t.data.title ?? "")}{t.description ? ` · ${t.description}` : ""}{t.use_count ? ` · used ${t.use_count} time${t.use_count === 1 ? "" : "s"}` : ""}</div></div>
            {manage && <><Button size="sm" variant="ghost" icon aria-label={t.pinned ? `Unpin ${t.name}` : `Pin ${t.name} to the Create menu`} title={t.pinned ? "Unpin" : "Pin to the Create menu"}
                onClick={() => pin.mutate(t)}>{t.pinned ? <PinOff size={14} /> : <Pin size={14} />}</Button>
              <Button size="sm" variant="ghost" icon aria-label={`Edit ${t.name}`} onClick={() => setEdit(t)}><Pencil size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${t.name}`} onClick={() => del.mutate(t)}><Trash2 size={14} /></Button></>}
          </div>))}
      {edit && <TemplateModal tpl={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function TemplateModal({ tpl, onClose }: { tpl?: Template; onClose: () => void }) {
  const opts = useWOOptions();
  const { can } = useSession();
  const qc = useQueryClient();
  const d = (tpl?.data ?? {}) as Record<string, unknown>;
  const [f, setF] = useState({ name: tpl?.name ?? "", description: tpl?.description ?? "", title: (d.title as string) ?? "", body: (d.description as string) ?? "",
    priority: (d.priority as string) ?? "none", work_type: (d.work_type as string) ?? "reactive", estimated_minutes: (d.estimated_minutes as number | null) ?? null,
    assignees: (d.assignees as string[]) ?? [], categories: (d.categories as string[]) ?? [], asset_id: (d.asset_id as string | null) ?? null,
    location_id: (d.location_id as string | null) ?? null, due_in_days: (d.due_in_days as number | null) ?? null, pinned: tpl?.pinned ?? false });
  const [err, setErr] = useState("");
  const payload = { name: f.name, description: f.description, pinned: f.pinned, data: { title: f.title, description: f.body, priority: f.priority, work_type: f.work_type,
    estimated_minutes: f.estimated_minutes, assignees: f.assignees, categories: f.categories,
    ...(f.asset_id ? { asset_id: f.asset_id } : {}), ...(f.location_id ? { location_id: f.location_id } : {}), ...(f.due_in_days !== null ? { due_in_days: f.due_in_days } : {}) } };
  const m = useMutation({ mutationFn: () => tpl ? api(`/work-order-templates/${tpl.id}`, { method: "PATCH", body: payload }) : api("/work-order-templates", { method: "POST", body: payload }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-templates"] }); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={tpl ? "Edit template" : "New template"} width={620} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>Save template</Button></>}>
      <div className="form-grid">
        <Field label="Template name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Replace AHU filter" />}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Work order title" className="full">{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Description" className="full">{(id) => <textarea id={id} className="textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
        <Field label="Priority">{(id) => <Select id={id} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["none", "low", "medium", "high"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select>}</Field>
        <Field label="Work type">{(id) => <Select id={id} value={f.work_type} onChange={(e) => setF({ ...f, work_type: e.target.value })}><option value="reactive">Reactive</option><option value="preventive">Preventive</option><option value="other">Other</option></Select>}</Field>
        <Field label="Estimated minutes">{(id) => <Input id={id} type="number" min={0} value={f.estimated_minutes ?? ""} onChange={(e) => setF({ ...f, estimated_minutes: e.target.value ? Number(e.target.value) : null })} />}</Field>
        <Field label="Categories">{(id) => <CategoryPicker id={id} options={opts.data} value={f.categories} onChange={(v) => setF({ ...f, categories: v })} />}</Field>
        <Field label="Assign to" className="full">{(id) => <AssigneePicker id={id} options={opts.data} value={f.assignees} onChange={(v) => setF({ ...f, assignees: v })} />}</Field>
        {can("assets.view") && <Field label="Asset">{(id) => <AssetPicker id={id} value={f.asset_id ? [f.asset_id] : []} onChange={(v) => setF({ ...f, asset_id: v[0] ?? null })} />}</Field>}
        {can("locations.view") && <Field label="Location">{(id) => <LocationPicker id={id} value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} />}</Field>}
        <Field label="Due" hint="Days after the work order is created (0 = same day). Leave empty for no due date.">{(id) => (
          <Input id={id} type="number" min={0} max={3650} value={f.due_in_days ?? ""} onChange={(e) => setF({ ...f, due_in_days: e.target.value === "" ? null : Number(e.target.value) })} />)}</Field>
        <div className="field" style={{ justifyContent: "flex-end" }}><Toggle checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} label="Pin to the Create menu"
          hint="One tap creates a work order from it." /></div>
      </div>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function Numbering({ next, ro }: { next: number; ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [v, setV] = useState(String(next));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setV(String(next)); }, [next]);
  const m = useMutation({ mutationFn: () => api("/work-orders/settings/next-number", { method: "POST", body: { next_number: Number(v) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-settings"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); setConfirm(false); toast("Numbering updated"); },
    onError: (e) => { setConfirm(false); toast((e as ApiError).message, { kind: "error" }); } });
  return (
    <section className="card">
      <div className="card-head"><h2>Work order numbers</h2></div>
      <div className="card-body form-grid">
        <Field label="Next work order number" hint="Handy when you move from another system and want to keep counting from where you were. You can only move it forward.">
          {(id) => <Input id={id} type="number" min={next} disabled={ro} value={v} onChange={(e) => setV(e.target.value)} />}</Field>
        {!ro && <div className="field" style={{ justifyContent: "flex-end" }}><Button disabled={!v || Number(v) === next} onClick={() => setConfirm(true)}>Change numbering</Button></div>}
      </div>
      {confirm && <Modal title="Change work order numbering?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => m.mutate()}>Set next number to #{v}</Button></>}><p>This can't be undone. New work orders will start at #{v}.</p></Modal>}
    </section>
  );
}
