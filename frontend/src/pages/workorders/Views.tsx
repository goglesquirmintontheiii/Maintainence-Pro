// Table, Calendar, Workload and Board views.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, GripVertical, RotateCcw } from "lucide-react";
import { api, ApiError, type WOList, type WOStatus, type WorkOrder, type Workload } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { addDays, filtersParam, fmtMinutes, shortDate, startOfDay, STATUS_LABEL, useWOOptions, WORK_TYPE_LABEL, ymd } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Checkbox, Dropdown, EmptyState, ListSkeleton, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { AssigneeChips, CategoryChips } from "../../components/pickers";
import { BulkBar } from "./Bulk";
import type { ListQuery } from "./WorkOrders";

function pref<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } }
function setPref(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

function usePatchWO() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/work-orders/${id}`, { method: "PATCH", body }),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["wo-workload"] }); qc.invalidateQueries({ queryKey: ["work-order", v.id] }); },
    onError: (e) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast((e as ApiError).message, { kind: "error" }); },
  });
}

// ---------------------------------------------------------------- table
type Col = { id: string; label: string; sort?: string; cell: (w: WorkOrder, tz?: string) => React.ReactNode; num?: boolean };
const BASE_COLS: Col[] = [
  { id: "number", label: "ID", sort: "number", cell: (w) => <span className="mono">#{w.number}</span> },
  { id: "title", label: "Title", sort: "title", cell: (w) => <span className="t">{w.unread && <span className="unread-dot" />} {w.title}</span> },
  { id: "status", label: "Status", sort: "status", cell: (w) => <StatusPill status={w.status} sub={w.sub_status} /> },
  { id: "priority", label: "Priority", sort: "priority", cell: (w) => <PriorityBadge priority={w.priority} /> },
  { id: "assignees", label: "Assigned to", cell: (w) => <AssigneeChips items={w.assignees} max={2} /> },
  { id: "due_at", label: "Due date", sort: "due_at", cell: (w, tz) => w.due_at ? <span className={w.overdue ? "due danger" : ""}>{shortDate(w.due_at, tz)}</span> : <span className="faint">—</span> },
  { id: "start_at", label: "Start date", sort: "start_at", cell: (w, tz) => w.start_at ? shortDate(w.start_at, tz) : <span className="faint">—</span> },
  { id: "categories", label: "Categories", cell: (w) => <CategoryChips items={w.categories} /> },
  { id: "work_type", label: "Work type", cell: (w) => WORK_TYPE_LABEL[w.work_type] },
  { id: "estimated", label: "Estimated", sort: "estimated_minutes", num: true, cell: (w) => (w.estimated_minutes ? fmtMinutes(w.estimated_minutes) : <span className="faint">—</span>) },
  { id: "created_by", label: "Created by", cell: (w) => w.created_by?.name ?? "—" },
  { id: "created_at", label: "Created", sort: "created_at", cell: (w, tz) => dateTime(w.created_at, tz) },
  { id: "updated_at", label: "Updated", sort: "updated_at", cell: (w, tz) => dateTime(w.updated_at, tz) },
  { id: "completed_at", label: "Completed", sort: "completed_at", cell: (w, tz) => (w.completed_at ? dateTime(w.completed_at, tz) : <span className="faint">—</span>) },
];
const DEFAULT_COLS = ["number", "title", "status", "priority", "assignees", "due_at", "categories"];

export function TableView({ query, onOpen }: { query: ListQuery; onOpen: (id: string) => void }) {
  const { session, can } = useSession();
  const opts = useWOOptions();
  const [cols, setCols] = useState<string[]>(() => pref("wo.table.cols", DEFAULT_COLS));
  const [sort, setSort] = useState<string>(() => pref("wo.table.sort", "-number"));
  const [perPage, setPerPage] = useState<number>(() => pref("wo.table.pp", 50));
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(true);
  const [sel, setSel] = useState<string[]>([]);
  const [dragCol, setDragCol] = useState<string | null>(null);
  useEffect(() => { setPref("wo.table.cols", cols); setPref("wo.table.sort", sort); setPref("wo.table.pp", perPage); }, [cols, sort, perPage]);
  const all: Col[] = useMemo(() => [...BASE_COLS, ...(opts.data?.custom_fields ?? []).map<Col>((f) => ({ id: `cf:${f.id}`, label: f.name,
    cell: (w) => { const v = w.custom[f.id]; return v === undefined || v === "" ? <span className="faint">—</span> : f.type === "checkbox" ? (v ? "Yes" : "No") : String(v); } }))], [opts.data]);
  const shown = cols.map((c) => all.find((x) => x.id === c)).filter(Boolean) as Col[];
  const qs = `sort=${sort}&per_page=${perPage}&page=${page}&q=${encodeURIComponent(query.q)}${filtersParam(query.filters)}${showDeleted ? "&include_deleted=1" : ""}${showUpcoming ? "" : "&tab=todo"}`;
  useEffect(() => { setPage(1); setSel([]); }, [query.q, query.filters, sort, perPage, showDeleted, showUpcoming]);
  const data = useQuery({ queryKey: ["work-orders", "table", qs], queryFn: () => api<WOList>(`/work-orders?${qs}`), placeholderData: (p) => p });
  const items = data.data?.items ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const toggleSort = (c: Col) => { if (!c.sort) return; setSort(sort === c.sort ? `-${c.sort}` : sort === `-${c.sort}` ? c.sort : c.id === "number" ? `-${c.sort}` : c.sort); };
  const moveCol = (from: string, to: string) => { if (from === to) return; const next = cols.filter((c) => c !== from); next.splice(next.indexOf(to), 0, from); setCols(next); };
  return (
    <div className="wo-table card">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <span className="small muted">{total} work order{total === 1 ? "" : "s"}</span>
        <div className="row wrap">
          <label className="check small"><input type="checkbox" checked={showUpcoming} onChange={(e) => setShowUpcoming(e.target.checked)} /><span>Show upcoming and done</span></label>
          {can("wo.delete") && <label className="check small"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /><span>Show deleted</span></label>}
          <Dropdown width={250} trigger={(_, t) => <Button size="sm" onClick={t}><Columns3 size={14} />Columns</Button>}>
            {() => <div style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
              {all.map((c) => <div key={c.id} style={{ padding: "3px 4px" }}><Checkbox checked={cols.includes(c.id)} disabled={c.id === "title"} label={c.label}
                onChange={(v) => setCols(v ? [...cols, c.id] : cols.filter((x) => x !== c.id))} /></div>)}
              <div className="menu-sep" /><button className="menu-item" onClick={() => setCols(DEFAULT_COLS)}><RotateCcw size={14} />Restore defaults</button>
            </div>}
          </Dropdown>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th style={{ width: 34 }}><Checkbox checked={items.length > 0 && sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
              onChange={(c) => setSel(c ? items.map((w) => w.id) : [])} label={<span className="sr-only">Select all</span>} /></th>
            {shown.map((c) => (
              <th key={c.id} draggable onDragStart={() => setDragCol(c.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragCol) moveCol(dragCol, c.id); setDragCol(null); }}
                className={(c.sort ? "sortable" : "") + (c.num ? " num" : "")} aria-sort={sort === c.sort ? "ascending" : sort === `-${c.sort}` ? "descending" : undefined}>
                <span className="row" style={{ gap: 4 }}><GripVertical size={12} className="faint grip" />
                  <button type="button" className="th-btn" onClick={() => toggleSort(c)} disabled={!c.sort}>{c.label}</button>
                  {sort === c.sort && <ArrowUp size={12} />}{sort === `-${c.sort}` && <ArrowDown size={12} />}</span></th>))}
          </tr></thead>
          <tbody>
            {data.isLoading && <tr><td colSpan={shown.length + 1}><ListSkeleton rows={4} /></td></tr>}
            {items.map((w) => (
              <tr key={w.id} className={"clickable" + (w.deleted ? " deleted" : "")} onClick={() => onOpen(w.id)}>
                <td onClick={(e) => e.stopPropagation()}><Checkbox checked={sel.includes(w.id)} onChange={(c) => setSel(c ? [...sel, w.id] : sel.filter((x) => x !== w.id))} label={<span className="sr-only">Select #{w.number}</span>} /></td>
                {shown.map((c) => <td key={c.id} className={c.num ? "num" : ""}>{c.cell(w, session.org?.timezone)}</td>)}
              </tr>))}
          </tbody>
        </table>
        {!data.isLoading && items.length === 0 && <EmptyState title="No work orders match">Try different filters.</EmptyState>}
      </div>
      <div className="card-body row" style={{ justifyContent: "space-between", paddingTop: 10, paddingBottom: 10 }}>
        <Select value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} aria-label="Results per page" style={{ width: 150 }}>
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}</Select>
        <div className="row"><Button size="sm" icon aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></Button>
          <span className="small">Page {page} of {pages}</span>
          <Button size="sm" icon aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></Button></div>
      </div>
      {sel.length > 0 && <BulkBar ids={sel} items={items} onDone={() => setSel([])} />}
    </div>
  );
}

// ---------------------------------------------------------------- calendar
export function CalendarView({ query, onOpen }: { query: ListQuery; onOpen: (id: string) => void }) {
  const { session } = useSession();
  const tz = session.org?.timezone;
  const [mode, setMode] = useState<"month" | "week">(() => pref("wo.cal.mode", "month"));
  const [weekStart, setWeekStart] = useState<0 | 1>(() => pref("mpro.weekStart", 0));
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [dragId, setDragId] = useState<string | null>(null);
  const patch = usePatchWO();
  useEffect(() => { setPref("wo.cal.mode", mode); setPref("mpro.weekStart", weekStart); }, [mode, weekStart]);
  const { from, days } = useMemo(() => {
    if (mode === "week") { const s = addDays(anchor, -((anchor.getDay() - weekStart + 7) % 7)); return { from: s, days: 7 }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = addDays(first, -((first.getDay() - weekStart + 7) % 7));
    return { from: s, days: 42 };
  }, [mode, anchor, weekStart]);
  const to = addDays(from, days);
  const f = [...query.filters, { field: "due_at", op: "between", value: [ymd(from), ymd(addDays(to, -1))] }, { field: "status", op: "not_in", value: ["canceled"] }];
  const qs = `per_page=500&sort=due_at&q=${encodeURIComponent(query.q)}${filtersParam(f)}`;
  const data = useQuery({ queryKey: ["work-orders", "cal", qs], queryFn: () => api<WOList>(`/work-orders?${qs}`), placeholderData: (p) => p });
  const byDay = useMemo(() => {
    const m: Record<string, WorkOrder[]> = {};
    for (const w of data.data?.items ?? []) if (w.due_at) (m[ymd(new Date(w.due_at))] ??= []).push(w);
    return m;
  }, [data.data]);
  const move = (dir: number) => setAnchor(mode === "week" ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
  const drop = (day: Date) => {
    const w = data.data?.items.find((x) => x.id === dragId);
    setDragId(null);
    if (!w || !w.due_at) return;
    const old = new Date(w.due_at);
    const nd = new Date(day); nd.setHours(old.getHours(), old.getMinutes(), 0, 0);
    if (ymd(nd) === ymd(old)) return;
    const body: Record<string, unknown> = { due_at: nd.toISOString(), version: w.version };
    if (w.start_at && new Date(w.start_at) > nd) body.start_at = null;
    patch.mutate({ id: w.id, body });
  };
  const title = mode === "month" ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : `${shortDate(from.toISOString())} – ${shortDate(addDays(from, 6).toISOString())}`;
  const today = ymd(new Date());
  const heads = Array.from({ length: 7 }, (_, i) => addDays(from, i).toLocaleDateString(undefined, { weekday: "short" }));
  return (
    <div className="card cal">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div className="row"><Button size="sm" icon aria-label="Previous" onClick={() => move(-1)}><ChevronLeft size={16} /></Button>
          <Button size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>Today</Button>
          <Button size="sm" icon aria-label="Next" onClick={() => move(1)}><ChevronRight size={16} /></Button><h2 style={{ marginLeft: 6 }}>{title}</h2></div>
        <div className="row">
          <Select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value) as 0 | 1)} aria-label="First day of week" style={{ width: 150, height: 30 }}>
            <option value={0}>Sunday first</option><option value={1}>Monday first</option></Select>
          <div className="seg" role="tablist"><button type="button" role="tab" aria-selected={mode === "month"} className={"seg-btn" + (mode === "month" ? " on" : "")} onClick={() => setMode("month")}>Month</button>
            <button type="button" role="tab" aria-selected={mode === "week"} className={"seg-btn" + (mode === "week" ? " on" : "")} onClick={() => setMode("week")}>Week</button></div>
        </div>
      </div>
      <div className={"cal-grid " + mode}>
        {heads.map((h) => <div key={h} className="cal-head">{h}</div>)}
        {Array.from({ length: days }, (_, i) => {
          const d = addDays(from, i), key = ymd(d), list = byDay[key] ?? [];
          const other = mode === "month" && d.getMonth() !== anchor.getMonth();
          const max = mode === "month" ? 3 : 30;
          return (
            <div key={key} className={"cal-day" + (other ? " other" : "") + (key === today ? " today" : "") + (dragId ? " droppable" : "")}
              onDragOver={(e) => e.preventDefault()} onDrop={() => drop(d)}>
              <div className="cal-num">{d.getDate()}</div>
              {list.slice(0, max).map((w) => (
                <button key={w.id} type="button" draggable onDragStart={() => setDragId(w.id)} onClick={() => onOpen(w.id)}
                  className={"cal-ev " + w.status + (w.overdue ? " overdue" : "")} title={`#${w.number} ${w.title}\n${STATUS_LABEL[w.status]} · ${dateTime(w.due_at, tz)}${w.assignees.length ? "\n" + w.assignees.map((a) => a.name).join(", ") : ""}`}>
                  <span className="dot" />{mode === "week" && <span className="faint">{new Date(w.due_at!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz })}</span>}<span className="cal-t">{w.title}</span></button>))}
              {list.length > max && <button type="button" className="linkbtn small" onClick={() => { setMode("week"); setAnchor(d); }}>+{list.length - max} more</button>}
            </div>);
        })}
      </div>
      <div className="card-body small faint row" style={{ gap: 14, paddingTop: 10, paddingBottom: 10 }}>
        <span className="row" style={{ gap: 4 }}><span className="legend open" />Open</span><span className="row" style={{ gap: 4 }}><span className="legend in_progress" />In progress</span>
        <span className="row" style={{ gap: 4 }}><span className="legend on_hold" />On hold</span><span className="row" style={{ gap: 4 }}><span className="legend done" />Done</span>
        <span className="row" style={{ gap: 4 }}><span className="legend overdue" />Overdue</span><span className="grow" />Drag a work order to another day to reschedule it.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- workload
