import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrf, setUnauthorizedHandler, type Session } from "./api";

type Ctx = { session: Session; refresh: () => Promise<void>; set: (s: Session) => void; can: (perm: string) => boolean };
const SessionCtx = createContext<Ctx | null>(null);

export function applyTheme(theme: string | undefined) {
  const t = theme === "light" || theme === "dark" ? theme
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
}

export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["session"], queryFn: () => api<Session>("/auth/session"), staleTime: 60_000, retry: 1 });
  const set = useCallback((s: Session) => { setCsrf(s.csrf); qc.setQueryData(["session"], s); }, [qc]);
  const refresh = useCallback(async () => { set(await api<Session>("/auth/session")); }, [set]);
  useEffect(() => { if (q.data) { setCsrf(q.data.csrf); applyTheme(q.data.user?.theme); } }, [q.data]);
  useEffect(() => { setUnauthorizedHandler(() => { qc.clear(); void refresh(); }); }, [qc, refresh]);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme(q.data?.user?.theme);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q.data?.user?.theme]);
  if (q.isError) return <div className="empty" style={{ height: "100%" }}><h2>Can't reach Maintenance Pro</h2><p>{(q.error as Error).message}</p>
    <button className="btn primary" onClick={() => q.refetch()}>Try again</button></div>;
  if (!q.data) return <>{fallback}</>;
  const s = q.data;
  const can = (perm: string) => !!s.permissions?.includes(perm);
  return <SessionCtx.Provider value={{ session: s, refresh, set, can }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
