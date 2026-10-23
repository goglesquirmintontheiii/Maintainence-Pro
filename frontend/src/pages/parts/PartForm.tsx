// Create or edit a part (r221 required fields, r237 duplicate warning, custom fields, vendors, stock on create).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { TeamsPicker } from "../assets/shared";
import { usePartFields, usePartOptions, type PartDetail } from "./types";

type VendorDraft = { vendor_id: string; vendor_part_number: string; unit_cost: string; lead_time_days: string; preferred: boolean };
type StockDraft = { location_id: string | null; area: string; min_qty: string; max_qty: string; initial_quantity: string };
type Dup = { id: string; name: string; part_number: string; barcode: string };

const TEXT = ["name", "part_number", "description", "unit", "unit_cost", "barcode", "manufacturer", "mpn", "lead_time_days"] as const;
type F = Record<(typeof TEXT)[number], string>;
const REQ_LABEL: Record<string, string> = { part_number: "part_number", description: "description", unit_cost: "unit_cost", barcode: "barcode", lead_time_days: "lead_time_days" };

function initial(p?: PartDetail): F {
  const f = Object.fromEntries(TEXT.map((k) => [k, ""])) as F;
  f.unit = "each";
  if (!p) return f;
  for (const k of TEXT) { const v = (p as unknown as Record<string, unknown>)[k]; f[k] = v === null || v === undefined ? "" : String(v); }
  return f;
}

