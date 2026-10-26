// MPro Management (0.6.0, MP-136): the server's own console for sysadmins. It has its own sidebar instead of the
// organization's: Overview, Server Settings, API Keys, User Database, User Management, Org Database, Org Management and
// the server's audit log. Only sysadmins get here, and the server checks that on every call (mpro/sysadmin/api.py).
// Organizations' data (files, money, work orders, assets) is never shown here.
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Check, Copy, Gauge, History, KeyRound, Lock, Menu, Plus, RotateCcw, Search, Server, ShieldCheck, Trash2, Unlock, UserCog, Users } from "lucide-react";
import { api, ApiError, type AuditEvent, type Session } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { LogoMark } from "../../components/Logo";
import "./management.css";

const BASE = "/mpro-management";
const SA = "/sysadmin";

type UserRow = { id: string; name: string; email: string; phone: string; initials: string; active: boolean; sysadmin: boolean; has_password: boolean;
  last_login_at: string | null; created_at: string | null; org_count: number };
type UserDetail = UserRow & { orgs: { org_id: string; org_name: string; org_deleted: boolean; plan: string; role: string; role_label: string; joined_at: string | null }[] };
type OrgRow = { id: string; name: string; slug: string; email: string; plan: string; plan_label: string; timezone: string; created_at: string | null;
  deleted: boolean; deleted_at: string | null; members: number; owners: { id: string; name: string; email: string }[] };
type OrgDetail = OrgRow & { member_list: { membership_id: string; user_id: string; name: string; email: string; role: string; role_label: string; active: boolean; joined_at: string | null }[];
  roles: { key: string; label: string }[]; plans: { key: string; label: string }[]; plans_apply?: boolean };
type Paged<T> = { items: T[]; total: number; page: number; per_page: number };
type SettingItem = { key: string; label: string; type: "str" | "int" | "bool" | "secret"; applies: "now" | "restart"; env: string; locked: boolean;
  source: "environment" | "file" | "default"; value: string | number | boolean | null; running?: string | number | boolean | null; has_value?: boolean };
type Settings = { items: SettingItem[]; file: string; everywhere_warning: string; edition: string; test_build: boolean; restart_needed?: string[]; warning?: string | null };
type ApiKeyRow = { id: string; name: string; service: string; service_label: string; masked: string; note: string; created_at: string | null; created_by: string | null };

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

const SECTIONS: { path: string; label: string; icon: typeof Gauge }[] = [
  { path: "", label: "Overview", icon: Gauge },
  { path: "server", label: "Server Settings", icon: Server },
  { path: "api-keys", label: "API Keys", icon: KeyRound },
  { path: "users", label: "User Database", icon: Users },
  { path: "user-management", label: "User Management", icon: UserCog },
  { path: "orgs", label: "Org Database", icon: Building2 },
  { path: "org-management", label: "Org Management", icon: ShieldCheck },
  { path: "audit", label: "Audit log", icon: History },
];

