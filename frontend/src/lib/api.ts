// Thin client for the MPro REST API (/api/v1). The web app uses the same public API as everyone else.

let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };
export const getCsrf = () => csrf;

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
  version: string; edition: string; region: string; test_build: boolean; csrf: string; authenticated: boolean; max_upload_mb?: number;
  demo_login?: { email: string; password: string } | null;
  user?: { id: string; name: string; email: string; initials: string; theme: "system" | "light" | "dark"; avatar_url?: string | null };
  org?: Org | null; role?: string | null; role_label?: string | null; permissions?: string[];
  entitlements?: { plan: string; features: string[]; limits: Record<string, number | null> };
  orgs?: { id: string; name: string; role: string }[];
};
export type Org = { id: string; name: string; slug: string; timezone: string; currency: string; locale: string; units: string; plan: string; home_region: string };
export type Member = {
  id: string; membership_id: string; name: string; email: string; initials: string; role: string; role_label: string; job_title: string;
  role_id?: string | null; role_key?: string; avatar_url?: string | null;
  active: boolean; has_password: boolean; last_login_at: string | null; joined_at: string | null;
  teams: { id: string; name: string; color: string }[];
};
export type Team = { id: string; name: string; description: string; color: string; member_count: number; created_at: string;
  members: { id: string; name: string; email: string; initials: string }[] };
export type Role = { id: string; key: string; label: string; name: string; rank?: number; description: string; custom: boolean; members: number;
  permissions: string[]; base?: string; base_label?: string; added?: string[]; removed?: string[]; settings?: { wo_visibility?: "all" | "limited" };
  deleted: boolean };
export type AuditEvent = { id: string; type: string; entity_type: string; entity_id: string; entity_label: string; actor_id: string | null;
  actor_label: string; summary: string; changes: Record<string, [unknown, unknown]>; data: Record<string, unknown>; ip: string; created_at: string };
export type Job = { id: string; kind: string; status: string; attempts: number; max_attempts: number; run_at: string; created_at: string;
  finished_at: string | null; last_error: string; locked_by: string };
export type Email = { id: string; to: string; subject: string; body: string; status: string; error: string; created_at: string; sent_at: string | null };
export type SearchGroup = { type: string; label: string; results: { id: string; title: string; subtitle: string; url: string; initials?: string; color?: string }[] };

// ---- uploads ---------------------------------------------------------------------------------
let maxUploadMB = 150;
export const setMaxUpload = (mb: number | undefined) => { if (mb) maxUploadMB = mb; };
export const getMaxUpload = () => maxUploadMB;

/** Upload a file with progress (0–1). Files above the limit are refused before they're sent (MP-109). */
export function upload(file: File, attachTo?: { entity_type: string; entity_id: string; role?: string }, onProgress?: (fraction: number) => void): Promise<FileItem> {
  if (file.size > maxUploadMB * 1024 * 1024) {
    return Promise.reject(new ApiError(413, `${file.name} is ${(file.size / 1048576).toFixed(0)} MB. Files can be up to ${maxUploadMB} MB.`));
  }
  const fd = new FormData();
  fd.append("file", file);
  if (attachTo) { fd.append("entity_type", attachTo.entity_type); fd.append("entity_id", attachTo.entity_id); fd.append("role", attachTo.role ?? "file"); }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    xhr.setRequestHeader("Accept", "application/json");
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up."));
    xhr.onload = () => {
      let data: { message?: string } & Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as FileItem);
      else reject(new ApiError(xhr.status, data.message || (xhr.status === 413 ? `That file is too large. Files can be up to ${maxUploadMB} MB.` : "Upload failed.")));
    };
    xhr.send(fd);
  });
}

// ---- work orders -----------------------------------------------------------------------------
export type WOStatus = "open" | "on_hold" | "in_progress" | "done" | "canceled";
export type WOPriority = "none" | "low" | "medium" | "high";
export type Person = { id: string; name: string; initials: string; avatar_url?: string | null };
export type Assignee = { type: "user" | "team"; id: string; name: string; initials?: string; color?: string; avatar_url?: string | null };
export type CategoryRef = { id: string; name: string; color: string };
export type FileItem = { id: string; link_id: string | null; name: string; content_type: string; size: number; is_image: boolean; role: string | null;
  url: string; thumb_url: string | null; width: number | null; height: number | null; created_at: string };
export type WorkOrder = {
  id: string; number: number; title: string; status: WOStatus; status_label: string; sub_status: string; priority: WOPriority; priority_label: string;
  work_type: "reactive" | "preventive" | "other"; start_at: string | null; due_at: string | null; overdue: boolean; estimated_minutes: number | null;
  assignees: Assignee[]; categories: CategoryRef[]; parent_id: string | null; created_by: Person | null; created_at: string; updated_at: string;
  completed_at: string | null; approval_status: "none" | "pending" | "approved" | "rejected"; custom: Record<string, unknown>; unread: boolean; deleted: boolean;
  version: number; comment_count?: number; sub_work_orders?: { total: number; closed: number } | null;
  asset: { id: string; name: string; status: AssetStatus } | null; location: { id: string; name: string } | null; source_type: string;
  cover_url?: string | null; cover_file_id?: string | null;
  parent?: { id: string; number: number; title: string } | null; // list rows: the parent's number and title (0.4.0)
};
export type AssetStatus = "online" | "offline" | "do_not_track";
export type AssetTask = { id: string; asset: { id: string; name: string; status: AssetStatus; deleted: boolean; location: string | null };
  status: "open" | "in_progress" | "on_hold" | "done"; note: string; updated_at: string; status_changed_at: string | null };
