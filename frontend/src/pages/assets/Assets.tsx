// Assets: tree (list + detail, MaintainX layout) or table, with filters, bulk actions, labels and CSV export.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, ChevronDown, ChevronRight, Download, FileSpreadsheet, ListFilter, ListTree, MoreHorizontal, Plus, Printer, Search, Settings2, Table2, Trash2, X } from "lucide-react";
import { api, ApiError, type ExportItem } from "../../lib/api";
import { useAssetOptions, type Asset, type Paged } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { shortDate } from "../../lib/wo";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { AssetForm } from "./AssetForm";
import { ASSET_TABS, AssetDetailView, StatusModal, type AssetTab } from "./AssetDetail";
import { AssetStatusPill } from "./shared";

type View = "tree" | "table";
type Filters = { q: string; status: string; criticality: string; location_id: string; type_id: string; warranty: string; label: string };
const EMPTY: Filters = { q: "", status: "", criticality: "", location_id: "", type_id: "", warranty: "", label: "" };

function load<T>(k: string, d: T): T { try { const v = sessionStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } }
function keep(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export function filterQuery(f: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (!v) continue;
    if (k === "warranty" && v === "expiring") out.warranty_expiring_days = "60";
    else out[k] = v;
  }
  return out;
}
const qsOf = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

