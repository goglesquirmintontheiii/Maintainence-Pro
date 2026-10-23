// Parts and inventory: API shapes and small helpers (0.5.0, MP-039–041).
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
export const STATUS_OPTIONS = [["issued", "Used"], ["assigned", "Planned"], ["reserved", "Reserved"], ["kitted", "Kitted"], ["staged", "Staged"]];
export const KIND_TONE = {
    restock: "success", receive: "success", return: "info", initial: "neutral", use: "danger", adjust: "warning", count: "warning", transfer_in: "info", transfer_out: "info",
};
export function usePartOptions() {
    return useQuery({ queryKey: ["part-options"], queryFn: () => api("/parts/options"), staleTime: 60_000 });
}
export function usePartFields() {
    return useQuery({ queryKey: ["custom-fields", "part"], queryFn: () => api("/custom-fields?entity=part"), staleTime: 60_000 });
}
/** Quantity for display: "12", "2.5", with the unit unless it's "each". */
export function qty(v, unit) {
    if (v === null || v === undefined || v === "")
        return "—";
    return unit && unit !== "each" ? `${v} ${unit}` : v;
}
export const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
export const qsOf = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
