// Purchase orders (0.5.0, MP-042–044): API shapes and small shared hooks.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
export const PO_STATUS = {
    requested: "Requested", pending: "Pending approval", approved: "Approved", rejected: "Rejected",
    partially_fulfilled: "Partially fulfilled", complete: "Complete", canceled: "Canceled",
};
export const PO_TONE = {
    requested: "warning", pending: "warning", approved: "info", rejected: "danger", partially_fulfilled: "info", complete: "success", canceled: "neutral",
};
export function usePOOptions() {
    return useQuery({ queryKey: ["po-options"], queryFn: () => api("/purchase-orders/options"), staleTime: 60_000 });
}
export function addrLines(a) {
    if (!a)
        return [];
    return [a.company, a.attention && `Attn: ${a.attention}`, a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean);
}
/** "12.5000" → "12.5" for display of quantities. */
export function q(v) {
    if (v === null || v === undefined || v === "")
        return "—";
    const n = Number(v);
    return Number.isNaN(n) ? v : String(+n.toFixed(4));
}
