import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Work-order detail (MaintainX layout): header and status → assignees/meta → description and photos →
// time and costs → sub-work orders and links → activity feed with the comment box at the bottom.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Copy, CopyPlus, Download, ExternalLink, FileText, ImagePlus, Link2, ListTree, Mail, MapPin, MoreHorizontal, Paperclip, Pause, Pencil, Play, Plus, Printer, RotateCcw, Send, SmilePlus, Square, Timer, Trash2, Undo2, X, } from "lucide-react";
import { api, upload, } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, dateTime, timeAgo } from "../../lib/format";
import { absoluteUrl, copyText, dueLabel, fmtDuration, fmtMinutes, money, STATUS_LABEL, useWOOptions, WORK_TYPE_LABEL } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { AssigneeChips, CategoryChips, MentionBox, RichText, SignaturePad } from "../../components/pickers";
import { fromDetail, WorkOrderForm } from "./Form";
import { ASSET_STATUS_LABEL } from "../../lib/assets";
import { FileViewer } from "../../components/FileViewer";
import { DropZone } from "../../components/DropZone";
import { ProcedureRuns } from "../procedures/Runner";
import { offerCloseSubs, RecurrenceChip, SubRollup } from "../pm/WOParts";
import { WOPartsSection } from "../parts/WOParts";
import { WorkOrderOutside } from "./WorkOrderVendors";
import { WOCustomerRow } from "../vendors/WOCustomer";
import { WOReceipts } from "../finance/Receipts";
const REACTIONS = ["👍", "👀", "✅", "🎉", "❤️", "⚠️"];
const STATUS_BTNS = [
    { id: "open", label: "Open", icon: Square }, { id: "on_hold", label: "On Hold", icon: Pause },
    { id: "in_progress", label: "In Progress", icon: Play }, { id: "done", label: "Done", icon: CheckCircle2 },
];
export function useWorkOrder(id) {
    return useQuery({ queryKey: ["work-order", id], queryFn: () => api(`/work-orders/${id}`), enabled: !!id });
}
export function WorkOrderDetail({ id, backTo, inDrawer, onClose }) {
    const q = useWorkOrder(id);
    const opts = useWOOptions();
    const { session, can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const [newSub, setNewSub] = useState(false);
    const [copyInit, setCopyInit] = useState(null);
    const [statusAsk, setStatusAsk] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pdfOpen, setPdfOpen] = useState(false);
    const tz = session.org?.timezone;
    useEffect(() => {
        // mark read happens on GET; refresh list unread dots
        if (q.data)
            qc.invalidateQueries({ queryKey: ["work-orders"], refetchType: "none" });
    }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            const panels = document.querySelectorAll(".drawer-wrap").length;
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable || document.querySelector(".overlay") || panels > (inDrawer ? 1 : 0))
                return;
            if (e.key === "e" && (q.data?.you?.edit ?? can("wo.edit")) && q.data && !q.data.deleted) {
                e.preventDefault();
                setEditing(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [can, q.data, inDrawer]);
    const refresh = (wo) => {
        if (wo)
            qc.setQueryData(["work-order", id], wo);
        else
            qc.invalidateQueries({ queryKey: ["work-order", id] });
        qc.invalidateQueries({ queryKey: ["work-orders"] });
        qc.invalidateQueries({ queryKey: ["wo-activity", id] });
        qc.invalidateQueries({ queryKey: ["wo-stats"] });
        qc.invalidateQueries({ queryKey: ["wo-workload"] });
    };
    const err = (e) => {
        const ae = e;
        if (ae.status === 409) {
            refresh();
            toast("Someone else just changed this work order. It's been refreshed.", { kind: "error" });
        }
        else
            toast(ae.message, { kind: "error" });
    };
    const statusM = useMutation({
        mutationFn: (b) => api(`/work-orders/${id}/status`, { method: "POST", body: { version: q.data?.version, ...b } }),
        onMutate: async (b) => {
            const prev = qc.getQueryData(["work-order", id]);
            if (prev && b.status !== "done")
                qc.setQueryData(["work-order", id], { ...prev, status: b.status, sub_status: b.sub_status ?? "" });
            return { prev };
        },
        onSuccess: (wo, b, ctx) => {
            refresh(wo);
            setStatusAsk(null);
            if (!b.undo && ctx?.prev?.status !== "done")
                offerCloseSubs(wo, toast, qc); // MaintainX offers to close open sub-work orders (0.4.0)
            const from = ctx?.prev?.status;
            const fromSub = ctx?.prev?.sub_status ?? "";
            if (from && from !== wo.status && !b.undo)
                toast(`Marked ${STATUS_LABEL[wo.status]}`, { action: { label: "Undo", run: () => statusM.mutate({ status: from, sub_status: fromSub, version: wo.version, undo: true }) } });
            void b;
        },
        onError: (e, _b, ctx) => { if (ctx?.prev)
            qc.setQueryData(["work-order", id], ctx.prev); err(e); },
    });
    const del = useMutation({
        mutationFn: () => api(`/work-orders/${id}`, { method: "DELETE" }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            setConfirmDelete(false);
            nav(backTo ?? "/work-orders");
            onClose?.();
            toast(`Deleted #${q.data?.number}`, { action: { label: "Undo", run: () => { void api(`/work-orders/${id}/restore`, { method: "POST" }).then(() => { qc.invalidateQueries({ queryKey: ["work-orders"] }); nav(`/work-orders/${id}`); }); } } });
        }, onError: err,
    });
    const restore = useMutation({ mutationFn: () => api(`/work-orders/${id}/restore`, { method: "POST" }), onSuccess: (wo) => { refresh(wo); toast("Restored"); }, onError: err });
    const duplicate = useMutation({ mutationFn: () => api(`/work-orders/${id}/duplicate`, { method: "POST" }),
        onSuccess: (wo) => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast(`Created #${wo.number}`); nav(`/work-orders/${wo.id}`); onClose?.(); }, onError: err });
    const approval = useMutation({ mutationFn: (b) => api(`/work-orders/${id}/approval`, { method: "POST", body: b }),
        onSuccess: (wo) => { refresh(wo); toast(wo.approval_status === "approved" ? "Approved" : "Sent back for more work"); }, onError: err });
    const unread = useMutation({ mutationFn: () => api("/work-orders/bulk", { method: "POST", body: { ids: [id], action: "mark_unread" } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["work-orders"] }); toast("Marked as unread"); }, onError: err });
    if (q.isError)
        return _jsx(EmptyState, { title: "Work order not found", children: "It may have been deleted, or you don't have access to it." });
    if (!q.data)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    const wo = q.data;
    const s = opts.data?.settings;
    const editable = (wo.you?.edit ?? can("wo.edit")) && !wo.deleted;
    const due = dueLabel(wo.due_at, wo.overdue, tz);
    const subs = wo.sub_statuses?.[wo.status] ?? [];
    const changeStatus = (st) => {
        if (st === wo.status)
            return;
        const rule = st === "on_hold" ? s?.comment_on_hold : st === "canceled" ? s?.comment_on_cancel : "none";
        const assetDown = woAssetsOf(wo).some((a) => a.status !== "online") && can("assets.status");
        const needsDialog = st === "done" ? !!(s?.require_signature || s?.completion_summary !== "none" || assetDown) : rule === "mandatory" || (rule === "optional" && st === "canceled");
        if (needsDialog)
            setStatusAsk(st);
        else
            statusM.mutate({ status: st });
    };
    return (_jsxs("div", { className: "detail wo-detail" + (inDrawer ? " in-drawer" : ""), children: [!inDrawer && _jsxs(Link, { to: backTo ?? "/work-orders", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All work orders"] }), wo.deleted && _jsxs("div", { className: "banner warning", children: [_jsx(Trash2, { size: 18 }), _jsx("div", { className: "grow", children: "This work order was deleted." }), (wo.you?.delete ?? can("wo.delete")) && _jsxs(Button, { size: "sm", onClick: () => restore.mutate(), children: [_jsx(RotateCcw, { size: 14 }), "Restore"] })] }), _jsxs("div", { className: "wo-head", children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row small muted", style: { gap: 6 }, children: [_jsxs("span", { className: "mono", children: ["#", wo.number] }), wo.parent && _jsxs(_Fragment, { children: ["\u00B7 ", _jsx(ListTree, { size: 13 }), "Sub-work order of ", _jsxs(Link, { to: `/work-orders/${wo.parent.id}`, children: ["#", wo.parent.number, " ", wo.parent.title] })] })] }), _jsx("h1", { className: "wo-title", children: wo.title }), _jsxs("div", { className: "row wrap", style: { marginTop: 6 }, children: [_jsx(StatusPill, { status: wo.status, sub: wo.sub_status }), _jsx(PriorityBadge, { priority: wo.priority }), due && _jsxs("span", { className: "due " + due.tone, children: [_jsx(Clock, { size: 13 }), due.text] }), _jsx(RecurrenceChip, { wo: wo, editable: editable, onChange: () => refresh() }), wo.approval_status === "pending" && _jsx(Pill, { tone: "warning", children: "Awaiting approval" }), wo.approval_status === "approved" && _jsx(Pill, { tone: "success", children: "Approved" }), wo.approval_status === "rejected" && wo.status !== "done" && _jsx(Pill, { tone: "danger", children: "Sent back" })] })] }), _jsxs("div", { className: "row", children: [editable && _jsxs(Button, { onClick: () => setEditing(true), "aria-label": "Edit", children: [_jsx(Pencil, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Edit" })] }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 250, children: (close) => _jsxs(_Fragment, { children: [can("wo.create") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setCopyInit({ ...fromDetail(wo), title: wo.title }); }, children: [_jsx(CopyPlus, { size: 15 }), "Copy to new work order"] }), can("wo.create") && _jsxs("button", { className: "menu-item", onClick: () => { close(); duplicate.mutate(); }, children: [_jsx(Copy, { size: 15 }), "Duplicate now"] }), can("wo.create") && !wo.parent_id && !wo.deleted && _jsxs("button", { className: "menu-item", onClick: () => { close(); setNewSub(true); }, children: [_jsx(ListTree, { size: 15 }), "Add sub-work order"] }), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setPdfOpen(true); }, children: [_jsx(Printer, { size: 15 }), "Export to PDF"] }), _jsxs("button", { className: "menu-item", onClick: async () => { close(); toast((await copyText(absoluteUrl(`/work-orders/${wo.id}`))) ? "Link copied" : "Couldn't copy the link"); }, children: [_jsx(Link2, { size: 15 }), "Copy link"] }), _jsxs("a", { className: "menu-item", href: `mailto:?subject=${encodeURIComponent(`Work order #${wo.number}: ${wo.title}`)}&body=${encodeURIComponent(absoluteUrl(`/work-orders/${wo.id}`))}`, onClick: close, children: [_jsx(Mail, { size: 15 }), "Email a link"] }), inDrawer && _jsxs(Link, { className: "menu-item", to: `/work-orders/${wo.id}`, onClick: close, children: [_jsx(ExternalLink, { size: 15 }), "Open full page"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); unread.mutate(); }, children: [_jsx(Undo2, { size: 15 }), "Mark as unread"] }), editable && wo.status !== "canceled" && wo.status !== "done" && _jsxs("button", { className: "menu-item", onClick: () => { close(); setStatusAsk("canceled"); }, children: [_jsx(Ban, { size: 15 }), "Cancel work order"] }), can("audit.view") && _jsxs(Link, { className: "menu-item", to: `/settings/audit-log?entity_id=${wo.id}`, onClick: close, children: [_jsx(FileText, { size: 15 }), "History in audit log"] }), (wo.you?.delete ?? can("wo.delete")) && !wo.deleted && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirmDelete(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] })] })] }) }), inDrawer && onClose && _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Close", onClick: onClose, children: _jsx(X, { size: 18 }) })] })] }), editable && wo.status !== "canceled" && (_jsx("div", { className: "status-bar", role: "group", "aria-label": "Status", children: STATUS_BTNS.map((b) => {
                    const Icon = b.icon;
                    return (_jsxs("button", { type: "button", className: "status-btn " + b.id + (wo.status === b.id ? " on" : ""), "aria-pressed": wo.status === b.id, disabled: statusM.isPending, onClick: () => changeStatus(b.id), children: [_jsx(Icon, { size: 16 }), b.label] }, b.id));
                }) })), wo.status === "canceled" && _jsxs("div", { className: "banner warning", children: [_jsx(Ban, { size: 18 }), _jsxs("div", { className: "grow", children: [_jsx("b", { children: "Canceled." }), " ", wo.cancel_reason] }), editable && _jsx(Button, { size: "sm", onClick: () => statusM.mutate({ status: "open" }), children: "Reopen" })] }), editable && subs.length > 0 && wo.status !== "canceled" && (_jsxs("div", { className: "row small", children: [_jsx("span", { className: "muted", children: "Sub-status" }), _jsxs(Select, { "aria-label": "Sub-status", value: wo.sub_status, style: { width: "auto", height: 30 }, onChange: (e) => statusM.mutate({ status: wo.status, sub_status: e.target.value }), children: [_jsx("option", { value: "", children: "None" }), subs.map((x) => _jsx("option", { children: x }, x))] })] })), wo.approval_status === "pending" && can("wo.approve") && _jsx(ApprovalBar, { onDecide: (approve, comment) => approval.mutate({ approve, comment }), busy: approval.isPending }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Assigned to" }), _jsx("dd", { children: _jsx(AssigneeChips, { items: wo.assignees, max: 6 }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Due date" }), _jsx("dd", { children: wo.due_at ? dateTime(wo.due_at, tz) : _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Start date" }), _jsx("dd", { children: wo.start_at ? dateTime(wo.start_at, tz) : _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Priority" }), _jsx("dd", { children: _jsx(PriorityBadge, { priority: wo.priority }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Work type" }), _jsx("dd", { children: WORK_TYPE_LABEL[wo.work_type] })] }), _jsxs("div", { children: [_jsx("dt", { children: "Estimated time" }), _jsx("dd", { children: wo.estimated_minutes ? fmtMinutes(wo.estimated_minutes) : _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Categories" }), _jsx("dd", { children: wo.categories.length ? _jsx(CategoryChips, { items: wo.categories }) : _jsx("span", { className: "faint", children: "None" }) })] }), woAssetsOf(wo).length > 0 && _jsxs("div", { children: [_jsx("dt", { children: woAssetsOf(wo).length > 1 ? "Assets" : "Asset" }), _jsx("dd", { className: "stack", style: { gap: 4 }, children: woAssetsOf(wo).map((a) => (_jsxs(Link, { to: `/assets/${a.id}`, className: "row", style: { gap: 6 }, children: [_jsx("span", { className: "astat-dot " + a.status, title: ASSET_STATUS_LABEL[a.status] }), a.name] }, a.id))) })] }), wo.location && _jsxs("div", { children: [_jsx("dt", { children: "Location" }), _jsx("dd", { children: _jsxs(Link, { to: `/locations/${wo.location.id}`, className: "row", style: { gap: 6 }, children: [_jsx(MapPin, { size: 14, className: "faint" }), wo.location.name] }) })] }), _jsx(WOCustomerRow, { woId: wo.id, canEdit: editable }), _jsxs("div", { children: [_jsx("dt", { children: "Created" }), _jsxs("dd", { title: dateTime(wo.created_at, tz), children: [timeAgo(wo.created_at), wo.created_by && ` by ${wo.created_by.name}`] })] }), wo.completed_at && _jsxs("div", { children: [_jsx("dt", { children: "Completed" }), _jsxs("dd", { title: dateTime(wo.completed_at, tz), children: [timeAgo(wo.completed_at), wo.completed_by && ` by ${wo.completed_by.name}`] })] }), _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Time in status" }), _jsx("dd", { className: "small", children: ["open", "in_progress", "on_hold"].filter((k) => wo.time_in_status[k] > 0).map((k) => `${STATUS_LABEL[k]} ${fmtDuration(wo.time_in_status[k])}`).join(" · ") || "—" })] }), (opts.data?.custom_fields ?? []).filter((f) => wo.custom[f.id] !== undefined && wo.custom[f.id] !== "").map((f) => (_jsxs("div", { children: [_jsx("dt", { children: f.name }), _jsx("dd", { children: f.type === "checkbox" ? (wo.custom[f.id] ? "Yes" : "No") : f.type === "link"
                                    ? _jsx("a", { href: String(wo.custom[f.id]), target: "_blank", rel: "noopener noreferrer", children: String(wo.custom[f.id]) })
                                    : f.type === "datetime" ? dateTime(String(wo.custom[f.id]), tz) : f.type === "currency" ? currency(wo.custom[f.id], session.org?.currency)
                                        : String(wo.custom[f.id]) })] }, f.id)))] }), wo.description && _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Description" }), _jsx("p", { className: "prewrap", children: wo.description })] }), _jsx(Attachments, { wo: wo, editable: editable, onChange: () => refresh() }), wo.asset_tasks.length > 0 && _jsx(AssetTasks, { wo: wo, editable: editable && !["done", "canceled"].includes(wo.status), onChange: (w) => refresh(w) }), can("procedures.view") && _jsx(ProcedureRuns, { wo: wo, onChange: () => refresh() }), (wo.completion_summary || wo.signature) && (_jsxs("section", { className: "card card-pad stack", children: [_jsx("h3", { children: "Completion" }), wo.completion_summary && _jsx("p", { className: "prewrap", children: wo.completion_summary }), wo.signature && _jsxs("div", { className: "row", style: { alignItems: "flex-end", gap: 16 }, children: [_jsx("img", { src: wo.signature.file.url, alt: `Signature of ${wo.signature.name}`, className: "sig-img" }), _jsxs("div", { className: "small muted", children: ["Signed by ", _jsx("b", { children: wo.signature.name }), _jsx("br", {}), dateTime(wo.signature.signed_at, tz)] })] })] })), _jsx(WOPartsSection, { wo: wo }), _jsx(WorkOrderOutside, { wo: wo, editable: editable }), _jsx(TimeAndCosts, { wo: wo, editable: editable, onChange: (w) => refresh(w) }), _jsx(WOReceipts, { woId: wo.id }), _jsx(SubsAndLinks, { wo: wo, editable: editable, onAddSub: () => setNewSub(true), onChange: (w) => refresh(w) }), _jsx(SubRollup, { wo: wo }), _jsx(ActivityFeed, { wo: wo, options: opts.data }), editing && _jsx(WorkOrderForm, { edit: wo, onClose: () => setEditing(false), onSaved: (w) => refresh(w) }), newSub && _jsx(WorkOrderForm, { init: { parent_id: wo.id, assignees: wo.assignees.map((a) => `${a.type}:${a.id}`), categories: wo.categories.map((c) => c.id), priority: wo.priority }, onClose: () => setNewSub(false), onSaved: () => refresh() }), copyInit && _jsx(WorkOrderForm, { init: copyInit, onClose: () => setCopyInit(null) }), statusAsk && _jsx(StatusDialog, { wo: wo, target: statusAsk, options: opts.data, onClose: () => setStatusAsk(null), busy: statusM.isPending, onConfirm: (b) => statusM.mutate({ status: statusAsk, ...b }) }), pdfOpen && _jsx(PdfDialog, { wo: wo, onClose: () => setPdfOpen(false) }), confirmDelete && _jsx(Modal, { title: `Delete #${wo.number}?`, onClose: () => setConfirmDelete(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Keep it" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsxs("p", { children: ["\u201C", wo.title, "\u201D will move to deleted work orders. Administrators can restore it from the table view (Show deleted). Canceling keeps it in reports instead."] }) })] }));
}
function ApprovalBar({ onDecide, busy }) {
    const [reject, setReject] = useState(false);
    const [why, setWhy] = useState("");
    return (_jsxs("div", { className: "banner info", style: { alignItems: "center" }, children: [_jsx(CheckCircle2, { size: 18 }), _jsxs("div", { className: "grow", children: [_jsx("b", { children: "Waiting for your approval." }), " Check the work, then approve it or send it back."] }), _jsx(Button, { size: "sm", onClick: () => setReject(true), disabled: busy, children: "Send back" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => onDecide(true), disabled: busy, children: "Approve" }), reject && _jsx(Modal, { title: "Send back for more work", onClose: () => setReject(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setReject(false), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !why.trim(), onClick: () => { onDecide(false, why); setReject(false); }, children: "Send back" })] }), children: _jsx(Field, { label: "What still needs doing?", children: (id) => _jsx("textarea", { id: id, className: "textarea", value: why, onChange: (e) => setWhy(e.target.value), autoFocus: true }) }) })] }));
}
function StatusDialog({ wo, target, options, onClose, onConfirm, busy }) {
    const s = options?.settings;
    const [comment, setComment] = useState("");
    const [summary, setSummary] = useState("");
    const [sig, setSig] = useState(null);
    const [signedBy, setSignedBy] = useState("");
    const [sub, setSub] = useState("");
    const [files, setFiles] = useState([]);
    const { session, can } = useSession();
    const [keepDown, setKeepDown] = useState(() => new Set());
    const { toast } = useToast();
    const done = target === "done";
    const downAssets = done && can("assets.status") ? woAssetsOf(wo).filter((a) => a.status !== "online") : [];
    const bringUp = downAssets.filter((a) => !keepDown.has(a.id));
    const rule = target === "on_hold" ? s?.comment_on_hold : target === "canceled" ? s?.comment_on_cancel : "none";
    const needSig = done && s?.require_signature && !wo.signature;
    const sumRule = done ? s?.completion_summary : "none";
    const ok = (!done || (!needSig || sig) && (sumRule !== "mandatory" || summary.trim())) && (rule !== "mandatory" || comment.trim());
    const subs = wo.sub_statuses?.[target] ?? [];
    const pick = async (fl) => { for (const f of Array.from(fl ?? [])) {
        try {
            const up = await upload(f);
            setFiles((x) => [...x, up]);
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
    } };
    const title = done ? `Complete #${wo.number}` : target === "canceled" ? `Cancel #${wo.number}` : `${STATUS_LABEL[target]} · #${wo.number}`;
    return (_jsxs(Modal, { title: title, onClose: onClose, width: 560, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Back" }), _jsx(Button, { variant: target === "canceled" ? "danger" : "primary", className: target === "canceled" ? "solid" : "", disabled: !ok || busy, onClick: () => onConfirm({ comment, summary: summary || undefined, signature: sig ?? undefined, signed_by: signedBy || undefined, sub_status: sub, file_ids: files.map((f) => f.id),
                        ...(bringUp.length ? { asset_status: { assets: bringUp.map((a) => ({ asset_id: a.id, status: "online" })) } } : {}) }), children: done ? "Mark as Done" : target === "canceled" ? "Cancel work order" : `Mark ${STATUS_LABEL[target]}` })] }), children: [wo.sub_work_orders.some((x) => x.status !== "done" && x.status !== "canceled") && done && _jsxs("div", { className: "banner warning", children: [_jsx(AlertTriangle, { size: 16 }), "Some sub-work orders are still open."] }), subs.length > 0 && _jsx(Field, { label: "Sub-status", children: (id) => _jsxs(Select, { id: id, value: sub, onChange: (e) => setSub(e.target.value), children: [_jsx("option", { value: "", children: "None" }), subs.map((x) => _jsx("option", { children: x }, x))] }) }), rule !== "none" && !done && _jsx(Field, { label: target === "canceled" ? "Reason" + (rule === "mandatory" ? " *" : " (optional)") : "Comment" + (rule === "mandatory" ? " *" : " (optional)"), children: (id) => _jsx("textarea", { id: id, className: "textarea", value: comment, onChange: (e) => setComment(e.target.value), autoFocus: true, placeholder: target === "on_hold" ? "e.g. Waiting on a replacement belt" : "e.g. Duplicate of #1042" }) }), done && sumRule !== "none" && _jsx(Field, { label: "Completion summary" + (sumRule === "mandatory" ? " *" : " (optional)"), children: (id) => _jsx("textarea", { id: id, className: "textarea", value: summary, onChange: (e) => setSummary(e.target.value), autoFocus: true, placeholder: "What was done and anything the next person should know" }) }), (done || target === "canceled") && _jsxs("div", { className: "field", children: [_jsx("span", { className: "label", children: done ? "After photos and files (optional)" : "Attachments (optional)" }), _jsx(DropZone, { onFiles: (fs) => void pick(fs), children: _jsxs("label", { className: "dropzone small", children: [_jsx(ImagePlus, { size: 18, className: "faint" }), _jsx("span", { children: "Add files or drag them here" }), _jsx("input", { type: "file", multiple: true, hidden: true, onChange: (e) => void pick(e.target.files) })] }) }), files.length > 0 && _jsx("div", { className: "row wrap", children: files.map((f) => _jsx("span", { className: "chip", children: f.name }, f.id)) })] }), done && (s?.require_signature || wo.signature) && (wo.signature
                ? _jsxs("p", { className: "small muted", children: ["Already signed by ", wo.signature.name, "."] })
                : _jsxs("div", { className: "field", children: [_jsxs("span", { className: "label", children: ["Signature", needSig ? " *" : ""] }), _jsx(SignaturePad, { onChange: setSig }), _jsx(Input, { "aria-label": "Signed by", placeholder: `Signed by (default ${session.user?.name})`, value: signedBy, onChange: (e) => setSignedBy(e.target.value) })] })), downAssets.map((a) => _jsxs("label", { className: "check banner info", style: { alignItems: "center" }, children: [_jsx("input", { type: "checkbox", checked: !keepDown.has(a.id), onChange: (e) => setKeepDown((k) => { const n = new Set(k); if (e.target.checked)
                            n.delete(a.id);
                        else
                            n.add(a.id); return n; }) }), _jsxs("span", { children: [_jsx("b", { children: a.name }), " is ", ASSET_STATUS_LABEL[a.status], ". Mark it Online when this work order is done."] })] }, a.id)), done && s?.require_approval && _jsx("p", { className: "small muted", children: "An administrator will review and approve this before it's final." })] }));
}
const PDF_SECTIONS = [["basic_info", "Basic info"], ["description", "Description"], ["custom_fields", "Custom fields"], ["sub_work_orders", "Sub-work orders"],
    ["costs", "Time and costs"], ["attachments", "Pictures and files"], ["comments", "Comments"], ["history", "History"], ["estimated_time", "Estimated time"],
    ["signature_line", "Signature line"], ["export_info", "Export info"]];
