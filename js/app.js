/*
 * Golf Shot Tracker: the screen logic.
 *
 * Flow on the course:
 *   1. Stand at the ball, tap "Next shot", pick the club. The app samples the
 *      GPS for a few seconds and saves the shot with its position.
 *   2. The previous shot's distance is filled in automatically: it's the
 *      distance from where it was hit to where this one is hit.
 *   3. On the green, tap Putts +. The first putt also records the ball's
 *      position, which gives the approach shot its distance.
 *   4. "Finish hole" moves on to the next hole.
 *
 * Editing afterwards (the EDIT button): reorder shots, add a missed shot by
 * tapping the map, drag a shot to where it really was, change clubs.
 *
 * The data rules live in round.js; storage in store.js; the map in map.js.
 */

import { sampleBestPosition, geoErrorText, accuracyClass, toYd, FLAG_ACCURACY_M, SAMPLE_MS } from './geo.js';
import {
  DEFAULT_BAG, HOLES, newRound, hole, shotsOnHole, addShot, editShot, deleteShot, findShot,
  setHoleEnd, addPutt, removePutt, holeSummary, finishHole, totalStrokes, shotsToCsv,
  nextHoleNo, finishedHoleCount, moveShot, insertShot, setShotPosition,
  setPar, setFairway, setGir, scoreToPar, fmtToPar, toParWords,
} from './round.js';
import { load, save, activeRound, saveFile } from './store.js';
import { createMap, refreshSize, centerOn, showMe, drawHole, onMapTap } from './map.js';

const $ = (id) => document.getElementById(id);

let state = load();
let busy = false;           // true while the GPS is being sampled
let mapReady = false;
let editingShotId = null;   // shot open in the edit dialog
let clubPurpose = 'shot';   // what the club sheet is picking for: 'shot' or 'add'
let pendingAdd = null;      // {lat, lon} tapped for a missed shot
let movingShotId = null;    // shot being dragged on the map
let pendingMove = null;     // {lat, lon} where it was dropped
let bannerTimer = null;
let wakeLock = null;
let wantWakeLock = false;

