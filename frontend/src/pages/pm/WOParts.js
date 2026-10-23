import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Preventive-maintenance pieces that live on work-order screens (0.4.0):
// the form's Repeat control, the detail's recurrence chip, the sub-work-order roll-up and the "close the subs too?" offer.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Repeat, SkipForward, StopCircle } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fmtMinutes, money, shortDate } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Modal, Select } from "../../components/ui";
import { ScheduleInput } from "./ScheduleInput";
import "../../styles/pm.css";
/** What the form starts with: the work order's current repeat, or "Does not repeat". */
export function repeatFrom(rec) {
    if (!rec || rec.kind !== "repeat" || !rec.active || !("freq" in rec.spec))
        return null;
    return { ...rec.spec, based_on: rec.interval_mode === "floating" ? "completion" : "due", days_ahead: rec.horizon_days };
}
/** Compact Repeat control for the work-order form. Sub-work orders repeat with their parent; plan work is changed on the plan. */
export function RepeatField({ value, onChange, rec, dueAt, isSub }) {
    if (isSub)
        return null;
    if (rec && rec.kind === "plan") {
        return _jsx(Field, { label: "Repeat", className: "full", children: () => (_jsxs("span", { className: "small muted row", style: { gap: 6 }, children: [_jsx(CalendarClock, { size: 14 }), "From maintenance plan ", _jsx(Link, { to: `/preventive-maintenance/${rec.plan_id}`, children: rec.name })] })) });
    }
    return (_jsx(Field, { label: "Repeat", className: "full", hint: value && !dueAt ? "No due date yet, so the first one is due tomorrow." : undefined, children: (id) => (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [_jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsxs(Select, { id: id, value: value ? "on" : "", style: { width: 180 }, onChange: (e) => onChange(e.target.value ? { freq: "weekly", interval: 1, based_on: "due" } : null), children: [_jsx("option", { value: "", children: "Does not repeat" }), _jsx("option", { value: "on", children: "Repeats\u2026" })] }), value && _jsxs(Select, { "aria-label": "Schedule the next one", value: value.based_on, style: { width: 230 }, onChange: (e) => onChange({ ...value, based_on: e.target.value }), children: [_jsx("option", { value: "due", children: "From the due date (fixed)" }), _jsx("option", { value: "completion", children: "After this one is completed" })] })] }), value && _jsx(ScheduleInput, { value: value, anchor: dueAt, floating: value.based_on === "completion", onChange: (s) => onChange({ ...value, ...s }) })] })) }));
}
/** Save the Repeat choice after the work order itself is saved. Returns the fresh work order when something changed.
 *  The work order is already saved by then, so a failure is reported through onError instead of failing the save. */
