/*
 * Golf Shot Tracker (Phase 1): the screen logic.
 *
 * Flow on the course:
 *   1. Stand at the ball, tap the club you're about to hit. The app samples
 *      the GPS for a few seconds and saves the shot with its position.
 *   2. The previous shot's distance is filled in automatically: it's the
 *      distance from where it was tapped to where this one was tapped.
 *   3. On the green, tap Putt +. The first putt also records the ball's
 *      position, which gives the approach shot its distance.
 *   4. Finish hole moves on to the next hole.
 *
 * The data rules live in round.js; storage in store.js; the map in map.js.
 */

import { sampleBestPosition, geoErrorText, accuracyClass, toYd, FLAG_ACCURACY_M, SAMPLE_MS } from './geo.js';
import {
  DEFAULT_BAG, HOLES, newRound, hole, shotsOnHole, addShot, editShot, deleteShot, findShot,
  setHoleEnd, addPutt, removePutt, holeSummary, finishHole, totalStrokes, shotsToCsv,
  nextHoleNo, prevHoleNo, finishedHoleCount,
} from './round.js';
import { load, save, activeRound, saveFile } from './store.js';
import { createMap, refreshSize, centerOn, showMe, drawHole } from './map.js';

const $ = (id) => document.getElementById(id);

let state = load();
let busy = false;          // true while the GPS is being sampled
let mapReady = false;
let editingShotId = null;
let wakeLock = null;
let wantWakeLock = false;

const fmtYd = (m) => `${Math.round(toYd(m))} yd`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function persist() {
  if (!save(state)) showStatus('Could not save on this phone. Export now so nothing is lost.', true);
}

// ---- Status line -------------------------------------------------------------

function showStatus(html, isError = false) {
  $('statusText').innerHTML = html;
  $('status').classList.toggle('error', isError);
}

function setBusy(on, label = '') {
  busy = on;
  document.querySelectorAll('#clubGrid button, #puttPlusBtn, #finishHoleBtn')
    .forEach((b) => { b.disabled = on; });
  $('progress').hidden = !on;
  if (on) {
    $('progressFill').style.width = '0%';
    showStatus(`<strong>Hold still…</strong> ${label}`);
  }
}

// Sample the GPS with a progress bar. Resolves to a position, or null on failure
// (with the reason shown on screen).
async function takeReading(label) {
  setBusy(true, label);
  try {
    return await sampleBestPosition((bestAcc, n, elapsed) => {
      $('progressFill').style.width = Math.min(100, (elapsed / SAMPLE_MS) * 100) + '%';
      showStatus(`<strong>Hold still…</strong> ${label} · ${n} fix${n === 1 ? '' : 'es'}, best ±${bestAcc.toFixed(1)} m`);
    });
  } catch (err) {
    showStatus(geoErrorText(err), true);
    return null;
  } finally {
    setBusy(false);
  }
}

function accuracyNote(pos) {
  const cls = accuracyClass(pos.accuracy_m);
  const flag = pos.accuracy_m > FLAG_ACCURACY_M ? ' ⚑ poor GPS' : '';
  return `<span class="badge ${cls}">±${pos.accuracy_m.toFixed(1)} m${flag}</span>`;
}

// ---- Actions ---------------------------------------------------------------------

async function onClub(club) {
  const round = activeRound(state);
  if (busy || !round) return;
  if (wantWakeLock) requestWakeLock(); // a tap is a good moment to re-take it

  const pos = await takeReading(`recording ${club}`);
  if (!pos) {
    // Keep the stroke for the score even when the GPS fails.
    if (!confirm(`No GPS position. Record the ${club} shot anyway?\n(It counts for your score but gets no distance.)`)) return;
  }
  const shot = addShot(round, { club, pos });
  persist();

  const prev = shotsOnHole(round, shot.hole_no).find((s) => s.shot_no === shot.shot_no - 1);
  let msg = `Shot ${shot.shot_no} · <strong>${club}</strong> saved ` + (pos ? accuracyNote(pos) : '(no GPS)');
  if (prev) {
    msg += `<br>Shot ${prev.shot_no} · ${prev.club}: <strong>${prev.distance_m == null ? 'no distance' : fmtYd(prev.distance_m)}</strong>`;
  }
  showStatus(msg, !!pos && pos.accuracy_m > FLAG_ACCURACY_M);
  if (pos) showMe(pos.lat, pos.lon);
  render();
}

// The last full shot's destination: ball on the green, or the cup on a chip-in.
async function recordHoleEnd(round, label) {
  const pos = await takeReading(label);
  if (!pos) return false;
  setHoleEnd(round, round.current_hole, pos);
  showMe(pos.lat, pos.lon);
  return pos;
}

