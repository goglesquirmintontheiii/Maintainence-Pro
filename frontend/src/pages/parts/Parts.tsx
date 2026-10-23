// Parts & Inventory (0.5.0, MP-039–041): list + detail (MaintainX layout) or table with per-location rows,
// filters, saved filter presets, exports, labels. /parts/cycle-counts and /parts/transactions are sub-pages.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bookmark, ClipboardCheck, Download, FileSpreadsheet, History, List, MoreHorizontal, Package, Plus, Printer, Search, Settings2, Table2, Trash2, X } from "lucide-react";
import { api, ApiError, type ExportItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { PartDetailView, PART_TABS, type PartTab } from "./PartDetail";
import { PartForm } from "./PartForm";
import { CycleCountsPage } from "./CycleCounts";
import { TransactionsPage } from "./Transactions";
import { qsOf, qty, usePartOptions, type PartList, type PartRow } from "./types";
import "./parts.css";

type View = "list" | "table";
type Filters = { q: string; stock: string; type_id: string; location_id: string; critical: string; non_stock: string };
const EMPTY: Filters = { q: "", stock: "", type_id: "", location_id: "", critical: "", non_stock: "" };
type Preset = { id: string; name: string; filters: Partial<Filters>; shared: boolean; pinned: boolean };

function load<T>(k: string, d: T): T { try { const v = sessionStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } }
function keep(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export function PartsPage() {
  const { id, tab } = useParams();
  if (id === "cycle-counts") return <CycleCountsPage runId={tab} />;
  if (id === "transactions") return <TransactionsPage />;
  return <PartsMain id={id} tab={tab} />;
}

function PartsMain({ id, tab }: { id?: string; tab?: string }) {
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const { toast } = useToast();
  const [view, setView] = useState<View>(() => (id ? "list" : load<View>("parts.view", "list")));
  const [filters, setFilters] = useState<Filters>(() => {
    const keys = Object.keys(EMPTY) as (keyof Filters)[];
    if (!keys.some((k) => params.get(k))) return load("parts.filters", EMPTY);
    const f = { ...EMPTY };
    for (const k of keys) f[k] = params.get(k) ?? "";
    return f;
  });
  useEffect(() => {
    const keys = Object.keys(EMPTY);
    if (keys.some((k) => params.has(k))) { const p = new URLSearchParams(params); keys.forEach((k) => p.delete(k)); setParams(p, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [labels, setLabels] = useState(false);
  useEffect(() => { keep("parts.view", view); }, [view]);
  useEffect(() => { keep("parts.filters", filters); }, [filters]);
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }, [params, setParams]);
  const query = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>, [filters]);
  const filtered = Object.keys(query).length > 0;
  const exportCsv = useMutation({
    mutationFn: (report: string) => api<ExportItem>("/parts/export", { method: "POST", body: { report, query: report === "transactions" ? {} : query } }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const set = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));

  const header = (
    <div className={"wo-toolbar" + (view === "list" ? " compact" : "")}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Parts</h1>
        <div className="row">
          <div className="seg views" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === "list"} className={"seg-btn" + (view === "list" ? " on" : "")} onClick={() => setView("list")} title="List" aria-label="List"><List size={15} /></button>
            <button type="button" role="tab" aria-selected={view === "table"} className={"seg-btn" + (view === "table" ? " on" : "")} onClick={() => { setView("table"); if (id) nav("/parts"); }} title="Table" aria-label="Table"><Table2 size={15} /></button>
          </div>
          <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={260}>
            {(close) => <>
              <Link className="menu-item" to="/parts/transactions" onClick={close}><History size={15} />Transactions log</Link>
              <Link className="menu-item" to="/parts/cycle-counts" onClick={close}><ClipboardCheck size={15} />Cycle counts</Link>
              {can("exports.use") && <>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => { close(); exportCsv.mutate("parts"); }}><Download size={15} />Export parts{filtered ? " (filtered)" : ""}</button>
                {can("costs.view") && <button className="menu-item" onClick={() => { close(); exportCsv.mutate("valuation"); }}><Download size={15} />Inventory valuation</button>}
                <button className="menu-item" onClick={() => { close(); exportCsv.mutate("slow_moving"); }}><Download size={15} />Slow-moving parts</button>
                <Link className="menu-item" to="/downloads" onClick={close}><FileSpreadsheet size={15} />Download Center</Link>
              </>}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { close(); setLabels(true); }}><Printer size={15} />Print QR labels{filtered ? " (filtered)" : ""}</button>
              <Link className="menu-item" to="/settings/parts" onClick={close}><Settings2 size={15} />Parts settings</Link>
            </>}
          </Dropdown>
          {can("parts.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New Part"><Plus size={16} /><span className={view === "list" ? "" : "desktop-only"}>{view === "list" ? "New" : "New Part"}</span></Button>}
        </div>
      </div>
      <FilterBar f={filters} set={set} replace={setFilters} clear={() => setFilters({ ...EMPTY, q: filters.q })} />
    </div>
  );

  return (
    <div className="wo-page">
      {view === "list" ? (
        <div className={"split wo-split" + (id ? " has-detail" : "")}>
          <div className="split-list">
            <div className="list-tools wo-list-tools">{header}</div>
            <div className="list" aria-label="Parts"><PartList query={query} activeId={id} /></div>
          </div>
          <div className="split-detail">
            {id ? <PartDetailView key={id} id={id} tab={(PART_TABS.some(([k]) => k === tab) ? tab : "details") as PartTab}
              onTab={(t) => nav(t === "details" ? `/parts/${id}` : `/parts/${id}/${t}`, { replace: true })} />
              : <EmptyState icon={<Package size={28} />} title="Select a part">Pick one from the list to see its stock, where it's kept and where it was used.</EmptyState>}
          </div>
        </div>
      ) : (
        <div className="wo-scroll">{header}<PartTable query={query} /></div>
      )}
      {creating && <PartForm onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); nav(`/parts/${p.id}`); }} />}
      {labels && <LabelDialog entityType="part" ids={undefined} query={query} onClose={() => setLabels(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- filters and presets (r226)
function FilterBar({ f, set, replace, clear }: { f: Filters; set: (p: Partial<Filters>) => void; replace: (f: Filters) => void; clear: () => void }) {
  const opts = usePartOptions();
  const active = [f.stock, f.type_id, f.location_id, f.critical, f.non_stock].filter(Boolean).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <div className="search-in grow"><Search size={15} className="faint" />
          <Input placeholder="Search name, part number, barcode or vendor" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search parts" /></div>
        <Presets f={f} apply={replace} />
      </div>
      <div className="asset-filters part-filters">
        <div className="seg part-stock-seg" role="radiogroup" aria-label="Stock">
          {[["", "All"], ["needs_restock", "Needs restock"], ["out_of_stock", "Out of stock"], ["in_stock", "In stock"]].map(([k, l]) =>
            <button key={k} type="button" role="radio" aria-checked={f.stock === k} className={"seg-btn" + (f.stock === k ? " on" : "")} onClick={() => set({ stock: k })}>{l}</button>)}
        </div>
        <Select aria-label="Part type" value={f.type_id} onChange={(e) => set({ type_id: e.target.value })}><option value="">Any type</option>
          {(opts.data?.types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <div className="asset-filter-loc"><LocationPicker value={f.location_id || null} onChange={(v) => set({ location_id: v ?? "" })} placeholder="Any location" /></div>
        <Select aria-label="Stocked" value={f.non_stock} onChange={(e) => set({ non_stock: e.target.value })}><option value="">Stock and non-stock</option>
          <option value="0">Stocked parts</option><option value="1">Non-stock parts</option></Select>
        <label className="check small"><input type="checkbox" checked={f.critical === "1"} onChange={(e) => set({ critical: e.target.checked ? "1" : "" })} /><span>Critical only</span></label>
        {active > 0 && <button type="button" className="linkbtn small" onClick={clear}>Clear filters</button>}
      </div>
    </div>
  );
}

function Presets({ f, apply }: { f: Filters; apply: (f: Filters) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const q = useQuery({ queryKey: ["part-presets"], queryFn: () => api<{ items: Preset[] }>("/parts/presets") });
  const [saving, setSaving] = useState(false);
  const del = useMutation({ mutationFn: (p: Preset) => api(`/parts/presets/${p.id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["part-presets"] }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const items = q.data?.items ?? [];
  return (
    <>
      <Dropdown trigger={(_, t) => <Button icon aria-label="Saved filters" title="Saved filters" onClick={t}><Bookmark size={16} /></Button>} width={260}>
        {(close) => <>
          {items.length === 0 && <div className="menu-item small faint" style={{ cursor: "default" }}>No saved filters yet</div>}
          {items.map((p) => <div key={p.id} className="row part-preset">
            <button className="menu-item grow" onClick={() => { close(); apply({ ...EMPTY, ...p.filters }); }}>{p.name}{p.shared && <span className="small faint"> · shared</span>}</button>
            {(!p.shared || can("parts.settings")) && <button type="button" className="chip-x" aria-label={`Delete ${p.name}`} onClick={() => del.mutate(p)}><Trash2 size={13} /></button>}
          </div>)}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { close(); setSaving(true); }}><Plus size={15} />Save current filters</button>
        </>}
      </Dropdown>
      {saving && <SavePreset f={f} onClose={() => setSaving(false)} />}
    </>
  );
}

function SavePreset({ f, onClose }: { f: Filters; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => api("/parts/presets", { method: "POST", body: { name, shared, filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["part-presets"] }); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title="Save filters" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Input aria-label="Name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Warehouse restock" />
      {can("parts.settings") && <Checkbox checked={shared} onChange={setShared} label="Share with everyone" />}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- list
export function StockBadge({ p }: { p: Pick<PartRow, "non_stock" | "needs_restock" | "negative" | "out_of_stock" | "available" | "on_hand" | "unit"> }) {
  if (p.non_stock) return <span className="part-stock ns">Non-stock</span>;
  const cls = p.negative ? "neg" : p.out_of_stock ? "out" : p.needs_restock ? "low" : "ok";
  return <span className={"part-stock " + cls} title={p.needs_restock ? "Needs restock" : undefined}>{qty(p.on_hand, p.unit)}</span>;
}

function PartRowBody({ p }: { p: PartRow }) {
  return (
    <Link to={`/parts/${p.id}`} className="tree-link">
      {p.thumb_url ? <img className="asset-thumb" src={p.thumb_url} alt="" loading="lazy" /> : <span className="asset-thumb ph" aria-hidden="true"><Package size={15} /></span>}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="t">{p.name}</span>
        <span className="s">{[p.part_number, p.types.map((t) => t.name).join(", "), p.needs_restock ? "Needs restock" : ""].filter(Boolean).join(" · ") || " "}</span>
      </span>
      <StockBadge p={p} />
    </Link>
  );
}

function PartList({ query, activeId }: { query: Record<string, string>; activeId?: string }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [query]);
  const q = useQuery({ queryKey: ["parts", "list", query, page], queryFn: () => api<PartList>(`/parts?per_page=100&page=${page}&sort=name&${qsOf(query)}`), placeholderData: (p) => p });
  const { can } = useSession();
  if (q.isLoading) return <ListSkeleton />;
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  if (!items.length) return Object.keys(query).length ? <EmptyState title="No parts match">Try clearing filters.</EmptyState>
    : <EmptyState icon={<Package size={26} />} title="No parts yet">{can("parts.manage") ? "Add the spare parts and supplies you keep. Press New to start." : "Parts your team adds show here."}</EmptyState>;
  return (
    <>
      <div className="small muted" style={{ padding: "6px 16px" }}>{total} part{total === 1 ? "" : "s"}</div>
      {items.map((p) => <div key={p.id} className={"tree-row" + (p.id === activeId ? " active" : "")} style={{ paddingLeft: 12 }}><PartRowBody p={p} /></div>)}
      {total > page * 100 && <div className="card-body"><Button size="sm" onClick={() => setPage(page + 1)}>Next page</Button></div>}
      {page > 1 && <div className="card-body" style={{ paddingTop: 0 }}><Button size="sm" variant="ghost" onClick={() => setPage(page - 1)}>Previous page</Button></div>}
    </>
  );
}

// ---------------------------------------------------------------- table (with "Show per location", r218)
const SORTS: Record<string, string> = { name: "name", part_number: "part_number", on_hand: "on_hand", unit_cost: "unit_cost", updated: "updated_at" };

function PartTable({ query }: { query: Record<string, string> }) {
  const [sort, setSort] = useState(() => load("parts.table.sort", "name"));
  const [page, setPage] = useState(1);
  const [perLoc, setPerLoc] = useState(() => load("parts.table.perloc", false));
  const [showDeleted, setShowDeleted] = useState(false);
  const { can } = useSession();
  const nav = useNavigate();
  useEffect(() => { keep("parts.table.sort", sort); keep("parts.table.perloc", perLoc); }, [sort, perLoc]);
  useEffect(() => { setPage(1); }, [query, sort, showDeleted]);
  const qs = `sort=${sort}&per_page=50&page=${page}${perLoc ? "&per_location=1" : ""}${showDeleted ? "&include_deleted=1" : ""}&${qsOf(query)}`;
  const data = useQuery({ queryKey: ["parts", "table", qs], queryFn: () => api<PartList>(`/parts?${qs}`), placeholderData: (p) => p });
  const items = data.data?.items ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const costs = can("costs.view");
  const th = (label: string, key?: string) => {
    const s = key ? SORTS[key] : undefined;
    return <th aria-sort={s && sort.replace("-", "") === s ? (sort.startsWith("-") ? "descending" : "ascending") : undefined}>
      <button type="button" className="th-btn" disabled={!s} onClick={() => s && setSort(sort === s ? `-${s}` : s)}>{label}
        {s && sort.replace("-", "") === s && (sort.startsWith("-") ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button></th>;
  };
  return (
    <div className="wo-table card">
      <div className="card-head wrap"><span className="small muted">{total} part{total === 1 ? "" : "s"}</span>
        <span className="row" style={{ gap: 12 }}>
          <label className="check small"><input type="checkbox" checked={perLoc} onChange={(e) => setPerLoc(e.target.checked)} /><span>Show per location</span></label>
          {can("parts.delete") && <label className="check small"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /><span>Show deleted</span></label>}
        </span></div>
      <div className="table-wrap">
        {perLoc ? (
          <table className="table part-table">
            <thead><tr><th>Part</th><th>Location</th><th>Area</th><th className="num">In stock</th><th className="num">Reserved</th><th className="num">Available</th><th className="num">Min</th><th className="num">Max</th></tr></thead>
            <tbody>
              {(data.data?.per_location ?? []).map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/parts/${r.part.id}`)}>
                  <td><span className="t">{r.part.name}</span>{r.part.part_number && <span className="small faint" style={{ display: "block" }}>{r.part.part_number}</span>}</td>
                  <td>{r.location?.name ?? <span className="faint">No location</span>}</td><td>{r.area || <span className="faint">—</span>}</td>
                  <td className={"num" + (r.negative ? " part-neg" : r.needs_restock ? " part-low" : "")}>{r.on_hand}</td><td className="num">{r.reserved}</td><td className="num">{r.available}</td>
                  <td className="num">{r.min_qty ?? "—"}</td><td className="num">{r.max_qty ?? "—"}</td>
                </tr>))}
              {!data.isLoading && !(data.data?.per_location ?? []).length && <tr><td colSpan={8}><EmptyState title="No stock rows">These parts aren't stocked at a location yet.</EmptyState></td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="table part-table">
            <thead><tr>{th("Name", "name")}{th("Part number", "part_number")}<th>Types</th>{th("In stock", "on_hand")}<th className="num">Available</th><th className="num">Min / Max</th>
              {costs && th("Unit cost", "unit_cost")}{th("Updated", "updated")}</tr></thead>
            <tbody>
              {data.isLoading && <tr><td colSpan={8}><ListSkeleton rows={4} /></td></tr>}
              {!data.isLoading && items.length === 0 && <tr><td colSpan={8}><EmptyState title="No parts match">Try clearing filters.</EmptyState></td></tr>}
              {items.map((p) => (
                <tr key={p.id} className={"clickable" + (p.deleted ? " deleted" : "")} onClick={() => nav(`/parts/${p.id}`)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") nav(`/parts/${p.id}`); }}>
                  <td><span className="row" style={{ gap: 8 }}>{p.thumb_url ? <img className="asset-thumb sm" src={p.thumb_url} alt="" loading="lazy" /> : null}<span className="t">{p.name}</span></span></td>
                  <td className="mono">{p.part_number || <span className="faint">—</span>}</td>
                  <td>{p.types.length ? <span className="row wrap" style={{ gap: 4 }}>{p.types.map((t) => <span key={t.id} className="chip"><span className="sw lg" style={{ background: t.color }} />{t.name}</span>)}</span> : <span className="faint">—</span>}</td>
                  <td><StockBadge p={p} /></td><td className="num">{p.non_stock ? "—" : p.available}</td>
                  <td className="num">{p.min_qty ?? "—"} / {p.max_qty ?? "—"}</td>
                  {costs && <td className="num">{p.unit_cost ?? "—"}</td>}
                  <td><span className="small">{timeAgo(p.updated_at)}</span></td>
                </tr>))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 && <div className="card-head" style={{ borderTop: "1px solid var(--c-border-soft)", borderBottom: 0 }}>
        <span className="small muted">Page {page} of {pages}</span>
        <div className="row"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div></div>}
    </div>
  );
}

export function CloseX({ onClick }: { onClick: () => void }) {
  return <Button variant="ghost" icon aria-label="Close" onClick={onClick}><X size={18} /></Button>;
}
