import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// One maintenance plan: what it creates and when, the next visits (move / reassign / postpone / skip each one) and history.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CalendarClock, CalendarPlus, Gauge, MapPin, MoreHorizontal, Package, Pause, Pencil, Play, Repeat, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { fmtMinutes, fromLocalInput, shortDate, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill } from "../../components/ui";
import { AssigneePicker } from "../../components/pickers";
import { PlanForm } from "./PlanForm";
import { fmtUnits, OCC_LABEL, OCC_TONE, pctLabel, pctTone, usePlan } from "./types";
const KIND_LABEL = { time: "Time-based", usage: "Meter-based", time_or_usage: "Time or meter, whichever comes first" };
export function PlanDetail({ id }) {
    const q = usePlan(id);
    const { session, can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const tz = session.org?.timezone;
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const preview = useQuery({ queryKey: ["pm-preview", id, q.data?.version], queryFn: () => api(`/pm/plans/${id}/preview?count=12`), enabled: !!q.data });
    const history = useQuery({ queryKey: ["pm-history", id, q.data?.version], queryFn: () => api(`/pm/plans/${id}/history`), enabled: !!q.data });
    const refresh = () => {
        for (const k of ["pm-plan", "pm-preview", "pm-history"])
            qc.invalidateQueries({ queryKey: [k, id] });
        qc.invalidateQueries({ queryKey: ["pm-plans"] });
        qc.invalidateQueries({ queryKey: ["pm-calendar"] });
        qc.invalidateQueries({ queryKey: ["work-orders"] });
    };
    const err = (e) => toast(e.message, { kind: "error" });
    const pause = useMutation({
        mutationFn: (on) => api(`/pm/plans/${id}/${on ? "resume" : "pause"}`, { method: "POST" }),
        onSuccess: (_r, on) => { refresh(); toast(on ? "Plan resumed" : "Plan paused. No new work orders will be created."); }, onError: err,
    });
    const gen = useMutation({
        mutationFn: () => api(`/pm/plans/${id}/generate`, { method: "POST" }),
        onSuccess: (r) => { refresh(); toast(r.created ? `Created ${r.created} work order${r.created === 1 ? "" : "s"}` : "Nothing is due within the scheduling window yet"); }, onError: err,
    });
    const del = useMutation({
        mutationFn: () => api(`/pm/plans/${id}`, { method: "DELETE" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["pm-plans"] }); toast("Plan deleted"); nav("/preventive-maintenance"); }, onError: err,
    });
    if (q.isLoading)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 8 }) });
    if (q.isError || !q.data)
        return _jsx("div", { className: "detail", children: _jsx(EmptyState, { title: "Can't open this plan", children: q.error?.message }) });
    const p = q.data;
    const manage = can("pm.manage") && !p.deleted;
    const repeat = p.kind === "repeat";
    const comp = p.compliance;
    return (_jsxs("div", { className: "detail pm-detail", children: [_jsxs(Link, { to: "/preventive-maintenance", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All plans"] }), _jsxs("div", { className: "wo-head", children: [_jsxs("div", { className: "grow", children: [_jsx("div", { className: "row small muted", style: { gap: 6 }, children: repeat ? _jsxs(_Fragment, { children: [_jsx(Repeat, { size: 13 }), "Repeating work order"] }) : _jsxs(_Fragment, { children: [_jsx(CalendarClock, { size: 13 }), "Maintenance plan"] }) }), _jsx("h1", { className: "wo-title", children: p.name }), _jsxs("div", { className: "row wrap", style: { marginTop: 6 }, children: [p.active ? _jsx(Pill, { tone: "success", children: "Active" }) : _jsx(Pill, { tone: "warning", children: "Paused" }), p.deleted && _jsx(Pill, { tone: "danger", children: "Deleted" }), _jsx("span", { className: "small muted", children: p.frequency })] })] }), manage && _jsxs("div", { className: "row", children: [!repeat && _jsxs(Button, { onClick: () => setEditing(true), "aria-label": "Edit", children: [_jsx(Pencil, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Edit" })] }), _jsx(Button, { onClick: () => pause.mutate(!p.active), disabled: pause.isPending, children: p.active ? _jsxs(_Fragment, { children: [_jsx(Pause, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Pause" })] }) : _jsxs(_Fragment, { children: [_jsx(Play, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Resume" })] }) }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 250, children: (close) => _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", disabled: !p.active, onClick: () => { close(); gen.mutate(); }, children: [_jsx(CalendarPlus, { size: 15 }), "Create due work orders now"] }), can("pm.delete") && _jsxs("button", { className: "menu-item danger", onClick: () => { close(); setConfirmDelete(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete plan"] })] }) })] })] }), repeat && p.source_work_order_id && _jsxs("div", { className: "banner info small", children: [_jsx(Repeat, { size: 16 }), _jsxs("div", { className: "grow", children: ["This repeats a work order. Change how often it repeats from the work order's ", _jsx("b", { children: "Edit" }), " panel."] }), _jsx(Link, { to: `/work-orders/${p.source_work_order_id}`, className: "linkbtn small", children: "Open work order" })] }), p.last_problem && _jsxs("div", { className: "banner warning small", role: "status", children: [_jsx(AlertTriangle, { size: 16 }), _jsxs("div", { className: "grow", children: [_jsx("b", { children: "Problem with this plan:" }), " ", p.last_problem.replace(/\.$/, ""), ". Check its details in ", _jsx("b", { children: "Edit" }), "."] })] }), p.description && _jsx("p", { className: "prewrap", children: p.description }), _jsxs("div", { className: "tiles pm-tiles", children: [_jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Next due" }), _jsx("div", { className: "v sm", children: p.next_due_at ? shortDate(p.next_due_at, tz) : "—" })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "On time (last 12 months)" }), _jsx("div", { className: "v sm " + pctTone(comp?.percent), children: pctLabel(comp?.percent) }), comp && _jsxs("div", { className: "small muted", children: [comp.on_time, " on time \u00B7 ", comp.late, " late \u00B7 ", comp.missed, " missed \u00B7 ", comp.skipped, " skipped"] })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Creates work" }), _jsxs("div", { className: "v sm", children: [p.horizon_days, " day", p.horizon_days === 1 ? "" : "s", " ahead"] }), p.start_offset_days > 0 && _jsxs("div", { className: "small muted", children: ["Starts ", p.start_offset_days, " day", p.start_offset_days === 1 ? "" : "s", " before due"] })] })] }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { children: [_jsx("dt", { children: "Schedule" }), _jsxs("dd", { children: [KIND_LABEL[p.schedule_kind], p.interval_mode === "floating" ? " · from last completion" : " · fixed dates"] })] }), p.asset && _jsxs("div", { children: [_jsx("dt", { children: "Asset" }), _jsx("dd", { children: _jsxs(Link, { to: `/assets/${p.asset.id}`, className: "row", style: { gap: 6 }, children: [_jsx(Package, { size: 14, className: "faint" }), p.asset.name] }) })] }), p.location && _jsxs("div", { children: [_jsx("dt", { children: "Location" }), _jsx("dd", { children: _jsxs(Link, { to: `/locations/${p.location.id}`, className: "row", style: { gap: 6 }, children: [_jsx(MapPin, { size: 14, className: "faint" }), p.location.name] }) })] }), _jsx(CalendarRules, { p: p }), p.defaults.estimated_minutes ? _jsxs("div", { children: [_jsx("dt", { children: "Estimated time" }), _jsx("dd", { children: fmtMinutes(p.defaults.estimated_minutes) })] }) : null, _jsxs("div", { children: [_jsx("dt", { children: "Time zone" }), _jsx("dd", { children: p.timezone })] })] }), !repeat && (p.tasks?.length ?? 0) > 0 && _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Tasks" }), _jsx("span", { className: "small muted", children: "Tasks due the same day go on one work order" })] }), _jsx("ul", { className: "pm-tasks", children: p.tasks.map((t) => (_jsxs("li", { children: [_jsx("div", { className: "t", children: t.name || p.name }), _jsxs("div", { className: "small muted row wrap", style: { gap: 10 }, children: [t.summary && _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx(CalendarClock, { size: 13 }), t.summary] }), t.every_units ? _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx(Gauge, { size: 13 }), "Every ", fmtUnits(t.every_units), " \u00B7 next at ", fmtUnits(t.next_units)] }) : null, t.overrides.priority && _jsxs("span", { children: ["Priority ", t.overrides.priority] }), t.overrides.estimated_minutes ? _jsx("span", { children: fmtMinutes(t.overrides.estimated_minutes) }) : null, t.procedure_ids.length > 0 && _jsxs("span", { children: [t.procedure_ids.length, " procedure", t.procedure_ids.length === 1 ? "" : "s"] })] })] }, t.id))) })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Upcoming" }), _jsx("span", { className: "small muted", children: "Changing one visit leaves the rest of the schedule alone" })] }), preview.isLoading ? _jsx("div", { className: "card-body", children: _jsx(ListSkeleton, { rows: 3 }) })
                        : (preview.data?.items.length ?? 0) === 0 ? _jsx("div", { className: "card-body small faint", children: p.active ? (p.schedule_kind === "usage" ? "Work is created when the meter gets close to the next interval." : "Nothing in the next year.") : "Paused." })
                            : _jsx("ul", { className: "pm-occ", children: preview.data.items.map((o) => _jsx(OccRow, { planId: id, o: o, manage: manage, onDone: refresh }, o.key)) })] }), (history.data?.items.length ?? 0) > 0 && _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "History" }) }), _jsx("ul", { className: "pm-occ", children: history.data.items.map((o) => _jsx(OccRow, { planId: id, o: o, manage: false, onDone: refresh, past: true }, o.key)) })] }), editing && _jsx(PlanForm, { edit: p, onClose: () => setEditing(false), onSaved: () => refresh() }), confirmDelete && _jsx(Modal, { title: `Delete ${p.name}?`, onClose: () => setConfirmDelete(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Keep it" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsx("p", { children: "No more work orders will be created from this plan. Work orders it already created stay, and so does its compliance history." }) })] }));
}
function CalendarRules({ p }) {
    const c = p.calendar;
    const bits = [];
    if (c.months?.length && c.months.length < 12)
        bits.push("Only in " + c.months.map((m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]).join(", "));
    const skips = [c.skip_weekends && "weekends", c.skip_holidays && "holidays"].filter(Boolean);
    if (skips.length)
        bits.push(`Not on ${skips.join(" or ")} (${c.shift === "next" ? "moves to the next workday" : c.shift === "skip" ? "skipped" : "moves to the previous workday"})`);
    if (!bits.length)
        return null;
    return _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Calendar" }), _jsx("dd", { children: bits.join(" · ") })] });
}
function OccRow({ planId, o, manage, onDone, past }) {
    const { session, can } = useSession();
    const tz = session.org?.timezone;
    const [act, setAct] = useState(null);
    const closed = ["completed", "skipped", "canceled"].includes(o.status) || (o.work_order && ["done", "canceled"].includes(o.work_order.status));
    const { toast } = useToast();
    const unskip = useMutation({
        mutationFn: () => api(`/pm/plans/${planId}/occurrences/${encodeURIComponent(o.key)}`, { method: "POST", body: { action: "unskip" } }),
        onSuccess: () => { onDone(); toast("Back on the schedule"); }, onError: (e) => toast(e.message, { kind: "error" }),
    });
    const due = o.due_at ? shortDate(o.due_at, tz) : o.due_units !== null ? `at ${fmtUnits(o.due_units)}` : "—";
    return (_jsxs("li", { className: "pm-occ-row" + (o.status === "skipped" ? " skipped" : ""), children: [_jsxs("div", { className: "pm-occ-date", children: [_jsx("span", { className: "d", title: o.due_at ? dateTime(o.due_at, tz) : undefined, children: due }), o.original_due_at && _jsxs("span", { className: "small faint", children: ["was ", shortDate(o.original_due_at, tz)] })] }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Pill, { tone: OCC_TONE[o.status], children: OCC_LABEL[o.status] }), o.work_order && _jsxs(Link, { to: `/work-orders/${o.work_order.id}`, className: "small", children: ["#", o.work_order.number] }), o.tasks.filter((t) => t.name).length > 0 && _jsx("span", { className: "small muted", children: o.tasks.map((t) => t.name).filter(Boolean).join(", ") })] }), o.skip_reason && _jsxs("div", { className: "small muted", children: [o.status === "skipped" ? "Skipped" : "Postponed", ": ", o.skip_reason] }), past && o.completed_at && _jsxs("div", { className: "small faint", children: ["Completed ", shortDate(o.completed_at, tz)] })] }), manage && !past && (o.status === "skipped"
                ? can("pm.skip") && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => unskip.mutate(), disabled: unskip.isPending, children: "Unskip" })
                : !closed && o.due_at && _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { size: "sm", icon: true, variant: "ghost", "aria-label": `Change the visit due ${due}`, onClick: t, children: _jsx(MoreHorizontal, { size: 16 }) }), width: 200, children: (close) => _jsxs(_Fragment, { children: [_jsx("button", { className: "menu-item", onClick: () => { close(); setAct("move"); }, children: "Move to another date" }), _jsx("button", { className: "menu-item", onClick: () => { close(); setAct("reassign"); }, children: "Reassign" }), can("pm.skip") && _jsx("button", { className: "menu-item", onClick: () => { close(); setAct("postpone"); }, children: "Postpone" }), can("pm.skip") && _jsx("button", { className: "menu-item danger", onClick: () => { close(); setAct("skip"); }, children: "Skip" })] }) })), act && _jsx(OccDialog, { planId: planId, o: o, act: act, onClose: () => setAct(null), onDone: () => { setAct(null); onDone(); } })] }));
}
const ACT_TITLE = { move: "Move this visit", reassign: "Reassign this visit", postpone: "Postpone this visit", skip: "Skip this visit" };
function OccDialog({ planId, o, act, onClose, onDone }) {
    const opts = useWOOptions();
    const { toast } = useToast();
    const [due, setDue] = useState(toLocalInput(o.due_at));
    const [who, setWho] = useState(o.overrides.assignees ?? []);
    const [reason, setReason] = useState("");
    const needReason = act === "skip" || act === "postpone";
    const m = useMutation({
        mutationFn: () => api(`/pm/plans/${planId}/occurrences/${encodeURIComponent(o.key)}`, { method: "POST", body: {
                action: act, reason: reason || undefined, ...(act === "move" || act === "postpone" ? { due_at: fromLocalInput(due) } : {}), ...(act === "reassign" ? { assignees: who } : {}),
            } }),
        onSuccess: () => { toast(act === "skip" ? "Skipped" : act === "reassign" ? "Reassigned" : "Moved"); onDone(); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const ok = (!needReason || reason.trim()) && ((act !== "move" && act !== "postpone") || due);
    return (_jsxs(Modal, { title: ACT_TITLE[act], onClose: onClose, width: 480, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Back" }), _jsx(Button, { variant: act === "skip" ? "danger" : "primary", className: act === "skip" ? "solid" : "", disabled: !ok || m.isPending, onClick: () => m.mutate(), children: act === "skip" ? "Skip visit" : "Save" })] }), children: [act === "skip" && _jsxs("p", { className: "small muted", children: [o.work_order ? `Work order #${o.work_order.number} will be canceled. ` : "", "It counts as skipped in compliance; the rest of the schedule stays."] }), act === "postpone" && _jsx("p", { className: "small muted", children: "Compliance still judges this visit against its original date." }), act === "move" && _jsxs("p", { className: "small muted", children: ["Moves only this visit", o.work_order ? ` and work order #${o.work_order.number}` : "", "."] }), (act === "move" || act === "postpone") && _jsx(Field, { label: "New due date", children: (id) => _jsx(Input, { id: id, type: "datetime-local", value: due, onChange: (e) => setDue(e.target.value) }) }), act === "reassign" && _jsx(Field, { label: "Assign to", children: (id) => _jsx(AssigneePicker, { id: id, options: opts.data, value: who, onChange: setWho }) }), needReason && _jsx(Field, { label: "Reason *", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: reason, autoFocus: true, onChange: (e) => setReason(e.target.value), placeholder: "e.g. Parts on back order" }) })] }));
}