export async function applyRepeat(wo, value, before, onError) {
    if (value === undefined || wo.parent_id)
        return wo;
    if (JSON.stringify(value) === JSON.stringify(before))
        return wo;
    try {
        if (value)
            await api(`/work-orders/${wo.id}/repeat`, { method: "PUT", body: value });
        else if (before)
            await api(`/work-orders/${wo.id}/repeat`, { method: "DELETE" });
        else
            return wo;
        return await api(`/work-orders/${wo.id}`);
    }
    catch (e) {
        onError?.(`Work order #${wo.number} was saved, but its repeat wasn't: ${e.message}`);
        return wo;
    }
}
// ---- detail: recurrence chip ----------------------------------------------------------------------------
export function RecurrenceChip({ wo, editable, onChange }) {
    const rec = wo.recurrence;
    const { session, can } = useSession();
    const { toast } = useToast();
    const [ask, setAsk] = useState(null);
    const [reason, setReason] = useState("");
    const tz = session.org?.timezone;
    const act = useMutation({
        mutationFn: (what) => what === "skip"
            ? api(`/work-orders/${wo.id}/repeat/skip-next`, { method: "POST", body: { reason } })
            : api(`/work-orders/${wo.id}/repeat`, { method: "DELETE" }),
        onSuccess: (_r, what) => { setAsk(null); setReason(""); onChange(); toast(what === "skip" ? "Skipped the next one" : "This work order no longer repeats"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!rec)
        return null;
    const isPlan = rec.kind === "plan";
    const label = isPlan ? rec.name : rec.summary;
    const chip = _jsxs("span", { className: "pm-chip" + (rec.active ? "" : " off"), children: [isPlan ? _jsx(CalendarClock, { size: 13 }) : _jsx(Repeat, { size: 13 }), label, !rec.active && " (stopped)"] });
    const canAct = editable && rec.kind === "repeat" && rec.active && !wo.parent_id;
    return _jsxs(_Fragment, { children: [canAct ? (_jsx(Dropdown, { align: "left", width: 260, trigger: (_, t) => _jsx("button", { type: "button", className: "pm-chip-btn", onClick: t, "aria-label": `Repeats: ${label}`, children: chip }), children: (close) => _jsxs(_Fragment, { children: [_jsx("div", { className: "small muted", style: { padding: "6px 10px" }, children: rec.next_due_at ? `Next one due ${shortDate(rec.next_due_at, tz)}` : "No next one scheduled" }), can("pm.skip") && rec.next_key && _jsxs("button", { className: "menu-item", onClick: () => { close(); setAsk("skip"); }, children: [_jsx(SkipForward, { size: 15 }), "Skip next"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setAsk("stop"); }, children: [_jsx(StopCircle, { size: 15 }), "Stop repeating"] })] }) }))
                : isPlan ? _jsx(Link, { to: `/preventive-maintenance/${rec.plan_id}`, className: "pm-chip-btn", title: "Open the maintenance plan", children: chip }) : chip, ask && _jsx(Modal, { title: ask === "skip" ? "Skip the next one?" : "Stop repeating?", onClose: () => setAsk(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setAsk(null), children: "Back" }), _jsx(Button, { variant: ask === "stop" ? "danger" : "primary", className: ask === "stop" ? "solid" : "", disabled: act.isPending || (ask === "skip" && !reason.trim()), onClick: () => act.mutate(ask), children: ask === "skip" ? "Skip it" : "Stop repeating" })] }), children: ask === "skip"
                    ? _jsxs(_Fragment, { children: [_jsxs("p", { children: ["The one due ", rec.next_due_at ? shortDate(rec.next_due_at, tz) : "next", " won't be created (or is canceled if it already was). It counts as skipped in PM compliance."] }), _jsx(Field, { label: "Reason *", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: reason, autoFocus: true, onChange: (e) => setReason(e.target.value), placeholder: "e.g. Line down for retooling" }) })] })
                    : _jsxs("p", { children: ["No more copies of \u201C", wo.title, "\u201D will be created. This one and the ones already created stay as they are."] }) })] });
}
// ---- detail: sub-work order roll-up ------------------------------------------------------------------
export function SubRollup({ wo }) {
    const { session } = useSession();
    const subs = wo.sub_work_orders.length;
    const q = useQuery({ queryKey: ["wo-rollup", wo.id, wo.version], queryFn: () => api(`/work-orders/${wo.id}/rollup`), enabled: subs > 0 });
    if (!subs || !q.data)
        return null;
    const r = q.data;
    const cur = session.org?.currency;
    const anyTime = r.total.minutes > 0 || (r.total.total_cents ?? 0) > 0 || r.total.other_cents > 0;
    if (!anyTime)
        return null;
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Totals with sub-work orders" }) }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table pm-rollup", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Work order" }), _jsx("th", { className: "num", children: "Time" }), _jsx("th", { className: "num", children: "Cost" })] }) }), _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("td", { children: "This work order" }), _jsx("td", { className: "num", children: fmtMinutes(r.own.minutes) }), _jsx("td", { className: "num", children: money(r.own.total_cents, cur) })] }), r.subs.map((s) => _jsxs("tr", { children: [_jsx("td", { children: _jsxs(Link, { to: `/work-orders/${s.id}`, children: ["#", s.number, " ", s.title] }) }), _jsx("td", { className: "num", children: fmtMinutes(s.minutes) }), _jsx("td", { className: "num", children: money(s.total_cents, cur) })] }, s.id))] }), _jsx("tfoot", { children: _jsxs("tr", { children: [_jsx("td", { className: "t", children: "Total" }), _jsx("td", { className: "num t", children: fmtMinutes(r.total.minutes) }), _jsx("td", { className: "num t", children: money(r.total.total_cents, cur) })] }) })] }) })] }));
}
// ---- detail: offer to close open subs when the parent is marked Done ---------------------------------------
export function offerCloseSubs(wo, toast, qc) {
    const open = wo.sub_work_orders.filter((s) => s.status !== "done" && s.status !== "canceled").length;
    if (wo.status !== "done" || !open)
        return;
    toast(`${open} sub-work order${open === 1 ? " is" : "s are"} still open`, {
        action: {
            label: open === 1 ? "Close it" : "Close them",
            run: () => {
                api(`/work-orders/${wo.id}/close-subs`, { method: "POST", body: { status: "done" } })
                    .then((r) => {
                    qc.invalidateQueries({ queryKey: ["work-order", wo.id] });
                    qc.invalidateQueries({ queryKey: ["work-orders"] });
                    toast(r.failed.length ? `Closed ${r.closed.length}; #${r.failed[0].number}: ${r.failed[0].message}` : `Closed ${r.closed.length} sub-work order${r.closed.length === 1 ? "" : "s"}`, r.failed.length ? { kind: "error" } : undefined);
                })
                    .catch((e) => toast(e.message, { kind: "error" }));
            },
        },
    });
}
