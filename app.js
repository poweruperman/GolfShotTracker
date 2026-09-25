/*
 * Golf GPS Spike (Phase 0)
 * ------------------------
 * One button that records the phone's GPS position.
 * On each press it listens to the GPS for a few seconds and keeps the
 * reading with the best (smallest) reported accuracy.
 *
 * Units: coordinates in decimal degrees, distances stored in meters,
 * yards shown alongside for golf use.
 */
'use strict';

// ---- Settings you may want to tune after field testing -------------------
const SAMPLE_MS = 5000;        // how long to listen to the GPS on each press
const MAX_WAIT_MS = 30000;     // give up if no fix at all after this long
const GOOD_ACCURACY_M = 5;     // green badge at or below this
const FLAG_ACCURACY_M = 10;    // red badge (flagged) above this
const COARSE_HINT_M = 500;     // above this, "Precise Location" is probably off

const M_TO_YD = 1.0936133;     // 1 meter = 1.0936133 yards
const STORAGE_KEY = 'gpsSpike.readings.v1';
const TEST_KEY = 'gpsSpike.testNo.v1';

// ---- State ---------------------------------------------------------------
let readings = loadReadings();       // array of reading objects, oldest first
let testNo = loadTestNo();           // groups readings taken at the same spot
let sampling = false;                // true while a press is in progress
let wakeLock = null;                 // the Screen Wake Lock handle, if held
let wantWakeLock = false;            // what David chose with the toggle

const $ = (id) => document.getElementById(id);

// ---- Storage (phone only in Phase 0; export is the backup) -----------------
function loadReadings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function loadTestNo() {
  const n = parseInt(localStorage.getItem(TEST_KEY), 10);
  return Number.isFinite(n) ? n : 1;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readings));
    localStorage.setItem(TEST_KEY, String(testNo));
  } catch (e) {
    showMessage('Could not save on this phone. Export now so nothing is lost.', true);
  }
}

// ---- Geometry --------------------------------------------------------------

// Great-circle distance between two lat/lon points, in meters.
// Haversine is accurate to well under a centimeter at golf distances.
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8; // mean Earth radius in meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const fmtM = (m) => `${m.toFixed(1)} m (${(m * M_TO_YD).toFixed(1)} yd)`;

function accuracyClass(acc) {
  if (acc <= GOOD_ACCURACY_M) return 'good';
  if (acc <= FLAG_ACCURACY_M) return 'ok';
  return 'bad';
}

// ---- GPS sampling ----------------------------------------------------------

/*
 * Listen to the GPS for SAMPLE_MS and resolve with the most accurate fix.
 * Why not just getCurrentPosition()? The first fix after waking the GPS is
 * often the worst one. Watching for a few seconds lets the receiver settle.
 * If no fix has arrived when time is up (cold start), keep waiting for the
 * first one, up to MAX_WAIT_MS.
 */
function sampleBestPosition(onUpdate) {
  return new Promise((resolve, reject) => {
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
        onUpdate(best, count, Date.now() - started);
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
      if (best) resolve({ position: best, count });
      else reject(lastError || new Error('No GPS fix received.'));
    }
  });
}

function geoErrorText(err) {
  if (!err || typeof err.code !== 'number') return err ? err.message : 'Unknown error';
  switch (err.code) {
    case 1: return 'Location permission denied. Allow location for this app and try again.';
    case 2: return 'Position unavailable. Move into open sky and try again.';
    case 3: return 'GPS timed out. Move into open sky and try again.';
    default: return err.message;
  }
}

