const CACHE_NAME = "home-cache-v6";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js?v=20260419-4",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  if (new URL(request.url).pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }

        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }

        return caches.match("./");
      })
  );
});
