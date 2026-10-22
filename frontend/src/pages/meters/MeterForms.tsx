// Meter create/edit drawer, trigger editor, copy dialog, monitoring points and bulk edit.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { Meter, MeterDetail } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Modal, Select } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";

export type MeterOptions = { units: Record<string, string[]>; frequencies: { id: string; label: string }[];
  monitoring_points: { id: string; name: string; asset_id: string | null }[]; can: Record<"read" | "manage" | "delete", boolean> };

export function useMeterOptions() {
  const { can } = useSession();
  return useQuery({ queryKey: ["meter-options"], queryFn: () => api<MeterOptions>("/meters/options"), staleTime: 60_000, enabled: can("meters.view") });
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function UnitSelect({ value, onChange, units, id }: { value: string; onChange: (v: string) => void; units: Record<string, string[]>; id?: string }) {
  const all = Object.values(units).flat();
  const [custom, setCustom] = useState(value !== "" && !all.includes(value));
  return (
    <div className="row" style={{ gap: 6 }}>
      <Select id={id} value={custom ? "__custom" : value} onChange={(e) => { if (e.target.value === "__custom") { setCustom(true); onChange(""); } else { setCustom(false); onChange(e.target.value); } }}>
        {Object.entries(units).map(([g, us]) => <optgroup key={g} label={g}>{us.map((u) => <option key={u} value={u}>{u}</option>)}</optgroup>)}
        <option value="__custom">Custom unit…</option>
      </Select>
      {custom && <Input aria-label="Custom unit" placeholder="e.g. bags" value={value} maxLength={40} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function MeterForm({ edit, onClose, onSaved, initialAsset }: { edit?: MeterDetail; onClose: () => void; onSaved: (m: MeterDetail) => void; initialAsset?: string }) {
  const opts = useMeterOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState(() => ({
    name: edit?.name ?? "", description: edit?.description ?? "", unit: edit?.unit ?? "hours", meter_type: edit?.meter_type ?? "manual",
    asset_id: edit?.asset_id ?? initialAsset ?? null, location_id: edit?.location_id ?? null, monitoring_point_id: edit?.monitoring_point_id ?? "",
    reading_frequency: edit?.reading_frequency ?? "none", frequency_interval: String(edit?.frequency_interval ?? 1),
    warning_low: str(edit?.warning_low), warning_high: str(edit?.warning_high), alarm_low: str(edit?.alarm_low), alarm_high: str(edit?.alarm_high),
  }));
  const [err, setErr] = useState("");
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, monitoring_point_id: f.monitoring_point_id || null, frequency_interval: Number(f.frequency_interval) || 1,
        warning_low: numOrNull(f.warning_low), warning_high: numOrNull(f.warning_high), alarm_low: numOrNull(f.alarm_low), alarm_high: numOrNull(f.alarm_high) };
      if (edit && body.asset_id === edit.asset_id) delete (body as Partial<typeof body>).asset_id; // don't reset the location on unrelated edits
      return edit ? api<MeterDetail>(`/meters/${edit.id}`, { method: "PATCH", body }) : api<MeterDetail>("/meters", { method: "POST", body });
    },
    onSuccess: (m) => { qc.invalidateQueries({ queryKey: ["meters"] }); qc.setQueryData(["meter", m.id], m); toast(edit ? "Meter saved" : "Meter created"); onSaved(m); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const points = (opts.data?.monitoring_points ?? []).filter((p) => !f.asset_id || !p.asset_id || p.asset_id === f.asset_id);
  return (
    <Drawer title={edit ? "Edit meter" : "New meter"} onClose={onClose}
      footer={<><span className="grow small" style={{ color: "var(--c-danger)" }} role="alert">{err}</span><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending || !f.name.trim() || !f.unit.trim()} onClick={() => { setErr(""); save.mutate(); }}>{edit ? "Save" : "Create"}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Meter name">{(id) => <Input id={id} value={f.name} maxLength={255} placeholder="e.g. Run hours" onChange={(e) => set({ name: e.target.value })} required />}</Field>
        <Field label="Unit of measurement">{(id) => <UnitSelect id={id} value={f.unit} units={opts.data?.units ?? {}} onChange={(unit) => set({ unit })} />}</Field>
        <Field label="Description">{(id) => <textarea id={id} className="textarea" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <div className="form-grid">
          <Field label="Asset">{(id) => <AssetPicker id={id} value={f.asset_id ? [f.asset_id] : []} onChange={(v) => set({ asset_id: v[0] ?? null })} />}</Field>
          <Field label="Location" hint={f.asset_id && !f.location_id ? "Uses the asset's location" : undefined}>{(id) => <LocationPicker id={id} value={f.location_id} onChange={(v) => set({ location_id: v })} />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Monitoring point" hint="A sensor spot several meters read from">{(id) => (
            <Select id={id} value={f.monitoring_point_id} onChange={(e) => set({ monitoring_point_id: e.target.value })}>
              <option value="">None</option>{points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>)}</Field>
          <Field label="Type">{(id) => <Select id={id} value={f.meter_type} onChange={(e) => set({ meter_type: e.target.value as Meter["meter_type"] })}>
            <option value="manual">Manual readings</option><option value="automated">Automated (API or sensor)</option></Select>}</Field>
        </div>
        <Field label="Reading frequency" hint="People are reminded when a reading is due.">{(id) => (
          <div className="row" style={{ gap: 6 }}>
            {f.reading_frequency !== "none" && <><span className="small muted">Every</span>
              <Input aria-label="Interval" type="number" min={1} max={1000} style={{ width: 80 }} value={f.frequency_interval} onChange={(e) => set({ frequency_interval: e.target.value })} /></>}
            <Select id={id} value={f.reading_frequency} onChange={(e) => set({ reading_frequency: e.target.value as Meter["reading_frequency"] })}>
              {(opts.data?.frequencies ?? [{ id: "none", label: "None" }]).map((x) => <option key={x.id} value={x.id}>{x.id === "none" ? "No schedule" : x.label}</option>)}</Select>
          </div>)}</Field>
        <fieldset className="mfield">
          <legend>Limits <span className="small faint">(optional)</span></legend>
          <div className="mlimits">
            <Field label="Alarm low">{(id) => <Input id={id} type="number" step="any" value={f.alarm_low} onChange={(e) => set({ alarm_low: e.target.value })} />}</Field>
            <Field label="Warning low">{(id) => <Input id={id} type="number" step="any" value={f.warning_low} onChange={(e) => set({ warning_low: e.target.value })} />}</Field>
            <Field label="Warning high">{(id) => <Input id={id} type="number" step="any" value={f.warning_high} onChange={(e) => set({ warning_high: e.target.value })} />}</Field>
            <Field label="Alarm high">{(id) => <Input id={id} type="number" step="any" value={f.alarm_high} onChange={(e) => set({ alarm_high: e.target.value })} />}</Field>
          </div>
          <p className="small faint" style={{ margin: 0 }}>Readings outside the warning limits are flagged; outside the alarm limits they show red. Use a trigger to create work automatically.</p>
        </fieldset>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------- copy
export function CopyMeterDialog({ meter, onClose, onDone }: { meter: MeterDetail; onClose: () => void; onDone: (ids: string[]) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<"one" | "assets">("one");
  const [assets, setAssets] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: () => api<{ items: Meter[] }>(`/meters/${meter.id}/copy`, { method: "POST", body: mode === "assets" ? { asset_ids: assets } : {} }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["meters"] }); toast(`Made ${r.items.length} cop${r.items.length === 1 ? "y" : "ies"}`); onDone(r.items.map((x) => x.id)); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title="Copy meter" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={m.isPending || (mode === "assets" && !assets.length)} onClick={() => m.mutate()}>Copy</Button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Copies the settings, limits and triggers (not the readings).</p>
        <label className="check"><input type="radio" name="cm" checked={mode === "one"} onChange={() => setMode("one")} /><span>One copy named “Copy - {meter.name}”</span></label>
        <label className="check"><input type="radio" name="cm" checked={mode === "assets"} onChange={() => setMode("assets")} /><span>A copy on each of these assets</span></label>
        {mode === "assets" && <AssetPicker multi value={assets} onChange={setAssets} placeholder="Pick assets" exclude={meter.asset_id ? [meter.asset_id] : []} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- monitoring points
export function MonitoringPointsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ["monitoring-points"], queryFn: () => api<{ items: { id: string; name: string; description: string; asset_id: string | null }[] }>("/monitoring-points") });
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string; asset_id: string | null } | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["monitoring-points"] }); qc.invalidateQueries({ queryKey: ["meter-options"] }); };
  const save = useMutation({
    mutationFn: () => editing!.id ? api(`/monitoring-points/${editing!.id}`, { method: "PATCH", body: editing }) : api("/monitoring-points", { method: "POST", body: editing }),
    onSuccess: () => { done(); setEditing(null); toast("Monitoring point saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/monitoring-points/${id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Monitoring point deleted"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <Modal title="Monitoring points" onClose={onClose} width={560}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>A monitoring point is one physical spot on an asset (say, the drive-end bearing) that several meters read from.</p>
        {editing ? (
          <div className="card card-pad stack">
            <Field label="Name">{(id) => <Input id={id} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={120} />}</Field>
            <Field label="Asset">{(id) => <AssetPicker id={id} value={editing.asset_id ? [editing.asset_id] : []} onChange={(v) => setEditing({ ...editing, asset_id: v[0] ?? null })} />}</Field>
            <Field label="Description">{(id) => <Input id={id} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />}</Field>
            <div className="row" style={{ justifyContent: "flex-end" }}><Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" disabled={!editing.name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button></div>
          </div>
        ) : can("meters.manage") && <div><Button onClick={() => setEditing({ name: "", description: "", asset_id: null })}><Plus size={15} />Add monitoring point</Button></div>}
        {(list.data?.items ?? []).length === 0 ? <p className="small faint">None yet.</p> : (
          <table className="table"><tbody>{list.data!.items.map((p) => (
            <tr key={p.id}><td><b>{p.name}</b>{p.description && <div className="small muted">{p.description}</div>}</td>
              <td style={{ width: 90, textAlign: "right" }}>
                {can("meters.manage") && <Button size="sm" variant="ghost" icon aria-label={`Edit ${p.name}`} onClick={() => setEditing({ ...p })}><Pencil size={14} /></Button>}
                {can("meters.delete") && <Button size="sm" variant="ghost" icon aria-label={`Delete ${p.name}`} onClick={() => del.mutate(p.id)}><Trash2 size={14} /></Button>}
              </td></tr>))}</tbody></table>)}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- bulk
export function BulkMeterDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const opts = useMeterOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [field, setField] = useState<"reading_frequency" | "unit" | "location_id">("reading_frequency");
  const [freq, setFreq] = useState("day");
  const [interval, setInterval] = useState("1");
  const [unit, setUnit] = useState("hours");
  const [loc, setLoc] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => {
      const patch = field === "reading_frequency" ? { reading_frequency: freq, frequency_interval: Number(interval) || 1 } : field === "unit" ? { unit } : { location_id: loc };
      return api<{ done: string[]; failed: { name: string; message: string }[] }>("/meters/bulk", { method: "POST", body: { ids, action: "edit", patch } });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["meters"] }); qc.invalidateQueries({ queryKey: ["meter"] });
      toast(r.failed.length ? `${r.done.length} updated. ${r.failed[0].name}: ${r.failed[0].message}` : `Updated ${r.done.length} meter${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" });
      onDone();
    },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title={`Edit ${ids.length} meter${ids.length === 1 ? "" : "s"}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Apply</Button></>}>
      <div className="stack">
        <Field label="Change">{(id) => <Select id={id} value={field} onChange={(e) => setField(e.target.value as typeof field)}>
          <option value="reading_frequency">Reading frequency</option><option value="unit">Unit</option><option value="location_id">Location</option></Select>}</Field>
        {field === "reading_frequency" && <div className="row" style={{ gap: 6 }}><span className="small muted">Every</span>
          <Input aria-label="Interval" type="number" min={1} style={{ width: 80 }} value={interval} onChange={(e) => setInterval(e.target.value)} />
          <Select aria-label="Frequency" value={freq} onChange={(e) => setFreq(e.target.value)}>{(opts.data?.frequencies ?? []).map((x) => <option key={x.id} value={x.id}>{x.id === "none" ? "No schedule" : x.label}</option>)}</Select></div>}
        {field === "unit" && <UnitSelect value={unit} units={opts.data?.units ?? {}} onChange={setUnit} />}
        {field === "location_id" && <LocationPicker value={loc} onChange={setLoc} placeholder="No location" />}
      </div>
    </Modal>
  );
}
