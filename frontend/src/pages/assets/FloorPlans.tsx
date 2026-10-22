// Floor plans on a location: upload a plan image, drop pins for assets (or a label), drag pins to move them.
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, MapPin, Trash2 } from "lucide-react";
import { api, ApiError, upload } from "../../lib/api";
import type { FloorPlan, FloorPlanPin, LocationDetail } from "../../lib/assets";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, Modal } from "../../components/ui";
import { AssetPicker } from "../../components/assetPickers";

export function FloorPlans({ loc, editable }: { loc: LocationDetail; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["location", loc.id] });
  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const f = await upload(file);
      await api(`/locations/${loc.id}/floor-plans`, { method: "POST", body: { name: file.name.replace(/\.[^.]+$/, ""), file_id: f.id } });
      await refresh(); setCurrent(loc.floor_plans.length); toast("Floor plan added");
    } catch (e) { toast((e as ApiError).message, { kind: "error" }); } finally { setBusy(false); }
  };
  const plans = loc.floor_plans;
  const plan = plans[Math.min(current, plans.length - 1)];
  return (
    <section className="card">
      <div className="card-head wrap">
        <div className="seg" role="tablist" aria-label="Floor plans">{plans.map((p, i) => (
          <button key={p.id} type="button" role="tab" aria-selected={plan?.id === p.id} className={"seg-btn" + (plan?.id === p.id ? " on" : "")} onClick={() => setCurrent(i)}>{p.name}</button>))}</div>
        {editable && <><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ""; }} />
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy}><ImagePlus size={14} />{busy ? "Uploading…" : "Add floor plan"}</Button></>}
      </div>
      {!plan ? <EmptyState icon={<MapPin size={24} />} title="No floor plans">Upload a floor plan image (PNG, JPG or WebP) and pin assets on it, so people can find equipment fast.</EmptyState>
        : <PlanCanvas key={plan.id} loc={loc} plan={plan} editable={editable} onChanged={refresh} />}
    </section>
  );
}

function PlanCanvas({ loc, plan, editable, onChanged }: { loc: LocationDetail; plan: FloorPlan; editable: boolean; onChanged: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const { toast } = useToast();
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const base = `/locations/${loc.id}/floor-plans/${plan.id}`;
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const move = useMutation({ mutationFn: (p: { id: string; x: number; y: number }) => api(`${base}/pins/${p.id}`, { method: "PATCH", body: { x: p.x, y: p.y } }), onSuccess: onChanged, onError: err });
  const delPin = useMutation({ mutationFn: (id: string) => api(`${base}/pins/${id}`, { method: "DELETE" }), onSuccess: () => { onChanged(); toast("Pin removed"); }, onError: err });
  const delPlan = useMutation({ mutationFn: () => api(base, { method: "DELETE" }), onSuccess: () => { onChanged(); toast("Floor plan removed"); }, onError: err });
  const frac = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)) };
  };
  const pinAt = (p: FloorPlanPin) => (drag && drag.id === p.id ? { x: drag.x, y: drag.y } : { x: p.x, y: p.y });
  return (
    <div className="card-body stack">
      <div ref={box} className={"plan-box" + (editable ? " editable" : "")} onClick={(e) => { if (!editable || drag) return; if ((e.target as HTMLElement).closest(".plan-pin")) return; setAdding(frac(e.clientX, e.clientY)); }}
        onPointerMove={(e) => { if (drag) { const f = frac(e.clientX, e.clientY); setDrag({ ...drag, ...f, moved: true }); } }}
        onPointerUp={() => { if (drag) { if (drag.moved) move.mutate({ id: drag.id, x: drag.x, y: drag.y }); setTimeout(() => setDrag(null), 0); } }}>
        <img src={plan.url} alt={`Floor plan: ${plan.name}`} draggable={false} />
        {plan.pins.map((p) => { const at = pinAt(p); return (
          <button key={p.id} type="button" className={"plan-pin" + (p.asset_status ? " " + p.asset_status : "")} style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
            title={p.label} aria-label={`${p.label}${p.asset_id ? " (asset)" : ""}`}
            onPointerDown={(e) => { if (!editable) return; e.stopPropagation(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag({ id: p.id, x: p.x, y: p.y, moved: false }); }}
            onClick={(e) => { e.stopPropagation(); if (drag?.moved) return; if (p.asset_id) nav(`/assets/${p.asset_id}`); }}
            onKeyDown={(e) => { if (editable && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); delPin.mutate(p.id); } }}>
            <MapPin size={22} /><span className="plan-pin-label">{p.label}</span>
          </button>); })}
      </div>
      {editable && <div className="row small muted wrap" style={{ justifyContent: "space-between" }}>
        <span>Click the plan to add a pin. Drag a pin to move it; select it and press Delete to remove it.</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><Trash2 size={14} />Remove this plan</Button></div>}
      {adding && <AddPin base={base} at={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); onChanged(); }} />}
      {confirm && <Modal title="Remove floor plan?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => { setConfirm(false); delPlan.mutate(); }}>Remove</Button></>}><p>{plan.name} and its pins will be removed.</p></Modal>}
    </div>
  );
}

function AddPin({ base, at, onClose, onDone }: { base: string; at: { x: number; y: number }; onClose: () => void; onDone: () => void }) {
  const [asset, setAsset] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({ mutationFn: () => api(`${base}/pins`, { method: "POST", body: { ...at, asset_id: asset[0] ?? null, label } }), onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title="Add a pin" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={(!asset.length && !label.trim()) || m.isPending} onClick={() => m.mutate()}>Add pin</Button></>}>
      <Field label="Asset">{(id) => <AssetPicker id={id} value={asset} onChange={setAsset} placeholder="Pick an asset" />}</Field>
      <Field label="Label" hint="Optional for assets. Use a label alone for things like an exit or an electrical panel.">{(id) => <Input id={id} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