async function onRecord() {
  if (sampling) return;
  if (!('geolocation' in navigator)) {
    showMessage('This browser has no GPS access.', true);
    return;
  }
  if (!window.isSecureContext) {
    showMessage('GPS needs HTTPS. Open the app from its https:// link.', true);
    return;
  }

  // A button tap is a user gesture, which is a good moment to (re)take the wake lock.
  if (wantWakeLock) requestWakeLock();

  sampling = true;
  setBusy(true);
  showMessage('');

  try {
    const { position, count } = await sampleBestPosition((best, n, elapsed) => {
      const pct = Math.min(100, (elapsed / SAMPLE_MS) * 100);
      $('progressFill').style.width = pct + '%';
      $('progressText').textContent =
        `Sampling… ${n} fix${n === 1 ? '' : 'es'}, best ${best.coords.accuracy.toFixed(1)} m`;
    });

    const c = position.coords;
    const prev = readings[readings.length - 1];
    const reading = {
      id: Date.now(),
      test_no: testNo,
      label: $('label').value.trim(),
      lat: c.latitude,
      lon: c.longitude,
      accuracy_m: Math.round(c.accuracy * 10) / 10,
      samples: count,
      recorded_at: new Date(position.timestamp).toISOString(),
      // distance from the previous reading (any test), in meters
      dist_from_prev_m: prev ? haversineM(prev.lat, prev.lon, c.latitude, c.longitude) : null,
    };
    readings.push(reading);
    save();

    if (c.accuracy > COARSE_HINT_M) {
      showMessage('Accuracy is very poor. "Precise Location" may be turned off for Safari Websites in iPhone Settings.', true);
    } else if (c.accuracy > FLAG_ACCURACY_M) {
      showMessage(`Flagged: accuracy worse than ${FLAG_ACCURACY_M} m. Try again in open sky.`, true);
    } else {
      showMessage('Saved.');
    }
  } catch (err) {
    showMessage(geoErrorText(err), true);
  } finally {
    sampling = false;
    setBusy(false);
    render();
  }
}

// ---- Screen Wake Lock --------------------------------------------------------
// Keeps the screen on. The OS releases it whenever the app goes to the
// background, so we take it again when the app becomes visible.

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    $('wakeBtn').textContent = 'Keep screen on: not supported';
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', updateWakeButton);
  } catch (e) {
    // Can be refused in Low Power Mode or when the app is not visible.
    showMessage('Screen could not be kept on (Low Power Mode?).', true);
  }
  updateWakeButton();
}

async function toggleWakeLock() {
  wantWakeLock = !wantWakeLock;
  if (wantWakeLock) {
    await requestWakeLock();
  } else if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
  updateWakeButton();
}

function updateWakeButton() {
  const on = wakeLock && !wakeLock.released;
  $('wakeBtn').textContent = `Keep screen on: ${on ? 'ON' : 'off'}`;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) requestWakeLock();
});

// ---- Other controls ----------------------------------------------------------

function newTest() {
  testNo++;
  save();
  $('label').value = '';
  showMessage(`Started test ${testNo}. Readings from here on are compared with each other.`);
  render();
}

function undoLast() {
  if (!readings.length) return;
  const last = readings[readings.length - 1];
  if (!confirm(`Delete reading from ${new Date(last.recorded_at).toLocaleTimeString()}?`)) return;
  readings.pop();
  save();
  render();
}

function clearAll() {
  if (!readings.length) return;
  if (!confirm('Delete ALL readings on this phone? Export first if you want to keep them.')) return;
  readings = [];
  testNo = 1;
  save();
  render();
}

// ---- Export ------------------------------------------------------------------

function toCsv() {
  const cols = ['id', 'test_no', 'label', 'lat', 'lon', 'accuracy_m', 'samples',
    'recorded_at', 'dist_from_prev_m', 'dist_from_prev_yd'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = readings.map((r) => cols.map((c) => {
    if (c === 'dist_from_prev_m') return r.dist_from_prev_m == null ? '' : r.dist_from_prev_m.toFixed(2);
    if (c === 'dist_from_prev_yd') return r.dist_from_prev_m == null ? '' : (r.dist_from_prev_m * M_TO_YD).toFixed(2);
    return esc(r[c]);
  }).join(','));
  return [cols.join(','), ...rows].join('\n');
}

/*
 * On iPhone the share sheet is the reliable way to get a file out of a
 * home-screen app ("Save to Files", Mail, AirDrop). Fall back to a normal
 * download link where sharing files is not supported.
 */
async function saveFile(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // David closed the share sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

// ---- Rendering ---------------------------------------------------------------

function currentTestStats() {
  const set = readings.filter((r) => r.test_no === testNo);
  if (!set.length) return null;

  // Simple average of lat/lon is fine over a few meters.
  const meanLat = set.reduce((s, r) => s + r.lat, 0) / set.length;
  const meanLon = set.reduce((s, r) => s + r.lon, 0) / set.length;
  const avgAcc = set.reduce((s, r) => s + r.accuracy_m, 0) / set.length;

  let maxFromMean = 0;
  for (const r of set) {
    maxFromMean = Math.max(maxFromMean, haversineM(meanLat, meanLon, r.lat, r.lon));
  }
  let spread = 0;
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      spread = Math.max(spread, haversineM(set[i].lat, set[i].lon, set[j].lat, set[j].lon));
    }
  }
  return { count: set.length, avgAcc, maxFromMean, spread };
}

