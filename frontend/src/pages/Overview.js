import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, ClipboardList, FlaskConical, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV } from "../shell/nav";
import { Button, EmptyState, ListSkeleton } from "../components/ui";
import { WORow } from "./workorders/WorkOrders";
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
function setListFilters(filters) { try {
    sessionStorage.setItem("wo.filters", JSON.stringify(filters));
    sessionStorage.removeItem("wo.savedview");
}
catch { /* ignore */ } }
export function Overview() {
    const { session, can } = useSession();
    const nav = useNavigate();
    const stats = useQuery({ queryKey: ["wo-stats"], queryFn: () => api("/work-orders/stats"), enabled: can("wo.view") });
    const mine = useQuery({ queryKey: ["work-orders", "overview-mine"], queryFn: () => api("/work-orders?tab=todo&scope=assigned_me&sort=due_at&per_page=6"), enabled: can("wo.view") });
    const assetStats = useQuery({ queryKey: ["asset-overview"], enabled: can("assets.view"), queryFn: async () => {
            const [offline, warr] = await Promise.all([
                api("/assets?status=offline&per_page=1"), api("/assets/warranties?days=60")
            ]);
            const overdue = can("meters.view") ? await api("/meters?overdue=1&per_page=1") : { total: 0 };
            return { offline: offline.total, warranties: warr.items.length, overdue: overdue.total };
        } });
    const a = assetStats.data;
    const next = NAV.filter((n) => n.phase).sort((a, b) => a.phase.localeCompare(b.phase))[0];
    const tile = (label, value, sub, filters, tone) => (_jsxs("button", { type: "button", className: "card tile tile-btn", onClick: () => { setListFilters(filters); nav("/work-orders?view=table"); }, children: [_jsx("div", { className: "k", children: label }), _jsx("div", { className: "v" + (tone && value ? " " + tone : ""), children: value ?? "–" }), _jsx("div", { className: "small muted", children: sub })] }));
    const s = stats.data;
    return (_jsxs("div", { className: "page", children: [_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsxs("h1", { children: [greeting(), ", ", session.user?.name.split(" ")[0]] }), _jsxs("p", { className: "sub", children: [session.org?.name, " \u00B7 ", session.role_label] })] }), can("wo.create") && _jsxs(Button, { variant: "primary", onClick: () => nav("/work-orders?new=1"), children: [_jsx(Plus, { size: 16 }), "New Work Order"] })] }), session.test_build && _jsxs("div", { className: "banner info", children: [_jsx(FlaskConical, { size: 18 }), _jsxs("div", { children: [_jsx("b", { children: "You're running a test build." }), " All data is stored locally on the host computer and may be lost during development.", session.db_path && _jsxs(_Fragment, { children: [" The database is at ", _jsx("code", { className: "mono db-path", children: session.db_path }), "."] })] })] }), can("wo.view") && _jsxs("div", { className: "tiles", children: [tile("Open work orders", s?.open, `${s?.assigned_to_me ?? 0} assigned to you`, [{ field: "status", op: "in", value: ["open", "on_hold", "in_progress"] }]), tile("Overdue", s?.overdue, "Past their due date", [{ field: "due_at", op: "overdue" }], "danger"), tile("High priority", s?.high_priority, "Open and high priority", [{ field: "status", op: "in", value: ["open", "on_hold", "in_progress"] }, { field: "priority", op: "in", value: ["high"] }], "warning"), tile("Completed", s?.completed_7d, "In the last 7 days", [{ field: "status", op: "in", value: ["done"] }]), can("assets.view") && _jsxs("button", { type: "button", className: "card tile tile-btn", onClick: () => nav("/assets?status=offline"), children: [_jsx("div", { className: "k", children: "Assets offline" }), _jsx("div", { className: "v" + (a?.offline ? " danger" : ""), children: a?.offline ?? "–" }), _jsx("div", { className: "small muted", children: a ? `${a.warranties} warrant${a.warranties === 1 ? "y" : "ies"} ending in 60 days` : " " })] }), can("meters.view") && (a?.overdue ?? 0) > 0 && _jsxs("button", { type: "button", className: "card tile tile-btn", onClick: () => nav("/meters?overdue=1"), children: [_jsx("div", { className: "k", children: "Readings overdue" }), _jsx("div", { className: "v warning", children: a?.overdue }), _jsx("div", { className: "small muted", children: "Meters waiting for a reading" })] }), (s?.awaiting_approval ?? 0) > 0 && tile("Awaiting approval", s?.awaiting_approval, "Done, waiting for sign-off", [{ field: "approval", op: "in", value: ["pending"] }], "warning")] }), _jsxs("div", { className: "form-grid", style: { alignItems: "start" }, children: [can("wo.view") && _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "My work" }), _jsxs(Link, { to: "/work-orders", className: "small row", children: ["All work orders ", _jsx(ArrowRight, { size: 14 })] })] }), mine.isLoading ? _jsx(ListSkeleton, { rows: 3 }) : (mine.data?.items.length ?? 0) === 0
                                ? _jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 24 }), title: "Nothing assigned to you", children: "Work assigned to you shows here, soonest due first." })
                                : _jsx("div", { role: "list", children: mine.data.items.map((w) => _jsx(WORow, { w: w, tz: session.org?.timezone }, w.id)) })] }), _jsxs("div", { className: "stack", style: { gap: 20 }, children: [_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsxs("h2", { children: ["What's in MPro ", session.version] }) }), _jsx("div", { className: "card-body", children: _jsx("ul", { className: "checklist", children: SHIPPED.map((x) => _jsxs("li", { children: [_jsx(CheckCircle2, { size: 18, color: "var(--c-success)" }), _jsx("span", { children: x })] }, x)) }) })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Coming next" }) }), _jsx("div", { className: "card-body", children: _jsx("ul", { className: "checklist", children: NAV.filter((n) => n.phase).sort((a, b) => a.phase.localeCompare(b.phase)).slice(0, 5).map((n) => (_jsxs("li", { children: [_jsx(Circle, { size: 18, className: "faint" }), _jsxs("span", { className: "grow", children: [_jsx(Link, { to: n.path, children: n.label }), _jsx("div", { className: "small muted", children: n.blurb })] }), _jsx("span", { className: "mono faint", children: n.phase })] }, n.id))) }) }), next && _jsx("div", { className: "card-body", style: { paddingTop: 0 }, children: _jsxs(Link, { to: next.path, className: "row small", children: ["See what ", next.label, " will do ", _jsx(ArrowRight, { size: 14 })] }) })] })] })] })] }));
}