async function onPuttPlus() {
  const round = activeRound(state);
  if (busy || !round) return;
  const h = hole(round, round.current_hole);
  const needsEnd = h.putts === 0 && !h.end && shotsOnHole(round, round.current_hole).length > 0;

  let msg = '';
  if (needsEnd) {
    const pos = await recordHoleEnd(round, 'marking the ball on the green');
    const last = shotsOnHole(round, round.current_hole).slice(-1)[0];
    msg = pos
      ? `Ball on green ${accuracyNote(pos)}<br>Shot ${last.shot_no} · ${last.club}: <strong>${last.distance_m == null ? 'no distance' : fmtYd(last.distance_m)}</strong>`
      : 'Putt counted. The ball position was not recorded, so the last shot has no distance.';
  }
  addPutt(round, round.current_hole);
  persist();
  render();
  if (msg) showStatus(msg, msg.startsWith('Putt counted'));
}

function onPuttMinus() {
  const round = activeRound(state);
  if (busy || !round) return;
  removePutt(round, round.current_hole);
  persist();
  render();
}

async function onFinishHole() {
  const round = activeRound(state);
  if (busy || !round) return;
  const n = round.current_hole;
  const sum = holeSummary(round, n);
  const h = hole(round, n);

  if (sum.strokes === 0 && !confirm(`Nothing recorded on hole ${n}. Skip to hole ${nextHoleNo(n)}?`)) return;

  // Holed out from off the green (no putts): offer to record the cup so the
  // last shot gets a distance.
  if (sum.shots > 0 && sum.putts === 0 && !h.end) {
    if (confirm('No putts on this hole. Did you hole out from off the green?\n\n' +
      'OK: stand at the cup and record it (gives the last shot a distance).\n' +
      'Cancel: finish without it.')) {
      await recordHoleEnd(round, 'recording the cup');
    }
  }

  finishHole(round);
  persist();
  render();
  showStatus(`Hole ${n} done: <strong>${sum.strokes}</strong> strokes (${sum.putts} putt${sum.putts === 1 ? '' : 's'}). ` +
    `Now on hole ${round.current_hole}.`);

  if (finishedHoleCount(round) >= HOLES && confirm('That was your 18th hole. End the round?')) endRound();
}

function changeHole(step) {
  const round = activeRound(state);
  if (busy || !round) return;
  round.current_hole = step > 0 ? nextHoleNo(round.current_hole) : prevHoleNo(round.current_hole);
  persist();
  render();
  showStatus(`Now on hole ${round.current_hole}. New shots go on this hole.`);
}

function startRound() {
  const round = newRound({ course: $('courseInput').value, startHole: Number($('startHoleInput').value) });
  state.rounds.push(round);
  state.active_round_id = round.id;
  persist();
  wantWakeLock = true;
  requestWakeLock();
  render();
  locateOnce();
}

function endRound() {
  const round = activeRound(state);
  if (!round) return;
  round.finished_at = new Date().toISOString();
  state.active_round_id = null;
  persist();
  $('menuDialog').close();
  releaseWakeLock();
  render();
  if (confirm('Round saved on this phone. Export a backup copy now (CSV)?')) exportRound(round, 'csv');
}

// Center the map on the player before the first shot, so the hole is visible.
// A quick, low-power fix is fine here; it isn't used for any distance.
function locateOnce() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (p) => { centerOn(p.coords.latitude, p.coords.longitude, 17); showMe(p.coords.latitude, p.coords.longitude); },
    () => { /* no position: the map just stays where it is */ },
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
  );
}

// ---- Shot list and editing ---------------------------------------------------------

