import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Automation builder: When (trigger + targets) → How often (sensitivity) → Only if (conditions) → Then (actions),
// with a live plain-language summary from the server (POST /automations/describe).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Clock, Gauge, Mail, Plus, Sparkles, Trash2, Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { useWOOptions, PRIORITY_LABEL } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select, Toggle } from "../../components/ui";
import { AssigneePicker, CategoryPicker, MultiPicker, assigneeOptions } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import { ACTION_LABEL, ASSET_STATUS, COND_LABEL, RECURRING, TRIGGER_LABEL, WEEKDAYS, WO_STATUS, emptyDoc, useMeterList, } from "./types";
import { AutomationTree } from "./Tree";
const MAX_TARGETS = 250;
export function AutomationBuilder({ edit, init, onClose, onSaved }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const [doc, setDoc] = useState(() => {
        if (edit) {
            const { name, description, active, trigger, targets, conditions, actions, sensitivity, rerun_minutes } = edit;
            return { name, description, active, trigger, targets, conditions, actions, sensitivity, rerun_minutes };
        }
        return { ...emptyDoc(init?.trigger?.type ?? "meter_reading"), ...init };
    });
    const [err, setErr] = useState("");
    const set = (p) => setDoc((d) => ({ ...d, ...p }));
    const kind = doc.trigger.type;
    // live summary, debounced
    const [summary, setSummary] = useState(edit?.summary ?? "");
    const describeKey = JSON.stringify([doc.trigger, doc.targets, doc.conditions, doc.actions, doc.sensitivity]);
    useEffect(() => {
        const ctl = new AbortController();
        const h = setTimeout(() => {
            api("/automations/describe", { method: "POST", body: doc, signal: ctl.signal })
                .then((r) => setSummary(r.summary)).catch(() => undefined);
        }, 300);
        return () => { clearTimeout(h); ctl.abort(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [describeKey]);
    const save = useMutation({
        mutationFn: () => {
            const body = { ...doc, name: doc.name.trim() || autoName(doc) };
            return edit ? api(`/automations/${edit.id}`, { method: "PATCH", body }) : api("/automations", { method: "POST", body });
        },
        onSuccess: (a) => {
            qc.invalidateQueries({ queryKey: ["automations"] });
            qc.invalidateQueries({ queryKey: ["automation", a.id] });
            qc.invalidateQueries({ queryKey: ["meter"] });
            toast(edit ? "Automation saved" : "Automation created");
            onSaved(a);
        },
        onError: (e) => setErr(e.message),
    });
    const switchKind = (k) => {
        if (k === kind)
            return;
        const fresh = emptyDoc(k);
        // keep actions that still make sense; targets switch between meters and assets so they're cleared
        setDoc((d) => ({ ...d, trigger: fresh.trigger, sensitivity: fresh.sensitivity, targets: [], conditions: d.conditions }));
    };
    return (_jsx(Drawer, { title: edit ? "Edit automation" : "New automation", onClose: onClose, width: 640, footer: _jsxs(_Fragment, { children: [err && _jsx("span", { className: "small grow", role: "alert", style: { color: "var(--c-danger)" }, children: err }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => { setErr(""); save.mutate(); }, children: save.isPending ? "Saving…" : edit ? "Save" : "Create" })] }), children: _jsxs("div", { className: "stack auto-builder", children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: doc.name, maxLength: 255, placeholder: autoName(doc) || "e.g. Compressor running hot", onChange: (e) => set({ name: e.target.value }) }) }), _jsxs("div", { className: "auto-summary", "aria-live": "polite", children: [_jsx(Sparkles, { size: 16, "aria-hidden": "true" }), _jsx("span", { children: summary || "Fill in the steps below and a summary appears here." })] }), _jsx(AutomationTree, { doc: doc, defaultOpen: false }), _jsxs(Step, { n: 1, title: "When", children: [_jsx("div", { className: "seg auto-kind", role: "radiogroup", "aria-label": "Trigger", children: Object.keys(TRIGGER_LABEL).map((k) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": kind === k, className: "seg-btn" + (kind === k ? " on" : ""), onClick: () => switchKind(k), children: [k === "meter_reading" ? _jsx(Gauge, { size: 14 }) : k === "asset_status" ? _jsx(Boxes, { size: 14 }) : _jsx(Wrench, { size: 14 }), TRIGGER_LABEL[k]] }, k))) }), _jsx(TriggerFields, { doc: doc, set: set })] }), kind === "meter_reading" && !RECURRING.includes(doc.trigger.condition) && (_jsx(Step, { n: 2, title: "How often", children: _jsx(SensitivityFields, { doc: doc, set: set }) })), _jsx(Step, { n: kind === "meter_reading" && !RECURRING.includes(doc.trigger.condition) ? 3 : 2, title: "Only if (optional)", children: _jsx(ConditionsFields, { value: doc.conditions, onChange: (conditions) => set({ conditions }) }) }), _jsxs(Step, { n: kind === "meter_reading" && !RECURRING.includes(doc.trigger.condition) ? 4 : 3, title: "Then", children: [_jsx(ActionsFields, { value: doc.actions, kind: kind, onChange: (actions) => set({ actions }) }), _jsx(Field, { label: "Don't run again for the same meter or asset within", hint: "Leave empty to run every time it triggers.", children: (id) => _jsx(MinutesInput, { id: id, value: doc.rerun_minutes, onChange: (rerun_minutes) => set({ rerun_minutes }) }) })] }), _jsx(Toggle, { checked: doc.active, onChange: (active) => set({ active }), label: "On", hint: "Turned-off automations keep their history but don't run." }), _jsx(Field, { label: "Notes (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, maxLength: 4000, value: doc.description, onChange: (e) => set({ description: e.target.value }) }) })] }) }));
}
function autoName(doc) {
    const a = doc.actions[0];
    if (a?.type === "create_work_order" && a.title)
        return a.title.replace(/\{\w+\}/g, "").trim();
    if (a?.type === "send_email" && a.subject)
        return a.subject.replace(/\{\w+\}/g, "").trim();
    return "";
}
function Step({ n, title, children }) {
    return (_jsxs("section", { className: "auto-step", "aria-label": title, children: [_jsxs("h3", { className: "auto-step-h", children: [_jsx("span", { className: "auto-step-n", "aria-hidden": "true", children: n }), title] }), _jsx("div", { className: "stack", children: children })] }));
}
// ---------------------------------------------------------------- trigger
function TriggerFields({ doc, set }) {
    const t = doc.trigger;
    const meters = useMeterList();
    const opts = useWOOptions();
    const unit = useMemo(() => meters.data?.items.find((m) => m.id === doc.targets[0])?.unit ?? "", [meters.data, doc.targets]);
    const meterOpts = useMemo(() => (meters.data?.items ?? []).map((m) => ({
        key: m.id, label: m.name, sub: [m.asset?.name, m.unit].filter(Boolean).join(" · "), icon: _jsx(Gauge, { size: 14, className: "faint" }),
    })), [meters.data]);
    const tooMany = doc.targets.length > MAX_TARGETS;
    if (t.type === "meter_reading") {
        const rec = RECURRING.includes(t.condition);
        return _jsxs(_Fragment, { children: [_jsx(Field, { label: "Meters", hint: `Up to ${MAX_TARGETS}. Each meter is tracked on its own.`, error: tooMany ? `Pick ${MAX_TARGETS} or fewer.` : undefined, children: (id) => _jsx(MultiPicker, { id: id, label: "Meters", placeholder: "Pick meters", options: meterOpts, value: doc.targets, onChange: (targets) => set({ targets }), searchPlaceholder: "Search meters", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [_jsx(Gauge, { size: 12 }), s.label] }, s.key)) }) }) }), _jsxs("div", { className: "auto-grid", children: [_jsx(Field, { label: "Reading", children: (id) => (_jsx(Select, { id: id, value: t.condition, onChange: (e) => {
                                    const condition = e.target.value;
                                    set({ trigger: { ...t, condition }, sensitivity: RECURRING.includes(condition) ? {} : doc.sensitivity.mode ? doc.sensitivity : { mode: "once" } });
                                }, children: Object.keys(COND_LABEL).map((c) => _jsx("option", { value: c, children: COND_LABEL[c] }, c)) })) }), _jsx(Field, { label: rec ? "Every" : t.condition.endsWith("_from_last") ? "Amount" : "Value", children: (id) => (_jsxs("span", { className: "auto-unit", children: [_jsx(Input, { id: id, type: "number", step: "any", inputMode: "decimal", value: String(t.value ?? ""), onChange: (e) => set({ trigger: { ...t, value: e.target.value } }) }), unit && _jsx("span", { className: "small muted", children: unit })] })) }), rec && _jsx(Field, { label: "Starting at", hint: "The first reading that triggers it. Empty = one step from now.", children: (id) => (_jsx(Input, { id: id, type: "number", step: "any", inputMode: "decimal", value: String(t.first_at ?? ""), onChange: (e) => set({ trigger: { ...t, first_at: e.target.value } }) })) })] })] });
    }
    const statuses = t.type === "asset_status" ? ASSET_STATUS : WO_STATUS;
    const sOpts = Object.entries(statuses).map(([k, l]) => ({ key: k, label: l }));
    return _jsxs(_Fragment, { children: [_jsx(Field, { label: t.type === "asset_status" ? "Assets" : "Work orders on these assets", hint: `Leave empty for all. Up to ${MAX_TARGETS}.`, error: tooMany ? `Pick ${MAX_TARGETS} or fewer.` : undefined, children: (id) => _jsx(AssetPicker, { id: id, multi: true, value: doc.targets, onChange: (targets) => set({ targets }), placeholder: t.type === "asset_status" ? "Any asset" : "Any asset" }) }), _jsxs("div", { className: "auto-grid", children: [_jsx(Field, { label: "From", children: (id) => _jsx(MultiPicker, { id: id, label: "From", placeholder: "Any status", options: sOpts, value: t.from, onChange: (v) => set({ trigger: { ...t, from: v } }) }) }), _jsx(Field, { label: "To", children: (id) => _jsx(MultiPicker, { id: id, label: "To", placeholder: "Any status", options: sOpts, value: t.to, onChange: (v) => set({ trigger: { ...t, to: v } }) }) })] }), t.type === "work_order_status" && _jsxs("div", { className: "auto-grid", children: [_jsx(Field, { label: "Priority", children: (id) => _jsx(MultiPicker, { id: id, label: "Priority", placeholder: "Any priority", options: Object.entries(PRIORITY_LABEL).map(([k, l]) => ({ key: k, label: l })), value: t.priorities, onChange: (priorities) => set({ trigger: { ...t, priorities } }) }) }), _jsx(Field, { label: "Category", children: (id) => _jsx(CategoryPicker, { id: id, options: opts.data, value: t.categories, onChange: (categories) => set({ trigger: { ...t, categories } }) }) })] })] });
}
// ---------------------------------------------------------------- sensitivity
function SensitivityFields({ doc, set }) {
    const s = doc.sensitivity;
    const mode = s.mode ?? "once";
    const modes = [
        ["once", "Once, then again after a reading back in range"],
        ["every", "Every reading that matches"],
        ["n_of_m", "When enough of the last readings match"],
        ["duration", "When it stays that way for a while"],
    ];
    return _jsxs(_Fragment, { children: [_jsx("div", { className: "auto-radios", role: "radiogroup", "aria-label": "How often", children: modes.map(([k, l]) => (_jsxs("label", { className: "auto-radio" + (mode === k ? " on" : ""), children: [_jsx("input", { type: "radio", name: "sens", checked: mode === k, onChange: () => set({ sensitivity: k === "n_of_m" ? { mode: k, n: s.n ?? 3, m: s.m ?? 5 } : k === "duration" ? { mode: k, minutes: s.minutes ?? 30 } : { mode: k } }) }), l] }, k))) }), mode === "n_of_m" && _jsxs("div", { className: "row wrap small", style: { gap: 6 }, children: [_jsx(Input, { "aria-label": "Readings that must match", type: "number", min: 1, max: 50, style: { width: 70 }, value: s.n ?? "", onChange: (e) => set({ sensitivity: { ...s, n: Number(e.target.value) || undefined } }) }), _jsx("span", { children: "of the last" }), _jsx(Input, { "aria-label": "Readings to look at", type: "number", min: 1, max: 50, style: { width: 70 }, value: s.m ?? "", onChange: (e) => set({ sensitivity: { ...s, m: Number(e.target.value) || undefined } }) }), _jsx("span", { children: "readings" })] }), mode === "duration" && _jsxs("div", { className: "row wrap small", style: { gap: 6 }, children: [_jsx("span", { children: "For longer than" }), _jsx(MinutesInput, { value: s.minutes ?? 0, onChange: (minutes) => set({ sensitivity: { ...s, minutes } }), label: "Duration" })] })] });
}
// ---------------------------------------------------------------- conditions
function ConditionsFields({ value, onChange }) {
    const upd = (i, c) => onChange(value.map((x, j) => (j === i ? c : x)));
    const has = (t) => value.some((c) => c.type === t);
    return _jsxs(_Fragment, { children: [value.length === 0 && _jsx("div", { className: "small faint", children: "Runs whenever the trigger happens. Add a condition to narrow it down." }), value.map((c, i) => (_jsxs("div", { className: "auto-cond", children: [_jsx("span", { className: "auto-cond-k small", children: c.type === "asset_status" ? "Asset is" : c.type === "weekday" ? "Day is" : "Time is between" }), _jsxs("div", { className: "grow", children: [c.type === "asset_status" && _jsx(MultiPicker, { label: "Asset status", placeholder: "Pick statuses", options: Object.entries(ASSET_STATUS).map(([k, l]) => ({ key: k, label: l })), value: c.in, onChange: (v) => upd(i, { ...c, in: v }) }), c.type === "weekday" && _jsx("div", { className: "auto-days", role: "group", "aria-label": "Weekdays", children: WEEKDAYS.map((d, n) => (_jsx("button", { type: "button", "aria-pressed": c.days.includes(n), className: "auto-day" + (c.days.includes(n) ? " on" : ""), onClick: () => upd(i, { ...c, days: c.days.includes(n) ? c.days.filter((x) => x !== n) : [...c.days, n].sort() }), children: d }, d))) }), c.type === "time_window" && _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Input, { type: "time", "aria-label": "From", value: c.from, onChange: (e) => upd(i, { ...c, from: e.target.value }), style: { width: 130 } }), _jsx("span", { className: "small", children: "and" }), _jsx(Input, { type: "time", "aria-label": "To", value: c.to, onChange: (e) => upd(i, { ...c, to: e.target.value }), style: { width: 130 } }), _jsx("span", { className: "small faint desktop-only", children: "org time" })] })] }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove condition", onClick: () => onChange(value.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }, i))), value.length < 10 && _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [!has("asset_status") && _jsxs(Button, { size: "sm", onClick: () => onChange([...value, { type: "asset_status", in: ["online"] }]), children: [_jsx(Plus, { size: 14 }), "Asset status"] }), !has("weekday") && _jsxs(Button, { size: "sm", onClick: () => onChange([...value, { type: "weekday", days: [0, 1, 2, 3, 4] }]), children: [_jsx(Plus, { size: 14 }), "Weekdays"] }), !has("time_window") && _jsxs(Button, { size: "sm", onClick: () => onChange([...value, { type: "time_window", from: "07:00", to: "17:00" }]), children: [_jsx(Clock, { size: 14 }), "Time of day"] })] })] });
}
// ---------------------------------------------------------------- actions
function ActionsFields({ value, kind, onChange }) {
    const upd = (i, a) => onChange(value.map((x, j) => (j === i ? a : x)));
    const add = (t) => onChange([...value, t === "create_work_order" ? { type: t, title: "", priority: "medium" }
            : t === "change_asset_status" ? { type: t, status: "offline", downtime_type: "unplanned" } : { type: t, recipients: [], subject: "" }]);
    const ph = kind === "meter_reading" ? "{meter} {value} {unit} {asset}" : kind === "asset_status" ? "{asset} {status}" : "{work_order} {asset} {status}";
    return _jsxs(_Fragment, { children: [value.map((a, i) => (_jsxs("div", { className: "card auto-action", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("b", { className: "row", style: { gap: 6 }, children: [a.type === "create_work_order" ? _jsx(Wrench, { size: 15 }) : a.type === "send_email" ? _jsx(Mail, { size: 15 }) : _jsx(Boxes, { size: 15 }), ACTION_LABEL[a.type]] }), value.length > 1 && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Remove ${ACTION_LABEL[a.type]}`, onClick: () => onChange(value.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }), a.type === "create_work_order" && _jsx(WOAction, { a: a, ph: ph, onChange: (x) => upd(i, x) }), a.type === "change_asset_status" && _jsxs("div", { className: "auto-grid", children: [_jsx(Field, { label: "Set the asset to", children: (id) => _jsx(Select, { id: id, value: a.status, onChange: (e) => upd(i, { ...a, status: e.target.value, downtime_type: e.target.value === "offline" ? a.downtime_type || "unplanned" : "" }), children: Object.entries(ASSET_STATUS).map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), a.status === "offline" && _jsx(Field, { label: "Downtime", children: (id) => _jsxs(Select, { id: id, value: a.downtime_type || "unplanned", onChange: (e) => upd(i, { ...a, downtime_type: e.target.value }), children: [_jsx("option", { value: "unplanned", children: "Unplanned" }), _jsx("option", { value: "planned", children: "Planned" })] }) }), _jsx(Field, { label: "Reason (optional)", children: (id) => _jsx(Input, { id: id, maxLength: 80, value: a.reason ?? "", onChange: (e) => upd(i, { ...a, reason: e.target.value }) }) }), kind === "meter_reading" || kind === "asset_status" ? null : _jsx("div", { className: "small faint", style: { alignSelf: "end" }, children: "Uses the work order's asset." })] }), a.type === "send_email" && _jsx(EmailAction, { a: a, ph: ph, onChange: (x) => upd(i, x) }), _jsx(Field, { label: "Then wait before doing this again", hint: "Per meter or asset. Empty = no wait.", children: (id) => _jsx(MinutesInput, { id: id, value: a.rerun_minutes ?? 0, onChange: (rerun_minutes) => upd(i, { ...a, rerun_minutes }) }) })] }, i))), value.length < 5 && _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsxs(Button, { size: "sm", onClick: () => add("create_work_order"), children: [_jsx(Plus, { size: 14 }), "Work order"] }), _jsxs(Button, { size: "sm", onClick: () => add("change_asset_status"), children: [_jsx(Plus, { size: 14 }), "Asset status"] }), _jsxs(Button, { size: "sm", onClick: () => add("send_email"), children: [_jsx(Plus, { size: 14 }), "Email"] })] })] });
}
function WOAction({ a, ph, onChange }) {
    const opts = useWOOptions();
    const tpls = useQuery({ queryKey: ["wo-templates"], queryFn: () => api("/work-order-templates") });
    return _jsxs(_Fragment, { children: [_jsx(Field, { label: "From a template (optional)", children: (id) => _jsxs(Select, { id: id, value: a.template_id ?? "", onChange: (e) => onChange({ ...a, template_id: e.target.value || undefined }), children: [_jsx("option", { value: "", children: "No template" }), (tpls.data?.items ?? []).map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] }) }), _jsx(Field, { label: a.template_id ? "Title (overrides the template)" : "Title", hint: `You can use ${ph}.`, children: (id) => _jsx(Input, { id: id, maxLength: 255, value: a.title ?? "", placeholder: a.template_id ? "Template title" : "e.g. Check {meter}: {value} {unit}", onChange: (e) => onChange({ ...a, title: e.target.value }) }) }), _jsx(Field, { label: "Description (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, maxLength: 4000, value: a.description ?? "", onChange: (e) => onChange({ ...a, description: e.target.value }) }) }), _jsxs("div", { className: "auto-grid", children: [_jsx(Field, { label: "Priority", children: (id) => _jsxs(Select, { id: id, value: a.priority ?? "", onChange: (e) => onChange({ ...a, priority: e.target.value || undefined }), children: [a.template_id && _jsx("option", { value: "", children: "From the template" }), Object.entries(PRIORITY_LABEL).map(([k, l]) => _jsx("option", { value: k, children: l }, k))] }) }), _jsx(Field, { label: "Due in (days)", children: (id) => _jsx(Input, { id: id, type: "number", min: 0, max: 3650, value: a.due_in_days ?? "", placeholder: "No due date", onChange: (e) => onChange({ ...a, due_in_days: e.target.value === "" ? "" : Number(e.target.value) }) }) })] }), _jsx(Field, { label: "Assign to", children: (id) => _jsx(AssigneePicker, { id: id, options: opts.data, value: a.assignees ?? [], onChange: (assignees) => onChange({ ...a, assignees }) }) }), _jsx(Field, { label: "Categories", children: (id) => _jsx(CategoryPicker, { id: id, options: opts.data, value: a.categories ?? [], onChange: (categories) => onChange({ ...a, categories }) }) }), _jsx("div", { className: "small faint", children: "The work order goes on the meter's or asset's own asset and location. A new one isn't created while the last one is still open." })] });
}
function EmailAction({ a, ph, onChange }) {
    const opts = useWOOptions();
    const people = useMemo(() => assigneeOptions(opts.data), [opts.data]);
    return _jsxs(_Fragment, { children: [_jsx(Field, { label: "To", children: (id) => _jsx(MultiPicker, { id: id, label: "Recipients", placeholder: "Pick people or teams", options: people, value: a.recipients, onChange: (recipients) => onChange({ ...a, recipients }), searchPlaceholder: "Search people and teams", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) }) }), _jsx(Field, { label: "Subject", hint: `You can use ${ph}.`, children: (id) => _jsx(Input, { id: id, maxLength: 200, value: a.subject, placeholder: "e.g. {meter} is at {value} {unit}", onChange: (e) => onChange({ ...a, subject: e.target.value }) }) }), _jsx(Field, { label: "Message (optional)", hint: "Empty sends the automation's summary.", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, maxLength: 5000, value: a.body ?? "", onChange: (e) => onChange({ ...a, body: e.target.value }) }) })] });
}
// ---------------------------------------------------------------- minutes
const UNITS = [[1, "minutes"], [60, "hours"], [1440, "days"]];
export function MinutesInput({ value, onChange, id, label = "Interval" }) {
    const best = UNITS.slice().reverse().find(([f]) => value && value % f === 0)?.[0] ?? 60;
    const [unit, setUnit] = useState(value ? best : 60);
    const shown = value ? String(value / unit) : "";
    return (_jsxs("span", { className: "row", style: { gap: 6 }, children: [_jsx(Input, { id: id, "aria-label": label, type: "number", min: 0, step: "any", style: { width: 90 }, value: shown, placeholder: "\u2014", onChange: (e) => onChange(e.target.value === "" ? 0 : Math.max(0, Math.round(Number(e.target.value) * unit))) }), _jsx(Select, { "aria-label": `${label} unit`, value: unit, style: { width: 110 }, onChange: (e) => { const u = Number(e.target.value); setUnit(u); if (value)
                    onChange(Math.round((value / unit) * u)); }, children: UNITS.map(([f, l]) => _jsx("option", { value: f, children: l }, f)) })] }));
}
