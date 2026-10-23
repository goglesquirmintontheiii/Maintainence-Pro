import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Meter create/edit drawer, trigger editor, copy dialog, monitoring points and bulk edit.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Modal, Select } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
export function useMeterOptions() {
    const { can } = useSession();
    return useQuery({ queryKey: ["meter-options"], queryFn: () => api("/meters/options"), staleTime: 60_000, enabled: can("meters.view") });
}
const numOrNull = (v) => (v.trim() === "" ? null : Number(v));
const str = (v) => (v === null || v === undefined ? "" : String(v));
export function UnitSelect({ value, onChange, units, id }) {
    const all = Object.values(units).flat();
    const [custom, setCustom] = useState(value !== "" && !all.includes(value));
    return (_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs(Select, { id: id, value: custom ? "__custom" : value, onChange: (e) => { if (e.target.value === "__custom") {
                    setCustom(true);
                    onChange("");
                }
                else {
                    setCustom(false);
                    onChange(e.target.value);
                } }, children: [Object.entries(units).map(([g, us]) => _jsx("optgroup", { label: g, children: us.map((u) => _jsx("option", { value: u, children: u }, u)) }, g)), _jsx("option", { value: "__custom", children: "Custom unit\u2026" })] }), custom && _jsx(Input, { "aria-label": "Custom unit", placeholder: "e.g. bags", value: value, maxLength: 40, onChange: (e) => onChange(e.target.value) })] }));
}
export function MeterForm({ edit, onClose, onSaved, initialAsset }) {
    const opts = useMeterOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [f, setF] = useState(() => ({
        name: edit?.name ?? "", description: edit?.description ?? "", unit: edit?.unit ?? "hours", meter_type: edit?.meter_type ?? "manual",
        asset_id: edit?.asset_id ?? initialAsset ?? null, location_id: edit?.location_id ?? null, monitoring_point_id: edit?.monitoring_point_id ?? "",
        reading_frequency: edit?.reading_frequency ?? "none", frequency_interval: String(edit?.frequency_interval ?? 1),
        warning_low: str(edit?.warning_low), warning_high: str(edit?.warning_high), alarm_low: str(edit?.alarm_low), alarm_high: str(edit?.alarm_high),
    }));
    const [err, setErr] = useState("");
    const set = (p) => setF((x) => ({ ...x, ...p }));
    const save = useMutation({
        mutationFn: () => {
            const body = { ...f, monitoring_point_id: f.monitoring_point_id || null, frequency_interval: Number(f.frequency_interval) || 1,
                warning_low: numOrNull(f.warning_low), warning_high: numOrNull(f.warning_high), alarm_low: numOrNull(f.alarm_low), alarm_high: numOrNull(f.alarm_high) };
            if (edit && body.asset_id === edit.asset_id)
                delete body.asset_id; // don't reset the location on unrelated edits
            return edit ? api(`/meters/${edit.id}`, { method: "PATCH", body }) : api("/meters", { method: "POST", body });
        },
        onSuccess: (m) => { qc.invalidateQueries({ queryKey: ["meters"] }); qc.setQueryData(["meter", m.id], m); toast(edit ? "Meter saved" : "Meter created"); onSaved(m); },
        onError: (e) => setErr(e.message),
    });
    const points = (opts.data?.monitoring_points ?? []).filter((p) => !f.asset_id || !p.asset_id || p.asset_id === f.asset_id);
    return (_jsx(Drawer, { title: edit ? "Edit meter" : "New meter", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx("span", { className: "grow small", style: { color: "var(--c-danger)" }, role: "alert", children: err }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending || !f.name.trim() || !f.unit.trim(), onClick: () => { setErr(""); save.mutate(); }, children: edit ? "Save" : "Create" })] }), children: _jsxs("form", { className: "stack", onSubmit: (e) => { e.preventDefault(); save.mutate(); }, children: [_jsx(Field, { label: "Meter name", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 255, placeholder: "e.g. Run hours", onChange: (e) => set({ name: e.target.value }), required: true }) }), _jsx(Field, { label: "Unit of measurement", children: (id) => _jsx(UnitSelect, { id: id, value: f.unit, units: opts.data?.units ?? {}, onChange: (unit) => set({ unit }) }) }), _jsx(Field, { label: "Description", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: f.description, onChange: (e) => set({ description: e.target.value }) }) }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Asset", children: (id) => _jsx(AssetPicker, { id: id, value: f.asset_id ? [f.asset_id] : [], onChange: (v) => set({ asset_id: v[0] ?? null }) }) }), _jsx(Field, { label: "Location", hint: f.asset_id && !f.location_id ? "Uses the asset's location" : undefined, children: (id) => _jsx(LocationPicker, { id: id, value: f.location_id, onChange: (v) => set({ location_id: v }) }) })] }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Monitoring point", hint: "A sensor spot several meters read from", children: (id) => (_jsxs(Select, { id: id, value: f.monitoring_point_id, onChange: (e) => set({ monitoring_point_id: e.target.value }), children: [_jsx("option", { value: "", children: "None" }), points.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))] })) }), _jsx(Field, { label: "Type", children: (id) => _jsxs(Select, { id: id, value: f.meter_type, onChange: (e) => set({ meter_type: e.target.value }), children: [_jsx("option", { value: "manual", children: "Manual readings" }), _jsx("option", { value: "automated", children: "Automated (API or sensor)" })] }) })] }), _jsx(Field, { label: "Reading frequency", hint: "People are reminded when a reading is due.", children: (id) => (_jsxs("div", { className: "row", style: { gap: 6 }, children: [f.reading_frequency !== "none" && _jsxs(_Fragment, { children: [_jsx("span", { className: "small muted", children: "Every" }), _jsx(Input, { "aria-label": "Interval", type: "number", min: 1, max: 1000, style: { width: 80 }, value: f.frequency_interval, onChange: (e) => set({ frequency_interval: e.target.value }) })] }), _jsx(Select, { id: id, value: f.reading_frequency, onChange: (e) => set({ reading_frequency: e.target.value }), children: (opts.data?.frequencies ?? [{ id: "none", label: "None" }]).map((x) => _jsx("option", { value: x.id, children: x.id === "none" ? "No schedule" : x.label }, x.id)) })] })) }), _jsxs("fieldset", { className: "mfield", children: [_jsxs("legend", { children: ["Limits ", _jsx("span", { className: "small faint", children: "(optional)" })] }), _jsxs("div", { className: "mlimits", children: [_jsx(Field, { label: "Alarm low", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: f.alarm_low, onChange: (e) => set({ alarm_low: e.target.value }) }) }), _jsx(Field, { label: "Warning low", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: f.warning_low, onChange: (e) => set({ warning_low: e.target.value }) }) }), _jsx(Field, { label: "Warning high", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: f.warning_high, onChange: (e) => set({ warning_high: e.target.value }) }) }), _jsx(Field, { label: "Alarm high", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: f.alarm_high, onChange: (e) => set({ alarm_high: e.target.value }) }) })] }), _jsx("p", { className: "small faint", style: { margin: 0 }, children: "Readings outside the warning limits are flagged; outside the alarm limits they show red. Use a trigger to create work automatically." })] })] }) }));
}
// ---------------------------------------------------------------- copy
export function CopyMeterDialog({ meter, onClose, onDone }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [mode, setMode] = useState("one");
    const [assets, setAssets] = useState([]);
    const m = useMutation({
        mutationFn: () => api(`/meters/${meter.id}/copy`, { method: "POST", body: mode === "assets" ? { asset_ids: assets } : {} }),
        onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["meters"] }); toast(`Made ${r.items.length} cop${r.items.length === 1 ? "y" : "ies"}`); onDone(r.items.map((x) => x.id)); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsx(Modal, { title: "Copy meter", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: m.isPending || (mode === "assets" && !assets.length), onClick: () => m.mutate(), children: "Copy" })] }), children: _jsxs("div", { className: "stack", children: [_jsx("p", { className: "muted", style: { margin: 0 }, children: "Copies the settings, limits and triggers (not the readings)." }), _jsxs("label", { className: "check", children: [_jsx("input", { type: "radio", name: "cm", checked: mode === "one", onChange: () => setMode("one") }), _jsxs("span", { children: ["One copy named \u201CCopy - ", meter.name, "\u201D"] })] }), _jsxs("label", { className: "check", children: [_jsx("input", { type: "radio", name: "cm", checked: mode === "assets", onChange: () => setMode("assets") }), _jsx("span", { children: "A copy on each of these assets" })] }), mode === "assets" && _jsx(AssetPicker, { multi: true, value: assets, onChange: setAssets, placeholder: "Pick assets", exclude: meter.asset_id ? [meter.asset_id] : [] })] }) }));
}
// ---------------------------------------------------------------- monitoring points
export function MonitoringPointsDialog({ onClose }) {
    const qc = useQueryClient();
    const { can } = useSession();
    const { toast } = useToast();
    const list = useQuery({ queryKey: ["monitoring-points"], queryFn: () => api("/monitoring-points") });
    const [editing, setEditing] = useState(null);
    const done = () => { qc.invalidateQueries({ queryKey: ["monitoring-points"] }); qc.invalidateQueries({ queryKey: ["meter-options"] }); };
    const save = useMutation({
        mutationFn: () => editing.id ? api(`/monitoring-points/${editing.id}`, { method: "PATCH", body: editing }) : api("/monitoring-points", { method: "POST", body: editing }),
        onSuccess: () => { done(); setEditing(null); toast("Monitoring point saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const del = useMutation({ mutationFn: (id) => api(`/monitoring-points/${id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Monitoring point deleted"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsx(Modal, { title: "Monitoring points", onClose: onClose, width: 560, children: _jsxs("div", { className: "stack", children: [_jsx("p", { className: "small muted", style: { margin: 0 }, children: "A monitoring point is one physical spot on an asset (say, the drive-end bearing) that several meters read from." }), editing ? (_jsxs("div", { className: "card card-pad stack", children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }), maxLength: 120 }) }), _jsx(Field, { label: "Asset", children: (id) => _jsx(AssetPicker, { id: id, value: editing.asset_id ? [editing.asset_id] : [], onChange: (v) => setEditing({ ...editing, asset_id: v[0] ?? null }) }) }), _jsx(Field, { label: "Description", children: (id) => _jsx(Input, { id: id, value: editing.description, onChange: (e) => setEditing({ ...editing, description: e.target.value }) }) }), _jsxs("div", { className: "row", style: { justifyContent: "flex-end" }, children: [_jsx(Button, { onClick: () => setEditing(null), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !editing.name.trim() || save.isPending, onClick: () => save.mutate(), children: "Save" })] })] })) : can("meters.manage") && _jsx("div", { children: _jsxs(Button, { onClick: () => setEditing({ name: "", description: "", asset_id: null }), children: [_jsx(Plus, { size: 15 }), "Add monitoring point"] }) }), (list.data?.items ?? []).length === 0 ? _jsx("p", { className: "small faint", children: "None yet." }) : (_jsx("table", { className: "table", children: _jsx("tbody", { children: list.data.items.map((p) => (_jsxs("tr", { children: [_jsxs("td", { children: [_jsx("b", { children: p.name }), p.description && _jsx("div", { className: "small muted", children: p.description })] }), _jsxs("td", { style: { width: 90, textAlign: "right" }, children: [can("meters.manage") && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${p.name}`, onClick: () => setEditing({ ...p }), children: _jsx(Pencil, { size: 14 }) }), can("meters.delete") && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${p.name}`, onClick: () => del.mutate(p.id), children: _jsx(Trash2, { size: 14 }) })] })] }, p.id))) }) }))] }) }));
}
// ---------------------------------------------------------------- bulk
export function BulkMeterDialog({ ids, onClose, onDone }) {
    const opts = useMeterOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [field, setField] = useState("reading_frequency");
    const [freq, setFreq] = useState("day");
    const [interval, setInterval] = useState("1");
    const [unit, setUnit] = useState("hours");
    const [loc, setLoc] = useState(null);
    const m = useMutation({
        mutationFn: () => {
            const patch = field === "reading_frequency" ? { reading_frequency: freq, frequency_interval: Number(interval) || 1 } : field === "unit" ? { unit } : { location_id: loc };
            return api("/meters/bulk", { method: "POST", body: { ids, action: "edit", patch } });
        },
        onSuccess: (r) => {
            qc.invalidateQueries({ queryKey: ["meters"] });
            qc.invalidateQueries({ queryKey: ["meter"] });
            toast(r.failed.length ? `${r.done.length} updated. ${r.failed[0].name}: ${r.failed[0].message}` : `Updated ${r.done.length} meter${r.done.length === 1 ? "" : "s"}`, { kind: r.failed.length ? "error" : "info" });
            onDone();
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsx(Modal, { title: `Edit ${ids.length} meter${ids.length === 1 ? "" : "s"}`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: m.isPending, onClick: () => m.mutate(), children: "Apply" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Field, { label: "Change", children: (id) => _jsxs(Select, { id: id, value: field, onChange: (e) => setField(e.target.value), children: [_jsx("option", { value: "reading_frequency", children: "Reading frequency" }), _jsx("option", { value: "unit", children: "Unit" }), _jsx("option", { value: "location_id", children: "Location" })] }) }), field === "reading_frequency" && _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx("span", { className: "small muted", children: "Every" }), _jsx(Input, { "aria-label": "Interval", type: "number", min: 1, style: { width: 80 }, value: interval, onChange: (e) => setInterval(e.target.value) }), _jsx(Select, { "aria-label": "Frequency", value: freq, onChange: (e) => setFreq(e.target.value), children: (opts.data?.frequencies ?? []).map((x) => _jsx("option", { value: x.id, children: x.id === "none" ? "No schedule" : x.label }, x.id)) })] }), field === "unit" && _jsx(UnitSelect, { value: unit, units: opts.data?.units ?? {}, onChange: setUnit }), field === "location_id" && _jsx(LocationPicker, { value: loc, onChange: setLoc, placeholder: "No location" })] }) }));
}
