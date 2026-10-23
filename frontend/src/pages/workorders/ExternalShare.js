import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Share a work order outside the organization (0.5.0: r058–r060, r088) and email its PDF to vendors (r094).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { absoluteUrl, copyText } from "../../lib/wo";
import { dateTime, timeAgo } from "../../lib/format";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Field, Input, Modal, Pill, Select } from "../../components/ui";
const ACCESS_LABEL = { hidden: "Hidden", view: "Can view", interact: "Can view and interact" };
function useVendorContacts(vendorId) {
    return useQuery({
        queryKey: ["vendor", vendorId, "contacts"], enabled: !!vendorId,
        queryFn: async () => (await api(`/vendors/${vendorId}`)).contacts.filter((c) => c.email),
    });
}
/** Vendor + contacts + free email addresses: who receives the email. */
function Recipients({ vendors, vendorId, setVendorId, contactIds, setContactIds, emails, setEmails }) {
    const contacts = useVendorContacts(vendorId);
    return _jsxs(_Fragment, { children: [vendors.length > 0 && _jsx(Field, { label: "Vendor", children: (id) => (_jsxs(Select, { id: id, value: vendorId, onChange: (e) => { setVendorId(e.target.value); setContactIds([]); }, children: [_jsx("option", { value: "", children: "None" }), vendors.map((v) => _jsx("option", { value: v.id, children: v.name }, v.id))] })) }), vendorId && _jsx(Field, { label: "Send to contacts", hint: contacts.data && !contacts.data.length ? "This vendor has no contacts with an email address." : undefined, children: () => (_jsx("div", { className: "stack", style: { gap: 4 }, children: (contacts.data ?? []).map((c) => _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: contactIds.includes(c.id), onChange: (e) => setContactIds(e.target.checked ? [...contactIds, c.id] : contactIds.filter((x) => x !== c.id)) }), _jsxs("span", { children: [c.name, " ", _jsx("span", { className: "muted", children: c.email })] })] }, c.id)) })) }), _jsx(Field, { label: "Other email addresses", hint: "Separate addresses with commas.", children: (id) => _jsx(Input, { id: id, type: "text", inputMode: "email", value: emails, onChange: (e) => setEmails(e.target.value), placeholder: "name@example.com" }) })] });
}
const splitEmails = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
function FieldAccess({ fields, value, onChange }) {
    return (_jsxs("table", { className: "table small ext-access", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Field" }), _jsx("th", { children: "Access" })] }) }), _jsx("tbody", { children: fields.map((f) => (_jsxs("tr", { children: [_jsx("td", { children: f.label }), _jsx("td", { children: _jsx(Select, { "aria-label": `${f.label} access`, value: value[f.id] ?? f.default, style: { height: 30 }, onChange: (e) => onChange({ ...value, [f.id]: e.target.value }), children: ["hidden", "view", ...(f.interactive ? ["interact"] : [])].map((a) => _jsx("option", { value: a, children: ACCESS_LABEL[a] }, a)) }) })] }, f.id))) })] }));
}
/** "Share outside" dialog: list links, make a new one (shown once), disable/enable, reset, remove. */
export function ExternalShareDialog({ wo, vendors, onClose }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const { session } = useSession();
    const tz = session.org?.timezone;
    const fieldsQ = useQuery({ queryKey: ["external-fields"], queryFn: () => api("/external-shares/fields"), staleTime: Infinity });
    const sharesQ = useQuery({ queryKey: ["work-order", wo.id, "external-shares"], queryFn: () => api(`/work-orders/${wo.id}/external-shares`) });
    const [creating, setCreating] = useState(false);
    const [access, setAccess] = useState({});
    const [vendorId, setVendorId] = useState(wo.vendors?.[0]?.id ?? "");
    const [contactIds, setContactIds] = useState([]);
    const [emails, setEmails] = useState("");
    const [message, setMessage] = useState("");
    const [fresh, setFresh] = useState(null); // the link, shown once
    const [editing, setEditing] = useState(null);
    const done = wo.status === "done" || wo.status === "canceled";
    const refresh = () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); };
    const fail = (e) => toast(e.message, { kind: "error" });
    const create = useMutation({
        mutationFn: () => api(`/work-orders/${wo.id}/external-shares`, { method: "POST", body: { fields: access, vendor_id: vendorId || null, contact_ids: contactIds, emails: splitEmails(emails), message } }),
        onSuccess: (s) => { setFresh(s); setCreating(false); refresh(); toast(s.recipients.length ? `Link emailed to ${s.recipients.join(", ")}` : "Link created"); },
        onError: fail,
    });
    const patch = useMutation({
        mutationFn: ({ s, body }) => api(`/work-orders/${wo.id}/external-shares/${s.id}`, { method: "PATCH", body }),
        onSuccess: () => { refresh(); setEditing(null); }, onError: fail,
    });
    const reset = useMutation({
        mutationFn: (s) => api(`/work-orders/${wo.id}/external-shares/${s.id}/reset`, { method: "POST" }),
        onSuccess: (s) => { setFresh(s); refresh(); toast("The old link no longer works. Here's the new one."); }, onError: fail,
    });
    const remove = useMutation({
        mutationFn: (s) => api(`/work-orders/${wo.id}/external-shares/${s.id}`, { method: "DELETE" }),
        onSuccess: () => { refresh(); toast("Link removed"); }, onError: fail,
    });
    const fields = fieldsQ.data?.fields ?? [];
    const items = sharesQ.data?.items ?? [];
    return (_jsxs(Modal, { title: `Share #${wo.number} outside your organization`, width: 640, onClose: onClose, footer: creating
            ? _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setCreating(false), children: "Back" }), _jsx(Button, { variant: "primary", disabled: create.isPending, onClick: () => create.mutate(), children: splitEmails(emails).length || contactIds.length ? "Create and email link" : "Create link" })] })
            : _jsx(Button, { onClick: onClose, children: "Close" }), children: [fresh?.path && _jsxs("div", { className: "banner info stack", style: { alignItems: "stretch" }, children: [_jsxs("div", { children: [_jsx("b", { children: "Copy this link now." }), " For security it's shown only once; if you lose it, reset the link to get a new one."] }), _jsxs("div", { className: "row", children: [_jsx(Input, { readOnly: true, value: absoluteUrl(fresh.path), onFocus: (e) => e.currentTarget.select(), "aria-label": "Link" }), _jsxs(Button, { onClick: async () => toast((await copyText(absoluteUrl(fresh.path))) ? "Link copied" : "Couldn't copy the link"), children: [_jsx(Copy, { size: 14 }), "Copy"] })] })] }), creating ? _jsxs("div", { className: "stack", children: [_jsx("p", { className: "small muted", children: "Anyone with the link can see what you allow below, without an account. It turns off by itself when the work order is Done." }), _jsx(FieldAccess, { fields: fields, value: access, onChange: setAccess }), _jsx(Recipients, { vendors: vendors, vendorId: vendorId, setVendorId: setVendorId, contactIds: contactIds, setContactIds: setContactIds, emails: emails, setEmails: setEmails }), _jsx(Field, { label: "Message (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: message, onChange: (e) => setMessage(e.target.value) }) })] }) : _jsxs("div", { className: "stack", children: [done && _jsxs("div", { className: "banner warning", children: ["This work order is ", wo.status === "done" ? "Done" : "canceled", ", so its links are off. Reopen it to share again."] }), !items.length && !sharesQ.isLoading && _jsx("p", { className: "muted", children: "No links yet. Make one to let a vendor or contractor see the work, fill in procedures, comment and add photos without an account." }), items.map((s) => (_jsxs("div", { className: "card card-pad stack", style: { gap: 6 }, children: [_jsxs("div", { className: "row wrap", children: [_jsx(Pill, { tone: s.status === "active" ? "success" : "neutral", children: s.status === "active" ? "Active" : "Off" }), s.finished_at && _jsxs(Pill, { tone: "info", children: ["Finished by ", s.finished_by_name] }), _jsxs("span", { className: "small muted grow", children: ["Made ", timeAgo(s.created_at), s.created_by && ` by ${s.created_by.name}`, s.recipients.length > 0 && ` · sent to ${s.recipients.join(", ")}`] })] }), _jsx("div", { className: "small muted", children: s.last_viewed_at ? `Last opened ${dateTime(s.last_viewed_at, tz)}` : "Not opened yet" }), _jsxs("div", { className: "row wrap", children: [_jsx(Button, { size: "sm", onClick: () => setEditing(s), children: "Field access" }), _jsx(Button, { size: "sm", disabled: patch.isPending || (done && s.status !== "active"), onClick: () => patch.mutate({ s, body: { status: s.status === "active" ? "disabled" : "active" } }), children: s.status === "active" ? "Turn off" : "Turn on" }), _jsxs(Button, { size: "sm", disabled: reset.isPending || done, onClick: () => reset.mutate(s), title: "The old link stops working and you get a new one", children: [_jsx(RefreshCw, { size: 13 }), "Reset link"] }), _jsxs(Button, { size: "sm", variant: "ghost", style: { color: "var(--c-danger)" }, disabled: remove.isPending, onClick: () => remove.mutate(s), children: [_jsx(Trash2, { size: 13 }), "Remove"] })] })] }, s.id))), !done && _jsx("div", { children: _jsxs(Button, { variant: "primary", onClick: () => { setFresh(null); setAccess({}); setCreating(true); }, children: [_jsx(Plus, { size: 14 }), "New link"] }) })] }), editing && _jsx(Modal, { title: "Field access", onClose: () => setEditing(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setEditing(null), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: patch.isPending, onClick: () => patch.mutate({ s: editing, body: { fields: editing.fields } }), children: "Save" })] }), children: _jsx(FieldAccess, { fields: fields, value: editing.fields, onChange: (v) => setEditing({ ...editing, fields: v }) }) })] }));
}
/** r094: email the work order PDF to vendors with a message. */
export function EmailPdfDialog({ wo, vendors, onClose }) {
    const { toast } = useToast();
    const [vendorId, setVendorId] = useState(wo.vendors?.[0]?.id ?? "");
    const [contactIds, setContactIds] = useState([]);
    const [emails, setEmails] = useState("");
    const [message, setMessage] = useState("");
    const send = useMutation({
        mutationFn: () => api(`/work-orders/${wo.id}/email-pdf`, { method: "POST", body: {
                vendor_ids: vendorId && !contactIds.length ? [vendorId] : [], contact_ids: contactIds, emails: splitEmails(emails), message
            } }),
        onSuccess: (r) => { toast(`PDF sent to ${r.sent_to.join(", ")}`); onClose(); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    return (_jsx(Modal, { title: `Email #${wo.number} as a PDF`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: send.isPending, onClick: () => send.mutate(), children: [_jsx(Mail, { size: 14 }), "Send"] })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Recipients, { vendors: vendors, vendorId: vendorId, setVendorId: setVendorId, contactIds: contactIds, setContactIds: setContactIds, emails: emails, setEmails: setEmails }), vendorId && !contactIds.length && _jsx("p", { className: "small muted", children: "With no contacts picked, it goes to the vendor's purchase order contacts (or all its contacts)." }), _jsx(Field, { label: "Message", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 4, value: message, onChange: (e) => setMessage(e.target.value), placeholder: "Please quote for this job\u2026" }) })] }) }));
}