function PdfDialog({ wo, onClose }) {
    const [sections, setSections] = useState(PDF_SECTIONS.map(([k]) => k).filter((k) => k !== "history"));
    const [size, setSize] = useState("regular");
    const url = `/api/v1/work-orders/${wo.id}/pdf?sections=${sections.join(",")}&image_size=${size}`;
    return (_jsxs(Modal, { title: `Export #${wo.number} to PDF`, onClose: onClose, width: 520, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs("a", { className: "btn", href: url + "&download=1", onClick: onClose, children: [_jsx(Download, { size: 15 }), "Download"] }), _jsxs("a", { className: "btn primary", href: url, target: "_blank", rel: "noopener noreferrer", onClick: onClose, children: [_jsx(Printer, { size: 15 }), "Open to print"] })] }), children: [_jsx(Field, { label: "Pictures", children: (id) => _jsxs(Select, { id: id, value: size, onChange: (e) => setSize(e.target.value), children: [_jsx("option", { value: "small", children: "Small" }), _jsx("option", { value: "regular", children: "Regular" }), _jsx("option", { value: "large", children: "Large" }), _jsx("option", { value: "original", children: "Original" }), _jsx("option", { value: "links", children: "File links only" })] }) }), _jsxs("div", { className: "field", children: [_jsx("span", { className: "label", children: "Include" }), _jsx("div", { className: "check-grid", children: PDF_SECTIONS.map(([k, l]) => _jsxs("label", { className: "check", children: [_jsx("input", { type: "checkbox", checked: sections.includes(k), onChange: (e) => setSections(e.target.checked ? [...sections, k] : sections.filter((x) => x !== k)) }), _jsx("span", { children: l })] }, k)) })] }), _jsx("p", { className: "small muted", children: "The PDF has a QR code that opens this work order in MPro." })] }));
}
// ---------------------------------------------------------------- attachments
function Attachments({ wo, editable, onChange }) {
    const { toast } = useToast();
    const [busy, setBusy] = useState(0);
    const [view, setView] = useState(null);
    const input = useRef(null);
    const add = async (fl, role = "file") => {
        for (const f of Array.from(fl ?? [])) {
            setBusy((n) => n + 1);
            try {
                await upload(f, { entity_type: "work_order", entity_id: wo.id, role });
            }
            catch (e) {
                toast(e.message, { kind: "error" });
            }
            finally {
                setBusy((n) => n - 1);
            }
        }
        onChange();
    };
    const remove = async (f) => {
        try {
            await api(`/files/links/${f.link_id}`, { method: "DELETE" });
            onChange();
            toast(`Removed ${f.name}`);
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
    };
    const images = wo.attachments.filter((a) => a.is_image);
    const others = wo.attachments.filter((a) => !a.is_image);
    const viewList = [...images, ...others];
    const coverId = wo.cover_url?.split("/files/")[1]?.split("/")[0] ?? null;
    const setCover = async (fileId) => {
        try {
            await api(`/work-orders/${wo.id}/cover`, { method: "PUT", body: { file_id: fileId } });
            onChange();
            toast("Work order image updated");
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
    };
    if (!wo.attachments.length && !editable)
        return null;
    return (_jsx(DropZone, { disabled: !editable, onFiles: (fs) => void add(fs), children: _jsxs("section", { children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("h3", { className: "sec-h", children: ["Pictures and files ", wo.attachments.length > 0 && _jsxs("span", { className: "faint", children: ["(", wo.attachments.length, ")"] })] }), editable && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => input.current?.click(), disabled: busy > 0, children: [_jsx(Paperclip, { size: 14 }), busy ? `Uploading ${busy}…` : "Add"] }), _jsx("input", { ref: input, type: "file", multiple: true, hidden: true, onChange: (e) => { void add(e.target.files); e.target.value = ""; } })] }), !wo.attachments.length && _jsxs("div", { className: "dropzone small", onClick: () => input.current?.click(), children: [_jsx(ImagePlus, { size: 18, className: "faint" }), "Drag photos or files here"] }), images.length > 0 && _jsx("div", { className: "thumbs", children: images.map((f) => (_jsxs("figure", { className: "thumb", children: [_jsx("button", { type: "button", onClick: () => setView(f), "aria-label": `View ${f.name}`, children: _jsx("img", { src: f.thumb_url ?? f.url, alt: f.name, loading: "lazy" }) }), f.role && ["before", "after"].includes(f.role) && _jsx("span", { className: "thumb-tag", children: f.role === "before" ? "Before" : "After" }), f.id === coverId && images.length > 1 && _jsx("span", { className: "cover-tag", children: "Cover" }), editable && _jsx("button", { type: "button", className: "thumb-x", "aria-label": `Remove ${f.name}`, onClick: () => void remove(f), children: _jsx(X, { size: 12 }) })] }, f.id))) }), others.length > 0 && _jsx("div", { className: "files", children: others.map((f) => (_jsxs("div", { className: "file-row", children: [_jsx(FileText, { size: 16, className: "faint" }), _jsx("button", { type: "button", className: "linkbtn grow", style: { textAlign: "left" }, onClick: () => setView(f), children: f.name }), _jsxs("span", { className: "small faint", children: [(f.size / 1024 / 1024).toFixed(f.size > 1048576 ? 1 : 2), " MB"] }), _jsx("a", { className: "btn ghost sm icon", href: f.url + "?download=1", "aria-label": `Download ${f.name}`, children: _jsx(Download, { size: 14 }) }), editable && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Remove ${f.name}`, onClick: () => void remove(f), children: _jsx(X, { size: 14 }) })] }, f.id))) }), view && _jsx(FileViewer, { files: viewList, index: Math.max(0, viewList.findIndex((f) => f.id === view.id)), onClose: () => setView(null), actions: (f) => editable && f.is_image && ["file", "photo", "before", "after"].includes(f.role ?? "file")
                        ? (f.id === coverId ? _jsx("span", { className: "small", style: { color: "var(--c-viewer-muted)" }, children: "Work order image" })
                            : _jsxs(Button, { size: "sm", className: "viewer-btn", "aria-label": "Use as work order image", title: "Use as work order image", onClick: () => void setCover(f.id), children: [_jsx(ImagePlus, { size: 14 }), _jsx("span", { className: "desktop-only", children: "Use as work order image" })] }))
                        : null })] }) }));
}
// ---------------------------------------------------------------- time and costs
function Elapsed({ since }) {
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
    const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
    return _jsxs("span", { className: "mono", children: [String(Math.floor(s / 3600)).padStart(2, "0"), ":", String(Math.floor((s % 3600) / 60)).padStart(2, "0"), ":", String(s % 60).padStart(2, "0")] });
}
function TimeAndCosts({ wo, editable, onChange }) {
    const { session, can } = useSession();
    const opts = useWOOptions();
    const { toast } = useToast();
    const qc = useQueryClient();
    const [addTime, setAddTime] = useState(false);
    const [addCost, setAddCost] = useState(false);
    const c = wo.costs;
    const mine = c.timers.find((t) => t.user.id === session.user?.id);
    const cur = session.org?.currency ?? "USD";
    const err = (e) => toast(e.message, { kind: "error" });
    const after = () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["wo-activity", wo.id] }); };
    const timer = useMutation({
        mutationFn: (start) => start ? api(`/work-orders/${wo.id}/timer`, { method: "POST", body: {} }) : api(`/work-orders/${wo.id}/timer`, { method: "DELETE" }),
        onSuccess: (w, start) => { onChange(w); qc.invalidateQueries({ queryKey: ["my-timers"] }); toast(start ? "Timer started" : "Time logged"); }, onError: err,
    });
    const delTime = useMutation({ mutationFn: (tid) => api(`/work-orders/${wo.id}/time/${tid}`, { method: "DELETE" }), onSuccess: after, onError: err });
    const delCost = useMutation({ mutationFn: (cid) => api(`/work-orders/${wo.id}/costs/${cid}`, { method: "DELETE" }), onSuccess: after, onError: err });
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Time and costs" }), _jsxs("div", { className: "row", children: [editable && wo.status !== "done" && (mine
                                ? _jsxs(Button, { size: "sm", variant: "primary", onClick: () => timer.mutate(false), disabled: timer.isPending, children: [_jsx(Square, { size: 13 }), "Stop ", _jsx(Elapsed, { since: mine.started_at })] })
                                : _jsxs(Button, { size: "sm", onClick: () => timer.mutate(true), disabled: timer.isPending, children: [_jsx(Timer, { size: 14 }), "Start timer"] })), editable && _jsxs(Button, { size: "sm", onClick: () => setAddTime(true), children: [_jsx(Clock, { size: 14 }), "Log time"] }), editable && _jsxs(Button, { size: "sm", onClick: () => setAddCost(true), children: [_jsx(Plus, { size: 14 }), "Add cost"] })] })] }), c.timers.filter((t) => t.user.id !== session.user?.id).map((t) => _jsxs("div", { className: "list-row small", style: { borderLeft: 0 }, children: [_jsx(Timer, { size: 14, className: "faint" }), t.user.name, " has a timer running \u00B7 ", _jsx(Elapsed, { since: t.started_at })] }, t.user.id)), c.time.length === 0 && c.costs.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No time or costs logged yet." }) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Who" }), _jsx("th", { children: "What" }), _jsx("th", { className: "num", children: "Time" }), _jsx("th", { className: "num", children: "Cost" }), _jsx("th", {})] }) }), _jsxs("tbody", { children: [c.time.map((t) => _jsxs("tr", { children: [_jsx("td", { children: _jsxs("span", { className: "row", children: [_jsx(Avatar, { name: t.user.name, initials: t.user.initials, size: "sm" }), t.user.name] }) }), _jsxs("td", { children: [t.time_type, t.note && _jsxs("span", { className: "small muted", children: [" \u00B7 ", t.note] })] }), _jsx("td", { className: "num", children: fmtMinutes(t.minutes) }), _jsx("td", { className: "num", children: c.rates_visible ? money(t.cost_cents, cur) : "—" }), _jsx("td", { children: editable && (t.user.id === session.user?.id || can("users.manage")) && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove time entry", onClick: () => delTime.mutate(t.id), children: _jsx(X, { size: 13 }) }) })] }, t.id)), c.costs.map((x) => _jsxs("tr", { children: [_jsx("td", { children: x.user ? _jsxs("span", { className: "row", children: [_jsx(Avatar, { name: x.user.name, initials: x.user.initials, size: "sm" }), x.user.name] }) : "—" }), _jsxs("td", { children: [x.cost_type, x.description && _jsxs("span", { className: "small muted", children: [" \u00B7 ", x.description] }), x.receipts.map((r) => _jsx("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", className: "small", children: " \u00B7 receipt" }, r.id))] }), _jsx("td", {}), _jsx("td", { className: "num", children: money(x.amount_cents, cur) }), _jsx("td", { children: editable && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove cost", onClick: () => delCost.mutate(x.id), children: _jsx(X, { size: 13 }) }) })] }, x.id))] }), _jsx("tfoot", { children: _jsxs("tr", { children: [_jsx("td", { colSpan: 2, children: _jsx("b", { children: "Total" }) }), _jsx("td", { className: "num", children: _jsx("b", { children: fmtMinutes(c.total_minutes) }) }), _jsx("td", { className: "num", children: _jsx("b", { children: c.rates_visible ? money(c.total_cents, cur) : money(c.other_cents, cur) }) }), _jsx("td", {})] }) })] }) })), !c.rates_visible && c.time.length > 0 && _jsx("div", { className: "card-body small faint", style: { paddingTop: 0 }, children: "Labor costs are hidden for your role." }), addTime && _jsx(TimeModal, { wo: wo, types: opts.data?.settings.time_types ?? ["Work"], onClose: () => setAddTime(false), onDone: after }), addCost && _jsx(CostModal, { wo: wo, types: opts.data?.settings.cost_types ?? ["Other"], onClose: () => setAddCost(false), onDone: after })] }));
}
function TimeModal({ wo, types, onClose, onDone }) {
    const { session, can } = useSession();
    const opts = useWOOptions();
    const { toast } = useToast();
    const [f, setF] = useState({ hours: "", minutes: "", time_type: types.includes("Work") ? "Work" : types[0], user_id: session.user.id, note: "", rate: "" });
    const total = (Number(f.hours) || 0) * 60 + (Number(f.minutes) || 0);
    const m = useMutation({
        mutationFn: () => api(`/work-orders/${wo.id}/time`, { method: "POST", body: { minutes: total, time_type: f.time_type, user_id: f.user_id, note: f.note,
                rate_cents: f.rate === "" ? undefined : Math.round(Number(f.rate) * 100) } }),
        onSuccess: () => { onDone(); onClose(); toast(`Logged ${fmtMinutes(total)}`); }, onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsx(Modal, { title: "Log time", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: total <= 0 || m.isPending, onClick: () => m.mutate(), children: "Log time" })] }), children: _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Hours", children: (id) => _jsx(Input, { id: id, type: "number", min: 0, value: f.hours, onChange: (e) => setF({ ...f, hours: e.target.value }), autoFocus: true }) }), _jsx(Field, { label: "Minutes", children: (id) => _jsx(Input, { id: id, type: "number", min: 0, max: 59, value: f.minutes, onChange: (e) => setF({ ...f, minutes: e.target.value }) }) }), _jsx(Field, { label: "Type", children: (id) => _jsx(Select, { id: id, value: f.time_type, onChange: (e) => setF({ ...f, time_type: e.target.value }), children: types.map((t) => _jsx("option", { children: t }, t)) }) }), _jsx(Field, { label: "Who", children: (id) => _jsx(Select, { id: id, value: f.user_id, disabled: !can("users.manage"), onChange: (e) => setF({ ...f, user_id: e.target.value }), children: (opts.data?.people ?? []).filter((p) => p.assignable).map((p) => _jsx("option", { value: p.id, children: p.name }, p.id)) }) }), wo.costs.rates_visible && _jsx(Field, { label: "Hourly rate override", hint: "Leave empty for their usual rate; 0 for no labor cost.", children: (id) => _jsx(Input, { id: id, type: "number", min: 0, step: "0.01", value: f.rate, onChange: (e) => setF({ ...f, rate: e.target.value }) }) }), _jsx(Field, { label: "Note (optional)", className: wo.costs.rates_visible ? "" : "full", children: (id) => _jsx(Input, { id: id, value: f.note, maxLength: 500, onChange: (e) => setF({ ...f, note: e.target.value }) }) })] }) }));
}
function CostModal({ wo, types, onClose, onDone }) {
    const { session } = useSession();
    const { toast } = useToast();
    const [f, setF] = useState({ amount: "", cost_type: types[types.length - 1], description: "" });
    const [receipts, setReceipts] = useState([]);
    const cents = Math.round((Number(f.amount) || 0) * 100);
    const m = useMutation({
        mutationFn: () => api(`/work-orders/${wo.id}/costs`, { method: "POST", body: { amount_cents: cents, cost_type: f.cost_type, description: f.description, file_ids: receipts.map((r) => r.id) } }),
        onSuccess: () => { onDone(); onClose(); toast("Cost added"); }, onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsxs(Modal, { title: "Add a cost", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: cents <= 0 || m.isPending, onClick: () => m.mutate(), children: "Add cost" })] }), children: [_jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: `Amount (${session.org?.currency ?? "USD"})`, children: (id) => _jsx(Input, { id: id, type: "number", min: 0, step: "0.01", value: f.amount, onChange: (e) => setF({ ...f, amount: e.target.value }), autoFocus: true }) }), _jsx(Field, { label: "Type", children: (id) => _jsx(Select, { id: id, value: f.cost_type, onChange: (e) => setF({ ...f, cost_type: e.target.value }), children: types.map((t) => _jsx("option", { children: t }, t)) }) }), _jsx(Field, { label: "Description", className: "full", children: (id) => _jsx(Input, { id: id, value: f.description, maxLength: 500, placeholder: "e.g. Contractor call-out", onChange: (e) => setF({ ...f, description: e.target.value }) }) })] }), _jsx(DropZone, { accept: "image/*,.pdf", onFiles: async (fs) => { for (const x of fs) {
                    try {
                        const up = await upload(x);
                        setReceipts((r) => [...r, up]);
                    }
                    catch (er) {
                        toast(er.message, { kind: "error" });
                    }
                } }, children: _jsxs("label", { className: "dropzone small", children: [_jsx(Paperclip, { size: 16, className: "faint" }), "Attach receipts or drag them here", _jsx("input", { type: "file", multiple: true, hidden: true, accept: "image/*,.pdf", onChange: async (e) => { for (const x of Array.from(e.target.files ?? [])) {
                                try {
                                    const up = await upload(x);
                                    setReceipts((r) => [...r, up]);
                                }
                                catch (er) {
                                    toast(er.message, { kind: "error" });
                                }
                            } } })] }) }), receipts.length > 0 && _jsx("div", { className: "row wrap", children: receipts.map((r) => _jsx("span", { className: "chip", children: r.name }, r.id)) })] }));
}
// ---------------------------------------------------------------- sub-work orders and links
function MiniRow({ w, extra }) {
    return (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsx(StatusPill, { status: w.status }), _jsxs(Link, { to: `/work-orders/${w.id}`, className: "grow t", style: { color: "var(--c-text)" }, children: [_jsxs("span", { className: "mono faint", children: ["#", w.number] }), " ", w.title] }), _jsx(PriorityBadge, { priority: w.priority }), extra] }));
}
function SubsAndLinks({ wo, editable, onAddSub, onChange }) {
    const { can } = useSession();
    const { toast } = useToast();
    const [adding, setAdding] = useState(false);
    const [num, setNum] = useState("");
    const [kind, setKind] = useState("related");
    const add = useMutation({ mutationFn: () => api(`/work-orders/${wo.id}/links`, { method: "POST", body: { work_order_id: num.replace("#", ""), kind } }),
        onSuccess: (w) => { onChange(w); setAdding(false); setNum(""); }, onError: (e) => toast(e.message, { kind: "error" }) });
    const rm = useMutation({ mutationFn: (lid) => api(`/work-orders/${wo.id}/links/${lid}`, { method: "DELETE" }), onSuccess: onChange,
        onError: (e) => toast(e.message, { kind: "error" }) });
    const closed = wo.sub_work_orders.filter((x) => x.status === "done" || x.status === "canceled").length;
    const blockedBy = wo.links.filter((l) => l.relation === "blocked_by" && !["done", "canceled"].includes(l.work_order.status));
    if (!wo.sub_work_orders.length && !wo.links.length && !editable)
        return null;
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Sub-work orders and links" }), _jsxs("div", { className: "row", children: [editable && can("wo.create") && !wo.parent_id && _jsxs(Button, { size: "sm", onClick: onAddSub, children: [_jsx(ListTree, { size: 14 }), "Add sub-work order"] }), editable && _jsxs(Button, { size: "sm", onClick: () => setAdding(true), children: [_jsx(Link2, { size: 14 }), "Link"] })] })] }), blockedBy.length > 0 && _jsx("div", { className: "card-body", style: { paddingBottom: 0 }, children: _jsxs("div", { className: "banner warning", children: [_jsx(AlertTriangle, { size: 16 }), "Blocked by ", blockedBy.map((l) => `#${l.work_order.number}`).join(", "), ", which ", blockedBy.length === 1 ? "isn't" : "aren't", " done yet."] }) }), wo.sub_work_orders.length > 0 && _jsxs(_Fragment, { children: [_jsxs("div", { className: "card-body small muted", style: { paddingBottom: 4 }, children: [closed, " of ", wo.sub_work_orders.length, " done", _jsx("div", { className: "progress", "aria-hidden": "true", children: _jsx("span", { style: { width: `${(closed / wo.sub_work_orders.length) * 100}%` } }) })] }), wo.sub_work_orders.map((w) => _jsx(MiniRow, { w: w }, w.id))] }), wo.links.map((l) => _jsx(MiniRow, { w: l.work_order, extra: _jsxs(_Fragment, { children: [_jsx("span", { className: "small faint", children: l.relation === "blocks" ? "blocks" : l.relation === "blocked_by" ? "blocked by" : "related" }), editable && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove link", onClick: () => rm.mutate(l.id), children: _jsx(X, { size: 13 }) })] }) }, l.id)), !wo.sub_work_orders.length && !wo.links.length && _jsx("div", { className: "card-body small faint", children: "Break big jobs into sub-work orders, or link related work." }), adding && _jsx(Modal, { title: "Link a work order", onClose: () => setAdding(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setAdding(false), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !num.trim() || add.isPending, onClick: () => add.mutate(), children: "Link" })] }), children: _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Work order number", children: (id) => _jsx(Input, { id: id, placeholder: "#1042", value: num, onChange: (e) => setNum(e.target.value), autoFocus: true }) }), _jsx(Field, { label: "Relationship", children: (id) => _jsxs(Select, { id: id, value: kind, onChange: (e) => setKind(e.target.value), children: [_jsx("option", { value: "related", children: "Related to" }), _jsx("option", { value: "blocks", children: "This blocks it" })] }) })] }) })] }));
}
// ---------------------------------------------------------------- activity feed
function ActivityFeed({ wo, options }) {
    const { session, can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const feed = useQuery({ queryKey: ["wo-activity", wo.id], queryFn: () => api(`/work-orders/${wo.id}/activity`) });
    const [body, setBody] = useState("");
    const [files, setFiles] = useState([]);
    const [editing, setEditing] = useState(null);
    const [viewing, setViewing] = useState(null);
    const [editBody, setEditBody] = useState("");
    const [showHistory, setShowHistory] = useState(true);
    const err = (e) => toast(e.message, { kind: "error" });
    const reload = () => { qc.invalidateQueries({ queryKey: ["wo-activity", wo.id] }); qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); };
    const post = useMutation({ mutationFn: () => api(`/work-orders/${wo.id}/comments`, { method: "POST", body: { body, file_ids: files.map((f) => f.id) } }),
        onSuccess: () => { setBody(""); setFiles([]); reload(); }, onError: err });
    const edit = useMutation({ mutationFn: (cid) => api(`/work-orders/${wo.id}/comments/${cid}`, { method: "PATCH", body: { body: editBody } }),
        onSuccess: () => { setEditing(null); reload(); }, onError: err });
    const del = useMutation({ mutationFn: (cid) => api(`/work-orders/${wo.id}/comments/${cid}`, { method: "DELETE" }), onSuccess: reload, onError: err });
    const react = useMutation({ mutationFn: ({ cid, emoji }) => api(`/work-orders/${wo.id}/comments/${cid}/reactions`, { method: "POST", body: { emoji } }),
        onSuccess: reload, onError: err });
    const people = useMemo(() => Object.fromEntries((options?.people ?? []).map((p) => [p.id, p.name])), [options]);
    const items = (feed.data?.items ?? []).filter((i) => showHistory || i.kind === "comment");
    const end = useRef(null);
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Activity" }), _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: showHistory, onChange: (e) => setShowHistory(e.target.checked) }), _jsx("span", { children: "Show history" })] })] }), _jsxs("div", { className: "feed", children: [feed.isLoading && _jsx(ListSkeleton, { rows: 2 }), items.map((i) => i.kind === "event" ? (_jsxs("div", { className: "feed-ev", children: [_jsx("span", { className: "dot" }), _jsxs("span", { children: [_jsx("b", { children: i.actor_label }), " ", lower(i.summary), i.data?.comment ? _jsxs(_Fragment, { children: [": \u201C", String(i.data.comment), "\u201D"] }) : null] }), _jsx("span", { className: "faint small r", title: dateTime(i.created_at), children: timeAgo(i.created_at) })] }, "e" + i.id)) : (_jsxs("div", { className: "comment", children: [i.author ? _jsx(Avatar, { name: i.author.name, initials: i.author.initials, size: "sm" }) : _jsx("span", { className: "avatar sm" }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row small", children: [_jsx("b", { children: i.author?.name ?? (i.external_name ? `${i.external_name} (outside)` : "Someone") }), _jsxs("span", { className: "faint", title: dateTime(i.created_at), children: [timeAgo(i.created_at), i.edited_at && " · edited"] }), !i.deleted && _jsxs("span", { className: "r row", style: { gap: 2 }, children: [_jsx(Dropdown, { up: true, width: 220, trigger: (_, t) => _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "React", onClick: t, children: _jsx(SmilePlus, { size: 14 }) }), children: (close) => _jsx("div", { className: "row", style: { padding: 6 }, children: REACTIONS.map((e) => _jsx("button", { type: "button", className: "emoji-btn", onClick: () => { close(); react.mutate({ cid: i.id, emoji: e }); }, children: e }, e)) }) }), i.author?.id === session.user?.id && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Edit comment", onClick: () => { setEditing(i.id); setEditBody(i.body); }, children: _jsx(Pencil, { size: 13 }) }), (i.author?.id === session.user?.id || can("wo.delete")) && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Delete comment", onClick: () => del.mutate(i.id), children: _jsx(Trash2, { size: 13 }) })] })] }), i.deleted ? _jsx("p", { className: "faint small", children: "Comment deleted" }) : editing === i.id ? (_jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx(MentionBox, { value: editBody, onChange: setEditBody, options: options, autoFocus: true, onSubmit: () => edit.mutate(i.id) }), _jsxs("div", { className: "row", children: [_jsx(Button, { size: "sm", onClick: () => setEditing(null), children: "Cancel" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => edit.mutate(i.id), children: "Save" })] })] })) : _jsx("p", { className: "prewrap", children: _jsx(RichText, { text: i.body }) }), i.files.length > 0 && _jsx("div", { className: "thumbs sm", children: i.files.map((f) => f.is_image
                                            ? _jsx("button", { type: "button", className: "thumb", "aria-label": `View ${f.name}`, onClick: () => setViewing({ files: i.files, id: f.id }), children: _jsx("img", { src: f.thumb_url ?? f.url, alt: f.name }) }, f.id)
                                            : _jsxs("button", { type: "button", className: "chip", onClick: () => setViewing({ files: i.files, id: f.id }), children: [_jsx(FileText, { size: 13 }), f.name] }, f.id)) }), Object.keys(i.reactions).length > 0 && _jsx("div", { className: "row", style: { gap: 4, marginTop: 4 }, children: Object.entries(i.reactions).map(([e, who]) => (_jsxs("button", { type: "button", className: "reaction" + (who.includes(session.user.id) ? " mine" : ""), title: who.map((u) => people[u] ?? "Someone").join(", "), onClick: () => react.mutate({ cid: i.id, emoji: e }), children: [e, " ", who.length] }, e))) })] })] }, "c" + i.id))), !feed.isLoading && items.length === 0 && _jsx("div", { className: "small faint", style: { padding: "8px 0" }, children: "No comments yet." }), _jsx("div", { ref: end })] }), can("wo.comment") && !wo.deleted && (_jsxs(DropZone, { className: "comment-box", label: "Drop files to attach them", onFiles: async (fs) => { for (const x of fs) {
                    try {
                        const up = await upload(x);
                        setFiles((f) => [...f, up]);
                    }
                    catch (er) {
                        err(er);
                    }
                } }, children: [_jsx(MentionBox, { value: body, onChange: setBody, options: options, placeholder: "Write a comment\u2026 use @ to mention someone", onSubmit: () => { if (body.trim() || files.length)
                            post.mutate(); } }), files.length > 0 && _jsx("div", { className: "row wrap", children: files.map((f) => _jsxs("span", { className: "chip", children: [f.name, _jsx("button", { type: "button", className: "linkbtn", "aria-label": `Remove ${f.name}`, onClick: () => setFiles((x) => x.filter((y) => y.id !== f.id)), children: _jsx(X, { size: 12 }) })] }, f.id)) }), _jsxs("div", { className: "row", children: [_jsxs("label", { className: "btn ghost sm", "aria-label": "Attach files", children: [_jsx(Paperclip, { size: 14 }), _jsx("input", { type: "file", multiple: true, hidden: true, onChange: async (e) => {
                                            for (const x of Array.from(e.target.files ?? [])) {
                                                try {
                                                    const up = await upload(x);
                                                    setFiles((f) => [...f, up]);
                                                }
                                                catch (er) {
                                                    err(er);
                                                }
                                            }
                                            e.target.value = "";
                                        } })] }), _jsxs("span", { className: "small faint grow", children: ["Ctrl + Enter to send", options?.settings.mention_assigns ? " · mentioning someone assigns them" : ""] }), _jsxs(Button, { size: "sm", variant: "primary", disabled: (!body.trim() && !files.length) || post.isPending, onClick: () => post.mutate(), children: [_jsx(Send, { size: 14 }), "Send"] })] })] })), viewing && _jsx(FileViewer, { files: viewing.files, index: Math.max(0, viewing.files.findIndex((f) => f.id === viewing.id)), onClose: () => setViewing(null) })] }));
}
function lower(s) { return s ? s[0].toLowerCase() + s.slice(1) : s; }
const TASK_STATUSES = [
    { id: "open", label: "Open" }, { id: "on_hold", label: "On Hold" }, { id: "in_progress", label: "In Progress" }, { id: "done", label: "Done" }
];
/** Every asset on the work order (MP-124), falling back to the single asset from older responses. */
function woAssetsOf(wo) {
    return wo.assets?.length ? wo.assets : wo.asset ? [wo.asset] : [];
}
/** Asset task list (MP-099): each asset on the work order has its own status and notes, without sub-work orders. */
function AssetTasks({ wo, editable, onChange }) {
    const { toast } = useToast();
    const [notes, setNotes] = useState({});
    const m = useMutation({
        mutationFn: ({ task, body }) => api(`/work-orders/${wo.id}/asset-tasks/${task.id}`, { method: "PATCH", body }),
        onSuccess: (w) => onChange(w), onError: (e) => toast(e.message, { kind: "error" }),
    });
    const done = wo.asset_tasks.filter((t) => t.status === "done").length;
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsxs("h3", { children: [_jsx(ListTree, { size: 16 }), " Asset tasks"] }), _jsxs("span", { className: "small muted", children: [done, " of ", wo.asset_tasks.length, " done"] })] }), _jsx("div", { className: "card-body", style: { paddingTop: 0 }, children: _jsx("div", { className: "progress", "aria-hidden": "true", children: _jsx("span", { style: { width: `${(done / wo.asset_tasks.length) * 100}%` } }) }) }), _jsx("ul", { className: "asset-tasks", children: wo.asset_tasks.map((t) => (_jsxs("li", { className: "asset-task " + t.status, children: [_jsxs("div", { className: "row wrap", style: { gap: 8 }, children: [_jsxs(Link, { to: `/assets/${t.asset.id}`, className: "grow row", style: { gap: 6, minWidth: 160 }, children: [_jsx("span", { className: "astat-dot " + t.asset.status, title: ASSET_STATUS_LABEL[t.asset.status] }), _jsx("span", { className: t.status === "done" ? "strike" : "", children: t.asset.name }), t.asset.location && _jsx("span", { className: "small faint", children: t.asset.location })] }), editable
                                    ? _jsx("div", { className: "seg sm", role: "radiogroup", "aria-label": `Status of ${t.asset.name}`, children: TASK_STATUSES.map((x) => (_jsx("button", { type: "button", role: "radio", "aria-checked": t.status === x.id, className: "seg-btn task-" + x.id + (t.status === x.id ? " on" : ""), disabled: m.isPending, onClick: () => m.mutate({ task: t, body: { status: x.id } }), children: x.label }, x.id))) })
                                    : _jsx(StatusPill, { status: t.status })] }), editable
                            ? _jsx("textarea", { className: "textarea small", rows: 1, "aria-label": `Notes for ${t.asset.name}`, placeholder: "Notes", value: notes[t.id] ?? t.note, onChange: (e) => setNotes((n) => ({ ...n, [t.id]: e.target.value })), onBlur: () => { const v = notes[t.id]; if (v !== undefined && v !== t.note)
                                    m.mutate({ task: t, body: { note: v } }); } })
                            : t.note && _jsx("p", { className: "small prewrap", style: { margin: "4px 0 0" }, children: t.note })] }, t.id))) })] }));
}
