// Create / edit work order side panel (MaintainX opens new work orders in a side panel).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FileText, ImagePlus, LayoutTemplate, X } from "lucide-react";
import { api, ApiError, upload, type CustomFieldDef, type FileItem, type Template, type WODetail } from "../../lib/api";
import { useSession } from "../../lib/session";
import { atTime, fromLocalInput, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select } from "../../components/ui";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { AssetPicker, ClearableDate, LocationPicker } from "../../components/assetPickers";
import { useAssetList, useAssetOptions } from "../../lib/assets";

export type FormInit = Partial<{
  title: string; description: string; priority: string; work_type: string; start_at: string | null; due_at: string | null; estimated_minutes: number | null;
  assignees: string[]; categories: string[]; custom: Record<string, unknown>; parent_id: string | null; template_id: string | null;
  asset_id: string | null; location_id: string | null; asset_tasks: string[];
  asset_status: { status: string; reason?: string; downtime_type?: string } | null;
}>;

const PRIOS = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]] as const;

export function fromDetail(wo: WODetail): FormInit {
  return {
    title: wo.title, description: wo.description, priority: wo.priority, work_type: wo.work_type, start_at: wo.start_at, due_at: wo.due_at,
    estimated_minutes: wo.estimated_minutes, assignees: wo.assignees.map((a) => `${a.type}:${a.id}`), categories: wo.categories.map((c) => c.id),
    custom: wo.custom, parent_id: wo.parent_id, asset_id: wo.asset?.id ?? null, location_id: wo.location?.id ?? null,
    asset_tasks: (wo.asset_tasks ?? []).map((t) => t.asset.id),
  };
}

