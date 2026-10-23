import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Vendors on a work order (0.5.0, r075) with the outside-sharing actions next to them (r058–r060, r094).
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe2, Mail, Pencil, Truck } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Modal, Pill } from "../../components/ui";
import { EmailPdfDialog, ExternalShareDialog } from "./ExternalShare";
import "../../styles/external.css";
function VendorChecklist({ vendors, value, onChange }) {
    const [q, setQ] = useState("");
    const shown = vendors.filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase()));
    return (_jsxs("div", { className: "stack", style: { gap: 6 }, children: [vendors.length > 8 && _jsx("input", { className: "input", placeholder: "Search vendors", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search vendors" }), _jsxs("div", { className: "stack", style: { gap: 4, maxHeight: 220, overflow: "auto" }, children: [shown.map((v) => _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", checked: value.includes(v.id), onChange: (e) => onChange(e.target.checked ? [...value, v.id] : value.filter((x) => x !== v.id)) }), _jsxs("span", { className: "row", style: { gap: 6 }, children: [_jsx("span", { className: "vdot", style: { background: v.color } }), v.name] })] }, v.id)), !vendors.length && _jsx("span", { className: "small muted", children: "No vendors yet. Add them under Vendors." })] })] }));
}
/** Field for the create / edit form. `value` undefined = untouched (edits keep the current vendors). */
export function WOVendorsField({ edit, value, onChange }) {
    const opts = useWOOptions();
    const vendors = opts.data?.vendors ?? [];
    if (!vendors.length)
        return null;
    return _jsxs("div", { className: "field", children: [_jsx("span", { className: "label", children: "Vendors" }), _jsx(VendorChecklist, { vendors: vendors, value: value ?? (edit?.vendors ?? []).map((v) => v.id), onChange: onChange })] });
}
/** Detail card: vendors, plus "Share outside" and "Email PDF". */
export function WorkOrderOutside({ wo, editable }) {
    const { can } = useSession();
    const opts = useWOOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [pick, setPick] = useState(null);
    const [sharing, setSharing] = useState(false);
    const [mailing, setMailing] = useState(false);
    const vendors = opts.data?.vendors ?? [];
    const mine = wo.vendors ?? [];
    const canShare = can("wo.share_external");
    const save = useMutation({
        mutationFn: (ids) => api(`/work-orders/${wo.id}/vendors`, { method: "PUT", body: { vendor_ids: ids } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); setPick(null); toast("Vendors saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!mine.length && !canShare && !(editable && vendors.length))
        return null;
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsxs("h2", { children: [_jsx(Truck, { size: 16 }), " Vendors"] }), _jsxs("div", { className: "row", children: [wo.shared_externally && _jsxs(Pill, { tone: "info", children: [_jsx(Globe2, { size: 12 }), " Shared externally"] }), editable && vendors.length > 0 && _jsxs(Button, { size: "sm", onClick: () => setPick(mine.map((v) => v.id)), children: [_jsx(Pencil, { size: 13 }), "Edit"] }), canShare && _jsxs(Button, { size: "sm", onClick: () => setMailing(true), children: [_jsx(Mail, { size: 14 }), "Email PDF"] }), canShare && _jsxs(Button, { size: "sm", onClick: () => setSharing(true), children: [_jsx(Globe2, { size: 14 }), "Share outside"] })] })] }), _jsx("div", { className: "card-pad row wrap", children: mine.length ? mine.map((v) => _jsxs(Link, { to: `/vendors/${v.id}`, className: "chip", children: [_jsx("span", { className: "vdot", style: { background: v.color } }), v.name] }, v.id))
                    : _jsx("span", { className: "small muted", children: "No vendors on this work order." }) }), pick && _jsx(Modal, { title: "Vendors", onClose: () => setPick(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setPick(null), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => save.mutate(pick), children: "Save" })] }), children: _jsx(VendorChecklist, { vendors: vendors, value: pick, onChange: setPick }) }), sharing && _jsx(ExternalShareDialog, { wo: wo, vendors: vendors, onClose: () => setSharing(false) }), mailing && _jsx(EmailPdfDialog, { wo: wo, vendors: vendors, onClose: () => setMailing(false) })] }));
}
