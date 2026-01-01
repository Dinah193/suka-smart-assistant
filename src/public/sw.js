/* public/sw.js
 * -----------------------------------------------------------------------------
 * SSA Service Worker
 *
 * Responsibilities for notifications:
 * - Show/replace ongoing session notifications (called from page via registration.showNotification).
 * - Relay notification action clicks ("pause"|"resume"|"next"|"open") back to all
 *   open SSA clients via postMessage, so the app can react (SessionRunner).
 * - Provide message endpoints to close notifications by tag if requested.
 *
 * Notes:
 * - Keep the SW lean. This SW focuses on notifications plumbing and click actions.
 * - If you later add Push, you can reuse the same action relay logic in 'push' events.
 * -----------------------------------------------------------------------------
 */

self.addEventListener("install", (event) => {
  // Activate faster
  self.skipWaiting?.();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Claim clients so messages/notifications work immediately
    await self.clients.claim();
  })());
});

/**
 * Broadcast a message to all window clients of this service worker scope.
 * @param {any} data
 */
async function broadcastToClients(data) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(data);
  }
}

self.addEventListener("notificationclick", (event) => {
  const action = event.action || "open"; // default click (not on action button)
  const n = event.notification;
  const tag = n?.tag || null;
  const data = n?.data || {};

  // Close the notification immediately for UX
  try { n?.close?.(); } catch {}

  // Relay to app
  event.waitUntil((async () => {
    await broadcastToClients({
      type: "SSA_NOTIFICATION_ACTION",
      action,
      tag,
      stepIdx: data.stepIdx,
      totalSteps: data.totalSteps,
      ts: new Date().toISOString(),
    });

    // Focus an existing client or open a new one (for "open" action)
    if (action === "open") {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        // Try to focus the first visible client
        try {
          if ("focus" in c) { await c.focus(); break; }
        } catch { /* ignore */ }
      }
      if (all.length === 0 && self.registration?.scope) {
        // Open root if no client found
        try {
          await self.clients.openWindow(self.registration.scope);
        } catch { /* ignore */ }
      }
    }
  })());
});

// Optional: allow the page to ask SW to close notifications by tag
self.addEventListener("message", (event) => {
  const msg = event?.data || {};
  if (!msg || !msg.type) return;

  if (msg.type === "SSA_NOTIFICATIONS_CLOSE") {
    const tag = String(msg.tag || "");
    event.waitUntil((async () => {
      try {
        const notifs = await self.registration.getNotifications({ tag, includeTriggered: true });
        for (const n of notifs) {
          n.close();
        }
      } catch { /* ignore */ }
    })());
  }

  // (Optional) In the future, you can extend:
  // if (msg.type === "SSA_NOTIFICATIONS_SHOW") { self.registration.showNotification(...msg.payload) }
});

// Optional: if Push is configured later, we can surface notifications here.
// self.addEventListener("push", (event) => {
//   const data = (() => {
//     try { return event.data?.json?.() || {}; } catch { return {}; }
//   })();
//   const title = data.title || "SSA";
//   const options = Object.assign(
//     { body: data.body || "", icon: "/icons/ssa-192.png", badge: "/icons/ssa-badge-72.png" },
//     data.options || {}
//   );
//   event.waitUntil(self.registration.showNotification(title, options));
// });
