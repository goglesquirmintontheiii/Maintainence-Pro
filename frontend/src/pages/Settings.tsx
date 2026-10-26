import { useMemo, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RotateCw } from "lucide-react";
import { api, ApiError, getCsrf, type AuditEvent, type Email, type Job, type Member, type Org, type Session } from "../lib/api";
import { useSession } from "../lib/session";
import { dateTime, show, timeAgo } from "../lib/format";
import { useToast } from "../components/Toast";
import { Avatar, AvatarStack, Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, PriorityBadge, Select, StatusPill } from "../components/ui";
import { SETTINGS_NAV } from "../shell/nav";
import { LogoMark } from "../components/Logo";
import { PhotoPickerButton } from "../components/AvatarCropper";
import { UserId } from "./People";
import { DeleteAccount } from "../pwa/DeleteAccount"; // r321 (0.6.0)

export function SettingsLayout() {
  const { can } = useSession();
  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings</h1><p className="sub">Organization details, the audit trail and what MPro is doing in the background.</p></div></div>
      <div className="tabs tabs-scroll" role="tablist">
        {SETTINGS_NAV.filter((s) => !s.perm || can(s.perm)).map((s) => { const Icon = s.icon; return (
          <NavLink key={s.path} to={s.path} className={({ isActive }) => "tab" + (isActive ? " active" : "")}><Icon size={15} />{s.label}</NavLink>); })}
      </div>
      <Outlet />
    </div>
  );
}

export function SettingsIndex() { return <Navigate to="/settings/organization" replace />; }

const TZS: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { return ["UTC"]; } })();
const CURRENCIES = ["USD", "CAD", "MXN", "EUR", "GBP", "AUD", "NZD", "BRL", "INR", "JPY", "CNY", "ZAR", "CHF", "SEK"];

