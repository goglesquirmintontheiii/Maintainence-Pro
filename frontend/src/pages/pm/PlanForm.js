import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Create / edit a maintenance plan (MP-104): the work order it creates, nested tasks with their own schedules,
// time / meter / whichever-first, fixed or floating, how far ahead work is created, and calendar rules.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Gauge, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fromLocalInput, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { ProcedurePicker } from "../procedures/Picker";
import { ScheduleInput } from "./ScheduleInput";
import { MONTHS } from "./types";
import { NumberInput } from "../../components/NumberInput";
const PRIOS = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const MAX_TASKS = 10;
let seq = 0;
const newKey = () => `n${++seq}`;
function tomorrowAt(hhmm = "08:00") { const d = new Date(Date.now() + 86400000); return new Date(`${d.toISOString().slice(0, 10)}T${hhmm}`).toISOString(); }
const blankTask = () => ({
    key: newKey(), name: "", spec: { freq: "monthly", interval: 1 }, anchor: tomorrowAt(), meter_id: null, every_units: null, lead_units: null, overrides: {}, procedure_ids: [],
});
function fromPlan(p) {
    if (!p)
        return { name: "", description: "", asset_id: null, location_id: null, schedule_kind: "time", interval_mode: "fixed", horizon_days: 14, start_offset_days: 0,
            defaults: { priority: "medium", assignees: [], categories: [] }, calendar: {}, tasks: [blankTask()] };
    return {
        name: p.name, description: p.description, asset_id: p.asset?.id ?? null, location_id: p.location?.id ?? null, schedule_kind: p.schedule_kind,
        interval_mode: p.interval_mode, horizon_days: p.horizon_days, start_offset_days: p.start_offset_days,
        defaults: { priority: "none", assignees: [], categories: [], ...p.defaults }, calendar: p.calendar ?? {},
        tasks: (p.tasks ?? []).map((t) => ({ ...t, key: t.id ?? newKey(), customRule: !!t.rrule && !("freq" in (t.spec ?? {})) })),
    };
}
export function PlanForm({ edit, onClose, onSaved }) {
    const { can } = useSession();
    const opts = useWOOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [d, setD] = useState(() => fromPlan(edit));
    const [err, setErr] = useState("");
    const set = (patch) => { setErr(""); setD((x) => ({ ...x, ...patch })); };
    const setDef = (patch) => set({ defaults: { ...d.defaults, ...patch } });
    const setCal = (patch) => set({ calendar: { ...d.calendar, ...patch } });
    const setTask = (i, patch) => set({ tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
    const timed = d.schedule_kind !== "usage";
    const usage = d.schedule_kind !== "time";
    const meters = useQuery({
        queryKey: ["meters", "pm-pick", d.asset_id], enabled: usage,
        queryFn: () => api(`/meters?per_page=200${d.asset_id ? `&asset_id=${d.asset_id}` : ""}`),
    });
    const payload = () => ({
        name: d.name.trim(), description: d.description, asset_id: d.asset_id, location_id: d.location_id, schedule_kind: d.schedule_kind,
        interval_mode: d.interval_mode, horizon_days: d.horizon_days, start_offset_days: d.start_offset_days, calendar: d.calendar,
        defaults: { ...d.defaults, title: d.defaults.title?.trim() || undefined, estimated_minutes: d.defaults.estimated_minutes || undefined },
        tasks: d.tasks.map((t) => ({
            ...(t.id ? { id: t.id } : {}), name: t.name.trim(), overrides: t.overrides, procedure_ids: t.procedure_ids,
            ...(timed ? (t.customRule ? { anchor: t.anchor } : { anchor: t.anchor, spec: t.spec }) : { spec: null, rrule: null }),
            ...(usage ? { meter_id: t.meter_id, every_units: t.every_units, lead_units: t.lead_units, ...(t.start_units ? { start_units: t.start_units } : {}) } : { meter_id: null, every_units: null }),
        })),
        ...(edit ? { version: edit.version } : {}),
    });
    const save = useMutation({
        mutationFn: () => edit ? api(`/pm/plans/${edit.id}`, { method: "PATCH", body: payload() }) : api("/pm/plans", { method: "POST", body: payload() }),
        onSuccess: (p) => {
            qc.invalidateQueries({ queryKey: ["pm-plans"] });
            qc.invalidateQueries({ queryKey: ["pm-plan", p.id] });
            qc.invalidateQueries({ queryKey: ["pm-calendar"] });
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            toast(edit ? "Plan saved. Changes apply to work that hasn't been created yet." : "Maintenance plan created");
            onClose();
            onSaved?.(p);
        },
        onError: (e) => setErr(e.status === 409 ? "Someone else changed this plan. Close this panel and edit again." : e.message),
    });
    const missing = useMemo(() => {
        const m = [];
        if (!d.name.trim())
            m.push("name");
        d.tasks.forEach((t, i) => {
            const label = d.tasks.length > 1 ? ` (task ${i + 1})` : "";
            if (timed && !t.anchor)
                m.push("first due date" + label);
            if (usage && (!t.meter_id || !t.every_units))
                m.push("meter and interval" + label);
        });
        return m;
    }, [d, timed, usage]);
    const months = d.calendar.months ?? [];
    return (_jsxs(Drawer, { title: edit ? `Edit ${edit.name}` : "New maintenance plan", onClose: onClose, width: 680, footer: _jsxs(_Fragment, { children: [_jsx("span", { className: "small faint grow", children: missing.length ? `Still needed: ${missing.join(", ")}` : edit ? "Only future work changes." : "" }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: missing.length > 0 || save.isPending, onClick: () => save.mutate(), children: save.isPending ? "Saving…" : edit ? "Save" : "Create plan" })] }), children: [_jsx(Field, { label: "Plan name *", children: (id) => _jsx(Input, { id: id, value: d.name, maxLength: 255, placeholder: "e.g. Chiller 1 preventive maintenance", onChange: (e) => set({ name: e.target.value }) }) }), _jsx(Field, { label: "Description", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, maxLength: 4096, value: d.description, onChange: (e) => set({ description: e.target.value }) }) }), _jsxs("div", { className: "form-grid", children: [can("assets.view") && _jsx(Field, { label: "Asset", children: (id) => _jsx(AssetPicker, { id: id, value: d.asset_id ? [d.asset_id] : [], onChange: (v) => set({ asset_id: v[0] ?? null }) }) }), can("locations.view") && _jsx(Field, { label: "Location", children: (id) => _jsx(LocationPicker, { id: id, value: d.location_id, onChange: (v) => set({ location_id: v }) }) })] }), _jsxs("fieldset", { className: "pm-fs", children: [_jsx("legend", { children: "Work order it creates" }), _jsx(Field, { label: "Title", hint: "Leave empty to use the plan and task names.", children: (id) => _jsx(Input, { id: id, value: d.defaults.title ?? "", maxLength: 255, placeholder: d.name || "Plan name", onChange: (e) => setDef({ title: e.target.value }) }) }), _jsx(Field, { label: "Instructions", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: d.defaults.description ?? "", onChange: (e) => setDef({ description: e.target.value }) }) }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Assign to", className: "full", children: (id) => _jsx(AssigneePicker, { id: id, options: opts.data, value: d.defaults.assignees ?? [], onChange: (v) => setDef({ assignees: v }) }) }), _jsx(Field, { label: "Priority", children: () => _jsx(PrioritySeg, { value: d.defaults.priority ?? "none", onChange: (v) => setDef({ priority: v }) }) }), _jsx(Field, { label: "Estimated time (minutes)", children: (id) => _jsx(NumberInput, { id: id, min: 0, step: 5, integer: true, value: d.defaults.estimated_minutes ?? null, onValue: (v) => setDef({ estimated_minutes: v || null }) }) }), _jsx(Field, { label: "Categories", children: (id) => _jsx(CategoryPicker, { id: id, options: opts.data, value: d.defaults.categories ?? [], onChange: (v) => setDef({ categories: v }) }) }), can("procedures.view") && _jsx(Field, { label: "Procedures", children: (id) => _jsx(ProcedurePicker, { id: id, value: d.defaults.procedure_ids ?? [], onChange: (v) => setDef({ procedure_ids: v }) }) }), usage && _jsx(Field, { label: "Due", hint: "For meter-triggered work.", children: (id) => _jsxs("div", { className: "row", children: [_jsx(NumberInput, { id: id, min: 0, max: 365, integer: true, empty: 0, style: { width: 90 }, value: d.defaults.due_in_days ?? 7, onValue: (v) => setDef({ due_in_days: v ?? 0 }) }), _jsx("span", { className: "small muted", children: "days after it's created" })] }) })] })] }), _jsxs("fieldset", { className: "pm-fs", children: [_jsx("legend", { children: "Schedule" }), _jsx("div", { className: "seg", role: "radiogroup", "aria-label": "Schedule by", children: [["time", "Time", CalendarClock], ["usage", "Meter reading", Gauge], ["time_or_usage", "Whichever comes first", CalendarClock]].map(([k, l, Icon]) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": d.schedule_kind === k, className: "seg-btn" + (d.schedule_kind === k ? " on" : ""), onClick: () => set({ schedule_kind: k }), children: [_jsx(Icon, { size: 14 }), l] }, k))) }), timed && _jsx(Field, { label: "Next visit is planned from", children: (id) => _jsxs(Select, { id: id, value: d.interval_mode, style: { maxWidth: 360 }, onChange: (e) => set({ interval_mode: e.target.value }), children: [_jsx("option", { value: "fixed", children: "The original schedule (fixed)" }), _jsx("option", { value: "floating", children: "When the last one was completed (floating)" })] }) }), _jsxs("div", { className: "stack pm-task-list", children: [d.tasks.map((t, i) => (_jsxs("div", { className: "pm-task card", children: [_jsxs("div", { className: "row", children: [_jsx(Input, { "aria-label": `Task ${i + 1} name`, value: t.name, maxLength: 255, placeholder: d.tasks.length > 1 ? `Task ${i + 1}, e.g. Quarterly inspection` : "Task name (optional)", onChange: (e) => setTask(i, { name: e.target.value }), className: "grow" }), d.tasks.length > 1 && _jsx(Button, { icon: true, variant: "ghost", "aria-label": `Remove task ${i + 1}`, onClick: () => set({ tasks: d.tasks.filter((_, j) => j !== i) }), children: _jsx(Trash2, { size: 15 }) })] }), timed && _jsxs("div", { className: "pm-task-grid", children: [_jsx(Field, { label: "First due", children: (id) => _jsx(Input, { id: id, type: "datetime-local", value: toLocalInput(t.anchor), onChange: (e) => setTask(i, { anchor: fromLocalInput(e.target.value) }) }) }), t.customRule
                                                ? _jsx(Field, { label: "Repeats", children: () => _jsxs("span", { className: "small muted", children: [t.summary || t.rrule, " ", _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setTask(i, { customRule: false, spec: { freq: "monthly", interval: 1 } }), children: "Change" })] }) })
                                                : _jsx(Field, { label: "Repeats", children: () => _jsx(ScheduleInput, { idPrefix: `t${i}`, value: t.spec, anchor: t.anchor, floating: d.interval_mode === "floating", onChange: (s) => setTask(i, { spec: s }) }) })] }), usage && _jsxs("div", { className: "pm-task-grid three", children: [_jsx(Field, { label: "Meter", children: (id) => _jsxs(Select, { id: id, value: t.meter_id ?? "", onChange: (e) => setTask(i, { meter_id: e.target.value || null }), children: [_jsx("option", { value: "", children: meters.isLoading ? "Loading…" : (meters.data?.items.length ?? 0) ? "Pick a meter" : "No meters" + (d.asset_id ? " on this asset" : "") }), meters.data?.items.map((m) => _jsxs("option", { value: m.id, children: [m.name, m.asset ? ` · ${m.asset.name}` : "", m.last_value !== null ? ` (now ${m.last_value.toLocaleString()} ${m.unit})` : ""] }, m.id))] }) }), _jsx(Field, { label: "Every", children: (id) => _jsx(NumberInput, { id: id, min: 0, value: t.every_units ?? null, placeholder: "e.g. 2000", onValue: (v) => setTask(i, { every_units: v || null }) }) }), _jsx(Field, { label: "Create ahead", hint: "Units before it's due", children: (id) => _jsx(NumberInput, { id: id, min: 0, value: t.lead_units ?? null, placeholder: "0", onValue: (v) => setTask(i, { lead_units: v || null }) }) })] }), _jsxs("details", { className: "pm-task-more", children: [_jsxs("summary", { className: "small", children: ["Task details", (t.overrides.priority || t.overrides.estimated_minutes || t.procedure_ids.length) ? " (set)" : ""] }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Priority", hint: "The highest priority wins when tasks share a work order.", children: (id) => _jsxs(Select, { id: id, value: t.overrides.priority ?? "", onChange: (e) => setTask(i, { overrides: { ...t.overrides, priority: e.target.value || undefined } }), children: [_jsx("option", { value: "", children: "Same as the plan" }), PRIOS.slice(1).map(([k, l]) => _jsx("option", { value: k, children: l }, k))] }) }), _jsx(Field, { label: "Estimated time (minutes)", children: (id) => _jsx(NumberInput, { id: id, min: 0, step: 5, integer: true, value: t.overrides.estimated_minutes ?? null, onValue: (v) => setTask(i, { overrides: { ...t.overrides, estimated_minutes: v || undefined } }) }) }), _jsx(Field, { label: "Instructions", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: t.overrides.description ?? "", onChange: (e) => setTask(i, { overrides: { ...t.overrides, description: e.target.value || undefined } }) }) }), can("procedures.view") && _jsx(Field, { label: "Procedures", className: "full", children: (id) => _jsx(ProcedurePicker, { id: id, value: t.procedure_ids, onChange: (v) => setTask(i, { procedure_ids: v }) }) })] })] })] }, t.key))), d.tasks.length < MAX_TASKS && _jsxs("div", { children: [_jsxs(Button, { size: "sm", onClick: () => set({ tasks: [...d.tasks, blankTask()] }), children: [_jsx(Plus, { size: 14 }), "Add a task"] }), _jsx("span", { className: "small muted", style: { marginLeft: 8 }, children: "e.g. monthly checks, a quarterly inspection and an annual overhaul in one plan" })] })] })] }), _jsxs("fieldset", { className: "pm-fs", children: [_jsx("legend", { children: "When work is created" }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Create work orders", hint: "Scheduling window: how far ahead of the due date.", children: (id) => _jsxs("div", { className: "row", children: [_jsx(NumberInput, { id: id, min: 0, max: 365, integer: true, empty: 0, style: { width: 90 }, value: d.horizon_days, onValue: (v) => set({ horizon_days: v ?? 0 }) }), _jsx("span", { className: "small muted", children: "days ahead" })] }) }), _jsx(Field, { label: "Start date", hint: "Shows in To Do this many days before it's due.", children: (id) => _jsxs("div", { className: "row", children: [_jsx(NumberInput, { id: id, min: 0, max: 365, integer: true, empty: 0, style: { width: 90 }, value: d.start_offset_days, onValue: (v) => set({ start_offset_days: v ?? 0 }) }), _jsx("span", { className: "small muted", children: "days before due" })] }) })] }), timed && _jsxs(_Fragment, { children: [_jsx(Field, { label: "Months", hint: months.length ? "Visits outside these months are skipped (seasonal)." : "All year.", children: () => (_jsx("div", { className: "pm-months", role: "group", "aria-label": "Months", children: MONTHS.map((m, i) => {
                                        const on = !months.length || months.includes(i + 1);
                                        return _jsx("button", { type: "button", className: "pm-day" + (on ? " on" : ""), "aria-pressed": on, onClick: () => {
                                                const cur = months.length ? months : MONTHS.map((_, j) => j + 1);
                                                const next = on ? cur.filter((x) => x !== i + 1) : [...cur, i + 1].sort((a, b) => a - b);
                                                setCal({ months: next.length === 12 ? [] : next.length ? next : cur });
                                            }, children: m }, m);
                                    }) })) }), _jsxs("div", { className: "row wrap", style: { gap: 16 }, children: [_jsx(Checkbox, { checked: !!d.calendar.skip_weekends, onChange: (v) => setCal({ skip_weekends: v }), label: "Not on weekends" }), _jsx(Checkbox, { checked: !!d.calendar.skip_holidays, onChange: (v) => setCal({ skip_holidays: v }), label: "Not on holidays" }), (d.calendar.skip_weekends || d.calendar.skip_holidays) && _jsxs(Select, { "aria-label": "When it lands on one", value: d.calendar.shift ?? "previous", style: { width: 230 }, onChange: (e) => setCal({ shift: e.target.value }), children: [_jsx("option", { value: "previous", children: "Move to the workday before" }), _jsx("option", { value: "next", children: "Move to the workday after" }), _jsx("option", { value: "skip", children: "Skip that visit" })] })] })] })] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
function PrioritySeg({ value, onChange }) {
    return _jsx("div", { className: "seg", role: "radiogroup", "aria-label": "Priority", children: PRIOS.map(([k, l]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": value === k, className: "seg-btn prio-" + k + (value === k ? " on" : ""), onClick: () => onChange(k), children: l }, k))) });
}
