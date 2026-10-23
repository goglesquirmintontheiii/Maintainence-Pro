// Thin client for the MPro REST API (/api/v1). The web app uses the same public API as everyone else.
let csrf = "";
export const setCsrf = (t) => { csrf = t; };
export const getCsrf = () => csrf;
export class ApiError extends Error {
    constructor(status, message, detail) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export async function api(path, opts = {}) {
    const method = opts.method ?? "GET";
    const headers = { Accept: "application/json" };
    if (opts.body !== undefined)
        headers["Content-Type"] = "application/json";
    if (method !== "GET")
        headers["X-CSRF-Token"] = csrf;
    let res;
    try {
        res = await fetch("/api/v1" + path, { method, headers, credentials: "same-origin", signal: opts.signal,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    }
    catch (e) {
        if (e.name === "AbortError")
            throw e;
        throw new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up.");
    }
    if (res.status === 204)
        return undefined;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401 && onUnauthorized && !path.startsWith("/auth/"))
            onUnauthorized();
        const msg = (data && (data.message || data.detail?.json && "Check the highlighted fields.")) || "Something went wrong. Try again.";
        throw new ApiError(res.status, msg, data?.detail);
    }
    return data;
}
// ---- uploads ---------------------------------------------------------------------------------
let maxUploadMB = 150;
export const setMaxUpload = (mb) => { if (mb)
    maxUploadMB = mb; };
export const getMaxUpload = () => maxUploadMB;
/** Upload a file with progress (0–1). Files above the limit are refused before they're sent (MP-109). */
export function upload(file, attachTo, onProgress) {
    if (file.size > maxUploadMB * 1024 * 1024) {
        return Promise.reject(new ApiError(413, `${file.name} is ${(file.size / 1048576).toFixed(0)} MB. Files can be up to ${maxUploadMB} MB.`));
    }
    const fd = new FormData();
    fd.append("file", file);
    if (attachTo) {
        fd.append("entity_type", attachTo.entity_type);
        fd.append("entity_id", attachTo.entity_id);
        fd.append("role", attachTo.role ?? "file");
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/v1/files");
        xhr.withCredentials = true;
        xhr.setRequestHeader("X-CSRF-Token", csrf);
        xhr.setRequestHeader("Accept", "application/json");
        if (onProgress)
            xhr.upload.onprogress = (e) => { if (e.lengthComputable)
                onProgress(e.loaded / e.total); };
        xhr.onerror = () => reject(new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up."));
        xhr.onload = () => {
            let data = {};
            try {
                data = JSON.parse(xhr.responseText || "{}");
            }
            catch { /* not JSON */ }
            if (xhr.status >= 200 && xhr.status < 300)
                resolve(data);
            else
                reject(new ApiError(xhr.status, data.message || (xhr.status === 413 ? `That file is too large. Files can be up to ${maxUploadMB} MB.` : "Upload failed.")));
        };
        xhr.send(fd);
    });
}
