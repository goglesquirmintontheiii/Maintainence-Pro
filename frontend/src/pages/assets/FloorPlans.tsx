// Floor plans on a location: upload a plan image; the card shows the plan with its pins and drawing, and opens the
// full-screen viewer/editor (FloorPlanEditor) to zoom, draw, pin assets and link areas to locations (MP-110).
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, MapPin, Maximize2, Pencil, Trash2 } from "lucide-react";
import { api, ApiError, upload } from "../../lib/api";
import type { FloorPlan, LocationDetail } from "../../lib/assets";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Modal } from "../../components/ui";
import { FloorPlanEditor, PlanShapes } from "./FloorPlanEditor";
import { DropZone } from "../../components/DropZone";
import type { Shape } from "./floorplanShapes";

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
    <DropZone className="card" disabled={!editable || busy} multiple={false} accept="image/png,image/jpeg,image/webp" label="Drop an image to add it as a floor plan" onFiles={(fs) => void add(fs[0])}>
    <section>
      <div className="card-head wrap">
        <div className="seg" role="tablist" aria-label="Floor plans">{plans.map((p, i) => (
          <button key={p.id} type="button" role="tab" aria-selected={plan?.id === p.id} className={"seg-btn" + (plan?.id === p.id ? " on" : "")} onClick={() => setCurrent(i)}>{p.name}</button>))}</div>
        {editable && <><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ""; }} />
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy}><ImagePlus size={14} />{busy ? "Uploading…" : "Add floor plan"}</Button></>}
      </div>
      {!plan ? <EmptyState icon={<MapPin size={24} />} title="No floor plans">Upload a floor plan image (PNG, JPG or WebP) and pin assets on it, so people can find equipment fast.</EmptyState>
        : <PlanCanvas key={plan.id} loc={loc} plan={plan} editable={editable} onChanged={refresh} />}
    </section>
    </DropZone>
  );
}

function PlanCanvas({ loc, plan, editable, onChanged }: { loc: LocationDetail; plan: FloorPlan; editable: boolean; onChanged: () => void }) {
  const nav = useNavigate();
  const { toast } = useToast();
  const [open, setOpen] = useState<null | "view" | "edit">(null);
  const [confirm, setConfirm] = useState(false);
  const [aspect, setAspect] = useState(0.66);
  const base = `/locations/${loc.id}/floor-plans/${plan.id}`;
  const delPlan = useMutation({ mutationFn: () => api(base, { method: "DELETE" }), onSuccess: () => { onChanged(); toast("Floor plan removed"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const shapes = (plan.annotations?.shapes ?? []) as unknown as Shape[];
  return (
    <div className="card-body stack">
      <div className="plan-box fp-preview" role="button" tabIndex={0} aria-label={`Open ${plan.name} full screen`} title="Open full screen"
        onClick={() => setOpen("view")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen("view"); } }}>
        <img src={plan.url} alt={`Floor plan: ${plan.name}`} draggable={false} onLoad={(e) => setAspect(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth || 0.66)} />
        <PlanShapes shapes={shapes} aspect={aspect} onOpen={(s) => nav(s.location_id ? `/locations/${s.location_id}` : `/assets/${s.asset_id}`)} />
        {plan.pins.map((p) => (
          <button key={p.id} type="button" className={"plan-pin" + (p.asset_status ? " " + p.asset_status : "")} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            title={p.label} aria-label={`${p.label}${p.asset_id ? " (asset)" : ""}`} onClick={(e) => { e.stopPropagation(); if (p.asset_id) nav(`/assets/${p.asset_id}`); else setOpen("view"); }}>
            <MapPin size={22} /><span className="plan-pin-label">{p.label}</span>
          </button>))}
        <span className="fp-open-hint"><Maximize2 size={14} />Open</span>
      </div>
      <div className="row small muted wrap" style={{ justifyContent: "space-between" }}>
        <span>{editable ? "Open the plan to zoom in, or edit it to draw rooms, add pins and link areas to locations." : "Click the plan to open it full screen. Click a pin or a linked area to open it."}</span>
        {editable && <span className="row" style={{ gap: 6 }}>
          <Button size="sm" onClick={() => setOpen("edit")}><Pencil size={14} />Edit plan</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><Trash2 size={14} />Remove this plan</Button></span>}
      </div>
      {open && <FloorPlanEditor locId={loc.id} plan={plan} editable={editable} startEditing={open === "edit"} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {confirm && <Modal title="Remove floor plan?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => { setConfirm(false); delPlan.mutate(); }}>Remove</Button></>}><p>{plan.name}, its pins and its drawing will be removed.</p></Modal>}
    </div>
  );
}
