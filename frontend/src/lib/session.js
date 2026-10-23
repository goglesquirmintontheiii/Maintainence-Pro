import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrf, setMaxUpload, setUnauthorizedHandler } from "./api";
const SessionCtx = createContext(null);
export function applyTheme(theme) {
    // Light is the default (0.3.0); "system" follows the device only when someone picks it.
    const t = theme === "dark" ? "dark"
        : theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = t;
}
export function SessionProvider({ children, fallback }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["session"], queryFn: () => api("/auth/session"), staleTime: 60_000, retry: 1 });
    const set = useCallback((s) => { setCsrf(s.csrf); qc.setQueryData(["session"], s); }, [qc]);
    const refresh = useCallback(async () => { set(await api("/auth/session")); }, [set]);
    useEffect(() => { if (q.data) {
        setCsrf(q.data.csrf);
        applyTheme(q.data.user?.theme);
        setMaxUpload(q.data.max_upload_mb);
    } }, [q.data]);
    useEffect(() => { setUnauthorizedHandler(() => { qc.clear(); void refresh(); }); }, [qc, refresh]);
    useEffect(() => {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const on = () => applyTheme(q.data?.user?.theme);
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, [q.data?.user?.theme]);
    if (q.isError)
        return _jsxs("div", { className: "empty", style: { height: "100%" }, children: [_jsx("h2", { children: "Can't reach Maintenance Pro" }), _jsx("p", { children: q.error.message }), _jsx("button", { className: "btn primary", onClick: () => q.refetch(), children: "Try again" })] });
    if (!q.data)
        return _jsx(_Fragment, { children: fallback });
    const s = q.data;
    // Own vs any (MP-130): someone with only the "…_own" half sees the controls; the server (and per-record `you`
    // flags on detail responses) decides for each record.
    const can = (perm) => !!s.permissions?.includes(perm) || (perm in OWN_OF && !!s.permissions?.includes(OWN_OF[perm]));
    return _jsx(SessionCtx.Provider, { value: { session: s, refresh, set, can }, children: children });
}
export const OWN_OF = {
    "wo.edit": "wo.edit_own", "wo.delete": "wo.delete_own", "assets.manage": "assets.manage_own",
    "procedures.manage": "procedures.manage_own", "po.manage": "po.manage_own",
};
export function useSession() {
    const c = useContext(SessionCtx);
    if (!c)
        throw new Error("useSession outside SessionProvider");
    return c;
}
