// Preventive Maintenance (0.4.0, MP-033/MP-104): plans list + detail split like Work Orders, a month calendar forecast
// and a compliance report. Repeating work orders show here too (kind "repeat"); they're edited on the work order.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, CalendarOff, Gauge, MoreHorizontal, PauseCircle, PieChart, Plus, Repeat, Search, Trash2 } from "lucide-react";
import "../../styles/workorders.css";
import "../../styles/pm.css";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { shortDate } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { PlanDetail } from "./PlanDetail";
import { PlanForm } from "./PlanForm";
import { PMCalendar } from "./Calendar";
import { CompliancePage } from "./Compliance";
import { pctLabel, pctTone, useHolidays, type Plan } from "./types";

type Tab = "plans" | "calendar" | "compliance";
const TABS: { id: Tab; label: string; icon: typeof Repeat }[] = [
  { id: "plans", label: "Plans", icon: CalendarClock }, { id: "calendar", label: "Calendar", icon: CalendarDays }, { id: "compliance", label: "Compliance", icon: PieChart },
];
type Paged<T> = { items: T[]; total: number; page: number; per_page: number };

export function PMPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const tab: Tab = id ? "plans" : ((params.get("tab") as Tab) || "plans");
  const [creating, setCreating] = useState(false);
  const [holidays, setHolidays] = useState(false);
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); params.delete("new"); setParams(params, { replace: true }); } }, [params, setParams]);
  const setTab = (t: Tab) => { if (id) nav(`/preventive-maintenance?tab=${t}`); else { const p = new URLSearchParams(params); p.set("tab", t); setParams(p); } };

  const tabs = (
    <div className="seg views" role="tablist" aria-label="Preventive maintenance">{TABS.map((t) => { const Icon = t.icon; return (
      <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={"seg-btn" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
        <Icon size={15} /><span>{t.label}</span></button>); })}</div>);
  const more = (
    <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={230}>
      {(close) => <button className="menu-item" onClick={() => { close(); setHolidays(true); }}><CalendarOff size={15} />Holidays and shutdowns…</button>}
    </Dropdown>);
  const newBtn = can("pm.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New maintenance plan"><Plus size={16} /><span>New plan</span></Button>;

  return (
    <div className="wo-page">
      {tab === "plans" ? <PlansSplit id={id} head={<>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ fontSize: "var(--fs-lg)" }}>Preventive Maintenance</h1>
          <div className="row">{more}{newBtn}</div>
        </div>{tabs}</>} />
        : <div className="wo-scroll"><div className="pm-page">
          <div className="page-head"><div><h1>Preventive Maintenance</h1></div><div className="row">{more}{newBtn}</div></div>
          {tabs}
          {tab === "calendar" ? <PMCalendar /> : <CompliancePage />}
        </div></div>}
      {creating && <PlanForm onClose={() => setCreating(false)} onSaved={(p) => nav(`/preventive-maintenance/${p.id}`)} />}
      {holidays && <HolidaysDialog onClose={() => setHolidays(false)} />}
    </div>
  );
}