export function ManagementPage() {
  const { session, set } = useSession();
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const { toast } = useToast();
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  if (!session.user?.sysadmin) {
    return <div className="page"><EmptyState icon={<ShieldCheck size={28} />} title="Only MPro sysadmins can open MPro Management">
      Sysadmins are the people who run this MPro server. Ask one to add you, or run <code>mpro sysadmin add EMAIL</code> on the server.
      <div style={{ marginTop: 12 }}><Link to="/">Back to MPro</Link></div></EmptyState></div>;
  }
  const switchOrg = async (id: string) => { set(await api<Session>("/auth/switch-org", { method: "POST", body: { org_id: id } })); nav("/"); toast("Switched organization"); };
  return (
    <div className={"shell mgmt" + (drawer ? " drawer-open" : "")}>
      <aside className="sidebar" aria-label="MPro Management">
        <div className="sb-head"><LogoMark size={30} /><span className="wm">Maintenance <b>Pro</b></span></div>
        <Dropdown align="left" trigger={(_, toggle) => (
          <button className="sb-org" onClick={toggle} aria-label="Organization"><ShieldCheck size={16} /><span className="name grow">MPro Management</span></button>)}>
          {(close) => <>
            <div className="menu-label">Organizations</div>
            {session.orgs?.map((o) => (
              <button key={o.id} className="menu-item" onClick={() => { close(); void switchOrg(o.id); }}><Building2 size={15} /><span className="grow">{o.name}</span></button>))}
            <div className="menu-sep" />
            <div className="menu-item mgmt-current"><ShieldCheck size={15} /><span className="grow">MPro Management</span><Check size={15} className="r" /></div>
          </>}
        </Dropdown>
        <nav className="sb-nav">
          <div className="sb-group">Server</div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return <NavLink key={s.path} to={s.path ? `${BASE}/${s.path}` : BASE} end={!s.path} className={({ isActive }) => "sb-item" + (isActive ? " active" : "")}><Icon size={18} /><span>{s.label}</span></NavLink>;
          })}
        </nav>
        <div className="sb-foot">
          {session.org ? <Link to="/" className="sb-item mgmt-back"><ArrowLeft size={16} /><span>Back to {session.org.name}</span></Link>
            : <span className="ver small" style={{ color: "var(--c-sidebar-muted)" }}>MPro {session.version}</span>}
        </div>
      </aside>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
      <div className="main">
        <header className="topbar">
          <Button variant="ghost" icon className="mobile-only" aria-label="Open menu" onClick={() => setDrawer(true)}><Menu size={20} /></Button>
          <strong className="mgmt-title"><ShieldCheck size={16} /> MPro Management</strong>
          <span className="grow" />
          <span className="small muted desktop-only">Signed in as {session.user.email}</span>
          <Avatar name={session.user.name} initials={session.user.initials} src={session.user.avatar_url} size="sm" />
        </header>
        <main className="content">
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="server" element={<ServerSettingsPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="users" element={<UserDatabase />} />
            <Route path="user-management" element={<PickFirst kind="user" />} />
            <Route path="user-management/:id" element={<UserManagement />} />
            <Route path="orgs" element={<OrgDatabase />} />
            <Route path="org-management" element={<PickFirst kind="org" />} />
            <Route path="org-management/:id" element={<OrgManagement />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to={BASE} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Head({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>{actions}</div>;
}

// ---- overview ------------------------------------------------------------------------------
function OverviewPage() {
  const q = useQuery({ queryKey: ["sa", "overview"], queryFn: () => api<{ users: number; orgs: number; keys: number; sysadmins: UserRow[] }>(`${SA}/overview`) });
  const d = q.data;
  return (
    <div className="page">
      <Head title="MPro Management" sub="Look after this MPro server: its settings, keys, people and organizations. Organizations' own data (work orders, assets, files and money) isn't shown here." />
      {q.isLoading || !d ? <ListSkeleton rows={3} /> : <>
        <div className="mgmt-stats">
          <Link className="card mgmt-stat" to={`${BASE}/users`}><span className="n">{d.users}</span><span>people</span></Link>
          <Link className="card mgmt-stat" to={`${BASE}/orgs`}><span className="n">{d.orgs}</span><span>organizations</span></Link>
          <Link className="card mgmt-stat" to={`${BASE}/api-keys`}><span className="n">{d.keys}</span><span>API keys</span></Link>
        </div>
        <div className="card">
          <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Sysadmins</h3><span className="small muted">Change them in User Management or with <code>mpro sysadmin</code></span></div>
          {d.sysadmins.map((u) => (
            <Link key={u.id} to={`${BASE}/user-management/${u.id}`} className="list-row">
              <Avatar name={u.name} initials={u.initials} size="sm" />
              <span className="grow"><span className="t">{u.name}</span><span className="s">{u.email}</span></span>
              {!u.active && <Pill tone="danger">Locked</Pill>}
            </Link>))}
        </div>
      </>}
    </div>
  );
}

// ---- confirm with password -------------------------------------------------------------------
function ConfirmPassword({ title, children, confirmLabel, danger, extra, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; extra?: ReactNode;
  onConfirm: (password: string) => Promise<unknown>; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true); setError("");
    try { await onConfirm(pw); onClose(); } catch (e) { setError(err(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} disabled={!pw || busy} onClick={() => void go()}>{confirmLabel}</Button></>}>
      <div className="stack">
        {children}
        {extra}
        <Field label="Your password" hint="Enter your own MPro password to confirm." error={error}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pw) void go(); }} />}
        </Field>
      </div>
    </Modal>
  );
}

