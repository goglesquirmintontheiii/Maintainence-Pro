import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// The Customer field on work orders (MP-046, r234): a picker for the work-order form and a row for the detail.
// Saved through PUT /work-orders/:id/customer so the work-order payload itself stays unchanged.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { MultiPicker } from "../../components/pickers";
import { useCustomersLite } from "./Customers";
export function useWOCustomer(woId) {
    const { can } = useSession();
    return useQuery({ queryKey: ["wo-customer", woId], queryFn: () => api(`/work-orders/${woId}/customer`), enabled: !!woId && can("customers.view") });
}
/** Save the picked customer after the work order itself was saved. `undefined` = unchanged. */
export async function saveWOCustomer(woId, customerId) {
    if (customerId === undefined)
        return;
    await api(`/work-orders/${woId}/customer`, { method: "PUT", body: { customer_id: customerId } });
}
export function WOCustomerPicker({ value, onChange, id }) {
    const list = useCustomersLite();
    const items = list.data?.items ?? [];
    return _jsx(MultiPicker, { id: id, single: true, label: "Customer", placeholder: "No customer", value: value ? [value] : [], searchPlaceholder: "Search customers", options: items.map((c) => ({ key: c.id, label: c.name, icon: _jsx(UserRound, { size: 14, className: "faint" }) })), onChange: (v) => { const c = items.find((x) => x.id === v[0]); onChange(c ? c.id : null, c?.default_location_id ?? null); } });
}
/** True when the Customer field is worth showing: the person may see customers and the org has some. */
export function useShowCustomerField() {
    const { can } = useSession();
    const list = useCustomersLite();
    return can("customers.view") && (list.data?.items.length ?? 0) > 0;
}
/** <dl> row on the work-order detail, editable in place. */
export function WOCustomerRow({ woId, canEdit }) {
    const cur = useWOCustomer(woId);
    const show = useShowCustomerField();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const save = useMutation({ mutationFn: (cid) => saveWOCustomer(woId, cid),
        onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ["wo-customer", woId] }); qc.invalidateQueries({ queryKey: ["customer"] }); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    const c = cur.data?.customer;
    if (!c && !show)
        return null;
    return (_jsxs("div", { children: [_jsx("dt", { children: "Customer" }), _jsx("dd", { children: editing ? _jsx(WOCustomerPicker, { value: c?.id ?? null, onChange: (id) => save.mutate(id) })
                    : _jsxs("span", { className: "row", style: { gap: 6 }, children: [c ? _jsxs(Link, { to: `/customers/${c.id}`, className: "row", style: { gap: 6 }, children: [_jsx(UserRound, { size: 14, className: "faint" }), c.name] }) : _jsx("span", { className: "faint", children: "None" }), canEdit && _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setEditing(true), children: c ? "Change" : "Add" })] }) })] }));
}
