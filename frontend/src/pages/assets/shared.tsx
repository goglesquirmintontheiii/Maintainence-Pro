// Pieces shared by the Assets, Locations and asset settings screens (0.3.0).
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Download, ImagePlus, Users, X } from "lucide-react";
import { api, ApiError, upload, type AssetStatus, type FileItem } from "../../lib/api";
import { ASSET_STATUS_LABEL, type HistoryItem } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton, Pill } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { FileViewer, type ViewerFile } from "../../components/FileViewer";
import { DropZone } from "../../components/DropZone";
import "../../styles/assets.css";

export function AssetStatusPill({ status, reason }: { status: AssetStatus; reason?: string }) {
  return <span className={"pill " + status} title={reason || undefined}><span className="dot" />{ASSET_STATUS_LABEL[status]}{reason ? <span className="sub">· {reason}</span> : null}</span>;
}

export function Crumbs({ path, base, baseLabel }: { path: { id: string; name: string }[]; base: string; baseLabel: string }) {
  return (
    <nav className="crumbs small" aria-label="Breadcrumbs">
      <Link to={base}>{baseLabel}</Link>
      {path.map((p) => <span key={p.id} className="row" style={{ gap: 4 }}><ChevronRight size={12} className="faint" /><Link to={`${base}/${p.id}`}>{p.name}</Link></span>)}
    </nav>
  );
}

export function useTeams() {
  const { can } = useSession();
  return useQuery({ queryKey: ["teams-lite"], queryFn: () => api<{ items: { id: string; name: string; color: string }[] }>("/teams"), staleTime: 60_000,
    enabled: can("teams.view") });
}

export function TeamsPicker({ value, onChange, id, disabled }: { value: string[]; onChange: (v: string[]) => void; id?: string; disabled?: boolean }) {
  const teams = useTeams();
  const opts = useMemo(() => (teams.data?.items ?? []).map((t) => ({ key: t.id, label: t.name,
    icon: <span className="team-ic" style={{ background: t.color }}><Users size={12} /></span> })), [teams.data]);
  return <MultiPicker id={id} label="Teams in charge" placeholder="Add teams" options={opts} value={value} onChange={onChange} disabled={disabled}
    searchPlaceholder="Search teams"
    renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />;
}

export function TeamChips({ teams }: { teams: { id: string; name: string; color: string }[] }) {
  if (!teams.length) return <span className="faint">None</span>;
  return <span className="row wrap" style={{ gap: 4 }}>{teams.map((t) => <span key={t.id} className="chip"><span className="team-ic" style={{ background: t.color }}><Users size={11} /></span>{t.name}</span>)}</span>;
}

/** A section that opens and closes (used for Lifecycle, Warranty and Financials in forms). */
export function Collapsible({ title, children, defaultOpen = false, hint }: { title: string; children: ReactNode; defaultOpen?: boolean; hint?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={"collapsible" + (open ? " open" : "")}>
      <button type="button" className="collapsible-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="grow">{title}</span>{hint && <span className="small faint">{hint}</span>}
      </button>
      {open && <div className="collapsible-body form-grid">{children}</div>}
    </section>
  );
}

export const centsToInput = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));
export const inputToCents = (v: string): number | null => {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return v.trim() === "" || Number.isNaN(n) ? null : Math.round(n * 100);
};

