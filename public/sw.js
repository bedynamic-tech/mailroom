self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "New email", body: "A new conversation arrived." };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "New email", {
      body: payload.body || "A new conversation arrived.",
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      data: payload.data || { url: "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const relativeUrl = event.notification.data?.url || "/inbox";
  const targetUrl = new URL(relativeUrl, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const existing = windowClients.find((client) => client.url.startsWith(self.location.origin));
        if (existing) {
          if ("navigate" in existing && existing.url !== targetUrl) await existing.navigate(targetUrl);
          if ("focus" in existing) return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
