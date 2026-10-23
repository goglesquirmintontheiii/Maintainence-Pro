import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Vendors (0.5.0, MP-045, r262–r264): MaintainX list + detail. Vendor types, contacts (who gets purchase orders,
// who is CC'd), linked assets and locations, parts they sell, purchase orders, files and custom vendor fields.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Download, FileSpreadsheet, Globe, Mail, MoreHorizontal, Pencil, Phone, Plus, Search, ShoppingCart, Tags, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { avatarColor, currency, dateTime, show, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import { ColorPicker } from "../../components/ColorPicker";
import { FilesSection } from "../assets/shared";
import { CustomInput } from "../workorders/Form";
import { useLocationList } from "../../lib/assets";
import { PO_TONE } from "../purchasing/types";
import "../purchasing/purchasing.css";
export function useVendorFields() {
    return useQuery({ queryKey: ["custom-fields", "vendor"], queryFn: () => api("/custom-fields?entity=vendor"), staleTime: 60_000 });
}
function useVendorTypes() {
    return useQuery({ queryKey: ["vendor-types"], queryFn: () => api("/vendor-types"), staleTime: 30_000 });
}
export function OrgAvatar({ name, color, src, lg }) {
    if (src)
        return _jsx("img", { className: "vd-avatar" + (lg ? " lg" : ""), src: src, alt: "" });
    return _jsx("span", { className: "vd-avatar" + (lg ? " lg" : ""), style: { background: color && color !== "#5d6880" ? color : avatarColor(name) }, "aria-hidden": "true", children: name.slice(0, 1).toUpperCase() });
}
export function addressText(a) {
    if (!a)
        return "";
    return [a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n");
}
export function VendorsPage() {
    const { id } = useParams();
    const nav = useNavigate();
    const { can } = useSession();
    const { toast } = useToast();
    const [search, setSearch] = useState("");
    const [typeId, setTypeId] = useState("");
    const [creating, setCreating] = useState(false);
    const [typesOpen, setTypesOpen] = useState(false);
    const types = useVendorTypes();
    const exportCsv = useMutation({
        mutationFn: () => api("/vendors/export", { method: "POST", body: {} }),
        onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Vendors" }), _jsxs("div", { className: "row", children: [_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 240, children: (close) => _jsxs(_Fragment, { children: [can("vendors.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setTypesOpen(true); }, children: [_jsx(Tags, { size: 15 }), "Vendor types"] }), can("exports.use") && _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); exportCsv.mutate(); }, children: [_jsx(Download, { size: 15 }), "Export to CSV"] }), _jsxs(Link, { className: "menu-item", to: "/downloads", onClick: close, children: [_jsx(FileSpreadsheet, { size: 15 }), "Download Center"] })] })] }) }), can("vendors.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New Vendor", children: [_jsx(Plus, { size: 16 }), "New"] })] })] }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs("div", { className: "search-in grow", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search name, email, contact or account #", value: search, onChange: (e) => setSearch(e.target.value), "aria-label": "Search vendors" })] }), (types.data?.items ?? []).length > 0 && _jsxs(Select, { "aria-label": "Vendor type", value: typeId, onChange: (e) => setTypeId(e.target.value), style: { maxWidth: 150 }, children: [_jsx("option", { value: "", children: "All types" }), (types.data?.items ?? []).map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] })] })] }), _jsx("div", { className: "list", "aria-label": "Vendors", children: _jsx(VendorList, { q: search, typeId: typeId, activeId: id }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(VendorDetailView, { id: id }, id)
                            : _jsx(EmptyState, { icon: _jsx(Building2, { size: 28 }), title: "Select a vendor", children: "Pick one from the list to see contacts, parts they sell and purchase orders." }) })] }), creating && _jsx(VendorForm, { onClose: () => setCreating(false), onSaved: (v) => { setCreating(false); nav(`/vendors/${v.id}`); } }), typesOpen && _jsx(TypesDialog, { onClose: () => setTypesOpen(false) })] }));
}
function VendorList({ q, typeId, activeId }) {
    const { can } = useSession();
    const qs = new URLSearchParams(Object.entries({ q, type_id: typeId, per_page: "200" }).filter(([, v]) => v)).toString();
    const list = useQuery({ queryKey: ["vendors", "list", qs], queryFn: () => api(`/vendors?${qs}`), placeholderData: (p) => p });
    if (list.isLoading)
        return _jsx(ListSkeleton, {});
    const items = list.data?.items ?? [];
    if (!items.length)
        return q || typeId ? _jsx(EmptyState, { title: "No vendors match", children: "Try another search." })
            : _jsx(EmptyState, { icon: _jsx(Building2, { size: 26 }), title: "No vendors yet", children: can("vendors.manage") ? "Add the companies you buy parts and services from." : "Vendors your team adds show here." });
    return _jsxs(_Fragment, { children: [_jsxs("div", { className: "small muted", style: { padding: "6px 16px" }, children: [list.data?.total, " vendor", list.data?.total === 1 ? "" : "s"] }), items.map((v) => _jsxs(Link, { to: `/vendors/${v.id}`, className: "list-row" + (v.id === activeId ? " active" : ""), children: [_jsx(OrgAvatar, { name: v.name, color: v.color, src: v.picture_url }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("span", { className: "t", style: { display: "block" }, children: v.name }), _jsx("span", { className: "s", style: { display: "block" }, children: [v.types.map((t) => t.name).join(", "), v.contacts[0]?.name, v.open_purchase_orders ? `${v.open_purchase_orders} open PO${v.open_purchase_orders === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || v.email || " " })] })] }, v.id))] });
}
function VendorDetailView({ id }) {
    const v = useQuery({ queryKey: ["vendor", id], queryFn: () => api(`/vendors/${id}`) });
    const qc = useQueryClient();
    const nav = useNavigate();
    const { session, can } = useSession();
    const { toast } = useToast();
    const fields = useVendorFields();
    const [editing, setEditing] = useState(false);
    const [contact, setContact] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const refresh = () => { qc.invalidateQueries({ queryKey: ["vendor", id] }); qc.invalidateQueries({ queryKey: ["vendors"] }); };
    const del = useMutation({ mutationFn: () => api(`/vendors/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); toast("Vendor deleted"); nav("/vendors"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    if (v.isError)
        return _jsx(EmptyState, { icon: _jsx(Building2, { size: 28 }), title: "Vendor not found", children: "It may have been deleted, or you don't have access." });
    const d = v.data;
    if (!d)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 5 }) });
    const cur = d.currency || session.org?.currency;
    const cf = (fields.data?.items ?? []).filter((f) => d.custom[f.id] !== undefined && d.custom[f.id] !== "");
    return (_jsxs("div", { className: "detail", children: [_jsxs(Link, { to: "/vendors", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All vendors"] }), _jsxs("div", { className: "wo-head", children: [_jsx(OrgAvatar, { name: d.name, color: d.color, src: d.picture_url, lg: true }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "small muted", children: _jsx(Link, { to: "/vendors", children: "Vendors" }) }), _jsx("h1", { className: "wo-title", children: d.name }), _jsx("div", { className: "vd-chips", style: { marginTop: 6 }, children: d.types.map((t) => _jsxs("span", { className: "chip", children: [_jsx("span", { className: "sw lg", style: { background: t.color } }), t.name] }, t.id)) })] }), _jsxs("div", { className: "row", children: [can("po.request") && _jsxs(Link, { className: "btn", to: `/purchase-orders?new=1&vendor_id=${d.id}`, children: [_jsx(ShoppingCart, { size: 15 }), _jsx("span", { className: "desktop-only", children: "New PO" })] }), d.can.manage && _jsx(Button, { icon: true, "aria-label": "Edit vendor", title: "Edit", onClick: () => setEditing(true), children: _jsx(Pencil, { size: 15 }) }), d.can.delete && _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 200, children: (close) => _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirm(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] }) })] })] }), d.description && _jsx("section", { className: "card card-pad prewrap", children: d.description }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { children: [_jsx("dt", { children: "Email" }), _jsx("dd", { children: d.email ? _jsx("a", { href: `mailto:${d.email}`, children: d.email }) : "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Phone" }), _jsx("dd", { children: d.phone ? _jsx("a", { href: `tel:${d.phone}`, children: d.phone }) : "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Website" }), _jsx("dd", { children: d.website ? _jsx("a", { href: /^https?:/i.test(d.website) ? d.website : `https://${d.website}`, target: "_blank", rel: "noopener noreferrer", children: d.website }) : "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Our account #" }), _jsx("dd", { className: "mono", children: show(d.account_number) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Payment terms" }), _jsx("dd", { children: show(d.payment_terms) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Currency" }), _jsx("dd", { children: d.currency || session.org?.currency })] }), _jsxs("div", { children: [_jsx("dt", { children: "Address" }), _jsx("dd", { className: "prewrap small", children: addressText(d.address) || "—" })] }), cf.map((f) => _jsxs("div", { children: [_jsx("dt", { children: f.name }), _jsx("dd", { children: f.type === "checkbox" ? (d.custom[f.id] ? "Yes" : "No") : f.type === "currency" ? currency(d.custom[f.id], cur) : String(d.custom[f.id]) })] }, f.id)), _jsxs("div", { children: [_jsx("dt", { children: "Updated" }), _jsx("dd", { className: "small", children: dateTime(d.updated_at, session.org?.timezone) })] })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Contacts" }), d.can.manage && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setContact("new"), children: [_jsx(Plus, { size: 14 }), "Add contact"] })] }), d.contacts.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No contacts yet. Add who you order from: they get purchase orders when you send them." })
                        : _jsx("div", { className: "contact-grid", children: d.contacts.map((c) => _jsx(ContactCard, { c: c, onEdit: d.can.manage ? () => setContact(c) : undefined }, c.id)) })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Purchase orders" }), _jsx(Link, { className: "small", to: `/purchase-orders`, children: "All purchase orders" })] }), d.purchase_orders.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No purchase orders with this vendor yet." })
                        : d.purchase_orders.map((p) => _jsxs(Link, { to: `/purchase-orders/${p.id}`, className: "list-row", children: [_jsx("span", { className: "mono small faint", children: p.number }), _jsx("span", { className: "grow t", children: p.title }), p.total !== null && _jsx("span", { className: "small", children: currency(p.total, cur) }), _jsx(Pill, { tone: PO_TONE[p.status], children: p.status.replace("_", " ") }), _jsx("span", { className: "small faint desktop-only", children: timeAgo(p.created_at) })] }, p.id))] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Parts" }) }), d.parts.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No parts list this vendor yet. Add it as a vendor on a part." })
                        : d.parts.map((p) => _jsxs(Link, { to: `/parts/${p.id}`, className: "list-row", children: [_jsxs("span", { className: "grow", children: [_jsx("span", { className: "t", children: p.name }), _jsx("span", { className: "s", children: [p.vendor_part_number && `Vendor # ${p.vendor_part_number}`, p.part_number].filter(Boolean).join(" · ") || " " })] }), p.unit_cost !== null && _jsx("span", { className: "small", children: currency(p.unit_cost, cur) }), p.preferred && _jsx(Pill, { tone: "info", children: "Preferred" })] }, p.id))] }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Assets" }), _jsx("dd", { children: d.assets.length ? _jsx("span", { className: "vd-chips", children: d.assets.map((a) => _jsx(Link, { className: "chip", to: `/assets/${a.id}`, children: a.name }, a.id)) }) : _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Locations" }), _jsx("dd", { children: d.locations.length ? _jsx("span", { className: "vd-chips", children: d.locations.map((l) => _jsx(Link, { className: "chip", to: `/locations/${l.id}`, children: l.name }, l.id)) }) : _jsx("span", { className: "faint", children: "None" }) })] })] }), _jsx(FilesSection, { files: d.files, entityType: "vendor", entityId: d.id, editable: d.can.manage, queryKey: ["vendor", d.id], role: "file" }), editing && _jsx(VendorForm, { edit: d, onClose: () => setEditing(false), onSaved: () => { setEditing(false); refresh(); } }), contact && _jsx(ContactDialog, { kind: "vendor", parentId: d.id, edit: contact === "new" ? undefined : contact, onClose: () => setContact(null), onDone: () => { setContact(null); refresh(); } }), confirm && _jsx(Modal, { title: "Delete vendor?", onClose: () => setConfirm(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirm(false), children: "Cancel" }), _jsx(Button, { variant: "danger", disabled: del.isPending, onClick: () => del.mutate(), children: "Delete" })] }), children: _jsxs("p", { children: [d.name, " will be removed from lists. Purchase orders keep the vendor's name."] }) })] }));
}
export function ContactCard({ c, onEdit }) {
    return (_jsxs("div", { className: "contact-card", children: [_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx("b", { className: "grow", children: c.name }), onEdit && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${c.name}`, onClick: onEdit, children: _jsx(Pencil, { size: 13 }) })] }), c.role && _jsx("span", { className: "small muted", children: c.role }), c.email && _jsxs("a", { className: "small row", style: { gap: 4 }, href: `mailto:${c.email}`, children: [_jsx(Mail, { size: 12 }), c.email] }), c.phone && _jsxs("a", { className: "small row", style: { gap: 4 }, href: `tel:${c.phone}`, children: [_jsx(Phone, { size: 12 }), c.phone, c.extension ? ` ext. ${c.extension}` : ""] }), _jsxs("div", { className: "vd-chips", children: [c.is_po_contact && _jsx(Pill, { tone: "info", children: "Gets POs" }), c.cc_on_po && _jsx(Pill, { children: "CC on POs" }), c.is_billing && _jsx(Pill, { tone: "info", children: "Billing" })] })] }));
}
export function ContactDialog({ kind, parentId, edit, onClose, onDone }) {
    const [c, setC] = useState(edit ?? { id: "", name: "", role: "", email: "", phone: "", extension: "", is_po_contact: false, cc_on_po: false, is_billing: false });
    const [err, setErr] = useState("");
    const base = kind === "vendor" ? "vendor-contacts" : "customer-contacts";
    const body = kind === "vendor" ? { name: c.name, role: c.role, email: c.email, phone: c.phone, extension: c.extension, is_po_contact: c.is_po_contact, cc_on_po: c.cc_on_po }
        : { name: c.name, role: c.role, email: c.email, phone: c.phone, is_billing: c.is_billing };
    const save = useMutation({ mutationFn: () => edit ? api(`/${base}/${edit.id}`, { method: "PATCH", body }) : api(`/${kind}s/${parentId}/contacts`, { method: "POST", body }),
        onSuccess: onDone, onError: (e) => setErr(e.message) });
    const del = useMutation({ mutationFn: () => api(`/${base}/${edit?.id}`, { method: "DELETE" }), onSuccess: onDone, onError: (e) => setErr(e.message) });
    return (_jsxs(Modal, { title: edit ? "Edit contact" : "Add contact", onClose: onClose, footer: _jsxs(_Fragment, { children: [edit && _jsxs(Button, { variant: "ghost", style: { marginRight: "auto", color: "var(--c-danger)" }, onClick: () => del.mutate(), children: [_jsx(Trash2, { size: 14 }), "Remove"] }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !c.name.trim() || save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: c.name, maxLength: 200, onChange: (e) => setC({ ...c, name: e.target.value }) }) }), _jsx(Field, { label: "Role", children: (id) => _jsx(Input, { id: id, value: c.role, maxLength: 120, placeholder: "e.g. Account manager", onChange: (e) => setC({ ...c, role: e.target.value }) }) }), _jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", value: c.email, maxLength: 255, onChange: (e) => setC({ ...c, email: e.target.value }) }) }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Phone", children: (id) => _jsx(Input, { id: id, type: "tel", value: c.phone, maxLength: 60, onChange: (e) => setC({ ...c, phone: e.target.value }) }) }), kind === "vendor" && _jsx(Field, { label: "Extension", children: (id) => _jsx(Input, { id: id, value: c.extension ?? "", maxLength: 20, onChange: (e) => setC({ ...c, extension: e.target.value }) }) })] }), kind === "vendor" ? _jsxs(_Fragment, { children: [_jsx(Checkbox, { checked: !!c.is_po_contact, onChange: (v) => setC({ ...c, is_po_contact: v }), label: "Send purchase orders to this contact" }), _jsx(Checkbox, { checked: !!c.cc_on_po, onChange: (v) => setC({ ...c, cc_on_po: v }), label: "CC this contact on purchase orders" })] }) : _jsx(Checkbox, { checked: !!c.is_billing, onChange: (v) => setC({ ...c, is_billing: v }), label: "Billing contact" }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
export function AddressFields({ value, onChange }) {
    const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
    return (_jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Street", children: (id) => _jsx(Input, { id: id, value: value.line1 ?? "", maxLength: 200, onChange: set("line1") }) }), _jsx(Field, { label: "Line 2", children: (id) => _jsx(Input, { id: id, value: value.line2 ?? "", maxLength: 200, onChange: set("line2") }) }), _jsx(Field, { label: "City", children: (id) => _jsx(Input, { id: id, value: value.city ?? "", maxLength: 120, onChange: set("city") }) }), _jsx(Field, { label: "State / region", children: (id) => _jsx(Input, { id: id, value: value.region ?? "", maxLength: 120, onChange: set("region") }) }), _jsx(Field, { label: "Postal code", children: (id) => _jsx(Input, { id: id, value: value.postal_code ?? "", maxLength: 20, onChange: set("postal_code") }) }), _jsx(Field, { label: "Country", children: (id) => _jsx(Input, { id: id, value: value.country ?? "", maxLength: 2, placeholder: "US", onChange: set("country") }) })] }));
}
function VendorForm({ edit, onClose, onSaved }) {
    const types = useVendorTypes();
    const fields = useVendorFields();
    const locs = useLocationList();
    const [f, setF] = useState(() => ({
        name: edit?.name ?? "", color: edit?.color ?? "#5d6880", description: edit?.description ?? "", email: edit?.email ?? "", phone: edit?.phone ?? "",
        website: edit?.website ?? "", account_number: edit?.account_number ?? "", payment_terms: edit?.payment_terms ?? "", currency: edit?.currency ?? "",
        address: edit?.address ?? {}, type_ids: edit?.types.map((t) => t.id) ?? [], asset_ids: edit?.assets.map((a) => a.id) ?? [],
        location_ids: edit?.locations.map((l) => l.id) ?? [], custom: { ...(edit?.custom ?? {}) },
    }));
    const [err, setErr] = useState("");
    const set = (p) => setF((x) => ({ ...x, ...p }));
    const locOpts = useMemo(() => (locs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name })), [locs.data]);
    const save = useMutation({
        mutationFn: () => edit ? api(`/vendors/${edit.id}`, { method: "PATCH", body: f }) : api("/vendors", { method: "POST", body: f }),
        onSuccess: onSaved, onError: (e) => setErr(e.message),
    });
    return (_jsx(Drawer, { title: edit ? `Edit ${edit.name}` : "New Vendor", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || save.isPending, onClick: () => save.mutate(), children: edit ? "Save" : "Create" })] }), children: _jsxs("div", { className: "stack", style: { gap: 12 }, children: [_jsxs("div", { className: "row", style: { gap: 10, alignItems: "flex-end" }, children: [_jsx(Field, { label: "Name", className: "grow", children: (id) => _jsx(Input, { id: id, autoFocus: true, value: f.name, maxLength: 255, onChange: (e) => set({ name: e.target.value }) }) }), _jsx(ColorPicker, { value: f.color, onChange: (c) => set({ color: c }) })] }), _jsx(Field, { label: "Vendor types", children: (id) => _jsx(MultiPicker, { id: id, label: "Vendor types", placeholder: "Add types", value: f.type_ids, onChange: (v) => set({ type_ids: v }), options: (types.data?.items ?? []).map((t) => ({ key: t.id, label: t.name, icon: _jsx("span", { className: "sw lg", style: { background: t.color } }) })) }) }), _jsx(Field, { label: "Description", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 2, value: f.description, onChange: (e) => set({ description: e.target.value }) }) }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", value: f.email, onChange: (e) => set({ email: e.target.value }) }) }), _jsx(Field, { label: "Phone", children: (id) => _jsx(Input, { id: id, type: "tel", value: f.phone, onChange: (e) => set({ phone: e.target.value }) }) }), _jsx(Field, { label: "Website", children: (id) => _jsxs("div", { className: "search-in", children: [_jsx(Globe, { size: 14, className: "faint" }), _jsx(Input, { id: id, value: f.website, onChange: (e) => set({ website: e.target.value }) })] }) }), _jsx(Field, { label: "Our account #", hint: "Your customer number with them", children: (id) => _jsx(Input, { id: id, value: f.account_number, onChange: (e) => set({ account_number: e.target.value }) }) }), _jsx(Field, { label: "Payment terms", children: (id) => _jsx(Input, { id: id, value: f.payment_terms, placeholder: "Net 30", onChange: (e) => set({ payment_terms: e.target.value }) }) }), _jsx(Field, { label: "Currency", hint: "Empty: your organization's", children: (id) => _jsx(Input, { id: id, value: f.currency, maxLength: 3, placeholder: "USD", onChange: (e) => set({ currency: e.target.value.toUpperCase() }) }) })] }), _jsx("h3", { className: "sec-h", children: "Address" }), _jsx(AddressFields, { value: f.address, onChange: (a) => set({ address: a }) }), _jsx(Field, { label: "Assets they service or supply", children: (id) => _jsx(AssetPicker, { id: id, multi: true, value: f.asset_ids, onChange: (v) => set({ asset_ids: v }), placeholder: "Add assets" }) }), _jsx(Field, { label: "Locations", children: (id) => _jsx(MultiPicker, { id: id, label: "Locations", placeholder: "Add locations", value: f.location_ids, onChange: (v) => set({ location_ids: v }), options: locOpts }) }), (fields.data?.items ?? []).map((d) => _jsx(Field, { label: d.name + (d.required ? " *" : ""), children: () => _jsx(CustomInput, { def: d, value: f.custom[d.id], onChange: (v) => set({ custom: { ...f.custom, [d.id]: v } }) }) }, d.id)), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }) }));
}
function TypesDialog({ onClose }) {
    const qc = useQueryClient();
    const types = useVendorTypes();
    const { toast } = useToast();
    const [name, setName] = useState("");
    const [color, setColor] = useState("#3b82f6");
    const done = () => { qc.invalidateQueries({ queryKey: ["vendor-types"] }); qc.invalidateQueries({ queryKey: ["vendors"] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const add = useMutation({ mutationFn: () => api("/vendor-types", { method: "POST", body: { name, color } }), onSuccess: () => { setName(""); done(); }, onError: err });
    const patch = useMutation({ mutationFn: (t) => api(`/vendor-types/${t.id}`, { method: "PATCH", body: { name: t.name, color: t.color } }), onSuccess: done, onError: err });
    const del = useMutation({ mutationFn: (t) => api(`/vendor-types/${t.id}`, { method: "DELETE" }), onSuccess: done, onError: err });
    return (_jsxs(Modal, { title: "Vendor types", onClose: onClose, footer: _jsx(Button, { onClick: onClose, children: "Done" }), children: [_jsx("p", { className: "small muted", children: "Group vendors (parts supplier, contractor, service provider\u2026) to filter the list." }), (types.data?.items ?? []).map((t) => _jsxs("div", { className: "row", style: { gap: 8, marginBottom: 6 }, children: [_jsx(ColorPicker, { value: t.color, onChange: (c) => patch.mutate({ ...t, color: c }), size: "sm" }), _jsx(Input, { "aria-label": "Type name", defaultValue: t.name, className: "grow", onBlur: (e) => { if (e.target.value.trim() && e.target.value !== t.name)
                            patch.mutate({ ...t, name: e.target.value }); } }), _jsx("span", { className: "small faint", children: t.vendors ?? 0 }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${t.name}`, onClick: () => del.mutate(t), children: _jsx(Trash2, { size: 14 }) })] }, t.id)), _jsxs("div", { className: "row", style: { gap: 8, marginTop: 10 }, children: [_jsx(ColorPicker, { value: color, onChange: setColor, size: "sm" }), _jsx(Input, { "aria-label": "New type", placeholder: "New type", value: name, maxLength: 80, className: "grow", onChange: (e) => setName(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && name.trim())
                            add.mutate(); } }), _jsxs(Button, { size: "sm", disabled: !name.trim() || add.isPending, onClick: () => add.mutate(), children: [_jsx(Plus, { size: 14 }), "Add"] })] })] }));
}
