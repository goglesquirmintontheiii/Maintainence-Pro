import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// 0.5.0 Settings › Supplier connections (MP-084/086/088): supplier APIs, PunchOut catalogs and your own supplier sites.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Pencil, Plug, Plus, Trash2, XCircle } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import "./suppliers.css";
export function SupplierSettingsPage() {
    const { can } = useSession();
    if (!can("suppliers.connections"))
        return _jsx(EmptyState, { title: "Supplier connections", children: "Only administrators can set up supplier connections." });
    return _jsxs("div", { className: "stack", style: { gap: 20 }, children: [_jsx(Connections, {}), _jsx(Sites, {})] });
}
function Connections() {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["supplier-connections"], queryFn: () => api("/supplier-connections") });
    const [editing, setEditing] = useState(null);
    const done = () => qc.invalidateQueries({ queryKey: ["supplier-connections"] });
    const test = useMutation({
        mutationFn: (id) => api(`/supplier-connections/${id}/test`, { method: "POST" }),
        onSuccess: (r) => { done(); toast(r.message || "Connected"); },
        onError: (e) => { done(); toast(e.message, { kind: "error" }); },
    });
    const del = useMutation({ mutationFn: (id) => api(`/supplier-connections/${id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Connection removed"); } });
    const specs = q.data?.connectors ?? [];
    const items = q.data?.items ?? [];
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsxs("div", { children: [_jsx("h2", { style: { margin: 0 }, children: "Supplier connections" }), _jsx("p", { className: "small muted", style: { margin: "4px 0 0" }, children: "Without a connection, MPro reads the public product page. A connection gives more reliable prices and stock, and PunchOut lets you shop a supplier's catalog and bring the cart back as a purchase order." })] }) }), q.isLoading ? _jsx(ListSkeleton, { rows: 3 }) : _jsxs(_Fragment, { children: [items.map((c) => {
                        const spec = specs.find((s) => s.key === c.connector);
                        return _jsxs("div", { className: "sup-conn", children: [_jsx(Plug, { size: 18, className: "muted", style: { marginTop: 2 } }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row", style: { flexWrap: "wrap" }, children: [_jsx("strong", { children: c.name }), _jsx("span", { className: "small faint", children: c.connector_name }), !c.enabled && _jsx(Pill, { children: "Off" })] }), _jsx("div", { className: "small", style: { marginTop: 4 }, children: c.last_error ? _jsxs("span", { style: { color: "var(--c-danger)" }, children: [_jsx(XCircle, { size: 13, style: { verticalAlign: -2 } }), " ", c.last_error, " (", timeAgo(c.last_error_at), ")"] })
                                                : c.last_success_at ? _jsxs("span", { style: { color: "var(--c-success)" }, children: [_jsx(CheckCircle2, { size: 13, style: { verticalAlign: -2 } }), " Worked ", timeAgo(c.last_success_at)] })
                                                    : _jsx("span", { className: "faint", children: "Not tried yet" }) })] }), _jsx(Button, { size: "sm", disabled: test.isPending, onClick: () => test.mutate(c.id), children: "Test connection" }), spec && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Edit", onClick: () => setEditing({ spec, conn: c }), children: _jsx(Pencil, { size: 15 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove", onClick: () => del.mutate(c.id), children: _jsx(Trash2, { size: 15 }) })] }, c.id);
                    }), _jsxs("div", { className: "card-body stack", style: { borderTop: items.length ? "1px solid var(--c-border-soft)" : undefined }, children: [_jsx("div", { className: "small muted", children: "Add a connection" }), specs.map((s) => _jsxs("div", { className: "row", style: { alignItems: "flex-start" }, children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row", children: [_jsx("strong", { children: s.name }), s.needs_account && _jsx(Pill, { tone: "warning", children: "Needs your account to try" })] }), _jsx("div", { className: "small faint", children: s.docs })] }), _jsxs(Button, { size: "sm", onClick: () => setEditing({ spec: s }), children: [_jsx(Plus, { size: 14 }), "Connect"] })] }, s.key)), _jsx("div", { className: "small faint", children: "These connections follow the suppliers' published documentation but haven't been tried against a live account yet. Use \"Test connection\" after you add yours." })] })] }), editing && _jsx(ConnectionDialog, { spec: editing.spec, conn: editing.conn, onClose: () => setEditing(null), onSaved: () => { setEditing(null); done(); } })] }));
}
function ConnectionDialog({ spec, conn, onClose, onSaved }) {
    const [name, setName] = useState(conn?.name ?? spec.name);
    const [supplier, setSupplier] = useState(conn?.supplier_key ?? spec.supplier_key);
    const [enabled, setEnabled] = useState(conn?.enabled ?? true);
    const [settings, setSettings] = useState({ ...(conn?.settings ?? {}) });
    const [secrets, setSecrets] = useState({});
    const [error, setError] = useState("");
    const sites = useQuery({ queryKey: ["supplier-sites"], queryFn: () => api("/supplier-sites"), enabled: spec.kind === "punchout" });
    const save = useMutation({
        mutationFn: () => {
            const body = { connector: spec.key, name, supplier_key: supplier, enabled, settings, secrets };
            return conn ? api(`/supplier-connections/${conn.id}`, { method: "PATCH", body }) : api("/supplier-connections", { method: "POST", body });
        },
        onSuccess: onSaved,
        onError: (e) => setError(e.message),
    });
    const readFile = (field, f) => {
        if (!f)
            return;
        const r = new FileReader();
        r.onload = () => { const s = String(r.result); setSecrets((x) => ({ ...x, [field]: s.slice(s.indexOf(",") + 1) })); };
        r.readAsDataURL(f);
    };
    return (_jsx(Modal, { title: conn ? `Edit ${spec.name}` : `Connect ${spec.name}`, onClose: onClose, width: 540, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: _jsxs("div", { className: "stack", children: [_jsx("div", { className: "small muted", children: spec.docs }), error && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: error }), _jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: name, onChange: (e) => setName(e.target.value) }) }), spec.kind === "punchout" && _jsx(Field, { label: "Supplier", children: (id) => _jsxs(Select, { id: id, value: supplier, onChange: (e) => setSupplier(e.target.value), children: [_jsx("option", { value: "", children: "Choose\u2026" }), [...(sites.data?.items ?? []), ...(sites.data?.builtin ?? [])].map((s) => _jsx("option", { value: s.key, children: s.name }, s.key))] }) }), spec.fields.map((f) => f.secret
                    ? _jsx(Field, { label: f.label, hint: conn?.secrets_set[f.name] ? `Saved${conn.secrets_masked[f.name] ? ` (${conn.secrets_masked[f.name]})` : ""}. Leave empty to keep it.` : undefined, children: (id) => f.type === "file" ? _jsx(Input, { id: id, type: "file", accept: ".pfx,.p12", onChange: (e) => readFile(f.name, e.target.files?.[0]) })
                            : _jsx(Input, { id: id, type: "password", autoComplete: "new-password", value: secrets[f.name] ?? "", onChange: (e) => setSecrets({ ...secrets, [f.name]: e.target.value }) }) }, f.name)
                    : _jsx(Field, { label: f.label, children: (id) => f.type === "select"
                            ? _jsxs(Select, { id: id, value: settings[f.name] ?? "", onChange: (e) => setSettings({ ...settings, [f.name]: e.target.value }), children: [_jsx("option", { value: "", children: "Choose\u2026" }), (f.options ?? []).map(([v, l]) => _jsx("option", { value: v, children: l }, v))] })
                            : _jsx(Input, { id: id, placeholder: f.placeholder, value: settings[f.name] ?? "", onChange: (e) => setSettings({ ...settings, [f.name]: e.target.value }) }) }, f.name)), _jsx(Toggle, { label: "Use this connection", checked: enabled, onChange: setEnabled }), _jsx("div", { className: "small faint", children: "Passwords, secrets and certificates are stored encrypted and are never shown again." })] }) }));
}
function Sites() {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["supplier-sites"], queryFn: () => api("/supplier-sites") });
    const [editing, setEditing] = useState(null);
    const del = useMutation({ mutationFn: (id) => api(`/supplier-sites/${id}`, { method: "DELETE" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["supplier-sites"] }); toast("Removed"); } });
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0 }, children: "Supplier sites" }), _jsxs("p", { className: "small muted", style: { margin: "4px 0 0" }, children: ["MPro recognizes links from ", q.data?.builtin.length ?? "many", " suppliers. Add your local suppliers so their links show the supplier name and item number."] })] }), _jsxs(Button, { size: "sm", onClick: () => setEditing("new"), children: [_jsx(Plus, { size: 14 }), "Add supplier"] })] }), (q.data?.items ?? []).map((s) => _jsxs("div", { className: "sup-conn", children: [_jsxs("div", { className: "grow", children: [_jsx("strong", { children: s.name }), " ", _jsx("span", { className: "small faint", children: s.domains.join(", ") }), s.id_patterns.length > 0 && _jsx("div", { className: "small muted mono", children: s.id_patterns.join("  ") })] }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Edit", onClick: () => setEditing(s), children: _jsx(Pencil, { size: 15 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove", onClick: () => del.mutate(s.id), children: _jsx(Trash2, { size: 15 }) })] }, s.id)), _jsxs("details", { className: "card-body small", children: [_jsx("summary", { className: "muted", children: "Suppliers MPro already knows" }), _jsx("p", { className: "faint", children: (q.data?.builtin ?? []).map((s) => s.name).join(", ") })] }), editing && _jsx(SiteDialog, { site: editing === "new" ? undefined : editing, onClose: () => setEditing(null), onSaved: () => { setEditing(null); qc.invalidateQueries({ queryKey: ["supplier-sites"] }); } })] }));
}
function SiteDialog({ site, onClose, onSaved }) {
    const [f, setF] = useState({ name: site?.name ?? "", domains: (site?.domains ?? []).join(", "), id_patterns: (site?.id_patterns ?? []).join("\n"),
        id_label: site?.id_label ?? "", product_url: site?.product_url ?? "" });
    const [error, setError] = useState("");
    const save = useMutation({
        mutationFn: () => {
            const body = { name: f.name, domains: f.domains.split(/[\s,]+/).filter(Boolean), id_patterns: f.id_patterns.split("\n").map((x) => x.trim()).filter(Boolean),
                id_label: f.id_label, product_url: f.product_url };
            return site ? api(`/supplier-sites/${site.id}`, { method: "PATCH", body }) : api("/supplier-sites", { method: "POST", body });
        },
        onSuccess: onSaved,
        onError: (e) => setError(e.message),
    });
    return (_jsx(Modal, { title: site ? "Edit supplier" : "Add a supplier", onClose: onClose, width: 540, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: _jsxs("div", { className: "stack", children: [error && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: error }), _jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, onChange: (e) => setF({ ...f, name: e.target.value }) }) }), _jsx(Field, { label: "Web addresses", hint: "For example acmesupply.com. Subdomains are included.", children: (id) => _jsx(Input, { id: id, value: f.domains, onChange: (e) => setF({ ...f, domains: e.target.value }) }) }), _jsx(Field, { label: "Item number patterns (optional)", hint: "One per line. A regular expression with a group named id, for example /item/(?P<id>[0-9]+)", children: (id) => _jsx("textarea", { id: id, className: "input mono", rows: 3, value: f.id_patterns, onChange: (e) => setF({ ...f, id_patterns: e.target.value }) }) }), _jsxs("div", { className: "pl-grid2", children: [_jsx(Field, { label: "Item number label", children: (id) => _jsx(Input, { id: id, placeholder: "Item #", value: f.id_label, onChange: (e) => setF({ ...f, id_label: e.target.value }) }) }), _jsx(Field, { label: "Product page (optional)", hint: "Use {id} for the item number.", children: (id) => _jsx(Input, { id: id, placeholder: "https://acmesupply.com/item/{id}", value: f.product_url, onChange: (e) => setF({ ...f, product_url: e.target.value }) }) })] })] }) }));
}
