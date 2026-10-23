// Preventive maintenance (0.4.0): API types, hooks and small helpers shared by the PM pages and the work-order inserts.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FREQ_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly", every_n_days: "Every N days" };
export const OCC_LABEL = {
    upcoming: "Upcoming", planned: "Planned", generated: "Created", skipped: "Skipped", completed: "Completed", canceled: "Canceled",
};
export const OCC_TONE = {
    upcoming: "neutral", planned: "neutral", generated: "info", skipped: "warning", completed: "success", canceled: "danger",
};
const ORD = ["", "1st", "2nd", "3rd", "4th", "last"];
/** Friendly summary of a spec, mirroring mpro/pm/schedule.py describe(). `anchor` decides "on the 15th" / "on the 3rd Thursday". */
export function describe(spec, anchor, floating = false) {
    if (!spec?.freq)
        return "";
    const n = Math.max(1, spec.interval || 1);
    const d = anchor ? new Date(anchor) : null;
    let s;
    switch (spec.freq) {
        case "daily":
            s = n === 1 ? "Daily" : `Every ${n} days`;
            break;
        case "every_n_days":
            s = `Every ${n} day${n === 1 ? "" : "s"}`;
            break;
        case "weekly": {
            const days = (spec.weekdays?.length ? spec.weekdays : d ? [(d.getDay() + 6) % 7] : []).slice().sort();
            s = (n === 1 ? "Weekly" : `Every ${n} weeks`) + (days.length ? " on " + days.map((x) => WEEKDAYS[x]).join(", ") : "");
            break;
        }
        case "monthly": {
            s = n === 1 ? "Monthly" : `Every ${n} months`;
            if (d && spec.monthly === "by_weekday") {
                const nth = Math.floor((d.getDate() - 1) / 7) + 1;
                s += ` on the ${ORD[spec.last || nth === 5 ? 5 : nth]} ${d.toLocaleDateString(undefined, { weekday: "long" })}`;
            }
            else if (d)
                s += ` on day ${d.getDate()}`;
            break;
        }
        default: s = n === 1 ? "Yearly" : `Every ${n} years`;
    }
    return s + (floating ? " after completion" : "");
}
export function usePlan(id) {
    return useQuery({ queryKey: ["pm-plan", id], queryFn: () => api(`/pm/plans/${id}`), enabled: !!id });
}
export function useHolidays(enabled = true) {
    return useQuery({ queryKey: ["pm-holidays"], queryFn: () => api("/pm/holidays"), enabled, staleTime: 30_000 });
}
export function pctLabel(p) { return p === null || p === undefined ? "—" : `${Math.round(p)}%`; }
export function pctTone(p) {
    if (p === null || p === undefined)
        return "";
    return p >= 90 ? "success" : p >= 70 ? "warning" : "danger";
}
export const fmtUnits = (n) => (n === null || n === undefined ? "—" : n.toLocaleString());
