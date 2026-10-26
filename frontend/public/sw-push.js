/* Web push for Maintenance Pro (MP-051). Imported by the app's service worker (importScripts("/sw-push.js")),
   or registered on its own when there is no other service worker. Keep it dependency-free. */
/* eslint-env serviceworker */
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (_e) { msg = { title: event.data ? event.data.text() : "Maintenance Pro" }; }
  const title = msg.title || "Maintenance Pro";
  const options = {
    body: [msg.body, msg.org].filter(Boolean).join("\n"),
    icon: "/icon-512.png",
    badge: "/favicon.svg",
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    data: { url: msg.url || "/notifications", id: msg.id || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/notifications";
  // only ever open pages of this app
  const target = new URL(raw.startsWith("/") ? raw : "/notifications", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin && "focus" in c) {
        await c.focus();
        if ("navigate" in c) { try { await c.navigate(target); } catch (_e) { /* cross-origin or not controlled */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener("pushsubscriptionchange", () => {
  // The browser rotated the subscription; the app re-subscribes the next time it opens the settings page.
});