function render() {
  $('testNo').textContent = `#${testNo}`;

  // Last reading card
  const last = readings[readings.length - 1];
  $('lastCard').hidden = !last;
  if (last) {
    const badge = $('lastAccuracy');
    badge.textContent = `±${last.accuracy_m.toFixed(1)} m` +
      (last.accuracy_m > FLAG_ACCURACY_M ? ' ⚑ flagged' : '');
    badge.className = `badge ${accuracyClass(last.accuracy_m)}`;
    $('lastSamples').textContent = `${last.samples} fixes`;
    $('lastFromPrev').textContent = last.dist_from_prev_m == null ? '–' : fmtM(last.dist_from_prev_m);
    $('lastTime').textContent = new Date(last.recorded_at).toLocaleTimeString();
  }

  // Current test stats
  const st = currentTestStats();
  $('statCount').textContent = st ? st.count : 0;
  $('statAvgAcc').textContent = st ? `±${st.avgAcc.toFixed(1)} m` : '–';
  $('statMaxFromMean').textContent = st && st.count > 1 ? fmtM(st.maxFromMean) : '–';
  $('statSpread').textContent = st && st.count > 1 ? fmtM(st.spread) : '–';

  // Full list, newest first
  const list = $('list');
  list.innerHTML = '';
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="badge ${accuracyClass(r.accuracy_m)}">±${r.accuracy_m.toFixed(1)} m</span> ` +
      `Test ${r.test_no}${r.label ? ' · ' + escapeHtml(r.label) : ''}` +
      `<div class="meta">${new Date(r.recorded_at).toLocaleTimeString()} · ` +
      `${r.lat.toFixed(6)}, ${r.lon.toFixed(6)} · ${r.samples} fixes` +
      (r.dist_from_prev_m == null ? '' : ` · ${fmtM(r.dist_from_prev_m)} from previous`) +
      `</div>`;
    list.appendChild(li);
  }

  $('undoBtn').disabled = !readings.length;
  $('clearBtn').disabled = !readings.length;
  $('exportCsvBtn').disabled = !readings.length;
  $('exportJsonBtn').disabled = !readings.length;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function setBusy(busy) {
  $('recordBtn').disabled = busy;
  $('recordBtn').textContent = busy ? 'Hold still…' : 'Record position';
  $('progress').hidden = !busy;
  if (busy) $('progressFill').style.width = '0%';
}

function showMessage(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.className = 'message' + (isError ? ' error' : '');
}

// ---- Startup -----------------------------------------------------------------

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function init() {
  $('appMode').textContent = isInstalled() ? 'installed app' : 'in browser';
  $('installHint').hidden = isInstalled();

  $('recordBtn').addEventListener('click', onRecord);
  $('newTestBtn').addEventListener('click', newTest);
  $('undoBtn').addEventListener('click', undoLast);
  $('wakeBtn').addEventListener('click', toggleWakeLock);
  $('clearBtn').addEventListener('click', clearAll);
  $('exportCsvBtn').addEventListener('click', () =>
    saveFile(`gps-spike-${stamp()}.csv`, toCsv(), 'text/csv'));
  $('exportJsonBtn').addEventListener('click', () =>
    saveFile(`gps-spike-${stamp()}.json`, JSON.stringify(readings, null, 2), 'application/json'));

  // Ask the browser not to evict our data under storage pressure.
  // iOS may ignore this, which is why export exists.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // The service worker caches the app so it opens with weak or no signal.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  render();
}

init();
