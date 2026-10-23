import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Settings → Roles and permissions (MP-106): built-in and custom roles, a permission editor grouped by area,
// and a "view as" preview that shows what a role can see and do (a summary, not impersonation).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Plus, RotateCcw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import "../../styles/roles.css";
const err = (e) => e.message;
export function RolesPage() {
    const { can } = useSession();
    const manage = can("roles.manage");
    const [showDeleted, setShowDeleted] = useState(false);
    const roles = useQuery({ queryKey: ["roles", showDeleted], queryFn: () => api(`/roles${showDeleted ? "?include_deleted=1" : ""}`) });
    const cat = useQuery({ queryKey: ["roles", "catalogue"], queryFn: () => api("/roles/catalogue"), staleTime: 300_000 });
    const [selected, setSelected] = useState("");
    const [creating, setCreating] = useState(null); // base role to start from
    const list = roles.data ?? [];
    const current = list.find((r) => r.key === selected) ?? list[0];
    if (!roles.data || !cat.data)
        return _jsx(ListSkeleton, { rows: 8 });
    const builtin = list.filter((r) => !r.custom);
    const custom = list.filter((r) => r.custom);
    return (_jsxs("div", { className: "stack", style: { gap: 20 }, children: [_jsxs("div", { className: "row roles-intro", children: [_jsx("p", { className: "muted", style: { margin: 0 }, children: "Roles decide what people can see and do. Start a custom role from a built-in one and add or take away permissions." }), manage && _jsxs(Button, { variant: "primary", onClick: () => setCreating("technician"), children: [_jsx(Plus, { size: 16 }), "New role"] })] }), !manage && _jsx("div", { className: "banner info", children: "Only Owners can create and change roles. You can see how they're set up." }), _jsxs("div", { className: "roles-layout", children: [_jsxs("nav", { className: "card roles-list", "aria-label": "Roles", children: [_jsx("div", { className: "roles-group", children: "Built-in roles" }), builtin.map((r) => _jsx(RoleRow, { r: r, active: current?.key === r.key, onClick: () => setSelected(r.key) }, r.key)), _jsx("div", { className: "roles-group", children: "Custom roles" }), custom.length === 0 && _jsx("p", { className: "small faint", style: { padding: "0 16px 12px", margin: 0 }, children: "No custom roles yet." }), custom.map((r) => _jsx(RoleRow, { r: r, active: current?.key === r.key, onClick: () => setSelected(r.key) }, r.key)), manage && _jsx("div", { style: { padding: "8px 16px 14px" }, children: _jsx(Toggle, { label: "Show deleted roles", checked: showDeleted, onChange: setShowDeleted }) })] }), current && _jsx(RoleEditor, { role: current, cat: cat.data, manage: manage, onSelect: setSelected, onStartFrom: (base) => setCreating(base) }, current.key + (current.deleted ? ":d" : ""))] }), creating !== null && _jsx(CreateRole, { base: creating, cat: cat.data, roles: builtin, onClose: () => setCreating(null), onCreated: (r) => { setCreating(null); setSelected(r.key); } })] }));
}
function RoleRow({ r, active, onClick }) {
    return (_jsxs("button", { type: "button", className: "roles-row" + (active ? " active" : ""), "aria-current": active ? "true" : undefined, onClick: onClick, children: [_jsxs("span", { className: "grow", children: [_jsxs("span", { className: "roles-row-name", children: [r.label, r.deleted && _jsx(Pill, { tone: "warning", children: "Deleted" })] }), r.custom && r.base_label && _jsxs("span", { className: "small faint", children: ["Based on ", r.base_label] })] }), _jsx("span", { className: "small muted", title: `${r.members} ${r.members === 1 ? "person" : "people"}`, children: r.members })] }));
}
function CreateRole({ base, cat, roles, onClose, onCreated }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [f, setF] = useState({ name: "", description: "", base: cat.bases.includes(base) ? base : "technician", wo: base === "operator" ? "limited" : "all" });
    const create = useMutation({
        mutationFn: () => api("/roles", { method: "POST", body: { name: f.name, description: f.description, base: f.base, settings: { wo_visibility: f.wo } } }),
        onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["roles"] }); toast(`Created ${r.name}`); onCreated(r); },
        onError: (e) => toast(err(e), { kind: "error" }),
    });
    const label = (k) => roles.find((r) => r.key === k)?.label ?? k;
    return (_jsx(Modal, { title: "New role", onClose: onClose, width: 480, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || create.isPending, onClick: () => create.mutate(), children: "Create role" })] }), children: _jsxs("form", { className: "stack", onSubmit: (e) => { e.preventDefault(); if (f.name.trim())
                create.mutate(); }, children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, maxLength: 60, value: f.name, placeholder: "e.g. Shift lead", onChange: (e) => setF({ ...f, name: e.target.value }) }) }), _jsx(Field, { label: "Start from", hint: "The new role gets this role's permissions. You can change them afterwards.", children: (id) => (_jsx(Select, { id: id, value: f.base, onChange: (e) => setF({ ...f, base: e.target.value, wo: e.target.value === "operator" ? "limited" : f.wo }), children: cat.bases.map((b) => _jsx("option", { value: b, children: label(b) }, b)) })) }), _jsx(Field, { label: "Work orders they see", children: (id) => (_jsxs(Select, { id: id, value: f.wo, onChange: (e) => setF({ ...f, wo: e.target.value }), children: [_jsx("option", { value: "all", children: "All work orders" }), _jsx("option", { value: "limited", children: "Only work assigned to them or their teams" })] })) }), _jsx(Field, { label: "Description (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: f.description, onChange: (e) => setF({ ...f, description: e.target.value }) }) }), _jsx("button", { type: "submit", hidden: true })] }) }));
}
function RoleEditor({ role, cat, manage, onSelect, onStartFrom }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const { session } = useSession();
    const mine = useMemo(() => new Set(session.permissions ?? []), [session.permissions]);
    const editable = manage && role.custom && !role.deleted;
    const initial = () => ({ name: role.name, description: role.description ?? "", permissions: [...role.permissions],
        wo_visibility: role.settings?.wo_visibility === "limited" ? "limited" : "all" });
    const [d, setD] = useState(initial);
    useEffect(() => setD(initial()), [role]); // reset when the saved role changes
    const [q, setQ] = useState("");
    const [area, setArea] = useState("");
    const [onlyChanged, setOnlyChanged] = useState(false);
    const [sort, setSort] = useState("area");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [preview, setPreview] = useState(false);
    const basePerms = useMemo(() => new Set(cat.builtin[role.custom ? role.base ?? "technician" : role.key] ?? []), [cat, role]);
    const have = useMemo(() => new Set(d.permissions), [d.permissions]);
    const dirty = editable && (d.name !== role.name || d.description !== (role.description ?? "") || d.wo_visibility !== (role.settings?.wo_visibility === "limited" ? "limited" : "all")
        || d.permissions.length !== role.permissions.length || d.permissions.some((p) => !role.permissions.includes(p)));
    const invalidate = () => qc.invalidateQueries({ queryKey: ["roles"] });
    const save = useMutation({
        mutationFn: () => api(`/roles/${role.id}`, { method: "PATCH", body: { name: d.name, description: d.description, permissions: d.permissions, settings: { wo_visibility: d.wo_visibility } } }),
        onSuccess: () => { invalidate(); toast("Role saved"); }, onError: (e) => toast(err(e), { kind: "error" }),
    });
    const duplicate = useMutation({
        mutationFn: () => api(`/roles/${role.id}/duplicate`, { method: "POST" }),
        onSuccess: (r) => { invalidate(); onSelect(r.key); toast(`Created ${r.name}`); }, onError: (e) => toast(err(e), { kind: "error" }),
    });
    const remove = useMutation({
        mutationFn: () => api(`/roles/${role.id}`, { method: "DELETE" }),
        onSuccess: (x) => {
            setConfirmDelete(false);
            invalidate();
            onSelect("");
            qc.invalidateQueries({ queryKey: ["users"] });
            toast(x.moved ? `Role deleted. ${x.moved} ${x.moved === 1 ? "person moved" : "people moved"} to ${x.moved_to_label ?? role.fallback_label ?? role.base_label}.` : "Role deleted");
        },
        onError: (e) => toast(err(e), { kind: "error" }),
    });
    const restore = useMutation({
        mutationFn: () => api(`/roles/${role.id}/restore`, { method: "POST" }),
        onSuccess: () => { invalidate(); toast("Role restored"); }, onError: (e) => toast(err(e), { kind: "error" }),
    });
    const changed = (id) => have.has(id) !== basePerms.has(id);
    const needle = q.trim().toLowerCase();
    const labelOf = (id) => cat.actions.find((x) => x.id === id)?.label ?? "";
    const pairChanged = (a) => changed(a.id) || (!!a.own && changed(a.own));
    const visible = cat.actions.filter((a) => !a.own_of && (!area || a.area === area)
        && (!needle || a.label.toLowerCase().includes(needle) || a.id.includes(needle) || (!!a.own && labelOf(a.own).toLowerCase().includes(needle)))
        && (!onlyChanged || pairChanged(a)));
    const groups = cat.areas.map((ar) => ({ ...ar, actions: visible.filter((a) => a.area === ar.id) })).filter((g) => g.actions.length);
    if (sort === "name")
        groups.forEach((g) => g.actions.sort((a, b) => a.label.localeCompare(b.label)));
    const lockedReason = (a) => a.owner_only ? "Only Owners have this" : a.id === "org.view" ? "Everyone has this" : !mine.has(a.id) ? "You don't have this permission yourself" : "";
    const toggle = (id, on) => setD((x) => ({ ...x, permissions: on ? [...new Set([...x.permissions, id])] : x.permissions.filter((p) => p !== id) }));
    const changedCount = cat.actions.filter((a) => !a.own_of && pairChanged(a)).length;
    const scopeOf = (a) => (have.has(a.id) ? "any" : a.own && have.has(a.own) ? "own" : "none");
    const setScope = (a, v) => setD((x) => {
        const rest = x.permissions.filter((p) => p !== a.id && p !== a.own);
        return { ...x, permissions: v === "any" ? [...rest, a.id, ...(a.own ? [a.own] : [])] : v === "own" && a.own ? [...rest, a.own] : rest };
    });
    return (_jsxs("section", { className: "card roles-editor", "aria-labelledby": "role-title", children: [_jsxs("div", { className: "card-head roles-editor-head", children: [_jsxs("div", { children: [_jsxs("h2", { id: "role-title", className: "row", style: { gap: 8 }, children: [role.label, role.custom ? _jsx(Pill, { children: "Custom" }) : _jsx(Pill, { tone: "info", children: "Built-in" })] }), _jsxs("span", { className: "small muted", children: [role.members, " ", role.members === 1 ? "person has" : "people have", " this role", role.custom && role.base_label ? ` · based on ${role.base_label}` : ""] })] }), _jsxs("div", { className: "row roles-actions", children: [_jsxs(Button, { size: "sm", onClick: () => setPreview(true), children: [_jsx(Eye, { size: 14 }), "View as"] }), manage && !role.custom && role.key !== "owner" && _jsxs(Button, { size: "sm", onClick: () => onStartFrom(role.key), children: [_jsx(Copy, { size: 14 }), "Start a role from this"] }), manage && role.custom && !role.deleted && _jsxs(Button, { size: "sm", disabled: duplicate.isPending, onClick: () => duplicate.mutate(), children: [_jsx(Copy, { size: 14 }), "Duplicate"] }), manage && role.custom && !role.deleted && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setConfirmDelete(true), children: [_jsx(Trash2, { size: 14 }), "Delete"] }), manage && role.deleted && _jsxs(Button, { size: "sm", disabled: restore.isPending, onClick: () => restore.mutate(), children: [_jsx(RotateCcw, { size: 14 }), "Restore"] })] })] }), _jsxs("div", { className: "card-body stack", children: [!role.custom && _jsxs("p", { className: "small muted", style: { margin: 0 }, children: [role.description, " Built-in roles can't be changed; start a custom role from one instead."] }), role.deleted && _jsx("div", { className: "banner warning", children: "This role is deleted. Restore it to use it again." }), role.custom && (_jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, maxLength: 60, value: d.name, disabled: !editable, onChange: (e) => setD({ ...d, name: e.target.value }) }) }), _jsx(Field, { label: "Work orders they see", children: (id) => (_jsxs(Select, { id: id, value: d.wo_visibility, disabled: !editable, onChange: (e) => setD({ ...d, wo_visibility: e.target.value }), children: [_jsx("option", { value: "all", children: "All work orders" }), _jsx("option", { value: "limited", children: "Only work assigned to them or their teams" })] })) }), _jsx(Field, { label: "Description", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: d.description, disabled: !editable, onChange: (e) => setD({ ...d, description: e.target.value }) }) })] })), _jsxs("div", { className: "roles-filters", children: [_jsxs("label", { className: "roles-search", children: [_jsx(Search, { size: 14, "aria-hidden": "true", className: "faint" }), _jsx("input", { className: "input", type: "search", placeholder: "Search permissions", "aria-label": "Search permissions", value: q, onChange: (e) => setQ(e.target.value) })] }), _jsxs(Select, { "aria-label": "Area", value: area, onChange: (e) => setArea(e.target.value), children: [_jsx("option", { value: "", children: "All areas" }), cat.areas.map((a) => _jsx("option", { value: a.id, children: a.label }, a.id))] }), _jsxs(Select, { "aria-label": "Sort", value: sort, onChange: (e) => setSort(e.target.value), children: [_jsx("option", { value: "area", children: "Default order" }), _jsx("option", { value: "name", children: "A to Z" })] }), role.custom && _jsx(Checkbox, { checked: onlyChanged, onChange: setOnlyChanged, label: `Only changed from ${role.base_label ?? "base role"} (${changedCount})` })] }), groups.length === 0 ? _jsx(EmptyState, { icon: _jsx(ShieldCheck, { size: 28 }), title: "No permissions match", children: "Try a different search or area." }) : groups.map((g) => {
                        const settable = g.actions.filter((a) => !lockedReason(a));
                        const on = settable.filter((a) => have.has(a.id)).length;
                        return (_jsxs("fieldset", { className: "roles-area", children: [_jsxs("legend", { className: "row", style: { gap: 10 }, children: [_jsx("span", { className: "roles-area-title", children: g.label }), _jsxs("span", { className: "small faint", children: [g.actions.filter((a) => have.has(a.id)).length, " of ", g.actions.length] }), editable && settable.length > 0 && _jsx(Checkbox, { label: "Select all", checked: on === settable.length, indeterminate: on > 0 && on < settable.length, onChange: (v) => setD((x) => { const ids = new Set(settable.flatMap((a) => (a.own ? [a.id, a.own] : [a.id]))); const rest = x.permissions.filter((p) => !ids.has(p)); return { ...x, permissions: v ? [...rest, ...ids] : rest }; }) })] }), _jsx("ul", { className: "roles-perms", children: g.actions.map((a) => {
                                        const reason = lockedReason(a);
                                        if (a.own) {
                                            const own = a.own;
                                            const ownLocked = !mine.has(own) && !mine.has(a.id);
                                            return (_jsxs("li", { className: "roles-scope" + (pairChanged(a) && role.custom ? " changed" : ""), children: [_jsx("label", { className: "roles-scope-label", htmlFor: `scope-${a.id}`, children: a.label }), _jsxs(Select, { id: `scope-${a.id}`, value: scopeOf(a), disabled: !editable || (!!reason && ownLocked), onChange: (e) => setScope(a, e.target.value), "aria-describedby": `scope-hint-${a.id}`, children: [_jsx("option", { value: "none", children: "No" }), _jsx("option", { value: "own", disabled: ownLocked, children: "Only their own" }), _jsx("option", { value: "any", disabled: !mine.has(a.id), children: "Any" })] }), _jsxs("span", { id: `scope-hint-${a.id}`, className: "small faint", children: ["Their own: created by them", a.id.startsWith("wo.") ? " or assigned to them or their team" : a.id.startsWith("assets.") ? " or their team is in charge" : a.id.startsWith("po.") ? " or requested by them" : ""] }), role.custom && pairChanged(a) && _jsx("span", { className: "small roles-diff", children: "Changed" })] }, a.id));
                                        }
                                        return (_jsxs("li", { className: changed(a.id) && role.custom ? "changed" : "", children: [_jsx(Checkbox, { checked: have.has(a.id), disabled: !editable || !!reason, onChange: (v) => toggle(a.id, v), label: a.label }), role.custom && changed(a.id) && _jsx("span", { className: "small roles-diff", children: have.has(a.id) ? "Added" : "Removed" }), editable && reason && _jsx("span", { className: "small faint", children: reason })] }, a.id));
                                    }) })] }, g.id));
                    })] }), editable && (_jsxs("div", { className: "roles-savebar", children: [_jsx("span", { className: "small muted", children: dirty ? "You have unsaved changes." : "All changes saved." }), _jsxs("div", { className: "row", children: [_jsx(Button, { disabled: !dirty, onClick: () => setD(initial()), children: "Discard" }), _jsx(Button, { variant: "primary", disabled: !dirty || !d.name.trim() || save.isPending, onClick: () => save.mutate(), children: "Save role" })] })] })), confirmDelete && (_jsx(Modal, { title: `Delete ${role.name}?`, onClose: () => setConfirmDelete(false), width: 440, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Cancel" }), _jsx(Button, { variant: "danger", disabled: remove.isPending, onClick: () => remove.mutate(), children: "Delete role" })] }), children: _jsxs("p", { style: { marginTop: 0 }, children: [role.members > 0
                            ? `${role.members} ${role.members === 1 ? "person has" : "people have"} this role. They'll move to ${role.fallback_label ?? "View-only"}, the most limited built-in role that has all of this role's permissions.`
                            : "Nobody has this role.", " You can restore it later from \u201CShow deleted roles\u201D."] }) })), preview && _jsx(ViewAsPanel, { roleKey: role.key, onClose: () => setPreview(false) })] }));
}
function ViewAsPanel({ roleKey, onClose }) {
    const v = useQuery({ queryKey: ["roles", "view-as", roleKey], queryFn: () => api(`/roles/view-as?role=${encodeURIComponent(roleKey)}`) });
    return (_jsx(Modal, { title: v.data ? `Viewing as ${v.data.label}` : "View as", onClose: onClose, width: 640, footer: _jsx(Button, { onClick: onClose, children: "Close" }), children: !v.data ? _jsx(ListSkeleton, { rows: 4 }) : (_jsxs("div", { className: "stack", children: [_jsx("p", { className: "small muted", style: { margin: 0 }, children: "A summary of what someone with this role can see and do. You stay signed in as yourself." }), _jsxs("div", { className: "banner info", children: [_jsx("strong", { children: "Work orders:" }), "\u00A0", v.data.work_orders] }), _jsx("div", { className: "roles-viewas", children: v.data.areas.filter((a) => a.can.length + a.cannot.length > 0).map((a) => (_jsxs("div", { className: "roles-viewas-area", children: [_jsx("h3", { children: a.label }), a.can.length > 0 && _jsx("ul", { className: "roles-can", children: a.can.map((x) => _jsx("li", { children: x }, x)) }), a.cannot.length > 0 && _jsx("ul", { className: "roles-cannot", children: a.cannot.map((x) => _jsx("li", { children: x }, x)) })] }, a.id))) })] })) }));
}
