/*
 * Service worker: caches the app's own files so it opens even with weak or
 * no signal on the course. It does NOT cache or send any location data.
 * Map imagery comes from another site (USGS) and is not cached here yet.
 *
 * Strategy: "stale-while-revalidate" — show the cached copy instantly, then
 * fetch a fresh copy in the background for next time. After you publish an
 * update, open the app twice to see it (or bump CACHE_NAME below).
 */
const CACHE_NAME = 'shot-tracker-v2';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/geo.js',
  './js/round.js',
  './js/store.js',
  './js/map.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './gps-test/',
  './gps-test/index.html',
  './gps-test/style.css',
  './gps-test/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove caches from older versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached); // offline: fall back to the cached copy
      return cached || network;
    })
  );
});
