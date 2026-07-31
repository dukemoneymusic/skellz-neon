/**
 * SKELLZ service worker.
 *
 * Deliberately conservative. This is a live multiplayer game, so the one thing
 * a cache must never do is hand back a stale board:
 *
 *  - /api/**            never touched. Room state is always from the network.
 *  - /_next/static/**   cache-first. Filenames are content-hashed, so a cached
 *                       hit is always the exact build that asked for it.
 *  - navigations        network-first, falling back to the cached shell and
 *                       then to the offline page.
 *
 * Client and server run the *same* physics code to render a shot, so serving a
 * stale document — and with it stale bundle hashes — could desync replays.
 * Hence network-first for HTML plus skipWaiting/claim: a new deploy takes over
 * immediately rather than lingering behind an old worker.
 */

const VERSION = "skellz-v1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";

const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Lets the page tell a waiting worker to take over straight away.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Anything off-origin (the QR image) is left entirely alone.
  if (url.origin !== self.location.origin) return;

  // Live game state must never come from a cache.
  if (url.pathname.startsWith("/api/")) return;

  // Immutable, content-hashed build output.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Page loads: always try the network so the newest build wins.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(request, copy));
          return res;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match(OFFLINE_URL))),
    );
    return;
  }

  // Icons, splash images and other same-origin assets: serve fast, refresh quietly.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? network;
    }),
  );
});