export function PartForm({ edit, onClose, onSaved }: { edit?: PartDetail; onClose: () => void; onSaved: (p: PartDetail) => void }) {
  const opts = usePartOptions();
  const fields = usePartFields();
  const { can } = useSession();
  const vendorsQ = useQuery({ queryKey: ["vendors", "options"], queryFn: () => api<{ items: { id: string; name: string; color: string }[] }>("/vendors?per_page=500&sort=name"),
    enabled: can("vendors.view"), retry: false });
  const [f, setF] = useState<F>(() => initial(edit));
  const [nonStock, setNonStock] = useState(edit?.non_stock ?? false);
  const [types, setTypes] = useState<string[]>(edit?.types.map((t) => t.id) ?? []);
  const [teams, setTeams] = useState<string[]>(edit?.teams.map((t) => t.id) ?? []);
  const [assets, setAssets] = useState<string[]>(edit?.assets.map((a) => a.id) ?? []);
  const [vendors, setVendors] = useState<VendorDraft[]>(() => (edit?.vendors ?? []).map((v) => ({ vendor_id: v.vendor.id, vendor_part_number: v.vendor_part_number,
    unit_cost: v.unit_cost ?? "", lead_time_days: v.lead_time_days === null ? "" : String(v.lead_time_days), preferred: v.preferred })));
  const [stock, setStock] = useState<StockDraft[]>(edit ? [] : [{ location_id: null, area: "", min_qty: "", max_qty: "", initial_quantity: "" }]);
  const [custom, setCustom] = useState<Record<string, unknown>>(edit?.custom ?? {});
  const [dups, setDups] = useState<Dup[]>([]);
  const [err, setErr] = useState("");
  const required = new Set(opts.data?.settings.required_fields ?? []);
  const costs = can("costs.view");
  const set = (k: keyof F, v: string) => setF((x) => ({ ...x, [k]: v }));
  const label = (text: string, key: string) => text + (required.has(key) ? " *" : "");

  // Possible duplicates (r237): same name, barcode or vendor part number.
  useEffect(() => {
    const name = f.name.trim(), barcode = f.barcode.trim(), vpn = vendors.map((v) => v.vendor_part_number.trim()).find(Boolean) ?? "";
    if (name.length < 3 && !barcode && !vpn) { setDups([]); return; }
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ name, barcode, vendor_part_number: vpn, ...(edit ? { exclude: edit.id } : {}) });
      api<{ items: Dup[] }>(`/parts/duplicates?${qs}`).then((r) => setDups(r.items)).catch(() => setDups([]));
    }, 400);
    return () => clearTimeout(t);
  }, [f.name, f.barcode, vendors, edit]);

  const payload = () => {
    const b: Record<string, unknown> = { ...f, non_stock: nonStock, type_ids: types, team_ids: teams, asset_ids: assets, custom,
      lead_time_days: f.lead_time_days === "" ? null : Number(f.lead_time_days) };
    if (!costs) delete b.unit_cost;
    if (can("vendors.view")) b.vendors = vendors.filter((v) => v.vendor_id).map((v) => ({ ...v, unit_cost: costs ? v.unit_cost || null : undefined,
      lead_time_days: v.lead_time_days === "" ? null : Number(v.lead_time_days) }));
    if (!can("assets.view")) delete b.asset_ids;
    if (edit) b.version = edit.version;
    else if (!nonStock) b.stock = stock.filter((s) => s.location_id || s.min_qty || s.max_qty || s.initial_quantity || s.area)
      .map((s) => ({ ...s, min_qty: s.min_qty || null, max_qty: s.max_qty || null, initial_quantity: can("parts.stock") ? s.initial_quantity || null : null }));
    return b;
  };
  const m = useMutation({
    mutationFn: () => edit ? api<PartDetail>(`/parts/${edit.id}`, { method: "PATCH", body: payload() }) : api<PartDetail>("/parts", { method: "POST", body: payload() }),
    onSuccess: onSaved,
    onError: (e) => setErr((e as ApiError).message),
  });
  const vendorOpts = vendorsQ.data?.items ?? [];

  return (
    <Drawer title={edit ? "Edit part" : "New part"} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>{edit ? "Save" : "Create part"}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Name *">{(id) => <Input id={id} value={f.name} maxLength={255} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Ball bearing 6205-2RS" />}</Field>
        {dups.length > 0 && <div className="banner info" role="status"><div>Possible duplicate{dups.length === 1 ? "" : "s"}: {dups.map((d, i) =>
          <span key={d.id}>{i > 0 && ", "}<Link to={`/parts/${d.id}`} target="_blank">{d.name}{d.part_number ? ` (${d.part_number})` : ""}</Link></span>)}</div></div>}
        <div className="part-grid2">
          <Field label={label("Part number", REQ_LABEL.part_number)}>{(id) => <Input id={id} value={f.part_number} maxLength={120} onChange={(e) => set("part_number", e.target.value)} />}</Field>
          <Field label={label("Barcode", "barcode")}>{(id) => <Input id={id} value={f.barcode} maxLength={120} onChange={(e) => set("barcode", e.target.value)} placeholder="Scan or type" />}</Field>
          <Field label="Unit">{(id) => <><Input id={id} list="part-units" value={f.unit} maxLength={30} onChange={(e) => set("unit", e.target.value)} />
            <datalist id="part-units">{(opts.data?.units ?? []).map((u) => <option key={u} value={u} />)}</datalist></>}</Field>
          {costs && <Field label={label("Unit cost", "unit_cost")}>{(id) => <Input id={id} inputMode="decimal" value={f.unit_cost} onChange={(e) => set("unit_cost", e.target.value)} placeholder="0.00" />}</Field>}
          <Field label="Manufacturer">{(id) => <Input id={id} value={f.manufacturer} maxLength={120} onChange={(e) => set("manufacturer", e.target.value)} />}</Field>
          <Field label="Manufacturer part number">{(id) => <Input id={id} value={f.mpn} maxLength={120} onChange={(e) => set("mpn", e.target.value)} />}</Field>
          <Field label={label("Lead time (days)", "lead_time_days")}>{(id) => <Input id={id} type="number" min={0} max={3650} value={f.lead_time_days} onChange={(e) => set("lead_time_days", e.target.value)} />}</Field>
        </div>
        <Field label={label("Description", "description")}>{(id) => <textarea id={id} className="textarea" rows={3} value={f.description} maxLength={5000} onChange={(e) => set("description", e.target.value)} />}</Field>
        <Checkbox checked={nonStock} onChange={setNonStock} disabled={!!edit && !edit.non_stock && Number(edit.on_hand ?? 0) !== 0}
          label="Non-stock part (bought when needed, quantities aren't tracked)" />
        <Field label={label("Part types", "part_types")}>{(id) => <MultiPicker id={id} label="Part types" placeholder="No types" value={types} onChange={setTypes}
          options={(opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name + (t.critical ? " (critical)" : ""), icon: <span className="sw lg" style={{ background: t.color }} /> }))} />}</Field>
        <Field label={label("Teams in charge", "teams")}>{(id) => <TeamsPicker id={id} value={teams} onChange={setTeams} />}</Field>
        {can("assets.view") && <Field label={label("Used on assets", "assets")}>{(id) => <AssetPicker id={id} multi value={assets} onChange={setAssets} placeholder="No assets" />}</Field>}

        {can("vendors.view") && <fieldset className="part-fieldset">
          <legend>{label("Vendors", "vendors")}</legend>
          {vendors.map((v, i) => (
            <div key={i} className="part-vendor-row">
              <Select aria-label="Vendor" value={v.vendor_id} onChange={(e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, vendor_id: e.target.value } : x)))}>
                <option value="">Pick a vendor</option>{vendorOpts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
              <Input aria-label="Vendor part number" placeholder="Vendor part #" value={v.vendor_part_number} maxLength={120}
                onChange={(e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, vendor_part_number: e.target.value } : x)))} />
              {costs && <Input aria-label="Vendor price" placeholder="Price" inputMode="decimal" value={v.unit_cost}
                onChange={(e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)))} />}
              <label className="check small"><input type="radio" name="preferred-vendor" checked={v.preferred}
                onChange={() => setVendors((vs) => vs.map((x, j) => ({ ...x, preferred: j === i })))} /><span>Preferred</span></label>
              <Button size="sm" variant="ghost" icon aria-label="Remove vendor" onClick={() => setVendors((vs) => vs.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
            </div>))}
          <Button size="sm" variant="ghost" onClick={() => setVendors((vs) => [...vs, { vendor_id: "", vendor_part_number: "", unit_cost: "", lead_time_days: "", preferred: vs.length === 0 }])}>
            <Plus size={14} />Add vendor</Button>
        </fieldset>}

        {!edit && !nonStock && <fieldset className="part-fieldset">
          <legend>Where it's kept</legend>
          {stock.map((s, i) => {
            const upd = (p: Partial<StockDraft>) => setStock((ss) => ss.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="part-stock-row">
                <LocationPicker value={s.location_id} onChange={(v) => upd({ location_id: v })} placeholder="No location" />
                <Input aria-label={label("Area or bin", "area")} placeholder={label("Area / bin", "area")} value={s.area} maxLength={120} onChange={(e) => upd({ area: e.target.value })} />
                <Input aria-label={label("Minimum", "min_qty")} placeholder={label("Min", "min_qty")} inputMode="decimal" value={s.min_qty} onChange={(e) => upd({ min_qty: e.target.value })} />
                <Input aria-label={label("Maximum", "max_qty")} placeholder={label("Max", "max_qty")} inputMode="decimal" value={s.max_qty} onChange={(e) => upd({ max_qty: e.target.value })} />
                {can("parts.stock") && <Input aria-label="Quantity in stock now" placeholder="In stock" inputMode="decimal" value={s.initial_quantity} onChange={(e) => upd({ initial_quantity: e.target.value })} />}
                {stock.length > 1 && <Button size="sm" variant="ghost" icon aria-label="Remove location" onClick={() => setStock((ss) => ss.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>}
              </div>);
          })}
          <Button size="sm" variant="ghost" onClick={() => setStock((ss) => [...ss, { location_id: null, area: "", min_qty: "", max_qty: "", initial_quantity: "" }])}><Plus size={14} />Add location</Button>
        </fieldset>}

        {(fields.data?.items ?? []).map((c) => <CustomInput key={c.id} def={c} value={custom[c.id]} onChange={(v) => setCustom((x) => ({ ...x, [c.id]: v }))} />)}
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}
