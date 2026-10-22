// Settings → Assets and locations: status reasons, hierarchy depth, asset types and custom fields.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, ApiError, type AssetStatus, type CustomFieldDef } from "../../lib/api";
import { ASSET_STATUS_LABEL, type AssetSettings } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import "../../styles/assets.css";

const FIELD_TYPES: [CustomFieldDef["type"], string][] = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
  ["date", "Date"], ["datetime", "Date and time"], ["checkbox", "Checkbox"], ["link", "Link (URL or phone)"]];
const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#7a52c9", "#b8560b", "#c4302b", "#c43c5c", "#5d6880", "#a16207", "#2f8f46"];
type AType = { id: string; name: string; color: string; usage: number };

export function AssetSettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const ro = !can("assets.settings");
  const s = useQuery({ queryKey: ["asset-settings"], queryFn: () => api<AssetSettings>("/assets/settings") });
  const save = useMutation({
    mutationFn: (b: Partial<AssetSettings>) => api<AssetSettings>("/assets/settings", { method: "PATCH", body: b }),
    onSuccess: (x) => { qc.setQueryData(["asset-settings"], x); qc.invalidateQueries({ queryKey: ["asset-options"] }); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!s.data) return <ListSkeleton rows={6} />;
  const v = s.data;
  return (
    <div className="stack" style={{ gap: 20 }}>
      {ro && <div className="banner info">Only administrators can change asset settings. You can see how they're set up.</div>}
      <section className="card">
        <div className="card-head"><h2>Asset statuses</h2><span className="small muted">Reasons people pick when they change an asset's status</span></div>
        <div className="card-body stack">
          {(Object.keys(ASSET_STATUS_LABEL) as AssetStatus[]).map((st) => (
            <ReasonList key={st} status={st} items={v.status_reasons[st] ?? []} ro={ro} onSave={(items) => save.mutate({ status_reasons: { ...v.status_reasons, [st]: items } })} />))}
          <Toggle label="Ask for the asset's status on work orders" hint="When someone creates or completes a work order on an asset, offer to mark it offline or back online."
            checked={v.ask_status_on_work_orders} disabled={ro} onChange={(x) => save.mutate({ ask_status_on_work_orders: x })} />
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2>Hierarchy</h2></div>
        <div className="card-body">
          <Field label="Maximum asset tree depth" hint="How many levels of sub-assets are allowed (0 = no limit). Existing deeper trees stay as they are.">{(id) =>
            <DepthInput id={id} value={v.max_depth} disabled={ro} onSave={(n) => save.mutate({ max_depth: n })} />}</Field>
        </div>
      </section>
      <AssetTypes ro={ro} />
      <CustomFields entity="asset" title="Asset custom fields" ro={ro} />
      <CustomFields entity="location" title="Location custom fields" ro={ro} />
    </div>
  );
}

function DepthInput({ id, value, disabled, onSave }: { id: string; value: number; disabled: boolean; onSave: (n: number) => void }) {
  const [n, setN] = useState(String(value));
  return (
    <div className="row" style={{ maxWidth: 260 }}>
      <Input id={id} type="number" min={0} max={50} value={n} disabled={disabled} onChange={(e) => setN(e.target.value)} />
      {!disabled && Number(n) !== value && <Button onClick={() => onSave(Math.max(0, Math.min(50, Number(n) || 0)))}>Save</Button>}
    </div>
  );
}

function ReasonList({ status, items, ro, onSave }: { status: AssetStatus; items: string[]; ro: boolean; onSave: (items: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (t && !items.includes(t)) onSave([...items, t]); setText(""); };
  return (
    <div className="reason-list">
      <div className="row" style={{ gap: 6 }}><span className={"astat-dot " + status} /><b>{ASSET_STATUS_LABEL[status]}</b></div>
      <div className="row wrap" style={{ gap: 6 }}>
        {items.length === 0 && <span className="small faint">No reasons</span>}
        {items.map((r) => <span key={r} className="chip">{r}{!ro && <button type="button" className="chip-x" aria-label={`Remove reason ${r}`} onClick={() => onSave(items.filter((x) => x !== r))}><X size={12} /></button>}</span>)}
      </div>
      {!ro && <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }} style={{ maxWidth: 420 }}>
        <Input aria-label={`New reason for ${ASSET_STATUS_LABEL[status]}`} value={text} maxLength={80} onChange={(e) => setText(e.target.value)} placeholder="Add a reason" />
        <Button type="submit" disabled={!text.trim()}>Add</Button></form>}
    </div>
  );
}

function AssetTypes({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["asset-types"], queryFn: () => api<{ items: AType[] }>("/asset-types") });
  const [edit, setEdit] = useState<AType | "new" | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["asset-types"] }); qc.invalidateQueries({ queryKey: ["asset-options"] }); };
  const del = useMutation({ mutationFn: (t: AType) => api(`/asset-types/${t.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Asset type deleted"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <section className="card">
      <div className="card-head"><h2>Asset types</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add type</Button>}</div>
      {!q.data ? <ListSkeleton rows={2} /> : q.data.items.length === 0 ? <div className="card-body small faint">Group assets by kind, like Pump, Conveyor or HVAC. Custom fields can be limited to a type.</div>
        : q.data.items.map((t) => (
          <div key={t.id} className="list-row" style={{ borderLeft: 0 }}>
            <span className="sw lg" style={{ background: t.color }} /><div className="grow"><div className="t">{t.name}</div><div className="s">{t.usage} asset{t.usage === 1 ? "" : "s"}</div></div>
            {!ro && <><Button size="sm" variant="ghost" icon aria-label={`Edit ${t.name}`} onClick={() => setEdit(t)}><Pencil size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${t.name}`} onClick={() => del.mutate(t)}><Trash2 size={14} /></Button></>}
          </div>))}
      {edit && <TypeModal t={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={() => { done(); setEdit(null); }} />}
    </section>
  );
}

