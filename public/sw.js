// Mailroom service worker: installable app shell, offline fallback, and Web Push.
// Bump CACHE_VERSION when the caching strategy changes; hashed build assets
// are keyed by URL, so normal deploys do not need a bump.
const CACHE_VERSION = "v1";
const SHELL_CACHE = `mailroom-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `mailroom-assets-${CACHE_VERSION}`;
const SHELL_URL = "/";
const MAX_ASSETS = 60;

// Paths the Worker handles; never serve them from cache.
const NETWORK_ONLY = ["/api/", "/mcp", "/authorize", "/.well-known/", "/cdn-cgi/"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mailroom-") && !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(event));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  }
});

// Every route renders the same SPA shell. Keep the latest good copy so the
// installed app still opens without a connection. Redirects (for example to
// the Cloudflare Access login) pass straight through and are never cached.
async function networkFirstShell(event) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.ok && response.type === "basic" && !response.redirected) {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy)));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic" && !response.redirected) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
  }
  return response;
}

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "New email", body: "A new conversation arrived." };
  }
  const data = payload.data || { url: "/inbox" };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || "New email", {
        body: payload.body || "A new conversation arrived.",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        tag: payload.tag,
        renotify: Boolean(payload.tag),
        timestamp: Date.now(),
        data,
      }),
      updateAppBadge(data.unread),
      // Board reminders don't change the mail lists, so open windows needn't refresh.
      data.kind === "board-reminder"
        ? Promise.resolve()
        : notifyClients({ type: "mailroom:new-email", url: data.url }),
    ]),
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

async function updateAppBadge(unread) {
  if (typeof unread !== "number" || !("setAppBadge" in self.navigator)) return;
  try {
    if (unread > 0) await self.navigator.setAppBadge(unread);
    else await self.navigator.clearAppBadge();
  } catch {
    // Badging is best effort; some platforms reject it outside installed apps.
  }
}

async function notifyClients(message) {
  const windowClients = await self.clients.matchAll({ type: "window" });
  for (const client of windowClients) client.postMessage(message);
}
