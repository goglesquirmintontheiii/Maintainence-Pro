// Create / edit asset side panel.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanText } from "lucide-react";
import { api, ApiError, upload, type FileItem } from "../../lib/api";
import { NameplateScan, type NameplateResult } from "../../components/Nameplate";
import { useAssetOptions, type AssetDetail } from "../../lib/assets";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, ClearableDate, LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { centsToInput, Collapsible, inputToCents, PhotoPicker, TeamsPicker } from "./shared";

type F = Record<string, string> & { name: string };
const TEXT = ["name", "description", "manufacturer", "model", "serial_number", "barcode", "criticality", "warranty_provider", "warranty_terms", "disposal_method", "disposal_notes"];
const NUM = ["year", "expected_life_years", "replacement_year", "useful_life_years"];
const DATES = ["commissioned_on", "disposed_on", "warranty_start", "warranty_end", "purchase_date", "depreciation_start"];
const MONEY = ["purchase_price_cents", "salvage_value_cents", "replacement_cost_cents", "disposal_value_cents"];

function initial(a?: AssetDetail): F {
  const f: F = { name: "" };
  if (!a) { for (const k of [...TEXT, ...NUM, ...DATES, ...MONEY]) f[k] ??= ""; return f; }
  const src: Record<string, unknown> = {
    name: a.name, description: a.description, manufacturer: a.manufacturer, model: a.model, serial_number: a.serial_number, barcode: a.barcode,
    criticality: a.criticality, year: a.year, warranty_provider: a.warranty.provider, warranty_terms: a.warranty.terms, warranty_start: a.warranty.start,
    warranty_end: a.warranty.end, commissioned_on: a.lifecycle.commissioned_on, expected_life_years: a.lifecycle.expected_life_years,
    replacement_year: a.lifecycle.replacement_year, disposed_on: a.lifecycle.disposed_on, disposal_method: a.lifecycle.disposal_method,
    disposal_notes: a.lifecycle.disposal_notes, purchase_date: a.financials?.purchase_date, useful_life_years: a.financials?.useful_life_years,
    depreciation_start: a.financials?.depreciation_start,
  };
  for (const k of [...TEXT, ...NUM, ...DATES]) f[k] = src[k] === null || src[k] === undefined ? "" : String(src[k]);
  for (const k of MONEY) f[k] = centsToInput((a.financials as Record<string, number | null> | undefined)?.[k]);
  return f;
}

