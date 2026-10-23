// Public work order page for people outside the organization (0.5.0: r058–r060, r092). No login: the secret link in
// the URL is the credential, so this page never uses the session and only calls /api/v1/external/<token>/….
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, FileText, MapPin, Paperclip, Send, Wrench } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { LogoMark } from "../../components/Logo";
import { Button, EmptyState, Field, Input, Modal, Pill, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { SignaturePad } from "../../components/pickers";
import "../../styles/external.css";

type Access = "hidden" | "view" | "interact";
type PubFile = { id: string; name: string; content_type: string; size: number; is_image: boolean; url: string; thumb_url: string | null };
type Item = { id: string; type: string; label: string; description?: string; required?: boolean; options?: string[]; items?: Item[]; link?: string; reference_file_ids?: string[] };
type Answer = { value: unknown; result: string; note: string; files: PubFile[]; skipped: boolean; answered_by: string | null; answered_at: string | null };
type Run = { id: string; procedure: { name: string } | null; schema: { items: Item[] }; status: string; progress: { answered: number; total: number } | Record<string, number>;
  answers: Record<string, Answer>; reference_files: Record<string, PubFile> };
type View = {
  organization: string; number: number; title: string; access: Record<string, Access>; finished_at: string | null; finished_by_name: string;
  description?: string; status?: "open" | "on_hold" | "in_progress" | "done" | "canceled"; sub_status?: string; priority?: "none" | "low" | "medium" | "high";
  start_at?: string | null; due_at?: string | null; overdue?: boolean; location?: { name: string } | null; assets?: { name: string }[];
  assignees?: { name: string; type: string }[]; categories?: { name: string; color: string }[]; files?: PubFile[]; procedures?: Run[];
  comments?: { id: string; body: string; author: string; external: boolean; files: PubFile[]; created_at: string }[];
};

const NAME_KEY = "mpro.external.name";
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };

