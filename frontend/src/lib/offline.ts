// Offline support for the phone app (0.6.0, MP-053, r270, r291). Owned by the PWA workstream (F4).
//
// Contract used by screens:
//   queueMutation({method, path, body, label, woId?, idempotencyKey?}) → sends now when the server answers, or saves
//     the change on this device (IndexedDB) and replays it, in order, when the connection is back. Every change
//     carries an Idempotency-Key, so a replay never runs twice on the server. `queued: true` means it was saved.
//   useOnline() → false while the device or the MPro server can't be reached.
//
// Also here: the sync engine that keeps the person's work orders on the phone (GET /sync change feed + /sync/items),
// the helpers screens use to show a queued change straight away (patchCachedWO, addCachedComment), and the state the
// offline banner and the pending-sync badge read (useOfflineState).
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError, setReachabilityHandler, type WODetail } from "./api";
import * as idb from "../pwa/idb";

export type Mutation = { method: "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: unknown; label: string; idempotencyKey?: string;
  woId?: string }; // the work order it changes: keeps changes to one work order in order, and its version current
export type MutationResult<T> = { queued: boolean; result?: T };

export type QueuedStatus = "pending" | "failed" | "conflict" | "auth";
export type Queued = Mutation & { seq?: number; key: string; userId: string; orgId: string; status: QueuedStatus; error?: string;
  current?: WODetail | null; createdAt: string; attempts: number };
type WORecord = { id: string; orgId: string; version: number; detail: WODetail; activity?: unknown; parts?: unknown; savedAt: string };
type Feed = { cursor: string; full: boolean; server_time: string; cache_ids: string[]; changed_ids: string[]; items_max: number };
type Items = { items: { id: string; version: number; detail: WODetail; activity: unknown; parts?: unknown }[]; missing: string[] };

export const API_CACHE = "mpro-api"; // the service worker's saved API replies (keep in step with the sw template)
const SYNC_EVERY_MS = 5 * 60_000;

// ---------------------------------------------------------------- state the UI reads
type State = { online: boolean; reachable: boolean; queue: Queued[]; syncing: boolean; lastSync: string | null; error: string | null; cached: number };
let state: State = { online: typeof navigator === "undefined" ? true : navigator.onLine, reachable: true, queue: [], syncing: false,
  lastSync: null, error: null, cached: 0 };