export type MiniWO = { id: string; number: number; title: string; status: WOStatus; priority: WOPriority; due_at: string | null; assignees: Assignee[] };
export type TimeEntry = { id: string; user: Person; minutes: number; time_type: string; rate_cents: number | null; effective_rate_cents: number | null;
  cost_cents: number | null; note: string; started_at: string | null; created_at: string };
export type CostItem = { id: string; user: Person | null; amount_cents: number; cost_type: string; description: string; receipts: FileItem[]; created_at: string };
export type Costs = { time: TimeEntry[]; costs: CostItem[]; timers: { user: Person; started_at: string; time_type: string }[]; total_minutes: number;
  labor_cents: number | null; other_cents: number; total_cents: number | null; rates_visible: boolean };
export type WODetail = WorkOrder & {
  description: string; completed_by: Person | null; completion_summary: string; cancel_reason: string;
  signature: { file: FileItem; name: string; signed_at: string } | null; approved_by: Person | null; approved_at: string | null; status_changed_at: string;
  parent: MiniWO | null; sub_work_orders: MiniWO[]; links: { id: string; relation: "blocks" | "blocked_by" | "related"; work_order: MiniWO }[];
  attachments: FileItem[]; time_in_status: Record<string, number>; costs: Costs; sub_statuses: Record<string, string[]>;
  asset_tasks: AssetTask[];
  procedures?: unknown[]; // procedure runs (pages/procedures/types.ts Run)
  recurrence?: import("../pages/pm/types").Recurrence | null; // repeating work / maintenance plan it came from (0.4.0)
};
export type WOList = { items: WorkOrder[]; total: number; page: number; per_page: number };
export type CustomFieldDef = { id: string; name: string; type: "text" | "textarea" | "number" | "select" | "date" | "datetime" | "link" | "checkbox" | "currency";
  options: string[]; required: boolean; copy_on_repeat?: boolean; on_request_form?: boolean; sort?: number };
export type WOSettings = {
  required_fields: string[]; require_time_to_complete: boolean; require_cost_to_complete: boolean; require_signature: boolean; require_approval: boolean;
  completion_summary: "none" | "optional" | "mandatory"; comment_on_hold: "none" | "optional" | "mandatory"; comment_on_cancel: "none" | "optional" | "mandatory";
  mention_assigns: boolean; todo_by_start_date_only: boolean; time_types: string[]; cost_types: string[]; default_hourly_rate_cents: number | null;
  rates_visible_to_all: boolean; sub_statuses: Record<string, string[]>; default_start_time: string; default_due_time: string; workday_minutes: number; next_number: number;
};
export type WOOptions = {
  statuses: { id: WOStatus; label: string }[]; priorities: { id: WOPriority; label: string }[]; work_types: { id: string; label: string }[];
  categories: CategoryRef[]; teams: { id: string; name: string; color: string }[];
  people: { id: string; name: string; initials: string; role: string; assignable: boolean; avatar_url?: string | null }[]; custom_fields: CustomFieldDef[];
  assets?: { id: string; name: string; path: string }[]; locations?: { id: string; name: string; path: string }[];
  settings: Pick<WOSettings, "required_fields" | "completion_summary" | "comment_on_hold" | "comment_on_cancel" | "require_signature" | "require_approval" | "time_types" | "cost_types" | "sub_statuses" | "default_start_time" | "default_due_time" | "workday_minutes" | "mention_assigns">;
  next_number: number;
};
export type Filter = { field: string; op: string; value?: unknown };
export type SavedView = { id: string; name: string; shared: boolean; filters: Filter[]; sort: string; columns: string[]; pinned: boolean };
export type Template = { id: string; name: string; description: string; data: Record<string, unknown>; pinned: boolean; use_count: number;
  last_used_at: string | null; updated_at: string };
export type Category = CategoryRef & { description: string; work_order_count?: number };
export type ActivityItem = ({ kind: "comment" } & CommentItem & { at: string }) | ({ kind: "event"; at: string } & AuditEvent);
export type CommentItem = { id: string; body: string; deleted: boolean; author: Person | null; mentions: { users: string[]; teams: string[] };
  reactions: Record<string, string[]>; files: FileItem[]; created_at: string; edited_at: string | null };
export type ExportItem = { id: string; kind: string; title: string; status: "queued" | "ready" | "failed"; error: string; file: FileItem | null;
  created_at: string; finished_at: string | null; expires_at: string };
export type Workload = { start: string; days: string[]; capacity_minutes: number; people: (Person & { job_title: string })[]; totals?: Record<string, number>;
  cells: Record<string, Record<string, { minutes: number; items: WLItem[] }>>;
  unassigned: { id: string; name: string; color: string; days: Record<string, { minutes: number; items: WLItem[] }> }[] };
export type WLItem = { id: string; number: number; title: string; priority: WOPriority; minutes: number };
export type WOStats = { open: number; overdue: number; high_priority: number; due_today: number; completed_7d: number; assigned_to_me: number; awaiting_approval: number };