function token(): string { return decodeURIComponent(window.location.pathname.replace(/^\/x\//, "").split("/")[0] ?? ""); }

async function uploadFile(t: string, file: File): Promise<PubFile> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/v1/external/${encodeURIComponent(t)}/files`, { method: "POST", body: fd, credentials: "omit", referrerPolicy: "no-referrer" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message || "The upload failed. Try again.");
  return data as PubFile;
}

function FileChips({ files }: { files: PubFile[] }) {
  if (!files.length) return null;
  return <div className="row wrap" style={{ gap: 8 }}>{files.map((f) => f.is_image && f.thumb_url
    ? <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="ext-thumb"><img src={f.thumb_url} alt={f.name} referrerPolicy="no-referrer" /></a>
    : <a key={f.id} href={f.url + "?download=1"} rel="noopener noreferrer" className="chip"><FileText size={13} />{f.name}</a>)}</div>;
}

function flatten(items: Item[]): Item[] { return items.flatMap((i) => i.type === "section" || i.type === "procedure" ? [i, ...flatten(i.items ?? [])] : [i]); }

function AnswerField({ t, run, item, a, name, canEdit, onSaved }: { t: string; run: Run; item: Item; a?: Answer; name: string; canEdit: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const [sig, setSig] = useState<string | null>(null);
  const [text, setText] = useState(a?.value != null && typeof a.value !== "object" ? String(a.value) : "");
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/external/${encodeURIComponent(t)}/procedures/${run.id}/answers/${item.id}`, { method: "PUT", body: { name, ...body } }),
    onSuccess: onSaved, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const ask = () => { if (!name.trim()) { toast("Type your name at the top first.", { kind: "error" }); return false; } return true; };
  const put = (value: unknown, extra: Record<string, unknown> = {}) => { if (ask()) save.mutate({ value, ...extra }); };
  const dis = !canEdit || save.isPending;
  const v = a?.value;
  const choice = (opts: [string, string][], cur: string) => <div className="row wrap" style={{ gap: 6 }}>{opts.map(([id, label]) =>
    <Button key={id} size="sm" variant={cur === id ? "primary" : "default"} disabled={dis} onClick={() => put(id)}>{label}</Button>)}</div>;
  let control: React.ReactNode;
  switch (item.type) {
    case "checkbox": control = <label className="check"><input type="checkbox" checked={!!v} disabled={dis} onChange={(e) => put(e.target.checked)} /><span>{v ? "Done" : "Not done"}</span></label>; break;
    case "inspection": control = choice([["pass", "Pass"], ["flag", "Flag"], ["fail", "Fail"]], a?.result ?? ""); break;
    case "yes_no_na": control = choice([["yes", "Yes"], ["no", "No"], ["na", "N/A"]], a?.result ?? ""); break;
    case "multiple_choice": control = <Select value={String(v ?? "")} disabled={dis} onChange={(e) => put(e.target.value || null)} aria-label={item.label}><option value="">Choose…</option>{(item.options ?? []).map((o) => <option key={o}>{o}</option>)}</Select>; break;
    case "checklist": { const cur = Array.isArray(v) ? (v as string[]) : []; control = <div className="stack" style={{ gap: 4 }}>{(item.options ?? []).map((o) => <label key={o} className="check small"><input type="checkbox" disabled={dis} checked={cur.includes(o)} onChange={(e) => put(e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))} /><span>{o}</span></label>)}</div>; break; }
    case "number": case "amount": case "meter_reading": control = <div className="row"><Input type="number" inputMode="decimal" value={text} disabled={dis} onChange={(e) => setText(e.target.value)} aria-label={item.label} style={{ maxWidth: 180 }} /><Button size="sm" disabled={dis} onClick={() => put(item.type === "meter_reading" ? { value: text } : text)}>Save</Button></div>; break;
    case "date": control = <Input type="date" value={String(v ?? "").slice(0, 10)} disabled={dis} onChange={(e) => put(e.target.value || null)} aria-label={item.label} style={{ maxWidth: 200 }} />; break;
    case "text": control = <div className="stack" style={{ gap: 6 }}><textarea className="textarea" rows={2} value={text} disabled={dis} onChange={(e) => setText(e.target.value)} aria-label={item.label} /><div><Button size="sm" disabled={dis || text === String(v ?? "")} onClick={() => put(text)}>Save</Button></div></div>; break;
    case "file": control = <div className="stack" style={{ gap: 6 }}><FileChips files={a?.files ?? []} />{canEdit && <label className="btn btn-sm" style={{ alignSelf: "flex-start" }}><Paperclip size={13} />Add photos or files
      <input type="file" multiple hidden onChange={async (e) => { if (!ask()) return; const list = Array.from(e.target.files ?? []); e.target.value = "";
        try { const ups = await Promise.all(list.map((f) => uploadFile(t, f))); put(ups.map((u) => u.id)); }
        catch (err) { toast((err as ApiError).message, { kind: "error" }); } }} /></label>}</div>; break;
    case "signature": {
      const sv = v as { name?: string; signed_at?: string } | null;
      control = sv?.name ? <span className="small">Signed by <b>{sv.name}</b></span> : canEdit ? <div className="stack" style={{ gap: 6 }}><SignaturePad onChange={setSig} /><div><Button size="sm" disabled={!sig || dis} onClick={() => { if (ask()) save.mutate({ signature: sig, signed_by: name }); }}>Sign</Button></div></div> : <span className="faint small">Not signed</span>;
      break;
    }
    default: control = <span className="small muted">This field is filled in by the organization.</span>;
  }
  return (
    <div className="ext-field">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div><b>{item.label}</b>{item.required && <span className="req" aria-label="required"> *</span>}{item.description && <div className="small muted prewrap">{item.description}</div>}</div>
        {a?.answered_by && <span className="small faint">{a.answered_by}</span>}
      </div>
      {(item.reference_file_ids ?? []).length > 0 && <FileChips files={(item.reference_file_ids ?? []).map((id) => run.reference_files[id]).filter(Boolean)} />}
      {item.link && <a href={item.link} target="_blank" rel="noopener noreferrer" className="small">{item.link}</a>}
      {control}
    </div>
  );
}

