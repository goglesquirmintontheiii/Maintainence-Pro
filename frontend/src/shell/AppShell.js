import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, Boxes, Building2, Gauge, MapPin, ScanLine, Check, ChevronsLeft, ChevronsRight, ClipboardList, Download, Home, Keyboard, LogOut, Menu, MessageSquare, Monitor, Moon, MoreHorizontal, Pin, Plus, Search, Sun, Tags, UserRound, Zap } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { applyTheme, useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Avatar, Button, Dropdown, Modal } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { CommandPalette } from "./CommandPalette";
import { NAV } from "./nav";
function readCollapsed() { try {
    return localStorage.getItem("mpro.sidebar") === "collapsed";
}
catch {
    return false;
} }
export function AppShell() {
    const { session, set, can } = useSession();
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [drawer, setDrawer] = useState(false);
    const [palette, setPalette] = useState(false);
    const [help, setHelp] = useState(false);
    const pendingG = useRef(0);
    const canRef = useRef(can);
    canRef.current = can;
    const loc = useLocation();
    const nav = useNavigate();
    const { toast } = useToast();
    useEffect(() => { setDrawer(false); }, [loc.pathname]);
    useEffect(() => { try {
        localStorage.setItem("mpro.sidebar", collapsed ? "collapsed" : "open");
    }
    catch { /* ignore */ } }, [collapsed]);
    useEffect(() => {
        const onKey = (e) => {
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
            if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
                e.preventDefault();
                setPalette(true);
                return;
            }
            if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay, .drawer-wrap"))
                return;
            if (e.key === "?") {
                e.preventDefault();
                setHelp(true);
            }
            else if (e.key === "c" && !location.pathname.startsWith("/work-orders") && canRef.current("wo.create")) {
                e.preventDefault();
                nav("/work-orders?new=1");
            }
            else if (e.key === "g") {
                pendingG.current = Date.now();
            }
            else if (pendingG.current && Date.now() - pendingG.current < 1200) {
                pendingG.current = 0;
                const to = { w: "/work-orders", o: "/", p: "/people", s: "/settings", d: "/downloads" }[e.key];
                if (to) {
                    e.preventDefault();
                    nav(to);
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [nav]);
    const signOut = useCallback(async () => { set(await api("/auth/logout", { method: "POST" })); nav("/login"); }, [set, nav]);
    const setTheme = async (theme) => {
        applyTheme(theme);
        set(await api("/auth/preferences", { method: "PATCH", body: { theme } }));
    };
    const switchOrg = async (id) => { set(await api("/auth/switch-org", { method: "POST", body: { org_id: id } })); nav("/"); toast("Switched organization"); };
    let group = "";
    const user = session.user;
    return (_jsxs("div", { className: "shell" + (collapsed ? " collapsed" : "") + (drawer ? " drawer-open" : ""), children: [_jsxs("aside", { className: "sidebar", "aria-label": "Main navigation", children: [_jsxs("div", { className: "sb-head", children: [_jsx(LogoMark, { size: 30 }), _jsxs("span", { className: "wm", children: ["Maintenance ", _jsx("b", { children: "Pro" })] })] }), _jsx(Dropdown, { align: "left", trigger: (_, toggle) => (_jsxs("button", { className: "sb-org", onClick: toggle, "aria-label": "Organization", children: [_jsx(Building2, { size: 16 }), _jsx("span", { className: "name grow", children: session.org?.name })] })), children: (close) => _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "Organizations" }), session.orgs?.map((o) => (_jsxs("button", { className: "menu-item", onClick: () => { close(); if (o.id !== session.org?.id)
                                        void switchOrg(o.id); }, children: [_jsx(Building2, { size: 15 }), _jsx("span", { className: "grow", children: o.name }), o.id === session.org?.id && _jsx(Check, { size: 15, className: "r" })] }, o.id))), can("org.manage") && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsx(Link, { className: "menu-item", to: "/settings/organization", onClick: close, children: "Organization settings" })] })] }) }), _jsx("nav", { className: "sb-nav", children: NAV.filter((n) => n.group !== "hidden" && (!n.perm || can(n.perm))).map((n) => {
                            const head = n.group && n.group !== group ? _jsx("div", { className: "sb-group", children: (group = n.group) }) : null;
                            const Icon = n.icon;
                            return (_jsxs("div", { children: [head, _jsxs(NavLink, { to: n.path, end: n.path === "/", className: ({ isActive }) => "sb-item" + (isActive ? " active" : ""), title: collapsed ? n.label : undefined, children: [_jsx(Icon, { size: 18 }), _jsx("span", { children: n.label }), n.phase && _jsx("span", { className: "soon", title: `Arrives in ${n.phase}`, children: n.phase.replace(/\.0$/, "") })] })] }, n.id));
                        }) }), _jsxs("div", { className: "sb-foot", children: [_jsx(Button, { variant: "ghost", icon: true, size: "sm", className: "desktop-only", style: { color: "var(--c-sidebar-muted)" }, onClick: () => setCollapsed((c) => !c), "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar", children: collapsed ? _jsx(ChevronsRight, { size: 16 }) : _jsx(ChevronsLeft, { size: 16 }) }), _jsxs("span", { className: "ver small", style: { color: "var(--c-sidebar-muted)" }, children: ["MPro ", session.version, session.test_build ? " · test build" : ""] })] })] }), drawer && _jsx("div", { className: "drawer-backdrop", onClick: () => setDrawer(false) }), _jsxs("div", { className: "main", children: [_jsxs("header", { className: "topbar", children: [_jsx(Button, { variant: "ghost", icon: true, className: "mobile-only", "aria-label": "Open menu", onClick: () => setDrawer(true), children: _jsx(Menu, { size: 20 }) }), _jsxs("button", { className: "searchbtn", onClick: () => setPalette(true), "aria-label": "Search", children: [_jsx(Search, { size: 16 }), _jsx("span", { className: "label-text", children: "Search work orders, people, pages\u2026" }), _jsx("span", { className: "kbd", children: "Ctrl K" })] }), _jsx("span", { className: "grow" }), _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Scan a QR code or barcode", title: "Scan a code", onClick: () => nav("/scan"), children: _jsx(ScanLine, { size: 18 }) }), _jsx(Dropdown, { trigger: (_, toggle) => _jsxs(Button, { variant: "primary", onClick: toggle, "aria-label": "Create", children: [_jsx(Plus, { size: 16 }), _jsx("span", { className: "desktop-only", children: "Create" })] }), children: (close) => _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "Create" }), can("wo.create") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/work-orders?new=1"); }, children: [_jsx(ClipboardList, { size: 15 }), "Work order", _jsx("span", { className: "r kbd", children: "C" })] }), can("wo.create") && _jsx(QuickTemplates, { close: close }), can("categories.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/categories"); }, children: [_jsx(Tags, { size: 15 }), "Category"] }), _jsx("div", { className: "menu-sep" }), can("users.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/people/users?invite=1"); }, children: [_jsx(UserRound, { size: 15 }), "Invite a person"] }), can("teams.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/people/teams?new=1"); }, children: [_jsx(Building2, { size: 15 }), "Team"] }), can("assets.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/assets?new=1"); }, children: [_jsx(Boxes, { size: 15 }), "Asset"] }), can("locations.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/locations?new=1"); }, children: [_jsx(MapPin, { size: 15 }), "Location"] }), can("meters.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/meters?new=1"); }, children: [_jsx(Gauge, { size: 15 }), "Meter"] })] }) }), _jsx(Dropdown, { trigger: (_, toggle) => _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Notifications", onClick: toggle, children: _jsx(Bell, { size: 18 }) }), children: () => _jsx("div", { style: { padding: 16, width: 280 }, className: "small muted", children: "Notifications arrive in 0.6.0. Until then, unread work orders show a blue dot in the Work Orders list." }) }), _jsx(Dropdown, { trigger: (_, toggle) => _jsx("button", { className: "btn ghost icon", onClick: toggle, "aria-label": "Account menu", style: { width: 40 }, children: _jsx(Avatar, { name: user.name, initials: user.initials, src: user.avatar_url, size: "sm" }) }), children: (close) => _jsxs(_Fragment, { children: [_jsxs("div", { style: { padding: "8px 10px" }, children: [_jsx("div", { style: { fontWeight: 600 }, children: user.name }), _jsx("div", { className: "small muted", children: user.email }), _jsxs("div", { className: "small faint", children: [session.role_label, " \u00B7 ", session.org?.name] })] }), _jsx("div", { className: "menu-sep" }), _jsxs(Link, { className: "menu-item", to: "/profile", onClick: close, children: [_jsx(UserRound, { size: 15 }), "Profile & password"] }), can("exports.use") && _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(Download, { size: 15 }), "Download Center"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setHelp(true); }, children: [_jsx(Keyboard, { size: 15 }), "Keyboard shortcuts", _jsx("span", { className: "r kbd", children: "?" })] }), _jsx("div", { className: "menu-label", children: "Theme" }), [["system", "Match my device", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]].map(([k, label, Icon]) => (_jsxs("button", { className: "menu-item", onClick: () => void setTheme(k), children: [_jsx(Icon, { size: 15 }), label, user.theme === k && _jsx(Check, { size: 15, className: "r" })] }, k))), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => { close(); void signOut(); }, children: [_jsx(LogOut, { size: 15 }), "Sign out"] })] }) })] }), _jsx("main", { className: "content", id: "main", children: _jsx(Outlet, {}) })] }), _jsxs("nav", { className: "bottomnav", "aria-label": "Quick navigation", children: [[["/", "Overview", Home], ["/work-orders", "Work Orders", ClipboardList], ["/assets", "Assets", Boxes], ["/messages", "Messages", MessageSquare]].map(([p, l, Icon]) => (_jsxs(NavLink, { to: p, end: p === "/", className: ({ isActive }) => (isActive ? "active" : ""), children: [_jsx(Icon, { size: 20 }), l] }, p))), _jsxs("button", { onClick: () => setDrawer(true), children: [_jsx(MoreHorizontal, { size: 20 }), "More"] })] }), palette && _jsx(CommandPalette, { onClose: () => setPalette(false) }), help && _jsx(ShortcutsHelp, { onClose: () => setHelp(false) })] }));
}
const SHORTCUTS = [
    ["Ctrl K or /", "Search everything"], ["C", "Create a work order"], ["?", "Show this list"],
    ["J / K", "Next / previous work order in To Do"], ["E", "Edit the open work order"], ["Ctrl Enter", "Send a comment or save a form"],
    ["G then W", "Go to Work Orders"], ["G then O", "Go to Overview"], ["G then P", "Go to Teams & Users"], ["G then S", "Go to Settings"], ["G then D", "Go to Download Center"], ["Esc", "Close a panel or dialog"],
];
function ShortcutsHelp({ onClose }) {
    return (_jsx(Modal, { title: "Keyboard shortcuts", onClose: onClose, children: _jsx("table", { className: "table", children: _jsx("tbody", { children: SHORTCUTS.map(([k, d]) => (_jsxs("tr", { children: [_jsx("td", { style: { width: 150 }, children: k.split(" ").map((x, i) => x === "or" || x === "then" ? _jsxs("span", { className: "small faint", children: [" ", x, " "] }, i) : _jsx("span", { className: "kbd", children: x }, i)) }), _jsx("td", { children: d })] }, k))) }) }) }));
}
/** One-tap create from pinned and most-used templates (MP-101, roadmap r587). */
function QuickTemplates({ close }) {
    const nav = useNavigate();
    const qc = useQueryClient();
    const { toast } = useToast();
    const t = useQuery({ queryKey: ["wo-templates", "popular"], queryFn: () => api("/work-order-templates?sort=popular"), staleTime: 30_000 });
    const items = (t.data?.items ?? []).filter((x) => x.pinned || x.use_count > 0).slice(0, 5);
    const fallback = (t.data?.items ?? []).slice(0, 3);
    const list = items.length ? items : fallback;
    if (!list.length)
        return null;
    const go = async (tpl) => {
        close();
        try {
            const wo = await api(`/work-order-templates/${tpl.id}/create`, { method: "POST", body: {} });
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            qc.invalidateQueries({ queryKey: ["wo-templates"] });
            qc.invalidateQueries({ queryKey: ["wo-stats"] });
            toast(`Work order #${wo.number} created from “${tpl.name}”`);
            nav(`/work-orders/${wo.id}`);
        }
        catch (e) {
            // a required field the template doesn't fill: open the full form prefilled instead
            toast(e.message, { kind: "error" });
            nav(`/work-orders?new=1&template=${tpl.id}`);
        }
    };
    return _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "From a template" }), list.map((x) => (_jsxs("button", { className: "menu-item", onClick: () => void go(x), title: `Create a work order from “${x.name}” in one tap`, children: [x.pinned ? _jsx(Pin, { size: 15 }) : _jsx(Zap, { size: 15 }), _jsx("span", { className: "grow", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: x.name })] }, x.id))), _jsx("div", { className: "menu-sep" })] });
}
