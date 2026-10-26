// Public request portal (r279, r300, r265) and the no-login status page (r603). No sign-in: the portal's link (or a
// QR sticker) is all it takes. The page only knows the portal's own settings and the one asset or location a sticker
// names; it never lists the organization's assets, locations or other requests.
import { useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, ImagePlus, MapPin, X } from "lucide-react";
import { api, ApiError, type CustomFieldDef } from "../../lib/api";
import { LogoMark } from "../../components/Logo";
import { DropZone } from "../../components/DropZone";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Pill } from "../../components/ui";
import { CustomInput } from "../workorders/Form";
import { FIELD_LABELS, REQUEST_STATUS, REQUEST_TONE, type FieldKey, type FieldState, type RequestStatus } from "./types";
import "./requests.css";
import "../purchasing/purchasing.css";

type PublicPortal = {
  name: string; intro: string; org_name: string; fields: Record<FieldKey, FieldState>; require_email: boolean;
  asset: { id: string; name: string } | null; location: { id: string; name: string } | null;
  custom_fields: Pick<CustomFieldDef, "id" | "name" | "type" | "options" | "required">[];
};
type Uploaded = { id: string; name: string; is_image: boolean };
const PRIOS: [string, string][] = [["none", "Not urgent"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]];

async function uploadPublic(slug: string, file: File): Promise<Uploaded> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/v1/portal/${encodeURIComponent(slug)}/files`, { method: "POST", body: fd, credentials: "omit" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message || "Upload failed.");
  return data as Uploaded;
}

function Shell({ org, children }: { org?: string; children: React.ReactNode }) {
  return <div className="pq-page"><div className="pq-card"><div className="row" style={{ gap: 10 }}><LogoMark size={28} /><b className="grow">{org ?? ""}</b></div>{children}</div></div>;
}

export function PublicPortalPage() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const asset = params.get("asset"), loc = params.get("location");
  const q = useQuery({
    queryKey: ["portal", slug, asset, loc], retry: false,
    queryFn: () => api<PublicPortal>(`/portal/${encodeURIComponent(slug)}${asset ? `?asset=${encodeURIComponent(asset)}` : loc ? `?location=${encodeURIComponent(loc)}` : ""}`),
  });
  const [f, setF] = useState({ title: "", description: "", priority: "none", name: "", email: "", phone: "", notify_email: true, website: "" });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ number: number; status_path: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: () => api<{ number: number; status_path: string }>(`/portal/${encodeURIComponent(slug)}/requests`, { method: "POST", body: {
      ...f, notify_email: f.notify_email && !!f.email.trim(), custom, file_ids: files.map((x) => x.id), asset_id: q.data?.asset?.id, location_id: q.data?.location?.id,
    } }),
    onSuccess: setDone, onError: (e) => setErr((e as ApiError).message),
  });
  if (q.isLoading) return <Shell><ListSkeleton rows={5} /></Shell>;
  if (q.isError || !q.data) return <Shell><EmptyState title="This request form isn't available">The link may be old or the form turned off. Ask the maintenance team for a new link.</EmptyState></Shell>;
  const p = q.data;
  const shown = (k: FieldKey) => p.fields[k] !== "hidden";
  const req = (k: FieldKey) => (p.fields[k] === "required" ? " *" : "");
  if (done) {
    const link = location.origin + done.status_path;
    return <Shell org={p.org_name}>
      <div className="req-done"><CheckCircle2 size={40} color="var(--c-success)" /><h1 className="wo-title">Thanks, we got it</h1>
        <p>Your request is <b>#{done.number}</b>. {f.email && f.notify_email ? "We'll email you when it's approved, declined or done." : ""}</p>
        <p className="small muted">Keep this link to check on it later. No account needed.</p>
        <div className="row req-link-row"><a href={done.status_path} className="mono small grow">{link}</a>
          <Button size="sm" icon aria-label="Copy link" onClick={() => void navigator.clipboard?.writeText(link)}><Copy size={14} /></Button></div>
        <Button onClick={() => { setDone(null); setF({ ...f, title: "", description: "" }); setFiles([]); setCustom({}); }}>Report something else</Button>
      </div></Shell>;
  }
  const missing: string[] = [];
  if (!f.title.trim()) missing.push("What's wrong");
  if (!f.name.trim()) missing.push("Your name");
  if (p.require_email && !f.email.trim()) missing.push("Email");
  if (p.fields.description === "required" && !f.description.trim()) missing.push("Description");
  if (p.fields.priority === "required" && f.priority === "none") missing.push("Priority");
  if (p.fields.attachments === "required" && !files.length) missing.push("Photo");
  for (const cf of p.custom_fields) if (cf.required && (custom[cf.id] ?? "") === "") missing.push(cf.name);
  const onFiles = async (list: FileList | File[] | null) => {
    for (const file of Array.from(list ?? [])) {
      setUploading((n) => n + 1);
      try { const up = await uploadPublic(slug, file); setFiles((fs) => [...fs, up]); } catch (e) { setErr((e as ApiError).message); } finally { setUploading((n) => n - 1); }
    }
  };
  return (
    <Shell org={p.org_name}>
      <div><h1 className="wo-title" style={{ margin: 0 }}>{p.name}</h1>{p.intro && <p className="prewrap muted" style={{ margin: "6px 0 0" }}>{p.intro}</p>}</div>
      {(p.asset || p.location) && <div className="chip req-target"><MapPin size={14} />{[p.asset?.name, p.location?.name].filter(Boolean).join(" · ")}</div>}
      <Field label="What's wrong? *">{(id) => <Input id={id} value={f.title} maxLength={255} placeholder="e.g. The front door won't lock" onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
      {shown("description") && <Field label={FIELD_LABELS.description + req("description")}>{(id) => <textarea id={id} className="textarea" rows={4} maxLength={4000}
        placeholder="Where exactly, and anything we should know" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>}
      {shown("priority") && <Field label={"How urgent is it?" + req("priority")}>{() => (
        <div className="seg" role="radiogroup" aria-label="Priority">{PRIOS.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={f.priority === k} className={"seg-btn" + (f.priority === k ? " on" : "")} onClick={() => setF({ ...f, priority: k })}>{l}</button>))}</div>)}</Field>}
      {shown("attachments") && <div className="field"><span className="label">Photos{req("attachments")}</span>
        <DropZone onFiles={(fs) => void onFiles(fs)} accept="image/*,.pdf,.mp4,.mov"><div className="dropzone">
          <ImagePlus size={20} className="faint" /><span>Drag photos here, or <button type="button" className="linkbtn" onClick={() => input.current?.click()}>take or choose a photo</button></span>
          <input ref={input} type="file" multiple hidden accept="image/*,.pdf,.mp4,.mov" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
        </div></DropZone>
        {(files.length > 0 || uploading > 0) && <div className="row wrap">{files.map((x) => <span key={x.id} className="chip">{x.name}
          <button type="button" className="linkbtn" aria-label={`Remove ${x.name}`} onClick={() => setFiles((fs) => fs.filter((y) => y.id !== x.id))}><X size={12} /></button></span>)}
          {uploading > 0 && <span className="small faint" role="status">Uploading {uploading}…</span>}</div>}</div>}
      {p.custom_fields.length > 0 && <div className="form-grid">{p.custom_fields.map((cf) => (
        <CustomInput key={cf.id} def={{ ...cf, required: cf.required }} value={custom[cf.id]} onChange={(v) => setCustom({ ...custom, [cf.id]: v })} />))}</div>}
      <hr className="divider" style={{ margin: 0 }} />
      <div className="form-grid">
        <Field label="Your name *">{(id) => <Input id={id} value={f.name} maxLength={200} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={"Email" + (p.require_email ? " *" : "")}>{(id) => <Input id={id} type="email" value={f.email} maxLength={320} autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone} maxLength={60} autoComplete="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
      </div>
      {f.email && <Checkbox checked={f.notify_email} onChange={(v) => setF({ ...f, notify_email: v })} label="Email me when it's approved, declined or done" />}
      <input className="req-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} name="website" />
      {err && <div className="banner warning" role="alert">{err}</div>}
      <div className="row"><span className="small faint grow">{missing.length ? `Still needed: ${missing.join(", ")}` : ""}</span>
        <Button variant="primary" disabled={missing.length > 0 || send.isPending || uploading > 0} onClick={() => { setErr(""); send.mutate(); }}>{send.isPending ? "Sending…" : "Send request"}</Button></div>
    </Shell>
  );
}

type Status = { org_name: string; number: number; title: string; status: RequestStatus; status_label: string; decline_reason: string;
  work_order: { number: number; status: string } | null; created_at: string; updated_at: string };
const WO_STATUS: Record<string, string> = { open: "Open", on_hold: "On hold", in_progress: "In progress", done: "Done", canceled: "Canceled" };

export function RequestStatusPage() {
  const { token = "" } = useParams();
  const q = useQuery({ queryKey: ["request-status", token], queryFn: () => api<Status>(`/request-status/${encodeURIComponent(token)}`), retry: false, refetchInterval: 60_000 });
  if (q.isLoading) return <Shell><ListSkeleton rows={3} /></Shell>;
  if (q.isError || !q.data) return <Shell><EmptyState title="This status link isn't valid">Check that you copied the whole link from your email.</EmptyState></Shell>;
  const d = q.data;
  return (
    <Shell org={d.org_name}>
      <div><div className="small muted">Request #{d.number}</div><h1 className="wo-title" style={{ margin: "4px 0" }}>{d.title}</h1>
        <Pill tone={REQUEST_TONE[d.status]}>{REQUEST_STATUS[d.status]}</Pill></div>
      <ol className="req-steps">
        <li className="on">Sent {new Date(d.created_at).toLocaleString()}</li>
        <li className={d.status !== "pending" ? "on" : ""}>{d.status === "declined" ? "Declined" : d.status === "pending" ? "Waiting for review" : "Approved"}</li>
        {d.work_order && <li className="on">Work order #{d.work_order.number}: {WO_STATUS[d.work_order.status] ?? d.work_order.status}</li>}
        <li className={d.status === "done" ? "on" : ""}>{d.status === "canceled" ? "Canceled" : "Done"}</li>
      </ol>
      {d.status === "declined" && d.decline_reason && <div className="banner warning"><b>Why:</b> {d.decline_reason}</div>}
      <p className="small faint" style={{ margin: 0 }}>Last update {new Date(d.updated_at).toLocaleString()}. This page refreshes by itself.</p>
    </Shell>
  );
}
