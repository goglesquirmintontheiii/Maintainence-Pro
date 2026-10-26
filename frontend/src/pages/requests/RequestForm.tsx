// New / edit request (MP-047, r274): title, description, priority, location, asset (and its status), "Assign to" team
// routing, request custom fields and pictures. The form brings its own location and asset lists, so requesters who
// can't browse assets can still say what's broken. Opened from /requests/new?asset_id=… by QR stickers (r276).
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, ImagePlus, X } from "lucide-react";
import { api, ApiError, upload, type FileItem } from "../../lib/api";
import { Button, Drawer, Field, Input, Select } from "../../components/ui";
import { DropZone } from "../../components/DropZone";
import { MultiPicker } from "../../components/pickers";
import { CustomInput } from "../workorders/Form";
import { FIELD_LABELS, useRequestForm, type FieldKey, type WorkRequest } from "./types";

const PRIOS: [WorkRequest["priority"], string][] = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const ACCEPT = "image/*,.pdf,.mp4,.mov,.heic";

type FormState = {
  title: string; description: string; priority: WorkRequest["priority"]; location_id: string | null; asset_id: string | null;
  asset_status: string; team_id: string | null; route_other: boolean; custom: Record<string, unknown>;
};

export function RequestForm({ edit, prefill, onClose, onSaved }: {
  edit?: WorkRequest; prefill?: { asset_id?: string | null; location_id?: string | null }; onClose: () => void; onSaved: (r: WorkRequest) => void;
}) {
  const cfg = useRequestForm();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(() => ({
    title: edit?.title ?? "", description: edit?.description ?? "", priority: edit?.priority ?? "none",
    location_id: edit?.location?.id ?? prefill?.location_id ?? null, asset_id: edit?.asset?.id ?? prefill?.asset_id ?? null,
    asset_status: edit?.asset_status ?? "", team_id: edit?.team?.id ?? null, route_other: edit?.route_other ?? false, custom: { ...(edit?.custom ?? {}) },
  }));
  const set = (p: Partial<FormState>) => setF((x) => ({ ...x, ...p }));
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const locs = useQuery({ queryKey: ["request-form", "locations"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/requests/form/locations"), staleTime: 60_000 });
  const assets = useQuery({ queryKey: ["request-form", "assets"], queryFn: () => api<{ items: { id: string; name: string; location: string; location_id: string | null }[] }>("/requests/form/assets"), staleTime: 60_000 });
  const pre = useQuery({
    queryKey: ["request-form", "prefill", prefill?.asset_id, prefill?.location_id],
    queryFn: () => api<{ asset: { id: string; location_id: string | null } | null; location: { id: string } | null }>(
      `/requests/form/prefill?${prefill?.asset_id ? `asset_id=${prefill.asset_id}` : `location_id=${prefill?.location_id ?? ""}`}`),
    enabled: !edit && !!(prefill?.asset_id || prefill?.location_id),
  });
  useEffect(() => {
    if (pre.data) setF((x) => ({ ...x, asset_id: pre.data.asset?.id ?? null, location_id: pre.data.location?.id ?? x.location_id }));
  }, [pre.data]);
  const c = cfg.data;
  const shown = (k: FieldKey) => (c?.fields[k] ?? "optional") !== "hidden";
  const req = (k: FieldKey) => (c?.fields[k] === "required" ? " *" : "");
  const missing: string[] = [];
  if (!f.title.trim()) missing.push("Title");
  if (c) {
    if (c.fields.description === "required" && !f.description.trim()) missing.push("Description");
    if (c.fields.priority === "required" && f.priority === "none") missing.push("Priority");
    if (c.fields.location === "required" && !f.location_id) missing.push("Location");
    if (c.fields.asset === "required" && !f.asset_id) missing.push("Asset");
    if (!edit && c.fields.attachments === "required" && files.length === 0) missing.push("Pictures and files");
    if (c.assign_to === "required" && !f.team_id && !f.route_other) missing.push("Assign to");
    for (const cf of c.custom_fields) if (cf.required && (f.custom[cf.id] ?? "") === "") missing.push(cf.name);
  }
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { title: f.title.trim(), custom: f.custom };
      if (shown("description")) body.description = f.description;
      if (shown("priority")) body.priority = f.priority;
      if (shown("location")) body.location_id = f.location_id;
      if (shown("asset")) { body.asset_id = f.asset_id; body.asset_status = f.asset_id ? f.asset_status : ""; }
      if (c && c.assign_to !== "hidden") { body.team_id = f.route_other ? null : f.team_id; body.route_other = f.route_other; }
      if (edit) return api<WorkRequest>(`/requests/${edit.id}`, { method: "PATCH", body });
      return api<WorkRequest>("/requests", { method: "POST", body: { ...body, file_ids: files.map((x) => x.id), source: prefill?.asset_id || prefill?.location_id ? "qr" : undefined } });
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["requests"] }); onSaved(r); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const onFiles = async (list: FileList | File[] | null) => {
    if (!list) return;
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1);
      try { const up = await upload(file); setFiles((fs) => [...fs, up]); }
      catch (e) { setErr((e as ApiError).message); }
      finally { setUploading((n) => n - 1); }
    }
  };
  const assetOpts = (assets.data?.items ?? []).filter((a) => !f.location_id || a.location_id === f.location_id || a.id === f.asset_id)
    .map((a) => ({ key: a.id, label: a.name, sub: a.location }));
  return (
    <Drawer title={edit ? `Edit request #${edit.number}` : "New request"} onClose={onClose} width={560}
      footer={<>
        <span className="small faint grow">{missing.length ? `Still needed: ${missing.join(", ")}` : ""}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={missing.length > 0 || save.isPending || uploading > 0} onClick={() => save.mutate()}>
          {save.isPending ? "Sending…" : edit ? "Save" : "Submit request"}</Button>
      </>}>
      <Field label="What's the problem? *">{(id) => <Input id={id} value={f.title} maxLength={255} autoFocus placeholder="e.g. Water leaking under the sink in the break room"
        onChange={(e) => set({ title: e.target.value })} />}</Field>
      {shown("description") && <Field label={FIELD_LABELS.description + req("description")}>{(id) => (
        <textarea id={id} className="textarea" rows={4} maxLength={4000} value={f.description} placeholder="Where is it, what did you notice, is anything unsafe?"
          onChange={(e) => set({ description: e.target.value })} />)}</Field>}
      {!edit && shown("attachments") && (
        <div className="field"><span className="label">{FIELD_LABELS.attachments + req("attachments")}</span>
          <DropZone onFiles={(fs) => void onFiles(fs)} accept={ACCEPT}><div className="dropzone">
            <ImagePlus size={20} className="faint" /><span>Drag photos here, or <button type="button" className="linkbtn" onClick={() => input.current?.click()}>take or choose a photo</button></span>
            <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          </div></DropZone>
          {(files.length > 0 || uploading > 0) && <div className="row wrap">{files.map((x) => (
            <span key={x.id} className="chip">{x.is_image ? <ImagePlus size={13} /> : <FileText size={13} />}{x.name}
              <button type="button" className="linkbtn" aria-label={`Remove ${x.name}`} onClick={() => setFiles((fs) => fs.filter((y) => y.id !== x.id))}><X size={12} /></button></span>))}
            {uploading > 0 && <span className="small faint" role="status">Uploading {uploading}…</span>}</div>}
        </div>)}
      <div className="form-grid">
        {shown("priority") && <Field label={FIELD_LABELS.priority + req("priority")} className="full">{() => (
          <div className="seg" role="radiogroup" aria-label="Priority">{PRIOS.map(([k, l]) => (
            <button type="button" key={k} role="radio" aria-checked={f.priority === k} className={"seg-btn prio-" + k + (f.priority === k ? " on" : "")}
              onClick={() => set({ priority: k })}>{l}</button>))}</div>)}</Field>}
        {shown("location") && <Field label={FIELD_LABELS.location + req("location")}>{(id) => (
          <MultiPicker id={id} single label="Location" placeholder="Pick a location" searchPlaceholder="Search locations"
            options={(locs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name }))} value={f.location_id ? [f.location_id] : []}
            onChange={(v) => set({ location_id: v[0] ?? null, asset_id: v[0] && f.asset_id && assets.data?.items.find((a) => a.id === f.asset_id)?.location_id !== v[0] ? null : f.asset_id })} />)}</Field>}
        {shown("asset") && <Field label={FIELD_LABELS.asset + req("asset")}>{(id) => (
          <MultiPicker id={id} single label="Asset" placeholder="Pick an asset" searchPlaceholder="Search assets" options={assetOpts}
            value={f.asset_id ? [f.asset_id] : []}
            onChange={(v) => { const a = assets.data?.items.find((x) => x.id === v[0]); set({ asset_id: v[0] ?? null, location_id: a?.location_id ?? f.location_id }); }} />)}</Field>}
        {shown("asset") && f.asset_id && <Field label="Is the asset still running?" className="full">{() => (
          <div className="seg" role="radiogroup" aria-label="Asset status">{[["", "Not sure"], ["online", "Running"], ["offline", "Down"]].map(([k, l]) => (
            <button type="button" key={k} role="radio" aria-checked={f.asset_status === k} className={"seg-btn" + (f.asset_status === k ? " on" : "")}
              onClick={() => set({ asset_status: k })}>{l}</button>))}</div>)}</Field>}
        {c && c.assign_to !== "hidden" && <Field label={"Assign to" + (c.assign_to === "required" ? " *" : "")} hint="Which team should look at it?">{(id) => (
          <Select id={id} value={f.route_other ? "__other" : f.team_id ?? ""} onChange={(e) => {
            const v = e.target.value; set(v === "__other" ? { route_other: true, team_id: null } : { route_other: false, team_id: v || null });
          }}>
            <option value="">—</option>{c.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            {c.allow_other && <option value="__other">Other (administrators)</option>}
          </Select>)}</Field>}
      </div>
      {(c?.custom_fields.length ?? 0) > 0 && <div className="form-grid">{c!.custom_fields.map((cf) => (
        <CustomInput key={cf.id} def={cf} value={f.custom[cf.id]} onChange={(v) => set({ custom: { ...f.custom, [cf.id]: v } })} />))}</div>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Drawer>
  );
}
