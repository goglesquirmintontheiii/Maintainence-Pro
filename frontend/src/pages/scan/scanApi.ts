// Scan actions, check-ins and history (0.6.0, MP-097). Talks to POST /scan, /scan/events and /scan/history.
// Offline: recent scans are cached on the phone so a code scanned again without signal still opens, and the scan and
// any action taken are queued through lib/offline (F4) with a client id, so a replay is never counted twice.
import { api, ApiError } from "../../lib/api";
import { queueMutation } from "../../lib/offline";

export type ScanAction = { key: string; label: string };
export type ScanWO = { id: string; number: number; title: string; status: string; due_at: string | null; assigned_to_me: boolean };
export type ScanContext = {
  status?: string; location?: string | null; work_orders?: ScanWO[]; meters?: { id: string; name: string; unit: string }[]; files?: number;
  assets?: { id: string; name: string; status: string }[]; unit?: string; on_hand?: string; available?: string; part_number?: string;
  non_stock?: boolean; number?: number; title?: string; published?: boolean; last_value?: string | null; last_reading_at?: string | null;
};
export type ScanFound = {
  status: "found"; entity_type: string; entity_id: string; label: string; url: string; code?: { id: string; value: string };
  scan_id?: string; actions: ScanAction[]; default_action: string; context: ScanContext; limited?: boolean; offline?: boolean;
};
export type ScanEvent = {
  id: string; entity_type: string; entity_id: string; entity_label: string; action: string; action_label: string;
  work_order_id: string | null; source: string; user: { id: string; name: string } | null; public: boolean; scanned_at: string;
  gps?: { latitude: string; longitude: string; accuracy_m: number | null };
};
export type ScanSettings = {
  default_actions: Record<string, string>; role_actions: Record<string, Record<string, string>>; public_scans: boolean;
  public_types: string[]; record_gps: boolean; require_window_minutes: number; actions: Record<string, ScanAction[]>;
};

export const TYPE_LABEL: Record<string, string> = {
  asset: "Asset", location: "Location", part: "Part", work_order: "Work order", procedure: "Procedure", meter: "Meter",
};

const CACHE_KEY = "mpro.scan.cache";
const CACHE_MAX = 300;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function readCache(): Record<string, ScanFound & { at: number }> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as Record<string, ScanFound & { at: number }>; } catch { return {}; }
}
function writeCache(key: string, r: ScanFound) {
  try {
    const c = readCache();
    c[key] = { ...r, scan_id: undefined, at: Date.now() };
    const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at);
    for (const k of keys.slice(CACHE_MAX)) delete c[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* private mode or full: scanning still works online */ }
}
const cacheKey = (v: string) => { const m = /\/q\/([A-Za-z0-9]{6,20})\/?(?:[?#].*)?$/.exec(v); return (m ? m[1] : v).trim().toUpperCase(); };

let gpsCfg: Promise<boolean> | null = null;
export function recordsGps(): Promise<boolean> {
  gpsCfg ??= api<{ record_gps: boolean }>("/scan/config").then((c) => c.record_gps).catch(() => false);
  return gpsCfg;
}
export function resetScanConfig() { gpsCfg = null; }

/** The phone's position, if the organization keeps it and the person allows it (never waits more than 4 s). */
export async function position(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!(await recordsGps()) || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null), { timeout: 4000, maximumAge: 60_000, enableHighAccuracy: false });
  });
}

const isNetworkError = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 502;

/** Resolve and record a scan. Returns the server's answer, or the cached record when the phone is offline. */
export async function scanRecord(value: string, source: "camera" | "link" | "typed" | "photo"): Promise<ScanFound | Record<string, unknown> & { status: string }> {
  const gps = await position();
  const client_id = newId();
  const scanned_at = new Date().toISOString();
  try {
    const r = await api<ScanFound | (Record<string, unknown> & { status: string })>("/scan", { method: "POST", body: { value, source, client_id, scanned_at, ...(gps ?? {}) } });
    if (r.status === "found") writeCache(cacheKey(value), r as ScanFound);
    return r;
  } catch (e) {
    const cached = readCache()[cacheKey(value)];
    if (!isNetworkError(e) || !cached) throw e;
    // offline: open what we know, and send the scan when the connection is back
    void queueMutation({ method: "POST", path: "/scan/events", label: `Scan of ${cached.label}`, idempotencyKey: client_id,
      body: { entity_type: cached.entity_type, entity_id: cached.entity_id, code: cached.code?.value, client_id, scanned_at, source: "offline", ...(gps ?? {}) } }).catch(() => undefined);
    return { ...cached, offline: true, scan_id: undefined };
  }
}

/** Keep an action in the scan history (check-in, start, reading…). Queued when offline. */
export async function recordAction(r: ScanFound, action: string, workOrderId?: string): Promise<{ queued: boolean }> {
  const gps = await position();
  const client_id = newId();
  const res = await queueMutation({ method: "POST", path: "/scan/events", label: `${action.replace("_", " ")} at ${r.label}`, idempotencyKey: client_id,
    body: { entity_type: r.entity_type, entity_id: r.entity_id, action, work_order_id: workOrderId, code: r.code?.value, client_id,
      scanned_at: new Date().toISOString(), source: r.offline ? "offline" : "camera", ...(gps ?? {}) } });
  return { queued: res.queued };
}
