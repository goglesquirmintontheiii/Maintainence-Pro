// Work-order detail (MaintainX layout): header and status → assignees/meta → description and photos →
// time and costs → sub-work orders and links → activity feed with the comment box at the bottom.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Copy, CopyPlus, Download, ExternalLink, FileText, ImagePlus, Link2, ListTree,
  Mail, MapPin, MoreHorizontal, Paperclip, Pause, Pencil, Play, Plus, Printer, RotateCcw, Send, SmilePlus, Square, Timer, Trash2, Undo2, X,
} from "lucide-react";
import {
  api, ApiError, upload, type ActivityItem, type AssetStatus, type AssetTask, type CommentItem, type FileItem, type MiniWO, type WODetail, type WOOptions, type WOStatus,
} from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, dateTime, timeAgo } from "../../lib/format";
import { absoluteUrl, copyText, dueLabel, fmtDuration, fmtMinutes, money, STATUS_LABEL, useWOOptions, WORK_TYPE_LABEL } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { AssigneeChips, CategoryChips, MentionBox, RichText, SignaturePad } from "../../components/pickers";
import { fromDetail, WorkOrderForm } from "./Form";
import { ASSET_STATUS_LABEL } from "../../lib/assets";
import { FileViewer } from "../../components/FileViewer";
import { ProcedureRuns } from "../procedures/Runner";
import { offerCloseSubs, RecurrenceChip, SubRollup } from "../pm/WOParts";
import { WOPartsSection } from "../parts/WOParts";
import { WorkOrderOutside } from "./WorkOrderVendors";
import { WOCustomerRow } from "../vendors/WOCustomer";

const REACTIONS = ["👍", "👀", "✅", "🎉", "❤️", "⚠️"];
const STATUS_BTNS: { id: WOStatus; label: string; icon: typeof Clock }[] = [
  { id: "open", label: "Open", icon: Square }, { id: "on_hold", label: "On Hold", icon: Pause },
  { id: "in_progress", label: "In Progress", icon: Play }, { id: "done", label: "Done", icon: CheckCircle2 },
];

export function useWorkOrder(id: string | undefined) {
  return useQuery({ queryKey: ["work-order", id], queryFn: () => api<WODetail>(`/work-orders/${id}`), enabled: !!id });
}

