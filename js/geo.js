/*
 * GPS and map math. No screen code here, so it can be unit-tested.
 * Units: coordinates in decimal degrees, distances in meters.
 */

export const M_TO_YD = 1.0936133;
export const M_TO_FT = 3.2808399;
export const toYd = (m) => m * M_TO_YD;

// ---- Settings to tune after the outdoor GPS test --------------------------------
export const SAMPLE_MS = 4000;     // how long to listen to the GPS when recording a shot
export const MAX_WAIT_MS = 30000;  // give up if no fix at all after this long
export const FLAG_ACCURACY_M = 10; // readings worse than this are flagged

// Great-circle distance in meters (accurate to well under a centimeter at golf distances).
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const distM = (a, b) => haversineM(a[0], a[1], b[0], b[1]);

// ---- Web Mercator: how map tiles (and our hole images) are laid out -------------

export function mercPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function mercToLatLon(x, y, z) {
  const n = 256 * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lat, lon];
}

/*
 * Each hole image comes with an affine transform m = [a, b, c, d, e, f] from
 * Mercator pixels (X, Y) at zoom z to image pixels (u, v):
 *   u = a*X + b*Y + c,  v = d*X + e*Y + f
 * (made by tools/build_courses.py). These two functions use it both ways.
 */
export function latLonToImage(img, lat, lon) {
  const [X, Y] = mercPx(lat, lon, img.z);
  const [a, b, c, d, e, f] = img.m;
  return [a * X + b * Y + c, d * X + e * Y + f];
}

export function imageToLatLon(img, u, v) {
  const [a, b, c, d, e, f] = img.m;
  const det = a * e - b * d;
  const X = (e * (u - c) - b * (v - f)) / det;
  const Y = (-d * (u - c) + a * (v - f)) / det;
  return mercToLatLon(X, Y, img.z);
}

// ---- Flat geometry around a point (fine over a golf course) ----------------------

// East/north meters of `p` from origin `o` (both [lat, lon]).
export function localXY(o, p) {
  // Same sphere as haversineM, so flat and great-circle distances agree.
  const k = 111194.93; // meters per degree of latitude
  return [(p[1] - o[1]) * k * Math.cos((o[0] * Math.PI) / 180), (p[0] - o[0]) * k];
}

export function pointInPolygon(p, poly) {
  // poly: [[lat, lon], ...]; ray casting in lat/lon is fine at this scale
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/*
 * Front and back of the green as seen from `from`: walk the line from the
 * player through the green's center and find where it enters and leaves the
 * green outline. Returns distances in meters { front, center, back }.
 */
export function greenDistances(from, green, center) {
  const c = distM(from, center);
  if (!green || green.length < 3) return { front: null, center: c, back: null };
  const [cx, cy] = localXY(from, center);
  const len = Math.hypot(cx, cy) || 1;
  const ux = cx / len;
  const uy = cy / len;
  let front = Infinity;
  let back = -Infinity;
  const pts = green.map((p) => localXY(from, p));
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    // Intersect the ray t*(ux,uy) with segment p1->p2.
    const dx = x2 - x1;
    const dy = y2 - y1;
    const den = ux * dy - uy * dx;
    if (Math.abs(den) < 1e-9) continue;
    const t = (x1 * dy - y1 * dx) / den;
    const s = (x1 * uy - y1 * ux) / den;
    if (s >= 0 && s <= 1 && t > 0) {
      front = Math.min(front, t);
      back = Math.max(back, t);
    }
  }
  if (!Number.isFinite(front)) return { front: null, center: c, back: null };
  return { front, center: c, back };
}

// Signed sideways offset of p from the line a->b in meters (+ = right of the line).
export function sideOffset(a, b, p) {
  const [bx, by] = localXY(a, b);
  const [px, py] = localXY(a, p);
  const len = Math.hypot(bx, by) || 1;
  return (bx * py - by * px) / -len;
}

// ---- GPS sampling ------------------------------------------------------------------

/*
 * Listen to the GPS for SAMPLE_MS and keep the most accurate fix. The first
 * fix after the GPS wakes up is often the worst, so a few seconds of
 * listening gives better shot positions than a single reading.
 */
export function sampleBestPosition(onUpdate = () => {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser has no GPS access.'));
      return;
    }
    let best = null;
    let count = 0;
    let timeUp = false;
    let done = false;
    let lastError = null;
    const started = Date.now();
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        count++;
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        onUpdate(best.coords.accuracy, count, Date.now() - started);
        if (timeUp) finish();
      },
      (err) => {
        lastError = err;
        if (err.code === err.PERMISSION_DENIED) finish();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS }
    );
    const softStop = setTimeout(() => { timeUp = true; if (best) finish(); }, SAMPLE_MS);
    const hardStop = setTimeout(finish, MAX_WAIT_MS);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(softStop);
      clearTimeout(hardStop);
      navigator.geolocation.clearWatch(watchId);
      if (best) {
        resolve({
          lat: best.coords.latitude,
          lon: best.coords.longitude,
          accuracy_m: Math.round(best.coords.accuracy * 10) / 10,
          samples: count,
          recorded_at: new Date(best.timestamp).toISOString(),
        });
      } else {
        reject(lastError || new Error('No GPS fix received.'));
      }
    }
  });
}

export function geoErrorText(err) {
  if (!err || typeof err.code !== 'number') return err ? err.message : 'Unknown GPS error';
  switch (err.code) {
    case 1: return 'Location permission denied. Allow location for this app and try again.';
    case 2: return 'Position unavailable. Move into open sky and try again.';
    case 3: return 'GPS timed out. Move into open sky and try again.';
    default: return err.message;
  }
}
