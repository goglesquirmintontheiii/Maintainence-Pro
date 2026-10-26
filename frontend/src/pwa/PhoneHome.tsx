// The phone Overview (0.6.0, r290), laid out like MaintainX's mobile home: shortcuts (Due Today, Invite, Scan Code,
// Pause notifications, Message), tiles (High Priority, Overdue, Pending Requests, Completed in the last 7 days),
// my To-Do and Recent Activity. Shown instead of the desktop Overview below 640 px.
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BellOff, CalendarCheck, ClipboardList, MessageSquare, ScanLine, UserPlus, type LucideIcon } from "lucide-react";
import { api, type WOList, type WOStats } from "../lib/api";
import { useSession } from "../lib/session";
import { useOnline } from "../lib/offline";
import { timeAgo } from "../lib/format";
import { EmptyState, ListSkeleton } from "../components/ui";
import { WORow } from "../pages/workorders/WorkOrders";

type Activity = { id: string; type: string; summary: string; actor: string; at: string; work_order: { id: string; number: number; title: string; status: string } };

function setListFilters(filters: unknown[]) { try { sessionStorage.setItem("wo.filters", JSON.stringify(filters)); sessionStorage.removeItem("wo.savedview"); } catch { /* ignore */ } }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const OPEN = ["open", "on_hold", "in_progress"];

export function PhoneHome() {
  const { session, can } = useSession();
  const nav = useNavigate();
  const online = useOnline();
  const stats = useQuery({ queryKey: ["wo-stats"], queryFn: () => api<WOStats>("/work-orders/stats"), enabled: can("wo.view") });
  const mine = useQuery({ queryKey: ["work-orders", "overview-mine"], queryFn: () => api<WOList>("/work-orders?tab=todo&scope=assigned_me&sort=due_at&per_page=6"), enabled: can("wo.view") });
  const requests = useQuery({ queryKey: ["requests", "pending-count"], retry: false, enabled: can("requests.view_all") && online,
    queryFn: async () => (await api<{ total?: number }>("/requests?status=pending&per_page=1")).total ?? null });
  const activity = useQuery({ queryKey: ["recent-activity"], queryFn: () => api<{ items: Activity[] }>("/me/recent-activity?limit=10"), enabled: can("wo.view") });
  const s = stats.data;
  const toList = (filters: unknown[]) => { setListFilters(filters); nav("/work-orders?view=todo"); };
  const shortcuts: [string, LucideIcon, () => void, boolean][] = [
    ["Due Today", CalendarCheck, () => toList([{ field: "status", op: "in", value: OPEN }, { field: "due_at", op: "between", value: [today(), today()] }]), can("wo.view")],
    ["Invite", UserPlus, () => nav("/people/users?invite=1"), can("users.manage")],
    ["Scan Code", ScanLine, () => nav("/scan"), true],
    ["Pause notifications", BellOff, () => nav("/notifications?pause=1"), true],
    ["Message", MessageSquare, () => nav("/messages"), can("messages.use")],
  ];
  const tile = (label: string, value: number | null | undefined, onClick: () => void, tone?: string) => (
    <button type="button" className="ph-tile" onClick={onClick}>
      <span className={"v" + (tone && value ? " " + tone : "")}>{value ?? "–"}</span><span className="k">{label}</span></button>);
  return (
    <div className="phone-home">
      <div><h1 style={{ margin: 0 }}>Hi {session.user?.name.split(" ")[0]}</h1><div className="small muted">{session.org?.name}</div></div>
      <div className="ph-shortcuts" role="list" aria-label="Shortcuts">
        {shortcuts.filter((x) => x[3]).map(([l, Icon, go]) => <button key={l} type="button" role="listitem" className="ph-shortcut" onClick={go}><Icon size={22} />{l}</button>)}
      </div>
      {can("wo.view") && <div className="ph-tiles">
        {tile("High Priority", s?.high_priority, () => toList([{ field: "status", op: "in", value: OPEN }, { field: "priority", op: "in", value: ["high"] }]), "warning")}
        {tile("Overdue", s?.overdue, () => toList([{ field: "due_at", op: "overdue" }]), "danger")}
        {can("requests.view_all") && tile("Pending Requests", requests.data, () => nav("/requests"))}
        {tile("Completed (7 days)", s?.completed_7d, () => { setListFilters([{ field: "status", op: "in", value: ["done"] }]); nav("/work-orders?view=table"); })}
      </div>}
      {can("wo.view") && <section className="ph-section">
        <h2>To-Do</h2>
        {mine.isLoading ? <ListSkeleton rows={3} /> : (mine.data?.items.length ?? 0) === 0
          ? <EmptyState icon={<ClipboardList size={24} />} title="Nothing assigned to you">Work assigned to you shows here, soonest due first.</EmptyState>
          : <div className="card" role="list">{mine.data!.items.map((w) => <WORow key={w.id} w={w} tz={session.org?.timezone} />)}</div>}
        <Link to="/work-orders" className="small">All work orders</Link>
      </section>}
      {can("wo.view") && <section className="ph-section">
        <h2>Recent Activity</h2>
        {activity.isLoading ? <ListSkeleton rows={3} /> : !(activity.data?.items.length)
          ? <p className="small muted">Nothing yet.</p>
          : <ul className="ph-activity">{activity.data.items.map((a) => (
            <li key={a.id}><Link to={`/work-orders/${a.work_order.id}`}>
              <div className="small"><b>{a.actor}</b> {a.summary.charAt(0).toLowerCase() + a.summary.slice(1)}</div>
              <div className="small muted">#{a.work_order.number} {a.work_order.title} · {timeAgo(a.at)}</div>
            </Link></li>))}</ul>}
      </section>}
    </div>);
}