export function OrganizationSettings() {
  const { session, can, refresh } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<Org>("/org") });
  const [f, setF] = useState<Partial<Org>>({});
  const v = { ...org.data, ...f } as Org;
  const save = useMutation({
    mutationFn: () => api<Org>("/org", { method: "PATCH", body: f }),
    onSuccess: (o) => { qc.setQueryData(["org"], o); setF({}); void refresh(); toast("Organization saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!org.data) return <ListSkeleton rows={4} />;
  const ro = !can("org.manage");
  return (
    <section className="card">
      <div className="card-head"><h2>Organization</h2>{ro && <Pill>Only administrators can change these</Pill>}</div>
      <div className="card-body form-grid">
        <Field label="Name" className="full">{(id) => <Input id={id} value={v.name} disabled={ro} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Time zone" hint="Due dates and schedules use this time zone.">{(id) => <Select id={id} value={v.timezone} disabled={ro} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TZS.map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
        <Field label="Currency">{(id) => <Select id={id} value={v.currency} disabled={ro} onChange={(e) => setF({ ...f, currency: e.target.value })}>{[...new Set([v.currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
        <Field label="Units">{(id) => <Select id={id} value={v.units} disabled={ro} onChange={(e) => setF({ ...f, units: e.target.value })}><option value="imperial">Imperial (ft, lb, °F)</option><option value="metric">Metric (m, kg, °C)</option></Select>}</Field>
        <Field label="Language and number format">{(id) => <Select id={id} value={v.locale} disabled={ro} onChange={(e) => setF({ ...f, locale: e.target.value })}>{["en-US", "en-GB", "en-CA", "es-MX", "es-ES", "fr-CA", "fr-FR", "de-DE", "pt-BR"].map((l) => <option key={l}>{l}</option>)}</Select>}</Field>
      </div>
      <div className="card-body row" style={{ borderTop: "1px solid var(--c-border-soft)", justifyContent: "space-between" }}>
        <span className="small muted">Edition: {session.edition === "cloud" ? "MPro Cloud" : "Self-hosted"} · Plan: {session.entitlements?.plan} · Region: {org.data.home_region}</span>
        {!ro && <div className="row"><Button disabled={!Object.keys(f).length} onClick={() => setF({})}>Discard</Button><Button variant="primary" disabled={!Object.keys(f).length || save.isPending} onClick={() => save.mutate()}>Save changes</Button></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- audit log
function fmtVal(v: unknown) { return v === null || v === undefined || v === "" ? "empty" : String(v); }

export function AuditLog() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const entity = params.get("entity_type") ?? "";
  const entityId = params.get("entity_id") ?? "";
  const from = params.get("from") ?? "";
  const qs = new URLSearchParams({ q: params.get("q") ?? "", entity_type: entity, entity_id: entityId, from, limit: "50" });
  const data = useInfiniteQuery({
    queryKey: ["audit", qs.toString()],
    queryFn: ({ pageParam }) => api<{ items: AuditEvent[]; next_cursor: string | null; entity_types: string[] }>(`/audit?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: "", getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = data.data?.pages.flatMap((p) => p.items) ?? [];
  const types = data.data?.pages[0]?.entity_types ?? [];
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };
  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div><h2>Audit log</h2><div className="small muted">Every change in this organization: who, what, when and the old and new values.</div></div>
        <a className="btn" href={`/api/v1/audit/export.csv?${qs}`}><Download size={15} />Export CSV</a>
      </div>
      <div className="card-body row wrap" style={{ borderBottom: "1px solid var(--c-border-soft)" }}>
        <form className="grow" onSubmit={(e) => { e.preventDefault(); set("q", q); }} style={{ minWidth: 200 }}>
          <Input placeholder="Search people, records or actions (press Enter)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the audit log" /></form>
        <Select value={entity} onChange={(e) => set("entity_type", e.target.value)} style={{ width: 170 }} aria-label="Record type">
          <option value="">All record types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
        <Input type="date" value={from.slice(0, 10)} onChange={(e) => set("from", e.target.value)} style={{ width: 160 }} aria-label="From date" />
        {entityId && <Button size="sm" onClick={() => set("entity_id", "")}>Showing one record · Clear</Button>}
      </div>
      {data.isLoading ? <ListSkeleton /> : rows.length === 0 ? <EmptyState title="No matching changes">Try a wider search or another record type.</EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Record</th><th>Changes</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="tnum" title={dateTime(r.created_at)} style={{ whiteSpace: "nowrap" }}>{timeAgo(r.created_at)}<div className="small faint">{dateTime(r.created_at)}</div></td>
              <td><div className="row"><Avatar name={r.actor_label} size="sm" />{r.actor_label}</div></td>
              <td>{r.summary}<div className="small faint mono">{r.type}</div></td>
              <td>{r.entity_label}<div className="small faint">{r.entity_type}</div></td>
              <td className="small">{Object.entries(r.changes).length ? Object.entries(r.changes).map(([k, [a, b]]) => (
                <div key={k}><b>{k}</b>: <span className="faint" style={{ textDecoration: "line-through" }}>{fmtVal(a)}</span> → {fmtVal(b)}</div>)) : <span className="faint">—</span>}</td>
            </tr>))}</tbody>
        </table></div>)}
      {data.hasNextPage && <div className="card-body"><Button onClick={() => data.fetchNextPage()} disabled={data.isFetchingNextPage}>{data.isFetchingNextPage ? "Loading…" : "Load older changes"}</Button></div>}
    </section>
  );
}

// ---------------------------------------------------------------- jobs
const JOB_TONE: Record<string, "info" | "success" | "warning" | "danger" | "neutral"> = { queued: "info", running: "warning", done: "success", failed: "danger" };

export function Jobs() {
  const [status, setStatus] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const jobs = useQuery({ queryKey: ["jobs", status], queryFn: () => api<{ items: Job[]; counts: Record<string, number> }>(`/jobs?status=${status}`), refetchInterval: 5000 });
  const retry = useMutation({ mutationFn: (id: string) => api(`/jobs/${id}/retry`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["jobs"] }); toast("Queued to run again"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const c = jobs.data?.counts ?? {};
  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div><h2>Background jobs</h2><div className="small muted">Emails, event processing and clean-up run here. Failed jobs retry automatically with growing waits.</div></div>
        <div className="row wrap">{["", "queued", "running", "done", "failed"].map((s) => (
          <Button key={s || "all"} size="sm" variant={status === s ? "primary" : "default"} onClick={() => setStatus(s)}>{s ? `${s[0].toUpperCase()}${s.slice(1)} ${c[s] ?? 0}` : "All"}</Button>))}</div>
      </div>
      {jobs.isLoading ? <ListSkeleton /> : !jobs.data?.items.length ? <EmptyState title="No jobs here">Nothing has run with this status yet.</EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Created</th><th>Finished</th><th /></tr></thead>
          <tbody>{jobs.data.items.map((j) => (
            <tr key={j.id}><td className="mono">{j.kind}{j.last_error && <div className="small" style={{ color: "var(--c-danger)", whiteSpace: "pre-wrap", maxWidth: 520 }}>{j.last_error.trim().split("\n").slice(-1)[0]}</div>}</td>
              <td><Pill tone={JOB_TONE[j.status]}>{j.status}</Pill></td><td className="tnum">{j.attempts} / {j.max_attempts}</td>
              <td title={dateTime(j.created_at)}>{timeAgo(j.created_at)}</td><td>{j.finished_at ? timeAgo(j.finished_at) : "—"}</td>
              <td>{j.status === "failed" && can("jobs.manage") && <Button size="sm" onClick={() => retry.mutate(j.id)}><RotateCw size={14} />Retry</Button>}</td></tr>))}
          </tbody></table></div>)}
    </section>
  );
}

// ---------------------------------------------------------------- email outbox
export function EmailOutbox() {
  const mails = useQuery({ queryKey: ["outbox"], queryFn: () => api<{ items: Email[]; smtp_configured: boolean }>("/outbox"), refetchInterval: 10000 });
  const [open, setOpen] = useState<Email | null>(null);
  return (
    <section className="card">
      <div className="card-head"><div><h2>Email outbox</h2><div className="small muted">Every email MPro sends: invitations, password resets and, later, notifications.</div></div></div>
      {mails.data && !mails.data.smtp_configured && <div className="card-body" style={{ paddingBottom: 0 }}><div className="banner warning">
        <div><b>No email server is set up</b>, so messages stay here instead of being delivered. You can open an invitation or reset email below and share its link by hand. Set <span className="mono">MPRO_SMTP_HOST</span> and related settings to send real email.</div></div></div>}
      {mails.isLoading ? <ListSkeleton /> : !mails.data?.items.length ? <EmptyState title="No emails yet">Invite someone or request a password reset to see one here.</EmptyState> : (
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="table">
          <thead><tr><th>To</th><th>Subject</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{mails.data.items.map((m) => (
            <tr key={m.id} style={{ cursor: "pointer" }} onClick={() => setOpen(m)}><td>{m.to}</td><td><button className="linkbtn" style={{ textAlign: "left" }}>{m.subject}</button></td>
              <td><Pill tone={m.status === "sent" ? "success" : m.status === "failed" ? "danger" : m.status === "queued" ? "info" : "neutral"}>{m.status === "not_configured" ? "Not sent (no email server)" : m.status}</Pill></td>
              <td>{timeAgo(m.created_at)}</td></tr>))}</tbody></table></div>)}
      {open && <Modal title={open.subject} onClose={() => setOpen(null)} width={640}>
        <div className="small muted">To {open.to} · {dateTime(open.created_at)}</div>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit", background: "var(--c-sunken)", padding: 16, borderRadius: 8, overflowWrap: "anywhere" }}>{open.body}</pre>
      </Modal>}
    </section>
  );
}

// ---------------------------------------------------------------- design system gallery
const SWATCHES = ["--c-primary", "--c-text", "--c-text-2", "--c-border", "--c-sunken", "--c-sidebar", "--c-open", "--c-hold", "--c-progress", "--c-done", "--c-high", "--c-medium", "--c-low", "--c-success", "--c-warning", "--c-danger"];

export function DesignSystem() {
  const { toast } = useToast();
  const [modal, setModal] = useState(false);
  const people = useMemo(() => ["Avery Kim", "Sam Patel", "Riley Chen", "Morgan Diaz", "Casey Nguyen"].map((n) => ({ name: n })), []);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted">The MPro component library, built from design tokens so it works in light and dark themes. Use it to check styling when building new modules.</p>
      <div className="gallery">
        <section className="card card-pad stack"><h3>Brand</h3><div className="row"><LogoMark size={48} /><span style={{ fontWeight: 700, fontSize: 18 }}>Maintenance <span style={{ color: "var(--c-primary)" }}>Pro</span></span></div></section>
        <section className="card card-pad stack"><h3>Buttons</h3><div className="row wrap"><Button variant="primary">Primary</Button><Button>Default</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button><Button size="sm">Small</Button><Button disabled>Disabled</Button></div></section>
        <section className="card card-pad stack"><h3>Work order status</h3><div className="row wrap"><StatusPill status="open" /><StatusPill status="on_hold" /><StatusPill status="in_progress" /><StatusPill status="done" /></div></section>
        <section className="card card-pad stack"><h3>Priority</h3><div className="row wrap" style={{ gap: 16 }}><PriorityBadge priority="high" /><PriorityBadge priority="medium" /><PriorityBadge priority="low" /><PriorityBadge priority="none" /></div></section>
        <section className="card card-pad stack"><h3>Avatars</h3><div className="row wrap"><Avatar name="Alex Morgan" size="lg" /><Avatar name="Jordan Reyes" /><Avatar name="Sam Patel" size="sm" /><AvatarStack people={people} max={3} /></div></section>
        <section className="card card-pad stack"><h3>Pills and chips</h3><div className="row wrap"><Pill tone="info">Info</Pill><Pill tone="success">Success</Pill><Pill tone="warning">Warning</Pill><Pill tone="danger">Danger</Pill><span className="chip"><span className="sw" style={{ background: "#0a7f96" }} />HVAC</span><span className="kbd">Ctrl K</span></div></section>
        <section className="card card-pad stack"><h3>Fields</h3><Field label="Asset name" hint="Hint text">{(id) => <Input id={id} placeholder="Conveyor C-3" />}</Field><Field label="Priority" error="Pick a priority">{(id) => <Select id={id}><option>High</option></Select>}</Field></section>
        <section className="card card-pad stack"><h3>Feedback</h3><div className="row wrap"><Button onClick={() => toast("Work order saved", { action: { label: "Undo", run: () => toast("Undone") } })}>Show toast</Button><Button onClick={() => setModal(true)}>Open modal</Button></div>
          <div className="banner info">Information banner</div></section>
        <section className="card card-pad stack"><h3>Loading</h3><ListSkeleton rows={2} /></section>
        <section className="card card-pad stack"><h3>Colour tokens</h3><div className="gallery" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>{SWATCHES.map((s) => (
          <div key={s}><div className="swatch" style={{ background: `var(${s})` }} /><div className="mono" style={{ fontSize: 10 }}>{s.slice(4)}</div></div>))}</div></section>
      </div>
      <EmptyState title="Empty state" icon={<LogoMark size={28} />} action={<Button variant="primary">Primary action</Button>}>Explain what will appear here and how to add the first one.</EmptyState>
      {modal && <Modal title="Example modal" onClose={() => setModal(false)} footer={<Button variant="primary" onClick={() => setModal(false)}>Done</Button>}>Modals trap focus and close with Escape.</Modal>}
      <p className="small faint">{show(null)} values show as an em dash.</p>
    </div>
  );
}

// ---------------------------------------------------------------- profile
export function Profile() {
  const { session, set, can } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState(session.user!.name);
  const me = useQuery({ queryKey: ["users", session.user!.id], queryFn: () => api<Member>(`/users/${session.user!.id}`) });
  const [title, setTitle] = useState<string | null>(null);
  const jobTitle = title ?? me.data?.job_title ?? "";
  const canTitle = can("profile.job_title") || session.role === "owner" || session.role === "admin";
  const saveTitle = useMutation({ mutationFn: () => api(`/users/${session.user!.id}`, { method: "PATCH", body: { job_title: jobTitle } }),
    onSuccess: async () => { await me.refetch(); setTitle(null); toast("Job title saved"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const photo = useMutation({
    mutationFn: async (blob: Blob | null) => {
      if (!blob) return api<Session>("/auth/avatar", { method: "DELETE" });
      const fd = new FormData(); fd.append("file", blob, "photo.jpg");
      const r = await fetch("/api/v1/auth/avatar", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": getCsrf() } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, (data as { message?: string }).message || "The photo couldn't be saved.");
      return data as Session;
    },
    onSuccess: (s, blob) => { set(s); toast(blob ? "Photo saved" : "Photo removed"); },
    onError: (e) => toast((e as Error).message, { kind: "error" }),
  });
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const [err, setErr] = useState("");
  const saveName = useMutation({ mutationFn: () => api(`/users/${session.user!.id}`, { method: "PATCH", body: { name } }),
    onSuccess: async () => { set(await api("/auth/session")); toast("Name saved"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const savePw = useMutation({ mutationFn: () => api("/auth/password/change", { method: "POST", body: { current: pw.current, new: pw.next } }),
    onSuccess: () => { setPw({ current: "", next: "", again: "" }); setErr(""); toast("Password changed"); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><div className="row" style={{ gap: 16 }}><Avatar name={session.user!.name} initials={session.user!.initials} size="lg" src={session.user!.avatar_url} />
        <div><h1>{session.user!.name}</h1><p className="sub">{session.user!.email} · {session.role_label}{jobTitle ? ` · ${jobTitle}` : ""}</p></div></div></div>
      <section className="card"><div className="card-head"><h2>Profile photo</h2></div>
        <div className="card-body row" style={{ gap: 16, flexWrap: "wrap" }}>
          <Avatar name={session.user!.name} initials={session.user!.initials} size="lg" src={session.user!.avatar_url} />
          <div className="stack" style={{ gap: 8 }}>
            <p className="small faint" style={{ margin: 0 }}>Shown next to your name across the app. JPG, PNG, WebP or GIF, up to 10 MB.</p>
            <div className="row"><PhotoPickerButton busy={photo.isPending} label={session.user!.avatar_url ? "Change photo" : "Add photo"} onBlob={(b) => photo.mutate(b)} />
              {session.user!.avatar_url && <Button size="sm" variant="ghost" disabled={photo.isPending} onClick={() => photo.mutate(null)}>Remove photo</Button>}</div>
          </div></div></section>
      <section className="card"><div className="card-head"><h2>Your details</h2></div>
        <div className="card-body form-grid"><Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Email" hint="Ask an administrator to change your email.">{(id) => <Input id={id} value={session.user!.email} disabled />}</Field>
          <Field label="Job title" hint={canTitle ? undefined : "Ask an administrator to change your job title."}>{(id) => <Input id={id} value={jobTitle} maxLength={120} disabled={!canTitle} placeholder="e.g. Maintenance lead" onChange={(e) => setTitle(e.target.value)} />}</Field>
          <div className="field"><span className="label">User ID</span><UserId id={session.user!.id} /><span className="hint">Support and the server's sysadmin commands use this to find your account.</span></div></div>
        <div className="card-body" style={{ paddingTop: 0 }}><div className="row"><Button variant="primary" disabled={!name.trim() || name === session.user!.name} onClick={() => saveName.mutate()}>Save name</Button>
          {canTitle && <Button disabled={title === null || title === (me.data?.job_title ?? "") || saveTitle.isPending} onClick={() => saveTitle.mutate()}>Save job title</Button>}</div></div></section>
      <section className="card"><div className="card-head"><h2>Change password</h2></div>
        <form className="card-body form-grid" onSubmit={(e) => { e.preventDefault(); if (pw.next !== pw.again) { setErr("The new passwords don't match."); return; } savePw.mutate(); }}>
          <Field label="Current password" className="full">{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
          <Field label="New password" hint="At least 8 characters.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
          <Field label="Repeat new password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} />}</Field>
          {err && <div className="banner warning full" role="alert">{err}</div>}
          <div className="full"><Button type="submit" variant="primary" disabled={!pw.current || pw.next.length < 8}>Change password</Button></div>
        </form></section>
      <DeleteAccount />
      <p className="small faint">Theme: choose it from the account menu in the top right. <Link to="/settings/design-system">See the design system</Link>.</p>
    </div>
  );
}
