const AVATAR_COLORS = ["#1b5bd4", "#0a7f96", "#7a52c9", "#b8560b", "#13805a", "#c4302b", "#3d6fb6", "#8a4fbf", "#0f766e", "#a16207"];
export function avatarColor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++)
        h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export function timeAgo(iso) {
    if (!iso)
        return "Never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 45)
        return "Just now";
    if (s < 3600)
        return `${Math.round(s / 60)} min ago`;
    if (s < 86400)
        return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7)
        return `${Math.round(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
}
export function dateTime(iso, tz) {
    if (!iso)
        return "—";
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
}
export function show(v) {
    if (v === null || v === undefined || v === "")
        return "—";
    return String(v);
}
/** A currency custom field's stored amount ("1250.00") shown in the organization's currency (MP-108). */
export function currency(amount, code = "USD") {
    const n = Number(amount);
    if (amount === null || amount === undefined || amount === "" || Number.isNaN(n))
        return "—";
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(n);
    }
    catch {
        return n.toFixed(2);
    }
}
