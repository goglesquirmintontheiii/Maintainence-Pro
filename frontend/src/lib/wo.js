// Work-order helpers shared by the list, detail, calendar and settings screens.
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useSession } from "./session";
export const STATUS_ORDER = ["open", "on_hold", "in_progress", "done"];
export const STATUS_LABEL = { open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done", canceled: "Canceled" };
export const PRIORITY_LABEL = { none: "None", low: "Low", medium: "Medium", high: "High" };
export const WORK_TYPE_LABEL = { reactive: "Reactive", preventive: "Preventive", other: "Other" };
export function useWOOptions() {
    const { can } = useSession();
    return useQuery({ queryKey: ["wo-options"], queryFn: () => api("/work-orders/options"), staleTime: 60_000, enabled: can("wo.view") });
}
export function fmtMinutes(n) {
    if (!n)
        return "0 min";
    const h = Math.floor(n / 60), m = n % 60;
    return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}
export function fmtDuration(seconds) {
    if (seconds < 60)
        return "under a minute";
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    return [d && `${d} d`, h && `${h} h`, !d && m && `${m} min`].filter(Boolean).join(" ");
}
export function money(cents, currency = "USD") {
    if (cents === null || cents === undefined)
        return "—";
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
    }
    catch {
        return (cents / 100).toFixed(2);
    }
}
export function shortDate(iso, tz) {
    if (!iso)
        return "";
    const d = new Date(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone: tz });
}
export function dueLabel(iso, overdue, tz) {
    if (!iso)
        return null;
    const d = new Date(iso), now = new Date();
    const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
    const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
    if (overdue)
        return { text: days === 0 ? `Overdue · ${t}` : `Overdue · ${shortDate(iso, tz)}`, tone: "danger" };
    if (days === 0)
        return { text: `Due today · ${t}`, tone: "warning" };
    if (days === 1)
        return { text: "Due tomorrow", tone: "muted" };
    return { text: `Due ${shortDate(iso, tz)}`, tone: "muted" };
}
export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
/** <input type="datetime-local"> value for an ISO date (in the browser's zone). */
export function toLocalInput(iso) {
    if (!iso)
        return "";
    const d = new Date(iso);
    return `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
/** A date (YYYY-MM-DD) at a default time like "12:00", as ISO. */
export function atTime(date, time) { return new Date(`${date}T${time}`).toISOString(); }
export function filtersParam(filters) { return filters.length ? "&filters=" + encodeURIComponent(JSON.stringify(filters)) : ""; }
/** Comment bodies store mentions as @[Name](user:<id>). */
export const MENTION_RE = /@\[([^\]]{1,200})\]\((user|team):([0-9a-fA-F-]{36})\)/g;
export function absoluteUrl(path) { return window.location.origin + path; }
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        return false;
    }
}
