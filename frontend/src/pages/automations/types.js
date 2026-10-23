// Automations (0.4.0, MP-117): types and small helpers shared by the list, detail and builder.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
export const TRIGGER_LABEL = {
    meter_reading: "Meter reading", asset_status: "Asset status changes", work_order_status: "Work order status changes",
};
export const COND_LABEL = {
    above: "Is above", below: "Is below", equal: "Is equal to", increases_by: "Increases by (every…)", decreases_by: "Decreases by (every…)",
    increases_from_last: "Increases from the last reading by", decreases_from_last: "Decreases from the last reading by",
};
export const RECURRING = ["increases_by", "decreases_by"];
export const ASSET_STATUS = { online: "Online", offline: "Offline", do_not_track: "Do Not Track" };
export const WO_STATUS = { open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done", canceled: "Canceled" };
export const ACTION_LABEL = {
    create_work_order: "Create a work order", change_asset_status: "Change asset status", send_email: "Send an email",
};
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** 90 → "1 hour 30 min"; 0 → "" */
export function minutesText(n) {
    if (!n)
        return "";
    if (n % 1440 === 0)
        return `${n / 1440} day${n === 1440 ? "" : "s"}`;
    if (n % 60 === 0)
        return `${n / 60} hour${n === 60 ? "" : "s"}`;
    if (n > 60)
        return `${Math.floor(n / 60)} h ${n % 60} min`;
    return `${n} min`;
}
export function emptyDoc(kind = "meter_reading") {
    return {
        name: "", description: "", active: true, targets: [], conditions: [], rerun_minutes: 0,
        trigger: kind === "meter_reading" ? { type: kind, condition: "above", value: "" }
            : kind === "asset_status" ? { type: kind, from: [], to: ["offline"] }
                : { type: kind, from: [], to: ["done"], priorities: [], categories: [] },
        sensitivity: kind === "meter_reading" ? { mode: "once" } : {},
        actions: [{ type: "create_work_order", title: "", priority: "medium" }],
    };
}
/** Light meter list for the pickers (≤500). */
export function useMeterList() {
    const { can } = useSession();
    return useQuery({ queryKey: ["meter-pick"], queryFn: () => api("/meters?per_page=500"), staleTime: 30_000, enabled: can("meters.view") });
}
