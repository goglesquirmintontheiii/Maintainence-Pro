// Finance (0.5.0, MP-090–MP-094): shared types, formatting and the multipart helper.
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, getCsrf, getMaxUpload } from "../../lib/api";
import { currency } from "../../lib/format";
export const useFinanceMe = () => useQuery({ queryKey: ["finance", "me"], queryFn: () => api("/finance/me"), staleTime: 60_000 });
export const money = (v, code = "USD") => currency(v ?? null, code || "USD");
export const day = (d) => {
    if (!d)
        return "—";
    const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const RECEIPT_STATUS = {
    new: ["To review", "info"], confirmed: ["Confirmed", "neutral"], matched: ["Matched", "success"], duplicate: ["Possible duplicate", "warning"],
};
export const VI_STATUS = {
    received: ["Received", "info"], matched: ["Matched", "neutral"], pending: ["Waiting for approval", "warning"], approved: ["Approved", "success"], paid: ["Paid", "success"],
    disputed: ["Disputed", "danger"], void: ["Void", "neutral"],
};
export const CI_STATUS = {
    draft: ["Draft", "neutral"], sent: ["Sent", "info"], partially_paid: ["Partially paid", "warning"], paid: ["Paid", "success"],
    overdue: ["Overdue", "danger"], void: ["Void", "neutral"],
};
export const CERT_TYPES = [["resale", "Resale"], ["exempt_organization", "Exempt organization (e.g. 501(c)(3))"],
    ["government", "Government"], ["manufacturing", "Manufacturing / industrial processing"], ["agricultural", "Agricultural"],
    ["direct_pay", "Direct pay permit"], ["custom", "Other"]];
/** POST multipart/form-data (receipts, invoices, certificate scans, statements). Same CSRF rules as api(). */
export async function postForm(path, fields) {
    const fd = new FormData();
    const max = getMaxUpload() * 1024 * 1024;
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined)
            continue;
        for (const one of Array.isArray(v) ? v : [v]) {
            if (one instanceof Blob && one.size > max)
                throw new ApiError(413, `Files can be up to ${getMaxUpload()} MB.`);
            if (one instanceof File)
                fd.append(k, one, one.name);
            else if (one instanceof Blob)
                fd.append(k, one, k === "files" ? "page.jpg" : "file");
            else
                fd.append(k, one);
        }
    }
    let res;
    try {
        res = await fetch("/api/v1" + path, { method: "POST", body: fd, credentials: "same-origin",
            headers: { "X-CSRF-Token": getCsrf(), Accept: "application/json" } });
    }
    catch {
        throw new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new ApiError(res.status, (data && data.message) || "Something went wrong. Try again.", data?.detail);
    return data;
}
