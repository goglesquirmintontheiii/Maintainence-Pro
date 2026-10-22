import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Mail, Plus, Search, Trash2, UserPlus, Users } from "lucide-react";
import { api, ApiError, type Member, type Role, type Team } from "../lib/api";
import { useSession } from "../lib/session";
import { dateTime, timeAgo } from "../lib/format";
import { useToast } from "../components/Toast";
import { Avatar, AvatarStack, Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../components/ui";

const ROLE_TONE: Record<string, "info" | "success" | "warning" | "neutral"> = { owner: "info", admin: "info", limited_admin: "info", technician: "success",
  operator: "success", custom: "success", requester: "warning", viewer: "neutral" };

function useRoles() { return useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles"), staleTime: 60_000 }); }

/** Roles this person may hand out; the server has the final say (nobody grants more than they have). */
function assignableRoles(roles: Role[] | undefined, myRole: string | null | undefined): Role[] {
  return (roles ?? []).filter((r) => !r.deleted && (myRole === "owner" || (r.key !== "owner" && (myRole === "admin" || !["admin", "limited_admin"].includes(r.key)))));
}
const keyOf = (m: Member) => m.role_key ?? m.role;

export function People() {
  const { tab = "users", id } = useParams();
  const { can } = useSession();
  const canUsers = can("users.view");
  const t = tab === "teams" || !canUsers ? "teams" : "users";
  return (
    <div className={"split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools" style={{ paddingBottom: 0 }}>
          <div className="row" style={{ justifyContent: "space-between" }}><h1>Teams &amp; Users</h1></div>
          <div className="tabs" role="tablist">
            {canUsers && <NavLink to="/people/users" className={() => "tab" + (t === "users" ? " active" : "")} role="tab" aria-selected={t === "users"}><Users size={15} />Users</NavLink>}
            <NavLink to="/people/teams" className={() => "tab" + (t === "teams" ? " active" : "")} role="tab" aria-selected={t === "teams"}>Teams</NavLink>
          </div>
        </div>
        {t === "users" ? <UserList selected={id} /> : <TeamList selected={id} />}
      </div>
      <div className="split-detail">
        {id ? (t === "users" ? <UserDetail id={id} /> : <TeamDetail id={id} />)
          : <EmptyState icon={<Users size={28} />} title={t === "users" ? "Select a person" : "Select a team"}>
              {t === "users" ? "Pick someone from the list to see their role, teams and activity." : "Pick a team to see and manage its members."}</EmptyState>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- users
function UserList({ selected }: { selected?: string }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [params, setParams] = useSearchParams();
  const roles = useRoles();
  const { can } = useSession();
  const users = useQuery({ queryKey: ["users", q, role], queryFn: () => api<{ items: Member[]; total: number }>(`/users?q=${encodeURIComponent(q)}&role=${role}`), placeholderData: (p) => p });
  const inviting = params.get("invite") === "1";
  return (
    <>
      <div className="list-tools">
        <div className="row">
          <div className="grow" style={{ position: "relative" }}>
            <Search size={15} className="faint" style={{ position: "absolute", left: 10, top: 10 }} />
            <Input placeholder="Search name, email or job title" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 32 }} aria-label="Search users" />
          </div>
          {can("users.manage") && <Button variant="primary" onClick={() => setParams({ invite: "1" })} aria-label="Invite"><UserPlus size={16} /><span className="desktop-only">Invite</span></Button>}
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>{roles.data?.filter((r) => !r.deleted).map((r) => <option key={r.key} value={r.key}>{r.label}{r.custom ? " (custom)" : ""}</option>)}
        </Select>
        <div className="small muted">{users.data ? `${users.data.total} ${users.data.total === 1 ? "person" : "people"}` : " "}</div>
      </div>
      <div className="list" role="list">
        {users.isLoading ? <ListSkeleton /> : users.data?.items.length === 0 ? <EmptyState title="Nobody matches">Try a different name or role.</EmptyState>
          : users.data?.items.map((u) => (
            <Link key={u.id} to={`/people/users/${u.id}`} className={"list-row" + (u.id === selected ? " active" : "")} role="listitem">
              <Avatar name={u.name} initials={u.initials} src={u.avatar_url} />
              <div className="grow"><div className="t">{u.name}</div><div className="s">{u.job_title || u.email}</div></div>
              <Pill tone={ROLE_TONE[u.role]}>{u.role_label}</Pill>
            </Link>))}
      </div>
      {inviting && <InviteModal onClose={() => setParams({})} />}
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const roles = useRoles();
  const { session } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const [f, setF] = useState({ email: "", name: "", role: "technician", job_title: "" });
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => api<Member>("/users", { method: "POST", body: f }),
    onSuccess: (u) => { qc.invalidateQueries({ queryKey: ["users"] }); toast(`Invitation sent to ${u.email}`); onClose(); nav(`/people/users/${u.id}`); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const assignable = assignableRoles(roles.data, session.role);
  return (
    <Modal title="Invite a person" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.email || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Sending…" : "Send invitation"}</Button></>}>
      <p className="muted">They'll get an email with a link to set their password. Requesters are free and unlimited.</p>
      <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
      <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <div className="form-grid">
        <Field label="Role">{(id) => <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{assignable.map((r) => <option key={r.key} value={r.key}>{r.label}{r.custom ? " (custom)" : ""}</option>)}</Select>}</Field>
        <Field label="Job title (optional)">{(id) => <Input id={id} value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} />}</Field>
      </div>
      <p className="small muted">{roles.data?.find((r) => r.key === f.role)?.description}</p>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function UserDetail({ id }: { id: string }) {
  const { session, can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const roles = useRoles();
  const u = useQuery({ queryKey: ["user", id], queryFn: () => api<Member>(`/users/${id}`) });
  const [confirm, setConfirm] = useState(false);
  const [transfer, setTransfer] = useState<null | { stay: boolean }>(null);
  const { refresh } = useSession();
  const makeOwner = useMutation({
    mutationFn: (stay: boolean) => api<Member>("/org/transfer-ownership", { method: "POST", body: { user_id: id, stay_owner: stay } }),
    onSuccess: async (m) => { qc.setQueryData(["user", id], m); qc.invalidateQueries({ queryKey: ["users"] }); qc.invalidateQueries({ queryKey: ["roles"] });
      setTransfer(null); toast(`${m.name} is now an Owner`); await refresh(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const save = useMutation({
    mutationFn: (body: Partial<Member>) => api<Member>(`/users/${id}`, { method: "PATCH", body }),
    onSuccess: (m) => { qc.setQueryData(["user", id], m); qc.invalidateQueries({ queryKey: ["users"] }); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/users/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast("Removed from the organization"); nav("/people/users"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (u.isError) return <EmptyState title="Person not found">They may have been removed from this organization.</EmptyState>;
  if (!u.data) return <div className="detail"><ListSkeleton rows={3} /></div>;
  const m = u.data;
  const manage = can("users.manage") && m.id !== session.user?.id;
  const assignable = assignableRoles(roles.data, session.role);
  return (
    <div className="detail">
      <Link to="/people/users" className="row small mobile-only"><ArrowLeft size={14} />All people</Link>
      <div className="detail-head">
        <Avatar name={m.name} initials={m.initials} size="xl" src={m.avatar_url} />
        <div className="grow"><h1>{m.name}</h1><div className="muted">{m.job_title || "No job title"}</div>
          <div className="row wrap" style={{ marginTop: 8 }}><Pill tone={ROLE_TONE[m.role]}>{m.role_label}</Pill>{!m.has_password && <Pill tone="warning">Invitation pending</Pill>}</div></div>
        <a className="btn" href={`mailto:${m.email}`}><Mail size={16} />Email</a>
      </div>
      <dl className="meta-grid card card-pad">
        <div><dt>Email</dt><dd>{m.email}</dd></div>
        <div><dt>Last signed in</dt><dd title={dateTime(m.last_login_at)}>{timeAgo(m.last_login_at)}</dd></div>
        <div><dt>Joined</dt><dd>{dateTime(m.joined_at)}</dd></div>
        <div><dt>Teams</dt><dd className="row wrap">{m.teams.length ? m.teams.map((t) => <Link key={t.id} to={`/people/teams/${t.id}`} className="chip"><span className="sw" style={{ background: t.color }} />{t.name}</Link>) : <span className="faint">None</span>}</dd></div>
      </dl>
      {manage && (
        <section className="card">
          <div className="card-head"><h2>Role and details</h2></div>
          <div className="card-body form-grid">
            <Field label="Role" hint={roles.data?.find((r) => r.key === keyOf(m))?.description}>{(fid) => (
              <Select id={fid} value={keyOf(m)} disabled={save.isPending || !assignable.some((r) => r.key === keyOf(m))} onChange={(e) => save.mutate({ role: e.target.value })}>
                {(assignable.some((r) => r.key === keyOf(m)) ? assignable : roles.data ?? []).map((r) => <option key={r.key} value={r.key}>{r.label}{r.custom ? " (custom)" : ""}</option>)}
              </Select>)}</Field>
            <Field label="Job title">{(fid) => <Input id={fid} defaultValue={m.job_title} key={m.job_title} onBlur={(e) => { if (e.target.value !== m.job_title) save.mutate({ job_title: e.target.value }); }} />}</Field>
          </div>
          {session.role === "owner" && m.role !== "owner" && m.has_password && (
            <div className="card-body row wrap" style={{ borderTop: "1px solid var(--c-border-soft)" }}>
              <span className="grow small muted">Owners can change organization settings, billing and roles. Every organization needs at least one.</span>
              <Button onClick={() => setTransfer({ stay: false })}>Make {m.name.split(" ")[0]} an Owner…</Button>
            </div>)}
          <div className="card-body" style={{ borderTop: "1px solid var(--c-border-soft)" }}>
            {confirm ? <div className="row wrap"><span className="grow">Remove {m.name} from {session.org?.name}? Their history stays in the audit log.</span>
              <Button onClick={() => setConfirm(false)}>Keep</Button><Button variant="danger" className="solid" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</Button></div>
              : <Button variant="danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Remove from organization</Button>}
          </div>
        </section>)}
      {can("wo.view") && ["owner", "admin", "limited_admin", "technician", "operator", "custom"].includes(m.role) && <WorkSettings userId={m.id} manage={can("users.manage") && !["owner", "admin"].includes(m.role)} self={m.id === session.user?.id} />}
      {can("audit.view") && <Link to={`/settings/audit-log?entity_id=${m.id}`} className="small">See this person's history in the audit log</Link>}
      {transfer && <Modal title={`Make ${m.name} an Owner?`} onClose={() => setTransfer(null)}
        footer={<><Button onClick={() => setTransfer(null)}>Cancel</Button><Button variant="primary" disabled={makeOwner.isPending} onClick={() => makeOwner.mutate(transfer.stay)}>Make Owner</Button></>}>
        <p>{m.name} will get full access, including organization settings, billing and roles.</p>
        <label className="check"><input type="checkbox" checked={transfer.stay} onChange={(e) => setTransfer({ stay: e.target.checked })} />
          <span>I stay an Owner too (otherwise I become an Administrator)</span></label>
      </Modal>}
    </div>
  );
}

// ---------------------------------------------------------------- teams
function TeamList({ selected }: { selected?: string }) {
  const [q, setQ] = useState("");
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const teams = useQuery({ queryKey: ["teams", q], queryFn: () => api<{ items: Team[]; total: number }>(`/teams?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  return (
    <>
      <div className="list-tools">
        <div className="row">
          <div className="grow" style={{ position: "relative" }}>
            <Search size={15} className="faint" style={{ position: "absolute", left: 10, top: 10 }} />
            <Input placeholder="Search teams" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 32 }} aria-label="Search teams" />
          </div>
          {can("teams.manage") && <Button variant="primary" onClick={() => setParams({ new: "1" })} aria-label="New team"><Plus size={16} /><span className="desktop-only">New team</span></Button>}
        </div>
        <div className="small muted">{teams.data ? `${teams.data.total} teams` : " "}</div>
      </div>
      <div className="list" role="list">
        {teams.isLoading ? <ListSkeleton /> : teams.data?.items.length === 0 ? <EmptyState title="No teams yet">Teams group people by trade or area so work can be assigned to the whole team.</EmptyState>
          : teams.data?.items.map((t) => (
            <Link key={t.id} to={`/people/teams/${t.id}`} className={"list-row" + (t.id === selected ? " active" : "")} role="listitem">
              <span className="avatar" style={{ background: t.color, borderRadius: 8 }}>{t.name.slice(0, 2).toUpperCase()}</span>
              <div className="grow"><div className="t">{t.name}</div><div className="s">{t.member_count} {t.member_count === 1 ? "member" : "members"}</div></div>
              <AvatarStack people={t.members} max={3} />
            </Link>))}
      </div>
      {params.get("new") === "1" && <TeamModal onClose={() => setParams({})} />}
    </>
  );
}

const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#b8560b", "#7a52c9", "#c4302b", "#3d6fb6", "#5d6880"];

function TeamModal({ team, onClose }: { team?: Team; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const [f, setF] = useState({ name: team?.name ?? "", description: team?.description ?? "", color: team?.color ?? COLORS[0] });
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => team ? api<Team>(`/teams/${team.id}`, { method: "PATCH", body: f }) : api<Team>("/teams", { method: "POST", body: f }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["teams"] }); qc.setQueryData(["team", t.id], t); toast(team ? "Team saved" : `Team ${t.name} created`); onClose(); if (!team) nav(`/people/teams/${t.id}`); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={team ? "Edit team" : "New team"} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>{team ? "Save" : "Create team"}</Button></>}>
      <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Electrical" />}</Field>
      <Field label="Description (optional)">{(id) => <textarea id={id} className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <div className="field"><span className="label">Colour</span><div className="row wrap">{COLORS.map((c) => (
        <button key={c} type="button" aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })}
          style={{ width: 28, height: 28, borderRadius: 8, background: c, border: f.color === c ? "3px solid var(--c-text)" : "2px solid var(--c-panel)", cursor: "pointer" }} />))}</div></div>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function TeamDetail({ id }: { id: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const t = useQuery({ queryKey: ["team", id], queryFn: () => api<Team>(`/teams/${id}`) });
  const users = useQuery({ queryKey: ["users", "", ""], queryFn: () => api<{ items: Member[] }>("/users?q=&role="), enabled: can("teams.manage") && can("users.view") });
  const [edit, setEdit] = useState(false);
  const [add, setAdd] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); setAdd(""); }, [id]);
  const done = (msg: string) => (team: Team) => { qc.setQueryData(["team", id], team); qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["users"] }); toast(msg); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const addM = useMutation({ mutationFn: (uid: string) => api<Team>(`/teams/${id}/members`, { method: "POST", body: { user_id: uid } }), onSuccess: done("Added to the team"), onError: err });
  const rmM = useMutation({ mutationFn: (uid: string) => api<Team>(`/teams/${id}/members/${uid}`, { method: "DELETE" }), onSuccess: done("Removed from the team"), onError: err });
  const delM = useMutation({ mutationFn: () => api(`/teams/${id}`, { method: "DELETE" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); toast("Team deleted"); nav("/people/teams"); }, onError: err });
  const candidates = useMemo(() => (users.data?.items ?? []).filter((u) => !t.data?.members.some((m) => m.id === u.id)), [users.data, t.data]);
  if (t.isError) return <EmptyState title="Team not found">It may have been deleted.</EmptyState>;
  if (!t.data) return <div className="detail"><ListSkeleton rows={3} /></div>;
  const team = t.data;
  const manage = can("teams.manage");
  return (
    <div className="detail">
      <Link to="/people/teams" className="row small mobile-only"><ArrowLeft size={14} />All teams</Link>
      <div className="detail-head">
        <span className="avatar xl" style={{ background: team.color, borderRadius: 14 }}>{team.name.slice(0, 2).toUpperCase()}</span>
        <div className="grow"><h1>{team.name}</h1><div className="muted">{team.description || "No description"}</div></div>
        {manage && <Button onClick={() => setEdit(true)}>Edit</Button>}
      </div>
      <section className="card">
        <div className="card-head"><h2>Members <span className="faint tnum">({team.member_count})</span></h2>
          {manage && can("users.view") && <div className="row">
            <Select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Person to add" style={{ width: 220 }}>
              <option value="">Add a person…</option>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Button variant="primary" disabled={!add || addM.isPending} onClick={() => { addM.mutate(add); setAdd(""); }}>Add</Button></div>}
        </div>
        {team.members.length === 0 ? <EmptyState title="No members yet">Add people so work can be assigned to the whole team.</EmptyState>
          : team.members.map((m) => (
            <div key={m.id} className="list-row" style={{ borderLeft: 0 }}>
              <Avatar name={m.name} initials={m.initials} /><div className="grow"><Link to={`/people/users/${m.id}`} className="t" style={{ color: "var(--c-text)" }}>{m.name}</Link><div className="s">{m.email}</div></div>
              {manage && <Button size="sm" variant="ghost" onClick={() => rmM.mutate(m.id)} aria-label={`Remove ${m.name}`}>Remove</Button>}
            </div>))}
      </section>
      {manage && (confirm ? <div className="row wrap card card-pad"><span className="grow">Delete the {team.name} team? People stay in the organization.</span>
        <Button onClick={() => setConfirm(false)}>Keep</Button><Button variant="danger" className="solid" onClick={() => delM.mutate()}>Delete team</Button></div>
        : <div><Button variant="danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete team</Button></div>)}
      {edit && <TeamModal team={team} onClose={() => setEdit(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- work settings (rates, visibility)
type WorkSettingsT = { hourly_rate_cents: number | null; default_hourly_rate_cents: number | null; rates_visible: boolean; wo_visibility: "all" | "limited" };

function WorkSettings({ userId, manage, self }: { userId: string; manage: boolean; self: boolean }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const ws = useQuery({ queryKey: ["work-settings", userId], queryFn: () => api<WorkSettingsT>(`/users/${userId}/work-settings`) });
  const save = useMutation({
    mutationFn: (b: Partial<WorkSettingsT>) => api<WorkSettingsT>(`/users/${userId}/work-settings`, { method: "PATCH", body: b }),
    onSuccess: (x) => { qc.setQueryData(["work-settings", userId], x); toast("Saved"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!ws.data || (!manage && !ws.data.rates_visible && !self)) return null;
  const w = ws.data;
  const cur = session.org?.currency ?? "USD";
  return (
    <section className="card">
      <div className="card-head"><h2>Work orders</h2></div>
      <div className="card-body form-grid">
        {w.rates_visible && <Field label={`Hourly rate (${cur})`} hint={`Leave empty to use the default (${((w.default_hourly_rate_cents ?? 0) / 100).toFixed(2)}).`}>{(id) => (
          <Input id={id} type="number" min={0} step="0.01" disabled={!manage} key={String(w.hourly_rate_cents)} defaultValue={w.hourly_rate_cents === null ? "" : w.hourly_rate_cents / 100}
            onBlur={(e) => { const v = e.target.value === "" ? null : Math.round(Number(e.target.value) * 100); if (v !== w.hourly_rate_cents) save.mutate({ hourly_rate_cents: v }); }} />)}</Field>}
        <Field label="Work order visibility" hint="Limited: sees only work they created or that's assigned to them or their teams.">{(id) => (
          <Select id={id} value={w.wo_visibility} disabled={!manage} onChange={(e) => save.mutate({ wo_visibility: e.target.value as "all" | "limited" })}>
            <option value="all">All work orders</option><option value="limited">Limited</option></Select>)}</Field>
      </div>
    </section>
  );
}
