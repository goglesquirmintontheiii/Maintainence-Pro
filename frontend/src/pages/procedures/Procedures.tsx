// Procedures library (MaintainX "Procedures", 0.4.0 MP-034–037): list with search, status, tag and category filters;
// detail with a preview, version history (r206), work-order history (r207) and analytics (r596); create blank, from a
// built-in template (r209) or by importing a CSV or PDF (MP-036); copy, archive, delete (r208); the builder at /:id/edit.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, ArrowLeft, ClipboardCheck, ClipboardList, Copy, Download, FilePlus2, FileUp, LayoutTemplate, MoreHorizontal, Pencil, Plus, Search, Trash2,
} from "lucide-react";
import { api, ApiError, getCsrf, type ExportItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { STATUS_LABEL } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { DropZone } from "../../components/DropZone";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, StatusPill } from "../../components/ui";
import { ProcedureBuilder } from "./Builder";
import { PreviewForm } from "./Runner";
import { ProcedureAnalytics } from "./Analytics";
import { MONTHS, fieldsOf, useProcOptions, walk, type Library, type Procedure, type ProcedureDetail, type Schema, type Version } from "./types";
import "../../styles/procedures.css";
import { ScanRequirementPanel } from "../scan/ScanRequirement"; // 0.6.0 scan to start or complete (MP-097)

// an imported schema waiting for the builder (the route change remounts the page, so it can't live in state)
let pendingImport: { name: string; schema: Schema } | null = null;

export function ProceduresPage() {
  const { id, mode } = useParams();
  const [init] = useState(() => (id === "new" ? pendingImport : null));
  useEffect(() => { pendingImport = null; }, []);
  if (id && mode === "edit") return <ProcedureBuilder id={id} init={id === "new" ? init : null} />;
  return <Library id={id} onImported={(v) => { pendingImport = v; }} />;
}