export function WorkOrderDetail({ id, backTo, inDrawer, onClose }: { id: string; backTo?: string; inDrawer?: boolean; onClose?: () => void }) {
  const q = useWorkOrder(id);
  const opts = useWOOptions();
  const { session, can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [newSub, setNewSub] = useState(false);
  const [copyInit, setCopyInit] = useState<ReturnType<typeof fromDetail> | null>(null);
  const [statusAsk, setStatusAsk] = useState<WOStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const tz = session.org?.timezone;

  useEffect(() => {
    // mark read happens on GET; refresh list unread dots
    if (q.data) qc.invalidateQueries({ queryKey: ["work-orders"], refetchType: "none" });
  }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const panels = document.querySelectorAll(".drawer-wrap").length;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay") || panels > (inDrawer ? 1 : 0)) return;
      if (e.key === "e" && (q.data?.you?.edit ?? can("wo.edit")) && q.data && !q.data.deleted) { e.preventDefault(); setEditing(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [can, q.data, inDrawer]);

  const refresh = (wo?: WODetail) => {
    if (wo) qc.setQueryData(["work-order", id], wo); else qc.invalidateQueries({ queryKey: ["work-order", id] });
    qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["wo-activity", id] }); qc.invalidateQueries({ queryKey: ["wo-stats"] });
    qc.invalidateQueries({ queryKey: ["wo-workload"] });
  };
  const err = (e: unknown) => {
    const ae = e as ApiError;
    if (ae.status === 409) { refresh(); toast("Someone else just changed this work order. It's been refreshed.", { kind: "error" }); }
    else toast(ae.message, { kind: "error" });
  };
  const statusM = useMutation({
    mutationFn: (b: Record<string, unknown>) => api<WODetail>(`/work-orders/${id}/status`, { method: "POST", body: { version: q.data?.version, ...b } }),
    onMutate: async (b) => { // optimistic
      const prev = qc.getQueryData<WODetail>(["work-order", id]);
      if (prev && b.status !== "done") qc.setQueryData(["work-order", id], { ...prev, status: b.status as WOStatus, sub_status: (b.sub_status as string) ?? "" });
      return { prev };
    },
    onSuccess: (wo, b, ctx) => {
      refresh(wo); setStatusAsk(null);
      if (!b.undo && ctx?.prev?.status !== "done") offerCloseSubs(wo, toast, qc); // MaintainX offers to close open sub-work orders (0.4.0)
      const from = ctx?.prev?.status;
      const fromSub = ctx?.prev?.sub_status ?? "";
      if (from && from !== wo.status && !b.undo) toast(`Marked ${STATUS_LABEL[wo.status]}`, { action: { label: "Undo", run: () => statusM.mutate({ status: from, sub_status: fromSub, version: wo.version, undo: true }) } });
      void b;
    },
    onError: (e, _b, ctx) => { if (ctx?.prev) qc.setQueryData(["work-order", id], ctx.prev); err(e); },
  });
  const del = useMutation({
    mutationFn: () => api(`/work-orders/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-orders"] }); setConfirmDelete(false); nav(backTo ?? "/work-orders"); onClose?.();
      toast(`Deleted #${q.data?.number}`, { action: { label: "Undo", run: () => { void api(`/work-orders/${id}/restore`, { method: "POST" }).then(() => { qc.invalidateQueries({ queryKey: ["work-orders"] }); nav(`/work-orders/${id}`); }); } } });
    }, onError: err,
  });
  const restore = useMutation({ mutationFn: () => api<WODetail>(`/work-orders/${id}/restore`, { method: "POST" }), onSuccess: (wo) => { refresh(wo); toast("Restored"); }, onError: err });
  const duplicate = useMutation({ mutationFn: () => api<WODetail>(`/work-orders/${id}/duplicate`, { method: "POST" }),
    onSuccess: (wo) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast(`Created #${wo.number}`); nav(`/work-orders/${wo.id}`); onClose?.(); }, onError: err });
  const approval = useMutation({ mutationFn: (b: { approve: boolean; comment?: string }) => api<WODetail>(`/work-orders/${id}/approval`, { method: "POST", body: b }),
    onSuccess: (wo) => { refresh(wo); toast(wo.approval_status === "approved" ? "Approved" : "Sent back for more work"); }, onError: err });
  const unread = useMutation({ mutationFn: () => api("/work-orders/bulk", { method: "POST", body: { ids: [id], action: "mark_unread" } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast("Marked as unread"); }, onError: err });

  if (q.isError) return <EmptyState title="Work order not found">It may have been deleted, or you don't have access to it.</EmptyState>;
  if (!q.data) return <div className="detail"><ListSkeleton rows={4} /></div>;
  const wo = q.data;
  const s = opts.data?.settings;
  const editable = (wo.you?.edit ?? can("wo.edit")) && !wo.deleted;
  const due = dueLabel(wo.due_at, wo.overdue, tz);
  const subs = wo.sub_statuses?.[wo.status] ?? [];

  const changeStatus = (st: WOStatus) => {
    if (st === wo.status) return;
    const rule = st === "on_hold" ? s?.comment_on_hold : st === "canceled" ? s?.comment_on_cancel : "none";
    const assetDown = woAssetsOf(wo).some((a) => a.status !== "online") && can("assets.status");
    const needsDialog = st === "done" ? !!(s?.require_signature || s?.completion_summary !== "none" || assetDown) : rule === "mandatory" || (rule === "optional" && st === "canceled");
    if (needsDialog) setStatusAsk(st); else statusM.mutate({ status: st });
  };

  return (
    <div className={"detail wo-detail" + (inDrawer ? " in-drawer" : "")}>
      {!inDrawer && <Link to={backTo ?? "/work-orders"} className="row small mobile-only"><ArrowLeft size={14} />All work orders</Link>}
      {wo.deleted && <div className="banner warning"><Trash2 size={18} /><div className="grow">This work order was deleted.</div>{(wo.you?.delete ?? can("wo.delete")) && <Button size="sm" onClick={() => restore.mutate()}><RotateCcw size={14} />Restore</Button>}</div>}
      <div className="wo-head">
        <div className="grow">
          <div className="row small muted" style={{ gap: 6 }}>
            <span className="mono">#{wo.number}</span>
            {wo.parent && <>· <ListTree size={13} />Sub-work order of <Link to={`/work-orders/${wo.parent.id}`}>#{wo.parent.number} {wo.parent.title}</Link></>}
          </div>
          <h1 className="wo-title">{wo.title}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <StatusPill status={wo.status} sub={wo.sub_status} /><PriorityBadge priority={wo.priority} />
            {due && <span className={"due " + due.tone}><Clock size={13} />{due.text}</span>}
            <RecurrenceChip wo={wo} editable={editable} onChange={() => refresh()} />
            {wo.approval_status === "pending" && <Pill tone="warning">Awaiting approval</Pill>}
            {wo.approval_status === "approved" && <Pill tone="success">Approved</Pill>}
            {wo.approval_status === "rejected" && wo.status !== "done" && <Pill tone="danger">Sent back</Pill>}
          </div>
        </div>
        <div className="row">
          {editable && <Button onClick={() => setEditing(true)} aria-label="Edit"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={250}>
            {(close) => <>
              {can("wo.create") && <button className="menu-item" onClick={() => { close(); setCopyInit({ ...fromDetail(wo), title: wo.title }); }}><CopyPlus size={15} />Copy to new work order</button>}
              {can("wo.create") && <button className="menu-item" onClick={() => { close(); duplicate.mutate(); }}><Copy size={15} />Duplicate now</button>}
              {can("wo.create") && !wo.parent_id && !wo.deleted && <button className="menu-item" onClick={() => { close(); setNewSub(true); }}><ListTree size={15} />Add sub-work order</button>}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { close(); setPdfOpen(true); }}><Printer size={15} />Export to PDF</button>
              <button className="menu-item" onClick={async () => { close(); toast((await copyText(absoluteUrl(`/work-orders/${wo.id}`))) ? "Link copied" : "Couldn't copy the link"); }}><Link2 size={15} />Copy link</button>
              <a className="menu-item" href={`mailto:?subject=${encodeURIComponent(`Work order #${wo.number}: ${wo.title}`)}&body=${encodeURIComponent(absoluteUrl(`/work-orders/${wo.id}`))}`} onClick={close}><Mail size={15} />Email a link</a>
              {inDrawer && <Link className="menu-item" to={`/work-orders/${wo.id}`} onClick={close}><ExternalLink size={15} />Open full page</Link>}
              <button className="menu-item" onClick={() => { close(); unread.mutate(); }}><Undo2 size={15} />Mark as unread</button>
              {editable && wo.status !== "canceled" && wo.status !== "done" && <button className="menu-item" onClick={() => { close(); setStatusAsk("canceled"); }}><Ban size={15} />Cancel work order</button>}
              {can("audit.view") && <Link className="menu-item" to={`/settings/audit-log?entity_id=${wo.id}`} onClick={close}><FileText size={15} />History in audit log</Link>}
              {(wo.you?.delete ?? can("wo.delete")) && !wo.deleted && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
          {inDrawer && onClose && <Button variant="ghost" icon aria-label="Close" onClick={onClose}><X size={18} /></Button>}
        </div>
      </div>

      {editable && wo.status !== "canceled" && (
        <div className="status-bar" role="group" aria-label="Status">
          {STATUS_BTNS.map((b) => { const Icon = b.icon; return (
            <button key={b.id} type="button" className={"status-btn " + b.id + (wo.status === b.id ? " on" : "")} aria-pressed={wo.status === b.id}
              disabled={statusM.isPending} onClick={() => changeStatus(b.id)}><Icon size={16} />{b.label}</button>); })}
        </div>)}
      {wo.status === "canceled" && <div className="banner warning"><Ban size={18} /><div className="grow"><b>Canceled.</b> {wo.cancel_reason}</div>{editable && <Button size="sm" onClick={() => statusM.mutate({ status: "open" })}>Reopen</Button>}</div>}
      {editable && subs.length > 0 && wo.status !== "canceled" && (
        <div className="row small"><span className="muted">Sub-status</span>
          <Select aria-label="Sub-status" value={wo.sub_status} style={{ width: "auto", height: 30 }} onChange={(e) => statusM.mutate({ status: wo.status, sub_status: e.target.value })}>
            <option value="">None</option>{subs.map((x) => <option key={x}>{x}</option>)}</Select></div>)}

      {wo.approval_status === "pending" && can("wo.approve") && <ApprovalBar onDecide={(approve, comment) => approval.mutate({ approve, comment })} busy={approval.isPending} />}

      <dl className="meta-grid card card-pad">
        <div className="span2"><dt>Assigned to</dt><dd><AssigneeChips items={wo.assignees} max={6} /></dd></div>
        <div><dt>Due date</dt><dd>{wo.due_at ? dateTime(wo.due_at, tz) : <span className="faint">None</span>}</dd></div>
        <div><dt>Start date</dt><dd>{wo.start_at ? dateTime(wo.start_at, tz) : <span className="faint">None</span>}</dd></div>
        <div><dt>Priority</dt><dd><PriorityBadge priority={wo.priority} /></dd></div>
        <div><dt>Work type</dt><dd>{WORK_TYPE_LABEL[wo.work_type]}</dd></div>
        <div><dt>Estimated time</dt><dd>{wo.estimated_minutes ? fmtMinutes(wo.estimated_minutes) : <span className="faint">None</span>}</dd></div>
        <div><dt>Categories</dt><dd>{wo.categories.length ? <CategoryChips items={wo.categories} /> : <span className="faint">None</span>}</dd></div>
        {woAssetsOf(wo).length > 0 && <div><dt>{woAssetsOf(wo).length > 1 ? "Assets" : "Asset"}</dt><dd className="stack" style={{ gap: 4 }}>{woAssetsOf(wo).map((a) => (
          <Link key={a.id} to={`/assets/${a.id}`} className="row" style={{ gap: 6 }}><span className={"astat-dot " + a.status} title={ASSET_STATUS_LABEL[a.status]} />{a.name}</Link>))}</dd></div>}
        {wo.location && <div><dt>Location</dt><dd><Link to={`/locations/${wo.location.id}`} className="row" style={{ gap: 6 }}><MapPin size={14} className="faint" />{wo.location.name}</Link></dd></div>}
        <WOCustomerRow woId={wo.id} canEdit={editable} />
        <div><dt>Created</dt><dd title={dateTime(wo.created_at, tz)}>{timeAgo(wo.created_at)}{wo.created_by && ` by ${wo.created_by.name}`}</dd></div>
        {wo.completed_at && <div><dt>Completed</dt><dd title={dateTime(wo.completed_at, tz)}>{timeAgo(wo.completed_at)}{wo.completed_by && ` by ${wo.completed_by.name}`}</dd></div>}
        <div className="span2"><dt>Time in status</dt><dd className="small">{(["open", "in_progress", "on_hold"] as const).filter((k) => wo.time_in_status[k] > 0).map((k) => `${STATUS_LABEL[k]} ${fmtDuration(wo.time_in_status[k])}`).join(" · ") || "—"}</dd></div>
        {(opts.data?.custom_fields ?? []).filter((f) => wo.custom[f.id] !== undefined && wo.custom[f.id] !== "").map((f) => (
          <div key={f.id}><dt>{f.name}</dt><dd>{f.type === "checkbox" ? (wo.custom[f.id] ? "Yes" : "No") : f.type === "link"
            ? <a href={String(wo.custom[f.id])} target="_blank" rel="noopener noreferrer">{String(wo.custom[f.id])}</a>
            : f.type === "datetime" ? dateTime(String(wo.custom[f.id]), tz) : f.type === "currency" ? currency(wo.custom[f.id], session.org?.currency)
            : String(wo.custom[f.id])}</dd></div>))}
      </dl>

      {wo.description && <section><h3 className="sec-h">Description</h3><p className="prewrap">{wo.description}</p></section>}

      <Attachments wo={wo} editable={editable} onChange={() => refresh()} />
      {wo.asset_tasks.length > 0 && <AssetTasks wo={wo} editable={editable && !["done", "canceled"].includes(wo.status)} onChange={(w) => refresh(w)} />}
      {can("procedures.view") && <ProcedureRuns wo={wo} onChange={() => refresh()} />}

      {(wo.completion_summary || wo.signature) && (
        <section className="card card-pad stack">
          <h3>Completion</h3>
          {wo.completion_summary && <p className="prewrap">{wo.completion_summary}</p>}
          {wo.signature && <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
            <img src={wo.signature.file.url} alt={`Signature of ${wo.signature.name}`} className="sig-img" />
            <div className="small muted">Signed by <b>{wo.signature.name}</b><br />{dateTime(wo.signature.signed_at, tz)}</div></div>}
        </section>)}

      <WOPartsSection wo={wo} />
      <WorkOrderOutside wo={wo} editable={editable} />
      <TimeAndCosts wo={wo} editable={editable} onChange={(w) => refresh(w)} />
      <SubsAndLinks wo={wo} editable={editable} onAddSub={() => setNewSub(true)} onChange={(w) => refresh(w)} />
      <SubRollup wo={wo} />
      <ActivityFeed wo={wo} options={opts.data} />

      {editing && <WorkOrderForm edit={wo} onClose={() => setEditing(false)} onSaved={(w) => refresh(w)} />}
      {newSub && <WorkOrderForm init={{ parent_id: wo.id, assignees: wo.assignees.map((a) => `${a.type}:${a.id}`), categories: wo.categories.map((c) => c.id), priority: wo.priority }}
        onClose={() => setNewSub(false)} onSaved={() => refresh()} />}
      {copyInit && <WorkOrderForm init={copyInit} onClose={() => setCopyInit(null)} />}
      {statusAsk && <StatusDialog wo={wo} target={statusAsk} options={opts.data} onClose={() => setStatusAsk(null)} busy={statusM.isPending}
        onConfirm={(b) => statusM.mutate({ status: statusAsk, ...b })} />}
      {pdfOpen && <PdfDialog wo={wo} onClose={() => setPdfOpen(false)} />}
      {confirmDelete && <Modal title={`Delete #${wo.number}?`} onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" className="solid" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>“{wo.title}” will move to deleted work orders. Administrators can restore it from the table view (Show deleted). Canceling keeps it in reports instead.</p>
      </Modal>}
    </div>
  );
}

function ApprovalBar({ onDecide, busy }: { onDecide: (approve: boolean, comment?: string) => void; busy: boolean }) {
  const [reject, setReject] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <div className="banner info" style={{ alignItems: "center" }}>
      <CheckCircle2 size={18} /><div className="grow"><b>Waiting for your approval.</b> Check the work, then approve it or send it back.</div>
      <Button size="sm" onClick={() => setReject(true)} disabled={busy}>Send back</Button>
      <Button size="sm" variant="primary" onClick={() => onDecide(true)} disabled={busy}>Approve</Button>
      {reject && <Modal title="Send back for more work" onClose={() => setReject(false)} footer={<><Button onClick={() => setReject(false)}>Cancel</Button>
        <Button variant="primary" disabled={!why.trim()} onClick={() => { onDecide(false, why); setReject(false); }}>Send back</Button></>}>
        <Field label="What still needs doing?">{(id) => <textarea id={id} className="textarea" value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />}</Field>
      </Modal>}
    </div>
  );
}

function StatusDialog({ wo, target, options, onClose, onConfirm, busy }: { wo: WODetail; target: WOStatus; options: WOOptions | undefined; onClose: () => void; onConfirm: (b: Record<string, unknown>) => void; busy: boolean }) {
  const s = options?.settings;
  const [comment, setComment] = useState("");
  const [summary, setSummary] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [signedBy, setSignedBy] = useState("");
  const [sub, setSub] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const { session, can } = useSession();
  const [keepDown, setKeepDown] = useState<Set<string>>(() => new Set());
  const { toast } = useToast();
  const done = target === "done";
  const downAssets = done && can("assets.status") ? woAssetsOf(wo).filter((a) => a.status !== "online") : [];
  const bringUp = downAssets.filter((a) => !keepDown.has(a.id));
  const rule = target === "on_hold" ? s?.comment_on_hold : target === "canceled" ? s?.comment_on_cancel : "none";
  const needSig = done && s?.require_signature && !wo.signature;
  const sumRule = done ? s?.completion_summary : "none";
  const ok = (!done || (!needSig || sig) && (sumRule !== "mandatory" || summary.trim())) && (rule !== "mandatory" || comment.trim());
  const subs = wo.sub_statuses?.[target] ?? [];
  const pick = async (fl: FileList | null) => { for (const f of Array.from(fl ?? [])) { try { const up = await upload(f); setFiles((x) => [...x, up]); } catch (e) { toast((e as ApiError).message, { kind: "error" }); } } };
  const title = done ? `Complete #${wo.number}` : target === "canceled" ? `Cancel #${wo.number}` : `${STATUS_LABEL[target]} · #${wo.number}`;
  return (
    <Modal title={title} onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Back</Button><Button variant={target === "canceled" ? "danger" : "primary"} className={target === "canceled" ? "solid" : ""} disabled={!ok || busy}
        onClick={() => onConfirm({ comment, summary: summary || undefined, signature: sig ?? undefined, signed_by: signedBy || undefined, sub_status: sub, file_ids: files.map((f) => f.id),
          ...(bringUp.length ? { asset_status: { assets: bringUp.map((a) => ({ asset_id: a.id, status: "online" })) } } : {}) })}>
        {done ? "Mark as Done" : target === "canceled" ? "Cancel work order" : `Mark ${STATUS_LABEL[target]}`}</Button></>}>
      {wo.sub_work_orders.some((x) => x.status !== "done" && x.status !== "canceled") && done && <div className="banner warning"><AlertTriangle size={16} />Some sub-work orders are still open.</div>}
      {subs.length > 0 && <Field label="Sub-status">{(id) => <Select id={id} value={sub} onChange={(e) => setSub(e.target.value)}><option value="">None</option>{subs.map((x) => <option key={x}>{x}</option>)}</Select>}</Field>}
      {rule !== "none" && !done && <Field label={target === "canceled" ? "Reason" + (rule === "mandatory" ? " *" : " (optional)") : "Comment" + (rule === "mandatory" ? " *" : " (optional)")}>
        {(id) => <textarea id={id} className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} autoFocus placeholder={target === "on_hold" ? "e.g. Waiting on a replacement belt" : "e.g. Duplicate of #1042"} />}</Field>}
      {done && sumRule !== "none" && <Field label={"Completion summary" + (sumRule === "mandatory" ? " *" : " (optional)")}>
        {(id) => <textarea id={id} className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus placeholder="What was done and anything the next person should know" />}</Field>}
      {(done || target === "canceled") && <div className="field"><span className="label">{done ? "After photos and files (optional)" : "Attachments (optional)"}</span>
        <label className="dropzone small"><ImagePlus size={18} className="faint" /><span>Add files</span><input type="file" multiple hidden onChange={(e) => void pick(e.target.files)} /></label>
        {files.length > 0 && <div className="row wrap">{files.map((f) => <span key={f.id} className="chip">{f.name}</span>)}</div>}</div>}
      {done && (s?.require_signature || wo.signature) && (wo.signature
        ? <p className="small muted">Already signed by {wo.signature.name}.</p>
        : <div className="field"><span className="label">Signature{needSig ? " *" : ""}</span><SignaturePad onChange={setSig} />
            <Input aria-label="Signed by" placeholder={`Signed by (default ${session.user?.name})`} value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></div>)}
      {downAssets.map((a) => <label key={a.id} className="check banner info" style={{ alignItems: "center" }}>
        <input type="checkbox" checked={!keepDown.has(a.id)} onChange={(e) => setKeepDown((k) => { const n = new Set(k); if (e.target.checked) n.delete(a.id); else n.add(a.id); return n; })} />
        <span><b>{a.name}</b> is {ASSET_STATUS_LABEL[a.status]}. Mark it Online when this work order is done.</span></label>)}
      {done && s?.require_approval && <p className="small muted">An administrator will review and approve this before it's final.</p>}
    </Modal>
  );
}

const PDF_SECTIONS: [string, string][] = [["basic_info", "Basic info"], ["description", "Description"], ["custom_fields", "Custom fields"], ["sub_work_orders", "Sub-work orders"],
  ["costs", "Time and costs"], ["attachments", "Pictures and files"], ["comments", "Comments"], ["history", "History"], ["estimated_time", "Estimated time"],
  ["signature_line", "Signature line"], ["export_info", "Export info"]];

function PdfDialog({ wo, onClose }: { wo: WODetail; onClose: () => void }) {
  const [sections, setSections] = useState<string[]>(PDF_SECTIONS.map(([k]) => k).filter((k) => k !== "history"));
  const [size, setSize] = useState("regular");
  const url = `/api/v1/work-orders/${wo.id}/pdf?sections=${sections.join(",")}&image_size=${size}`;
  return (
    <Modal title={`Export #${wo.number} to PDF`} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><a className="btn" href={url + "&download=1"} onClick={onClose}><Download size={15} />Download</a>
        <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer" onClick={onClose}><Printer size={15} />Open to print</a></>}>
      <Field label="Pictures">{(id) => <Select id={id} value={size} onChange={(e) => setSize(e.target.value)}>
        <option value="small">Small</option><option value="regular">Regular</option><option value="large">Large</option><option value="original">Original</option><option value="links">File links only</option></Select>}</Field>
      <div className="field"><span className="label">Include</span><div className="check-grid">
        {PDF_SECTIONS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={sections.includes(k)} onChange={(e) => setSections(e.target.checked ? [...sections, k] : sections.filter((x) => x !== k))} /><span>{l}</span></label>)}
      </div></div>
      <p className="small muted">The PDF has a QR code that opens this work order in MPro.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- attachments
function Attachments({ wo, editable, onChange }: { wo: WODetail; editable: boolean; onChange: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(0);
  const [view, setView] = useState<FileItem | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = async (fl: FileList | null, role = "file") => {
    for (const f of Array.from(fl ?? [])) {
      setBusy((n) => n + 1);
      try { await upload(f, { entity_type: "work_order", entity_id: wo.id, role }); } catch (e) { toast((e as ApiError).message, { kind: "error" }); }
      finally { setBusy((n) => n - 1); }
    }
    onChange();
  };
  const remove = async (f: FileItem) => {
    try { await api(`/files/links/${f.link_id}`, { method: "DELETE" }); onChange(); toast(`Removed ${f.name}`); } catch (e) { toast((e as ApiError).message, { kind: "error" }); }
  };
  const images = wo.attachments.filter((a) => a.is_image);
  const others = wo.attachments.filter((a) => !a.is_image);
  const viewList = [...images, ...others];
  const coverId = wo.cover_url?.split("/files/")[1]?.split("/")[0] ?? null;
  const setCover = async (fileId: string) => {
    try { await api(`/work-orders/${wo.id}/cover`, { method: "PUT", body: { file_id: fileId } }); onChange(); toast("Work order image updated"); }
    catch (e) { toast((e as ApiError).message, { kind: "error" }); }
  };
  if (!wo.attachments.length && !editable) return null;
  return (
    <section onDragOver={(e) => { if (editable) e.preventDefault(); }} onDrop={(e) => { if (editable) { e.preventDefault(); void add(e.dataTransfer.files); } }}>
      <div className="row" style={{ justifyContent: "space-between" }}><h3 className="sec-h">Pictures and files {wo.attachments.length > 0 && <span className="faint">({wo.attachments.length})</span>}</h3>
        {editable && <Button size="sm" variant="ghost" onClick={() => input.current?.click()} disabled={busy > 0}><Paperclip size={14} />{busy ? `Uploading ${busy}…` : "Add"}</Button>}
        <input ref={input} type="file" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} /></div>
      {!wo.attachments.length && <div className="dropzone small" onClick={() => input.current?.click()}><ImagePlus size={18} className="faint" />Drag photos or files here</div>}
      {images.length > 0 && <div className="thumbs">{images.map((f) => (
        <figure key={f.id} className="thumb">
          <button type="button" onClick={() => setView(f)} aria-label={`View ${f.name}`}><img src={f.thumb_url ?? f.url} alt={f.name} loading="lazy" /></button>
          {f.role && ["before", "after"].includes(f.role) && <span className="thumb-tag">{f.role === "before" ? "Before" : "After"}</span>}
          {f.id === coverId && images.length > 1 && <span className="cover-tag">Cover</span>}
          {editable && <button type="button" className="thumb-x" aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}><X size={12} /></button>}
        </figure>))}</div>}
      {others.length > 0 && <div className="files">{others.map((f) => (
        <div key={f.id} className="file-row"><FileText size={16} className="faint" /><button type="button" className="linkbtn grow" style={{ textAlign: "left" }} onClick={() => setView(f)}>{f.name}</button>
          <span className="small faint">{(f.size / 1024 / 1024).toFixed(f.size > 1048576 ? 1 : 2)} MB</span>
          <a className="btn ghost sm icon" href={f.url + "?download=1"} aria-label={`Download ${f.name}`}><Download size={14} /></a>
          {editable && <Button size="sm" variant="ghost" icon aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}><X size={14} /></Button>}</div>))}</div>}
      {view && <FileViewer files={viewList} index={Math.max(0, viewList.findIndex((f) => f.id === view.id))} onClose={() => setView(null)}
        actions={(f) => editable && f.is_image && ["file", "photo", "before", "after"].includes((f as FileItem).role ?? "file")
          ? (f.id === coverId ? <span className="small" style={{ color: "var(--c-viewer-muted)" }}>Work order image</span>
            : <Button size="sm" className="viewer-btn" aria-label="Use as work order image" title="Use as work order image" onClick={() => void setCover(f.id)}><ImagePlus size={14} /><span className="desktop-only">Use as work order image</span></Button>)
          : null} />}
    </section>
  );
}

// ---------------------------------------------------------------- time and costs
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <span className="mono">{String(Math.floor(s / 3600)).padStart(2, "0")}:{String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:{String(s % 60).padStart(2, "0")}</span>;
}

function TimeAndCosts({ wo, editable, onChange }: { wo: WODetail; editable: boolean; onChange: (w?: WODetail) => void }) {
  const { session, can } = useSession();
  const opts = useWOOptions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addTime, setAddTime] = useState(false);
  const [addCost, setAddCost] = useState(false);
  const c = wo.costs;
  const mine = c.timers.find((t) => t.user.id === session.user?.id);
  const cur = session.org?.currency ?? "USD";
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const after = () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["wo-activity", wo.id] }); };
  const timer = useMutation({
    mutationFn: (start: boolean) => start ? api<WODetail>(`/work-orders/${wo.id}/timer`, { method: "POST", body: {} }) : api<WODetail>(`/work-orders/${wo.id}/timer`, { method: "DELETE" }),
    onSuccess: (w, start) => { onChange(w); qc.invalidateQueries({ queryKey: ["my-timers"] }); toast(start ? "Timer started" : "Time logged"); }, onError: err,
  });
  const delTime = useMutation({ mutationFn: (tid: string) => api(`/work-orders/${wo.id}/time/${tid}`, { method: "DELETE" }), onSuccess: after, onError: err });
  const delCost = useMutation({ mutationFn: (cid: string) => api(`/work-orders/${wo.id}/costs/${cid}`, { method: "DELETE" }), onSuccess: after, onError: err });
  return (
    <section className="card">
      <div className="card-head"><h2>Time and costs</h2>
        <div className="row">
          {editable && wo.status !== "done" && (mine
            ? <Button size="sm" variant="primary" onClick={() => timer.mutate(false)} disabled={timer.isPending}><Square size={13} />Stop <Elapsed since={mine.started_at} /></Button>
            : <Button size="sm" onClick={() => timer.mutate(true)} disabled={timer.isPending}><Timer size={14} />Start timer</Button>)}
          {editable && <Button size="sm" onClick={() => setAddTime(true)}><Clock size={14} />Log time</Button>}
          {editable && <Button size="sm" onClick={() => setAddCost(true)}><Plus size={14} />Add cost</Button>}
        </div></div>
      {c.timers.filter((t) => t.user.id !== session.user?.id).map((t) => <div key={t.user.id} className="list-row small" style={{ borderLeft: 0 }}><Timer size={14} className="faint" />{t.user.name} has a timer running · <Elapsed since={t.started_at} /></div>)}
      {c.time.length === 0 && c.costs.length === 0 ? <div className="card-body small faint">No time or costs logged yet.</div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Who</th><th>What</th><th className="num">Time</th><th className="num">Cost</th><th /></tr></thead>
          <tbody>
            {c.time.map((t) => <tr key={t.id}><td><span className="row"><Avatar name={t.user.name} initials={t.user.initials} size="sm" />{t.user.name}</span></td>
              <td>{t.time_type}{t.note && <span className="small muted"> · {t.note}</span>}</td><td className="num">{fmtMinutes(t.minutes)}</td><td className="num">{c.rates_visible ? money(t.cost_cents, cur) : "—"}</td>
              <td>{editable && (t.user.id === session.user?.id || can("users.manage")) && <Button size="sm" variant="ghost" icon aria-label="Remove time entry" onClick={() => delTime.mutate(t.id)}><X size={13} /></Button>}</td></tr>)}
            {c.costs.map((x) => <tr key={x.id}><td>{x.user ? <span className="row"><Avatar name={x.user.name} initials={x.user.initials} size="sm" />{x.user.name}</span> : "—"}</td>
              <td>{x.cost_type}{x.description && <span className="small muted"> · {x.description}</span>}{x.receipts.map((r) => <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer" className="small"> · receipt</a>)}</td>
              <td /><td className="num">{money(x.amount_cents, cur)}</td>
              <td>{editable && <Button size="sm" variant="ghost" icon aria-label="Remove cost" onClick={() => delCost.mutate(x.id)}><X size={13} /></Button>}</td></tr>)}
          </tbody>
          <tfoot><tr><td colSpan={2}><b>Total</b></td><td className="num"><b>{fmtMinutes(c.total_minutes)}</b></td><td className="num"><b>{c.rates_visible ? money(c.total_cents, cur) : money(c.other_cents, cur)}</b></td><td /></tr></tfoot>
        </table></div>)}
      {!c.rates_visible && c.time.length > 0 && <div className="card-body small faint" style={{ paddingTop: 0 }}>Labor costs are hidden for your role.</div>}
      {addTime && <TimeModal wo={wo} types={opts.data?.settings.time_types ?? ["Work"]} onClose={() => setAddTime(false)} onDone={after} />}
      {addCost && <CostModal wo={wo} types={opts.data?.settings.cost_types ?? ["Other"]} onClose={() => setAddCost(false)} onDone={after} />}
    </section>
  );
}