// ---- server settings ---------------------------------------------------------------------------
const GROUPS: { title: string; keys: string[]; note?: string }[] = [
  { title: "Address", keys: ["host", "port", "base_url"], note: "The address and port take effect when MPro restarts. The public address is used in emails and links." },
  { title: "Email (SMTP)", keys: ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_tls", "mail_from"] },
  { title: "Limits and security", keys: ["max_upload_mb", "session_hours", "trusted_proxies"] },
];

function ServerSettingsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["sa", "settings"], queryFn: () => api<Settings>(`${SA}/server-settings`) });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api<Settings>(`${SA}/server-settings`, { method: "PATCH", body: draft }),
    onSuccess: (r) => {
      qc.setQueryData(["sa", "settings"], r); setDraft({}); setWarning(r.warning ?? null);
      toast(r.restart_needed?.length ? `Saved. Restart MPro to apply: ${r.restart_needed.join(", ")}.` : "Saved.");
    },
    onError: (e) => toast(err(e), { kind: "error" }),
  });
  if (q.isLoading || !q.data) return <div className="page"><ListSkeleton /></div>;
  const items = Object.fromEntries(q.data.items.map((i) => [i.key, i]));
  const val = (i: SettingItem) => (i.key in draft ? draft[i.key] : i.value ?? "");
  const dirty = Object.keys(draft).length > 0;
  const host = String(val(items.host) || items.host.running || "");
  return (
    <div className="page page-narrow">
      <Head title="Server Settings" sub={<>Saved in <code className="mgmt-path">{q.data.file}</code>. Environment variables win over these; settings they fix are locked here.</>}
        actions={<Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      {(warning || host === "0.0.0.0") && <div className="banner warning" role="note"><strong>Listening on 0.0.0.0.</strong> {q.data.everywhere_warning}</div>}
      {GROUPS.map((g) => (
        <section key={g.title} className="card">
          <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>{g.title}</h3></div>
          <div className="card-body stack">
            {g.note && <p className="small muted" style={{ margin: 0 }}>{g.note}</p>}
            <div className="form-grid">
              {g.keys.map((k) => items[k]).filter(Boolean).map((i) => <SettingField key={i.key} item={i} value={val(i)} onChange={(v) => setDraft((d) => ({ ...d, [i.key]: v }))} />)}
            </div>
          </div>
        </section>))}
    </div>
  );
}

function SettingField({ item, value, onChange }: { item: SettingItem; value: string | number | boolean; onChange: (v: string | boolean) => void }) {
  const hint = item.locked ? `Set by ${item.env}. Change it there.` : [
    item.applies === "restart" ? "Takes effect after a restart." : "Takes effect straight away.",
    value !== "" && item.running !== undefined && item.running !== null && item.running !== "" && String(item.running) !== String(value) ? `Now running with ${String(item.running)}.` : "",
  ].filter(Boolean).join(" ");
  if (item.type === "bool") {
    return <div className="field"><Toggle checked={Boolean(value === "" ? item.running ?? true : value)} disabled={item.locked} onChange={(v) => onChange(v)} label={item.label} hint={hint} /></div>;
  }
  return (
    <Field label={item.label} hint={hint}>
      {(id) => item.type === "secret"
        ? <Input id={id} type="password" autoComplete="new-password" disabled={item.locked} value={String(value ?? "")}
            placeholder={item.has_value ? "•••••••• (saved; type to replace)" : "Not set"} onChange={(e) => onChange(e.target.value)} />
        : <Input id={id} inputMode={item.type === "int" ? "numeric" : undefined} disabled={item.locked} value={String(value ?? "")}
            placeholder={item.running !== undefined && item.running !== null ? String(item.running) : ""} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

// ---- API keys ------------------------------------------------------------------------------
function ApiKeysPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["sa", "keys"], queryFn: () => api<{ items: ApiKeyRow[]; services: { key: string; label: string }[] }>(`${SA}/api-keys`) });
  const [editing, setEditing] = useState<ApiKeyRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<ApiKeyRow | null>(null);
  const del = useMutation({ mutationFn: (k: ApiKeyRow) => api(`${SA}/api-keys/${k.id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sa", "keys"] }); setDeleting(null); toast("Key deleted"); }, onError: (e) => toast(err(e), { kind: "error" }) });
  return (
    <div className="page page-narrow">
      <Head title="API Keys" sub="Keys for AI providers and other services this server uses. They're stored encrypted and never shown again in full."
        actions={<Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />Add key</Button>} />
      <div className="card">
        {q.isLoading ? <ListSkeleton rows={3} /> : !q.data?.items.length
          ? <EmptyState icon={<KeyRound size={28} />} title="No keys yet">Add a key when you connect an AI provider or another service.</EmptyState>
          : q.data.items.map((k) => (
            <div key={k.id} className="list-row">
              <KeyRound size={18} className="faint" />
              <span className="grow"><span className="t">{k.name}</span><span className="s">{k.service_label} · <code>{k.masked}</code>{k.note ? ` · ${k.note}` : ""} · added {timeAgo(k.created_at)}{k.created_by ? ` by ${k.created_by}` : ""}</span></span>
              <Button size="sm" onClick={() => setEditing(k)}>Edit</Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${k.name}`} onClick={() => setDeleting(k)}><Trash2 size={15} /></Button>
            </div>))}
      </div>
      {editing && q.data && <KeyForm k={editing === "new" ? null : editing} services={q.data.services} onClose={() => setEditing(null)} />}
      {deleting && <Modal title="Delete this key?" onClose={() => setDeleting(null)} width={420}
        footer={<><Button onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate(deleting)}>Delete key</Button></>}>
        <p>Features that use <strong>{deleting.name}</strong> stop working until you add another key for {deleting.service_label}.</p></Modal>}
    </div>
  );
}

