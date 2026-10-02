// Service worker: gør appen tilgængelig offline.
// Hæv versionen når filerne ændres, så telefonen henter den nye udgave.
const CACHE = "wine-cellar-v3";
const FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "manifest.json",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Netværk først (så opdateringer slår igennem), cache som fallback offline.
// Kald til Supabase (login og data) går altid direkte til nettet.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).hostname.endsWith(".supabase.co")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
