// Web push on this device (MP-051). The push and notification-click handlers live in public/sw-push.js, which the app's
// one service worker (/sw.js, registered by pwa/OfflineUI.tsx) loads with importScripts. We never register a worker here.
import { api } from "./api";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The app's service worker, once it's active (it's registered on load by the offline support).
function registration(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The app isn't ready for push yet. Reload the page and try again.")), 10_000)),
  ]);
}

// Builds before 0.6.0 shipped registered /sw-push.js on its own; remove that so only /sw.js controls the app.
export async function removeStalePushWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      const url = (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL ?? "";
      if (url.endsWith("/sw-push.js")) await reg.unregister();
    }
  } catch { /* ignore */ }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg || (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL.endsWith("/sw-push.js")) return null;
  return reg.pushManager.getSubscription();
}

// Ask the browser for permission, subscribe with the server's VAPID key and tell the server about this device.
export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("This browser can't receive push notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON();
  await api("/notifications/push/subscriptions", { method: "POST", body: { endpoint: j.endpoint, keys: j.keys } });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/notifications/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}

// Sign-out on this device: tell the server to stop pushing to it and drop the browser's subscription, so the next
// person to use the phone doesn't see the previous person's notifications. Returns the endpoint to send with logout.
export async function releasePushOnSignOut(): Promise<string | null> {
  try {
    const sub = await currentSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => undefined);
    return endpoint;
  } catch { return null; }
}
