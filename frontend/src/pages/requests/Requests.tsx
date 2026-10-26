// Requests (0.6.0, MP-047/MP-048, r273–r300): the list of work requests with a detail panel, like Work Orders.
// Approvers turn a request into a work order (optionally from a template) or decline it with a reason; requesters
// follow their own requests and see the work order's number and status. Guests (r236) also get their sites' assets
// and their customer's quotes here.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ClipboardList, Copy, Globe, Inbox, MapPin, MoreHorizontal, Pencil, Plus, Search, Send, Users, X } from "lucide-react";
import { api, ApiError, type Template } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLiveInvalidate } from "../../lib/live";
import { dateTime, timeAgo } from "../../lib/format";
import { fromLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { AssigneePicker } from "../../components/pickers";
import { ClearableDate } from "../../components/assetPickers";
import { RequestForm } from "./RequestForm";
import { GuestHome } from "./GuestHome";
import { REQUEST_STATUS, REQUEST_TONE, useBadge, useRequestForm, type RequestStatus, type WorkRequest } from "./types";
import "./requests.css";

const TABS: [string, string][] = [["open", "Pending"], ["approved", "Approved"], ["declined", "Declined"], ["done,canceled,skipped", "Closed"], ["", "All"]];

export function RequestsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const form = useRequestForm();
  const isGuest = !!form.data?.guest;
  const approver = can("requests.approve");
  const [tab, setTab] = useState(() => params.get("status") ?? (approver ? "open" : ""));
  const [team, setTeam] = useState(false);
  const [view, setView] = useState<"requests" | "sites">("requests");
  const creating = id === "new";
  const prefill = { asset_id: params.get("asset_id"), location_id: params.get("location_id") };
  const qs = `status=${encodeURIComponent(tab)}&q=${encodeURIComponent(q)}${team ? "&team=mine" : ""}&per_page=60`;
  const list = useQuery({ queryKey: ["requests", "list", qs], queryFn: () => api<{ items: WorkRequest[]; total: number }>(`/requests?${qs}`), placeholderData: (p) => p });
  const detailId = id && id !== "new" ? id : undefined;
  useEffect(() => { if (params.get("status")) { const p = new URLSearchParams(params); p.delete("status"); setParams(p, { replace: true }); } }, [params, setParams]);
  return (
    <div className="wo-page">
      <div className={"split wo-split" + (detailId ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1>Requests</h1>
              <div className="row">
                {can("requests.portals") && <Link className="btn ghost icon" to="/settings/requests" title="Request settings and portals" aria-label="Request settings"><Globe size={17} /></Link>}
                {can("requests.create") && <Button variant="primary" onClick={() => nav("/requests/new")} aria-label="New request"><Plus size={16} />New</Button>}
              </div>
            </div>
            {isGuest && <div className="seg" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "requests"} className={"seg-btn" + (view === "requests" ? " on" : "")} onClick={() => setView("requests")}>My requests</button>
              <button type="button" role="tab" aria-selected={view === "sites"} className={"seg-btn" + (view === "sites" ? " on" : "")} onClick={() => setView("sites")}>My sites</button>
            </div>}
            {view === "requests" && <>
              <div className="search-in"><Search size={15} className="faint" />
                <Input placeholder="Search keyword, request # or work order #" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search requests" /></div>
              <div className="row wrap" style={{ gap: 6 }}>
                <div className="seg req-tabs" role="tablist" aria-label="Status">{TABS.map(([k, l]) => (
                  <button key={l} type="button" role="tab" aria-selected={tab === k} className={"seg-btn" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}</button>))}</div>
                {approver && <button type="button" className={"chip req-chip" + (team ? " on" : "")} aria-pressed={team} onClick={() => setTeam((t) => !t)}><Users size={13} />My teams</button>}
              </div>
              {list.data && <div className="small faint">{list.data.total} request{list.data.total === 1 ? "" : "s"}</div>}
            </>}
          </div>
          {view === "sites" ? <GuestHome /> : (
            <div className="list" aria-label="Requests">
              {list.isLoading ? <ListSkeleton /> : !list.data?.items.length
                ? <EmptyState icon={<Inbox size={28} />} title={q ? "No requests match" : "No requests here"}>
                    {q ? "Try another search." : can("requests.create") ? "Report a problem with New. Approvers turn requests into work orders." : "Requests people send show here."}</EmptyState>
                : list.data.items.map((r) => <RequestRow key={r.id} r={r} active={r.id === detailId} />)}
            </div>)}
        </div>
        <div className="split-detail">
          {detailId ? <RequestDetail key={detailId} id={detailId} />
            : <EmptyState icon={<Inbox size={28} />} title="Select a request">Pick one to see what was reported{approver ? ", then approve or decline it" : " and where it stands"}.</EmptyState>}
        </div>
      </div>
      {creating && <RequestForm prefill={prefill} onClose={() => nav("/requests")} onSaved={(r) => nav(`/requests/${r.id}`)} />}
    </div>
  );
}

function RequestRow({ r, active }: { r: WorkRequest; active: boolean }) {
  const who = r.created_by?.name ?? r.submitter?.name ?? "";
  return (
    <Link to={`/requests/${r.id}`} className={"list-row req-row" + (active ? " active" : "")}>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="t">{r.new && <span className="req-dot" aria-label="New" />}{r.title}</span>
        <span className="s">#{r.number}{who ? ` · ${who}` : ""}{r.location ? ` · ${r.location.name}` : ""}{r.asset ? ` · ${r.asset.name}` : ""} · {timeAgo(r.created_at)}</span>
      </span>
      <span className="req-row-side">
        <Pill tone={REQUEST_TONE[r.status]}>{REQUEST_STATUS[r.status]}</Pill>
        {r.priority !== "none" && <PriorityBadge priority={r.priority} />}
      </span>
    </Link>
  );
}

function RequestDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["requests", "one", id], queryFn: () => api<WorkRequest>(`/requests/${id}`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useSession();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [comment, setComment] = useState("");
  useBadge();
  useEffect(() => { if (q.data) qc.invalidateQueries({ queryKey: ["requests", "badge"] }); }, [q.data, qc]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["requests"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const act = useMutation({ mutationFn: (path: string) => api<WorkRequest>(`/requests/${id}/${path}`, { method: "POST" }), onError: err,
    onSuccess: (r, path) => { refresh(); if (path === "duplicate") { toast(`Request #${r.number} created`); nav(`/requests/${r.id}`); } else toast("Request canceled"); } });
  const send = useMutation({ mutationFn: () => api(`/requests/${id}/comments`, { method: "POST", body: { body: comment } }), onError: err,
    onSuccess: () => { setComment(""); refresh(); } });
  if (q.isError) return <EmptyState icon={<Inbox size={28} />} title="Request not found">It may have been removed, or it isn't yours to see.</EmptyState>;
  const r = q.data;
  if (!r) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const author = r.created_by ?? (r.submitter ? { name: r.submitter.name } : null);
  const canDup = can("requests.create") && (r.status === "pending" || r.status === "declined");
  const canCancel = r.status === "pending" && (r.can_decide || r.can_edit);
  return (
    <div className="detail">
      <Link to="/requests" className="row small mobile-only"><ArrowLeft size={14} />All requests</Link>
      <div className="wo-head">
        <div className="grow"><div className="small muted">Request #{r.number}{r.source === "portal" ? " · from a request portal" : r.source === "qr" ? " · from a QR code" : ""}</div>
          <h1 className="wo-title">{r.title}</h1>
          <div className="row wrap" style={{ gap: 6 }}><Pill tone={REQUEST_TONE[r.status as RequestStatus]}>{REQUEST_STATUS[r.status as RequestStatus]}</Pill>
            {r.priority !== "none" && <PriorityBadge priority={r.priority} />}</div></div>
        <div className="row">
          {r.can_edit && <Button icon aria-label="Edit request" title="Edit" onClick={() => setEditing(true)}><Pencil size={15} /></Button>}
          {(canDup || canCancel) && <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={200}>
            {(close) => <>
              {canDup && <button className="menu-item" onClick={() => { close(); act.mutate("duplicate"); }}><Copy size={15} />Duplicate</button>}
              {canCancel && <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); act.mutate("cancel"); }}><X size={15} />Cancel request</button>}
            </>}
          </Dropdown>}
        </div>
      </div>
      {r.can_decide && <div className="req-decide card card-pad">
        <span className="grow">Turn this request into a work order, or decline it with a reason the requester will see.</span>
        <Button onClick={() => setDeclining(true)}><X size={15} />Decline</Button>
        <Button variant="primary" onClick={() => setApproving(true)}><Check size={15} />Approve</Button>
      </div>}
      {r.status === "declined" && r.decline_reason && <div className="banner warning"><b>Declined{r.decided_by ? ` by ${r.decided_by.name}` : ""}:</b> {r.decline_reason}</div>}
      {r.work_order && <div className="card card-pad row req-wo">
        <ClipboardList size={18} className="faint" />
        <span className="grow">Work order <b>#{r.work_order.number}</b>{r.work_order.status === "deleted" ? " was deleted" : ""}</span>
        {r.work_order.status !== "deleted" && <StatusPill status={r.work_order.status as "open"} />}
        {r.work_order.id && <Link className="btn btn-sm" to={`/work-orders/${r.work_order.id}`}>Open</Link>}
      </div>}
      {r.description && <section className="card card-pad prewrap">{r.description}</section>}
      {r.files.length > 0 && <div className="req-photos">{r.files.map((f) => (
        <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" title={f.name}>
          {f.thumb_url ? <img src={f.thumb_url} alt={f.name} /> : <span className="chip">{f.name}</span>}</a>))}</div>}
      <dl className="meta-grid card card-pad">
        <div><dt>Requested by</dt><dd>{author ? <span className="row" style={{ gap: 6 }}><Avatar name={author.name} size="sm" />{author.name}</span> : "—"}
          {r.submitter?.email && <span className="small faint" style={{ display: "block" }}>{r.submitter.email}{r.submitter.phone ? ` · ${r.submitter.phone}` : ""}</span>}</dd></div>
        <div><dt>Submitted</dt><dd>{dateTime(r.created_at)}</dd></div>
        <div><dt>Location</dt><dd>{r.location ? <span className="row" style={{ gap: 4 }}><MapPin size={14} className="faint" />{r.location.name}</span> : "—"}</dd></div>
        <div><dt>Asset</dt><dd>{r.asset ? r.asset.name : "—"}{r.asset && r.asset_status && <span className="small faint">{r.asset_status === "offline" ? " · reported down" : " · reported running"}</span>}</dd></div>
        <div><dt>Assign to</dt><dd>{r.team ? r.team.name : r.route_other ? "Other (administrators)" : "—"}</dd></div>
        {r.customer && <div><dt>Customer</dt><dd><Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link></dd></div>}
        {r.portal && <div><dt>Portal</dt><dd>{r.portal.name}</dd></div>}
        {r.decided_at && <div><dt>{r.status === "declined" ? "Declined" : "Approved"}</dt><dd>{dateTime(r.decided_at)}{r.decided_by ? ` by ${r.decided_by.name}` : ""}</dd></div>}
      </dl>
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Comments</h3></div>
        <div className="card-body stack">
          {(r.comments ?? []).length === 0 && <span className="small faint">No comments yet. Ask a question or add details.</span>}
          {(r.comments ?? []).map((c) => <div key={c.id} className="req-comment"><b>{c.author?.name ?? c.external_name ?? "Someone"}</b>
            <span className="small faint"> · {timeAgo(c.created_at)}</span><div className="prewrap">{c.body}</div></div>)}
          <div className="row" style={{ alignItems: "flex-end" }}>
            <textarea className="textarea grow" rows={2} placeholder="Write a comment…" value={comment} maxLength={10000} aria-label="Comment"
              onChange={(e) => setComment(e.target.value)} />
            <Button variant="primary" disabled={!comment.trim() || send.isPending} onClick={() => send.mutate()} aria-label="Send comment"><Send size={15} /></Button>
          </div>
        </div>
      </section>
      {editing && <RequestForm edit={r} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {approving && <ApproveDialog r={r} onClose={() => setApproving(false)} onDone={(wo) => { setApproving(false); refresh(); toast(`Work order #${wo.number} created`); }} />}
      {declining && <DeclineDialog r={r} onClose={() => setDeclining(false)} onDone={() => { setDeclining(false); refresh(); toast("Request declined"); }} />}
    </div>
  );
}

function ApproveDialog({ r, onClose, onDone }: { r: WorkRequest; onClose: () => void; onDone: (wo: { id: string; number: number }) => void }) {
  const templates = useQuery({ queryKey: ["wo-templates"], queryFn: () => api<{ items: Template[] }>("/work-order-templates") });
  const settings = useQuery({ queryKey: ["request-settings"], queryFn: () => api<{ default_template_id: string }>("/request-settings"), retry: false });
  const opts = useWOOptions();
  const [tpl, setTpl] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<string[]>(r.team ? [`team:${r.team.id}`] : []);
  const [due, setDue] = useState("");
  const [err, setErr] = useState("");
  const template = tpl ?? settings.data?.default_template_id ?? "";
  const go = useMutation({
    mutationFn: () => api<{ work_order: { id: string; number: number } }>(`/requests/${r.id}/approve`, { method: "POST", body: {
      ...(template ? { template_id: template } : {}), ...(assignees.length ? { assignees } : {}), ...(due ? { due_at: fromLocalInput(due) } : {}),
    } }),
    onSuccess: (d) => onDone(d.work_order), onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={`Approve request #${r.number}`} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={go.isPending} onClick={() => go.mutate()}><Check size={15} />Create work order</Button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>The request's title, description, priority, location, asset and photos go to the new work order. The requester sees its number and status.</p>
      <Field label="Template (optional)">{(id) => <Select id={id} value={template} onChange={(e) => setTpl(e.target.value)}>
        <option value="">No template</option>{templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
      <Field label="Assign to">{(id) => <AssigneePicker id={id} options={opts.data} value={assignees} onChange={setAssignees} />}</Field>
      <Field label="Due date">{(id) => <ClearableDate id={id} label="due date" type="datetime-local" value={due} onChange={setDue} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function DeclineDialog({ r, onClose, onDone }: { r: WorkRequest; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const go = useMutation({ mutationFn: () => api(`/requests/${r.id}/decline`, { method: "POST", body: { reason } }), onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={`Decline request #${r.number}`} onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!reason.trim() || go.isPending} onClick={() => go.mutate()}>Decline</Button></>}>
      <Field label="Why? *" hint="The requester sees this.">{(id) => <textarea id={id} className="textarea" rows={3} maxLength={2000} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

/** The red count next to Requests in the sidebar (r299). */
export function RequestsBadge() {
  const { can } = useSession();
  // new and changed requests arrive live for people who see everyone's requests (the sidebar keeps this mounted)
  useLiveInvalidate(can("requests.view_all") ? "requests" : null, [["requests"]]);
  const b = useBadge();
  const n = b.data?.new ?? 0;
  return n > 0 ? <span className="nav-badge" aria-label={`${n} new requests`}>{n > 99 ? "99+" : n}</span> : null;
}

