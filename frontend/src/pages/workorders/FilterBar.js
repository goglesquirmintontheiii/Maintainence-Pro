import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// MaintainX-style filter chips: "Status: One of Open, On Hold", with One of / None of / Is empty / Contains.
import { useMemo, useState } from "react";
import { Bookmark, Check, ChevronDown, Filter as FilterIcon, Pin, Plus, Save, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Checkbox, Dropdown, Field, Input, Modal, Select } from "../../components/ui";
const OPS = {
    list: [{ id: "in", label: "One of" }, { id: "not_in", label: "None of" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    tree: [{ id: "within", label: "In or under" }, { id: "in", label: "One of" }, { id: "not_in", label: "None of" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    date: [{ id: "between", label: "Between" }, { id: "before", label: "Before" }, { id: "after", label: "After" }, { id: "overdue", label: "Overdue" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    text: [{ id: "contains", label: "Contains" }, { id: "not_contains", label: "Does not contain" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    bool: [{ id: "is", label: "Is" }],
    cdate: [{ id: "between", label: "Between" }, { id: "before", label: "Before" }, { id: "after", label: "After" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    num: [{ id: "between", label: "Between" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
    parent: [{ id: "empty", label: "Top-level only" }, { id: "not_empty", label: "Sub-work orders only" }],
};
const NO_EMPTY = new Set(["status", "priority", "work_type", "created_by", "completed_by", "procedure_result"]);
export function fieldDefs(o) {
    const people = (x) => [{ id: "me", label: "Me" }, ...x.people.map((p) => ({ id: p.id, label: p.name, initials: p.initials }))];
    const base = [
        { id: "status", label: "Status", kind: "list", options: (x) => x.statuses.map((s) => ({ id: s.id, label: s.label })) },
        { id: "priority", label: "Priority", kind: "list", options: (x) => x.priorities.map((s) => ({ id: s.id, label: s.label })) },
        { id: "assignee", label: "Assigned to", kind: "list", options: (x) => [...people(x), { id: "none", label: "Nobody" }] },
        { id: "team", label: "Team", kind: "list", options: (x) => x.teams.map((t) => ({ id: t.id, label: t.name, color: t.color })) },
        { id: "category", label: "Category", kind: "list", options: (x) => x.categories.map((c) => ({ id: c.id, label: c.name, color: c.color })) },
        { id: "due_at", label: "Due date", kind: "date" },
        { id: "start_at", label: "Start date", kind: "date" },
        { id: "work_type", label: "Work type", kind: "list", options: (x) => x.work_types.map((s) => ({ id: s.id, label: s.label })) },
        { id: "created_by", label: "Created by", kind: "list", options: people },
        { id: "completed_by", label: "Completed by", kind: "list", options: people },
        { id: "created_at", label: "Created", kind: "date" },
        { id: "completed_at", label: "Completed", kind: "date" },
        { id: "title", label: "Title", kind: "text" },
        { id: "description", label: "Description", kind: "text" },
        { id: "parent", label: "Sub-work orders", kind: "parent" },
        { id: "unread", label: "Unread", kind: "bool" },
        { id: "procedure_result", label: "Procedure result", kind: "list", options: () => [{ id: "fail", label: "A step failed" }, { id: "flag", label: "A step flagged" }, { id: "pass", label: "A step passed" }] },
        ...(o?.assets?.length ? [{ id: "asset", label: "Asset", kind: "tree", options: (x) => (x.assets ?? []).map((a) => ({ id: a.id, label: a.name, sub: a.path })) }] : []),
        ...(o?.locations?.length ? [{ id: "location", label: "Location", kind: "tree", options: (x) => (x.locations ?? []).map((a) => ({ id: a.id, label: a.name, sub: a.path })) }] : []),
        ...(o?.vendors?.length ? [{ id: "vendor", label: "Vendor", kind: "list", options: (x) => (x.vendors ?? []).map((v) => ({ id: v.id, label: v.name, color: v.color })) }] : []),
        ...(o?.can_share_external ? [{ id: "shared", label: "Shared externally", kind: "bool" }] : []),
    ];
    const custom = (o?.custom_fields ?? []).map((f) => ({
        id: `custom.${f.id}`, label: f.name,
        kind: f.type === "select" || f.type === "checkbox" ? "list" : f.type === "date" || f.type === "datetime" ? "cdate" : f.type === "number" ? "num" : "text",
        options: f.type === "select" ? () => f.options.map((x) => ({ id: x, label: x })) : f.type === "checkbox" ? () => [{ id: "true", label: "Checked" }, { id: "false", label: "Not checked" }] : undefined,
    }));
    return [...base, ...custom];
}
function describe(f, def, o) {
    if (!def)
        return f.field;
    const op = (OPS[def.kind] ?? []).find((x) => x.id === f.op)?.label ?? f.op;
    if (["empty", "not_empty", "overdue"].includes(f.op) || def.kind === "parent")
        return `${def.label}: ${op}`;
    if (def.kind === "bool")
        return def.id === "shared" ? (f.value ? "Shared externally" : "Not shared externally") : f.value ? "Unread" : "Read";
    if ((def.kind === "list" || def.kind === "tree") && o && def.options) {
        const opts = def.options(o);
        const names = (f.value ?? []).map((v) => opts.find((x) => x.id === v)?.label ?? v);
        return `${def.label}: ${f.op === "not_in" ? "not " : ""}${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ") || "—"}`;
    }
    if (def.kind === "num" && Array.isArray(f.value))
        return `${def.label}: ${f.value[0] || "…"} – ${f.value[1] || "…"}`;
    if (def.kind === "date" || def.kind === "cdate") {
        const v = f.value;
        if (f.op === "between" && Array.isArray(v))
            return `${def.label}: ${v[0] || "…"} – ${v[1] || "…"}`;
        return `${def.label}: ${op.toLowerCase()} ${v ?? ""}`;
    }
    return `${def.label}: ${op.toLowerCase()} “${f.value ?? ""}”`;
}
function FilterEditor({ filter, def, options, onChange, onRemove, close }) {
    const [f, setF] = useState(filter);
    const [q, setQ] = useState("");
    const ops = (OPS[def.kind] ?? []).filter((x) => !(NO_EMPTY.has(def.id) && (x.id === "empty" || x.id === "not_empty")));
    const vals = f.value ?? [];
    const noValue = ["empty", "not_empty", "overdue"].includes(f.op) || def.kind === "parent";
    const opts = def.options ? def.options(options).filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase())) : [];
    return (_jsxs("div", { style: { padding: 8, width: 290 }, className: "stack", children: [_jsxs("div", { className: "row", children: [_jsx("b", { className: "grow", children: def.label }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove filter", onClick: () => { onRemove(); close(); }, children: _jsx(Trash2, { size: 14 }) })] }), def.kind !== "bool" && _jsx(Select, { value: f.op, "aria-label": "Condition", onChange: (e) => setF({ ...f, op: e.target.value, value: def.kind === "list" || def.kind === "tree" ? vals : f.value }), children: ops.map((o) => _jsx("option", { value: o.id, children: o.label }, o.id)) }), !noValue && (def.kind === "list" || def.kind === "tree") && (_jsxs(_Fragment, { children: [opts.length > 7 && _jsx(Input, { placeholder: "Search", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search options" }), _jsx("div", { className: "filter-opts", children: opts.map((x) => (_jsx(Checkbox, { checked: vals.includes(x.id), onChange: (c) => setF({ ...f, value: c ? [...vals, x.id] : vals.filter((v) => v !== x.id) }), label: _jsxs("span", { className: "row", style: { gap: 6 }, children: [x.color && _jsx("span", { className: "sw lg", style: { background: x.color } }), x.initials && _jsx(Avatar, { name: x.label, initials: x.initials, size: "sm" }), x.label, x.sub && _jsx("span", { className: "small faint", children: x.sub })] }) }, x.id))) })] })), !noValue && def.kind === "num" && _jsxs("div", { className: "row", children: [_jsx(Input, { type: "number", "aria-label": "From", value: (f.value ?? [])[0] ?? "", onChange: (e) => setF({ ...f, value: [e.target.value, (f.value ?? [])[1] ?? ""] }) }), _jsx(Input, { type: "number", "aria-label": "To", value: (f.value ?? [])[1] ?? "", onChange: (e) => setF({ ...f, value: [(f.value ?? [])[0] ?? "", e.target.value] }) })] }), !noValue && (def.kind === "date" || def.kind === "cdate") && (f.op === "between"
                ? _jsxs("div", { className: "row", children: [_jsx(Input, { type: "date", "aria-label": "From", value: (f.value ?? [])[0] ?? "", onChange: (e) => setF({ ...f, value: [e.target.value, (f.value ?? [])[1] ?? ""] }) }), _jsx(Input, { type: "date", "aria-label": "To", value: (f.value ?? [])[1] ?? "", onChange: (e) => setF({ ...f, value: [(f.value ?? [])[0] ?? "", e.target.value] }) })] })
                : _jsx(Input, { type: "date", "aria-label": "Date", value: f.value ?? "", onChange: (e) => setF({ ...f, value: e.target.value }) })), !noValue && def.kind === "text" && _jsx(Input, { "aria-label": "Text", value: f.value ?? "", onChange: (e) => setF({ ...f, value: e.target.value }), autoFocus: true }), def.kind === "bool" && _jsx(Select, { value: f.value ? "1" : "0", "aria-label": "Value", onChange: (e) => setF({ ...f, value: e.target.value === "1" }), children: def.id === "shared" ? _jsxs(_Fragment, { children: [_jsx("option", { value: "1", children: "Shared externally" }), _jsx("option", { value: "0", children: "Not shared" })] }) : _jsxs(_Fragment, { children: [_jsx("option", { value: "1", children: "Unread" }), _jsx("option", { value: "0", children: "Read" })] }) }), _jsxs("div", { className: "row", style: { justifyContent: "flex-end" }, children: [_jsx(Button, { size: "sm", onClick: close, children: "Cancel" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => { onChange(f); close(); }, children: "Apply" })] })] }));
}
export function FilterBar({ filters, onChange, options, activeView, onViewChange, sort }) {
    const defs = useMemo(() => fieldDefs(options), [options]);
    const [adding, setAdding] = useState(null);
    return (_jsxs("div", { className: "filterbar", children: [_jsx(SavedViews, { filters: filters, active: activeView, onPick: (v) => { onViewChange(v); onChange(v ? v.filters : []); }, sort: sort }), filters.map((f, i) => {
                const def = defs.find((d) => d.id === f.field);
                return (_jsx(Dropdown, { align: "left", width: 306, trigger: (_, toggle) => (_jsxs("span", { className: "fchip", children: [_jsx("button", { type: "button", onClick: toggle, children: describe(f, def, options) }), _jsx("button", { type: "button", "aria-label": "Remove filter", onClick: () => onChange(filters.filter((_, j) => j !== i)), children: _jsx(X, { size: 13 }) })] })), children: (close) => def && options ? _jsx(FilterEditor, { filter: f, def: def, options: options, close: close, onChange: (nf) => onChange(filters.map((x, j) => (j === i ? nf : x))), onRemove: () => onChange(filters.filter((_, j) => j !== i)) }) : null }, i));
            }), _jsx(Dropdown, { align: "left", width: adding ? 306 : 240, trigger: (_, toggle) => _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => { setAdding(null); toggle(); }, children: [_jsx(Plus, { size: 14 }), "Add filter"] }), children: (close) => adding && options ? (_jsx(FilterEditor, { def: defs.find((d) => d.id === adding), options: options, close: () => { setAdding(null); close(); }, onRemove: () => setAdding(null), filter: { field: adding, op: (OPS[defs.find((d) => d.id === adding).kind] ?? [{ id: "in" }])[0].id, value: defs.find((d) => d.id === adding).kind === "bool" ? true : undefined }, onChange: (nf) => onChange([...filters, nf]) })) : (_jsxs("div", { style: { maxHeight: 360, overflowY: "auto" }, children: [_jsx("div", { className: "menu-label", children: "Filter by" }), defs.map((d) => _jsxs("button", { type: "button", className: "menu-item", onClick: () => setAdding(d.id), children: [_jsx(FilterIcon, { size: 14, className: "faint" }), d.label] }, d.id))] })) }), filters.length > 0 && _jsx("button", { type: "button", className: "linkbtn small", onClick: () => { onChange([]); onViewChange(null); }, children: "Reset" })] }));
}
function SavedViews({ filters, active, onPick, sort }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const views = useQuery({ queryKey: ["wo-views"], queryFn: () => api("/work-orders/views") });
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState("");
    const [shared, setShared] = useState(false);
    const err = (e) => toast(e.message, { kind: "error" });
    const save = useMutation({
        mutationFn: () => api("/work-orders/views", { method: "POST", body: { name, filters, shared, sort: sort ?? "" } }),
        onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(v); setSaving(false); toast(`Saved view “${v.name}”`); }, onError: err,
    });
    const update = useMutation({
        mutationFn: (v) => api(`/work-orders/views/${v.id}`, { method: "PATCH", body: { filters, sort: sort ?? v.sort } }),
        onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(v); toast("View updated"); }, onError: err,
    });
    const pin = useMutation({ mutationFn: (v) => api(`/work-orders/views/${v.id}`, { method: "PATCH", body: { pinned: !v.pinned } }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["wo-views"] }), onError: err });
    const del = useMutation({ mutationFn: (v) => api(`/work-orders/views/${v.id}`, { method: "DELETE" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(null); toast("View deleted"); }, onError: err });
    const changed = active && JSON.stringify(active.filters) !== JSON.stringify(filters);
    const pinned = (views.data?.items ?? []).filter((v) => v.pinned);
    return (_jsxs(_Fragment, { children: [pinned.map((v) => _jsxs("button", { type: "button", className: "vchip" + (active?.id === v.id ? " active" : ""), onClick: () => onPick(active?.id === v.id ? null : v), children: [_jsx(Pin, { size: 12 }), v.name] }, v.id)), _jsx(Dropdown, { align: "left", width: 280, trigger: (_, toggle) => (_jsxs(Button, { size: "sm", onClick: toggle, "aria-label": "Saved views", children: [_jsx(Bookmark, { size: 14 }), active && !active.pinned ? active.name : "Views", changed && " •", _jsx(ChevronDown, { size: 13 })] })), children: (close) => _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "Saved views" }), (views.data?.items ?? []).length === 0 && _jsx("div", { className: "small faint", style: { padding: "4px 10px 8px" }, children: "Filter the list, then save it as a view." }), (views.data?.items ?? []).map((v) => {
                            const mine = !v.shared || can("views.share");
                            return (_jsxs("div", { className: "menu-item", style: { padding: "4px 6px 4px 10px" }, children: [_jsxs("button", { type: "button", className: "grow linkbtn", style: { color: "var(--c-text)", fontWeight: 500, textAlign: "left" }, onClick: () => { onPick(v); close(); }, children: [v.name, v.shared && _jsx("span", { className: "small faint", children: " \u00B7 shared" })] }), active?.id === v.id && _jsx(Check, { size: 14, color: "var(--c-primary)" }), mine && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": v.pinned ? "Unpin" : "Pin", onClick: () => pin.mutate(v), children: _jsx(Pin, { size: 13, style: { opacity: v.pinned ? 1 : 0.4 } }) }), mine && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Delete view", onClick: () => del.mutate(v), children: _jsx(Trash2, { size: 13 }) })] }, v.id));
                        }), _jsx("div", { className: "menu-sep" }), changed && active && (!active.shared || can("views.share")) && _jsxs("button", { type: "button", className: "menu-item", onClick: () => { update.mutate(active); close(); }, children: [_jsx(Save, { size: 14 }), "Update \u201C", active.name, "\u201D"] }), _jsxs("button", { type: "button", className: "menu-item", disabled: !filters.length, onClick: () => { setName(""); setShared(false); setSaving(true); close(); }, children: [_jsx(Plus, { size: 14 }), "Save current filters as a view"] })] }) }), saving && (_jsxs(Modal, { title: "Save view", onClose: () => setSaving(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setSaving(false), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || save.isPending, onClick: () => save.mutate(), children: "Save view" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: name, onChange: (e) => setName(e.target.value), placeholder: "e.g. High priority electrical", autoFocus: true }) }), can("views.share") && _jsx(Checkbox, { checked: shared, onChange: setShared, label: "Share with everyone in the organization" })] }))] }));
}
