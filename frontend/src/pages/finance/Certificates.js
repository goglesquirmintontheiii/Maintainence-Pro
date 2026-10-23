import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Tax exemption certificates (MP-090): scans stored encrypted, reminders 60/30/7 days before expiry, a vendor
// registry with "Send certificate to vendor" (scan attached; re-sent automatically on renewal), an access log, the
// exempt-purchases report, and the mobile exemption card — shown to the people named on it, watermarked
// "For <org> employees only", and kept on the phone so it works offline.
import { useEffect, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BadgeCheck, CreditCard, FileUp, Plus, RefreshCw, Send, ShieldCheck, Trash2, WifiOff } from "lucide-react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { useVendors } from "./VendorInvoices";
import { CERT_TYPES, day, postForm } from "./types";
const useMembers = () => useQuery({ queryKey: ["users", "lite"], staleTime: 60_000, queryFn: () => api("/users?per_page=500") });
const REG = {
    not_sent: ["Not sent", "neutral"], sent: ["Sent", "info"], on_file: ["On file", "success"], rejected: ["Rejected", "danger"],
};
export function CertificatesTab({ me, id }) {
    const manage = me.can["finance.tax_certificates"];
    const [status, setStatus] = useState("active");
    const [adding, setAdding] = useState(false);
    const nav = useNavigate();
    const [sp] = useSearchParams();
    const list = useQuery({ queryKey: ["finance", "certificates", status], queryFn: () => api(`/finance/tax-certificates?status=${status}&per_page=200`) });
    if (!manage) {
        // people named on a card: just their cards, phone-first
        return _jsx("div", { className: "fin-cards-only", children: id ? _jsx(ExemptionCardView, { id: id, onBack: () => nav("/finance/certificates") })
                : _jsxs("div", { className: "stack", style: { padding: "var(--s-4)" }, children: [_jsx("h1", { children: "Exemption cards" }), list.isLoading ? _jsx(ListSkeleton, { rows: 2 }) : !list.data?.items.length ? _jsx(EmptyState, { title: "No cards", children: "Nobody has shared an exemption card with you." })
                            : list.data.items.map((c) => _jsxs(Link, { className: "card card-pad row", to: `/finance/certificates/${c.id}`, children: [_jsx(CreditCard, { size: 20 }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [c.type_name, " \u00B7 ", c.jurisdiction] }), _jsxs("div", { className: "faint fin-small", children: ["Expires ", day(c.expires_on)] })] })] }, c.id))] }) });
    }
    return (_jsxs("div", { className: "split fin-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Tax certificates" }), _jsxs(Button, { variant: "primary", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 16 }), "New"] })] }), _jsx("div", { className: "seg fin-seg", role: "tablist", "aria-label": "Status", children: [["active", "Active"], ["retired", "Retired"], ["", "All"]].map(([k, l]) => _jsx("button", { type: "button", role: "tab", "aria-selected": status === k, className: "seg-btn" + (status === k ? " on" : ""), onClick: () => setStatus(k), children: l }, k)) })] }), _jsx("div", { className: "list", "aria-label": "Certificates", children: list.isLoading ? _jsx(ListSkeleton, {}) : !list.data?.items.length ? _jsx(EmptyState, { icon: _jsx(ShieldCheck, { size: 28 }), title: "No certificates", children: "Add your resale or exemption certificates; vendors get them by email, and purchase orders are marked tax-exempt." })
                            : list.data.items.map((c) => (_jsxs(Link, { to: `/finance/certificates/${c.id}`, className: "list-row" + (c.id === id ? " active" : ""), children: [_jsx(ShieldCheck, { size: 18, className: c.valid ? "fin-ok" : "faint" }), _jsxs("div", { className: "grow", children: [_jsxs("div", { className: "t", children: [c.type_name, " \u00B7 ", c.jurisdiction] }), _jsxs("div", { className: "s", children: [c.number || "No number", c.customer_id ? " · customer's certificate" : ""] }), _jsx("div", { className: "row wrap fin-pills", children: _jsx(ExpiryPill, { c: c }) })] })] }, c.id))) })] }), _jsx("div", { className: "split-detail", children: !id ? _jsx(EmptyState, { title: "Pick a certificate" })
                    : sp.get("card") === "1" ? _jsx(ExemptionCardView, { id: id, onBack: () => nav(`/finance/certificates/${id}`) })
                        : _jsx(CertificateDetail, { id: id, onBack: () => nav("/finance/certificates") }) }), adding && _jsx(CertForm, { onClose: () => setAdding(false), onSaved: (c) => { setAdding(false); nav(`/finance/certificates/${c.id}`); } })] }));
}
function ExpiryPill({ c }) {
    if (c.status === "retired")
        return _jsx(Pill, { children: "Retired" });
    if (c.days_left === null)
        return _jsx(Pill, { tone: "success", children: "No expiry" });
    if (c.days_left < 0)
        return _jsx(Pill, { tone: "danger", children: "Expired" });
    if (c.days_left <= 60)
        return _jsxs(Pill, { tone: "warning", children: ["Expires in ", c.days_left, " day", c.days_left === 1 ? "" : "s"] });
    return _jsxs(Pill, { tone: "success", children: ["Valid until ", day(c.expires_on)] });
}
function CertForm({ edit, renew, onClose, onSaved }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const members = useMembers();
    const base = edit ?? renew;
    const [f, setF] = useState({ type: base?.type ?? "resale", type_label: base?.type_label ?? "", country: base?.country ?? "US", region: base?.region ?? "",
        multistate_form: base?.multistate_form ?? "", covered_regions: (base?.covered_regions ?? []).join(", "), number: base?.number ?? "",
        legal_entity: base?.legal_entity ?? "", issued_on: renew ? "" : base?.issued_on ?? "", expires_on: renew ? "" : base?.expires_on ?? "",
        scope_notes: base?.scope_notes ?? "" });
    const [cardUsers, setCardUsers] = useState(base?.card_user_ids ?? []);
    const save = useMutation({
        mutationFn: () => {
            const body = { ...f, covered_regions: f.covered_regions.split(/[,\s]+/).filter(Boolean), card_user_ids: cardUsers };
            if (renew)
                return api(`/finance/tax-certificates/${renew.id}/renew`, { method: "POST", body });
            return edit ? api(`/finance/tax-certificates/${edit.id}`, { method: "PATCH", body }) : api("/finance/tax-certificates", { method: "POST", body });
        },
        onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["finance"] }); toast(renew ? "Renewed. Add the new scan; vendors get it automatically." : "Saved"); onSaved(c); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
    return (_jsx(Modal, { title: renew ? "Renew certificate" : edit ? "Edit certificate" : "New tax certificate", onClose: onClose, width: 640, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "fin-form-grid", children: [!renew && _jsx(Field, { label: "Type", children: (fid) => _jsx(Select, { id: fid, value: f.type, onChange: set("type"), children: CERT_TYPES.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) }) }), f.type === "custom" && !renew && _jsx(Field, { label: "Name", children: (fid) => _jsx(Input, { id: fid, value: f.type_label, onChange: set("type_label") }) }), !renew && _jsx(Field, { label: "Country", children: (fid) => _jsx(Input, { id: fid, value: f.country, onChange: set("country"), maxLength: 40 }) }), !renew && _jsx(Field, { label: "Multistate form", children: (fid) => _jsxs(Select, { id: fid, value: f.multistate_form, onChange: set("multistate_form"), children: [_jsx("option", { value: "", children: "None (one state / province)" }), _jsx("option", { value: "sst", children: "Streamlined Sales Tax (SST)" }), _jsx("option", { value: "mtc", children: "Multistate Tax Commission (MTC)" })] }) }), !renew && (f.multistate_form
                            ? _jsx(Field, { label: "States covered", hint: "e.g. IN, KY, OH", children: (fid) => _jsx(Input, { id: fid, value: f.covered_regions, onChange: set("covered_regions") }) })
                            : _jsx(Field, { label: "State / province", children: (fid) => _jsx(Input, { id: fid, value: f.region, onChange: set("region") }) })), _jsx(Field, { label: "Certificate number", children: (fid) => _jsx(Input, { id: fid, value: f.number, onChange: set("number") }) }), !renew && _jsx(Field, { label: "Legal entity", children: (fid) => _jsx(Input, { id: fid, value: f.legal_entity, onChange: set("legal_entity") }) }), _jsx(Field, { label: "Issued", children: (fid) => _jsx(Input, { id: fid, type: "date", value: f.issued_on, onChange: set("issued_on") }) }), _jsx(Field, { label: "Expires", children: (fid) => _jsx(Input, { id: fid, type: "date", value: f.expires_on, onChange: set("expires_on"), required: !!renew }) })] }), !renew && _jsx(Field, { label: "What it covers (notes)", children: (fid) => _jsx("textarea", { id: fid, className: "input", rows: 2, value: f.scope_notes, onChange: set("scope_notes") }) }), !renew && _jsxs("div", { className: "stack fin-tight", children: [_jsx("span", { className: "fin-label", children: "Who can show the exemption card on their phone" }), _jsx("div", { className: "fin-chips", children: members.data?.items.map((u) => _jsx("button", { type: "button", className: "fin-chip" + (cardUsers.includes(u.id) ? " on" : ""), onClick: () => setCardUsers((x) => x.includes(u.id) ? x.filter((y) => y !== u.id) : [...x, u.id]), children: u.name }, u.id)) })] })] }) }));
}
function CertificateDetail({ id, onBack }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const nav = useNavigate();
    const q = useQuery({ queryKey: ["finance", "certificate", id], queryFn: () => api(`/finance/tax-certificates/${id}`) });
    const vendors = useVendors();
    const [edit, setEdit] = useState(false);
    const [renew, setRenew] = useState(false);
    const [addVendor, setAddVendor] = useState("");
    const refresh = () => { void qc.invalidateQueries({ queryKey: ["finance", "certificate", id] }); void qc.invalidateQueries({ queryKey: ["finance", "certificates"] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const upload = useMutation({ mutationFn: ({ file, role }) => postForm(`/finance/tax-certificates/${id}/files`, { file, role }),
        onSuccess: (r) => { refresh(); toast(r.resent ? `Saved (encrypted) and sent to ${r.resent} vendor${r.resent > 1 ? "s" : ""}` : "Saved (encrypted)"); }, onError: err });
    const reg = useMutation({ mutationFn: (body) => api(`/finance/tax-certificates/${id}/vendors`, { method: "PUT", body }), onSuccess: refresh, onError: err });
    const unreg = useMutation({ mutationFn: (vid) => api(`/finance/tax-certificates/${id}/vendors/${vid}`, { method: "DELETE" }), onSuccess: refresh, onError: err });
    const send = useMutation({ mutationFn: (vid) => api(`/finance/tax-certificates/${id}/send`, { method: "POST", body: { vendor_id: vid } }),
        onSuccess: () => { refresh(); toast("Sent"); }, onError: err });
    const act = useMutation({ mutationFn: (path) => api(`/finance/tax-certificates/${id}/${path}`, { method: "POST", body: {} }), onSuccess: refresh, onError: err });
    const del = useMutation({ mutationFn: () => api(`/finance/tax-certificates/${id}`, { method: "DELETE" }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
    const c = q.data;
    if (q.isLoading)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    if (!c)
        return _jsx("div", { className: "detail", children: _jsx(EmptyState, { title: "Certificate not found" }) });
    const pick = (role) => (e) => { const file = e.target.files?.[0]; if (file)
        upload.mutate({ file, role }); e.target.value = ""; };
    return (_jsxs("div", { className: "detail fin-detail", children: [_jsxs("div", { className: "detail-head", children: [_jsx(Button, { icon: true, className: "fin-back", "aria-label": "Back", onClick: onBack, children: _jsx(ArrowLeft, { size: 18 }) }), _jsxs("div", { className: "grow", children: [_jsxs("h2", { children: [c.type_name, " \u00B7 ", c.jurisdiction] }), _jsxs("div", { className: "muted fin-small", children: [c.number || "No number", c.legal_entity ? ` · ${c.legal_entity}` : ""] })] }), _jsx(ExpiryPill, { c: c })] }), c.renewed_by_id && _jsxs("div", { className: "fin-banner", children: ["Renewed \u2014 ", _jsx(Link, { to: `/finance/certificates/${c.renewed_by_id}`, children: "open the new certificate" }), "."] }), _jsxs("div", { className: "row wrap fin-actions", children: [c.status === "active" && _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setEdit(true), children: "Edit" }), _jsxs(Button, { variant: "primary", onClick: () => setRenew(true), children: [_jsx(RefreshCw, { size: 15 }), "Renew"] }), c.card_user_ids.length > 0 && _jsxs(Button, { onClick: () => nav(`/finance/certificates/${c.id}?card=1`), children: [_jsx(CreditCard, { size: 15 }), "Show card"] }), _jsx(Button, { variant: "ghost", onClick: () => { if (confirm("Retire this certificate? It stops covering purchases."))
                                    act.mutate("retire"); }, children: "Retire" })] }), _jsx(Button, { icon: true, variant: "ghost", "aria-label": "Delete", onClick: () => { if (confirm("Delete this certificate?"))
                            del.mutate(); }, children: _jsx(Trash2, { size: 16 }) })] }), _jsx(DropZone, { className: "card", accept: "application/pdf,image/*", multiple: false, label: "Drop a scan to add it", onFiles: (fs) => upload.mutate({ file: fs[0], role: "file" }), children: _jsxs("section", { className: "card-pad stack", children: [_jsxs("div", { className: "row", children: [_jsx("h3", { className: "sec-h grow", children: "Scans" }), _jsxs("label", { className: "btn sm", children: [_jsx(FileUp, { size: 14 }), "Add scan", _jsx("input", { type: "file", accept: "application/pdf,image/*", hidden: true, onChange: pick("file") })] }), _jsxs("label", { className: "btn sm", children: [_jsx(CreditCard, { size: 14 }), c.has_card ? "Replace" : "Add", " card picture", _jsx("input", { type: "file", accept: "image/*", hidden: true, onChange: pick("card") })] })] }), (c.files ?? []).length ? (c.files ?? []).map((f) => _jsxs("a", { className: "row fin-small", href: `/api/v1/finance/tax-certificates/${c.id}/files/${f.id}`, target: "_blank", rel: "noreferrer", children: [_jsx(FileUp, { size: 14 }), f.name] }, f.id)) : _jsx("p", { className: "muted", children: "No scan yet. Scans are encrypted at rest and every view is logged." })] }) }), _jsxs("section", { className: "card card-pad stack", children: [_jsx("h3", { className: "sec-h", children: "Vendors" }), (c.vendors ?? []).map((v) => {
                        const [l, t] = REG[v.status];
                        return (_jsxs("div", { className: "row wrap fin-reg", children: [_jsxs("span", { className: "grow", children: [v.vendor?.name, v.sent_at ? _jsxs("span", { className: "faint fin-small", children: [" \u00B7 sent ", day(v.sent_at), v.sent_to ? ` to ${v.sent_to}` : ""] }) : null] }), _jsx(Pill, { tone: t, children: l }), _jsx(Select, { value: v.status, "aria-label": "Status", onChange: (e) => reg.mutate({ vendor_id: v.vendor?.id, status: e.target.value }), children: Object.entries(REG).map(([k, [lbl]]) => _jsx("option", { value: k, children: lbl }, k)) }), _jsx(Checkbox, { checked: v.auto_resend, onChange: (x) => reg.mutate({ vendor_id: v.vendor?.id, auto_resend: x }), label: "Re-send on renewal" }), _jsxs(Button, { size: "sm", disabled: c.status !== "active", onClick: () => v.vendor && send.mutate(v.vendor.id), children: [_jsx(Send, { size: 13 }), "Send"] }), _jsx(Button, { icon: true, size: "sm", variant: "ghost", "aria-label": "Remove vendor", onClick: () => v.vendor && unreg.mutate(v.vendor.id), children: _jsx(Trash2, { size: 13 }) })] }, v.id));
                    }), _jsxs("div", { className: "row", children: [_jsxs(Select, { value: addVendor, onChange: (e) => setAddVendor(e.target.value), "aria-label": "Add vendor", children: [_jsx("option", { value: "", children: "Add a vendor\u2026" }), vendors.data?.items.filter((v) => !(c.vendors ?? []).some((r) => r.vendor?.id === v.id)).map((v) => _jsx("option", { value: v.id, children: v.name }, v.id))] }), _jsx(Button, { disabled: !addVendor, onClick: () => { reg.mutate({ vendor_id: addVendor }); setAddVendor(""); }, children: "Add" })] }), _jsx("p", { className: "faint fin-small", children: "Purchase orders to vendors that have it on file (or were sent it) are marked tax-exempt and print the certificate number." })] }), c.scope_notes && _jsxs("section", { className: "card card-pad", children: [_jsx("h3", { className: "sec-h", children: "What it covers" }), _jsx("p", { className: "prewrap", children: c.scope_notes })] }), _jsxs("section", { className: "card card-pad stack fin-tight", children: [_jsx("h3", { className: "sec-h", children: "Access log" }), (c.access_log ?? []).map((a, i) => _jsxs("div", { className: "row fin-small", children: [_jsxs("span", { className: "grow", children: [a.user?.name ?? "Someone", " \u00B7 ", a.action.replace("_", " ")] }), _jsx("span", { className: "faint", children: day(a.at) })] }, i))] }), edit && _jsx(CertForm, { edit: c, onClose: () => setEdit(false), onSaved: () => { setEdit(false); refresh(); } }), renew && _jsx(CertForm, { renew: c, onClose: () => setRenew(false), onSaved: (n) => { setRenew(false); refresh(); nav(`/finance/certificates/${n.id}`); } })] }));
}
// ---- the mobile exemption card -----------------------------------------------------------------------------------
const cacheKey = (id) => `mpro.exemption-card.${id}`;
export function ExemptionCardView({ id, onBack }) {
    const [card, setCard] = useState(null);
    const [offline, setOffline] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let gone = false;
        api(`/finance/tax-certificates/${id}/card`).then((c) => {
            if (gone)
                return;
            setCard(c);
            setOffline(false);
            try {
                localStorage.setItem(cacheKey(id), JSON.stringify(c));
            }
            catch { /* storage full or blocked */ }
        }).catch((e) => {
            if (gone)
                return;
            if (e.status === 404 || e.status === 403 || e.status === 409) { // no longer allowed or no longer valid: forget it
                try {
                    localStorage.removeItem(cacheKey(id));
                }
                catch { /* blocked */ }
                setError(e.message || "This card isn't available.");
                return;
            }
            try {
                const raw = localStorage.getItem(cacheKey(id));
                if (raw) {
                    setCard(JSON.parse(raw));
                    setOffline(true);
                    return;
                }
            }
            catch { /* blocked */ }
            setError("You're offline and this card hasn't been opened on this phone before.");
        });
        return () => { gone = true; };
    }, [id]);
    const expired = card?.expires_on ? new Date(card.expires_on + "T23:59:59") < new Date() : false;
    return (_jsxs("div", { className: "fin-card-view", children: [_jsxs("div", { className: "row", children: [_jsx(Button, { icon: true, "aria-label": "Back", onClick: onBack, children: _jsx(ArrowLeft, { size: 18 }) }), _jsx("span", { className: "grow" }), offline && _jsxs(Pill, { tone: "warning", children: [_jsx(WifiOff, { size: 12 }), " Offline copy"] })] }), error ? _jsx(EmptyState, { title: "Card not available", children: error }) : !card ? _jsx(ListSkeleton, { rows: 3 }) : (_jsxs("div", { className: "fin-excard" + (expired ? " expired" : ""), "aria-label": "Tax exemption card", children: [_jsx("div", { className: "fin-excard-wm", "aria-hidden": true, children: Array.from({ length: 8 }, (_, i) => _jsx("span", { children: card.watermark }, i)) }), _jsxs("div", { className: "fin-excard-head", children: [_jsx(BadgeCheck, { size: 22 }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "fin-excard-org", children: card.org_name }), _jsxs("div", { className: "fin-excard-type", children: [card.type, " \u00B7 ", card.jurisdiction] })] })] }), card.image && _jsx("img", { className: "fin-excard-img", src: card.image, alt: "Certificate" }), _jsxs("dl", { className: "fin-excard-dl", children: [_jsxs("div", { children: [_jsx("dt", { children: "Certificate" }), _jsx("dd", { children: card.number || "—" })] }), _jsxs("div", { children: [_jsx("dt", { children: "Purchaser" }), _jsx("dd", { children: card.legal_entity || card.org_name })] }), _jsxs("div", { children: [_jsx("dt", { children: "Expires" }), _jsxs("dd", { children: [expired ? "EXPIRED " : "", day(card.expires_on)] })] })] }), _jsx("div", { className: "fin-excard-foot", children: card.watermark })] }))] }));
}