function TimeModal({ wo, types, onClose, onDone }: { wo: WODetail; types: string[]; onClose: () => void; onDone: () => void }) {
  const { session, can } = useSession();
  const opts = useWOOptions();
  const { toast } = useToast();
  const [f, setF] = useState({ hours: "", minutes: "", time_type: types.includes("Work") ? "Work" : types[0], user_id: session.user!.id, note: "", rate: "" });
  const total = (Number(f.hours) || 0) * 60 + (Number(f.minutes) || 0);
  const m = useMutation({
    mutationFn: () => api(`/work-orders/${wo.id}/time`, { method: "POST", body: { minutes: total, time_type: f.time_type, user_id: f.user_id, note: f.note,
      rate_cents: f.rate === "" ? undefined : Math.round(Number(f.rate) * 100) } }),
    onSuccess: () => { onDone(); onClose(); toast(`Logged ${fmtMinutes(total)}`); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title="Log time" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={total <= 0 || m.isPending} onClick={() => m.mutate()}>Log time</Button></>}>
      <div className="form-grid">
        <Field label="Hours">{(id) => <Input id={id} type="number" min={0} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} autoFocus />}</Field>
        <Field label="Minutes">{(id) => <Input id={id} type="number" min={0} max={59} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={f.time_type} onChange={(e) => setF({ ...f, time_type: e.target.value })}>{types.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
        <Field label="Who">{(id) => <Select id={id} value={f.user_id} disabled={!can("users.manage")} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
          {(opts.data?.people ?? []).filter((p) => p.assignable).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        {wo.costs.rates_visible && <Field label="Hourly rate override" hint="Leave empty for their usual rate; 0 for no labor cost.">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}</Field>}
        <Field label="Note (optional)" className={wo.costs.rates_visible ? "" : "full"}>{(id) => <Input id={id} value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function CostModal({ wo, types, onClose, onDone }: { wo: WODetail; types: string[]; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const { toast } = useToast();
  const [f, setF] = useState({ amount: "", cost_type: types[types.length - 1], description: "" });
  const [receipts, setReceipts] = useState<FileItem[]>([]);
  const cents = Math.round((Number(f.amount) || 0) * 100);
  const m = useMutation({
    mutationFn: () => api(`/work-orders/${wo.id}/costs`, { method: "POST", body: { amount_cents: cents, cost_type: f.cost_type, description: f.description, file_ids: receipts.map((r) => r.id) } }),
    onSuccess: () => { onDone(); onClose(); toast("Cost added"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title="Add a cost" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={cents <= 0 || m.isPending} onClick={() => m.mutate()}>Add cost</Button></>}>
      <div className="form-grid">
        <Field label={`Amount (${session.org?.currency ?? "USD"})`}>{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={f.cost_type} onChange={(e) => setF({ ...f, cost_type: e.target.value })}>{types.map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
        <Field label="Description" className="full">{(id) => <Input id={id} value={f.description} maxLength={500} placeholder="e.g. Contractor call-out" onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      </div>
      <label className="dropzone small"><Paperclip size={16} className="faint" />Attach receipts<input type="file" multiple hidden accept="image/*,.pdf"
        onChange={async (e) => { for (const x of Array.from(e.target.files ?? [])) { try { const up = await upload(x); setReceipts((r) => [...r, up]); } catch (er) { toast((er as ApiError).message, { kind: "error" }); } } }} /></label>
      {receipts.length > 0 && <div className="row wrap">{receipts.map((r) => <span key={r.id} className="chip">{r.name}</span>)}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- sub-work orders and links
function MiniRow({ w, extra }: { w: MiniWO; extra?: React.ReactNode }) {
  return (
    <div className="list-row" style={{ borderLeft: 0 }}>
      <StatusPill status={w.status} /><Link to={`/work-orders/${w.id}`} className="grow t" style={{ color: "var(--c-text)" }}><span className="mono faint">#{w.number}</span> {w.title}</Link>
      <PriorityBadge priority={w.priority} />{extra}
    </div>
  );
}

function SubsAndLinks({ wo, editable, onAddSub, onChange }: { wo: WODetail; editable: boolean; onAddSub: () => void; onChange: (w: WODetail) => void }) {
  const { can } = useSession();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [num, setNum] = useState("");
  const [kind, setKind] = useState("related");
  const add = useMutation({ mutationFn: () => api<WODetail>(`/work-orders/${wo.id}/links`, { method: "POST", body: { work_order_id: num.replace("#", ""), kind } }),
    onSuccess: (w) => { onChange(w); setAdding(false); setNum(""); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const rm = useMutation({ mutationFn: (lid: string) => api<WODetail>(`/work-orders/${wo.id}/links/${lid}`, { method: "DELETE" }), onSuccess: onChange,
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const closed = wo.sub_work_orders.filter((x) => x.status === "done" || x.status === "canceled").length;
  const blockedBy = wo.links.filter((l) => l.relation === "blocked_by" && !["done", "canceled"].includes(l.work_order.status));
  if (!wo.sub_work_orders.length && !wo.links.length && !editable) return null;
  return (
    <section className="card">
      <div className="card-head"><h2>Sub-work orders and links</h2>
        <div className="row">{editable && can("wo.create") && !wo.parent_id && <Button size="sm" onClick={onAddSub}><ListTree size={14} />Add sub-work order</Button>}
          {editable && <Button size="sm" onClick={() => setAdding(true)}><Link2 size={14} />Link</Button>}</div></div>
      {blockedBy.length > 0 && <div className="card-body" style={{ paddingBottom: 0 }}><div className="banner warning"><AlertTriangle size={16} />Blocked by {blockedBy.map((l) => `#${l.work_order.number}`).join(", ")}, which {blockedBy.length === 1 ? "isn't" : "aren't"} done yet.</div></div>}
      {wo.sub_work_orders.length > 0 && <>
        <div className="card-body small muted" style={{ paddingBottom: 4 }}>{closed} of {wo.sub_work_orders.length} done
          <div className="progress" aria-hidden="true"><span style={{ width: `${(closed / wo.sub_work_orders.length) * 100}%` }} /></div></div>
        {wo.sub_work_orders.map((w) => <MiniRow key={w.id} w={w} />)}</>}
      {wo.links.map((l) => <MiniRow key={l.id} w={l.work_order} extra={<>
        <span className="small faint">{l.relation === "blocks" ? "blocks" : l.relation === "blocked_by" ? "blocked by" : "related"}</span>
        {editable && <Button size="sm" variant="ghost" icon aria-label="Remove link" onClick={() => rm.mutate(l.id)}><X size={13} /></Button>}</>} />)}
      {!wo.sub_work_orders.length && !wo.links.length && <div className="card-body small faint">Break big jobs into sub-work orders, or link related work.</div>}
      {adding && <Modal title="Link a work order" onClose={() => setAdding(false)} footer={<><Button onClick={() => setAdding(false)}>Cancel</Button>
        <Button variant="primary" disabled={!num.trim() || add.isPending} onClick={() => add.mutate()}>Link</Button></>}>
        <div className="form-grid">
          <Field label="Work order number">{(id) => <Input id={id} placeholder="#1042" value={num} onChange={(e) => setNum(e.target.value)} autoFocus />}</Field>
          <Field label="Relationship">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}><option value="related">Related to</option><option value="blocks">This blocks it</option></Select>}</Field>
        </div></Modal>}
    </section>
  );
}

// ---------------------------------------------------------------- activity feed
function ActivityFeed({ wo, options }: { wo: WODetail; options: WOOptions | undefined }) {
  const { session, can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const feed = useQuery({ queryKey: ["wo-activity", wo.id], queryFn: () => api<{ items: ActivityItem[] }>(`/work-orders/${wo.id}/activity`) });
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ files: FileItem[]; id: string } | null>(null);
  const [editBody, setEditBody] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const reload = () => { qc.invalidateQueries({ queryKey: ["wo-activity", wo.id] }); qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); };
  const post = useMutation({ mutationFn: () => api<CommentItem>(`/work-orders/${wo.id}/comments`, { method: "POST", body: { body, file_ids: files.map((f) => f.id) } }),
    onSuccess: () => { setBody(""); setFiles([]); reload(); }, onError: err });
  const edit = useMutation({ mutationFn: (cid: string) => api(`/work-orders/${wo.id}/comments/${cid}`, { method: "PATCH", body: { body: editBody } }),
    onSuccess: () => { setEditing(null); reload(); }, onError: err });
  const del = useMutation({ mutationFn: (cid: string) => api(`/work-orders/${wo.id}/comments/${cid}`, { method: "DELETE" }), onSuccess: reload, onError: err });
  const react = useMutation({ mutationFn: ({ cid, emoji }: { cid: string; emoji: string }) => api(`/work-orders/${wo.id}/comments/${cid}/reactions`, { method: "POST", body: { emoji } }),
    onSuccess: reload, onError: err });
  const people = useMemo(() => Object.fromEntries((options?.people ?? []).map((p) => [p.id, p.name])), [options]);
  const items = (feed.data?.items ?? []).filter((i) => showHistory || i.kind === "comment");
  const end = useRef<HTMLDivElement>(null);
  return (
    <section className="card">
      <div className="card-head"><h2>Activity</h2><label className="check small"><input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /><span>Show history</span></label></div>
      <div className="feed">
        {feed.isLoading && <ListSkeleton rows={2} />}
        {items.map((i) => i.kind === "event" ? (
          <div key={"e" + i.id} className="feed-ev"><span className="dot" /><span><b>{i.actor_label}</b> {lower(i.summary)}{i.data?.comment ? <>: “{String(i.data.comment)}”</> : null}</span>
            <span className="faint small r" title={dateTime(i.created_at)}>{timeAgo(i.created_at)}</span></div>
        ) : (
          <div key={"c" + i.id} className="comment">
            {i.author ? <Avatar name={i.author.name} initials={i.author.initials} size="sm" /> : <span className="avatar sm" />}
            <div className="grow">
              <div className="row small"><b>{i.author?.name ?? (i.external_name ? `${i.external_name} (outside)` : "Someone")}</b><span className="faint" title={dateTime(i.created_at)}>{timeAgo(i.created_at)}{i.edited_at && " · edited"}</span>
                {!i.deleted && <span className="r row" style={{ gap: 2 }}>
                  <Dropdown up width={220} trigger={(_, t) => <Button size="sm" variant="ghost" icon aria-label="React" onClick={t}><SmilePlus size={14} /></Button>}>
                    {(close) => <div className="row" style={{ padding: 6 }}>{REACTIONS.map((e) => <button key={e} type="button" className="emoji-btn" onClick={() => { close(); react.mutate({ cid: i.id, emoji: e }); }}>{e}</button>)}</div>}
                  </Dropdown>
                  {i.author?.id === session.user?.id && <Button size="sm" variant="ghost" icon aria-label="Edit comment" onClick={() => { setEditing(i.id); setEditBody(i.body); }}><Pencil size={13} /></Button>}
                  {(i.author?.id === session.user?.id || can("wo.delete")) && <Button size="sm" variant="ghost" icon aria-label="Delete comment" onClick={() => del.mutate(i.id)}><Trash2 size={13} /></Button>}
                </span>}
              </div>
              {i.deleted ? <p className="faint small">Comment deleted</p> : editing === i.id ? (
                <div className="stack" style={{ gap: 6 }}><MentionBox value={editBody} onChange={setEditBody} options={options} autoFocus onSubmit={() => edit.mutate(i.id)} />
                  <div className="row"><Button size="sm" onClick={() => setEditing(null)}>Cancel</Button><Button size="sm" variant="primary" onClick={() => edit.mutate(i.id)}>Save</Button></div></div>
              ) : <p className="prewrap"><RichText text={i.body} /></p>}
              {i.files.length > 0 && <div className="thumbs sm">{i.files.map((f) => f.is_image
                ? <button type="button" key={f.id} className="thumb" aria-label={`View ${f.name}`} onClick={() => setViewing({ files: i.files, id: f.id })}><img src={f.thumb_url ?? f.url} alt={f.name} /></button>
                : <button type="button" key={f.id} className="chip" onClick={() => setViewing({ files: i.files, id: f.id })}><FileText size={13} />{f.name}</button>)}</div>}
              {Object.keys(i.reactions).length > 0 && <div className="row" style={{ gap: 4, marginTop: 4 }}>{Object.entries(i.reactions).map(([e, who]) => (
                <button key={e} type="button" className={"reaction" + (who.includes(session.user!.id) ? " mine" : "")} title={who.map((u) => people[u] ?? "Someone").join(", ")}
                  onClick={() => react.mutate({ cid: i.id, emoji: e })}>{e} {who.length}</button>))}</div>}
            </div>
          </div>))}
        {!feed.isLoading && items.length === 0 && <div className="small faint" style={{ padding: "8px 0" }}>No comments yet.</div>}
        <div ref={end} />
      </div>
      {can("wo.comment") && !wo.deleted && (
        <div className="comment-box">
          <MentionBox value={body} onChange={setBody} options={options} placeholder="Write a comment… use @ to mention someone" onSubmit={() => { if (body.trim() || files.length) post.mutate(); }} />
          {files.length > 0 && <div className="row wrap">{files.map((f) => <span key={f.id} className="chip">{f.name}<button type="button" className="linkbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X size={12} /></button></span>)}</div>}
          <div className="row"><label className="btn ghost sm" aria-label="Attach files"><Paperclip size={14} /><input type="file" multiple hidden onChange={async (e) => {
            for (const x of Array.from(e.target.files ?? [])) { try { const up = await upload(x); setFiles((f) => [...f, up]); } catch (er) { err(er); } } e.target.value = ""; }} /></label>
            <span className="small faint grow">Ctrl + Enter to send{options?.settings.mention_assigns ? " · mentioning someone assigns them" : ""}</span>
            <Button size="sm" variant="primary" disabled={(!body.trim() && !files.length) || post.isPending} onClick={() => post.mutate()}><Send size={14} />Send</Button></div>
        </div>)}
      {viewing && <FileViewer files={viewing.files} index={Math.max(0, viewing.files.findIndex((f) => f.id === viewing.id))} onClose={() => setViewing(null)} />}
    </section>
  );
}

function lower(s: string) { return s ? s[0].toLowerCase() + s.slice(1) : s; }

const TASK_STATUSES: { id: AssetTask["status"]; label: string }[] = [
  { id: "open", label: "Open" }, { id: "on_hold", label: "On Hold" }, { id: "in_progress", label: "In Progress" }, { id: "done", label: "Done" }];

/** Every asset on the work order (MP-124), falling back to the single asset from older responses. */
function woAssetsOf(wo: WODetail): { id: string; name: string; status: AssetStatus }[] {
  return wo.assets?.length ? wo.assets : wo.asset ? [wo.asset] : [];
}

/** Asset task list (MP-099): each asset on the work order has its own status and notes, without sub-work orders. */
function AssetTasks({ wo, editable, onChange }: { wo: WODetail; editable: boolean; onChange: (w: WODetail) => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: ({ task, body }: { task: AssetTask; body: Record<string, unknown> }) =>
      api<WODetail>(`/work-orders/${wo.id}/asset-tasks/${task.id}`, { method: "PATCH", body }),
    onSuccess: (w) => onChange(w), onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const done = wo.asset_tasks.filter((t) => t.status === "done").length;
  return (
    <section className="card">
      <div className="card-head"><h3><ListTree size={16} /> Asset tasks</h3><span className="small muted">{done} of {wo.asset_tasks.length} done</span></div>
      <div className="card-body" style={{ paddingTop: 0 }}><div className="progress" aria-hidden="true"><span style={{ width: `${(done / wo.asset_tasks.length) * 100}%` }} /></div></div>
      <ul className="asset-tasks">
        {wo.asset_tasks.map((t) => (
          <li key={t.id} className={"asset-task " + t.status}>
            <div className="row wrap" style={{ gap: 8 }}>
              <Link to={`/assets/${t.asset.id}`} className="grow row" style={{ gap: 6, minWidth: 160 }}>
                <span className={"astat-dot " + t.asset.status} title={ASSET_STATUS_LABEL[t.asset.status]} />
                <span className={t.status === "done" ? "strike" : ""}>{t.asset.name}</span>
                {t.asset.location && <span className="small faint">{t.asset.location}</span>}
              </Link>
              {editable
                ? <div className="seg sm" role="radiogroup" aria-label={`Status of ${t.asset.name}`}>{TASK_STATUSES.map((x) => (
                    <button key={x.id} type="button" role="radio" aria-checked={t.status === x.id} className={"seg-btn task-" + x.id + (t.status === x.id ? " on" : "")}
                      disabled={m.isPending} onClick={() => m.mutate({ task: t, body: { status: x.id } })}>{x.label}</button>))}</div>
                : <StatusPill status={t.status} />}
            </div>
            {editable
              ? <textarea className="textarea small" rows={1} aria-label={`Notes for ${t.asset.name}`} placeholder="Notes" value={notes[t.id] ?? t.note}
                  onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))}
                  onBlur={() => { const v = notes[t.id]; if (v !== undefined && v !== t.note) m.mutate({ task: t, body: { note: v } }); }} />
              : t.note && <p className="small prewrap" style={{ margin: "4px 0 0" }}>{t.note}</p>}
          </li>))}
      </ul>
    </section>
  );
}