export function WorkOrderForm({ edit, init, onClose, onSaved }: { edit?: WODetail; init?: FormInit; onClose: () => void; onSaved?: (wo: WODetail) => void }) {
  const opts = useWOOptions();
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const templates = useQuery({ queryKey: ["wo-templates"], queryFn: () => api<{ items: Template[] }>("/work-order-templates"), enabled: !edit });
  const [f, setF] = useState<FormInit>(() => ({ priority: "none", work_type: "reactive", assignees: [], categories: [], custom: {}, ...(edit ? fromDetail(edit) : {}), ...init }));
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: FormInit) => setF((x) => ({ ...x, ...patch }));
  const assetOpts = useAssetOptions();
  const assetList = useAssetList();
  const [showTasks, setShowTasks] = useState(() => !!(edit?.asset_tasks?.length || init?.asset_tasks?.length));
  const pickAsset = (id: string | null) => {
    // MaintainX fills in the asset's location when you pick an asset
    const a = id ? assetList.data?.items.find((x) => x.id === id) : null;
    set({ asset_id: id, ...(a?.location ? { location_id: a.location.id } : {}), ...(id ? {} : { asset_status: null }) });
  };
  const askStatus = !!f.asset_id && can("assets.status") && (assetOpts.data?.settings.ask_status_on_work_orders ?? true);
  const required = new Set(opts.data?.settings.required_fields ?? []);
  const s = opts.data?.settings;

  const applyTemplate = (t: Template, keep?: FormInit) => {
    const { due_in_days, ...d } = t.data as FormInit & { due_in_days?: number };
    const due = due_in_days !== undefined && due_in_days !== null
      ? atTime(new Date(Date.now() + due_in_days * 86400000).toISOString().slice(0, 10), opts.data?.settings.default_due_time ?? "12:00") : undefined;
    setF((x) => ({ ...x, ...d, ...(due ? { due_at: due } : {}), custom: { ...(x.custom ?? {}), ...(d.custom ?? {}) }, template_id: t.id, ...(keep ?? {}) }));
    toast(`Filled in from “${t.name}”`);
  };
  const appliedInit = useRef(false);
  useEffect(() => { // ?template= from a failed one-tap create: fill the form from it, keeping any asset/location passed in
    if (appliedInit.current || !init?.template_id || !templates.data) return;
    const t = templates.data.items.find((x) => x.id === init.template_id);
    appliedInit.current = true;
    if (t) applyTemplate(t, { ...(init.asset_id ? { asset_id: init.asset_id } : {}), ...(init.location_id ? { location_id: init.location_id } : {}) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.data, init?.template_id]);

  const payload = () => {
    const body: Record<string, unknown> = { ...f, assignees: (f.assignees ?? []).map((a) => a), file_ids: edit ? undefined : files.map((x) => x.id) };
    if (edit) { delete body.template_id; body.version = edit.version; }
    if (!f.asset_status?.status) delete body.asset_status;
    if (!can("assets.view")) { delete body.asset_id; delete body.asset_tasks; }
    if (!can("locations.view")) delete body.location_id;
    return body;
  };
  const save = useMutation({
    mutationFn: () => edit ? api<WODetail>(`/work-orders/${edit.id}`, { method: "PATCH", body: payload() }) : api<WODetail>("/work-orders", { method: "POST", body: payload() }),
    onSuccess: (wo) => {
      qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["wo-stats"] });
      qc.setQueryData(["work-order", wo.id], wo);
      toast(edit ? "Work order saved" : `Work order #${wo.number} created`);
      onClose();
      if (onSaved) onSaved(wo); else if (!edit) nav(`/work-orders/${wo.id}`);
    },
    onError: (e) => {
      const ae = e as ApiError;
      if (ae.status === 409) { qc.invalidateQueries({ queryKey: ["work-order", edit?.id] }); setErr("Someone else changed this work order while you were editing. Close this panel to see their changes, then edit again."); }
      else setErr(ae.message);
    },
  });

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1);
      try { const up = await upload(file); setFiles((x) => [...x, up]); }
      catch (e) { toast((e as ApiError).message, { kind: "error" }); }
      finally { setUploading((n) => n - 1); }
    }
  };

  const dueDate = f.due_at ? toLocalInput(f.due_at) : "";
  const startDate = f.start_at ? toLocalInput(f.start_at) : "";
  const missing = useMemo(() => {
    const m: string[] = [];
    if (!f.title?.trim()) m.push("title");
    if (required.has("due_date") && !f.due_at) m.push("due date");
    if (required.has("priority") && f.priority === "none") m.push("priority");
    if (required.has("description") && !f.description?.trim()) m.push("description");
    if (required.has("assignees") && !(f.assignees ?? []).length) m.push("assignees");
    if (required.has("categories") && !(f.categories ?? []).length) m.push("categories");
    if (required.has("estimated_time") && !f.estimated_minutes) m.push("estimated time");
    if (!edit && required.has("attachment") && !files.length) m.push("a picture or file");
    for (const cf of opts.data?.custom_fields ?? []) if (cf.required && (f.custom?.[cf.id] ?? "") === "") m.push(cf.name);
    return m;
  }, [f, files.length, required, opts.data, edit]);
  const req = (k: string) => (required.has(k) ? " *" : "");

  useEffect(() => { setErr(""); }, [f]);

  return (
    <Drawer title={edit ? `Edit work order #${edit.number}` : f.parent_id ? "New sub-work order" : "New work order"} onClose={onClose} width={620}
      footer={<>
        <span className="small faint grow">{missing.length ? `Still needed: ${missing.join(", ")}` : edit ? "" : `Will be #${opts.data?.next_number ?? "…"}`}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={missing.length > 0 || save.isPending || uploading > 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : edit ? "Save" : "Create"}</Button>
      </>}>
      {!edit && (templates.data?.items.length ?? 0) > 0 && (
        <div className="row"><LayoutTemplate size={16} className="faint" />
          <Select aria-label="Start from a template" value="" onChange={(e) => { const t = templates.data?.items.find((x) => x.id === e.target.value); if (t) applyTemplate(t); }} style={{ maxWidth: 320 }}>
            <option value="">Start from a template…</option>{templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select></div>)}
      <Field label="What needs to be done? *">{(id) => <Input id={id} value={f.title ?? ""} maxLength={255} placeholder="e.g. Replace worn belt on Conveyor 3" onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !missing.length) save.mutate(); }} />}</Field>
      <Field label={"Description" + req("description")}>{(id) => <textarea id={id} className="textarea" rows={4} maxLength={4096} value={f.description ?? ""} placeholder="Add details, steps or safety notes"
        onChange={(e) => set({ description: e.target.value })} />}</Field>
      {!edit && (
        <div className="field"><span className="label">Pictures and files{req("attachment")}</span>
          <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}>
            <ImagePlus size={20} className="faint" /><span>Drag photos or files here, or <button type="button" className="linkbtn" onClick={() => fileInput.current?.click()}>browse</button></span>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
              accept="image/*,.pdf,.doc,.docx,.xlsx,.csv,.txt,.mp4,.mov,.heic" />
          </div>
          {(files.length > 0 || uploading > 0) && <div className="row wrap">{files.map((x) => (
            <span key={x.id} className="chip">{x.is_image ? <ImagePlus size={13} /> : <FileText size={13} />}{x.name}
              <button type="button" className="linkbtn" aria-label={`Remove ${x.name}`} onClick={() => setFiles((fs) => fs.filter((y) => y.id !== x.id))}><X size={12} /></button></span>))}
            {uploading > 0 && <span className="small faint">Uploading {uploading}…</span>}</div>}
        </div>)}
      <div className="form-grid">
        <Field label={"Assign to" + req("assignees")} className="full">{(id) => <AssigneePicker id={id} options={opts.data} value={f.assignees ?? []} onChange={(v) => set({ assignees: v })} />}</Field>
        <Field label={"Priority" + req("priority")}>{() => (
          <div className="seg" role="radiogroup" aria-label="Priority">{PRIOS.map(([k, l]) => (
            <button type="button" key={k} role="radio" aria-checked={f.priority === k} className={"seg-btn prio-" + k + (f.priority === k ? " on" : "")} onClick={() => set({ priority: k })}>{l}</button>))}</div>)}</Field>
        <Field label="Work type">{(id) => <Select id={id} value={f.work_type} onChange={(e) => set({ work_type: e.target.value })}>
          <option value="reactive">Reactive</option><option value="preventive">Preventive</option><option value="other">Other</option></Select>}</Field>
        <Field label={"Due date" + req("due_date")}>{(id) => (
          <div className="row"><ClearableDate id={id} label="due date" type="datetime-local" value={dueDate} onChange={(v) => set({ due_at: fromLocalInput(v) })} />
            {!f.due_at && <Button size="sm" variant="ghost" onClick={() => set({ due_at: atTime(new Date().toISOString().slice(0, 10), s?.default_due_time ?? "12:00") })}>Today</Button>}</div>)}</Field>
        <Field label="Start date" hint="Hidden from To Do until this date.">{(id) => <ClearableDate id={id} label="start date" type="datetime-local" value={startDate} onChange={(v) => set({ start_at: fromLocalInput(v) })} />}</Field>
        <Field label={"Estimated time" + req("estimated_time")}>{(id) => (
          <div className="row"><Input id={id} type="number" min={0} step={1} aria-label="Hours" placeholder="0" value={f.estimated_minutes ? Math.floor(f.estimated_minutes / 60) : ""}
            onChange={(e) => set({ estimated_minutes: (Number(e.target.value) || 0) * 60 + ((f.estimated_minutes ?? 0) % 60) || null })} /><span className="small muted">h</span>
            <Input type="number" min={0} max={59} step={5} aria-label="Minutes" placeholder="0" value={f.estimated_minutes ? f.estimated_minutes % 60 : ""}
              onChange={(e) => set({ estimated_minutes: Math.floor((f.estimated_minutes ?? 0) / 60) * 60 + (Number(e.target.value) || 0) || null })} /><span className="small muted">min</span></div>)}</Field>
        <Field label={"Categories" + req("categories")}>{(id) => <CategoryPicker id={id} options={opts.data} value={f.categories ?? []} onChange={(v) => set({ categories: v })} />}</Field>
        {can("assets.view") && <Field label="Asset">{(id) => <AssetPicker id={id} value={f.asset_id ? [f.asset_id] : []} onChange={(v) => pickAsset(v[0] ?? null)} />}</Field>}
        {can("locations.view") && <Field label="Location">{(id) => <LocationPicker id={id} value={f.location_id ?? null} onChange={(v) => set({ location_id: v })} />}</Field>}
        {askStatus && <AssetStatusField value={f.asset_status ?? null} onChange={(v) => set({ asset_status: v })} reasons={assetOpts.data?.statuses} />}
        {can("assets.view") && (showTasks
          ? <Field label="Asset task list" hint="Each asset gets its own status and notes on the work order." className="full">{(id) => (
              <AssetPicker id={id} multi value={f.asset_tasks ?? []} onChange={(v) => set({ asset_tasks: v })} placeholder="Add assets to work through" />)}</Field>
          : <div className="full"><button type="button" className="linkbtn small" onClick={() => setShowTasks(true)}>+ Add an asset task list</button></div>)}
      </div>
      {(opts.data?.custom_fields.length ?? 0) > 0 && <>
        <hr className="divider" style={{ margin: 0 }} />
        <div className="form-grid">{opts.data!.custom_fields.map((cf) => (
          <CustomInput key={cf.id} def={cf} value={f.custom?.[cf.id]} onChange={(v) => set({ custom: { ...(f.custom ?? {}), [cf.id]: v } })} />))}</div>
      </>}
      {f.parent_id && <p className="small muted">This will be a sub-work order. Sub-work orders show on their parent with their own status.</p>}
      {!can("wo.create") && <div className="banner warning">You can't create work orders with your role.</div>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Drawer>
  );
}