function Procedures({ t, runs, name, canEdit, onSaved }: { t: string; runs: Run[]; name: string; canEdit: boolean; onSaved: () => void }) {
  return <section className="card card-pad stack"><h2><Wrench size={16} /> Procedures</h2>
    {runs.map((r) => (
      <div key={r.id} className="stack" style={{ gap: 10 }}>
        <div className="row"><h3 className="grow">{r.procedure?.name ?? "Procedure"}</h3>{r.status === "done" ? <Pill tone="success">Done</Pill> : <Pill>In progress</Pill>}</div>
        {flatten(r.schema.items).map((it) => it.type === "heading" || it.type === "section" || it.type === "procedure"
          ? (it.label ? <h4 key={it.id} className="sec-h">{it.label}</h4> : null)
          : <AnswerField key={it.id} t={t} run={r} item={it} a={r.answers[it.id]} name={name} canEdit={canEdit} onSaved={onSaved} />)}
      </div>))}
  </section>;
}

function Comments({ t, view, name, canEdit, onSaved }: { t: string; view: View; name: string; canEdit: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PubFile[]>([]);
  const [busy, setBusy] = useState(0);
  const post = useMutation({
    mutationFn: () => api(`/external/${encodeURIComponent(t)}/comments`, { method: "POST", body: { name, body, file_ids: files.map((f) => f.id) } }),
    onSuccess: () => { setBody(""); setFiles([]); onSaved(); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return <section className="card card-pad stack"><h2>Comments</h2>
    {(view.comments ?? []).map((c) => (
      <div key={c.id} className="ext-comment"><div className="small"><b>{c.author}</b> <span className="faint">· {timeAgo(c.created_at)}</span></div>
        {c.body && <p className="prewrap" style={{ margin: "4px 0" }}>{c.body}</p>}<FileChips files={c.files} /></div>))}
    {!view.comments?.length && <p className="small muted">No comments yet.</p>}
    {canEdit && <div className="stack" style={{ gap: 6 }}>
      <textarea className="textarea" rows={3} placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Comment" />
      {files.length > 0 && <div className="row wrap small">{files.map((f) => <span key={f.id} className="chip">{f.name}</span>)}</div>}
      <div className="row">
        <label className="btn btn-sm"><Paperclip size={13} />{busy ? "Uploading…" : "Attach"}
          <input type="file" multiple hidden onChange={async (e) => { const list = Array.from(e.target.files ?? []); e.target.value = "";
            for (const f of list) { setBusy((n) => n + 1); try { const up = await uploadFile(t, f); setFiles((x) => [...x, up]); } catch (err) { toast((err as ApiError).message, { kind: "error" }); } finally { setBusy((n) => n - 1); } } }} /></label>
        <span className="grow" />
        <Button variant="primary" size="sm" disabled={post.isPending || busy > 0 || (!body.trim() && !files.length) || !name.trim()} onClick={() => post.mutate()}><Send size={13} />Post</Button>
      </div>
      {!name.trim() && <span className="small faint">Type your name at the top to comment.</span>}
    </div>}
  </section>;
}

export function ExternalWorkOrder() {
  const t = token();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(readName);
  const [finishing, setFinishing] = useState(false);
  const [note, setNote] = useState("");
  const q = useQuery({ queryKey: ["external", t], queryFn: () => api<View>(`/external/${encodeURIComponent(t)}`), retry: false, refetchInterval: 60_000 });
  const metaAdded = useRef(false);
  useEffect(() => { // don't leak the link through the Referer header
    if (metaAdded.current) return; metaAdded.current = true;
    const m = document.createElement("meta"); m.name = "referrer"; m.content = "no-referrer"; document.head.appendChild(m);
  }, []);
  useEffect(() => { if (q.data) document.title = `#${q.data.number} ${q.data.title} · ${q.data.organization}`; }, [q.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["external", t] });
  const finish = useMutation({
    mutationFn: () => api(`/external/${encodeURIComponent(t)}/finish`, { method: "POST", body: { name, note } }),
    onSuccess: () => { setFinishing(false); setNote(""); refresh(); toast("Thanks — they've been told the work is finished."); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });

  const shell = (children: React.ReactNode) => <div className="ext-page"><header className="ext-top"><LogoMark size={26} /><span className="grow">{q.data?.organization ?? "Maintenance Pro"}</span></header><main className="ext-main stack">{children}</main></div>;
  if (q.isLoading) return shell(<p className="muted">Loading…</p>);
  if (q.isError || !q.data) {
    const st = (q.error as ApiError | null)?.status;
    return shell(<EmptyState title={st === 429 ? "Too many requests" : "This link doesn't work"}>
      {st === 429 ? "Wait a few minutes and try again." : "It may have been turned off, replaced with a new link, or the work may be complete. Ask the person who sent it for a new link."}
    </EmptyState>);
  }
  const v = q.data;
  const can = (f: string, want: "view" | "interact" = "view") => want === "interact" ? v.access[f] === "interact" : v.access[f] === "view" || v.access[f] === "interact";
  const anyInteract = can("comments", "interact") || can("procedures", "interact");
  return shell(<>
    <section className="card card-pad stack">
      <div className="small muted mono">Work order #{v.number}</div>
      <h1 className="wo-title" style={{ margin: 0 }}>{v.title}</h1>
      {(v.status || v.priority) && <div className="row wrap">{v.status && <StatusPill status={v.status} sub={v.sub_status} />}{v.priority && <PriorityBadge priority={v.priority} />}
        {v.due_at && <span className={"due " + (v.overdue ? "danger" : "")}><Clock size={13} />Due {dateTime(v.due_at)}</span>}</div>}
      <dl className="meta-grid">
        {v.start_at !== undefined && <div><dt>Start</dt><dd>{v.start_at ? dateTime(v.start_at) : "—"}</dd></div>}
        {v.location !== undefined && <div><dt>Location</dt><dd>{v.location ? <span className="row" style={{ gap: 6 }}><MapPin size={14} className="faint" />{v.location.name}</span> : "—"}</dd></div>}
        {v.assets !== undefined && <div><dt>Asset</dt><dd>{v.assets.length ? v.assets.map((a) => a.name).join(", ") : "—"}</dd></div>}
        {v.assignees !== undefined && <div><dt>Assigned to</dt><dd>{v.assignees.map((a) => a.name).join(", ") || "—"}</dd></div>}
        {v.categories !== undefined && <div><dt>Categories</dt><dd>{v.categories.map((c) => c.name).join(", ") || "—"}</dd></div>}
      </dl>
      {v.description && <p className="prewrap">{v.description}</p>}
      {v.files && v.files.length > 0 && <FileChips files={v.files} />}
    </section>
    {anyInteract && <section className="card card-pad row wrap">
      <Field label="Your name" hint="Shown next to what you add." className="grow">{(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => { setName(e.target.value); saveName(e.target.value); }} placeholder="Jo Smith, Acme Mechanical" />}</Field>
    </section>}
    {v.procedures && v.procedures.length > 0 && <Procedures t={t} runs={v.procedures} name={name} canEdit={can("procedures", "interact")} onSaved={refresh} />}
    {v.comments !== undefined && <Comments t={t} view={v} name={name} canEdit={can("comments", "interact")} onSaved={refresh} />}
    <section className="card card-pad row wrap">
      {v.finished_at ? <div className="row grow"><CheckCircle2 size={18} className="ok" /><span>Marked finished by <b>{v.finished_by_name}</b> {timeAgo(v.finished_at)}. {v.organization} will review and close it.</span></div>
        : <><span className="grow small muted">Done with the work? Let {v.organization} know.</span><Button variant="primary" onClick={() => setFinishing(true)}><CheckCircle2 size={15} />Mark work finished</Button></>}
    </section>
    <p className="small faint" style={{ textAlign: "center" }}>Keep this link private: anyone with it can see and add to this work order.</p>
    {finishing && <Modal title="Mark the work finished" onClose={() => setFinishing(false)}
      footer={<><Button onClick={() => setFinishing(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || finish.isPending} onClick={() => finish.mutate()}>Mark finished</Button></>}>
      <div className="stack">
        <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => { setName(e.target.value); saveName(e.target.value); }} />}</Field>
        <Field label="Note (optional)">{(id) => <textarea id={id} className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, anything they should know" />}</Field>
      </div>
    </Modal>}
  </>);
}
