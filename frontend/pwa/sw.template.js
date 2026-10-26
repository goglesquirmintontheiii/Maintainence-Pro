/* MPro service worker (0.6.0, MP-053). Generated at build time from frontend/pwa/sw.template.js:
 * __BUILD__ and __SHELL__ are filled in by the vite plugin in vite.config.ts. Not used by `npm run dev`.
 *
 * - App shell: the page and its hashed files are saved on install, so MPro opens with no connection.
 *   A new build waits until the person taps "Reload" (the page posts SKIP_WAITING), so nothing changes mid-task.
 * - API replies (GET /api/v1/…): network first; the last good reply is kept and used when the server can't be
 *   reached (marked with X-MPro-Offline: 1). The work order list falls back to the work orders saved for offline.
 * - Push notifications live in /sw-push.js (notifications workstream) and are loaded here when present.
 */
const BUILD = "__BUILD__";
const SHELL = __SHELL__;
const SHELL_CACHE = "mpro-shell-" + BUILD;
const RUNTIME_CACHE = "mpro-runtime-" + BUILD;
const API_CACHE = "mpro-api"; // keep in step with frontend/src/lib/offline.ts
const DB_NAME = "mpro-offline"; // keep in step with frontend/src/pwa/idb.ts
const NETWORK_TIMEOUT_MS = 8000;
// never saved: the sync feed itself, files and downloads (large, and fetched on purpose), sign-in and exports
const NO_CACHE = [/^\/api\/v1\/sync/, /^\/api\/v1\/files/, /^\/api\/v1\/auth\/(login|logout|switch-org)/, /\/pdf$/, /\/export/, /^\/api\/v1\/downloads/, /\/live/, /\/stream/];

try { importScripts("/sw-push.js"); } catch (e) { /* no push handler in this build */ }

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(["/index.html", ...SHELL])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith("mpro-shell-") && k !== SHELL_CACHE) || (k.startsWith("mpro-runtime-") && k !== RUNTIME_CACHE)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const t = event.data && event.data.type;
  if (t === "SKIP_WAITING") self.skipWaiting();
  else if (t === "CLEAR_API") event.waitUntil(caches.delete(API_CACHE));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (!url.pathname.startsWith("/api/v1/") || NO_CACHE.some((r) => r.test(url.pathname))) return;
    event.respondWith(apiNetworkFirst(req, url));
    return;
  }
  if (req.mode === "navigate") { event.respondWith(page(req)); return; }
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) event.respondWith(cacheFirst(req));
});

async function page(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL_CACHE)).put("/index.html", res.clone());
    return res;
  } catch (e) {
    return (await caches.match("/index.html")) || new Response("<h1>Maintenance Pro</h1><p>You're offline.</p>", { headers: { "Content-Type": "text/html" } });
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(RUNTIME_CACHE)).put(req, res.clone());
  return res;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function apiNetworkFirst(req, url) {
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    const cc = res.headers.get("Cache-Control") || "";
    if (res.status === 200 && (res.headers.get("Content-Type") || "").includes("application/json") && !cc.includes("no-store")) {
      (await caches.open(API_CACHE)).put(req, res.clone());
    }
    return res;
  } catch (e) {
    const hit = await (await caches.open(API_CACHE)).match(req);
    if (hit) return offline(hit);
    if (url.pathname === "/api/v1/work-orders") {
      const list = await savedWorkOrders(url).catch(() => null);
      if (list) return json(list, 200);
    }
    return json({ message: "You're offline, and this wasn't saved on this device. It loads again when you're back online.", status: 503 }, 503);
  }
}

async function offline(res) {
  const h = new Headers(res.headers);
  h.set("X-MPro-Offline", "1");
  return new Response(await res.blob(), { status: res.status, headers: h });
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "X-MPro-Offline": "1" } });
}

// The work order list, offline: built from the work orders saved for this person (To Do / Done tabs and search).
function idb(store, key) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(store)) { resolve(key === undefined ? [] : undefined); return; }
      const os = db.transaction(store).objectStore(store);
      const r = key === undefined ? os.getAll() : os.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

async function savedWorkOrders(url) {
  const cur = await idb("meta", "current");
  const recs = ((await idb("wo")) || []).filter((r) => !cur || r.orgId === cur.orgId);
  const p = url.searchParams;
  const tab = p.get("tab") || "todo";
  const q = (p.get("q") || "").trim().toLowerCase();
  let items = recs.map((r) => r.detail).filter((d) => d && !d.deleted);
  if (tab === "done") items = items.filter((d) => d.status === "done" || d.status === "canceled");
  else if (tab === "todo" || tab === "upcoming") items = items.filter((d) => d.status !== "done" && d.status !== "canceled");
  if (q) items = items.filter((d) => (d.title || "").toLowerCase().includes(q) || String(d.number) === q.replace("#", ""));
  const due = (d) => (d.due_at ? Date.parse(d.due_at) : Number.MAX_SAFE_INTEGER);
  items.sort((a, b) => due(a) - due(b) || a.number - b.number);
  const per = Math.max(1, Math.min(200, Number(p.get("per_page")) || 40));
  return { items: items.slice(0, per), total: items.length, page: 1, per_page: per, offline: true };
}