const listeners = new Set<() => void>();
function setState(p: Partial<State>) { state = { ...state, ...p }; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function isOnline(): boolean { return state.online && state.reachable; }
export function useOnline(): boolean { return useSyncExternalStore(subscribe, isOnline, () => true); }
export function useOfflineState(): State & { mine: Queued[]; pending: number; problems: number } {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  const mine = s.queue.filter((q) => ctx && q.userId === ctx.userId && q.orgId === ctx.orgId);
  return { ...s, mine, pending: mine.filter((q) => q.status === "pending").length, problems: mine.filter((q) => q.status !== "pending").length };
}

// ---------------------------------------------------------------- who the device belongs to
let ctx: { userId: string; orgId: string } | null = null;
const syncedListeners = new Set<(woIds: string[]) => void>();
/** Screens refresh their queries when queued changes or new data arrive. */
export function onSynced(fn: (woIds: string[]) => void): () => void { syncedListeners.add(fn); return () => { syncedListeners.delete(fn); }; }

/** Called once the session is known (OfflineProvider). Clears another person's or organization's saved work orders. */
export async function attach(userId: string, orgId: string): Promise<void> {
  const prev = await idb.get<{ userId: string; orgId: string }>("meta", "current").catch(() => undefined);
  ctx = { userId, orgId };
  if (prev && (prev.userId !== userId || prev.orgId !== orgId)) await forgetSavedWork();
  await idb.put("meta", { userId, orgId }, "current").catch(() => undefined);
  const lastSync = await idb.get<string>("meta", `last:${userId}:${orgId}`).catch(() => undefined);
  setState({ queue: await idb.all<Queued>("queue").catch(() => []), lastSync: lastSync ?? null, cached: (await idb.all<WORecord>("wo").catch(() => [])).length });
}

export function detach(): void { ctx = null; }

/** Sign-out / switch: drop saved work orders and saved API replies (queued changes stay until that person syncs). */
export async function forgetSavedWork(): Promise<void> {
  await idb.clear("wo").catch(() => undefined);
  if (typeof caches !== "undefined") await caches.delete(API_CACHE).catch(() => false);
  if (ctx) await idb.del("meta", `cursor:${ctx.userId}:${ctx.orgId}`).catch(() => undefined);
  setState({ cached: 0 });
}

// ---------------------------------------------------------------- sending and queueing changes
function newKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return "mp-" + (c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

async function send<T>(m: Mutation, key: string): Promise<T> {
  return api<T>(m.path, { method: m.method, body: m.body, headers: { "Idempotency-Key": key } });
}

export async function queueMutation<T = unknown>(m: Mutation): Promise<MutationResult<T>> {
  const key = m.idempotencyKey ?? newKey();
  const waiting = m.woId && state.queue.some((q) => q.woId === m.woId && q.status === "pending");
  if (isOnline() && !waiting) {
    try {
      const result = await send<T>(m, key);
      afterSuccess(m, result);
      return { queued: false, result };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0 || !ctx) throw e; // a real answer from the server
    }
  }
  if (!ctx) throw new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up.");
  const q: Queued = { ...m, key, userId: ctx.userId, orgId: ctx.orgId, status: "pending", createdAt: new Date().toISOString(), attempts: 0 };
  q.seq = Number(await idb.put("queue", q));
  setState({ queue: [...state.queue, q] });
  return { queued: true };
}

function afterSuccess(m: Mutation, result: unknown) {
  const r = result as Partial<WODetail> | undefined;
  if (m.woId && r && r.id === m.woId && typeof r.version === "number") void saveWO(r as WODetail);
}

async function replaceQueued(q: Queued) { await idb.put("queue", q); setState({ queue: state.queue.map((x) => (x.seq === q.seq ? q : x)) }); }
async function dropQueued(q: Queued) { if (q.seq !== undefined) await idb.del("queue", q.seq); setState({ queue: state.queue.filter((x) => x.seq !== q.seq) }); }

/** Send every queued change, oldest first. Stops at the first one that can't reach the server. */
export async function flush(): Promise<void> {
  if (!ctx) return;
  const touched = new Set<string>();
  for (const q0 of [...state.queue].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (q0.userId !== ctx.userId || q0.orgId !== ctx.orgId || (q0.status !== "pending" && q0.status !== "auth")) continue;
    const q = state.queue.find((x) => x.seq === q0.seq) ?? q0; // versions may have moved on
    try {
      const result = await send<unknown>(q, q.key);
      await dropQueued(q);
      if (q.woId) touched.add(q.woId);
      const r = result as Partial<WODetail> | undefined;
      if (q.woId && r && r.id === q.woId && typeof r.version === "number") {
        await saveWO(r as WODetail);
        // later changes to the same work order started from the version this one replaced
        for (const later of state.queue.filter((x) => x.woId === q.woId && (x.seq ?? 0) > (q.seq ?? 0))) {
          const b = later.body as Record<string, unknown> | undefined;
          if (b && typeof b.version === "number") await replaceQueued({ ...later, body: { ...b, version: r.version } });
        }
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, String(e));
      if (err.status === 0) break; // still offline: try again later
      if (err.status === 401 || (err.status === 403 && /session expired/i.test(err.message))) {
        await replaceQueued({ ...q, status: "auth", error: "Sign in again to send this change.", attempts: q.attempts + 1 });
        break;
      }
      const current = err.status === 409 ? ((err.detail as { current?: WODetail } | undefined)?.current ?? null) : null;
      await replaceQueued({ ...q, status: err.status === 409 ? "conflict" : "failed", error: err.message, current, attempts: q.attempts + 1 });
      if (current) await saveWO(current);
      if (q.woId) touched.add(q.woId);
    }
  }
  if (touched.size) syncedListeners.forEach((fn) => fn([...touched]));
}

/** Conflicts and failures: send again (optionally on top of the newer version), or throw the change away. */
export async function retryQueued(q: Queued, overwrite = false): Promise<void> {
  let body = q.body;
  if (overwrite && body && typeof body === "object") {
    const b = { ...(body as Record<string, unknown>) };
    if (q.current && typeof b.version === "number") b.version = q.current.version; else delete b.version;
    body = b;
  }
  await replaceQueued({ ...q, body, status: "pending", error: undefined, current: undefined, key: newKey() });
  void syncNow();
}
export async function discardQueued(q: Queued): Promise<void> {
  await dropQueued(q);
  if (q.woId) syncedListeners.forEach((fn) => fn([q.woId!]));
}

// ---------------------------------------------------------------- keeping my work orders on the device
async function putCached(path: string, data: unknown) {
  if (typeof caches === "undefined") return;
  const c = await caches.open(API_CACHE);
  await c.put(new Request("/api/v1" + path), new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "X-MPro-Saved": new Date().toISOString() } }));
}
async function dropCached(id: string) {
  if (typeof caches === "undefined") return;
  const c = await caches.open(API_CACHE);
  await Promise.all(["", "/activity", "/parts"].map((s) => c.delete(new Request(`/api/v1/work-orders/${id}${s}`))));
}

