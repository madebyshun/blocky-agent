// Blue Hood — service worker (T-D D3).
//
// Named `hood-sw.js` (not the more common `sw.js`) so it doesn't clobber
// any future generic app-shell worker Blue Chat / Bank might add.
//
// SCOPE (task A1 root-cause fix): registered by
// `EnableAlertsButton.tsx` with `scope: "/"`. The v1 impl used
// `scope: "/hood/"`, but the actual pages live at `/app/hood/*` (see
// middleware rewrite). An SW that doesn't cover the CURRENT page's
// URL never satisfies `navigator.serviceWorker.ready`, and the enable
// button hung forever with zero console output. `scope: "/"` covers
// both `/app/hood/*` and `/hood/*`. The `notificationclick` handler
// below only reacts to clicks originating from a Blue-Hood
// notification (tag prefix `hood-arrow-`), so widening the scope does
// NOT affect other pages on the origin.
//
// Contract: receive a `push` event with a JSON payload from
// `lib/blue-hood/push.ts` (`{ kind: "hood.arrow", serial, ticker,
// signal, brief, url }`), render a notification, and on click open
// the inbox URL (or focus an existing tab if the app is already open).

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (!payload || payload.kind !== "hood.arrow") return;

  const title = `Blue Hood ${payload.serial} · ${payload.ticker}`;
  const body = `${payload.signal}${payload.brief ? " — " + payload.brief : ""}`;
  const url = payload.url || "/hood/inbox";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body.slice(0, 300),
      tag: "hood-arrow-" + payload.id,
      badge: "/icon.png",
      icon: "/icon.png",
      data: { url, arrowId: payload.id },
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "/hood/inbox";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      const u = new URL(client.url);
      if (u.pathname.startsWith("/hood") || u.pathname.startsWith("/app/hood")) {
        client.focus();
        client.postMessage({ kind: "hood.arrow.click", arrowId: event.notification.data && event.notification.data.arrowId });
        return;
      }
    }
    self.clients.openWindow(targetUrl);
  })());
});
