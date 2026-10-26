import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, ClipboardList, FlaskConical, Plus } from "lucide-react";
import { api, type WOList, type WOStats } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV } from "../shell/nav";
import { Button, EmptyState, ListSkeleton } from "../components/ui";
import { WORow } from "./workorders/WorkOrders";
import { PhoneHome } from "../pwa/PhoneHome"; // phone Overview (0.6.0, r290)

const SHIPPED = [
  "Parts and inventory: stock per location, reservations, restocking, cycle counts and a transactions log",
  "Purchase orders with approval rules, budgets, partial receiving and supplier PunchOut carts",
  "Vendors and customers with contacts, quotes, and supplier product links that track price and stock",
  "Finance: receipts, vendor invoice matching, customer invoices, tax exemption certificates and cards",
  "Work orders shared outside the company by link, several assets and vendors per work order",
  "Maintenance plans with nested PMs, repeating work orders, a PM calendar and compliance",
  "Procedures with every field type, conditional logic, scoring, versions and reporting",
  "Automations: meter, asset and work-order triggers that create work, change status or email",
  "Owner and custom roles with permissions, a file viewer, a floor plan editor and profile photos",
  "Assets and locations in trees, with status, downtime, warranty, lifecycle and photo timelines",
  "Meters with charts, warning and alarm limits, and triggers that create work orders",
  "QR codes and barcodes: scan to open, tag first and assign later, Avery and thermal labels",
  "Asset task lists on work orders and one-tap templates",
  "Work orders with MaintainX fields, statuses, sub-statuses and numbering",
  "To Do, Table, Calendar, Workload and Board views with filters and saved views",
  "Comments with @mentions, photos and files, time, timers and costs",
  "Sign-off: signatures, completion summaries and approvals",
  "Sub-work orders, links, templates, custom fields and categories",
  "Bulk edit with Undo, PDF export with QR codes and a Download Center",
  "Sign in, organizations, roles, Teams & Users, audit log, light and dark themes",
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function setListFilters(filters: unknown[]) { try { sessionStorage.setItem("wo.filters", JSON.stringify(filters)); sessionStorage.removeItem("wo.savedview"); } catch { /* ignore */ } }

export function Overview() {
  const { session, can } = useSession();
  const nav = useNavigate();
  const stats = useQuery({ queryKey: ["wo-stats"], queryFn: () => api<WOStats>("/work-orders/stats"), enabled: can("wo.view") });
  const mine = useQuery({ queryKey: ["work-orders", "overview-mine"], queryFn: () => api<WOList>("/work-orders?tab=todo&scope=assigned_me&sort=due_at&per_page=6"), enabled: can("wo.view") });
  const assetStats = useQuery({ queryKey: ["asset-overview"], enabled: can("assets.view"), queryFn: async () => {
    const [offline, warr] = await Promise.all([
      api<{ total: number }>("/assets?status=offline&per_page=1"), api<{ items: unknown[] }>("/assets/warranties?days=60")]);
    const overdue = can("meters.view") ? await api<{ total: number }>("/meters?overdue=1&per_page=1") : { total: 0 };
    return { offline: offline.total, warranties: warr.items.length, overdue: overdue.total };
  } });
  const a = assetStats.data;
  const next = NAV.filter((n) => n.phase).sort((a, b) => a.phase!.localeCompare(b.phase!))[0];
  const tile = (label: string, value: number | undefined, sub: string, filters: unknown[], tone?: string) => (
    <button type="button" className="card tile tile-btn" onClick={() => { setListFilters(filters); nav("/work-orders?view=table"); }}>
      <div className="k">{label}</div><div className={"v" + (tone && value ? " " + tone : "")}>{value ?? "–"}</div><div className="small muted">{sub}</div></button>);
  const s = stats.data;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{greeting()}, {session.user?.name.split(" ")[0]}</h1><p className="sub">{session.org?.name} · {session.role_label}</p></div>
        {can("wo.create") && <Button variant="primary" onClick={() => nav("/work-orders?new=1")}><Plus size={16} />New Work Order</Button>}
      </div>
      {session.test_build && <div className="banner info"><FlaskConical size={18} /><div><b>You're running a test build.</b> All data is stored locally on the host computer and may be lost during development.{session.db_path && <> The database is at <code className="mono db-path">{session.db_path}</code>.</>}</div></div>}
      <PhoneHome />
      <div className="overview-desktop">
      {can("wo.view") && <div className="tiles">
        {tile("Open work orders", s?.open, `${s?.assigned_to_me ?? 0} assigned to you`, [{ field: "status", op: "in", value: ["open", "on_hold", "in_progress"] }])}
        {tile("Overdue", s?.overdue, "Past their due date", [{ field: "due_at", op: "overdue" }], "danger")}
        {tile("High priority", s?.high_priority, "Open and high priority", [{ field: "status", op: "in", value: ["open", "on_hold", "in_progress"] }, { field: "priority", op: "in", value: ["high"] }], "warning")}
        {tile("Completed", s?.completed_7d, "In the last 7 days", [{ field: "status", op: "in", value: ["done"] }])}
        {can("assets.view") && <button type="button" className="card tile tile-btn" onClick={() => nav("/assets?status=offline")}>
          <div className="k">Assets offline</div><div className={"v" + (a?.offline ? " danger" : "")}>{a?.offline ?? "–"}</div>
          <div className="small muted">{a ? `${a.warranties} warrant${a.warranties === 1 ? "y" : "ies"} ending in 60 days` : " "}</div></button>}
        {can("meters.view") && (a?.overdue ?? 0) > 0 && <button type="button" className="card tile tile-btn" onClick={() => nav("/meters?overdue=1")}>
          <div className="k">Readings overdue</div><div className="v warning">{a?.overdue}</div><div className="small muted">Meters waiting for a reading</div></button>}
        {(s?.awaiting_approval ?? 0) > 0 && tile("Awaiting approval", s?.awaiting_approval, "Done, waiting for sign-off", [{ field: "approval", op: "in", value: ["pending"] }], "warning")}
      </div>}
      <div className="form-grid" style={{ alignItems: "start" }}>
        {can("wo.view") && <section className="card">
          <div className="card-head"><h2>My work</h2><Link to="/work-orders" className="small row">All work orders <ArrowRight size={14} /></Link></div>
          {mine.isLoading ? <ListSkeleton rows={3} /> : (mine.data?.items.length ?? 0) === 0
            ? <EmptyState icon={<ClipboardList size={24} />} title="Nothing assigned to you">Work assigned to you shows here, soonest due first.</EmptyState>
            : <div role="list">{mine.data!.items.map((w) => <WORow key={w.id} w={w} tz={session.org?.timezone} />)}</div>}
        </section>}
        <div className="stack" style={{ gap: 20 }}>
          <section className="card">
            <div className="card-head"><h2>What's in MPro {session.version}</h2></div>
            <div className="card-body"><ul className="checklist">{SHIPPED.map((x) => <li key={x}><CheckCircle2 size={18} color="var(--c-success)" /><span>{x}</span></li>)}</ul></div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Coming next</h2></div>
            <div className="card-body"><ul className="checklist">
              {NAV.filter((n) => n.phase).sort((a, b) => a.phase!.localeCompare(b.phase!)).slice(0, 5).map((n) => (
                <li key={n.id}><Circle size={18} className="faint" /><span className="grow"><Link to={n.path}>{n.label}</Link><div className="small muted">{n.blurb}</div></span><span className="mono faint">{n.phase}</span></li>))}
            </ul></div>
            {next && <div className="card-body" style={{ paddingTop: 0 }}><Link to={next.path} className="row small">See what {next.label} will do <ArrowRight size={14} /></Link></div>}
          </section>
        </div>
      </div>
      </div>
    </div>
  );
}
