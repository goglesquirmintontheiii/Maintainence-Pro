import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Settings → Parts and inventory: stock rules, required fields, escalation, reservations, part types and custom fields.
// The keys are shared with purchasing (mpro/parts/settings.py); don't rename them.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { ColorPicker } from "../../components/ColorPicker";
import { TeamsPicker } from "../assets/shared";
import "./parts.css";
const REQUIRABLE = [["part_number", "Part number"], ["description", "Description"], ["unit_cost", "Unit cost"], ["barcode", "Barcode"],
    ["lead_time_days", "Lead time"], ["part_types", "Part types"], ["teams", "Teams"], ["assets", "Assets"], ["vendors", "Vendors"], ["area", "Area / bin"],
    ["min_qty", "Minimum quantity"], ["max_qty", "Maximum quantity"]];
const FIELD_TYPES = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
    ["date", "Date"], ["datetime", "Date and time"], ["checkbox", "Checkbox"], ["link", "Link (URL or phone)"], ["currency", "Currency"]];
export function PartsSettingsPage() {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const ro = !can("parts.settings");
    const s = useQuery({ queryKey: ["parts-settings"], queryFn: () => api("/parts/settings") });
    const save = useMutation({
        mutationFn: (patch) => api("/parts/settings", { method: "PATCH", body: patch }),
        onSuccess: (v) => { qc.setQueryData(["parts-settings"], v); qc.invalidateQueries({ queryKey: ["part-options"] }); toast("Saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!s.data)
        return _jsx(ListSkeleton, { rows: 6 });
    const v = s.data;
    return (_jsxs("div", { className: "stack", style: { gap: 20 }, children: [ro && _jsx("div", { className: "banner info", children: "Only administrators can change parts settings. You can see how they're set up." }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Stock" }) }), _jsxs("div", { className: "card-body stack", children: [_jsx(Field, { label: "A part needs restocking when", hint: "Compared with each location's minimum.", children: (id) => _jsxs(Select, { id: id, value: v.restock_trigger, disabled: ro, onChange: (e) => save.mutate({ restock_trigger: e.target.value }), style: { maxWidth: 360 }, children: [_jsx("option", { value: "in_stock", children: "What's in stock is below the minimum" }), _jsx("option", { value: "available", children: "What's available (in stock minus reserved) is below the minimum" })] }) }), _jsx(Toggle, { label: "Allow stock below zero", hint: "Let people use more than the system says is on hand. Negative stock shows in red until it's corrected.", checked: v.allow_negative_stock, disabled: ro, onChange: (x) => save.mutate({ allow_negative_stock: x }) }), _jsx(Toggle, { label: "Update the unit cost from restocks and receipts (moving average)", hint: "Otherwise the unit cost only changes when someone edits it.", checked: v.moving_average_cost, disabled: ro, onChange: (x) => save.mutate({ moving_average_cost: x }) }), _jsx(Toggle, { label: "Never show a negative quantity on order", hint: "Receiving more than was ordered doesn't push the on-order quantity below zero.", checked: v.prevent_negative_ordered, disabled: ro, onChange: (x) => save.mutate({ prevent_negative_ordered: x }) })] })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Parts on work orders" }) }), _jsxs("div", { className: "card-body stack", children: [_jsx(Field, { label: "Count parts as planned for work orders due within (days)", hint: "Shown as Planned on the part.", children: (id) => _jsx(NumberSave, { id: id, value: v.assigned_window_days, max: 365, disabled: ro, onSave: (n) => save.mutate({ assigned_window_days: n }) }) }), _jsx(Field, { label: "Reserve planned parts automatically for work orders due within (days)", hint: "0 turns this off. Reserved parts are held for the job.", children: (id) => _jsx(NumberSave, { id: id, value: v.auto_reserve_days, max: 365, disabled: ro, onSave: (n) => save.mutate({ auto_reserve_days: n }) }) })] })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Critical parts" }) }), _jsxs("div", { className: "card-body stack", children: [_jsx("p", { className: "small muted", style: { margin: 0 }, children: "When a part of a critical type runs low, these teams get an email." }), _jsx(TeamsPicker, { value: v.escalation_team_ids, disabled: ro, onChange: (ids) => save.mutate({ escalation_team_ids: ids }) })] })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Required fields" }), _jsx("span", { className: "small muted", children: "Asked for when someone creates or edits a part" })] }), _jsx("div", { className: "card-body part-req-grid", children: REQUIRABLE.map(([k, l]) => _jsx(Checkbox, { label: l, disabled: ro, checked: v.required_fields.includes(k), onChange: (x) => save.mutate({ required_fields: x ? [...v.required_fields, k] : v.required_fields.filter((f) => f !== k) }) }, k)) })] }), _jsx(PartTypes, { ro: ro }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Part custom fields" }) }), _jsx(PartFields, { ro: ro })] })] }));
}
function NumberSave({ id, value, max, disabled, onSave }) {
    const [n, setN] = useState(String(value));
    return (_jsxs("div", { className: "row", style: { maxWidth: 260 }, children: [_jsx(Input, { id: id, type: "number", min: 0, max: max, value: n, disabled: disabled, onChange: (e) => setN(e.target.value) }), !disabled && Number(n) !== value && _jsx(Button, { onClick: () => onSave(Math.max(0, Math.min(max, Number(n) || 0))), children: "Save" })] }));
}
function PartTypes({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["part-types"], queryFn: () => api("/part-types") });
    const [edit, setEdit] = useState(null);
    const done = () => { qc.invalidateQueries({ queryKey: ["part-types"] }); qc.invalidateQueries({ queryKey: ["part-options"] }); };
    const del = useMutation({ mutationFn: (t) => api(`/part-types/${t.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Part type deleted"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Part types" }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add type"] })] }), !q.data ? _jsx(ListSkeleton, { rows: 2 }) : q.data.items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Group parts by kind, like Bearings, Belts or Filters. Mark a type critical to get alerts when it runs low." })
                : q.data.items.map((t) => (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsx("span", { className: "sw lg", style: { background: t.color } }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [t.name, " ", t.critical && _jsx(Pill, { tone: "danger", children: "Critical" })] }), _jsxs("div", { className: "s", children: [t.usage, " part", t.usage === 1 ? "" : "s"] })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${t.name}`, onClick: () => setEdit(t), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${t.name}`, onClick: () => del.mutate(t), children: _jsx(Trash2, { size: 14 }) })] })] }, t.id))), edit && _jsx(TypeModal, { t: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: done })] }));
}
function TypeModal({ t, onClose, onDone }) {
    const [name, setName] = useState(t?.name ?? "");
    const [color, setColor] = useState(t?.color ?? "#5d6880");
    const [critical, setCritical] = useState(t?.critical ?? false);
    const [err, setErr] = useState("");
    const m = useMutation({ mutationFn: () => api(t ? `/part-types/${t.id}` : "/part-types", { method: t ? "PATCH" : "POST", body: { name, color, critical } }),
        onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: t ? "Edit part type" : "New part type", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: name, maxLength: 80, onChange: (e) => setName(e.target.value), placeholder: "e.g. Bearings" }) }), _jsx(Field, { label: "Color", children: () => _jsx(ColorPicker, { value: color, onChange: setColor }) }), _jsx(Checkbox, { checked: critical, onChange: setCritical, label: "Critical (email the escalation teams when one runs low)" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
function PartFields({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["custom-fields", "part"], queryFn: () => api("/custom-fields?entity=part") });
    const [edit, setEdit] = useState(null);
    const done = () => qc.invalidateQueries({ queryKey: ["custom-fields", "part"] });
    const del = useMutation({ mutationFn: (f) => api(`/custom-fields/${f.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Field deleted"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    const items = q.data?.items ?? [];
    return (_jsxs(_Fragment, { children: [!q.data ? _jsx(ListSkeleton, { rows: 2 }) : items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Add fields like a storage temperature, a shelf life or a hazard class." })
                : items.map((f) => (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [f.name, " ", f.required && _jsx(Pill, { tone: "warning", children: "Required" })] }), _jsxs("div", { className: "s", children: [FIELD_TYPES.find(([k]) => k === f.type)?.[1], f.type === "select" ? `: ${f.options.join(", ")}` : ""] })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${f.name}`, onClick: () => setEdit(f), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${f.name}`, onClick: () => del.mutate(f), children: _jsx(Trash2, { size: 14 }) })] })] }, f.id))), !ro && _jsx("div", { className: "card-body", style: { paddingTop: 6, paddingBottom: 12 }, children: _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add field"] }) }), edit && _jsx(FieldModal, { field: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: done })] }));
}
function FieldModal({ field, onClose, onDone }) {
    const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false });
    const [err, setErr] = useState("");
    const body = () => ({ name: f.name, type: f.type, required: f.required, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean), entity_type: "part" });
    const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
        onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: field ? "Edit field" : "New field", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 120, onChange: (e) => setF({ ...f, name: e.target.value }), placeholder: "e.g. Shelf life" }) }), _jsx(Field, { label: "Type", hint: field ? "A field's type can't change. Make a new field instead." : undefined, children: (id) => _jsx(Select, { id: id, value: f.type, disabled: !!field, onChange: (e) => setF({ ...f, type: e.target.value }), children: FIELD_TYPES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), f.type === "select" && _jsx(Field, { label: "Options (one per line)", children: (id) => _jsx("textarea", { id: id, className: "textarea", value: f.options, onChange: (e) => setF({ ...f, options: e.target.value }) }) }), _jsx(Checkbox, { checked: f.required, onChange: (x) => setF({ ...f, required: x }), label: "Required" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