function KeyForm({ k, services, onClose }: { k: ApiKeyRow | null; services: { key: string; label: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(k?.name ?? "");
  const [service, setService] = useState(k?.service ?? services[0]?.key ?? "other");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState(k?.note ?? "");
  const save = useMutation({
    mutationFn: () => api(k ? `${SA}/api-keys/${k.id}` : `${SA}/api-keys`, { method: k ? "PATCH" : "POST", body: { name, service, note, ...(secret ? { secret } : {}) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sa", "keys"] }); toast(k ? "Key saved" : "Key added"); onClose(); },
    onError: (e) => toast(err(e), { kind: "error" }),
  });
  return (
    <Modal title={k ? "Edit key" : "Add a key"} onClose={onClose} width={500}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || (!k && !secret) || save.isPending} onClick={() => save.mutate()}>{k ? "Save" : "Add key"}</Button></>}>
      <div className="stack">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI for the AI assistant" />}</Field>
        <Field label="Service">{(id) => <Select id={id} value={service} onChange={(e) => setService(e.target.value)}>{services.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>}</Field>
        <Field label={k ? "New key (leave empty to keep the current one)" : "Key"} hint={k ? `Current key ends in ${k.masked.replace(/•/g, "")}.` : "Paste the whole key. It's encrypted before it's saved."}>
          {(id) => <Input id={id} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

// ---- user database -----------------------------------------------------------------------------
function useSearchList<T>(key: string, path: string, extra: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== q) setParams((p) => { const n = new URLSearchParams(p); if (text) n.set("q", text); else n.delete("q"); n.delete("page"); return n; }, { replace: true }); }, 250);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const qs = new URLSearchParams({ q, page: String(page), per_page: "25", ...extra });
  const query = useQuery({ queryKey: ["sa", key, qs.toString()], queryFn: () => api<Paged<T> & { plans_apply?: boolean }>(`${path}?${qs}`), placeholderData: keepPreviousData });
  const go = (p: number) => setParams((x) => { const n = new URLSearchParams(x); n.set("page", String(p)); return n; });
  return { text, setText, page, go, query };
}

function Pager({ page, total, per, go }: { page: number; total: number; per: number; go: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return null;
  return <div className="row mgmt-pager"><Button size="sm" disabled={page <= 1} onClick={() => go(page - 1)}>Previous</Button>
    <span className="small muted">Page {page} of {pages}</span><Button size="sm" disabled={page >= pages} onClick={() => go(page + 1)}>Next</Button></div>;
}

function UserDatabase() {
  const [filter, setFilter] = useState("");
  const { text, setText, page, go, query } = useSearchList<UserRow>("users", `${SA}/users`, filter ? { filter } : {});
  const nav = useNavigate();
  const d = query.data;
  return (
    <div className="page">
      <Head title="User Database" sub="Everyone with an account on this server. Open someone to manage them." />
      <div className="row wrap mgmt-tools">
        <div className="search-in grow"><Search size={15} className="faint" /><Input placeholder="Search name, email, phone or user ID" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search people" autoFocus /></div>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show" style={{ width: "auto" }}>
          <option value="">Everyone</option><option value="sysadmins">Sysadmins</option><option value="locked">Locked</option>
        </Select>
      </div>
      <div className="card table-wrap">
        {query.isLoading ? <ListSkeleton /> : !d?.items.length ? <EmptyState icon={<Users size={28} />} title="No one matches">Try another name or email.</EmptyState> : (
          <table className="table">
            <thead><tr><th>Name</th><th className="desktop-only">Email</th><th className="desktop-only">Phone</th><th>Orgs</th><th className="desktop-only">Last sign-in</th><th /></tr></thead>
            <tbody>{d.items.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => nav(`${BASE}/user-management/${u.id}`)}>
                <td><div className="row"><Avatar name={u.name} initials={u.initials} size="sm" /><span className="mgmt-cell">
                  <Link to={`${BASE}/user-management/${u.id}`} onClick={(e) => e.stopPropagation()}>{u.name}</Link><span className="small muted mobile-only">{u.email}</span></span></div></td>
                <td className="desktop-only">{u.email}</td><td className="desktop-only">{u.phone || "—"}</td><td>{u.org_count}</td>
                <td className="desktop-only">{u.last_login_at ? timeAgo(u.last_login_at) : "Never"}</td>
                <td><div className="row wrap">{u.sysadmin && <Pill tone="info">Sysadmin</Pill>}{!u.active && <Pill tone="danger">Locked</Pill>}</div></td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {d && <Pager page={page} total={d.total} per={d.per_page} go={go} />}
      {d && <p className="small muted">{d.total} {d.total === 1 ? "person" : "people"}</p>}
    </div>
  );
}

function PickFirst({ kind }: { kind: "user" | "org" }) {
  return (
    <div className="page page-narrow">
      <EmptyState icon={kind === "user" ? <UserCog size={28} /> : <ShieldCheck size={28} />} title={kind === "user" ? "Pick a person first" : "Pick an organization first"}
        action={<Link className="btn primary" to={`${BASE}/${kind === "user" ? "users" : "orgs"}`}>Open the {kind === "user" ? "User" : "Org"} Database</Link>}>
        {kind === "user" ? "Find someone in the User Database, then open them here." : "Find an organization in the Org Database, then open it here."}
      </EmptyState>
    </div>
  );
}

// ---- user management ---------------------------------------------------------------------------
function UserManagement() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { session } = useSession();
  const q = useQuery({ queryKey: ["sa", "user", id], queryFn: () => api<UserDetail>(`${SA}/users/${id}`) });
  const [form, setForm] = useState<{ name: string; email: string; phone: string } | null>(null);
  const [dialog, setDialog] = useState<"sysadmin" | "reset" | null>(null);
  const [resetMode, setResetMode] = useState<"email" | "set">("email");
  const [newPw, setNewPw] = useState("");
  useEffect(() => { if (q.data) setForm({ name: q.data.name, email: q.data.email, phone: q.data.phone }); }, [q.data]);
  const refresh = (u: UserDetail) => { qc.setQueryData(["sa", "user", id], u); void qc.invalidateQueries({ queryKey: ["sa", "users"] }); void qc.invalidateQueries({ queryKey: ["sa", "overview"] }); };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api<UserDetail>(`${SA}/users/${id}`, { method: "PATCH", body }),
    onSuccess: (u) => { refresh(u); toast("Saved"); }, onError: (e) => toast(err(e), { kind: "error" }) });
  if (q.isError) return <div className="page"><EmptyState title="That person doesn't exist"><Link to={`${BASE}/users`}>Back to the User Database</Link></EmptyState></div>;
  if (q.isLoading || !q.data || !form) return <div className="page"><ListSkeleton /></div>;
  const u = q.data;
  const me = u.id === session.user?.id;
  const dirty = form.name !== u.name || form.email !== u.email || form.phone !== u.phone;
  return (
    <div className="page page-narrow">
      <Link to={`${BASE}/users`} className="row small"><ArrowLeft size={14} />User Database</Link>
      <div className="mgmt-person card">
        <Avatar name={u.name} initials={u.initials} size="xl" />
        <div className="grow">
          <h1 style={{ margin: 0 }}>{u.name}</h1>
          <div className="muted">{u.email}</div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {u.sysadmin && <Pill tone="info">Sysadmin</Pill>}
            {u.active ? <Pill tone="success">Active</Pill> : <Pill tone="danger">Locked</Pill>}
            {!u.has_password && <Pill>Hasn't set a password</Pill>}
            <span className="small muted">Joined {dateTime(u.created_at)} · {u.last_login_at ? `last signed in ${timeAgo(u.last_login_at)}` : "never signed in"}</span>
          </div>
          <div className="row small muted mgmt-uid">User ID <code>{u.id}</code>
            <Button size="sm" variant="ghost" icon aria-label="Copy user ID" onClick={() => { void navigator.clipboard?.writeText(u.id); toast("User ID copied"); }}><Copy size={13} /></Button></div>
        </div>
      </div>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Details</h3>
          <Button variant="primary" size="sm" disabled={!dirty || patch.isPending} onClick={() => patch.mutate(form)}>Save</Button></div>
        <div className="card-body form-grid">
          <Field label="Name">{(fid) => <Input id={fid} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Email">{(fid) => <Input id={fid} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Phone">{(fid) => <Input id={fid} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Account</h3></div>
        <div className="card-body stack">
          <div className="row wrap mgmt-actions">
            <Button onClick={() => setDialog("reset")}><RotateCcw size={15} />Reset password</Button>
            {u.active
              ? <Button disabled={me} title={me ? "You can't lock your own account" : undefined} onClick={() => patch.mutate({ active: false })}><Lock size={15} />Lock account</Button>
              : <Button onClick={() => patch.mutate({ active: true })}><Unlock size={15} />Unlock account</Button>}
            <Button onClick={() => setDialog("sysadmin")}><ShieldCheck size={15} />{u.sysadmin ? "Remove as sysadmin" : "Make sysadmin"}</Button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>A locked account can't sign in and is signed out everywhere. Sysadmins run this server; it gives them no access to organizations' work.</p>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Organizations</h3><span className="small muted">Change roles and plans in Org Management</span></div>
        {!u.orgs.length ? <div className="card-body small muted">Not in any organization.</div> : u.orgs.map((o) => (
          <Link key={o.org_id} to={`${BASE}/org-management/${o.org_id}`} className="list-row">
            <Building2 size={18} className="faint" />
            <span className="grow"><span className="t">{o.org_name}</span><span className="s">{o.role_label} · joined {dateTime(o.joined_at)}{o.role === "owner" ? ` · plan: ${o.plan}` : ""}</span></span>
            {o.org_deleted && <Pill tone="danger">Deleted</Pill>}
          </Link>))}
      </section>

      {dialog === "sysadmin" && <ConfirmPassword title={u.sysadmin ? `Remove ${u.name} as a sysadmin?` : `Make ${u.name} a sysadmin?`} confirmLabel={u.sysadmin ? "Remove" : "Make sysadmin"} danger={u.sysadmin}
        onClose={() => setDialog(null)} onConfirm={async (password) => { refresh(await api<UserDetail>(`${SA}/users/${id}`, { method: "PATCH", body: { sysadmin: !u.sysadmin, password } })); toast("Saved"); }}>
        <p>{u.sysadmin ? "They'll lose MPro Management. Their organizations and roles stay the same." : "They'll see MPro Management and can change this server's settings, people and organizations."}</p>
      </ConfirmPassword>}
      {dialog === "reset" && <ConfirmPassword title={`Reset ${u.name}'s password`} confirmLabel={resetMode === "email" ? "Send link" : "Set password"}
        onClose={() => { setDialog(null); setNewPw(""); }}
        onConfirm={async (password) => { const r = await api<{ message: string }>(`${SA}/users/${id}/reset-password`, { method: "POST", body: { mode: resetMode, password, ...(resetMode === "set" ? { new_password: newPw } : {}) } }); toast(r.message); }}
        extra={<div className="stack">
          <label className="row"><input type="radio" checked={resetMode === "email"} onChange={() => setResetMode("email")} /> Email them a link to set a new password</label>
          <label className="row"><input type="radio" checked={resetMode === "set"} onChange={() => setResetMode("set")} /> Set a new password now</label>
          {resetMode === "set" && <Field label="New password" hint="At least 8 characters. Tell them in person; they can change it later.">
            {(fid) => <Input id={fid} type="text" autoComplete="off" value={newPw} onChange={(e) => setNewPw(e.target.value)} />}</Field>}
        </div>}>
        <p className="muted" style={{ margin: 0 }}>{u.email}</p>
      </ConfirmPassword>}
    </div>
  );
}

// ---- org database ------------------------------------------------------------------------------
function OrgDatabase() {
  const [deleted, setDeleted] = useState(false);
  const { text, setText, page, go, query } = useSearchList<OrgRow>("orgs", `${SA}/orgs`, deleted ? { deleted: "1" } : {});
  const nav = useNavigate();
  const d = query.data;
  return (
    <div className="page">
      <Head title="Org Database" sub="Every organization on this server. Open one to manage its name, plan and members." />
      <div className="row wrap mgmt-tools">
        <div className="search-in grow"><Search size={15} className="faint" /><Input placeholder="Search name, email or organization ID" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search organizations" autoFocus /></div>
        <label className="row small"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Include deleted</label>
      </div>
      {d && d.plans_apply === false && <p className="small muted" style={{ margin: 0 }}>Plans only limit organizations on MPro Cloud. On this server every organization gets every feature.</p>}
      <div className="card table-wrap">
        {query.isLoading ? <ListSkeleton /> : !d?.items.length ? <EmptyState icon={<Building2 size={28} />} title="No organizations match" /> : (
          <table className="table">
            <thead><tr><th>Organization</th><th className="desktop-only">Owner</th><th>Members</th><th>Plan</th><th className="desktop-only">Created</th><th /></tr></thead>
            <tbody>{d.items.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => nav(`${BASE}/org-management/${o.id}`)}>
                <td><Link to={`${BASE}/org-management/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.name}</Link>{o.email && <div className="small muted">{o.email}</div>}</td>
                <td className="desktop-only">{o.owners.map((x) => x.name).join(", ") || "—"}</td>
                <td>{o.members}</td><td>{o.plan_label}</td><td className="desktop-only">{dateTime(o.created_at)}</td>
                <td>{o.deleted && <Pill tone="danger">Deleted</Pill>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {d && <Pager page={page} total={d.total} per={d.per_page} go={go} />}
    </div>
  );
}

// ---- org management ------------------------------------------------------------------------------
function OrgManagement() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["sa", "org", id], queryFn: () => api<OrgDetail>(`${SA}/orgs/${id}`) });
  const [form, setForm] = useState<{ name: string; email: string; plan: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  useEffect(() => { if (q.data) setForm({ name: q.data.name, email: q.data.email, plan: q.data.plan }); }, [q.data]);
  const refresh = (o: OrgDetail) => { qc.setQueryData(["sa", "org", id], (old: OrgDetail | undefined) => ({ ...old, ...o })); void qc.invalidateQueries({ queryKey: ["sa", "orgs"] }); };
  const call = useMutation({ mutationFn: ({ path, method, body }: { path: string; method: "PATCH" | "POST" | "DELETE"; body?: unknown }) => api<OrgDetail>(`${SA}/orgs/${id}${path}`, { method, body }),
    onSuccess: (o) => { refresh(o); toast("Saved"); }, onError: (e) => toast(err(e), { kind: "error" }) });
  if (q.isError) return <div className="page"><EmptyState title="That organization doesn't exist"><Link to={`${BASE}/orgs`}>Back to the Org Database</Link></EmptyState></div>;
  if (q.isLoading || !q.data || !form) return <div className="page"><ListSkeleton /></div>;
  const o = q.data;
  const dirty = form.name !== o.name || form.email !== o.email || form.plan !== o.plan;
  return (
    <div className="page page-narrow">
      <Link to={`${BASE}/orgs`} className="row small"><ArrowLeft size={14} />Org Database</Link>
      <Head title={o.name} sub={<>Created {dateTime(o.created_at)} · {o.members} {o.members === 1 ? "member" : "members"} · ID <code>{o.id}</code></>}
        actions={o.deleted ? <Button onClick={() => call.mutate({ path: "/restore", method: "POST", body: {} })}><RotateCcw size={15} />Restore</Button> : undefined} />
      {o.deleted && <div className="banner warning">Deleted {dateTime(o.deleted_at)}. Members can't open it. Restore it to give them access again.</div>}
      <p className="small muted" style={{ margin: 0 }}>Only basic details and members are shown here. The organization's work orders, assets, files and money stay private to its members.</p>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Organization</h3>
          <Button variant="primary" size="sm" disabled={!dirty || o.deleted || call.isPending} onClick={() => call.mutate({ path: "", method: "PATCH", body: form })}>Save</Button></div>
        <div className="card-body form-grid">
          <Field label="Name">{(fid) => <Input id={fid} disabled={o.deleted} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Email">{(fid) => <Input id={fid} type="email" disabled={o.deleted} value={form.email} placeholder="contact@company.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Plan" hint={o.plans_apply === false ? "Plans only limit organizations on MPro Cloud." : undefined}>
            {(fid) => <Select id={fid} disabled={o.deleted} value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>{o.plans.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select>}</Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Members</h3>
          {!o.deleted && <Button size="sm" onClick={() => setAdding(true)}><Plus size={15} />Add member</Button>}</div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th className="desktop-only">Email</th><th>Role</th><th /></tr></thead>
          <tbody>{o.member_list.map((m) => (
            <tr key={m.user_id}>
              <td><Link to={`${BASE}/user-management/${m.user_id}`}>{m.name}</Link>{!m.active && <> <Pill tone="danger">Locked</Pill></>}<div className="small muted mobile-only">{m.email}</div></td>
              <td className="desktop-only">{m.email}</td>
              <td><Select aria-label={`Role of ${m.name}`} disabled={o.deleted} value={m.role} onChange={(e) => call.mutate({ path: `/members/${m.user_id}`, method: "PATCH", body: { role: e.target.value } })}>
                {o.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select></td>
              <td><Button size="sm" variant="ghost" icon disabled={o.deleted} aria-label={`Remove ${m.name}`} onClick={() => call.mutate({ path: `/members/${m.user_id}`, method: "DELETE" })}><Trash2 size={15} /></Button></td>
            </tr>))}</tbody>
        </table></div>
      </section>

      {!o.deleted && <section className="card mgmt-danger">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Delete organization</h3></div>
        <div className="card-body row wrap">
          <span className="grow small">Members lose access straight away. Its data is kept, so you can restore it from the Org Database (Include deleted).</span>
          <Button variant="danger" onClick={() => setDeleting(true)}><Trash2 size={15} />Delete organization</Button>
        </div>
      </section>}

      {adding && <AddMember org={o} onClose={() => setAdding(false)} onDone={refresh} />}
      {deleting && <ConfirmPassword title={`Delete ${o.name}?`} confirmLabel="Delete organization" danger onClose={() => { setDeleting(false); setConfirmName(""); }}
        onConfirm={async (password) => { await api(`${SA}/orgs/${id}/delete`, { method: "POST", body: { password, confirm_name: confirmName } }); await q.refetch(); void qc.invalidateQueries({ queryKey: ["sa", "orgs"] }); toast("Organization deleted"); }}
        extra={<Field label={`Type the name (${o.name}) to confirm`}>{(fid) => <Input id={fid} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}</Field>}>
        <p style={{ margin: 0 }}>Its {o.members} {o.members === 1 ? "member loses" : "members lose"} access straight away.</p>
      </ConfirmPassword>}
    </div>
  );
}

function AddMember({ org, onClose, onDone }: { org: OrgDetail; onClose: () => void; onDone: (o: OrgDetail) => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("technician");
  const add = useMutation({ mutationFn: () => api<OrgDetail>(`${SA}/orgs/${org.id}/members`, { method: "POST", body: { email, name, role } }),
    onSuccess: (o) => { onDone(o); toast("Member added"); onClose(); }, onError: (e) => toast(err(e), { kind: "error" }) });
  return (
    <Modal title={`Add someone to ${org.name}`} onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!email.trim() || add.isPending} onClick={() => add.mutate()}>Add</Button></>}>
      <div className="stack">
        <Field label="Email" hint="Someone new gets an email to set their password.">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Name (for someone new)">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>{org.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select>}</Field>
      </div>
    </Modal>
  );
}

// ---- audit -----------------------------------------------------------------------------------
function AuditPage() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(text), 250); return () => clearTimeout(t); }, [text]);
  const list = useQuery({ queryKey: ["sa", "audit", q], queryFn: () => api<{ items: AuditEvent[]; next_cursor: string | null }>(`${SA}/audit?q=${encodeURIComponent(q)}`) });
  return (
    <div className="page">
      <Head title="Audit log" sub="Server changes and everything done in MPro Management. Changes to an organization also show in that organization's own audit log." />
      <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search the audit log" /></div>
      <div className="card table-wrap">
        {list.isLoading ? <ListSkeleton /> : !list.data?.items.length ? <EmptyState icon={<History size={28} />} title="Nothing yet" /> : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th className="desktop-only">IP</th></tr></thead>
            <tbody>{list.data.items.map((e) => (
              <tr key={e.id}><td className="nowrap">{dateTime(e.created_at)}</td><td>{e.actor_label}</td><td>{e.summary}</td><td className="desktop-only small muted">{e.ip}</td></tr>))}</tbody>
          </table>)}
      </div>
    </div>
  );
}