function TypeModal({ t, onClose, onDone }: { t?: AType; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(t?.name ?? "");
  const [color, setColor] = useState(t?.color ?? COLORS[0]);
  const [err, setErr] = useState("");
  const m = useMutation({ mutationFn: () => t ? api(`/asset-types/${t.id}`, { method: "PATCH", body: { name, color } }) : api("/asset-types", { method: "POST", body: { name, color } }),
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={t ? "Edit asset type" : "New asset type"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pump" />}</Field>
      <div className="field"><span className="small" style={{ fontWeight: 600 }}>Colour</span>
        <div className="row wrap" role="radiogroup" aria-label="Colour">{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c}
          className={"swatch-btn" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} />)}</div></div>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

type CF = CustomFieldDef & { scope_id?: string | null; entity_type?: string };

function CustomFields({ entity, title, ro }: { entity: "asset" | "location"; title: string; ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const data = useQuery({ queryKey: ["custom-fields", entity], queryFn: () => api<{ items: CF[] }>(`/custom-fields?entity=${entity}`) });
  const types = useQuery({ queryKey: ["asset-types"], queryFn: () => api<{ items: AType[] }>("/asset-types"), enabled: entity === "asset" });
  const [edit, setEdit] = useState<CF | "new" | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["custom-fields", entity] }); qc.invalidateQueries({ queryKey: ["asset-options"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const del = useMutation({ mutationFn: (f: CF) => api(`/custom-fields/${f.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Field deleted"); }, onError: err });
  const order = useMutation({ mutationFn: (ids: string[]) => api("/custom-fields/reorder", { method: "POST", body: { ids, entity_type: entity } }), onSuccess: done, onError: err });
  const items = data.data?.items ?? [];
  const move = (i: number, d: number) => { const ids = items.map((f) => f.id); const [x] = ids.splice(i, 1); ids.splice(i + d, 0, x); order.mutate(ids); };
  const typeName = (id?: string | null) => types.data?.items.find((t) => t.id === id)?.name;
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add field</Button>}</div>
      {!data.data ? <ListSkeleton rows={2} /> : items.length === 0 ? <div className="card-body small faint">{entity === "asset" ? "Add fields like horsepower, refrigerant or voltage. Limit a field to one asset type so it only shows where it applies." : "Add fields like a cost center, square footage or a building code."}</div>
        : items.map((f, i) => (
          <div key={f.id} className="list-row" style={{ borderLeft: 0 }}>
            <div className="grow"><div className="t">{f.name} {f.required && <Pill tone="warning">Required</Pill>}</div>
              <div className="s">{FIELD_TYPES.find(([k]) => k === f.type)?.[1]}{f.type === "select" ? `: ${f.options.join(", ")}` : ""}{f.scope_id ? ` · Only on ${typeName(f.scope_id) ?? "one type"}` : ""}</div></div>
            {!ro && <>
              <Button size="sm" variant="ghost" icon aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Edit ${f.name}`} onClick={() => setEdit(f)}><Pencil size={14} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${f.name}`} onClick={() => del.mutate(f)}><Trash2 size={14} /></Button></>}
          </div>))}
      {edit && <FieldModal entity={entity} field={edit === "new" ? undefined : edit} types={types.data?.items ?? []} onClose={() => setEdit(null)} onDone={done} />}
    </section>
  );
}

function FieldModal({ entity, field, types, onClose, onDone }: { entity: "asset" | "location"; field?: CF; types: AType[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false, scope_id: field?.scope_id ?? "" });
  const [err, setErr] = useState("");
  const body = () => ({ name: f.name, type: f.type, required: f.required, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean), entity_type: entity,
    ...(entity === "asset" ? { scope_id: f.scope_id || null } : {}) });
  const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
    onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={field ? "Edit field" : "New field"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={entity === "asset" ? "e.g. Horsepower" : "e.g. Cost center"} />}</Field>
      <Field label="Type" hint={field ? "A field's type can't change. Make a new field instead." : undefined}>{(id) => <Select id={id} value={f.type} disabled={!!field} onChange={(e) => setF({ ...f, type: e.target.value as CustomFieldDef["type"] })}>
        {FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
      {f.type === "select" && <Field label="Options (one per line)">{(id) => <textarea id={id} className="textarea" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} />}</Field>}
      {entity === "asset" && <Field label="Show on" hint="Limit the field to assets of one type, or show it on every asset.">{(id) => <Select id={id} value={f.scope_id} onChange={(e) => setF({ ...f, scope_id: e.target.value })}>
        <option value="">All assets</option>{types.map((t) => <option key={t.id} value={t.id}>Only {t.name} assets</option>)}</Select>}</Field>}
      <Checkbox checked={f.required} onChange={(x) => setF({ ...f, required: x })} label="Required" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
