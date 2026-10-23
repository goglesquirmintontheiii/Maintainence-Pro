import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Settings → Purchasing (0.5.0, MP-042–044, r227–r268): PO numbering and defaults, CC list, addresses, approval
// rules, budgets, and custom fields for purchase orders and vendors.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { useTeams } from "../assets/shared";
import { useVendorsLite } from "./POForm";
import { addrLines } from "./types";
import "./purchasing.css";
export function PurchasingSettingsPage() {
    const { can } = useSession();
    const ro = !can("po.settings");
    return (_jsxs("div", { className: "stack", style: { gap: 20 }, children: [ro && _jsx("div", { className: "banner info", children: "Only administrators can change purchasing settings. You can see how they're set up." }), _jsx(General, { ro: ro }), _jsx(Addresses, { ro: ro }), _jsx(Rules, { ro: ro }), _jsx(Budgets, { ro: ro }), _jsx(EntityFields, { entity: "purchase_order", title: "Purchase order fields", ro: ro }), _jsx(EntityFields, { entity: "vendor", title: "Vendor fields", ro: !can("vendors.manage") })] }));
}
function General({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const s = useQuery({ queryKey: ["po-settings"], queryFn: () => api("/purchasing/settings") });
    const [cc, setCc] = useState(null);
    const [next, setNext] = useState(null);
    const save = useMutation({
        mutationFn: (b) => api("/purchasing/settings", { method: "PATCH", body: b }),
        onSuccess: (x) => { qc.setQueryData(["po-settings"], x); qc.invalidateQueries({ queryKey: ["po-options"] }); setCc(null); setNext(null); toast("Saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!s.data)
        return _jsx(ListSkeleton, { rows: 4 });
    const v = s.data;
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Purchase orders" }) }), _jsxs("div", { className: "card-body stack", children: [_jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Number prefix", hint: `Next: ${v.number_prefix}${v.next_number}`, children: (id) => _jsx(Input, { id: id, defaultValue: v.number_prefix, maxLength: 12, disabled: ro, onBlur: (e) => { if (e.target.value !== v.number_prefix)
                                        save.mutate({ number_prefix: e.target.value }); } }) }), _jsx(Field, { label: "Next number", hint: "Can't go below a number already used", children: (id) => _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Input, { id: id, inputMode: "numeric", value: next ?? String(v.next_number), disabled: ro, onChange: (e) => setNext(e.target.value) }), next !== null && _jsx(Button, { size: "sm", onClick: () => save.mutate({ next_number: Number(next) }), children: "Set" })] }) }), _jsx(Field, { label: "Default title", children: (id) => _jsx(Input, { id: id, defaultValue: v.default_title, maxLength: 120, disabled: ro, onBlur: (e) => { if (e.target.value !== v.default_title)
                                        save.mutate({ default_title: e.target.value }); } }) })] }), _jsx(Field, { label: "Always CC", hint: "These addresses get a copy of every purchase order you send. Separate with commas.", children: (id) => _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Input, { id: id, className: "grow", value: cc ?? v.default_cc.join(", "), disabled: ro, onChange: (e) => setCc(e.target.value), placeholder: "purchasing@yourcompany.com" }), cc !== null && _jsx(Button, { size: "sm", onClick: () => save.mutate({ default_cc: cc.split(/[,;\s]+/).filter(Boolean) }), children: "Save" })] }) }), _jsx(Toggle, { label: "One address for shipping and billing", hint: "Purchase orders use the shipping address for billing too.", checked: v.single_address, disabled: ro, onChange: (x) => save.mutate({ single_address: x }) }), _jsx(Toggle, { label: "Requests need review", hint: "Purchase orders requested by technicians wait for someone who manages purchase orders.", checked: v.requests_need_review, disabled: ro, onChange: (x) => save.mutate({ requests_need_review: x }) })] })] }));
}
// ---------------------------------------------------------------- addresses (r253)
function Addresses({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const list = useQuery({ queryKey: ["addresses"], queryFn: () => api("/addresses") });
    const [edit, setEdit] = useState(null);
    const done = () => { qc.invalidateQueries({ queryKey: ["addresses"] }); qc.invalidateQueries({ queryKey: ["po-options"] }); };
    const del = useMutation({ mutationFn: (a) => api(`/addresses/${a.id}`, { method: "DELETE" }), onSuccess: done, onError: (e) => toast(e.message, { kind: "error" }) });
    const items = list.data?.items ?? [];
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Shipping and billing addresses" }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add address"] })] }), items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Add where vendors ship to and send invoices. The default ones fill in on new purchase orders." })
                : items.map((a) => _jsxs("div", { className: "list-row", style: { borderLeft: 0, alignItems: "flex-start" }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [a.label || a.line1, " ", a.is_default && _jsx(Pill, { tone: "info", children: "Default" }), " ", _jsx("span", { className: "small faint", children: { shipping: "Shipping", billing: "Billing", both: "Shipping and billing" }[a.kind] })] }), _jsx("div", { className: "s prewrap", children: addrLines(a).join(", ") })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${a.label}`, onClick: () => setEdit(a), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${a.label}`, onClick: () => del.mutate(a), children: _jsx(Trash2, { size: 14 }) })] })] }, a.id)), edit && _jsx(AddressModal, { edit: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: () => { setEdit(null); done(); } })] }));
}
function AddressModal({ edit, onClose, onDone }) {
    const [a, setA] = useState(edit ?? { kind: "both", is_default: false, country: "" });
    const [err, setErr] = useState("");
    const m = useMutation({ mutationFn: () => edit ? api(`/addresses/${edit.id}`, { method: "PATCH", body: a }) : api("/addresses", { method: "POST", body: a }),
        onSuccess: onDone, onError: (e) => setErr(e.message) });
    const t = (k, label, max = 200) => _jsx(Field, { label: label, children: (id) => _jsx(Input, { id: id, value: a[k] ?? "", maxLength: max, onChange: (e) => setA({ ...a, [k]: e.target.value }) }) });
    return (_jsxs(Modal, { title: edit ? "Edit address" : "New address", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsxs("div", { className: "po-form-grid", children: [t("label", "Name", 120), _jsx(Field, { label: "Used for", children: (id) => _jsxs(Select, { id: id, value: a.kind, onChange: (e) => setA({ ...a, kind: e.target.value }), children: [_jsx("option", { value: "both", children: "Shipping and billing" }), _jsx("option", { value: "shipping", children: "Shipping" }), _jsx("option", { value: "billing", children: "Billing" })] }) }), t("company", "Company"), t("attention", "Attention"), t("line1", "Street"), t("line2", "Line 2"), t("city", "City", 120), t("region", "State / region", 120), t("postal_code", "Postal code", 20), t("country", "Country (2 letters)", 2), t("phone", "Phone", 60), _jsx(Field, { label: "Site", children: (id) => _jsx(LocationPicker, { id: id, value: a.location_id ?? null, onChange: (v) => setA({ ...a, location_id: v }), placeholder: "Any site" }) })] }), _jsx(Checkbox, { checked: !!a.is_default, onChange: (v) => setA({ ...a, is_default: v }), label: "Use by default on new purchase orders" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
// ---------------------------------------------------------------- approval rules (r230)
const COND_FIELDS = [["total", "Total"], ["vendor", "Vendor"], ["location", "Site"], ["category", "Category"],
    ["has_one_off", "Has items that aren't parts"], ["zero_cost_part", "Has a part with no cost"], ["over_budget", "Goes over its budget"]];
function useUsersLite() {
    return useQuery({ queryKey: ["users-lite"], queryFn: () => api("/users?per_page=500"), staleTime: 60_000 });
}
function condLabel(c, names, cur) {
    const f = COND_FIELDS.find(([k]) => k === c.field)?.[1] ?? c.field;
    if (c.field === "total")
        return c.op === "between" && Array.isArray(c.value) ? `Total between ${currency(c.value[0], cur)} and ${currency(c.value[1], cur)}` : `Total ${c.op} ${currency(c.value, cur)}`;
    if (Array.isArray(c.value))
        return `${f}: ${c.value.map((x) => names[String(x)] ?? "…").join(", ")}`;
    if (c.field === "category")
        return `Category is ${String(c.value)}`;
    return f;
}
function Rules({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const { session } = useSession();
    const list = useQuery({ queryKey: ["approval-rules"], queryFn: () => api("/approval-rules?applies_to=purchase_order") });
    const users = useUsersLite();
    const teams = useTeams();
    const vendors = useVendorsLite();
    const [edit, setEdit] = useState(null);
    const done = () => qc.invalidateQueries({ queryKey: ["approval-rules"] });
    const err = (e) => toast(e.message, { kind: "error" });
    const del = useMutation({ mutationFn: (r) => api(`/approval-rules/${r.id}`, { method: "DELETE" }), onSuccess: done, onError: err });
    const toggle = useMutation({ mutationFn: (r) => api(`/approval-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }), onSuccess: done, onError: err });
    const names = Object.fromEntries([...(users.data?.items ?? []), ...(teams.data?.items ?? []), ...(vendors.data?.items ?? [])].map((x) => [x.id, x.name]));
    const items = list.data?.items ?? [];
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Approval rules" }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add rule"] })] }), _jsx("div", { className: "card-body small muted", style: { paddingBottom: 0 }, children: "Every matching rule adds an approval step; each step needs one of its approvers. Without a matching rule, purchase orders from people who manage them are approved right away." }), items.length === 0 ? _jsxs("div", { className: "card-body small faint", children: ["No rules yet. For example: orders of ", currency(5000, session.org?.currency), " or more need the plant manager."] })
                : items.map((r) => _jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [r.name, " ", !r.active && _jsx(Pill, { children: "Off" })] }), _jsx("div", { className: "s", children: (r.conditions.length ? r.conditions.map((c) => condLabel(c, names, session.org?.currency)).join(" and ") : "Every purchase order") + " → "
                                        + (r.action === "auto_approve" ? "approve automatically" : [...r.approver_user_ids, ...r.approver_team_ids].map((x) => names[x] ?? "…").join(" or ")) })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", onClick: () => toggle.mutate(r), children: r.active ? "Turn off" : "Turn on" }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${r.name}`, onClick: () => setEdit(r), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${r.name}`, onClick: () => del.mutate(r), children: _jsx(Trash2, { size: 14 }) })] })] }, r.id)), edit && _jsx(RuleModal, { edit: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: () => { setEdit(null); done(); } })] }));
}
function RuleModal({ edit, onClose, onDone }) {
    const users = useUsersLite();
    const teams = useTeams();
    const vendors = useVendorsLite();
    const [name, setName] = useState(edit?.name ?? "");
    const [conds, setConds] = useState(edit?.conditions ?? [{ field: "total", op: ">=", value: "" }]);
    const [action, setAction] = useState(edit?.action ?? "approvers");
    const [approvers, setApprovers] = useState([...(edit?.approver_user_ids ?? []).map((x) => `u:${x}`), ...(edit?.approver_team_ids ?? []).map((x) => `t:${x}`)]);
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => {
            const body = { name, conditions: conds, action, approver_user_ids: approvers.filter((x) => x.startsWith("u:")).map((x) => x.slice(2)),
                approver_team_ids: approvers.filter((x) => x.startsWith("t:")).map((x) => x.slice(2)), applies_to: "purchase_order" };
            return edit ? api(`/approval-rules/${edit.id}`, { method: "PATCH", body }) : api("/approval-rules", { method: "POST", body });
        },
        onSuccess: onDone, onError: (e) => setErr(e.message),
    });
    const setC = (i, c) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, ...c } : x)));
    const reset = (field) => field === "total" ? { field, op: ">=", value: "" } : field === "vendor" || field === "location" ? { field, op: "in", value: [] }
        : field === "category" ? { field, op: "=", value: "" } : { field, op: "=", value: true };
    return (_jsxs(Modal, { title: edit ? "Edit approval rule" : "New approval rule", width: 640, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: name, maxLength: 200, onChange: (e) => setName(e.target.value), placeholder: "e.g. Big orders" }) }), _jsx("h3", { className: "sec-h", children: "When" }), conds.length === 0 && _jsx("p", { className: "small muted", children: "Every purchase order." }), conds.map((c, i) => _jsxs("div", { className: "row wrap", style: { gap: 6, marginBottom: 6 }, children: [_jsx(Select, { "aria-label": "Condition", value: c.field, onChange: (e) => setC(i, reset(e.target.value)), style: { maxWidth: 220 }, children: COND_FIELDS.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }), c.field === "total" && _jsxs(_Fragment, { children: [_jsx(Select, { "aria-label": "Comparison", value: c.op, onChange: (e) => setC(i, { op: e.target.value, value: e.target.value === "between" ? ["", ""] : "" }), style: { maxWidth: 110 }, children: [">=", ">", "<=", "<", "between"].map((o) => _jsx("option", { value: o, children: o === "between" ? "between" : o }, o)) }), c.op === "between" && Array.isArray(c.value)
                                ? _jsxs(_Fragment, { children: [_jsx(Input, { "aria-label": "From", inputMode: "decimal", value: String(c.value[0] ?? ""), style: { maxWidth: 110 }, onChange: (e) => setC(i, { value: [e.target.value, c.value[1]] }) }), _jsx(Input, { "aria-label": "To", inputMode: "decimal", value: String(c.value[1] ?? ""), style: { maxWidth: 110 }, onChange: (e) => setC(i, { value: [c.value[0], e.target.value] }) })] })
                                : _jsx(Input, { "aria-label": "Amount", inputMode: "decimal", value: String(c.value ?? ""), style: { maxWidth: 140 }, onChange: (e) => setC(i, { value: e.target.value }) })] }), c.field === "vendor" && _jsx("div", { className: "grow", children: _jsx(MultiPicker, { label: "Vendors", placeholder: "Pick vendors", value: c.value ?? [], onChange: (v) => setC(i, { value: v }), options: (vendors.data?.items ?? []).map((v) => ({ key: v.id, label: v.name })) }) }), c.field === "location" && _jsx("div", { className: "grow", children: _jsx(LocationPicker, { value: (c.value ?? [])[0] ?? null, onChange: (v) => setC(i, { value: v ? [v] : [] }), placeholder: "Pick a site" }) }), c.field === "category" && _jsx(Input, { "aria-label": "Category", value: String(c.value ?? ""), onChange: (e) => setC(i, { value: e.target.value }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove condition", onClick: () => setConds((cs) => cs.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }, i)), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setConds((cs) => [...cs, reset("total")]), children: [_jsx(Plus, { size: 14 }), "Add condition"] }), _jsx("h3", { className: "sec-h", children: "Then" }), _jsxs(Select, { "aria-label": "Action", value: action, onChange: (e) => setAction(e.target.value), children: [_jsx("option", { value: "approvers", children: "Needs approval from" }), _jsx("option", { value: "auto_approve", children: "Approve automatically" })] }), action === "approvers" && _jsx("div", { style: { marginTop: 8 }, children: _jsx(MultiPicker, { label: "Approvers", placeholder: "Pick people or teams", value: approvers, onChange: setApprovers, options: [...(users.data?.items ?? []).map((u) => ({ key: `u:${u.id}`, label: u.name, sub: u.email })), ...(teams.data?.items ?? []).map((t) => ({ key: `t:${t.id}`, label: t.name, sub: "Team" }))] }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
// ---------------------------------------------------------------- budgets (r268)
function Budgets({ ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const list = useQuery({ queryKey: ["budgets"], queryFn: () => api("/budgets") });
    const [edit, setEdit] = useState(null);
    const done = () => { qc.invalidateQueries({ queryKey: ["budgets"] }); qc.invalidateQueries({ queryKey: ["po-options"] }); };
    const del = useMutation({ mutationFn: (b) => api(`/budgets/${b.id}`, { method: "DELETE" }), onSuccess: done, onError: (e) => toast(e.message, { kind: "error" }) });
    const items = list.data?.items ?? [];
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Budgets" }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add budget"] })] }), items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "Set a maintenance budget per site or category. Purchase orders show how much is left, and orders above the approval limit need approval." })
                : items.map((b) => _jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [b.name, " ", !b.active && _jsx(Pill, { children: "Off" })] }), _jsxs("div", { className: "s", children: [b.amount !== null ? `${currency(b.spent, b.currency)} of ${currency(b.amount, b.currency)} this ${b.period} (${b.used_pct}%)` : `Per ${b.period}`, b.approval_limit !== null && ` · approval above ${currency(b.approval_limit, b.currency)}`] }), b.amount !== null && _jsx("div", { className: "meter", style: { height: 6, background: "var(--c-border-soft)", borderRadius: 3, marginTop: 4, overflow: "hidden" }, children: _jsx("div", { style: { width: `${Math.min(100, b.used_pct)}%`, height: "100%", background: b.used_pct >= 100 ? "var(--c-danger)" : b.used_pct >= b.warn_at_pct ? "var(--c-warning)" : "var(--c-primary)" } }) })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${b.name}`, onClick: () => setEdit(b), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${b.name}`, onClick: () => del.mutate(b), children: _jsx(Trash2, { size: 14 }) })] })] }, b.id)), edit && _jsx(BudgetModal, { edit: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: () => { setEdit(null); done(); } })] }));
}
function BudgetModal({ edit, onClose, onDone }) {
    const [b, setB] = useState({ name: edit?.name ?? "", period: edit?.period ?? "month", starts_on: edit?.starts_on ?? new Date().toISOString().slice(0, 8) + "01",
        amount: edit?.amount ?? "", approval_limit: edit?.approval_limit ?? "", warn_at_pct: edit?.warn_at_pct ?? 90, location_id: edit?.location_id ?? null,
        category: edit?.category ?? "", active: edit?.active ?? true });
    const [err, setErr] = useState("");
    const body = { ...b, approval_limit: b.approval_limit === "" ? null : b.approval_limit };
    const m = useMutation({ mutationFn: () => edit ? api(`/budgets/${edit.id}`, { method: "PATCH", body }) : api("/budgets", { method: "POST", body }),
        onSuccess: onDone, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: edit ? "Edit budget" : "New budget", onClose: onClose, width: 600, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !b.name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: b.name, maxLength: 200, onChange: (e) => setB({ ...b, name: e.target.value }) }) }), _jsx(Field, { label: "Period", children: (id) => _jsxs(Select, { id: id, value: b.period, onChange: (e) => setB({ ...b, period: e.target.value }), children: [_jsx("option", { value: "month", children: "Monthly" }), _jsx("option", { value: "quarter", children: "Quarterly" }), _jsx("option", { value: "year", children: "Yearly" })] }) }), _jsx(Field, { label: "Starts on", children: (id) => _jsx(Input, { id: id, type: "date", value: b.starts_on, onChange: (e) => setB({ ...b, starts_on: e.target.value }) }) }), _jsx(Field, { label: "Amount per period", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: b.amount, onChange: (e) => setB({ ...b, amount: e.target.value }) }) }), _jsx(Field, { label: "Approval needed above", hint: "Optional: single orders over this amount", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: b.approval_limit, onChange: (e) => setB({ ...b, approval_limit: e.target.value }) }) }), _jsx(Field, { label: "Warn at %", children: (id) => _jsx(Input, { id: id, inputMode: "numeric", value: String(b.warn_at_pct), onChange: (e) => setB({ ...b, warn_at_pct: Number(e.target.value) || 0 }) }) }), _jsx(Field, { label: "Site", children: (id) => _jsx(LocationPicker, { id: id, value: b.location_id, onChange: (v) => setB({ ...b, location_id: v }), placeholder: "All sites" }) }), _jsx(Field, { label: "Category", children: (id) => _jsx(Input, { id: id, value: b.category, maxLength: 80, onChange: (e) => setB({ ...b, category: e.target.value }) }) })] }), _jsx(Checkbox, { checked: b.active, onChange: (v) => setB({ ...b, active: v }), label: "Active" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
// ---------------------------------------------------------------- custom fields (r249, r264)
const TYPES = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
    ["date", "Date"], ["checkbox", "Checkbox"], ["link", "Link"], ["currency", "Currency"]];
function EntityFields({ entity, title, ro }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const key = ["custom-fields", entity];
    const list = useQuery({ queryKey: key, queryFn: () => api(`/custom-fields?entity=${entity}`) });
    const [edit, setEdit] = useState(null);
    const del = useMutation({ mutationFn: (f) => api(`/custom-fields/${f.id}?entity=${entity}`, { method: "DELETE" }),
        onSuccess: () => qc.invalidateQueries({ queryKey: key }), onError: (e) => toast(e.message, { kind: "error" }) });
    const items = list.data?.items ?? [];
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: title }), !ro && _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 14 }), "Add field"] })] }), items.length === 0 ? _jsx("div", { className: "card-body small faint", children: entity === "vendor" ? "Track more about vendors, like a certification or a rating." : "Add fields like a cost center or a project code to every purchase order." })
                : items.map((f) => _jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [f.name, " ", f.required && _jsx(Pill, { tone: "warning", children: "Required" })] }), _jsx("div", { className: "s", children: TYPES.find(([k]) => k === f.type)?.[1] ?? f.type })] }), !ro && _jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${f.name}`, onClick: () => setEdit(f), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${f.name}`, onClick: () => del.mutate(f), children: _jsx(Trash2, { size: 14 }) })] })] }, f.id)), edit && _jsx(FieldModal, { entity: entity, field: edit === "new" ? undefined : edit, onClose: () => setEdit(null), onDone: () => { setEdit(null); qc.invalidateQueries({ queryKey: key }); } })] }));
}
function FieldModal({ entity, field, onClose, onDone }) {
    const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false });
    const [err, setErr] = useState("");
    const body = () => ({ ...f, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean), entity_type: entity });
    const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
        onSuccess: onDone, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: field ? "Edit field" : "New field", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: f.name, maxLength: 120, onChange: (e) => setF({ ...f, name: e.target.value }) }) }), _jsx(Field, { label: "Type", children: (id) => _jsx(Select, { id: id, value: f.type, disabled: !!field, onChange: (e) => setF({ ...f, type: e.target.value }), children: TYPES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), f.type === "select" && _jsx(Field, { label: "Options (one per line)", children: (id) => _jsx("textarea", { id: id, className: "textarea", value: f.options, onChange: (e) => setF({ ...f, options: e.target.value }) }) }), _jsx(Checkbox, { checked: f.required, onChange: (x) => setF({ ...f, required: x }), label: "Required" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