export function WorkloadView({ onOpen }: { query: ListQuery; onOpen: (id: string) => void }) {
  const opts = useWOOptions();
  const [start, setStart] = useState(() => { const d = startOfDay(new Date()); return addDays(d, -((d.getDay() + 6) % 7)); });
  const [days, setDays] = useState(7);
  const [team, setTeam] = useState("");
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const patch = usePatchWO();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["wo-workload", ymd(start), days, team], queryFn: () => api<Workload>(`/work-orders/workload?start=${ymd(start)}&days=${days}${team ? `&team=${team}` : ""}`), placeholderData: (p) => p });
  const w = data.data;
  const drop = async (toUser: string | null, day: string) => {
    if (!drag) return;
    const d = drag; setDrag(null);
    try {
      const wo = await qc.fetchQuery({ queryKey: ["work-order", d.id], queryFn: () => api<{ assignees: { type: string; id: string }[]; due_at: string | null; version: number }>(`/work-orders/${d.id}?mark_read=0`), staleTime: 0 });
      const cur = wo.assignees.map((a) => `${a.type}:${a.id}`);
      let next = cur;
      if (toUser && d.from !== toUser) next = [...cur.filter((x) => x !== `user:${d.from}`), `user:${toUser}`].filter((x, i, a) => a.indexOf(x) === i);
      const old = wo.due_at ? new Date(wo.due_at) : new Date();
      const nd = new Date(`${day}T00:00`); nd.setHours(old.getHours(), old.getMinutes());
      patch.mutate({ id: d.id, body: { assignees: next, due_at: nd.toISOString(), version: wo.version } });
    } catch { /* toast in mutation */ }
  };
  const cap = w?.capacity_minutes ?? 480;
  const cell = (userKey: string | null, day: string, c?: { minutes: number; items: Workload["cells"][string][string]["items"] }) => (
    <td key={day} className={"wl-cell" + (drag ? " droppable" : "")} onDragOver={(e) => e.preventDefault()} onDrop={() => void drop(userKey, day)}>
      {c && c.minutes > 0 && <div className={"wl-bar" + (c.minutes > cap ? " over" : "")} title={`${fmtMinutes(c.minutes)} of ${fmtMinutes(cap)}`}>
        <span style={{ width: `${Math.min(100, (c.minutes / cap) * 100)}%` }} /></div>}
      {c && <div className="small faint">{c.minutes ? fmtMinutes(c.minutes) : ""}</div>}
      {c?.items.map((it) => <button type="button" key={it.id} className={"wl-item prio-" + it.priority} draggable onDragStart={() => setDrag({ id: it.id, from: userKey ?? "" })}
        onClick={() => onOpen(it.id)} title={`#${it.number} ${it.title}${it.minutes ? ` · ${fmtMinutes(it.minutes)}` : " · no estimate"}`}>#{it.number} {it.title}</button>)}
    </td>);
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div className="row"><Button size="sm" icon aria-label="Previous" onClick={() => setStart(addDays(start, -days))}><ChevronLeft size={16} /></Button>
          <Button size="sm" onClick={() => { const d = startOfDay(new Date()); setStart(addDays(d, -((d.getDay() + 6) % 7))); }}>This week</Button>
          <Button size="sm" icon aria-label="Next" onClick={() => setStart(addDays(start, days))}><ChevronRight size={16} /></Button>
          <h2 style={{ marginLeft: 6 }}>{shortDate(start.toISOString())} – {shortDate(addDays(start, days - 1).toISOString())}</h2></div>
        <div className="row">
          <Select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team" style={{ width: 180, height: 30 }}><option value="">Everyone</option>
            {(opts.data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range" style={{ width: 120, height: 30 }}><option value={7}>1 week</option><option value={14}>2 weeks</option></Select>
        </div>
      </div>
      {!w ? <ListSkeleton rows={5} /> : (
        <div className="table-wrap"><table className="table wl">
          <thead><tr><th style={{ minWidth: 180 }}>Person</th>{w.days.map((d) => { const dd = new Date(`${d}T00:00`); return (
            <th key={d} className={d === ymd(new Date()) ? "today" : ""}>{dd.toLocaleDateString(undefined, { weekday: "short" })} {dd.getDate()}</th>); })}</tr></thead>
          <tbody>
            {w.people.map((p) => <tr key={p.id}><td><span className="row"><Avatar name={p.name} initials={p.initials} size="sm" /><span><div style={{ fontWeight: 600 }}>{p.name}</div><div className="small faint">{p.job_title}</div></span></span></td>
              {w.days.map((d) => cell(p.id, d, w.cells[p.id]?.[d]))}</tr>)}
            {w.unassigned.map((r) => <tr key={r.id} className="wl-unassigned"><td><span className="row"><span className="sw lg" style={{ background: r.color }} /><span><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small faint">{r.id === "none" ? "Nobody assigned" : "Team, no person yet"}</div></span></span></td>
              {w.days.map((d) => cell(null, d, r.days[d]))}</tr>)}
          </tbody>
        </table></div>)}
      <div className="card-body small faint" style={{ paddingTop: 10, paddingBottom: 10 }}>Hours come from each work order's estimated time on its due date. Capacity is {fmtMinutes(cap)} a day. Drag work to another person or day to reassign or reschedule it.</div>
    </div>
  );
}

// ---------------------------------------------------------------- board
const BOARD: WOStatus[] = ["open", "on_hold", "in_progress", "done"];
export function BoardView({ query, onOpen }: { query: ListQuery; onOpen: (id: string) => void }) {
  const { session } = useSession();
  const opts = useWOOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [drag, setDrag] = useState<string | null>(null);
  const since = ymd(addDays(new Date(), -14));
  const qs = `per_page=300&sort=-priority&q=${encodeURIComponent(query.q)}${filtersParam([...query.filters, { field: "status", op: "not_in", value: ["canceled"] }])}`;
  const data = useQuery({ queryKey: ["work-orders", "board", qs], queryFn: () => api<WOList>(`/work-orders?${qs}`), placeholderData: (p) => p });
  const status = useMutation({
    mutationFn: ({ w, to }: { w: WorkOrder; to: WOStatus }) => api(`/work-orders/${w.id}/status`, { method: "POST", body: { status: to, version: w.version } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["work-orders"] }),
    onError: (e, v) => { toast((e as ApiError).message + (v.to === "done" ? " Open the work order to complete it." : ""), { kind: "error" }); if (v.to === "done") onOpen(v.w.id); },
  });
  const cols = useMemo(() => {
    const m: Record<string, WorkOrder[]> = { open: [], on_hold: [], in_progress: [], done: [] };
    for (const w of data.data?.items ?? []) if (m[w.status] && (w.status !== "done" || (w.completed_at ?? "") >= since)) m[w.status].push(w);
    return m;
  }, [data.data, since]);
  const needsDialog = (to: WOStatus) => to === "done" ? !!(opts.data?.settings.require_signature || opts.data?.settings.completion_summary === "mandatory")
    : to === "on_hold" && opts.data?.settings.comment_on_hold === "mandatory";
  return (
    <div className="board">
      {BOARD.map((s) => (
        <div key={s} className={"board-col " + s} onDragOver={(e) => e.preventDefault()} onDrop={() => {
          const w = data.data?.items.find((x) => x.id === drag); setDrag(null);
          if (!w || w.status === s) return;
          if (needsDialog(s)) { toast("This needs a comment, summary or signature. Opening the work order…"); onOpen(w.id); return; }
          qc.setQueryData<WOList>(["work-orders", "board", qs], (old) => old && { ...old, items: old.items.map((x) => (x.id === w.id ? { ...x, status: s } : x)) });
          status.mutate({ w, to: s });
        }}>
          <div className="board-head"><StatusPill status={s} /><span className="faint small">{cols[s].length}</span>{s === "done" && <span className="small faint">last 14 days</span>}</div>
          <div className="board-list">
            {cols[s].map((w) => (
              <button type="button" key={w.id} className="board-card" draggable onDragStart={() => setDrag(w.id)} onClick={() => onOpen(w.id)}>
                <div className="row small faint" style={{ justifyContent: "space-between" }}><span className="mono">#{w.number}</span><PriorityBadge priority={w.priority} /></div>
                <div className="t">{w.title}</div>
                <div className="row small" style={{ justifyContent: "space-between" }}>
                  <span className={w.overdue ? "due danger" : "faint"}>{w.due_at ? shortDate(w.due_at, session.org?.timezone) : ""}</span>
                  <span className="avatars">{w.assignees.filter((a) => a.type === "user").slice(0, 3).map((a) => <Avatar key={a.id} name={a.name} initials={a.initials} size="sm" />)}</span>
                </div>
              </button>))}
            {cols[s].length === 0 && <div className="small faint" style={{ padding: 8 }}>Drop work orders here</div>}
          </div>
        </div>))}
    </div>
  );
}
