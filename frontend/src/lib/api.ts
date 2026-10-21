// Thin client for the MPro REST API (/api/v1). The web app uses the same public API as everyone else.

let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

type Opts = { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal };

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  let res: Response;
  try {
    res = await fetch("/api/v1" + path, { method, headers, credentials: "same-origin", signal: opts.signal,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !path.startsWith("/auth/")) onUnauthorized();
    const msg = (data && (data.message || data.detail?.json && "Check the highlighted fields.")) || "Something went wrong. Try again.";
    throw new ApiError(res.status, msg, data?.detail);
  }
  return data as T;
}

export type Session = {
  version: string; edition: string; region: string; test_build: boolean; csrf: string; authenticated: boolean;
  demo_login?: { email: string; password: string } | null;
  user?: { id: string; name: string; email: string; initials: string; theme: "system" | "light" | "dark" };
  org?: Org | null; role?: string | null; role_label?: string | null; permissions?: string[];
  entitlements?: { plan: string; features: string[]; limits: Record<string, number | null> };
  orgs?: { id: string; name: string; role: string }[];
};
export type Org = { id: string; name: string; slug: string; timezone: string; currency: string; locale: string; units: string; plan: string; home_region: string };
export type Member = {
  id: string; membership_id: string; name: string; email: string; initials: string; role: string; role_label: string; job_title: string;
  active: boolean; has_password: boolean; last_login_at: string | null; joined_at: string | null;
  teams: { id: string; name: string; color: string }[];
};
export type Team = { id: string; name: string; description: string; color: string; member_count: number; created_at: string;
  members: { id: string; name: string; email: string; initials: string }[] };
export type Role = { id: string; label: string; rank: number; description: string };
export type AuditEvent = { id: string; type: string; entity_type: string; entity_id: string; entity_label: string; actor_id: string | null;
  actor_label: string; summary: string; changes: Record<string, [unknown, unknown]>; data: Record<string, unknown>; ip: string; created_at: string };
export type Job = { id: string; kind: string; status: string; attempts: number; max_attempts: number; run_at: string; created_at: string;
  finished_at: string | null; last_error: string; locked_by: string };
export type Email = { id: string; to: string; subject: string; body: string; status: string; error: string; created_at: string; sent_at: string | null };
export type SearchGroup = { type: string; label: string; results: { id: string; title: string; subtitle: string; url: string; initials?: string; color?: string }[] };
