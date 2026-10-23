// Types and hooks for locations, assets, meters and QR codes (0.3.0). Mirrors mpro/assets, mpro/meters and mpro/qr.
import { useQuery } from "@tanstack/react-query";
import { api, getCsrf } from "./api";
import { useSession } from "./session";
export const ASSET_STATUS_LABEL = { online: "Online", offline: "Offline", do_not_track: "Do Not Track" };
export function useAssetOptions() {
    const { can } = useSession();
    return useQuery({ queryKey: ["asset-options"], queryFn: () => api("/assets/options"), staleTime: 60_000, enabled: can("assets.view") });
}
/** Light lists for pickers (≤500 rows; the pickers search on the server beyond that). */
export function useAssetList(q = "") {
    const { can } = useSession();
    return useQuery({ queryKey: ["asset-pick", q], queryFn: () => api(`/assets?per_page=500&sort=name${q ? "&q=" + encodeURIComponent(q) : ""}`),
        staleTime: 30_000, enabled: can("assets.view") });
}
export function useLocationList() {
    const { can } = useSession();
    return useQuery({ queryKey: ["location-pick"], queryFn: () => api("/locations?per_page=500"), staleTime: 30_000,
        enabled: can("locations.view") });
}
export function pathLabel(path, name) {
    return [...(path ?? []).map((p) => p.name), name].join(" › ");
}
/** Binary download of a POSTed request (labels). Opens PDFs in a new tab; saves ZPL. */
export async function postForFile(path, body, filename) {
    const res = await fetch("/api/v1" + path, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrf(), Accept: "application/pdf, text/plain, application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Couldn't make the labels. Try again.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (blob.type === "application/pdf") {
        const w = window.open(url, "_blank");
        if (!w) {
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
        }
    }
    else {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