function PlansSplit({ id, head }: { id?: string; head: React.ReactNode }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | "plan" | "repeat">("");
  const [active, setActive] = useState<"" | "1" | "0">("");
  const qs = `per_page=50&q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}${active ? `&active=${active}` : ""}`;
  const list = useInfiniteQuery({
    queryKey: ["pm-plans", qs], initialPageParam: 1,
    queryFn: ({ pageParam }) => api<Paged<Plan>>(`/pm/plans?${qs}&page=${pageParam}`),
    getNextPageParam: (l: Paged<Plan>) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
    placeholderData: (p) => p,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const filtered = !!(q || kind || active);
  return (
    <div className={"split wo-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools wo-list-tools">
          {head}
          <div className="search-in"><Search size={15} className="faint" />
            <Input placeholder="Search plans" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search plans" /></div>
          <div className="row" style={{ gap: 6 }}>
            <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="grow">
              <option value="">Plans and repeating work</option><option value="plan">Maintenance plans</option><option value="repeat">Repeating work orders</option></Select>
            <Select aria-label="Status" value={active} onChange={(e) => setActive(e.target.value as typeof active)} style={{ width: 130 }}>
              <option value="">Any status</option><option value="1">Active</option><option value="0">Paused</option></Select>
          </div>
          <div className="row small muted" style={{ justifyContent: "space-between" }}>
            <span>{total === undefined ? " " : `${total} plan${total === 1 ? "" : "s"}`}{filtered && <> · <button className="linkbtn small" onClick={() => { setQ(""); setKind(""); setActive(""); }}>Clear</button></>}</span>
            <span className="faint">Compliance: last 90 days</span>
          </div>
        </div>
        <div className="list" role="list">
          {list.isLoading ? <ListSkeleton /> : list.isError ? <div className="card-body banner warning">{(list.error as ApiError).message}</div>
            : items.length === 0 ? <EmptyState icon={<CalendarClock size={26} />} title={filtered ? "No plans match" : "No maintenance plans yet"}>
              {filtered ? "Try other filters." : "Plans create preventive work orders on a schedule or from meter readings. Make any work order repeat from its Repeat setting."}</EmptyState>
            : items.map((p) => <PlanRow key={p.id} p={p} active={p.id === id} />)}
          {list.hasNextPage && <div className="card-body"><Button block onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Show more</Button></div>}
        </div>
      </div>
      <div className="split-detail">
        {id ? <PlanDetail id={id} /> : <div className="desktop-only"><EmptyState icon={<CalendarClock size={26} />} title="Pick a plan">
          See its schedule, the next visits and how often it's done on time.</EmptyState></div>}
      </div>
    </div>
  );
}

function PlanRow({ p, active }: { p: Plan; active: boolean }) {
  const { session } = useSession();
  const pct = p.compliance?.percent;
  const Icon = p.kind === "repeat" ? Repeat : p.schedule_kind === "usage" ? Gauge : CalendarClock;
  return (
    <Link role="listitem" to={`/preventive-maintenance/${p.id}`} className={"list-row pm-row" + (active ? " active" : "") + (p.active ? "" : " paused")}>
      <span className={"pm-row-ic " + p.kind}><Icon size={16} /></span>
      <div className="grow">
        <div className="t">{p.name}</div>
        <div className="s">{p.frequency || "—"}{p.asset ? ` · ${p.asset.name}` : ""}</div>
      </div>
      <div className="pm-row-side">
        {p.active ? <span className="small muted">{p.next_due_at ? `Next ${shortDate(p.next_due_at, session.org?.timezone)}` : "Nothing scheduled"}</span>
          : <Pill tone="warning"><PauseCircle size={12} />Paused</Pill>}
        <span className={"pm-pct " + pctTone(pct)} title="Done on time, last 90 days">{pctLabel(pct)}</span>
      </div>
    </Link>
  );
}

function HolidaysDialog({ onClose }: { onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useHolidays();
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api("/pm/holidays", { method: "POST", body: { day, name } }),
    onSuccess: () => { setDay(""); setName(""); qc.invalidateQueries({ queryKey: ["pm-holidays"] }); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const del = useMutation({
    mutationFn: (hid: string) => api(`/pm/holidays/${hid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pm-holidays"] }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const manage = can("pm.manage");
  return (
    <Modal title="Holidays and shutdowns" onClose={onClose} width={520} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="small muted">Plans set to skip holidays move or skip visits that land on these days.</p>
      {manage && <div className="row wrap pm-hol-add">
        <Field label="Date">{(id) => <Input id={id} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label="Name" className="grow">{(id) => <Input id={id} value={name} maxLength={120} placeholder="e.g. Plant shutdown" onChange={(e) => setName(e.target.value)} />}</Field>
        <Button variant="primary" disabled={!day || add.isPending} onClick={() => add.mutate()}>Add</Button>
      </div>}
      {list.isLoading ? <ListSkeleton rows={3} /> : (list.data?.items.length ?? 0) === 0 ? <p className="small faint">No holidays yet.</p> : (
        <ul className="pm-hol-list">{list.data!.items.map((h) => (
          <li key={h.id} className="row"><span className="mono small">{h.day}</span><span className="grow">{h.name || "Holiday"}</span>
            {manage && <Button size="sm" variant="ghost" icon aria-label={`Remove ${h.day}`} onClick={() => del.mutate(h.id)}><Trash2 size={14} /></Button>}</li>))}</ul>)}
    </Modal>
  );
}
