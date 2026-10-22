import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, Boxes, Building2, Gauge, MapPin, ScanLine, Check, ChevronsLeft, ChevronsRight, ClipboardList, Download, Home, Keyboard, LogOut, Menu, MessageSquare, Monitor, Moon,
  MoreHorizontal, Pin, Plus, Search, Sun, Tags, UserRound, Zap } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Session, type Template } from "../lib/api";
import { applyTheme, useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Avatar, Button, Dropdown, Modal } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { CommandPalette } from "./CommandPalette";
import { NAV } from "./nav";

function readCollapsed(): boolean { try { return localStorage.getItem("mpro.sidebar") === "collapsed"; } catch { return false; } }

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
  useEffect(() => { try { localStorage.setItem("mpro.sidebar", collapsed ? "collapsed" : "open"); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setPalette(true); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay, .drawer-wrap")) return;
      if (e.key === "?") { e.preventDefault(); setHelp(true); }
      else if (e.key === "c" && !location.pathname.startsWith("/work-orders") && canRef.current("wo.create")) { e.preventDefault(); nav("/work-orders?new=1"); }
      else if (e.key === "g") { pendingG.current = Date.now(); }
      else if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const to = { w: "/work-orders", o: "/", p: "/people", s: "/settings", d: "/downloads" }[e.key];
        if (to) { e.preventDefault(); nav(to); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  const signOut = useCallback(async () => { set(await api<Session>("/auth/logout", { method: "POST" })); nav("/login"); }, [set, nav]);
  const setTheme = async (theme: "system" | "light" | "dark") => {
    applyTheme(theme);
    set(await api<Session>("/auth/preferences", { method: "PATCH", body: { theme } }));
  };
  const switchOrg = async (id: string) => { set(await api<Session>("/auth/switch-org", { method: "POST", body: { org_id: id } })); nav("/"); toast("Switched organization"); };

  let group = "";
  const user = session.user!;
  return (
    <div className={"shell" + (collapsed ? " collapsed" : "") + (drawer ? " drawer-open" : "")}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sb-head">
          <LogoMark size={30} />
          <span className="wm">Maintenance <b>Pro</b></span>
        </div>
        <Dropdown align="left" trigger={(_, toggle) => (
          <button className="sb-org" onClick={toggle} aria-label="Organization">
            <Building2 size={16} /><span className="name grow">{session.org?.name}</span>
          </button>)}>
          {(close) => <>
            <div className="menu-label">Organizations</div>
            {session.orgs?.map((o) => (
              <button key={o.id} className="menu-item" onClick={() => { close(); if (o.id !== session.org?.id) void switchOrg(o.id); }}>
                <Building2 size={15} /><span className="grow">{o.name}</span>{o.id === session.org?.id && <Check size={15} className="r" />}
              </button>))}
            {can("org.manage") && <><div className="menu-sep" /><Link className="menu-item" to="/settings/organization" onClick={close}>Organization settings</Link></>}
          </>}
        </Dropdown>
        <nav className="sb-nav">
          {NAV.filter((n) => n.group !== "hidden" && (!n.perm || can(n.perm))).map((n) => {
            const head = n.group && n.group !== group ? <div className="sb-group">{(group = n.group)}</div> : null;
            const Icon = n.icon;
            return (
              <div key={n.id}>
                {head}
                <NavLink to={n.path} end={n.path === "/"} className={({ isActive }) => "sb-item" + (isActive ? " active" : "")} title={collapsed ? n.label : undefined}>
                  <Icon size={18} /><span>{n.label}</span>{n.phase && <span className="soon" title={`Arrives in ${n.phase}`}>{n.phase.replace(/\.0$/, "")}</span>}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="sb-foot">
          <Button variant="ghost" icon size="sm" className="desktop-only" style={{ color: "var(--c-sidebar-muted)" }}
            onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </Button>
          <span className="ver small" style={{ color: "var(--c-sidebar-muted)" }}>MPro {session.version}{session.test_build ? " · test build" : ""}</span>
        </div>
      </aside>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" icon className="mobile-only" aria-label="Open menu" onClick={() => setDrawer(true)}><Menu size={20} /></Button>
          <button className="searchbtn" onClick={() => setPalette(true)} aria-label="Search">
            <Search size={16} /><span className="label-text">Search work orders, people, pages…</span><span className="kbd">Ctrl K</span>
          </button>
          <span className="grow" />
          <Button variant="ghost" icon aria-label="Scan a QR code or barcode" title="Scan a code" onClick={() => nav("/scan")}><ScanLine size={18} /></Button>
          <Dropdown trigger={(_, toggle) => <Button variant="primary" onClick={toggle} aria-label="Create"><Plus size={16} /><span className="desktop-only">Create</span></Button>}>
            {(close) => <>
              <div className="menu-label">Create</div>
              {can("wo.create") && <button className="menu-item" onClick={() => { close(); nav("/work-orders?new=1"); }}><ClipboardList size={15} />Work order<span className="r kbd">C</span></button>}
              {can("wo.create") && <QuickTemplates close={close} />}
              {can("categories.manage") && <button className="menu-item" onClick={() => { close(); nav("/categories"); }}><Tags size={15} />Category</button>}
              <div className="menu-sep" />
              {can("users.manage") && <button className="menu-item" onClick={() => { close(); nav("/people/users?invite=1"); }}><UserRound size={15} />Invite a person</button>}
              {can("teams.manage") && <button className="menu-item" onClick={() => { close(); nav("/people/teams?new=1"); }}><Building2 size={15} />Team</button>}
              {can("assets.manage") && <button className="menu-item" onClick={() => { close(); nav("/assets?new=1"); }}><Boxes size={15} />Asset</button>}
              {can("locations.manage") && <button className="menu-item" onClick={() => { close(); nav("/locations?new=1"); }}><MapPin size={15} />Location</button>}
              {can("meters.manage") && <button className="menu-item" onClick={() => { close(); nav("/meters?new=1"); }}><Gauge size={15} />Meter</button>}
            </>}
          </Dropdown>
          <Dropdown trigger={(_, toggle) => <Button variant="ghost" icon aria-label="Notifications" onClick={toggle}><Bell size={18} /></Button>}>
            {() => <div style={{ padding: 16, width: 280 }} className="small muted">Notifications arrive in 0.6.0. Until then, unread work orders show a blue dot in the Work Orders list.</div>}
          </Dropdown>
          <Dropdown trigger={(_, toggle) => <button className="btn ghost icon" onClick={toggle} aria-label="Account menu" style={{ width: 40 }}><Avatar name={user.name} initials={user.initials} size="sm" /></button>}>
            {(close) => <>
              <div style={{ padding: "8px 10px" }}><div style={{ fontWeight: 600 }}>{user.name}</div><div className="small muted">{user.email}</div>
                <div className="small faint">{session.role_label} · {session.org?.name}</div></div>
              <div className="menu-sep" />
              <Link className="menu-item" to="/profile" onClick={close}><UserRound size={15} />Profile &amp; password</Link>
              {can("exports.use") && <Link className="menu-item" to="/downloads" onClick={close}><Download size={15} />Download Center</Link>}
              <button className="menu-item" onClick={() => { close(); setHelp(true); }}><Keyboard size={15} />Keyboard shortcuts<span className="r kbd">?</span></button>
              <div className="menu-label">Theme</div>
              {([["system", "Match my device", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]] as const).map(([k, label, Icon]) => (
                <button key={k} className="menu-item" onClick={() => void setTheme(k)}><Icon size={15} />{label}{user.theme === k && <Check size={15} className="r" />}</button>))}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { close(); void signOut(); }}><LogOut size={15} />Sign out</button>
            </>}
          </Dropdown>
        </header>
        <main className="content" id="main"><Outlet /></main>
      </div>

      <nav className="bottomnav" aria-label="Quick navigation">
        {([["/", "Overview", Home], ["/work-orders", "Work Orders", ClipboardList], ["/assets", "Assets", Boxes], ["/messages", "Messages", MessageSquare]] as const).map(([p, l, Icon]) => (
          <NavLink key={p} to={p} end={p === "/"} className={({ isActive }) => (isActive ? "active" : "")}><Icon size={20} />{l}</NavLink>))}
        <button onClick={() => setDrawer(true)}><MoreHorizontal size={20} />More</button>
      </nav>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl K or /", "Search everything"], ["C", "Create a work order"], ["?", "Show this list"],
  ["J / K", "Next / previous work order in To Do"], ["E", "Edit the open work order"], ["Ctrl Enter", "Send a comment or save a form"],
  ["G then W", "Go to Work Orders"], ["G then O", "Go to Overview"], ["G then P", "Go to Teams & Users"], ["G then S", "Go to Settings"], ["G then D", "Go to Download Center"], ["Esc", "Close a panel or dialog"],
];

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="table"><tbody>{SHORTCUTS.map(([k, d]) => (
        <tr key={k}><td style={{ width: 150 }}>{k.split(" ").map((x, i) => x === "or" || x === "then" ? <span key={i} className="small faint"> {x} </span> : <span key={i} className="kbd">{x}</span>)}</td><td>{d}</td></tr>))}</tbody></table>
    </Modal>
  );
}

/** One-tap create from pinned and most-used templates (MP-101, roadmap r587). */
function QuickTemplates({ close }: { close: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useQuery({ queryKey: ["wo-templates", "popular"], queryFn: () => api<{ items: Template[] }>("/work-order-templates?sort=popular"), staleTime: 30_000 });
  const items = (t.data?.items ?? []).filter((x) => x.pinned || x.use_count > 0).slice(0, 5);
  const fallback = (t.data?.items ?? []).slice(0, 3);
  const list = items.length ? items : fallback;
  if (!list.length) return null;
  const go = async (tpl: Template) => {
    close();
    try {
      const wo = await api<{ id: string; number: number }>(`/work-order-templates/${tpl.id}/create`, { method: "POST", body: {} });
      qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["wo-templates"] }); qc.invalidateQueries({ queryKey: ["wo-stats"] });
      toast(`Work order #${wo.number} created from “${tpl.name}”`);
      nav(`/work-orders/${wo.id}`);
    } catch (e) {
      // a required field the template doesn't fill: open the full form prefilled instead
      toast((e as ApiError).message, { kind: "error" });
      nav(`/work-orders?new=1&template=${tpl.id}`);
    }
  };
  return <>
    <div className="menu-label">From a template</div>
    {list.map((x) => (
      <button key={x.id} className="menu-item" onClick={() => void go(x)} title={`Create a work order from “${x.name}” in one tap`}>
        {x.pinned ? <Pin size={15} /> : <Zap size={15} />}<span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
      </button>))}
    <div className="menu-sep" />
  </>;
}