export function AssetsPage() {
  const { id, tab } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const { toast } = useToast();
  const [view, setView] = useState<View>(() => (id ? "tree" : load<View>("assets.view", "tree")));
  // Links like /assets?status=offline (from Overview) set the filters; otherwise the last filters are kept.
  const [filters, setFilters] = useState<Filters>(() => {
    const keys = Object.keys(EMPTY) as (keyof Filters)[];
    if (!keys.some((k) => params.get(k)) && !params.get("warranty_expiring_days")) return load("assets.filters", EMPTY);
    const f = { ...EMPTY };
    for (const k of keys) f[k] = params.get(k) ?? "";
    if (params.get("warranty_expiring_days")) f.warranty = "expiring";
    return f;
  });
  useEffect(() => {
    const keys = [...Object.keys(EMPTY), "warranty_expiring_days"];
    if (keys.some((k) => params.has(k))) { const p = new URLSearchParams(params); keys.forEach((k) => p.delete(k)); setParams(p, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [labels, setLabels] = useState(false);
  useEffect(() => { keep("assets.view", view); }, [view]);
  useEffect(() => { keep("assets.filters", filters); }, [filters]);
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }, [params, setParams]);
  useEffect(() => { if (id && view === "table" && !params.get("open")) setView("tree"); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = useMemo(() => filterQuery(filters), [filters]);
  const filtered = Object.keys(query).length > 0;
  const exportCsv = useMutation({
    mutationFn: () => api<ExportItem>("/assets/export", { method: "POST", body: { query } }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const set = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const openId = params.get("open");
  const closeDrawer = useCallback(() => { const p = new URLSearchParams(params); p.delete("open"); p.delete("otab"); setParams(p); }, [params, setParams]);

  const header = (
    <div className={"wo-toolbar" + (view === "tree" ? " compact" : "")}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Assets</h1>
        <div className="row">
          <div className="seg views asset-views" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === "tree"} className={"seg-btn" + (view === "tree" ? " on" : "")} onClick={() => setView("tree")} title="Tree" aria-label="Tree"><ListTree size={15} /></button>
            <button type="button" role="tab" aria-selected={view === "table"} className={"seg-btn" + (view === "table" ? " on" : "")} onClick={() => { setView("table"); if (id) nav("/assets"); }} title="Table" aria-label="Table"><Table2 size={15} /></button>
          </div>
          <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={250}>
            {(close) => <>
              {can("exports.use") && <button className="menu-item" onClick={() => { close(); exportCsv.mutate(); }}><Download size={15} />Export to CSV{filtered ? " (filtered)" : ""}</button>}
              {can("exports.use") && <Link className="menu-item" to="/downloads" onClick={close}><FileSpreadsheet size={15} />Download Center</Link>}
              <button className="menu-item" onClick={() => { close(); setLabels(true); }}><Printer size={15} />Print QR labels{filtered ? " (filtered)" : " (all)"}</button>
              <Link className="menu-item" to="/settings/assets" onClick={close}><Settings2 size={15} />Asset settings</Link>
              {can("assets.packages") && <Link className="menu-item" to="/asset-hub" onClick={close}><Boxes size={15} />Asset Hub</Link>}
            </>}
          </Dropdown>
          {can("assets.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New Asset"><Plus size={16} /><span className={view === "tree" ? "" : "desktop-only"}>{view === "tree" ? "New" : "New Asset"}</span></Button>}
        </div>
      </div>
      <AssetFilterBar f={filters} set={set} clear={() => setFilters({ ...EMPTY, q: filters.q })} />
    </div>
  );

  return (
    <div className="wo-page">
      {view === "tree" ? (
        <div className={"split wo-split" + (id ? " has-detail" : "")}>
          <div className="split-list">
            <div className="list-tools wo-list-tools">{header}</div>
            <div className="list" role="tree" aria-label="Assets">{filtered ? <FlatList query={query} activeId={id} /> : <Tree activeId={id} />}</div>
          </div>
          <div className="split-detail">
            {id ? <AssetDetailView key={id} id={id} tab={(ASSET_TABS.some(([k]) => k === tab) ? tab : "details") as AssetTab}
              onTab={(t) => nav(t === "details" ? `/assets/${id}` : `/assets/${id}/${t}`, { replace: true })} />
              : <EmptyState icon={<Boxes size={28} />} title="Select an asset">Pick one from the list to see its details, work orders, downtime and photos.
                {can("assets.manage") && <><br /><span className="small faint">Drag an asset onto another to make it a sub-asset.</span></>}</EmptyState>}
          </div>
        </div>
      ) : (
        <div className="wo-scroll">{header}<AssetTable query={query} onOpen={(aid) => { const p = new URLSearchParams(params); p.set("open", aid); setParams(p); }} /></div>
      )}
      {openId && view === "table" && <DrawerDetail id={openId} onClose={closeDrawer} />}
      {creating && <AssetForm onClose={() => setCreating(false)} onSaved={(a) => { setCreating(false); if (view === "tree") nav(`/assets/${a.id}`); }} />}
      {labels && <LabelDialog entityType="asset" query={query} onClose={() => setLabels(false)} />}
    </div>
  );
}

function DrawerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [tab, setTab] = useState<AssetTab>("details");
  return (
    <div className="drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" style={{ width: "min(820px, 100%)" }} role="dialog" aria-label="Asset">
        <div className="drawer-head"><Link to={`/assets/${id}`} className="small">Open full page</Link><Button variant="ghost" icon aria-label="Close" onClick={onClose}><X size={18} /></Button></div>
        <div className="drawer-body"><AssetDetailView id={id} tab={tab} onTab={setTab} /></div>
      </aside>
    </div>
  );
}

function AssetFilterBar({ f, set, clear }: { f: Filters; set: (p: Partial<Filters>) => void; clear: () => void }) {
  const opts = useAssetOptions();
  const active = [f.status, f.criticality, f.location_id, f.type_id, f.warranty, f.label].filter(Boolean).length;
  const [open, setOpen] = useState(false); // phone: filters fold away behind a Filter button (MP-126)
  return (
    <div className={"stack asset-filterbar" + (open ? " open" : "")} style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <div className="search-in grow"><Search size={15} className="faint" />
          <Input placeholder="Search name, serial, model or barcode" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search assets" /></div>
        <Button icon className={"mobile-only wo-phone-btn" + (open || active ? " on" : "")} aria-expanded={open} aria-label={active ? `Filter (${active} on)` : "Filter"}
          onClick={() => setOpen((o) => !o)}><ListFilter size={20} />{active > 0 && <span className="wo-phone-count">{active}</span>}</Button>
      </div>
      <div className="asset-filters">
        <Select aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any status</option>
          {(opts.data?.statuses ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
        <Select aria-label="Criticality" value={f.criticality} onChange={(e) => set({ criticality: e.target.value })}><option value="">Any criticality</option>
          {(opts.data?.criticality ?? []).filter((c) => c.id).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}<option value="none">None set</option></Select>
        <Select aria-label="Asset type" value={f.type_id} onChange={(e) => set({ type_id: e.target.value })}><option value="">Any type</option>
          {(opts.data?.types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select aria-label="Warranty" value={f.warranty} onChange={(e) => set({ warranty: e.target.value })}><option value="">Any warranty</option>
          <option value="active">Under warranty</option><option value="expiring">Ends within 60 days</option><option value="expired">Warranty ended</option></Select>
        <div className="asset-filter-loc"><LocationPicker value={f.location_id || null} onChange={(v) => set({ location_id: v ?? "" })} placeholder="Any location" /></div>
        <label className="check small"><input type="checkbox" checked={f.label === "none"} onChange={(e) => set({ label: e.target.checked ? "none" : "" })} /><span>Without a label</span></label>
        {active > 0 && <button type="button" className="linkbtn small" onClick={clear}>Clear filters</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tree
function useReparent() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, parent }: { id: string; parent: string | null; name: string }) => api(`/assets/${id}`, { method: "PATCH", body: { parent_id: parent } }),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["asset-tree"] }); qc.invalidateQueries({ queryKey: ["asset"] }); qc.invalidateQueries({ queryKey: ["assets"] });
      toast(v.parent ? `Moved ${v.name}` : `${v.name} is now a top-level asset`); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
}

function Tree({ activeId }: { activeId?: string }) {
  const roots = useQuery({ queryKey: ["asset-tree", "root"], queryFn: () => api<Paged<Asset>>("/assets?parent_id=root&per_page=500&sort=name") });
  const reparent = useReparent();
  const { can } = useSession();
  const [over, setOver] = useState(false);
  if (roots.isLoading) return <ListSkeleton />;
  const items = roots.data?.items ?? [];
  if (!items.length) return <EmptyState icon={<Boxes size={26} />} title="No assets yet">{can("assets.manage") ? "Add your equipment, machines and buildings systems. Press New to start." : "Assets your team adds show here."}</EmptyState>;
  return (
    <>
      {items.map((a) => <TreeNode key={a.id} a={a} depth={0} activeId={activeId} onDrop={(src, name) => reparent.mutate({ id: src, parent: a.id, name })} />)}
      {can("assets.manage") && <div className={"tree-drop-root small" + (over ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const src = e.dataTransfer.getData("text/mpro-asset"); const name = e.dataTransfer.getData("text/mpro-asset-name");
          if (src) reparent.mutate({ id: src, parent: null, name }); }}>Drop here to make an asset top level</div>}
    </>
  );
}

function TreeNode({ a, depth, activeId, onDrop }: { a: Asset; depth: number; activeId?: string; onDrop: (src: string, name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const { can } = useSession();
  const reparent = useReparent();
  const kids = useQuery({ queryKey: ["asset-tree", a.id], queryFn: () => api<Paged<Asset>>(`/assets?parent_id=${a.id}&per_page=500&sort=name`), enabled: open && a.child_count > 0 });
  const dnd = can("assets.manage");
  return (
    <div role="treeitem" aria-expanded={a.child_count ? open : undefined} aria-selected={a.id === activeId}>
      <div className={"tree-row" + (a.id === activeId ? " active" : "") + (over ? " drop-over" : "")} style={{ paddingLeft: 8 + depth * 18 }}
        draggable={dnd} onDragStart={(e) => { e.dataTransfer.setData("text/mpro-asset", a.id); e.dataTransfer.setData("text/mpro-asset-name", a.name); e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => { if (dnd && e.dataTransfer.types.includes("text/mpro-asset")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const src = e.dataTransfer.getData("text/mpro-asset"); if (src && src !== a.id) onDrop(src, e.dataTransfer.getData("text/mpro-asset-name")); }}>
        {a.child_count > 0 ? <button type="button" className="tree-tog" aria-label={open ? `Collapse ${a.name}` : `Expand ${a.name}`} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className="tree-tog" />}
        <AssetRowBody a={a} />
      </div>
      {open && (kids.isLoading ? <div style={{ paddingLeft: 30 + depth * 18 }}><ListSkeleton rows={1} /></div>
        : (kids.data?.items ?? []).map((c) => <TreeNode key={c.id} a={c} depth={depth + 1} activeId={activeId}
          onDrop={(src, name) => reparent.mutate({ id: src, parent: c.id, name })} />))}
    </div>
  );
}

function AssetRowBody({ a, showPath }: { a: Asset; showPath?: boolean }) {
  return (
    <Link to={`/assets/${a.id}`} className="tree-link">
      {a.thumb_url ? <img className="asset-thumb" src={a.thumb_url} alt="" loading="lazy" /> : <span className="asset-thumb ph" aria-hidden="true"><Boxes size={15} /></span>}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="t row" style={{ gap: 6 }}><span className={"astat-dot " + a.status} aria-label={a.status_label} />{a.name}</span>
        <span className="s">{[showPath && a.path.length ? a.path.map((p) => p.name).join(" › ") : "", a.location?.name, a.child_count ? `${a.child_count} sub-asset${a.child_count === 1 ? "" : "s"}` : ""]
          .filter(Boolean).join(" · ") || " "}</span>
      </span>
      {a.open_work_orders > 0 && <span className="wo-count" title={`${a.open_work_orders} open work orders`}>{a.open_work_orders}</span>}
    </Link>
  );
}

function FlatList({ query, activeId }: { query: Record<string, string>; activeId?: string }) {
  const q = useQuery({ queryKey: ["assets", "flat", query], queryFn: () => api<Paged<Asset>>(`/assets?per_page=200&sort=name&${qsOf(query)}`), placeholderData: (p) => p });
  if (q.isLoading) return <ListSkeleton />;
  const items = q.data?.items ?? [];
  return (
    <>
      <div className="small muted" style={{ padding: "6px 16px" }}>{q.data?.total ?? 0} matching asset{q.data?.total === 1 ? "" : "s"}</div>
      {items.length === 0 ? <EmptyState title="No assets match">Try clearing filters.</EmptyState>
        : items.map((a) => <div key={a.id} className={"tree-row" + (a.id === activeId ? " active" : "")} style={{ paddingLeft: 12 }}><AssetRowBody a={a} showPath /></div>)}
    </>
  );
}

// ---------------------------------------------------------------- table
type Col = { id: string; label: string; sort?: string; cell: (a: Asset) => React.ReactNode };
const COLS: Col[] = [
  { id: "name", label: "Name", sort: "name", cell: (a) => <span className="row" style={{ gap: 8 }}>{a.thumb_url ? <img className="asset-thumb sm" src={a.thumb_url} alt="" loading="lazy" /> : null}
    <span><span className="t">{a.name}</span>{a.path.length > 0 && <span className="small faint" style={{ display: "block" }}>{a.path.map((p) => p.name).join(" › ")}</span>}</span></span> },
  { id: "status", label: "Status", sort: "status", cell: (a) => <AssetStatusPill status={a.status} reason={a.status_reason} /> },
  { id: "location", label: "Location", cell: (a) => a.location?.name ?? <span className="faint">—</span> },
  { id: "criticality", label: "Criticality", sort: "criticality", cell: (a) => a.criticality_label || <span className="faint">—</span> },
  { id: "types", label: "Types", cell: (a) => a.types.length ? <span className="row wrap" style={{ gap: 4 }}>{a.types.map((t) => <span key={t.id} className="chip"><span className="sw lg" style={{ background: t.color }} />{t.name}</span>)}</span> : <span className="faint">—</span> },
  { id: "manufacturer", label: "Manufacturer / model", sort: "manufacturer", cell: (a) => [a.manufacturer, a.model].filter(Boolean).join(" ") || <span className="faint">—</span> },
  { id: "serial", label: "Serial", cell: (a) => a.serial_number ? <span className="mono">{a.serial_number}</span> : <span className="faint">—</span> },
  { id: "warranty", label: "Warranty end", sort: "warranty_end", cell: (a) => a.warranty_end ? <span className={a.warranty_active ? "" : "faint"}>{shortDate(a.warranty_end)}</span> : <span className="faint">—</span> },
  { id: "open", label: "Open WOs", cell: (a) => a.open_work_orders || <span className="faint">0</span> },
  { id: "updated", label: "Updated", sort: "updated_at", cell: (a) => <span className="small">{timeAgo(a.updated_at)}</span> },
];

function AssetTable({ query, onOpen }: { query: Record<string, string>; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState(() => load("assets.table.sort", "name"));
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const { can } = useSession();
  useEffect(() => { keep("assets.table.sort", sort); }, [sort]);
  useEffect(() => { setPage(1); setSel([]); }, [query, sort, showDeleted]);
  const qs = `sort=${sort}&per_page=50&page=${page}${showDeleted ? "&include_deleted=1" : ""}&${qsOf(query)}`;
  const data = useQuery({ queryKey: ["assets", "table", qs], queryFn: () => api<Paged<Asset>>(`/assets?${qs}`), placeholderData: (p) => p });
  const items = data.data?.items ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const toggle = (c: Col) => { if (c.sort) setSort(sort === c.sort ? `-${c.sort}` : c.sort); };
  return (
    <div className="wo-table card">
      <div className="card-head wrap"><span className="small muted">{total} asset{total === 1 ? "" : "s"}</span>
        {can("assets.delete") && <label className="check small"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /><span>Show deleted</span></label>}</div>
      <div className="table-wrap">
        <table className="table asset-table">
          <thead><tr>
            <th style={{ width: 36 }}><Checkbox checked={items.length > 0 && sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
              onChange={(c) => setSel(c ? items.map((a) => a.id) : [])} label={<span className="sr-only">Select all</span>} /></th>
            {COLS.map((c) => <th key={c.id} aria-sort={c.sort && sort.replace("-", "") === c.sort ? (sort.startsWith("-") ? "descending" : "ascending") : undefined}>
              <button type="button" className="th-btn" disabled={!c.sort} onClick={() => toggle(c)}>{c.label}
                {c.sort && sort.replace("-", "") === c.sort && (sort.startsWith("-") ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button></th>)}
          </tr></thead>
          <tbody>
            {data.isLoading && <tr><td colSpan={COLS.length + 1}><ListSkeleton rows={4} /></td></tr>}
            {!data.isLoading && items.length === 0 && <tr><td colSpan={COLS.length + 1}><EmptyState title="No assets match">Try clearing filters.</EmptyState></td></tr>}
            {items.map((a) => (
              <tr key={a.id} className={"clickable" + (a.deleted ? " deleted" : "")} onClick={() => onOpen(a.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(a.id); }}>
                <td onClick={(e) => e.stopPropagation()}><Checkbox checked={sel.includes(a.id)} onChange={(c) => setSel((s) => (c ? [...s, a.id] : s.filter((x) => x !== a.id)))}
                  label={<span className="sr-only">Select {a.name}</span>} /></td>
                {COLS.map((c) => <td key={c.id}>{c.cell(a)}</td>)}
              </tr>))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <div className="card-head" style={{ borderTop: "1px solid var(--c-border-soft)", borderBottom: 0 }}>
        <span className="small muted">Page {page} of {pages}</span>
        <div className="row"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div></div>}
      {sel.length > 0 && <AssetBulkBar ids={sel} items={items} onDone={() => setSel([])} />}
    </div>
  );
}

function AssetBulkBar({ ids, items, onDone }: { ids: string[]; items: Asset[]; onDone: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<"edit" | "status" | "labels" | "delete" | null>(null);
  const chosen = items.filter((a) => ids.includes(a.id));
  const refresh = () => { qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["asset-tree"] }); qc.invalidateQueries({ queryKey: ["asset"] }); };
  const del = useMutation({
    mutationFn: () => api<{ done: string[]; failed: { name: string; message: string }[] }>("/assets/bulk", { method: "POST", body: { ids, action: "delete" } }),
    onSuccess: (r) => { refresh(); setMode(null); onDone(); toast(r.failed.length ? `Deleted ${r.done.length}. ${r.failed[0].name}: ${r.failed[0].message}` : `Deleted ${r.done.length} asset${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" }); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
      <b className="small">{ids.length} selected</b><span className="grow" />
      {can("assets.manage") && <Button size="sm" onClick={() => setMode("edit")}>Edit</Button>}
      {can("assets.status") && <Button size="sm" onClick={() => setMode("status")}>Change status</Button>}
      <Button size="sm" onClick={() => setMode("labels")}><Printer size={14} />Print labels</Button>
      {can("assets.delete") && <Button size="sm" variant="danger" onClick={() => setMode("delete")}><Trash2 size={14} />Delete</Button>}
      <Button size="sm" variant="ghost" onClick={onDone}>Clear</Button>
      {mode === "edit" && <BulkEdit ids={ids} onClose={() => setMode(null)} onDone={() => { refresh(); setMode(null); onDone(); }} />}
      {mode === "status" && <StatusModal assets={chosen} onClose={() => setMode(null)} onDone={() => { refresh(); setMode(null); onDone(); }} />}
      {mode === "labels" && <LabelDialog entityType="asset" ids={ids} onClose={() => { setMode(null); refresh(); }} />}
      {mode === "delete" && <Modal title={`Delete ${ids.length} asset${ids.length === 1 ? "" : "s"}?`} onClose={() => setMode(null)}
        footer={<><Button onClick={() => setMode(null)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>Assets with sub-assets are skipped. Deleted assets can be restored by an administrator.</p></Modal>}
    </div>
  );
}

function BulkEdit({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const opts = useAssetOptions();
  const { toast } = useToast();
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [location, setLocation] = useState<string | null>(null);
  const [parent, setParent] = useState<string[]>([]);
  const [crit, setCrit] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const patch = () => {
    const p: Record<string, unknown> = {};
    if (on.location) p.location_id = location;
    if (on.parent) p.parent_id = parent[0] ?? null;
    if (on.criticality) p.criticality = crit;
    if (on.types) p.types = types;
    return p;
  };
  const m = useMutation({
    mutationFn: () => api<{ done: string[]; failed: { name: string; message: string }[] }>("/assets/bulk", { method: "POST", body: { ids, action: "edit", patch: patch() } }),
    onSuccess: (r) => { toast(r.failed.length ? `Updated ${r.done.length}. ${r.failed[0].name}: ${r.failed[0].message}` : `Updated ${r.done.length} asset${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" }); onDone(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const row = (k: string, label: string, control: React.ReactNode) => (
    <div className="bulk-edit-row"><Checkbox checked={!!on[k]} onChange={(c) => setOn((o) => ({ ...o, [k]: c }))} label={label} />{on[k] && <div className="grow">{control}</div>}</div>);
  return (
    <Modal title={`Edit ${ids.length} asset${ids.length === 1 ? "" : "s"}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!Object.values(on).some(Boolean) || m.isPending} onClick={() => m.mutate()}>Apply</Button></>}>
      <p className="small muted">Tick what to change. Everything else stays as it is.</p>
      {row("location", "Location", <LocationPicker value={location} onChange={setLocation} placeholder="No location" />)}
      {row("parent", "Parent asset", <AssetPicker value={parent} onChange={setParent} exclude={ids} placeholder="None (top level)" />)}
      {row("criticality", "Criticality", <Select aria-label="Criticality" value={crit} onChange={(e) => setCrit(e.target.value)}>{(opts.data?.criticality ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>)}
      {row("types", "Asset types", <MultiPicker label="Asset types" placeholder="No types" value={types} onChange={setTypes}
        options={(opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: <span className="sw lg" style={{ background: t.color }} /> }))} />)}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