export function CustomInput({ def, value, onChange }: { def: CustomFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const label = def.name + (def.required ? " *" : "");
  const full = def.type === "textarea" ? "full" : "";
  switch (def.type) {
    case "textarea": return <Field label={label} className={full}>{(id) => <textarea id={id} className="textarea" rows={3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />}</Field>;
    case "number": return <Field label={label}>{(id) => <Input id={id} type="number" value={(value as number | string) ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />}</Field>;
    case "select": return <Field label={label}>{(id) => <Select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{def.options.map((o) => <option key={o}>{o}</option>)}</Select>}</Field>;
    case "date": return <Field label={label}>{(id) => <ClearableDate id={id} label={def.name} type="date" value={(value as string) ?? ""} onChange={(v) => onChange(v)} />}</Field>;
    case "datetime": return <Field label={label}>{(id) => <ClearableDate id={id} label={def.name} type="datetime-local" value={toLocalInput(value as string)} onChange={(v) => onChange(fromLocalInput(v) ?? "")} />}</Field>;
    case "checkbox": return <Field label={label}>{(id) => <label className="check"><input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /><span>Yes</span></label>}</Field>;
    case "link": return <Field label={label} hint="A web address (https://…) or phone link (tel:…)">{(id) => <Input id={id} type="url" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="https://" />}</Field>;
    default: return <Field label={label}>{(id) => <Input id={id} maxLength={4096} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />}</Field>;
  }
}

/** "Mark the asset as…" on create/edit (MaintainX asks for the asset's status when work starts). */
export function AssetStatusField({ value, onChange, reasons }: {
  value: { status: string; reason?: string; downtime_type?: string } | null; onChange: (v: { status: string; reason?: string; downtime_type?: string } | null) => void;
  reasons?: { id: string; label: string; reasons: string[] }[];
}) {
  const cur = reasons?.find((r) => r.id === value?.status);
  return (
    <Field label="Asset status" hint="Optional: changes the asset's status when you save.">{(id) => (
      <div className="row wrap">
        <Select id={id} value={value?.status ?? ""} style={{ maxWidth: 170 }}
          onChange={(e) => onChange(e.target.value ? { status: e.target.value, downtime_type: e.target.value === "offline" ? "unplanned" : undefined } : null)}>
          <option value="">Don't change</option>{reasons?.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
        {value?.status === "offline" && <Select aria-label="Downtime" value={value.downtime_type ?? "unplanned"} style={{ maxWidth: 140 }}
          onChange={(e) => onChange({ ...value, downtime_type: e.target.value })}><option value="unplanned">Unplanned</option><option value="planned">Planned</option></Select>}
        {value && (cur?.reasons.length ?? 0) > 0 && <Select aria-label="Reason" value={value.reason ?? ""} style={{ maxWidth: 200 }}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}><option value="">No reason</option>{cur!.reasons.map((r) => <option key={r}>{r}</option>)}</Select>}
      </div>)}</Field>
  );
}
