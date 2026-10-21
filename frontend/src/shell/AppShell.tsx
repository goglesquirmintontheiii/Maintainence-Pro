import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, Boxes, Building2, Check, ChevronsLeft, ChevronsRight, ClipboardList, Home, LogOut, Menu, MessageSquare, Monitor, Moon,
  MoreHorizontal, Plus, Search, Sun, UserRound } from "lucide-react";
import { api, type Session } from "../lib/api";
import { applyTheme, useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Avatar, Button, Dropdown } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { CommandPalette } from "./CommandPalette";
import { NAV } from "./nav";

function readCollapsed(): boolean { try { return localStorage.getItem("mpro.sidebar") === "collapsed"; } catch { return false; } }

export function AppShell() {
  const { session, set, can } = useSession();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const { toast } = useToast();

  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => { try { localStorage.setItem("mpro.sidebar", collapsed ? "collapsed" : "open"); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => {
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
            <Search size={16} /><span className="label-text">Search people, teams, pages…</span><span className="kbd">Ctrl K</span>
          </button>
          <span className="grow" />
          <Dropdown trigger={(_, toggle) => <Button variant="primary" onClick={toggle} aria-label="Create"><Plus size={16} /><span className="desktop-only">Create</span></Button>}>
            {(close) => <>
              <div className="menu-label">Create</div>
              {can("users.manage") && <button className="menu-item" onClick={() => { close(); nav("/people/users?invite=1"); }}><UserRound size={15} />Invite a person</button>}
              {can("teams.manage") && <button className="menu-item" onClick={() => { close(); nav("/people/teams?new=1"); }}><Building2 size={15} />Team</button>}
              <div className="menu-sep" />
              <button className="menu-item" disabled><ClipboardList size={15} />Work order<span className="r small">0.2.0</span></button>
              <button className="menu-item" disabled><Boxes size={15} />Asset<span className="r small">0.3.0</span></button>
            </>}
          </Dropdown>
          <Dropdown trigger={(_, toggle) => <Button variant="ghost" icon aria-label="Notifications" onClick={toggle}><Bell size={18} /></Button>}>
            {() => <div style={{ padding: 16, width: 280 }} className="small muted">No notifications yet. Assignment, mention and due-date alerts arrive with work orders and notifications (0.2.0–0.6.0).</div>}
          </Dropdown>
          <Dropdown trigger={(_, toggle) => <button className="btn ghost icon" onClick={toggle} aria-label="Account menu" style={{ width: 40 }}><Avatar name={user.name} initials={user.initials} size="sm" /></button>}>
            {(close) => <>
              <div style={{ padding: "8px 10px" }}><div style={{ fontWeight: 600 }}>{user.name}</div><div className="small muted">{user.email}</div>
                <div className="small faint">{session.role_label} · {session.org?.name}</div></div>
              <div className="menu-sep" />
              <Link className="menu-item" to="/profile" onClick={close}><UserRound size={15} />Profile &amp; password</Link>
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
    </div>
  );
}