const fmtYds = (m) => `${Math.round(toYd(m))} yds`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function persist() {
  if (!save(state)) showBanner('Could not save on this phone. Export now so nothing is lost.', { error: true, persist: true });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---- Banner (messages over the map) -------------------------------------------------

/*
 * opts.persist keeps it up until replaced; otherwise it hides after 7 s.
 * opts.actions shows Cancel/Done buttons: { onCancel, onDone } (Done optional).
 */
function showBanner(html, opts = {}) {
  clearTimeout(bannerTimer);
  $('bannerText').innerHTML = html;
  $('banner').classList.toggle('error', !!opts.error);
  $('banner').hidden = false;
  const acts = opts.actions;
  $('bannerActions').hidden = !acts;
  if (acts) {
    $('bannerDoneBtn').hidden = !acts.onDone;
    $('bannerCancelBtn').onclick = acts.onCancel;
    $('bannerDoneBtn').onclick = acts.onDone || null;
  }
  if (!opts.persist && !acts) bannerTimer = setTimeout(hideBanner, 7000);
}

function hideBanner() {
  clearTimeout(bannerTimer);
  $('banner').hidden = true;
  $('progress').hidden = true;
}

function setBusy(on, label = '') {
  busy = on;
  ['nextShotBtn', 'puttPlusBtn', 'finishHoleBtn', 'editBtn'].forEach((id) => { $(id).disabled = on; });
  $('progress').hidden = !on;
  if (on) {
    $('progressFill').style.width = '0%';
    showBanner(`<strong>Hold still…</strong> ${label}`, { persist: true });
  }
}

// Sample the GPS with a progress bar. Resolves to a position, or null on
// failure (with the reason shown on screen).
async function takeReading(label) {
  setBusy(true, label);
  try {
    const pos = await sampleBestPosition((bestAcc, n, elapsed) => {
      $('progressFill').style.width = Math.min(100, (elapsed / SAMPLE_MS) * 100) + '%';
      $('bannerText').innerHTML =
        `<strong>Hold still…</strong> ${label} · ${n} fix${n === 1 ? '' : 'es'}, best ±${bestAcc.toFixed(1)} m`;
    });
    setBusy(false);
    return pos;
  } catch (err) {
    setBusy(false);
    showBanner(geoErrorText(err), { error: true });
    return null;
  }
}

function accuracyNote(pos) {
  const flag = pos.accuracy_m > FLAG_ACCURACY_M ? ' ⚑ poor GPS' : '';
  return `<span class="badge ${accuracyClass(pos.accuracy_m)}">±${pos.accuracy_m.toFixed(1)} m${flag}</span>`;
}

// ---- Bottom sheets ---------------------------------------------------------------------

function openSheet(id) {
  closeSheets();
  $('sheetBackdrop').hidden = false;
  $(id).classList.add('open');
}

function closeSheets() {
  document.querySelectorAll('.sheet.open').forEach((el) => el.classList.remove('open'));
  $('sheetBackdrop').hidden = true;
}

function openClubSheet(purpose) {
  clubPurpose = purpose;
  $('clubSheetTitle').textContent = purpose === 'add' ? 'Missed shot: which club?' : 'Next shot';
  $('clubSheetHint').hidden = purpose === 'add';
  const grid = $('clubGrid');
  grid.innerHTML = '';
  for (const club of state.bag) {
    const b = document.createElement('button');
    b.textContent = club;
    b.addEventListener('click', () => onClubPicked(club));
    grid.appendChild(b);
  }
  openSheet('clubSheet');
}

function onClubPicked(club) {
  closeSheets();
  if (clubPurpose === 'add') addMissedShot(club);
  else recordShot(club);
}

// ---- Recording on the course -------------------------------------------------------------

async function recordShot(club) {
  const round = activeRound(state);
  if (busy || !round) return;
  if (wantWakeLock) requestWakeLock(); // a tap is a good moment to re-take it

  const pos = await takeReading(`recording ${escapeHtml(club)}`);
  if (!pos) {
    // Keep the stroke for the score even when the GPS fails.
    if (!confirm(`No GPS position. Record the ${club} shot anyway?\n(It counts for your score but gets no distance.)`)) return;
  }
  const shot = addShot(round, { club, pos });
  persist();

  const prev = shotsOnHole(round, shot.hole_no).find((s) => s.shot_no === shot.shot_no - 1);
  let msg = `Shot ${shot.shot_no} · <strong>${escapeHtml(club)}</strong> saved ` + (pos ? accuracyNote(pos) : '(no GPS)');
  if (prev) {
    msg += `<br>Shot ${prev.shot_no} · ${escapeHtml(prev.club)}: <strong>${prev.distance_m == null ? 'no distance' : fmtYds(prev.distance_m)}</strong>`;
  }
  if (pos) showMe(pos.lat, pos.lon);
  render();
  showBanner(msg, { error: !!pos && pos.accuracy_m > FLAG_ACCURACY_M });
}

// The last full shot's destination: ball on the green, or the cup on a chip-in.
async function recordHoleEnd(round, label) {
  const pos = await takeReading(label);
  if (!pos) return null;
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
  let error = false;
  if (needsEnd) {
    const pos = await recordHoleEnd(round, 'marking the ball on the green');
    const last = shotsOnHole(round, round.current_hole).slice(-1)[0];
    if (pos) {
      msg = `Ball on green ${accuracyNote(pos)}<br>Shot ${last.shot_no} · ${escapeHtml(last.club)}: ` +
        `<strong>${last.distance_m == null ? 'no distance' : fmtYds(last.distance_m)}</strong>`;
    } else {
      msg = 'Putt counted. The ball position was not recorded, so the last shot has no distance.';
      error = true;
    }
  }
  addPutt(round, round.current_hole);
  persist();
  render();
  if (msg) showBanner(msg, { error });
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
  const vsPar = sum.par ? ` (${toParWords(sum.strokes - sum.par)})` : '';
  showBanner(`Hole ${n}: <strong>${sum.strokes}</strong> strokes${vsPar}, ${plural(sum.putts, 'putt')}. Now on hole ${round.current_hole}.`);

  if (finishedHoleCount(round) >= HOLES && confirm('That was your 18th hole. End the round?')) endRound();
}

function goToHole(n) {
  const round = activeRound(state);
  if (busy || !round || movingShotId || pendingAdd) return;
  round.current_hole = n;
  persist();
  render();
}

// ---- Editing: shot list, reorder, add missed shot, move on map ------------------------------

function openEditSheet() {
  renderShotList();
  openSheet('editSheet');
}

function renderShotList() {
  const round = activeRound(state);
  if (!round) return;
  const n = round.current_hole;
  const shots = shotsOnHole(round, n);
  $('editSheetTitle').textContent = `Hole ${n} shots`;
  const ol = $('shotList');
  ol.innerHTML = '';
  if (!shots.length) ol.innerHTML = '<li class="small">No shots on this hole yet.</li>';
  shots.forEach((s, i) => {
    const notes = [
      s.accuracy_m == null ? (s.added_by_hand ? 'added by hand' : 'no GPS') : `±${s.accuracy_m.toFixed(0)} m`,
      fmtTime(s.recorded_at),
      s.moved_by_hand ? 'moved' : '',
      s.exclude_from_stats ? 'excluded' : '',
    ].filter(Boolean).join(' · ');
    const li = document.createElement('li');
    li.innerHTML = `
      <button class="shot-main${s.exclude_from_stats ? ' excluded' : ''}">
        <span class="shot-badge">${escapeHtml(s.club)}</span>
        <span><span class="shot-dist">${s.distance_m == null ? '–' : fmtYds(s.distance_m)}</span>
          <span class="shot-meta">Shot ${s.shot_no} · ${notes}</span></span>
      </button>
      <button class="order-btn up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="order-btn down" aria-label="Move down" ${i === shots.length - 1 ? 'disabled' : ''}>↓</button>`;
    li.querySelector('.shot-main').addEventListener('click', () => openEditShot(s.id));
    li.querySelector('.up').addEventListener('click', () => reorder(s.id, i - 1));
    li.querySelector('.down').addEventListener('click', () => reorder(s.id, i + 1));
    ol.appendChild(li);
  });
}

function reorder(shotId, newIndex) {
  moveShot(activeRound(state), shotId, newIndex);
  persist();
  render();
  renderShotList();
}

function startAddMissedShot() {
  closeSheets();
  showBanner('<strong>Add a missed shot:</strong> tap the map where that shot was hit.', {
    actions: { onCancel: endAddMissedShot },
  });
  onMapTap((lat, lon) => {
    pendingAdd = { lat, lon };
    onMapTap(null);
    openClubSheet('add');
  });
}

function addMissedShot(club) {
  const round = activeRound(state);
  if (!round || !pendingAdd) return;
  const shot = insertShot(round, { holeNo: round.current_hole, club, lat: pendingAdd.lat, lon: pendingAdd.lon });
  persist();
  endAddMissedShot();
  render(false);
  showBanner(`Added <strong>${escapeHtml(club)}</strong> as shot ${shot.shot_no}. Wrong place in the order? Use EDIT → ↑ ↓.`);
}

function endAddMissedShot() {
  pendingAdd = null;
  onMapTap(null);
  hideBanner();
}

function startMoveShot(shotId) {
  movingShotId = shotId;
  pendingMove = null;
  closeSheets();
  render(false);
  showBanner('<strong>Drag the large pin</strong> to where the ball really was, then tap Done.', {
    actions: {
      onCancel: () => endMoveShot(false),
      onDone: () => endMoveShot(true),
    },
  });
}

function endMoveShot(keep) {
  const round = activeRound(state);
  if (keep && pendingMove && round) {
    setShotPosition(round, movingShotId, pendingMove.lat, pendingMove.lon);
    persist();
  }
  movingShotId = null;
  pendingMove = null;
  hideBanner();
  render(false);
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
  if (!s || movingShotId || pendingAdd) return;
  editingShotId = shotId;
  $('editTitle').textContent = `Hole ${s.hole_no}, shot ${s.shot_no}`;
  $('editInfo').textContent = `${new Date(s.recorded_at).toLocaleString()} · ` +
    (s.accuracy_m == null ? (s.added_by_hand ? 'added by hand' : 'no GPS') : `±${s.accuracy_m.toFixed(1)} m`) +
    ` · ${s.distance_m == null ? 'no distance' : fmtYds(s.distance_m)}`;
  const clubs = state.bag.includes(s.club) ? state.bag : [...state.bag, s.club];
  fillSelect($('editClub'), clubs, s.club);
  fillSelect($('editHole'), Array.from({ length: HOLES }, (_, i) => i + 1), s.hole_no);
  $('editExclude').checked = s.exclude_from_stats;
  $('editMoveBtn').disabled = s.lat == null;
  $('editShotDialog').showModal();
}

function afterShotEdit() {
  persist();
  $('editShotDialog').close();
  render(false);
  if ($('editSheet').classList.contains('open')) renderShotList();
}

function saveEditShot() {
  const round = activeRound(state);
  if (!round || !editingShotId) return;
  editShot(round, editingShotId, {
    club: $('editClub').value,
    hole_no: Number($('editHole').value),
    exclude_from_stats: $('editExclude').checked,
  });
  afterShotEdit();
}

function deleteEditShot() {
  const round = activeRound(state);
  if (!round || !editingShotId) return;
  if (!confirm('Delete this shot? The shot before it will be re-measured to the next one.')) return;
  deleteShot(round, editingShotId);
  afterShotEdit();
}

// ---- Scorecard ------------------------------------------------------------------------------

const PAR_CYCLE = [null, 3, 4, 5];
const FAIRWAY_CYCLE = [null, 'hit', 'left', 'right'];
const GIR_CYCLE = [null, true, false];
const nextIn = (cycle, v) => cycle[(cycle.indexOf(v ?? null) + 1) % cycle.length];

function scoreClass(sum) {
  if (!sum.par || !sum.strokes) return '';
  const d = sum.strokes - sum.par;
  if (d < 0) return 'under';
  if (d === 1) return 'over1';
  if (d >= 2) return 'over2';
  return '';
}

function openScorecard() {
  renderScorecard();
  $('scorecardDialog').showModal();
}

function renderScorecard() {
  const round = activeRound(state);
  if (!round) return;
  $('scCourse').textContent = round.course || 'Round';
  $('scDate').textContent = round.date;
  const tp = scoreToPar(round);
  $('scTotal').innerHTML = `${totalStrokes(round)}<small>${tp.holes ? fmtToPar(tp.diff) + ` through ${plural(tp.holes, 'hole')} with par` : 'set par to see ±'}</small>`;

  const box = $('scTables');
  box.innerHTML = '';
  const totals = { strokes: 0, putts: 0, fwHit: 0, fwOf: 0, gir: 0, girOf: 0 };
  for (const [from, name] of [[1, 'OUT'], [10, 'IN']]) {
    const holes = Array.from({ length: 9 }, (_, i) => from + i);
    const sums = holes.map((n) => holeSummary(round, n));
    const t = document.createElement('table');
    t.className = 'sc-table';
    const row = (label, cls, cells, total) => {
      const tr = document.createElement('tr');
      if (cls) tr.className = cls;
      tr.innerHTML = `<th>${label}</th>`;
      cells.forEach((c) => { const td = document.createElement('td'); if (c instanceof Node) td.appendChild(c); else td.innerHTML = c; tr.appendChild(td); });
      const td = document.createElement('td');
      td.className = 'sc-sum';
      td.innerHTML = total;
      tr.appendChild(td);
      t.appendChild(tr);
    };
    const btn = (html, onClick) => {
      const b = document.createElement('button');
      b.innerHTML = html;
      b.addEventListener('click', () => { onClick(); persist(); renderScorecard(); render(false); });
      return b;
    };

    row('Hole', 'sc-hole', holes.map(String), name);
    row('Par', '', holes.map((n, i) => btn(sums[i].par ?? '·', () => setPar(round, n, nextIn(PAR_CYCLE, sums[i].par)))),
      sums.reduce((a, s) => a + (s.par || 0), 0) || '');
    row('Score', '', holes.map((n, i) => {
      const s = sums[i];
      const b = document.createElement('button');
      b.innerHTML = s.strokes ? `<span class="sc-score ${scoreClass(s)}">${s.strokes}</span>` : '';
      b.addEventListener('click', () => { $('scorecardDialog').close(); goToHole(n); });
      return b;
    }), sums.reduce((a, s) => a + s.strokes, 0) || '');
    row('Fairway', '', holes.map((n, i) => {
      const s = sums[i];
      if (s.par === 3) return '';
      const sym = { hit: '<span class="sc-hit">✓</span>', left: '←', right: '→' }[s.fairway] || '<span class="sc-miss">·</span>';
      return btn(sym, () => setFairway(round, n, nextIn(FAIRWAY_CYCLE, s.fairway)));
    }), (() => {
      const elig = sums.filter((s) => s.par !== 3 && s.fairway != null);
      totals.fwHit += elig.filter((s) => s.fairway === 'hit').length;
      totals.fwOf += elig.length;
      return elig.length ? `${elig.filter((s) => s.fairway === 'hit').length}/${elig.length}` : '';
    })());
    row('GIR', '', holes.map((n, i) => {
      const s = sums[i];
      const sym = s.gir === true ? '<span class="sc-hit">✓</span>' : s.gir === false ? '✗' : '<span class="sc-miss">·</span>';
      return btn(sym, () => setGir(round, n, nextIn(GIR_CYCLE, s.gir)));
    }), (() => {
      const set = sums.filter((s) => s.gir != null);
      totals.gir += set.filter((s) => s.gir).length;
      totals.girOf += set.length;
      return set.length ? `${set.filter((s) => s.gir).length}/${set.length}` : '';
    })());
    row('Putts', '', holes.map((n, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'sc-putts';
      wrap.appendChild(btn('+', () => addPutt(round, n)));
      const span = document.createElement('span');
      span.textContent = sums[i].putts;
      wrap.appendChild(span);
      wrap.appendChild(btn('−', () => removePutt(round, n)));
      return wrap;
    }), sums.reduce((a, s) => a + s.putts, 0));

    totals.strokes += sums.reduce((a, s) => a + s.strokes, 0);
    totals.putts += sums.reduce((a, s) => a + s.putts, 0);
    box.appendChild(t);
  }

  $('scSummary').innerHTML = `
    <div><strong>${totals.strokes}</strong><span class="small">Strokes</span></div>
    <div><strong>${totals.fwOf ? `${totals.fwHit}/${totals.fwOf}` : '–'}</strong><span class="small">Fairways</span></div>
    <div><strong>${totals.girOf ? `${totals.gir}/${totals.girOf}` : '–'}</strong><span class="small">GIR</span></div>
    <div><strong>${totals.putts}</strong><span class="small">Putts</span></div>`;
}

// ---- Round start / end -----------------------------------------------------------------------

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

// ---- Bag -------------------------------------------------------------------------------------

function openBag() {
  if ($('menuDialog').open) $('menuDialog').close();
  $('bagText').value = state.bag.join('\n');
  $('bagDialog').showModal();
}

function saveBag() {
  const clubs = $('bagText').value.split('\n').map((c) => c.trim()).filter(Boolean);
  if (!clubs.length) { alert('Add at least one club.'); return; }
  state.bag = [...new Set(clubs)];
  persist();
  $('bagDialog').close();
}

// ---- Export ------------------------------------------------------------------------------------

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

// ---- Screen Wake Lock ------------------------------------------------------------------------
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

// ---- Rendering ----------------------------------------------------------------------------------

function renderStart() {
  const ol = $('pastRounds');
  ol.innerHTML = '';
  const rounds = [...state.rounds].reverse();
  if (!rounds.length) ol.innerHTML = '<li class="small">No rounds yet.</li>';
  for (const r of rounds) {
    const tp = scoreToPar(r);
    const li = document.createElement('li');
    li.innerHTML = `<button class="round-row"><strong>${r.date}</strong>&nbsp;${escapeHtml(r.course || 'Unnamed course')}
      <span class="small">&nbsp;· ${totalStrokes(r)} strokes${tp.holes ? ` (${fmtToPar(tp.diff)})` : ''} · ${plural(r.shots.length, 'shot')}</span></button>`;
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

function renderHoleTabs(round) {
  const nav = $('holeTabs');
  if (!nav.children.length) {
    for (let n = 1; n <= HOLES; n++) {
      const b = document.createElement('button');
      b.className = 'hole-tab';
      b.textContent = n;
      b.dataset.hole = n;
      b.addEventListener('click', () => goToHole(n));
      nav.appendChild(b);
    }
  }
  for (const b of nav.children) {
    const n = Number(b.dataset.hole);
    b.classList.toggle('current', n === round.current_hole);
    b.classList.toggle('done', holeSummary(round, n).finished);
  }
  const cur = nav.children[round.current_hole - 1];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// fit: whether the map should re-frame the hole (false while editing, so it doesn't jump)
function renderRound(round, fit) {
  const n = round.current_hole;
  const sum = holeSummary(round, n);
  const tp = scoreToPar(round);

  $('courseName').textContent = round.course || 'Round';
  $('roundDate').textContent = round.date;
  $('scoreChip').textContent = tp.holes ? fmtToPar(tp.diff) : String(totalStrokes(round));

  if (sum.par && sum.strokes) {
    $('holeScore').textContent = toParWords(sum.strokes - sum.par);
    $('holeScoreLabel').textContent = `HOLE ${n} · PAR ${sum.par}`;
  } else {
    $('holeScore').textContent = sum.strokes;
    $('holeScoreLabel').textContent = `HOLE ${n} STROKES`;
  }
  $('puttCount').textContent = sum.putts;
  $('finishHoleBtn').textContent = sum.finished ? `Hole ${n} done ✓` : 'Finish hole ›';
  renderHoleTabs(round);

  if (!mapReady) {
    createMap('map');
    mapReady = true;
  }
  refreshSize();
  const h = round.holes[String(n)];
  drawHole(shotsOnHole(round, n), h ? h.end : null, {
    fmt: fmtYds,
    putts: sum.putts,
    onShotTap: openEditShot,
    movingShotId,
    onMoved: (lat, lon) => { pendingMove = { lat, lon }; },
    fit,
  });
}

function render(fit = true) {
  const round = activeRound(state);
  $('startScreen').hidden = !!round;
  $('roundScreen').hidden = !round;
  if (round) renderRound(round, fit);
  else renderStart();
}

// ---- Startup ------------------------------------------------------------------------------------

function init() {
  fillSelect($('startHoleInput'), Array.from({ length: HOLES }, (_, i) => i + 1), 1);

  $('startBtn').addEventListener('click', startRound);
  $('nextShotBtn').addEventListener('click', () => { if (!busy) openClubSheet('shot'); });
  $('puttPlusBtn').addEventListener('click', onPuttPlus);
  $('puttMinusBtn').addEventListener('click', onPuttMinus);
  $('finishHoleBtn').addEventListener('click', onFinishHole);
  $('editBtn').addEventListener('click', () => { if (!busy) openEditSheet(); });
  $('addShotBtn').addEventListener('click', startAddMissedShot);
  $('scoreChip').addEventListener('click', openScorecard);
  $('scoreBox').addEventListener('click', openScorecard);
  $('sheetBackdrop').addEventListener('click', closeSheets);
  document.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', closeSheets));

  $('editSaveBtn').addEventListener('click', saveEditShot);
  $('editCancelBtn').addEventListener('click', () => $('editShotDialog').close());
  $('editDeleteBtn').addEventListener('click', deleteEditShot);
  $('editMoveBtn').addEventListener('click', () => { $('editShotDialog').close(); startMoveShot(editingShotId); });

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