async function saveWO(detail: WODetail, extra?: { activity?: unknown; parts?: unknown }) {
  if (!ctx) return;
  const prev = await idb.get<WORecord>("wo", detail.id).catch(() => undefined);
  const rec: WORecord = { id: detail.id, orgId: ctx.orgId, version: detail.version, detail, activity: extra?.activity ?? prev?.activity,
    parts: extra && "parts" in extra ? extra.parts : prev?.parts, savedAt: new Date().toISOString() };
  await idb.put("wo", rec);
  await putCached(`/work-orders/${detail.id}`, detail);
  if (rec.activity) await putCached(`/work-orders/${detail.id}/activity`, rec.activity);
  if (rec.parts) await putCached(`/work-orders/${detail.id}/parts`, rec.parts);
}

/** Show a queued change straight away: update the saved copy of the work order (survives a reload). */
export async function patchCachedWO(id: string, fn: (d: WODetail) => WODetail): Promise<WODetail | null> {
  const rec = await idb.get<WORecord>("wo", id).catch(() => undefined);
  const base = rec?.detail ?? (await readCached<WODetail>(`/work-orders/${id}`));
  if (!base) return null;
  const next = fn(base);
  if (rec) await idb.put("wo", { ...rec, detail: next }); else if (ctx) await idb.put("wo", { id, orgId: ctx.orgId, version: next.version, detail: next, savedAt: new Date().toISOString() });
  await putCached(`/work-orders/${id}`, next);
  return next;
}

/** Show a queued comment in the work order's activity until it's sent. */
export async function addCachedComment(id: string, body: string, author: { id: string; name: string; initials: string }): Promise<unknown> {
  const cur = (await readCached<{ items: unknown[] }>(`/work-orders/${id}/activity`)) ?? { items: [] };
  const item = { kind: "comment", id: "pending-" + newKey(), body, deleted: false, author, mentions: { users: [], teams: [] }, reactions: {}, files: [],
    created_at: new Date().toISOString(), at: new Date().toISOString(), edited_at: null, pending: true };
  const next = { items: [...cur.items, item] };
  await putCached(`/work-orders/${id}/activity`, next);
  const rec = await idb.get<WORecord>("wo", id).catch(() => undefined);
  if (rec) await idb.put("wo", { ...rec, activity: next });
  return next;
}

