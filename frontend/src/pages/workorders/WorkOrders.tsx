// Work Orders: To Do (list + detail), Table, Calendar, Workload and Board views sharing one filter bar.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckSquare, ClipboardList, Columns3, Download, FileSpreadsheet, LayoutList, MessageSquare, MoreHorizontal, Plus, Search, Table2, Users } from "lucide-react";
import { api, ApiError, type ExportItem, type Filter, type SavedView, type WOList, type WorkOrder } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dueLabel, filtersParam, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { AvatarStack, Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { FilterBar } from "./FilterBar";
import { WorkOrderDetail } from "./Detail";
import { WorkOrderForm } from "./Form";
import { BoardView, CalendarView, TableView, WorkloadView } from "./Views";
import { BulkBar } from "./Bulk";

export type ViewKind = "todo" | "table" | "calendar" | "workload" | "board";
const VIEWS: { id: ViewKind; label: string; icon: typeof LayoutList }[] = [
  { id: "todo", label: "To Do", icon: LayoutList }, { id: "table", label: "Table", icon: Table2 }, { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "workload", label: "Workload", icon: Users }, { id: "board", label: "Board", icon: Columns3 },
];
const SCOPES = [["all", "All work orders"], ["assigned_me", "Assigned to me"], ["my_teams", "Assigned to my teams"], ["created_me", "Created by me"]] as const;
const SORTS = [["-priority", "Priority"], ["due_at", "Due date"], ["-created_at", "Newest"], ["created_at", "Oldest"], ["-updated_at", "Recently updated"], ["-number", "Number"]] as const;

function load<T>(k: string, d: T): T { try { const v = sessionStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } }
function keep(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export function WorkOrdersPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const opts = useWOOptions();
  const nav = useNavigate();
  // A direct link to one work order (/work-orders/:id) always opens it in the To Do split.
  const view = (params.get("view") as ViewKind) || (id ? "todo" : load<ViewKind>("wo.view", "todo"));
  const [filters, setFilters] = useState<Filter[]>(() => load("wo.filters", []));
  const [activeView, setActiveView] = useState<SavedView | null>(() => load("wo.savedview", null));
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [exporting, setExporting] = useState(false);
  useEffect(() => { keep("wo.filters", filters); }, [filters]);
  useEffect(() => { keep("wo.savedview", activeView); }, [activeView]);
  useEffect(() => { keep("wo.view", view); }, [view]);
  // ?new=1 opens the form; &asset= / &location= / &template= prefill it (links from asset, location and scan pages)
  const readPrefill = () => {
    const a = params.get("asset"), l = params.get("location"), t = params.get("template");
    return a || l || t ? { ...(a ? { asset_id: a } : {}), ...(l ? { location_id: l } : {}), ...(t ? { template_id: t } : {}) } : undefined;
  };
  const [prefill, setPrefill] = useState<{ asset_id?: string; location_id?: string; template_id?: string } | undefined>(readPrefill);
  useEffect(() => {
    if (params.get("new") === "1") {
      const p = readPrefill();
      if (p) setPrefill(p);
      setCreating(true); ["new", "asset", "location", "template"].forEach((k) => params.delete(k)); setParams(params, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay, .drawer-wrap")) return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && can("wo.create")) { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [can]);
  const setView = (v: ViewKind) => { const p = new URLSearchParams(params); p.set("view", v); setParams(p); if (id && v !== "todo") nav(`/work-orders?view=${v}&open=${id}`); };
  const openId = params.get("open");
  const closeDrawer = useCallback(() => { const p = new URLSearchParams(params); p.delete("open"); setParams(p); }, [params, setParams]);
  const openWO = (wid: string) => { const p = new URLSearchParams(params); p.set("open", wid); setParams(p); };
  const query = { filters, q };

  const compact = view === "todo";
  const viewSeg = (
    <div className="seg views" role="tablist" aria-label="View">{VIEWS.map((v) => { const Icon = v.icon; return (
      <button key={v.id} type="button" role="tab" aria-selected={view === v.id} aria-label={v.label} className={"seg-btn" + (view === v.id ? " on" : "")} onClick={() => setView(v.id)} title={v.label}>
        <Icon size={15} />{!compact && <span className="desktop-only">{v.label}</span>}</button>); })}</div>);
  const more = (
    <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={240}>
      {(close) => <>
        {can("exports.use") && <button className="menu-item" onClick={() => { close(); setExporting(true); }}><Download size={15} />Export…</button>}
        {can("exports.use") && <Link className="menu-item" to="/downloads" onClick={close}><FileSpreadsheet size={15} />Download Center</Link>}
        {can("wo.settings") && <Link className="menu-item" to="/settings/work-orders" onClick={close}><ClipboardList size={15} />Work order settings</Link>}
      </>}
    </Dropdown>);
  const newBtn = can("wo.create") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New Work Order"><Plus size={16} /><span className={compact ? "" : "desktop-only"}>{compact ? "New" : "New Work Order"}</span></Button>;
  const header = (
    <div className={"wo-toolbar" + (compact ? " compact" : "")}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Work Orders</h1>
        <div className="row">{viewSeg}{more}{newBtn}</div>
      </div>
      <div className="row wrap">
        <div className="search-in" style={{ minWidth: 220, flex: "0 1 300px" }}><Search size={15} className="faint" />
          <Input placeholder="Search title, description or #number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work orders" /></div>
        <FilterBar filters={filters} onChange={setFilters} options={opts.data} activeView={activeView} onViewChange={setActiveView} />
      </div>
    </div>
  );

  return (
    <div className="wo-page">
      {view === "todo" ? <ToDoView id={id} header={header} query={query} /> : (
        <div className="wo-scroll">
          {header}
          {view === "table" && <TableView query={query} onOpen={openWO} />}
          {view === "calendar" && <CalendarView query={query} onOpen={openWO} />}
          {view === "workload" && <WorkloadView query={query} onOpen={openWO} />}
          {view === "board" && <BoardView query={query} onOpen={openWO} />}
        </div>)}
      {openId && view !== "todo" && (
        <div className="drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDrawer(); }}>
          <aside className="drawer" style={{ width: "min(760px, 100%)" }} role="dialog" aria-label="Work order"><div className="drawer-body" style={{ padding: 0 }}>
            <WorkOrderDetail id={openId} inDrawer onClose={closeDrawer} /></div></aside>
        </div>)}
      {creating && <WorkOrderForm init={prefill} onClose={() => { setCreating(false); setPrefill(undefined); }} onSaved={view === "todo" ? undefined : (wo) => openWO(wo.id)} />}
      {exporting && <ExportDialog query={query} onClose={() => setExporting(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- To Do
export type ListQuery = { filters: Filter[]; q: string };

export function useWOList(qs: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["work-orders", qs],
    queryFn: ({ pageParam }) => api<WOList>(`/work-orders?${qs}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.per_page < last.total ? last.page + 1 : undefined),
    placeholderData: (p) => p, enabled,
  });
}

function ToDoView({ id, header, query }: { id?: string; header: React.ReactNode; query: ListQuery }) {
  const [tab, setTab] = useState<"todo" | "done">(() => load("wo.tab", "todo"));
  const [scope, setScope] = useState<string>(() => load("wo.scope", "all"));
  const [sort, setSort] = useState<string>(() => load("wo.sort", "-priority"));
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const { session } = useSession();
  const nav = useNavigate();
  useEffect(() => { keep("wo.tab", tab); keep("wo.scope", scope); keep("wo.sort", sort); }, [tab, scope, sort]);
  const qs = `tab=${tab}&scope=${scope}&sort=${tab === "done" && sort === "-priority" ? "-completed_at" : sort}&per_page=40&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}`;
  const list = useWOList(qs);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSel([]); }, [qs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay, .drawer-wrap")) return;
      if (e.key !== "j" && e.key !== "k") return;
      const i = items.findIndex((w) => w.id === id);
      const next = items[e.key === "j" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) { e.preventDefault(); nav(`/work-orders/${next.id}`); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, id, nav]);
  useEffect(() => { listRef.current?.querySelector(".list-row.active")?.scrollIntoView({ block: "nearest" }); }, [id]);
  return (
    <div className={"split wo-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools wo-list-tools">
          {header}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="tabs" role="tablist" style={{ border: 0 }}>
              <button type="button" role="tab" className="tab" aria-selected={tab === "todo"} onClick={() => setTab("todo")}>To Do</button>
              <button type="button" role="tab" className="tab" aria-selected={tab === "done"} onClick={() => setTab("done")}>Done</button>
            </div>
            <Button size="sm" variant={selecting ? "primary" : "ghost"} onClick={() => { setSelecting((s) => !s); setSel([]); }} aria-pressed={selecting}><CheckSquare size={14} />Select</Button>
          </div>
          <div className="row">
            <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Show">{SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by" style={{ width: 170 }}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</Select>
          </div>
          <div className="row small muted" style={{ justifyContent: "space-between" }}>
            <span>{total === undefined ? " " : `${total} work order${total === 1 ? "" : "s"}`}</span>
            {selecting && items.length > 0 && <Checkbox checked={sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
              onChange={(c) => setSel(c ? items.map((w) => w.id) : [])} label="Select all" />}
          </div>
        </div>
        <div className="list" role="list" ref={listRef}>
          {list.isLoading ? <ListSkeleton /> : items.length === 0 ? (
            <EmptyState icon={<ClipboardList size={26} />} title={tab === "todo" ? "Nothing to do" : "Nothing done yet"}>
              {query.filters.length || query.q || scope !== "all" ? "No work orders match. Try clearing filters." : tab === "todo" ? "Create a work order to get started. Press C anytime." : "Completed and canceled work orders show here."}
            </EmptyState>
          ) : items.map((w) => <WORow key={w.id} w={w} active={w.id === id} tz={session.org?.timezone} selecting={selecting} selected={sel.includes(w.id)}
            onSelect={(c) => setSel((s) => (c ? [...s, w.id] : s.filter((x) => x !== w.id)))} />)}
          {list.hasNextPage && <div style={{ padding: 12, textAlign: "center" }}><Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
        </div>
        {sel.length > 0 && <BulkBar ids={sel} items={items} onDone={() => setSel([])} />}
      </div>
      <div className="split-detail">
        {id ? <WorkOrderDetail id={id} key={id} /> : <EmptyState icon={<ClipboardList size={28} />} title="Select a work order">
          Pick one from the list to see its details, comments and time.<br /><span className="small faint">Shortcuts: <span className="kbd">C</span> create · <span className="kbd">J</span>/<span className="kbd">K</span> move · <span className="kbd">E</span> edit · <span className="kbd">?</span> all shortcuts</span></EmptyState>}
      </div>
    </div>
  );
}

export function WORow({ w, active, tz, selecting, selected, onSelect, onClick }: { w: WorkOrder; active?: boolean; tz?: string; selecting?: boolean; selected?: boolean; onSelect?: (v: boolean) => void; onClick?: () => void }) {
  const due = dueLabel(w.due_at, w.overdue, tz);
  const inner = (
    <>
      {selecting && <span onClick={(e) => e.stopPropagation()}><Checkbox checked={!!selected} onChange={(c) => onSelect?.(c)} label={<span className="sr-only">Select #{w.number}</span>} /></span>}
      <div className="grow wo-row-main">
        <div className="row" style={{ gap: 6 }}>{w.unread && <span className="unread-dot" aria-label="Unread" />}<span className="t">{w.title}</span></div>
        <div className="s row" style={{ gap: 8 }}><span className="mono">#{w.number}</span>
          {due && <span className={"due " + due.tone}>{due.text}</span>}
          {w.categories.slice(0, 2).map((c) => <span key={c.id} className="row" style={{ gap: 4 }}><span className="sw" style={{ background: c.color }} />{c.name}</span>)}
          {(w.comment_count ?? 0) > 0 && <span className="row" style={{ gap: 3 }}><MessageSquare size={12} />{w.comment_count}</span>}
          {w.sub_work_orders && <span>{w.sub_work_orders.closed}/{w.sub_work_orders.total} sub</span>}
        </div>
      </div>
      <div className="wo-row-side">
        <StatusPill status={w.status} />
        <div className="row" style={{ gap: 6 }}><PriorityBadge priority={w.priority} />
          {w.assignees.length > 0 && <AvatarStack people={w.assignees.map((a) => ({ name: a.name, initials: a.initials ?? a.name.slice(0, 2).toUpperCase() }))} max={3} />}</div>
      </div>
    </>
  );
  const cls = "list-row wo-row" + (active ? " active" : "") + (w.unread ? " unread" : "") + (w.deleted ? " deleted" : "");
  if (onClick) return <div className={cls} role="listitem" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}>{inner}</div>;
  return <Link to={`/work-orders/${w.id}`} className={cls} role="listitem">{inner}</Link>;
}

// ---------------------------------------------------------------- export
export function ExportDialog({ query, onClose, ids }: { query: ListQuery; onClose: () => void; ids?: string[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [format, setFormat] = useState<"csv" | "pdf">("csv");
  const m = useMutation({
    mutationFn: () => api<ExportItem>("/work-orders/export", { method: "POST", body: { format, ids, query: { q: query.q, filters: query.filters } } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["exports"] }); onClose(); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title="Export work orders" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => m.mutate()} disabled={m.isPending}><Download size={15} />Export</Button></>}>
      <p className="muted">{ids ? `${ids.length} selected work orders.` : "Everything that matches your current search and filters, in any status (To Do and Done)."} Exports go to the Download Center and are kept for 14 days.</p>
      <div className="seg" role="radiogroup" aria-label="Format">
        <button type="button" role="radio" aria-checked={format === "csv"} className={"seg-btn" + (format === "csv" ? " on" : "")} onClick={() => setFormat("csv")}>CSV spreadsheet</button>
        <button type="button" role="radio" aria-checked={format === "pdf"} className={"seg-btn" + (format === "pdf" ? " on" : "")} onClick={() => setFormat("pdf")}>PDF (one per page)</button>
      </div>
    </Modal>
  );
}