function Library({ id, onImported }: { id?: string; onImported: (v: { name: string; schema: Schema }) => void }) {
  const { can } = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const manage = can("procedures.manage");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [tag, setTag] = useState(params.get("tag") ?? "");
  const [cat, setCat] = useState("");
  const [dialog, setDialog] = useState<"template" | "import" | null>(null);
  useEffect(() => { const s = new URLSearchParams(params); if (tag) s.set("tag", tag); else s.delete("tag"); if (status) s.set("status", status); else s.delete("status"); setParams(s, { replace: true }); }, [tag, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = `q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`;
  const list = useQuery({ queryKey: ["procedures", qs], queryFn: () => api<Library>(`/procedures?${qs}`), placeholderData: (p) => p });
  const items = list.data?.items ?? [];
  const filtered = !!(q || status || tag || cat);

  const newMenu = manage && (
    <Dropdown width={250} trigger={(_, t) => <Button variant="primary" onClick={t} aria-label="New procedure"><Plus size={16} />New</Button>}>
      {(close) => <>
        <button className="menu-item" onClick={() => { close(); nav("/procedures/new/edit"); }}><FilePlus2 size={15} />Blank procedure</button>
        <button className="menu-item" onClick={() => { close(); setDialog("template"); }}><LayoutTemplate size={15} />From a template</button>
        <button className="menu-item" onClick={() => { close(); setDialog("import"); }}><FileUp size={15} />Import a CSV or PDF</button>
      </>}
    </Dropdown>);

  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1 style={{ fontSize: "var(--fs-lg)" }}>Procedures</h1>{newMenu}
            </div>
            <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Search procedures" aria-label="Search procedures" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="pl-filters">
              <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Published and drafts</option><option value="published">Published</option><option value="draft">Drafts</option><option value="archived">Archived</option></Select>
              <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">All tags</option>{(list.data?.tags ?? []).map((t) => <option key={t}>{t}</option>)}</Select>
              {(list.data?.categories.length ?? 0) > 1 && <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="span2">
                <option value="">All categories</option>{list.data!.categories.map((c) => <option key={c}>{c}</option>)}</Select>}
            </div>
            <div className="small muted">{list.data ? `${items.length} procedure${items.length === 1 ? "" : "s"}` : " "}
              {filtered && <> · <button className="linkbtn small" onClick={() => { setQ(""); setStatus(""); setTag(""); setCat(""); }}>Clear</button></>}</div>
          </div>
          <div className="list" role="list">
            {list.isLoading ? <ListSkeleton /> : items.length === 0 ? (
              <EmptyState icon={<ClipboardList size={26} />} title={filtered ? "No procedures match" : "No procedures yet"}
                action={!filtered && manage ? <Button variant="primary" onClick={() => setDialog("template")}><LayoutTemplate size={15} />Start from a template</Button> : undefined}>
                {filtered ? "Try clearing the filters." : "Procedures are checklists technicians fill in on work orders: inspections, readings, photos and sign-offs."}
              </EmptyState>) : items.map((p) => <ProcRow key={p.id} p={p} active={p.id === id} />)}
          </div>
        </div>
        <div className="split-detail">
          {id ? <ProcedureView id={id} key={id} /> : <EmptyState icon={<ClipboardCheck size={28} />} title="Select a procedure">Pick one from the list to preview it and see where it's used.</EmptyState>}
        </div>
      </div>
      {dialog === "template" && <TemplateDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} onReady={(v) => { onImported(v); setDialog(null); nav("/procedures/new/edit"); }} />}
    </div>);
}

function ProcRow({ p, active }: { p: Procedure; active: boolean }) {
  return (
    <Link to={`/procedures/${p.id}`} className={"list-row pl-row" + (active ? " active" : "")} role="listitem">
      <span className={"pl-ic " + p.status} aria-hidden="true"><ClipboardCheck size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t">{p.name}</div>
        <div className="s">{p.field_count} field{p.field_count === 1 ? "" : "s"}{p.category ? ` · ${p.category}` : ""}{p.tags.length ? ` · ${p.tags.slice(0, 3).join(", ")}` : ""}</div>
      </div>
      <div className="pl-side">
        {p.status === "draft" ? <Pill>Draft</Pill> : p.status === "archived" ? <Pill>Archived</Pill> : p.has_unpublished_changes ? <Pill tone="warning">Unpublished changes</Pill> : null}
        <span className="small faint">{p.work_order_count ? `${p.work_order_count} work order${p.work_order_count === 1 ? "" : "s"}` : "Not used yet"}</span>
      </div>
    </Link>);
}

type Tab = "overview" | "versions" | "history" | "analytics";
function ProcedureView({ id }: { id: string }) {
  const { can, session } = useSession();
  const tz = session.org?.timezone;
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["procedure", id], queryFn: () => api<ProcedureDetail>(`/procedures/${id}`) });
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const refresh = (p?: ProcedureDetail) => { if (p) qc.setQueryData(["procedure", id], p); qc.invalidateQueries({ queryKey: ["procedures"] }); qc.invalidateQueries({ queryKey: ["procedure", id] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const archive = useMutation({ mutationFn: (archived: boolean) => api<ProcedureDetail>(`/procedures/${id}/archive`, { method: "POST", body: { archived } }),
    onSuccess: (p) => { refresh(p); toast(p.status === "archived" ? "Archived. It can't be added to new work orders." : "Restored to the library"); }, onError: err });
  const copy = useMutation({ mutationFn: () => api<ProcedureDetail>(`/procedures/${id}/copy`, { method: "POST" }),
    onSuccess: (p) => { refresh(); toast("Copied as a draft"); nav(`/procedures/${p.id}`); }, onError: err });
  const publish = useMutation({ mutationFn: () => api<ProcedureDetail>(`/procedures/${id}/publish`, { method: "POST" }),
    onSuccess: (p) => { refresh(p); toast(`Published version ${p.published?.number}`); }, onError: err });
  const del = useMutation({ mutationFn: () => api(`/procedures/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["procedures"] }); setConfirmDelete(false); nav("/procedures");
      toast("Procedure deleted", { action: { label: "Undo", run: () => { void api(`/procedures/${id}/restore`, { method: "POST" }).then(() => { qc.invalidateQueries({ queryKey: ["procedures"] }); nav(`/procedures/${id}`); }); } } }); },
    onError: err });
  const exp = useMutation({
    mutationFn: () => api<ExportItem>("/procedures/export", { method: "POST", body: { procedure_id: id, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to + "T23:59:59").toISOString() } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["exports"] }); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
    onError: err });

  if (q.isError) return <EmptyState icon={<ClipboardList size={26} />} title="Procedure not found">It may have been deleted, or you don't have access to it.</EmptyState>;
  if (!q.data) return <div className="detail"><ListSkeleton rows={4} /></div>;
  const p = q.data;
  const shown = p.published ?? p.draft;
  const manage = can("procedures.manage") && !p.deleted;
  return (
    <div className="detail wo-detail">
      <Link to="/procedures" className="row small mobile-only"><ArrowLeft size={14} />All procedures</Link>
      {p.deleted && <div className="banner warning"><Trash2 size={18} /><div className="grow">This procedure was deleted.</div></div>}
      <div className="wo-head">
        <div className="grow">
          <div className="row small muted wrap" style={{ gap: 8 }}>
            {p.status === "published" ? <Pill tone="success">Published · v{p.published?.number}</Pill> : p.status === "archived" ? <Pill>Archived</Pill> : <Pill>Draft</Pill>}
            {p.has_unpublished_changes && <Pill tone="warning">Unpublished changes</Pill>}
            {p.category && <span>{p.category}</span>}
          </div>
          <h1 className="wo-title">{p.name}</h1>
          {p.tags.length > 0 && <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>{p.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
        </div>
        <div className="row">
          {manage && p.status !== "archived" && <Button onClick={() => nav(`/procedures/${id}/edit`)} aria-label="Edit"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          {manage && (p.status === "draft" || p.has_unpublished_changes) && <Button variant="primary" onClick={() => publish.mutate()} disabled={publish.isPending}>Publish</Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={230}>
            {(close) => <>
              {manage && <button className="menu-item" onClick={() => { close(); copy.mutate(); }}><Copy size={15} />Make a copy</button>}
              {can("exports.use") && <button className="menu-item" onClick={() => { close(); exp.mutate(); }}><Download size={15} />Export answers (CSV)</button>}
              {manage && (p.status === "archived"
                ? <button className="menu-item" onClick={() => { close(); archive.mutate(false); }}><ArchiveRestore size={15} />Unarchive</button>
                : <button className="menu-item" onClick={() => { close(); archive.mutate(true); }}><Archive size={15} />Archive</button>)}
              {can("procedures.delete") && !p.deleted && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
        </div>
      </div>

      <div className="pl-stats">
        <div className="card tile"><div className="k">Fields</div><div className="v">{shown ? fieldsOf(shown.schema).length : 0}</div></div>
        <div className="card tile"><div className="k">Work orders</div><div className="v">{p.work_order_count}</div></div>
        <div className="card tile"><div className="k">Updated</div><div className="v pl-v-sm" title={dateTime(p.updated_at, tz)}>{timeAgo(p.updated_at)}</div></div>
      </div>

      <div className="seg pl-tabs" role="tablist" aria-label="Procedure">
        {(["overview", "versions", "history", "analytics"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={"seg-btn" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
            {{ overview: "Overview", versions: "Versions", history: "Work orders", analytics: "Analytics" }[t]}</button>))}
      </div>
      {(tab === "history" || tab === "analytics") && (
        <div className="row wrap small" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 6 }}>From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
          <label className="row" style={{ gap: 6 }}>To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
          {(from || to) && <button className="linkbtn small" onClick={() => { setFrom(""); setTo(""); }}>All time</button>}
        </div>)}

      {tab === "overview" && <>
        {p.description && <p className="prewrap">{p.description}</p>}
        {p.variants.length > 0 && <section className="card card-pad small">
          <b>Seasonal variants</b>
          {p.variants.map((v) => <div key={v.procedure_id + v.name}>{v.name}: <Link to={`/procedures/${v.procedure_id}`}>another procedure</Link> in {v.months.map((m) => MONTHS[m - 1]).join(", ")}</div>)}
        </section>}
        <section className="card">
          <div className="card-head"><h2>{p.published ? `Version ${p.published.number}` : "Draft"}</h2><span className="small faint">Try it out. Nothing is saved.</span></div>
          <div className="card-body">{shown ? <PreviewForm schema={shown.schema} refs={Object.fromEntries(p.files.map((f) => [f.id, f]))} /> : <span className="faint">Empty</span>}</div>
        </section>
      </>}
      {tab === "overview" && !p.deleted && <ScanRequirementPanel procedureId={id} editable={manage && p.status !== "archived"} />}
      {tab === "versions" && <Versions id={id} tz={tz} />}
      {tab === "history" && <History id={id} from={from} to={to} tz={tz} />}
      {tab === "analytics" && <ProcedureAnalytics id={id} from={from} to={to} tz={tz} />}

      {confirmDelete && <Modal title="Delete procedure?" onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>“{p.name}” leaves the library. Work orders that already use it keep their copy and answers.</p></Modal>}
    </div>);
}

function Versions({ id, tz }: { id: string; tz?: string }) {
  const q = useQuery({ queryKey: ["procedure", id, "versions"], queryFn: () => api<{ items: Version[] }>(`/procedures/${id}/versions`) });
  if (!q.data) return <ListSkeleton rows={3} />;
  return (
    <section className="card">
      <ul className="pl-versions">{q.data.items.map((v) => {
        const c = v.changes ?? {};
        const parts = ([["added", "Added"], ["edited", "Edited"], ["removed", "Removed"]] as const).filter(([k]) => (c[k]?.length ?? 0) > 0);
        return (
          <li key={v.id}>
            <div className="row wrap" style={{ gap: 8 }}><b>Version {v.number}</b>
              {v.published_at ? <span className="small muted" title={dateTime(v.published_at, tz)}>Published {timeAgo(v.published_at)}</span> : <Pill>Draft</Pill>}
              <span className="small faint">{v.field_count} fields · {v.work_order_count ?? 0} work order{v.work_order_count === 1 ? "" : "s"}</span></div>
            {v.number === 1 && v.published_at ? <div className="small muted">First version</div>
              : parts.length ? parts.map(([k, label]) => <div key={k} className={"small pl-chg " + k}><b>{label}:</b> {c[k]!.slice(0, 12).join(", ")}{c[k]!.length > 12 ? ` and ${c[k]!.length - 12} more` : ""}</div>)
                : v.published_at && <div className="small muted">Details only</div>}
          </li>);
      })}</ul>
    </section>);
}

function History({ id, from, to, tz }: { id: string; from: string; to: string; tz?: string }) {
  const qs = `${from ? `from=${encodeURIComponent(new Date(from).toISOString())}&` : ""}${to ? `to=${encodeURIComponent(new Date(to + "T23:59:59").toISOString())}` : ""}`;
  type H = { created: number; completed: number; recent: { id: string; number: number; title: string; status: keyof typeof STATUS_LABEL; completed_at: string | null; score: number | null }[] };
  const q = useQuery({ queryKey: ["procedure", id, "history", qs], queryFn: () => api<H>(`/procedures/${id}/history?${qs}`), placeholderData: (p) => p });
  if (!q.data) return <ListSkeleton rows={3} />;
  const h = q.data;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="pl-stats two">
        <div className="card tile"><div className="k">Created</div><div className="v">{h.created}</div><div className="small muted">Work orders with this procedure</div></div>
        <div className="card tile"><div className="k">Completed</div><div className="v">{h.completed}</div><div className="small muted">{from || to ? "In this date range" : "All time"}</div></div>
      </div>
      <section className="card">
        <div className="card-head"><h2>Recent work orders</h2></div>
        {h.recent.length === 0 ? <div className="card-body small muted">Not used on any work orders yet.</div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Work order</th><th>Status</th><th className="desktop-only">Completed</th><th>Score</th></tr></thead>
            <tbody>{h.recent.map((w) => <tr key={w.id}>
              <td><Link to={`/work-orders/${w.id}`}>#{w.number} {w.title}</Link></td><td><StatusPill status={w.status} /></td>
              <td className="small desktop-only">{w.completed_at ? dateTime(w.completed_at, tz) : "—"}</td><td className="tnum">{w.score === null ? "—" : `${Math.round(w.score)}%`}</td></tr>)}</tbody></table></div>)}
      </section>
    </div>);
}

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const opts = useProcOptions();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const make = useMutation({ mutationFn: (key: string) => api<ProcedureDetail>("/procedures", { method: "POST", body: { template: key } }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["procedures"] }); toast("Created a draft from the template"); onClose(); nav(`/procedures/${p.id}/edit`); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <Modal title="Start from a template" onClose={onClose} width={560}>
      <div className="pr-pick-list">{(opts.data?.templates ?? []).map((t) => (
        <button key={t.key} type="button" className="pr-pick" disabled={make.isPending} onClick={() => make.mutate(t.key)}>
          <LayoutTemplate size={18} className="faint" />
          <span className="grow" style={{ minWidth: 0 }}><b>{t.name}</b><span className="small muted" style={{ display: "block" }}>{t.description}</span>
            <span className="small faint">{t.field_count} fields · {t.category}</span></span>
        </button>))}</div>
    </Modal>);
}

function ImportDialog({ onClose, onReady }: { onClose: () => void; onReady: (v: { name: string; schema: Schema }) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<{ name: string; schema: Schema } | null>(null);
  const send = async (f: File) => {
    setBusy(true); setErr(""); setRes(null);
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await fetch("/api/v1/procedures/import", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": getCsrf(), Accept: "application/json" } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || "That file couldn't be imported.");
      setRes(data);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const all = res ? walk(res.schema.items, true) : [];
  return (
    <Modal title="Import a procedure" onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!res || !res.name.trim()} onClick={() => res && onReady(res)}>Review in the builder</Button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}><b>CSV:</b> one row per field with the columns <span className="mono">type, label, options, required, description</span>.
          Separate options with <span className="mono">|</span>; a row with type <span className="mono">section</span> starts a section.<br />
          <b>PDF:</b> numbered or bulleted lines become inspection checks or checkboxes, and headings become headings. Review everything before publishing.</p>
        <input ref={ref} type="file" accept=".csv,.txt,.pdf,text/csv,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void send(f); }} />
        <DropZone multiple={false} accept=".csv,.txt,.pdf,text/csv,application/pdf" disabled={busy} label="Drop the file to read it" onFiles={(fs) => void send(fs[0])}>
          <div className="dropzone small"><FileUp size={18} className="faint" /><span>Drag a CSV or PDF here, or <button type="button" className="linkbtn" onClick={() => ref.current?.click()} disabled={busy}>{busy ? "reading…" : "choose a file"}</button></span></div></DropZone>
        {err && <div className="banner warning small">{err}</div>}
        {res && <>
          <Field label="Name">{(id) => <Input id={id} value={res.name} maxLength={255} onChange={(e) => setRes({ ...res, name: e.target.value })} />}</Field>
          <div className="small muted">Found {fieldsOf(res.schema).length} fields{all.some((i) => i.type === "section") ? ` in ${all.filter((i) => i.type === "section").length} sections` : ""}:</div>
          <ul className="pl-import-list small">{all.slice(0, 40).map((i) => <li key={i.id} className={i.type}>{i.label}<span className="faint"> · {i.type.replace(/_/g, " ")}</span></li>)}
            {all.length > 40 && <li className="faint">and {all.length - 40} more</li>}</ul>
        </>}
      </div>
    </Modal>);
}
