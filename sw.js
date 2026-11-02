/*
 * Service worker: keeps the app working with weak or no signal on the course.
 * - App files: served from cache, refreshed in the background.
 * - Course files (hole images, course data): kept once downloaded, so a
 *   course downloaded before the round works offline all day.
 * It never stores or sends location data.
 */
const APP_CACHE = 'gst-app-v1';
const COURSE_CACHE = 'gst-courses-v1';
const APP_FILES = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/geo.js', './js/round.js', './js/store.js', './js/courses.js', './js/holeview.js',
  './courses/index.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== APP_CACHE && k !== COURSE_CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Hole images and course files: cache first (they rarely change).
  if (url.pathname.includes('/courses/') && !url.pathname.endsWith('/courses/index.json')) {
    event.respondWith(caches.open(COURSE_CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App files: answer from cache at once, refresh it in the background.
  event.respondWith(caches.open(APP_CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => hit);
    return hit || net;
  }));
});