export function AssetForm({ edit, parentId, onClose, onSaved }: { edit?: AssetDetail; parentId?: string; onClose: () => void; onSaved: (a: AssetDetail) => void }) {
  const opts = useAssetOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState<F>(() => initial(edit));
  const [parent, setParent] = useState<string[]>(edit?.parent_id ? [edit.parent_id] : parentId ? [parentId] : []);
  const [location, setLocation] = useState<string | null>(edit?.location?.id ?? null);
  const [types, setTypes] = useState<string[]>(edit?.types.map((t) => t.id) ?? []);
  const [teams, setTeams] = useState<string[]>(edit?.teams.map((t) => t.id) ?? []);
  const [custom, setCustom] = useState<Record<string, unknown>>(edit?.custom ?? {});
  const [files, setFiles] = useState<FileItem[]>([]);
  const [err, setErr] = useState("");
  const [plate, setPlate] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const fromPlate = async (r: NameplateResult) => {
    // r594: create an asset from a nameplate photo; filled fields are only suggestions until saved
    setPlate(false);
    setF((x) => ({ ...x, manufacturer: r.manufacturer || x.manufacturer, model: r.model || x.model, serial_number: r.serial_number || x.serial_number,
      year: r.year ? String(r.year) : x.year, name: x.name || [r.manufacturer, r.model].filter(Boolean).join(" ") }));
    if (!edit) {
      try { const up = await upload(r.file); setFiles((fs) => [...fs, up]); } catch (e) { toast((e as ApiError).message, { kind: "error" }); }
    }
    toast("Filled in from the nameplate. Check the details before saving.");
  };
  const fin = !!opts.data?.can.financials;
  const makers = useQuery({ queryKey: ["asset-catalog"], queryFn: () => api<{ manufacturers: string[] }>("/asset-catalog"), staleTime: 300_000 });
  const models = useQuery({ queryKey: ["asset-catalog", f.manufacturer], enabled: !!f.manufacturer.trim(), staleTime: 300_000,
    queryFn: () => api<{ models: string[] }>(`/asset-catalog?manufacturer=${encodeURIComponent(f.manufacturer.trim())}`) });

  const body = () => {
    const b: Record<string, unknown> = {};
    for (const k of TEXT) b[k] = f[k];
    for (const k of NUM) b[k] = f[k] === "" ? null : Number(f[k]);
    for (const k of DATES) b[k] = f[k] || null;
    if (fin) for (const k of MONEY) b[k] = inputToCents(f[k]);
    if (!fin) { delete b.purchase_date; delete b.useful_life_years; delete b.depreciation_start; }
    Object.assign(b, { parent_id: parent[0] ?? null, location_id: location, types, teams, custom });
    if (!edit) b.file_ids = files.map((x) => x.id); else b.version = edit.version;
    return b;
  };
  const save = useMutation({
    mutationFn: () => edit ? api<AssetDetail>(`/assets/${edit.id}`, { method: "PATCH", body: body() }) : api<AssetDetail>("/assets", { method: "POST", body: body() }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["asset-pick"] }); qc.invalidateQueries({ queryKey: ["asset-tree"] });
      qc.setQueryData(["asset", a.id], a);
      toast(edit ? "Asset saved" : `Asset ${a.name} created`);
      onSaved(a);
    },
    onError: (e) => {
      const ae = e as ApiError;
      setErr(ae.status === 409 ? "Someone else changed this asset while you were editing. Close this panel to see their changes, then try again." : ae.message);
    },
  });
  const fields = (opts.data?.custom_fields ?? []).filter((c) => !c.scope_id || types.includes(c.scope_id));
  const typeOpts = (opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: <span className="sw lg" style={{ background: t.color }} /> }));
  const date = (k: string, label: string) => <Field label={label}>{(id) => <ClearableDate id={id} type="date" label={label} value={f[k]} onChange={(v) => set(k, v)} />}</Field>;
  const num = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}>{(id) => <Input id={id} type="number" inputMode="numeric" value={f[k]} onChange={(e) => set(k, e.target.value)} />}</Field>;
  const money = (k: string, label: string) => <Field label={label}>{(id) => <Input id={id} inputMode="decimal" placeholder="0.00" value={f[k]} onChange={(e) => set(k, e.target.value)} />}</Field>;

  return (
    <Drawer title={edit ? "Edit asset" : "New asset"} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><span className="grow" />
        <Button variant="primary" disabled={!f.name.trim() || save.isPending} onClick={() => { setErr(""); save.mutate(); }}>{save.isPending ? "Saving…" : edit ? "Save" : "Create asset"}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Asset name *" className="full">{(id) => <Input id={id} value={f.name} maxLength={255} autoFocus onChange={(e) => set("name", e.target.value)} placeholder="e.g. Air Compressor 2" />}</Field>
        <Field label="Description" className="full">{(id) => <textarea id={id} className="textarea" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} />}</Field>
        <div className="full row wrap"><Button size="sm" onClick={() => setPlate(true)}><ScanText size={14} />Read a nameplate photo</Button>
          <span className="small faint">Fills in manufacturer, model, serial number and year. Text is read on this device.</span></div>
        {!edit && <PhotoPicker files={files} setFiles={setFiles} label="Add photos (nameplate, overview) or documents" />}
        <Field label="Parent asset" hint="Sub-assets show under their parent in the tree.">{(id) => <AssetPicker id={id} value={parent} onChange={setParent} exclude={edit ? [edit.id] : []} placeholder="None (top level)" />}</Field>
        <Field label="Location">{(id) => <LocationPicker id={id} value={location} onChange={setLocation} placeholder={parent.length ? "Same as parent" : "None"} />}</Field>
        <Field label="Criticality">{(id) => <Select id={id} value={f.criticality} onChange={(e) => set("criticality", e.target.value)}>
          {(opts.data?.criticality ?? [{ id: "", label: "None" }]).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>}</Field>
        <Field label="Asset types">{(id) => <MultiPicker id={id} label="Asset types" placeholder="Add types" options={typeOpts} value={types} onChange={setTypes} searchPlaceholder="Search types"
          renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />}</Field>
        <Field label="Manufacturer">{(id) => <><Input id={id} list="mfr-list" value={f.manufacturer} maxLength={120} onChange={(e) => set("manufacturer", e.target.value)} />
          <datalist id="mfr-list">{(makers.data?.manufacturers ?? []).map((m) => <option key={m} value={m} />)}</datalist></>}</Field>
        <Field label="Model">{(id) => <><Input id={id} list="model-list" value={f.model} maxLength={120} onChange={(e) => set("model", e.target.value)} />
          <datalist id="model-list">{(models.data?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist></>}</Field>
        <Field label="Serial number">{(id) => <Input id={id} value={f.serial_number} maxLength={120} onChange={(e) => set("serial_number", e.target.value)} />}</Field>
        {num("year", "Year")}
        <Field label="Barcode" hint="An existing barcode or tag number; scanning it finds this asset.">{(id) => <Input id={id} value={f.barcode} maxLength={200} onChange={(e) => set("barcode", e.target.value)} />}</Field>
        <Field label="Teams in charge">{(id) => <TeamsPicker id={id} value={teams} onChange={setTeams} />}</Field>
        {fields.map((c) => <CustomInput key={c.id} def={c} value={custom[c.id]} onChange={(v) => setCustom((x) => ({ ...x, [c.id]: v }))} />)}
        <div className="full stack" style={{ gap: 8 }}>
          <Collapsible title="Lifecycle" hint="Commissioned, expected life, replacement, disposal">
            {date("commissioned_on", "Commissioned on")}{num("expected_life_years", "Expected life (years)")}{num("replacement_year", "Planned replacement year")}
            {date("disposed_on", "Disposed on")}
            <Field label="Disposal method">{(id) => <Select id={id} value={f.disposal_method} onChange={(e) => set("disposal_method", e.target.value)}><option value="">—</option>
              {(opts.data?.disposal_methods ?? []).map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}</Select>}</Field>
            <Field label="Disposal notes" className="full">{(id) => <textarea id={id} className="textarea" rows={2} value={f.disposal_notes} onChange={(e) => set("disposal_notes", e.target.value)} />}</Field>
          </Collapsible>
          <Collapsible title="Warranty" defaultOpen={!!f.warranty_end}>
            {date("warranty_start", "Warranty start")}{date("warranty_end", "Warranty end")}
            <Field label="Provider" className="full">{(id) => <Input id={id} value={f.warranty_provider} maxLength={200} onChange={(e) => set("warranty_provider", e.target.value)} />}</Field>
            <Field label="Terms" className="full">{(id) => <textarea id={id} className="textarea" rows={2} value={f.warranty_terms} onChange={(e) => set("warranty_terms", e.target.value)} />}</Field>
          </Collapsible>
          {fin && <Collapsible title="Financials" hint="Straight-line depreciation">
            {money("purchase_price_cents", "Purchase price")}{date("purchase_date", "Purchase date")}
            {num("useful_life_years", "Useful life (years)")}{money("salvage_value_cents", "Salvage value")}
            {date("depreciation_start", "Depreciation starts")}{money("replacement_cost_cents", "Replacement cost")}
            {money("disposal_value_cents", "Disposal value")}
          </Collapsible>}
        </div>
        {err && <div className="banner warning full" role="alert">{err}</div>}
      </form>
      {plate && <NameplateScan onResult={(r) => void fromPlate(r)} onClose={() => setPlate(false)} />}
    </Drawer>
  );
}
