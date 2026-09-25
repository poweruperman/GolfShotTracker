/*
 * GPS helpers: distance math and "best of a few seconds" position sampling.
 * Units: coordinates in decimal degrees, distances in meters.
 */

export const M_TO_YD = 1.0936133; // 1 meter = 1.0936133 yards

// ---- Settings to tune after the Phase 0 outdoor test -----------------------
export const SAMPLE_MS = 5000;     // how long to listen to the GPS on each press
export const MAX_WAIT_MS = 30000;  // give up if no fix at all after this long
export const GOOD_ACCURACY_M = 5;  // green badge at or below this
export const FLAG_ACCURACY_M = 10; // flagged above this

// Great-circle distance between two lat/lon points, in meters.
// Haversine is accurate to well under a centimeter at golf distances.
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8; // mean Earth radius in meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const toYd = (m) => m * M_TO_YD;

export function accuracyClass(acc) {
  if (acc == null) return 'bad';
  if (acc <= GOOD_ACCURACY_M) return 'good';
  if (acc <= FLAG_ACCURACY_M) return 'ok';
  return 'bad';
}

/*
 * Listen to the GPS for SAMPLE_MS and resolve with the most accurate fix.
 * Why not getCurrentPosition()? The first fix after the GPS wakes up is
 * often the worst one. Watching for a few seconds lets the receiver settle.
 * If no fix has arrived when time is up (cold start), keep waiting for the
 * first one, up to MAX_WAIT_MS.
 *
 * onUpdate(bestAccuracyM, fixCount, elapsedMs) is called on every fix so the
 * screen can show progress.
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
        // Permission denied will not fix itself by waiting, so stop now.
        if (err.code === err.PERMISSION_DENIED) finish();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS }
    );

    const softStop = setTimeout(() => {
      timeUp = true;
      if (best) finish();
    }, SAMPLE_MS);
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
