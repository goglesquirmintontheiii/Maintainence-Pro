import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Cycle counts (r222): scheduled counts create a work order; counters enter what's on the shelf; finishing the work
// order (or "Apply") records the differences as "count" corrections in the ledger.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck, Download, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWOOptions } from "../../lib/wo";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssigneePicker, MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { usePartOptions } from "./types";
import "./parts.css";
const SCHEDULES = [["", "Only when started by hand"], ["FREQ=WEEKLY;BYDAY=MO", "Every week (Monday)"], ["FREQ=MONTHLY;BYMONTHDAY=1", "Every month (1st)"],
    ["FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", "Every 3 months"], ["FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1", "Every year (January 1)"]];
const scheduleLabel = (r) => SCHEDULES.find(([k]) => k === r)?.[1] ?? (r ? "Custom schedule" : "Started by hand");
export function CycleCountsPage({ runId }) {
    const { can, session } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["cycle-counts"], queryFn: () => api("/cycle-counts") });
    const [edit, setEdit] = useState(null);
    const err = (e) => toast(e.message, { kind: "error" });
    const start = useMutation({ mutationFn: (c) => api(`/cycle-counts/${c.id}/start`, { method: "POST" }),
        onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["cycle-counts"] }); toast("Count started. It's on a work order now.", { action: r.work_order_id ? { label: "Open", run: () => nav(`/work-orders/${r.work_order_id}`) } : undefined }); },
        onError: err });
    const del = useMutation({ mutationFn: (c) => api(`/cycle-counts/${c.id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["cycle-counts"] }), onError: err });
    const tz = session.org?.timezone;
    if (runId)
        return _jsx("div", { className: "wo-page", children: _jsxs("div", { className: "wo-scroll page-narrow", children: [_jsxs(Link, { to: "/parts/cycle-counts", className: "row small", children: [_jsx(ArrowLeft, { size: 14 }), "Cycle counts"] }), _jsx(RunPanel, { runId: runId })] }) });
    return (_jsx("div", { className: "wo-page", children: _jsxs("div", { className: "wo-scroll page-narrow", children: [_jsxs(Link, { to: "/parts", className: "row small", children: [_jsx(ArrowLeft, { size: 14 }), "Parts"] }), _jsxs("div", { className: "row", style: { justifyContent: "space-between", margin: "8px 0 12px" }, children: [_jsx("h1", { children: "Cycle counts" }), can("parts.counts") && _jsxs(Button, { variant: "primary", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 16 }), "New count"] })] }), _jsx("p", { className: "small muted", style: { marginTop: 0 }, children: "Count part of your stock regularly instead of everything at once. Each count becomes a work order; when it's done, the differences correct the stock." }), !q.data ? _jsx(ListSkeleton, { rows: 3 }) : q.data.items.length === 0 ? _jsx(EmptyState, { icon: _jsx(ClipboardCheck, { size: 26 }), title: "No cycle counts yet", children: can("parts.counts") ? "Set one up for a storeroom, a part type or an aisle." : "Counts your team schedules show here." })
                    : _jsx("section", { className: "card", children: q.data.items.map((c) => (_jsxs("div", { className: "list-row part-count-row", children: [_jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsxs("div", { className: "t", children: [c.name, " ", !c.active && _jsx(Pill, { children: "Paused" })] }), _jsx("div", { className: "s", children: [c.location?.name ?? "Every location", scheduleLabel(c.rrule), c.next_at ? `next ${dateTime(c.next_at, tz)}` : ""].filter(Boolean).join(" · ") }), c.last_run && _jsxs("div", { className: "s", children: ["Last: ", c.last_run.status === "open" ? "in progress" : c.last_run.status, " · ", _jsx(Link, { to: `/parts/cycle-counts/${c.last_run.id}`, children: "see counts" }), c.last_run.work_order_id && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx(Link, { to: `/work-orders/${c.last_run.work_order_id}`, children: "work order" })] })] })] }), can("parts.counts") && _jsxs("div", { className: "row", style: { gap: 4 }, children: [_jsxs(Button, { size: "sm", onClick: () => start.mutate(c), disabled: start.isPending, children: [_jsx(Play, { size: 14 }), _jsx("span", { className: "desktop-only", children: "Start now" })] }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${c.name}`, onClick: () => setEdit(c), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${c.name}`, onClick: () => del.mutate(c), children: _jsx(Trash2, { size: 14 }) })] })] }, c.id))) }), edit && _jsx(CountForm, { c: edit === "new" ? undefined : edit, onClose: () => setEdit(null) })] }) }));
}
function CountForm({ c, onClose }) {
    const qc = useQueryClient();
    const opts = usePartOptions();
    const wo = useWOOptions();
    const [name, setName] = useState(c?.name ?? "");
    const [loc, setLoc] = useState(c?.location?.id ?? null);
    const [mode, setMode] = useState(c?.selection.type_ids?.length ? "types" : c?.selection.area ? "area" : "all");
    const [types, setTypes] = useState(c?.selection.type_ids ?? []);
    const [area, setArea] = useState(c?.selection.area ?? "");
    const [rrule, setRrule] = useState(c?.rrule ?? "");
    const [assignees, setAssignees] = useState(c?.assignees ?? []);
    const [active, setActive] = useState(c?.active ?? true);
    const [err, setErr] = useState("");
    const selection = mode === "types" ? { type_ids: types } : mode === "area" ? { area } : { all: true };
    const m = useMutation({
        mutationFn: () => api(c ? `/cycle-counts/${c.id}` : "/cycle-counts", { method: c ? "PATCH" : "POST",
            body: { name, location_id: loc, selection, rrule, assignees, active, ...(c && c.rrule !== rrule ? { next_at: null } : {}) } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["cycle-counts"] }); onClose(); },
        onError: (e) => setErr(e.message),
    });
    const custom = rrule && !SCHEDULES.some(([k]) => k === rrule);
    return (_jsxs(Modal, { title: c ? "Edit cycle count" : "New cycle count", onClose: onClose, width: 560, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: name, maxLength: 120, onChange: (e) => setName(e.target.value), placeholder: "e.g. Storeroom bearings" }) }), _jsx(Field, { label: "Location", children: () => _jsx(LocationPicker, { value: loc, onChange: setLoc, placeholder: "Every location" }) }), _jsx(Field, { label: "What to count", children: (id) => _jsxs(Select, { id: id, value: mode, onChange: (e) => setMode(e.target.value), children: [_jsx("option", { value: "all", children: "Every part stocked there" }), _jsx("option", { value: "types", children: "Parts of some types" }), _jsx("option", { value: "area", children: "One area or bin" })] }) }), mode === "types" && _jsx(MultiPicker, { label: "Part types", placeholder: "Pick part types", value: types, onChange: setTypes, options: (opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: _jsx("span", { className: "sw lg", style: { background: t.color } }) })) }), mode === "area" && _jsx(Input, { "aria-label": "Area", value: area, maxLength: 120, onChange: (e) => setArea(e.target.value), placeholder: "e.g. Aisle 3" }), _jsx(Field, { label: "Repeat", children: (id) => _jsxs(Select, { id: id, value: custom ? "custom" : rrule, onChange: (e) => setRrule(e.target.value === "custom" ? rrule : e.target.value), children: [SCHEDULES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)), custom && _jsxs("option", { value: "custom", children: ["Custom (", rrule, ")"] })] }) }), _jsx(Field, { label: "Assign the work order to", children: (id) => _jsx(AssigneePicker, { id: id, options: wo.data, value: assignees, onChange: setAssignees }) }), _jsx(Checkbox, { checked: active, onChange: setActive, label: "Active (start counts on schedule)" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
/** The lines of one count: shown on the count page and in the work order. */
export function RunPanel({ runId, run: given, onChange }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["count-run", runId], queryFn: () => api(`/cycle-count-runs/${runId}`), enabled: !!runId && !given });
    const run = given ?? q.data;
    const refresh = () => { qc.invalidateQueries({ queryKey: ["count-run"] }); qc.invalidateQueries({ queryKey: ["wo-count"] }); qc.invalidateQueries({ queryKey: ["cycle-counts"] }); onChange?.(); };
    const err = (e) => toast(e.message, { kind: "error" });
    const apply = useMutation({ mutationFn: () => api(`/cycle-count-runs/${run.id}/apply`, { method: "POST" }),
        onSuccess: (r) => { refresh(); toast(r.corrections ? `Stock corrected on ${r.corrections} line${r.corrections === 1 ? "" : "s"}` : "Counts matched. Nothing to correct."); }, onError: err });
    const exp = useMutation({ mutationFn: () => api(`/cycle-count-runs/${run.id}/export`, { method: "POST" }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }), onError: err });
    if (!run)
        return q.isError ? _jsx(EmptyState, { title: "Count not found" }) : _jsx(ListSkeleton, { rows: 3 });
    const open = run.status === "open";
    return (_jsxs("section", { className: "card part-run", children: [_jsxs("div", { className: "card-head wrap", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Cycle count" }), _jsxs("span", { className: "row", style: { gap: 8 }, children: [_jsxs("span", { className: "small muted", children: [run.progress.counted, " of ", run.progress.total, " counted"] }), !open && _jsx(Pill, { tone: run.status === "done" ? "success" : "neutral", children: run.status === "done" ? "Applied" : run.status === "canceled" ? "Canceled" : run.status }), can("exports.use") && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Export count", onClick: () => exp.mutate(), children: _jsx(Download, { size: 14 }) }), open && can("parts.counts") && _jsx(Button, { size: "sm", onClick: () => apply.mutate(), disabled: apply.isPending || run.progress.counted === 0, children: "Apply counts" })] })] }), _jsx("div", { className: "part-run-bar", "aria-hidden": "true", children: _jsx("span", { style: { width: `${run.progress.total ? (100 * run.progress.counted) / run.progress.total : 0}%` } }) }), run.lines.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Nothing matched this count's selection." })
                : run.lines.map((l) => _jsx(CountLineRow, { runId: run.id, l: l, open: open, onSaved: refresh }, l.id))] }));
}
function CountLineRow({ runId, l, open, onSaved }) {
    const { can } = useSession();
    const { toast } = useToast();
    const [v, setV] = useState(l.counted ?? "");
    const save = useMutation({
        mutationFn: (counted) => api(`/cycle-count-runs/${runId}/lines/${l.id}`, { method: "PUT", body: { counted, note: l.note } }),
        onSuccess: onSaved, onError: (e) => toast(e.message, { kind: "error" }),
    });
    const diff = l.difference !== null && l.difference !== "0" ? l.difference : null;
    return (_jsxs("div", { className: "list-row part-count-line", children: [_jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "t", children: _jsx(Link, { to: `/parts/${l.part.id}`, children: l.part.name }) }), _jsx("div", { className: "s", children: [l.part.part_number, l.location?.name, l.area, l.expected !== null ? `expected ${l.expected}` : ""].filter(Boolean).join(" · ") || " " })] }), diff && _jsx("span", { className: "small " + (diff.startsWith("-") ? "part-out" : "part-in"), children: diff.startsWith("-") ? diff : `+${diff}` }), open && can("parts.use") ? _jsx(Input, { className: "part-count-input", "aria-label": `Counted ${l.part.name}`, inputMode: "decimal", value: v, placeholder: "Count", onChange: (e) => setV(e.target.value), onBlur: () => { if (v !== (l.counted ?? ""))
                    save.mutate(v); }, onKeyDown: (e) => { if (e.key === "Enter")
                    e.target.blur(); } })
                : _jsx("span", { className: "num", children: l.counted ?? "—" })] }));
}
