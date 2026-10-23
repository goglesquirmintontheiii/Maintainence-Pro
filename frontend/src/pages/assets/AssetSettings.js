import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Settings → Assets and locations: status reasons, hierarchy depth, asset types and custom fields.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { ASSET_STATUS_LABEL } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import "../../styles/assets.css";
import "../../styles/asset-settings.css";
import { ColorPicker } from "../../components/ColorPicker";
const FIELD_TYPES = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
    ["date", "Date"], ["datetime", "Date and time"], ["checkbox", "Checkbox"], ["link", "Link (URL or phone)"], ["currency", "Currency"]];
const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#7a52c9", "#b8560b", "#c4302b", "#c43c5c", "#5d6880", "#a16207", "#2f8f46"];
export function AssetSettingsPage() {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const ro = !can("assets.settings");
    const s = useQuery({ queryKey: ["asset-settings"], queryFn: () => api("/assets/settings") });
    const save = useMutation({
        mutationFn: (b) => api("/assets/settings", { method: "PATCH", body: b }),
        onSuccess: (x) => { qc.setQueryData(["asset-settings"], x); qc.invalidateQueries({ queryKey: ["asset-options"] }); toast("Saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!s.data)
        return _jsx(ListSkeleton, { rows: 6 });
    const v = s.data;
    return (_jsxs("div", { className: "stack", style: { gap: 20 }, children: [ro && _jsx("div", { className: "banner info", children: "Only administrators can change asset settings. You can see how they're set up." }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Asset statuses" }), _jsx("span", { className: "small muted", children: "Reasons people pick when they change an asset's status" })] }), _jsxs("div", { className: "card-body stack", children: [Object.keys(ASSET_STATUS_LABEL).map((st) => (_jsx(ReasonList, { status: st, items: v.status_reasons[st] ?? [], ro: ro, onSave: (items) => save.mutate({ status_reasons: { ...v.status_reasons, [st]: items } }) }, st))), _jsx(Toggle, { label: "Ask for the asset's status on work orders", hint: "When someone creates or completes a work order on an asset, offer to mark it offline or back online.", checked: v.ask_status_on_work_orders, disabled: ro, onChange: (x) => save.mutate({ ask_status_on_work_orders: x }) })] })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Hierarchy" }) }), _jsx("div", { className: "card-body", children: _jsx(Field, { label: "Maximum asset tree depth", hint: "How many levels of sub-assets are allowed (0 = no limit). Existing deeper trees stay as they are.", children: (id) => _jsx(DepthInput, { id: id, value: v.max_depth, disabled: ro, onSave: (n) => save.mutate({ max_depth: n }) }) }) })] }), _jsx(AssetTypes, { ro: ro }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Location custom fields" }) }), _jsx(FieldList, { entity: "location", ro: ro, empty: "Add fields like a cost center, square footage or a building code." })] })] }));
}
function DepthInput({ id, value, disabled, onSave }) {
    const [n, setN] = useState(String(value));
    return (_jsxs("div", { className: "row", style: { maxWidth: 260 }, children: [_jsx(Input, { id: id, type: "number", min: 0, max: 50, value: n, disabled: disabled, onChange: (e) => setN(e.target.value) }), !disabled && Number(n) !== value && _jsx(Button, { onClick: () => onSave(Math.max(0, Math.min(50, Number(n) || 0))), children: "Save" })] }));
}
function ReasonList({ status, items, ro, onSave }) {
    const [text, setText] = useState("");
    const add = () => { const t = text.trim(); if (t && !items.includes(t))
        onSave([...items, t]); setText(""); };
    return (_jsxs("div", { className: "reason-list", children: [_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx("span", { className: "astat-dot " + status }), _jsx("b", { children: ASSET_STATUS_LABEL[status] })] }), _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [items.length === 0 && _jsx("span", { className: "small faint", children: "No reasons" }), items.map((r) => _jsxs("span", { className: "chip", children: [r, !ro && _jsx("button", { type: "button", className: "chip-x", "aria-label": `Remove reason ${r}`, onClick: () => onSave(items.filter((x) => x !== r)), children: _jsx(X, { size: 12 }) })] }, r))] }), !ro && _jsxs("form", { className: "row", onSubmit: (e) => { e.preventDefault(); add(); }, style: { maxWidth: 420 }, children: [_jsx(Input, { "aria-label": `New reason for ${ASSET_STATUS_LABEL[status]}`, value: text, maxLength: 80, onChange: (e) => setText(e.target.value), placeholder: "Add a reason" }), _jsx(Button, { type: "submit", disabled: !text.trim(), children: "Add" })] })] }));
}
function AssetTypes({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["asset-types"], queryFn: () => api("/asset-types") });
    const fields = useQuery({ queryKey: ["custom-fields", "asset"], queryFn: () => api("/custom-fields?entity=asset") });
    const [edit, setEdit] = useState(null);
    const [open, setOpen] = useState(new Set());
    const flip = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id))
        n.delete(id);
    else
        n.add(id); return n; });
    const done = () => { qc.invalidateQueries({ queryKey: ["asset-types"] }); qc.invalidateQueries({ queryKey: ["asset-options"] }); qc.invalidateQueries({ queryKey: ["custom-fields", "asset"] }); };
    const del = useMutation({ mutationFn: (t) => api(`/asset-types/${t.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Asset type deleted"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    const count = (id) => (fields.data?.items ?? []).filter((f) => f.scope_id === id).length;
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Asset types and fields" }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add type"] })] }), _jsxs("div", { className: "type-fields-all", children: [_jsxs("div", { className: "card-body", style: { paddingBottom: 0 }, children: [_jsx("h3", { className: "type-fields-h", children: "All asset types" }), _jsx("p", { className: "small faint", style: { margin: "2px 0 0" }, children: "These fields show on every asset." })] }), _jsx(FieldList, { entity: "asset", scope: null, ro: ro, empty: "Add fields like a serial plate photo date or a supplier code." })] }), !q.data ? _jsx(ListSkeleton, { rows: 2 }) : q.data.items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Group assets by kind, like Pump, Conveyor or HVAC, and give each type its own fields." })
                : q.data.items.map((t) => {
                    const n = count(t.id);
                    const isOpen = open.has(t.id);
                    return (_jsxs("div", { className: "type-block", children: [_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-expanded": isOpen, "aria-label": `${isOpen ? "Hide" : "Show"} fields for ${t.name}`, onClick: () => flip(t.id), children: isOpen ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }) }), _jsx("span", { className: "sw lg", style: { background: t.color } }), _jsxs("button", { type: "button", className: "grow type-name-btn", onClick: () => flip(t.id), children: [_jsx("div", { className: "t", children: t.name }), _jsxs("div", { className: "s", children: [t.usage, " asset", t.usage === 1 ? "" : "s", " \u00B7 ", n, " field", n === 1 ? "" : "s"] })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${t.name}`, onClick: () => setEdit(t), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${t.name}`, onClick: () => del.mutate(t), children: _jsx(Trash2, { size: 14 }) })] })] }), isOpen && _jsx("div", { className: "type-fields", children: _jsx(FieldList, { entity: "asset", scope: t.id, ro: ro, empty: `No fields only for ${t.name} yet. Add ones like horsepower or refrigerant.` }) })] }, t.id));
                }), edit && _jsx(TypeModal, { t: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: (id) => { done(); setEdit(null); if (id)
                    setOpen((o) => new Set(o).add(id)); } })] }));
}
function TypeModal({ t, onClose, onDone }) {
    const [name, setName] = useState(t?.name ?? "");
    const [color, setColor] = useState(t?.color ?? COLORS[0]);
    const [err, setErr] = useState("");
    const m = useMutation({ mutationFn: () => t ? api(`/asset-types/${t.id}`, { method: "PATCH", body: { name, color } }) : api("/asset-types", { method: "POST", body: { name, color } }),
        onSuccess: (x) => onDone(x?.id), onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: t ? "Edit asset type" : "New asset type", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: name, maxLength: 80, onChange: (e) => setName(e.target.value), placeholder: "e.g. Pump" }) }), _jsxs("div", { className: "field", children: [_jsx("span", { className: "small", style: { fontWeight: 600 }, children: "Colour" }), _jsx(ColorPicker, { value: color, onChange: setColor, presets: COLORS })] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
/** Custom fields for locations, or for assets of one type (`scope` = type id) or of every type (`scope` = null). */
function FieldList({ entity, scope, ro, empty }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const data = useQuery({ queryKey: ["custom-fields", entity], queryFn: () => api(`/custom-fields?entity=${entity}`) });
    const types = useQuery({ queryKey: ["asset-types"], queryFn: () => api("/asset-types"), enabled: entity === "asset" });
    const [edit, setEdit] = useState(null);
    const done = () => { qc.invalidateQueries({ queryKey: ["custom-fields", entity] }); qc.invalidateQueries({ queryKey: ["asset-options"] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const del = useMutation({ mutationFn: (f) => api(`/custom-fields/${f.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Field deleted"); }, onError: err });
    const order = useMutation({ mutationFn: (ids) => api("/custom-fields/reorder", { method: "POST", body: { ids, entity_type: entity } }), onSuccess: done, onError: err });
    const all = data.data?.items ?? [];
    const items = entity === "location" ? all : all.filter((f) => (f.scope_id ?? null) === (scope ?? null));
    // the API reorders the whole list, so swap the two fields' places within it
    const move = (i, d) => {
        const ids = all.map((f) => f.id);
        const a = ids.indexOf(items[i].id);
        const b = ids.indexOf(items[i + d].id);
        [ids[a], ids[b]] = [ids[b], ids[a]];
        order.mutate(ids);
    };
    return (_jsxs(_Fragment, { children: [!data.data ? _jsx(ListSkeleton, { rows: 2 }) : items.length === 0 ? _jsx("div", { className: "card-body small faint", style: { paddingTop: 8, paddingBottom: 8 }, children: empty })
                : items.map((f, i) => (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [f.name, " ", f.required && _jsx(Pill, { tone: "warning", children: "Required" })] }), _jsxs("div", { className: "s", children: [FIELD_TYPES.find(([k]) => k === f.type)?.[1], f.type === "select" ? `: ${f.options.join(", ")}` : ""] })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Move ${f.name} up`, disabled: i === 0 || order.isPending, onClick: () => move(i, -1), children: _jsx(ArrowUp, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Move ${f.name} down`, disabled: i === items.length - 1 || order.isPending, onClick: () => move(i, 1), children: _jsx(ArrowDown, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${f.name}`, onClick: () => setEdit(f), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${f.name}`, onClick: () => del.mutate(f), children: _jsx(Trash2, { size: 14 }) })] })] }, f.id))), !ro && _jsx("div", { className: "card-body", style: { paddingTop: 6, paddingBottom: 12 }, children: _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add field"] }) }), edit && _jsx(FieldModal, { entity: entity, field: edit === "new" ? undefined : edit, scope: scope ?? null, types: types.data?.items ?? [], onClose: () => setEdit(null), onDone: done })] }));
}
function FieldModal({ entity, field, scope, types, onClose, onDone }) {
    const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false, scope_id: field?.scope_id ?? scope ?? "" });
    const [err, setErr] = useState("");
    const body = () => ({ name: f.name, type: f.type, required: f.required, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean), entity_type: entity,
        ...(entity === "asset" ? { scope_id: f.scope_id || null } : {}) });
    const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
        onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: field ? "Edit field" : "New field", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 120, onChange: (e) => setF({ ...f, name: e.target.value }), placeholder: entity === "asset" ? "e.g. Horsepower" : "e.g. Cost center" }) }), _jsx(Field, { label: "Type", hint: field ? "A field's type can't change. Make a new field instead." : undefined, children: (id) => _jsx(Select, { id: id, value: f.type, disabled: !!field, onChange: (e) => setF({ ...f, type: e.target.value }), children: FIELD_TYPES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), f.type === "select" && _jsx(Field, { label: "Options (one per line)", children: (id) => _jsx("textarea", { id: id, className: "textarea", value: f.options, onChange: (e) => setF({ ...f, options: e.target.value }) }) }), entity === "asset" && _jsx(Field, { label: "Show on", hint: "Limit the field to assets of one type, or show it on every asset.", children: (id) => _jsxs(Select, { id: id, value: f.scope_id, onChange: (e) => setF({ ...f, scope_id: e.target.value }), children: [_jsx("option", { value: "", children: "All asset types" }), types.map((t) => _jsxs("option", { value: t.id, children: ["Only ", t.name, " assets"] }, t.id))] }) }), _jsx(Checkbox, { checked: f.required, onChange: (x) => setF({ ...f, required: x }), label: "Required" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
