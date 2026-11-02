/*
 * Course data: the list of courses and each course's holes, made by
 * tools/build_courses.py from OpenStreetMap and USGS aerial photos.
 * Files live in courses/ next to the app and are cached for offline use.
 */

import { distM } from './geo.js';

let indexCache = null;
const courseCache = {};

export async function loadIndex() {
  if (!indexCache) {
    const r = await fetch('courses/index.json');
    if (!r.ok) throw new Error('Could not load the course list.');
    indexCache = (await r.json()).courses;
  }
  return indexCache;
}

export async function loadCourse(id) {
  if (!courseCache[id]) {
    const r = await fetch(`courses/${id}/course.json`);
    if (!r.ok) throw new Error('Could not load this course.');
    courseCache[id] = await r.json();
  }
  return courseCache[id];
}

export const cachedCourse = (id) => courseCache[id] || null;

export function courseHole(course, n) {
  return course ? course.holes.find((h) => h.n === n) || null : null;
}

export const imageUrl = (course, h) => (h && h.image ? `courses/${course.id}/${h.image.file}` : null);

// Courses sorted nearest first when we know where the player is.
export function sortByDistance(list, here) {
  if (!here) return [...list].sort((a, b) => a.name.localeCompare(b.name));
  return [...list]
    .map((c) => ({ ...c, away_m: distM(here, c.center) }))
    .sort((a, b) => a.away_m - b.away_m);
}

/*
 * Download every hole image of a course into the offline cache before the
 * round, so the course works with no signal. The service worker serves them.
 */
export async function downloadForOffline(course, onProgress = () => {}) {
  if (!('caches' in window)) return;
  const cache = await caches.open('gst-courses-v1');
  const urls = [`courses/${course.id}/course.json`,
    ...course.holes.filter((h) => h.image).map((h) => `courses/${course.id}/${h.image.file}`)];
  let done = 0;
  for (const u of urls) {
    if (!(await cache.match(u))) {
      try { await cache.add(u); } catch (e) { /* keep going; it loads online later */ }
    }
    onProgress(++done, urls.length);
  }
}