function openShotList() {
  const round = activeRound(state);
  if (!round) return;
  const box = $('shotList');
  box.innerHTML = '';
  const holeNos = [...new Set([...round.shots.map((s) => s.hole_no),
    ...Object.keys(round.holes).map(Number)])];
  // Show holes in playing order, starting from the round's first hole.
  const firstHole = round.shots.length ? round.shots.reduce((a, b) => (a.recorded_at < b.recorded_at ? a : b)).hole_no : 1;
  holeNos.sort((a, b) => ((a - firstHole + HOLES) % HOLES) - ((b - firstHole + HOLES) % HOLES));

  if (!holeNos.length) box.innerHTML = '<p class="small">No shots yet.</p>';
  for (const n of holeNos) {
    const sum = holeSummary(round, n);
    const div = document.createElement('div');
    div.className = 'hole-group';
    div.innerHTML = `<h3>Hole ${n} <span class="small">· ${sum.strokes} strokes · ${sum.putts} putt${sum.putts === 1 ? '' : 's'}</span></h3>`;
    const ol = document.createElement('ol');
    ol.className = 'plain';
    for (const s of shotsOnHole(round, n)) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="shot-row${s.exclude_from_stats ? ' excluded' : ''}">
        <span class="shot-no">${s.shot_no}</span>
        <span class="shot-club">${escapeHtml(s.club)}</span>
        <span class="shot-dist">${s.distance_m == null ? '–' : fmtYd(s.distance_m)}</span>
        <span class="shot-meta">${s.accuracy_m == null ? 'no GPS' : '±' + s.accuracy_m.toFixed(0) + ' m'} · ${fmtTime(s.recorded_at)}${s.exclude_from_stats ? ' · excluded' : ''}</span>
      </button>`;
      li.querySelector('button').addEventListener('click', () => openEditShot(s.id));
      ol.appendChild(li);
    }
    div.appendChild(ol);
    box.appendChild(div);
  }
  $('shotListDialog').showModal();
}

function fillSelect(sel, values, selected) {
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (String(v) === String(selected)) o.selected = true;
    sel.appendChild(o);
  }
}

function openEditShot(shotId) {
  const round = activeRound(state);
  const s = round && findShot(round, shotId);
  if (!s) return;
  editingShotId = shotId;
  $('editTitle').textContent = `Hole ${s.hole_no}, shot ${s.shot_no}`;
  $('editInfo').textContent = `${new Date(s.recorded_at).toLocaleString()} · ` +
    (s.accuracy_m == null ? 'no GPS' : `±${s.accuracy_m.toFixed(1)} m`) +
    ` · ${s.distance_m == null ? 'no distance' : fmtYd(s.distance_m)}`;
  const clubs = state.bag.includes(s.club) ? state.bag : [...state.bag, s.club];
  fillSelect($('editClub'), clubs, s.club);
  fillSelect($('editHole'), Array.from({ length: HOLES }, (_, i) => i + 1), s.hole_no);
  $('editExclude').checked = s.exclude_from_stats;
  $('editShotDialog').showModal();
}

function saveEditShot() {
  const round = activeRound(state);
  if (!round || !editingShotId) return;
  editShot(round, editingShotId, {
    club: $('editClub').value,
    hole_no: Number($('editHole').value),
    exclude_from_stats: $('editExclude').checked,
  });
  persist();
  $('editShotDialog').close();
  render();
  openShotList(); // refresh the list behind it
}

function deleteEditShot() {
  const round = activeRound(state);
  if (!round || !editingShotId) return;
  if (!confirm('Delete this shot? The shot before it will be re-measured to the next one.')) return;
  deleteShot(round, editingShotId);
  persist();
  $('editShotDialog').close();
  render();
  openShotList();
}

// ---- Bag -------------------------------------------------------------------------

function openBag() {
  $('menuDialog').close();
  $('bagText').value = state.bag.join('\n');
  $('bagDialog').showModal();
}

function saveBag() {
  const clubs = $('bagText').value.split('\n').map((c) => c.trim()).filter(Boolean);
  if (!clubs.length) { alert('Add at least one club.'); return; }
  state.bag = [...new Set(clubs)];
  persist();
  $('bagDialog').close();
  render();
}

// ---- Export ------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

function exportRound(round, kind) {
  const name = `round-${round.date}-${round.id}`;
  if (kind === 'csv') saveFile(`${name}.csv`, shotsToCsv([round]), 'text/csv');
  else saveFile(`${name}.json`, JSON.stringify(round, null, 2), 'application/json');
}

function exportAll(kind) {
  if (kind === 'csv') saveFile(`golf-shots-${stamp()}.csv`, shotsToCsv(state.rounds), 'text/csv');
  else saveFile(`golf-data-${stamp()}.json`, JSON.stringify(state, null, 2), 'application/json');
}

// ---- Screen Wake Lock ----------------------------------------------------------------
// Keeps the screen on so iOS doesn't pause the app. The OS drops the lock
// whenever the app goes to the background, so it's re-taken on return.

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) { updateWakeButton(); return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', updateWakeButton);
  } catch (e) {
    // Can be refused in Low Power Mode or when the app is not visible.
  }
  updateWakeButton();
}

async function releaseWakeLock() {
  wantWakeLock = false;
  if (wakeLock) { try { await wakeLock.release(); } catch (e) { /* already gone */ } }
  wakeLock = null;
  updateWakeButton();
}

function toggleWakeLock() {
  if (wantWakeLock) releaseWakeLock();
  else { wantWakeLock = true; requestWakeLock(); }
}

function updateWakeButton() {
  const on = wakeLock && !wakeLock.released;
  $('wakeBtn').textContent = !('wakeLock' in navigator)
    ? 'Keep screen on: not supported'
    : `Keep screen on: ${on ? 'ON' : 'off'}`;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) requestWakeLock();
});

// ---- Rendering --------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderStart() {
  const ol = $('pastRounds');
  ol.innerHTML = '';
  const rounds = [...state.rounds].reverse();
  if (!rounds.length) ol.innerHTML = '<li class="small">No rounds yet.</li>';
  for (const r of rounds) {
    const li = document.createElement('li');
    li.innerHTML = `<button class="round-row"><strong>${r.date}</strong> ${escapeHtml(r.course || 'Unnamed course')}
      <span class="small">· ${totalStrokes(r)} strokes · ${r.shots.length} shots</span></button>`;
    li.querySelector('button').addEventListener('click', () => {
      if (!confirm(`Reopen the ${r.date} round to view or edit it?`)) return;
      state.active_round_id = r.id;
      persist();
      render();
    });
    ol.appendChild(li);
  }
  $('exportAllCsvBtn').disabled = !state.rounds.length;
  $('exportAllJsonBtn').disabled = !state.rounds.length;
}

function renderClubs() {
  const grid = $('clubGrid');
  if (grid.dataset.bag === state.bag.join('|')) return; // unchanged
  grid.dataset.bag = state.bag.join('|');
  grid.innerHTML = '';
  for (const club of state.bag) {
    const b = document.createElement('button');
    b.className = 'club';
    b.textContent = club;
    b.addEventListener('click', () => onClub(club));
    grid.appendChild(b);
  }
}

function renderRound(round) {
  const n = round.current_hole;
  const sum = holeSummary(round, n);
  $('courseName').textContent = round.course || 'Round';
  $('roundTotal').textContent = `${round.date} · ${totalStrokes(round)} strokes so far`;
  $('holeNo').textContent = n;
  $('holeSummary').textContent =
    `${sum.shots} shot${sum.shots === 1 ? '' : 's'} + ${sum.putts} putt${sum.putts === 1 ? '' : 's'} = ${sum.strokes}` +
    (sum.finished ? ' · finished' : '');
  $('puttCount').textContent = sum.putts;
  renderClubs();

  if (!mapReady) {
    createMap('map');
    mapReady = true;
  }
  refreshSize();
  const h = round.holes[String(n)];
  drawHole(shotsOnHole(round, n), h ? h.end : null, fmtYd);
}

function render() {
  const round = activeRound(state);
  $('startScreen').hidden = !!round;
  $('roundScreen').hidden = !round;
  if (round) renderRound(round);
  else renderStart();
}

// ---- Startup ------------------------------------------------------------------------------

function init() {
  fillSelect($('startHoleInput'), Array.from({ length: HOLES }, (_, i) => i + 1), 1);

  $('startBtn').addEventListener('click', startRound);
  $('prevHoleBtn').addEventListener('click', () => changeHole(-1));
  $('nextHoleBtn').addEventListener('click', () => changeHole(1));
  $('puttPlusBtn').addEventListener('click', onPuttPlus);
  $('puttMinusBtn').addEventListener('click', onPuttMinus);
  $('finishHoleBtn').addEventListener('click', onFinishHole);
  $('shotListBtn').addEventListener('click', openShotList);
  $('editSaveBtn').addEventListener('click', saveEditShot);
  $('editCancelBtn').addEventListener('click', () => $('editShotDialog').close());
  $('editDeleteBtn').addEventListener('click', deleteEditShot);
  $('menuBtn').addEventListener('click', () => { updateWakeButton(); $('menuDialog').showModal(); });
  $('wakeBtn').addEventListener('click', toggleWakeLock);
  $('exportCsvBtn').addEventListener('click', () => exportRound(activeRound(state), 'csv'));
  $('exportJsonBtn').addEventListener('click', () => exportRound(activeRound(state), 'json'));
  $('endRoundBtn').addEventListener('click', () => { if (confirm('End this round?')) endRound(); });
  $('bagBtn').addEventListener('click', openBag);
  $('menuBagBtn').addEventListener('click', openBag);
  $('bagSaveBtn').addEventListener('click', saveBag);
  $('bagResetBtn').addEventListener('click', () => { $('bagText').value = DEFAULT_BAG.join('\n'); });
  $('exportAllCsvBtn').addEventListener('click', () => exportAll('csv'));
  $('exportAllJsonBtn').addEventListener('click', () => exportAll('json'));

  // Ask the browser not to evict our data under storage pressure.
  // iOS may ignore this, which is why export exists.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // The service worker caches the app so it opens with weak or no signal.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  // Reopened mid-round: keep the screen on again from the next tap.
  wantWakeLock = !!activeRound(state);

  render();
  // Reopened mid-round (e.g. after iOS closed the app): center on the player
  // if the current hole has no shots yet to fit the map to.
  const round = activeRound(state);
  if (round && !shotsOnHole(round, round.current_hole).some((s) => s.lat != null)) locateOnce();
}

init();