async function readCached<T>(path: string): Promise<T | null> {
  if (typeof caches === "undefined") return null;
  const r = await (await caches.open(API_CACHE)).match(new Request("/api/v1" + path));
  return r ? ((await r.json().catch(() => null)) as T | null) : null;
}

let running: Promise<void> | null = null;
/** Send queued changes, then fetch what changed in my work orders since the last sync. */
export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    if (!ctx || !isOnline()) return;
    setState({ syncing: true, error: null });
    try {
      await flush();
      if (!isOnline()) return;
      const me = ctx;
      const cursorKey = `cursor:${me.userId}:${me.orgId}`;
      const cursor = await idb.get<string>("meta", cursorKey).catch(() => undefined);
      const f = await api<Feed>(`/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!ctx || ctx.orgId !== me.orgId) return;
      const keep = new Set(f.cache_ids);
      for (const rec of await idb.all<WORecord>("wo")) {
        if (!keep.has(rec.id) && !state.queue.some((q) => q.woId === rec.id)) { await idb.del("wo", rec.id); await dropCached(rec.id); }
      }
      const busy = new Set(state.queue.filter((q) => q.status === "pending" && q.woId).map((q) => q.woId!));
      const todo = f.changed_ids.filter((id) => !busy.has(id));
      for (let i = 0; i < todo.length; i += f.items_max) {
        const r = await api<Items>(`/sync/items?ids=${todo.slice(i, i + f.items_max).join(",")}`);
        for (const it of r.items) await saveWO(it.detail, { activity: it.activity, parts: it.parts });
        for (const id of r.missing) { await idb.del("wo", id); await dropCached(id); }
      }
      // the screens around them, so they open offline too (the service worker saves these replies)
      await Promise.allSettled(["/auth/session", "/work-orders/options", "/me/timers", "/work-orders/stats",
        "/work-orders?tab=todo&scope=assigned_me&sort=due_at&per_page=6"].map((p) => api(p)));
      await idb.put("meta", f.cursor, cursorKey);
      const now = new Date().toISOString();
      await idb.put("meta", now, `last:${me.userId}:${me.orgId}`);
      setState({ lastSync: now, cached: (await idb.all<WORecord>("wo")).length });
      if (todo.length) syncedListeners.forEach((fn) => fn(todo));
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setState({ syncing: false });
      running = null;
    }
  })();
  return running;
}

// ---------------------------------------------------------------- connection tracking
let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const wentOnline = () => { const was = isOnline(); setState({ online: navigator.onLine, reachable: navigator.onLine ? true : state.reachable }); if (!was && isOnline()) void syncNow(); };
  window.addEventListener("online", wentOnline);
  window.addEventListener("offline", () => setState({ online: false }));
  setReachabilityHandler((ok) => { if (ok === state.reachable) return; const was = isOnline(); setState({ reachable: ok }); if (!was && isOnline()) void syncNow(); });
  // the server might be back even when the browser didn't notice: check now and then while there's work to send
  // while offline, check every few seconds whether the server answers again (a real reply flips us back online)
  setInterval(() => { if (ctx && !isOnline() && document.visibilityState === "visible") void api("/auth/session").catch(() => undefined); }, 5_000);
  setInterval(() => {
    if (!ctx || document.visibilityState !== "visible" || !isOnline()) return;
    const stale = !state.lastSync || Date.now() - Date.parse(state.lastSync) > SYNC_EVERY_MS;
    if (stale || state.queue.some((q) => q.status === "pending")) void syncNow();
  }, 30_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && isOnline()) void syncNow(); });
}

/** Mount once inside the signed-in app: keeps the device's copy of my work in step. */
export function useOfflineSync(userId: string | undefined, orgId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    start();
    if (!userId || !orgId || !enabled) { detach(); return; }
    let live = true;
    void attach(userId, orgId).then(() => { if (live) void syncNow(); });
    return () => { live = false; };
  }, [userId, orgId, enabled]);
}