export function fmtSeconds(s: number): string {
  if (s <= 0) return "0 min";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d} d`, h && `${h} h`, !d && m && `${m} min`].filter(Boolean).join(" ") || "under a minute";
}

/** Photos picked in a create form: uploaded right away, sent as file_ids on save. */
export function PhotoPicker({ files, setFiles, label = "Add photos or files" }: { files: FileItem[]; setFiles: (f: FileItem[]) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const { toast } = useToast();
  const pick = async (list: FileList | File[] | null) => {
    if (!list) return;
    const out = [...files];
    for (const f of Array.from(list)) {
      setBusy((n) => n + 1);
      try { out.push(await upload(f)); } catch (e) { toast((e as ApiError).message, { kind: "error" }); } finally { setBusy((n) => n - 1); }
    }
    setFiles(out);
  };
  return (
    <DropZone className="full" accept="image/*,application/pdf" onFiles={(fs) => void pick(fs)}>
      <input ref={input} type="file" multiple hidden accept="image/*,application/pdf" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
      <button type="button" className="dropzone small" onClick={() => input.current?.click()}><ImagePlus size={16} />{busy ? "Uploading…" : label}</button>
      {files.length > 0 && <div className="thumbs sm">{files.map((f) => (
        <figure key={f.id} className="thumb">{f.is_image ? <img src={f.thumb_url ?? f.url} alt={f.name} /> : <span className="small" style={{ padding: 6 }}>{f.name}</span>}
          <button type="button" className="thumb-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}><X size={12} /></button></figure>))}</div>}
    </DropZone>
  );
}

// Query keys of lists that show a record's picture, refreshed when its files change.
const LIST_KEYS: Record<string, string[]> = {
  asset: ["assets", "asset-tree", "asset-pick"],
  location: ["locations", "location-tree", "location-pick"],
  part: ["parts"],
  vendor: ["vendors"],
  customer: ["customers"],
};

/** Files attached to a saved record, with add and remove. */
export function FilesSection({ files, entityType, entityId, editable, queryKey, role = "photo" }: {
  files: FileItem[]; entityType: string; entityId: string; editable: boolean; queryKey: unknown[]; role?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [view, setView] = useState<FileItem | null>(null);
  const [busy, setBusy] = useState(false);
  // A new or removed picture changes the record's thumbnail in lists and trees too, not just its own page (MP-121)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey });
    for (const k of LIST_KEYS[entityType] ?? []) void qc.invalidateQueries({ queryKey: [k] });
  };
  const add = async (list: FileList | File[] | null) => {
    if (!list) return;
    setBusy(true);
    try { for (const f of Array.from(list)) await upload(f, { entity_type: entityType, entity_id: entityId, role: f.type.startsWith("image/") ? role : "file" }); }
    catch (e) { toast((e as ApiError).message, { kind: "error" }); }
    finally { setBusy(false); refresh(); }
  };
  const remove = async (f: FileItem) => {
    try { await api(`/files/links/${f.link_id}`, { method: "DELETE" }); refresh(); toast("Removed"); }
    catch (e) { toast((e as ApiError).message, { kind: "error" }); }
  };
  const imgs = files.filter((f) => f.is_image), docs = files.filter((f) => !f.is_image);
  return (
    <DropZone onFiles={(fs) => void add(fs)} disabled={!editable} className="card">
    <section className="card-pad stack">
      <div className="row" style={{ justifyContent: "space-between" }}><h3 className="sec-h" style={{ margin: 0 }}>Photos and files</h3>
        {editable && <><input ref={input} type="file" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy}><ImagePlus size={14} />{busy ? "Uploading…" : "Add"}</Button></>}</div>
      {files.length === 0 && <span className="small faint">No photos or files yet. Add photos, manuals or drawings.</span>}
      {imgs.length > 0 && <div className="thumbs">{imgs.map((f) => (
        <figure key={f.id} className="thumb"><button type="button" onClick={() => setView(f)} aria-label={`Open ${f.name}`}><img src={f.thumb_url ?? f.url} alt={f.name} /></button>
          {f.role === "warranty" && <span className="cover-tag">Warranty</span>}
          {editable && f.link_id && <button type="button" className="thumb-x" aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}><X size={12} /></button>}</figure>))}</div>}
      {docs.length > 0 && <div className="files">{docs.map((f) => (
        <div key={f.id} className="file-row"><button type="button" className="linkbtn grow" style={{ textAlign: "left" }} onClick={() => setView(f)}>{f.name}</button>
          {f.role === "warranty" && <Pill tone="info">Warranty</Pill>}
          <a className="btn ghost sm icon" href={f.url + "?download=1"} aria-label={`Download ${f.name}`}><Download size={14} /></a>
          {editable && f.link_id && <Button size="sm" variant="ghost" icon aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}><X size={14} /></Button>}</div>))}</div>}
      {view && <Lightbox file={view} files={[...imgs, ...docs]} onClose={() => setView(null)} />}
    </section>
    </DropZone>
  );
}

/** One file, or a list with `index`, in the shared in-page viewer (MP-107). */
export function Lightbox({ file, files, onClose }: { file: ViewerFile; files?: ViewerFile[]; onClose: () => void }) {
  const list = files?.length ? files : [file];
  return <FileViewer files={list} index={Math.max(0, list.findIndex((f) => f.id === file.id))} onClose={onClose} />;
}

const FIELD_NAMES: Record<string, string> = { parent_id: "parent", location_id: "location", types: "types", custom: "custom fields" };
function short(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "object") return Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : "changed";
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

export function HistoryList({ path, tz }: { path: string; tz?: string }) {
  const q = useQuery({ queryKey: ["history", path], queryFn: () => api<{ items: HistoryItem[] }>(path) });
  if (!q.data) return <ListSkeleton rows={4} />;
  if (!q.data.items.length) return <EmptyState title="No history yet" />;
  return (
    <ol className="history card">
      {q.data.items.map((h) => (
        <li key={h.id} className="history-row">
          <span className="dot" aria-hidden="true" />
          <div className="grow"><div><b>{h.actor}</b> {h.summary.charAt(0).toLowerCase() + h.summary.slice(1)}</div>
            {Object.keys(h.changes).length > 0 && Object.keys(h.changes).length <= 4 && <div className="small faint">
              {Object.entries(h.changes).map(([k, [a, b]]) => <span key={k} style={{ marginRight: 10 }}>{(FIELD_NAMES[k] ?? k.replace(/_cents$/, "").replace(/_/g, " "))}: {short(a)} → {short(b)}</span>)}</div>}</div>
          <span className="small faint" style={{ whiteSpace: "nowrap" }}>{dateTime(h.at, tz)}</span>
        </li>))}
    </ol>
  );
}

/** Simple grouped bar chart (two series) drawn with SVG and design tokens. */
export function BarChart2({ data, aLabel, bLabel, labelFor }: { data: { k: string; a: number; b: number }[]; aLabel: string; bLabel: string; labelFor: (k: string) => string }) {
  const W = 640, H = 200, pad = 28, top = Math.max(2, ...data.flatMap((d) => [d.a, d.b])), max = top % 2 ? top + 1 : top;
  const slot = (W - pad) / Math.max(1, data.length), bw = Math.max(3, Math.min(14, slot / 3));
  const step = Math.ceil(data.length / 8);
  return (
    <figure className="chart" aria-label={`${aLabel} and ${bLabel} per week`}>
      <svg viewBox={`0 0 ${W} ${H + 22}`} role="img" preserveAspectRatio="none">
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={pad} x2={W} y1={H - f * (H - 10)} y2={H - f * (H - 10)} className="grid" />
          <text x={pad - 6} y={H - f * (H - 10) + 4} className="axis" textAnchor="end">{Math.round(max * f)}</text></g>)}
        {data.map((d, i) => {
          const x = pad + i * slot + slot / 2;
          const ha = (d.a / max) * (H - 10), hb = (d.b / max) * (H - 10);
          return <g key={d.k}>
            <rect x={x - bw - 1} y={H - ha} width={bw} height={ha} className="bar-a"><title>{`${labelFor(d.k)}: ${d.a} ${aLabel.toLowerCase()}`}</title></rect>
            <rect x={x + 1} y={H - hb} width={bw} height={hb} className="bar-b"><title>{`${labelFor(d.k)}: ${d.b} ${bLabel.toLowerCase()}`}</title></rect>
            {i % step === 0 && <text x={x} y={H + 16} className="axis" textAnchor="middle">{labelFor(d.k)}</text>}
          </g>;
        })}
      </svg>
      <figcaption className="row small muted" style={{ gap: 14 }}><span className="row" style={{ gap: 5 }}><i className="legend-sq a" />{aLabel}</span>
        <span className="row" style={{ gap: 5 }}><i className="legend-sq b" />{bLabel}</span></figcaption>
    </figure>
  );
}
