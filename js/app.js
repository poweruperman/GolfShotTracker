/*
 * Golf Shot Tracker: the screens.
 *
 * Home (bottom tabs): Player, Clubs, Courses, Activity, Start Round.
 * Play: one hole at a time on its aerial photo (tee at the bottom), with
 *   live front/center/back distances to the green, tap-to-measure, shots
 *   drawn with club and yards, putts and a "+ SHOT" button.
 *
 * Recording a shot: stand at the ball, tap + SHOT, pick the club. The GPS is
 * sampled for a few seconds; the previous shot's distance fills in.
 * After putting out, the next + SHOT moves on to the next hole by itself.
 *
 * Data rules: round.js. Map math: geo.js. Hole drawing: holeview.js.
 */

import {
  toYd, M_TO_FT, FLAG_ACCURACY_M, SAMPLE_MS, distM, greenDistances,
  sampleBestPosition, geoErrorText,
} from './geo.js';
import {
  DEFAULT_BAG, newRound, hole, shotsOnHole, addShot, findShot, editShot, deleteShot, moveShot,
  setShotPosition, insertShot, setHoleEnd, setPutts, finishHole, nextHoleNo, holeScore,
  holeDone, scoreToPar, fmtToPar, toParWords, analyzeHole, clubStats, shotsToCsv,
} from './round.js';
import { load, save, parseBackup, saveFile } from './store.js';
import {
  loadIndex, loadCourse, cachedCourse, courseHole, imageUrl, sortByDistance, downloadForOffline,
} from './courses.js';
import { createHoleView } from './holeview.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yds = (m) => `${Math.round(toYd(m))}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let state = load();
let tab = 'start';
let here = null;            // last known [lat, lon] (for sorting courses)

// Play screen
let play = null;            // { mode: 'round' | 'browse', roundId, courseId, n }
let course = null;          // loaded course file for the play screen
let editMode = false;
let undoStack = [];
let target = null;          // tapped point { lat, lon }
let me = null;              // live GPS { lat, lon, acc }
let watchId = null;
let busy = false;
let toastTimer = null;
let clubPick = null;        // what the club sheet is for: { kind: 'shot' } | { kind: 'add', lat, lon }
let sheetShotId = null;

let wakeLock = null;
let wantWake = false;

const hv = createHoleView($('holeView'), {
  onTap: onMapTap,
  onPinTap: (id) => openShotSheet(id),
  onPinDrag: onPinDrag,
});

function persist() {
  if (!save(state)) toast('Could not save on this phone. Back up your data from Player.', { error: true });
}

const playRound = () => (play && play.mode === 'round' ? state.rounds.find((r) => r.id === play.roundId) : null);
const activeRound = () => state.rounds.find((r) => r.id === state.active_round_id) || null;
const isLive = (r) => r && r.id === state.active_round_id;
const parOf = (c) => (n) => { const h = courseHole(c, n); return h ? h.par : null; };

// ======================================================================= Home

const TITLES = { player: 'Player', clubs: 'Clubs', courses: 'Courses', activity: 'Activity', start: 'Start Round' };

function showHome(t = tab) {
  tab = t;
  stopLiveGps();
  releaseWake();
  play = null;
  editMode = false;
  $('play').hidden = true;
  $('home').hidden = false;
  $('homeTitle').textContent = TITLES[tab];
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const ar = activeRound();
  $('resumeCard').hidden = !ar;
  if (ar) {
    $('resumeCard').innerHTML = `<strong>Round in progress</strong><span>${esc(ar.course_name)} · Hole ${ar.current_hole}</span><em>Resume ›</em>`;
  }
  renderTab();
}

async function renderTab() {
  const body = $('homeBody');
  body.innerHTML = '';
  if (tab === 'start' || tab === 'courses') return renderCourseList(body);
  if (tab === 'activity') return renderActivity(body);
  if (tab === 'clubs') return renderClubs(body);
  if (tab === 'player') return renderPlayer(body);
}

async function renderCourseList(body) {
  body.innerHTML = `<input id="courseSearch" class="search" type="search" placeholder="Search courses" autocomplete="off">
    <ol id="courseList" class="list"></ol>`;
  let list = [];
  try {
    list = await loadIndex();
  } catch (e) {
    body.querySelector('#courseList').innerHTML = `<li class="hint">${esc(e.message)}</li>`;
    return;
  }
  const draw = () => {
    const q = body.querySelector('#courseSearch').value.trim().toLowerCase();
    const items = sortByDistance(list, here).filter((c) => !q || `${c.name} ${c.city}`.toLowerCase().includes(q));
    const ol = body.querySelector('#courseList');
    ol.innerHTML = '';
    for (const c of items) {
      const li = document.createElement('li');
      const away = c.away_m != null ? `${(c.away_m / 1000).toFixed(1)} km` : '';
      const holes = c.holes < c.holes_expected ? `${c.holes}/${c.holes_expected} holes mapped` : `${c.holes_expected} holes`;
      li.innerHTML = `<button class="row-btn"><span class="row-main"><strong>${esc(c.name)}</strong>
        <span class="sub">${esc(c.city)} · ${holes}${c.par ? ` · Par ${c.par}` : ''}</span></span>
        <span class="row-side">${away}</span></button>`;
      li.querySelector('button').addEventListener('click', () => (tab === 'start' ? openStart(c) : openBrowse(c.id, 1)));
      ol.appendChild(li);
    }
    if (!items.length) ol.innerHTML = '<li class="hint">No courses match.</li>';
  };
  body.querySelector('#courseSearch').addEventListener('input', draw);
  draw();
  if (!here) locateOnce(() => { if (tab === 'start' || tab === 'courses') draw(); });
}

function renderActivity(body) {
  const rounds = [...state.rounds].sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (!rounds.length) {
    body.innerHTML = '<p class="hint pad">No rounds yet. Start one from Start Round.</p>';
    return;
  }
  const ol = document.createElement('ol');
  ol.className = 'list';
  for (const r of rounds) {
    const c = cachedCourse(r.course_id);
    const sp = scoreToPar(r, c ? parOf(c) : () => null);
    const li = document.createElement('li');
    li.innerHTML = `<button class="row-btn"><span class="row-main"><strong>${esc(r.course_name)}</strong>
      <span class="sub">${r.date}${isLive(r) ? ' · in progress' : ''}</span></span>
      <span class="row-side big">${sp.strokes || '–'}${sp.holes ? `<em>${fmtToPar(sp.diff)}</em>` : ''}</span></button>`;
    li.querySelector('button').addEventListener('click', () => openRound(r.id));
    ol.appendChild(li);
  }
  body.appendChild(ol);
  // Load the course files in the background so scores vs par show next time.
  for (const id of new Set(rounds.map((r) => r.course_id))) {
    if (!cachedCourse(id)) loadCourse(id).then(() => { if (tab === 'activity' && !play) renderTab(); }).catch(() => {});
  }
}

async function renderClubs(body) {
  // Course files are needed to tell chips from full swings.
  await Promise.all([...new Set(state.rounds.map((r) => r.course_id))].map((id) => loadCourse(id).catch(() => null)));
  const stats = clubStats(state.rounds, (r, n) => courseHole(cachedCourse(r.course_id), n));
  const clubs = [...state.bag, ...Object.keys(stats).filter((c) => !state.bag.includes(c))];
  body.innerHTML = `<p class="hint pad">Average total distance (carry + roll) per club, from every shot
    you've recorded. Chips/pitches and shots marked "exclude" are left out. One shot can be
    5–10 yds off from GPS error; averages over many shots are reliable.</p>
    <ol class="list clubs"></ol>
    <button id="editBag" class="wide-btn">Edit my bag</button>`;
  const ol = body.querySelector('ol');
  for (const club of clubs) {
    const s = stats[club];
    const li = document.createElement('li');
    li.innerHTML = `<div class="club-row"><span class="badge">${esc(club)}</span>
      <span class="row-main"><strong>${s ? `${yds(s.avg_m)} yds` : '–'}</strong>
      <span class="sub">${s ? `${plural(s.count, 'shot')} · longest ${yds(s.max_m)} · range ${yds(s.min_m)}–${yds(s.max_m)}` : 'no shots yet'}</span></span></div>`;
    ol.appendChild(li);
  }
  body.querySelector('#editBag').addEventListener('click', openBag);
}

async function renderPlayer(body) {
  const done = state.rounds.filter((r) => r.shots.length);
  await Promise.all([...new Set(done.map((r) => r.course_id))].map((id) => loadCourse(id).catch(() => null)));
  let fwHit = 0; let fwAll = 0; let girHit = 0; let girAll = 0; let putts = 0; let holesPlayed = 0;
  for (const r of done) {
    const c = cachedCourse(r.course_id);
    for (let n = 1; n <= r.holes_total; n++) {
      const sc = holeScore(r, n);
      if (!sc.strokes) continue;
      holesPlayed++;
      putts += sc.putts;
      const a = analyzeHole(r, n, courseHole(c, n));
      if (a.fairway) { fwAll++; if (a.fairway === 'hit') fwHit++; }
      if (a.gir !== null) { girAll++; if (a.gir) girHit++; }
    }
  }
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
  body.innerHTML = `
    <div class="stat-grid">
      <div><strong>${done.length}</strong><span>Rounds</span></div>
      <div><strong>${pct(fwHit, fwAll)}</strong><span>Fairways</span></div>
      <div><strong>${pct(girHit, girAll)}</strong><span>GIR</span></div>
      <div><strong>${holesPlayed ? ((putts / holesPlayed) * 18).toFixed(1) : '–'}</strong><span>Putts / 18</span></div>
    </div>
    <h3 class="section">Settings</h3>
    <button id="pBag" class="wide-btn">My bag</button>
    <button id="pWake" class="wide-btn">Keep screen on during a round: ${state.no_wake ? 'Off' : 'On'}</button>
    <h3 class="section">Your data (only on this phone)</h3>
    <button id="pBackup" class="wide-btn">Back up all rounds (file)</button>
    <button id="pRestore" class="wide-btn">Restore from a backup file</button>
    <button id="pCsv" class="wide-btn">Export shots (CSV)</button>
    <a class="wide-btn" href="gps-test/">GPS accuracy test</a>
    <p class="hint pad">Course maps © OpenStreetMap contributors. Aerial imagery: USGS The National Map.
      Back up after each round: iPhone can clear web-app storage.</p>`;
  body.querySelector('#pBag').addEventListener('click', openBag);
  body.querySelector('#pWake').addEventListener('click', () => { state.no_wake = !state.no_wake; persist(); renderTab(); });
  body.querySelector('#pBackup').addEventListener('click', () =>
    saveFile(`golf-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state), 'application/json'));
  body.querySelector('#pRestore').addEventListener('click', () => $('restoreFile').click());
  body.querySelector('#pCsv').addEventListener('click', () =>
    saveFile(`golf-shots-${new Date().toISOString().slice(0, 10)}.csv`, shotsToCsv(state.rounds), 'text/csv'));
}

$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const s = parseBackup(await f.text());
    if (!confirm(`Replace the data on this phone with this backup (${plural(s.rounds.length, 'round')})?`)) return;
    state = s;
    persist();
    renderTab();
  } catch (err) {
    alert(err.message);
  }
});

function locateOnce(then) {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (p) => { here = [p.coords.latitude, p.coords.longitude]; then && then(); },
    () => {},
    { enableHighAccuracy: false, maximumAge: 300000, timeout: 15000 }
  );
}

// ===================================================================== Start

let startCourse = null;

function openStart(c) {
  startCourse = c;
  $('startCourse').textContent = c.name;
  const missing = c.holes < c.holes_expected;
  $('startInfo').textContent = `${c.city} · ${c.holes_expected} holes${c.par ? ` · Par ${c.par}` : ''}` +
    (missing ? `. Map data covers ${c.holes} of ${c.holes_expected} holes; the others can still be scored.` : '');
  const sel = $('startHole');
  sel.innerHTML = '';
  for (let n = 1; n <= c.holes_expected; n++) sel.add(new Option(`Hole ${n}`, n));
  $('startDialog').showModal();
}

$('startGo').addEventListener('click', async () => {
  $('startDialog').close();
  if (activeRound() && !confirm('Finish the round in progress and start a new one?')) return;
  if (activeRound()) activeRound().finished_at = new Date().toISOString();
  try {
    const c = await loadCourse(startCourse.id);
    const r = newRound({ course: c, startHole: Number($('startHole').value) });
    state.rounds.push(r);
    state.active_round_id = r.id;
    persist();
    openRound(r.id);
    downloadForOffline(c).catch(() => {});
  } catch (e) {
    alert(e.message);
  }
});
$('startPreview').addEventListener('click', () => { $('startDialog').close(); openBrowse(startCourse.id, 1); });
$('resumeCard').addEventListener('click', () => { const r = activeRound(); if (r) openRound(r.id); });
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showHome(b.dataset.tab)));

// ====================================================================== Play

async function openRound(id) {
  const r = state.rounds.find((x) => x.id === id);
  if (!r) return;
  play = { mode: 'round', roundId: id, courseId: r.course_id, n: r.current_hole };
  await enterPlay();
}

async function openBrowse(courseId, n) {
  play = { mode: 'browse', courseId, n };
  await enterPlay();
}

async function enterPlay() {
  try {
    course = await loadCourse(play.courseId);
  } catch (e) {
    course = null;
  }
  editMode = false;
  undoStack = [];
  target = null;
  $('home').hidden = true;
  $('play').hidden = false;
  buildHoleTabs();
  startLiveGps();
  const r = playRound();
  if (isLive(r) && !state.no_wake) { wantWake = true; requestWake(); }
  showHole(play.n);
}

function holeCount() {
  const r = playRound();
  return r ? r.holes_total : (course ? course.holes_expected : 18);
}

function buildHoleTabs() {
  const nav = $('holeTabs');
  nav.innerHTML = '';
  for (let n = 1; n <= holeCount(); n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.dataset.n = n;
    b.addEventListener('click', () => { if (!busy && !editMode) goHole(n); });
    nav.appendChild(b);
  }
}

function goHole(n) {
  const r = playRound();
  if (isLive(r)) { r.current_hole = n; persist(); }
  showHole(n);
}

function showHole(n) {
  play.n = n;
  target = null;
  const ch = courseHole(course, n);
  const msg = course
    ? 'No aerial image for this hole yet (not mapped in OpenStreetMap). You can still record shots and putts.'
    : 'Could not load this course.';
  hv.show(imageUrl(course, ch), ch && ch.image ? ch.image : null, msg);
  render();
}

function render() {
  if (!play) return;
  const r = playRound();
  const n = play.n;
  const ch = courseHole(course, n);
  const live = isLive(r);

  // Header
  $('playCourse').textContent = r ? r.course_name : (course ? course.name : '');
  $('playDate').textContent = r ? r.date : 'Course preview';
  const sp = r ? scoreToPar(r, parOf(course)) : null;
  $('scoreBoxBtn').hidden = !r;
  if (r) $('scoreBoxBtn').textContent = sp.holes ? fmtToPar(sp.diff) : String(sp.strokes || 0);

  // Hole tabs
  for (const b of $('holeTabs').children) {
    const k = Number(b.dataset.n);
    b.classList.toggle('on', k === n);
    b.classList.toggle('played', !!(r && holeScore(r, k).strokes));
  }
  const cur = $('holeTabs').children[n - 1];
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });

  // Hole info line
  const len = ch ? `${yds(ch.length_m)} yds` : '';
  $('holeInfo').innerHTML = `<strong>Hole ${n}</strong>${ch && ch.par ? ` · Par ${ch.par}` : ''}${len ? ` · ${len}` : ''}`;

  // Bottom bar
  $('playBottom').hidden = !r || editMode;
  $('browseBottom').hidden = !!r || editMode;
  $('fabs').hidden = !r || editMode;
  $('shotBtn').hidden = !live;
  if (r) {
    const sc = holeScore(r, n);
    const par = ch ? ch.par : null;
    if (par && sc.strokes && holeDone(r, n)) {
      $('holeScore').textContent = toParWords(sc.strokes - par);
      $('holeScoreLabel').textContent = 'SCORE';
    } else {
      $('holeScore').textContent = sc.strokes || '–';
      $('holeScoreLabel').textContent = 'STROKES';
    }
    $('puttCount').textContent = sc.putts;
  }

  // Edit bar replaces the normal header while editing
  $('editBar').hidden = !editMode;
  document.querySelector('.play-top').hidden = editMode;
  $('editHint').hidden = !editMode;
  $('holeInfo').hidden = editMode;
  $('editTitle').textContent = `Edit Hole ${n}`;
  $('undoBtn').disabled = !undoStack.length;

  drawOverlay();
  renderGreenPanel();
}

function drawOverlay() {
  const r = playRound();
  const n = play.n;
  const ch = courseHole(course, n);
  const o = { editMode, shots: [], end: null, me: null, target: null };
  if (r) {
    const shots = shotsOnHole(r, n);
    const a = analyzeHole(r, n, ch);
    o.shots = shots.map((s) => ({
      id: s.id, lat: s.lat, lon: s.lon, club: s.club, excluded: s.exclude_from_stats,
      text: s.distance_m == null ? '' : `${yds(s.distance_m)} yds`,
    }));
    const h = r.holes[String(n)];
    if (h && h.end) {
      o.end = {
        lat: h.end.lat, lon: h.end.lon, badge: h.putts ? `${h.putts}p` : '⚑',
        text: a.firstPuttM != null ? `${Math.round(a.firstPuttM * M_TO_FT)} ft` : '',
      };
    }
  }
  if (me && ch && distM([me.lat, me.lon], ch.green_center) < 1500) o.me = [me.lat, me.lon];
  if (target && ch) {
    const from = targetFrom(ch);
    o.target = {
      lat: target.lat, lon: target.lon,
      from, to: ch.green_center,
      l1: from ? `${yds(distM(from, [target.lat, target.lon]))} yds` : '',
      l2: `${yds(distM([target.lat, target.lon], ch.green_center))} yds`,
    };
  }
  hv.setOverlay(o);
}

// Measure a tapped target from the player if on this hole, else from the
// last shot, else from the tee.
function targetFrom(ch) {
  if (me && distM([me.lat, me.lon], ch.green_center) < 700) return [me.lat, me.lon];
  const r = playRound();
  if (r) {
    const shots = shotsOnHole(r, play.n).filter((s) => s.lat != null);
    if (shots.length) return [shots[shots.length - 1].lat, shots[shots.length - 1].lon];
  }
  return ch.tee;
}

function renderGreenPanel() {
  const ch = courseHole(course, play.n);
  const near = me && ch && distM([me.lat, me.lon], ch.green_center) < 700;
  $('greenPanel').hidden = !near || editMode;
  if (!near) return;
  const g = greenDistances([me.lat, me.lon], ch.green, ch.green_center);
  $('gFront').textContent = g.front != null ? yds(g.front) : '–';
  $('gCenter').textContent = yds(g.center);
  $('gBack').textContent = g.back != null ? yds(g.back) : '–';
}

function onMapTap(lat, lon) {
  if (editMode) {
    const r = playRound();
    if (!r) return;
    clubPick = { kind: 'add', lat, lon };
    openClubSheet('Add a missed shot: which club?', false);
    return;
  }
  if (target && distM([target.lat, target.lon], [lat, lon]) < 10) target = null;
  else target = { lat, lon };
  drawOverlay();
}

// ---- Live GPS for the rangefinder (front/center/back) --------------------------------

// One GPS feed for the whole play screen. Recording a shot listens to it
// too (gpsListeners) instead of starting a second GPS watch.
const gpsListeners = new Set();

function startLiveGps() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      lastFix = p;
      me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      here = [me.lat, me.lon];
      gpsListeners.forEach((l) => l.onPos(p));
      if (play && !busy) { renderGreenPanel(); drawOverlay(); }
    },
    (err) => gpsListeners.forEach((l) => l.onErr(err)),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
}

let lastFix = null;
function subscribeGps(onPos, onErr) {
  const l = { onPos, onErr };
  gpsListeners.add(l);
  return () => gpsListeners.delete(l);
}
subscribeGps.latest = () => lastFix;

function stopLiveGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// ---- Toast ---------------------------------------------------------------------------------

function toast(html, opts = {}) {
  clearTimeout(toastTimer);
  $('toastText').innerHTML = html;
  $('toast').classList.toggle('error', !!opts.error);
  $('toast').hidden = false;
  $('toastBar').hidden = !opts.progress;
  if (!opts.sticky) toastTimer = setTimeout(() => { $('toast').hidden = true; }, opts.ms || 4500);
}

// ---- Recording shots -----------------------------------------------------------------------

function openClubSheet(title, showHint) {
  $('clubSheetTitle').textContent = title;
  $('clubSheetHint').hidden = !showHint;
  const grid = $('clubGrid');
  grid.innerHTML = '';
  for (const club of state.bag) {
    const b = document.createElement('button');
    b.textContent = club;
    b.addEventListener('click', () => { closeSheets(); onClubPicked(club); });
    grid.appendChild(b);
  }
  openSheet('clubSheet');
}

$('shotBtn').addEventListener('click', () => {
  if (busy) return;
  clubPick = { kind: 'shot' };
  openClubSheet('Which club?', true);
});

function onClubPicked(club) {
  if (!clubPick) return;
  if (clubPick.kind === 'add') {
    const r = playRound();
    snapshot();
    const s = insertShot(r, { holeNo: play.n, club, lat: clubPick.lat, lon: clubPick.lon });
    persist();
    render();
    toast(`Added <strong>${esc(club)}</strong> as shot ${s.shot_no}. Use ☰ list ↑↓ if the order is wrong.`);
  } else {
    recordShot(club);
  }
  clubPick = null;
}

async function takeReading(label) {
  busy = true;
  $('shotBtn').disabled = true;
  $('puttPlus').disabled = true;
  $('toastFill').style.width = '0%';
  toast(`<strong>Hold still…</strong> ${label}`, { sticky: true, progress: true });
  try {
    const pos = await sampleBestPosition((acc, count, elapsed) => {
      $('toastFill').style.width = `${Math.min(100, (elapsed / SAMPLE_MS) * 100)}%`;
      $('toastText').innerHTML = `<strong>Hold still…</strong> ${label} · ±${acc.toFixed(0)} m`;
    }, watchId !== null ? subscribeGps : null);
    return pos;
  } catch (e) {
    toast(geoErrorText(e), { error: true });
    return null;
  } finally {
    busy = false;
    $('shotBtn').disabled = false;
    $('puttPlus').disabled = false;
  }
}

async function recordShot(club) {
  const r = playRound();
  if (!isLive(r) || busy) return;
  if (wantWake) requestWake();
  const pos = await takeReading(`recording ${esc(club)}`);
  if (!pos && !confirm(`No GPS position. Record the ${club} shot anyway?\n(It counts for your score but gets no distance.)`)) return;

  // Moving on? After putting out, or when standing on the next tee far from
  // this green, the shot belongs to the next hole.
  const n = play.n;
  const sc = holeScore(r, n);
  const ch = courseHole(course, n);
  const nextN = nextHoleNo(r, n);
  const nextCh = courseHole(course, nextN);
  let advance = sc.putts > 0;
  if (!advance && pos && sc.shots > 0 && ch && nextCh) {
    const p = [pos.lat, pos.lon];
    advance = distM(p, nextCh.tee) < 60 && distM(p, ch.green_center) > 90;
  }
  let msg = '';
  if (advance && sc.strokes) {
    finishHole(r, n);
    const par = ch ? ch.par : null;
    msg = `Hole ${n}: <strong>${sc.strokes}</strong>${par ? ` (${toParWords(sc.strokes - par)})` : ''}. `;
    r.current_hole = nextN;
    play.n = nextN;
  }
  const shot = addShot(r, { club, pos, holeNo: play.n });
  persist();
  if (msg) showHole(play.n); else render();

  const prev = shotsOnHole(r, shot.hole_no).find((s) => s.shot_no === shot.shot_no - 1);
  msg += `Shot ${shot.shot_no} · <strong>${esc(club)}</strong> saved` +
    (pos ? ` <span class="acc ${pos.accuracy_m > FLAG_ACCURACY_M ? 'bad' : ''}">±${pos.accuracy_m.toFixed(0)} m</span>` : ' (no GPS)');
  if (prev) msg += `<br>${esc(prev.club)}: <strong>${prev.distance_m == null ? 'no distance' : `${yds(prev.distance_m)} yds`}</strong>`;
  toast(msg, { error: !!pos && pos.accuracy_m > FLAG_ACCURACY_M });
}

$('puttPlus').addEventListener('click', async () => {
  const r = playRound();
  if (!r || busy) return;
  const n = play.n;
  const h = hole(r, n);
  // The first putt also marks where the ball is on the green, which gives
  // the approach shot its distance. Only when standing there (live round).
  let msg = '';
  if (isLive(r) && h.putts === 0 && !h.end && shotsOnHole(r, n).length) {
    const pos = await takeReading('marking your ball on the green');
    if (pos) {
      setHoleEnd(r, n, pos);
      const last = shotsOnHole(r, n).slice(-1)[0];
      msg = `Ball marked on the green. ${esc(last.club)}: <strong>${last.distance_m == null ? 'no distance' : `${yds(last.distance_m)} yds`}</strong>`;
    }
  }
  setPutts(r, n, h.putts + 1);
  persist();
  render();
  if (msg) toast(msg);
});

$('puttMinus').addEventListener('click', () => {
  const r = playRound();
  if (!r || busy) return;
  setPutts(r, play.n, hole(r, play.n).putts - 1);
  persist();
  render();
});

// ---- Editing (Arccos-style: drag shots, tap to add, tap a shot to change it) ---------------

function snapshot() {
  const r = playRound();
  undoStack.push(JSON.stringify(r));
  if (undoStack.length > 30) undoStack.shift();
}

$('editBtn').addEventListener('click', () => {
  if (busy) return;
  $('toast').hidden = true;
  editMode = true;
  undoStack = [];
  target = null;
  render();
});
$('doneBtn').addEventListener('click', () => { editMode = false; render(); });
$('undoBtn').addEventListener('click', () => {
  const r = playRound();
  if (!r || !undoStack.length) return;
  const prev = JSON.parse(undoStack.pop());
  Object.assign(r, prev);
  persist();
  render();
});

function onPinDrag(id, lat, lon) {
  const r = playRound();
  if (!r) return;
  snapshot();
  setShotPosition(r, id, lat, lon);
  persist();
  render();
}

function openShotSheet(id) {
  const r = playRound();
  const s = r && findShot(r, id);
  if (!s) return;
  sheetShotId = id;
  const a = analyzeHole(r, s.hole_no, courseHole(course, s.hole_no));
  $('shotSheetTitle').textContent = `Shot ${s.shot_no}: ${s.club}`;
  $('shotSheetInfo').textContent = [
    s.distance_m == null ? 'no distance' : `${yds(s.distance_m)} yds`,
    a.labels[s.shot_no - 1],
    s.accuracy_m == null ? (s.added_by_hand ? 'added by hand' : 'no GPS') : `GPS ±${s.accuracy_m.toFixed(0)} m`,
    s.moved_by_hand ? 'moved by hand' : '',
    new Date(s.recorded_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  ].filter(Boolean).join(' · ');
  $('shotExclude').textContent = s.exclude_from_stats ? 'Include' : 'Exclude';
  const n = shotsOnHole(r, s.hole_no).length;
  $('shotEarlier').disabled = s.shot_no === 1;
  $('shotLater').disabled = s.shot_no === n;
  const grid = $('shotClubGrid');
  grid.innerHTML = '';
  for (const club of state.bag) {
    const b = document.createElement('button');
    b.textContent = club;
    b.classList.toggle('on', club === s.club);
    b.addEventListener('click', () => shotChange(() => editShot(r, id, { club })));
    grid.appendChild(b);
  }
  openSheet('shotSheet');
}

function shotChange(fn, keepOpen = false) {
  snapshot();
  fn();
  persist();
  render();
  if ($('listSheet').classList.contains('open')) renderShotList();
  if (keepOpen && sheetShotId) openShotSheet(sheetShotId); else closeSheet('shotSheet');
}

$('shotEarlier').addEventListener('click', () => {
  const r = playRound(); const s = findShot(r, sheetShotId);
  shotChange(() => moveShot(r, s.id, s.shot_no - 2), true);
});
$('shotLater').addEventListener('click', () => {
  const r = playRound(); const s = findShot(r, sheetShotId);
  shotChange(() => moveShot(r, s.id, s.shot_no), true);
});
$('shotExclude').addEventListener('click', () => {
  const r = playRound(); const s = findShot(r, sheetShotId);
  shotChange(() => editShot(r, s.id, { exclude_from_stats: !s.exclude_from_stats }), true);
});
$('shotDelete').addEventListener('click', () => {
  if (!confirm('Delete this shot? The shot before it will be re-measured.')) return;
  const r = playRound();
  shotChange(() => deleteShot(r, sheetShotId));
});

// ---- Shot list (☰) ----------------------------------------------------------------------------

function renderShotList() {
  const r = playRound();
  const n = play.n;
  const ch = courseHole(course, n);
  const a = analyzeHole(r, n, ch);
  const sc = holeScore(r, n);
  $('listTitle').textContent = `Hole ${n}${ch && ch.par ? ` · Par ${ch.par}` : ''} · ${plural(sc.strokes, 'stroke')}`;
  const ol = $('shotList');
  ol.innerHTML = '';
  shotsOnHole(r, n).forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="shot-row${s.exclude_from_stats ? ' excluded' : ''}">
      <span class="badge">${esc(s.club)}</span>
      <span class="row-main"><strong>${s.distance_m == null ? '–' : `${yds(s.distance_m)} Yards`}</strong></span>
      <span class="row-side">${esc(a.labels[i])}</span></button>`;
    li.querySelector('button').addEventListener('click', () => openShotSheet(s.id));
    ol.appendChild(li);
  });
  if (sc.putts) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="shot-row"><span class="badge putt">Pu</span>
      <span class="row-main"><strong>${plural(sc.putts, 'putt')}</strong></span>
      <span class="row-side">${a.firstPuttM != null ? `1st putt ≈ ${Math.round(a.firstPuttM * M_TO_FT)} ft` : ''}</span></div>`;
    ol.appendChild(li);
  }
  if (!ol.children.length) ol.innerHTML = '<li class="hint">No shots on this hole yet.</li>';
}

$('listBtn').addEventListener('click', () => { renderShotList(); openSheet('listSheet'); });

// ---- Scorecard ---------------------------------------------------------------------------------

const FW_CYCLE = [null, 'hit', 'left', 'right'];
const GIR_CYCLE = [null, true, false];
const cycle = (arr, v) => arr[(arr.indexOf(v ?? null) + 1) % arr.length];

function openScorecard() {
  renderScorecard();
  $('scorecard').showModal();
}

function renderScorecard() {
  const r = playRound();
  if (!r) return;
  const sp = scoreToPar(r, parOf(course));
  $('scCourse').textContent = r.course_name;
  $('scDate').textContent = r.date;
  $('scTotal').textContent = sp.strokes || '–';
  $('scToPar').textContent = sp.holes ? fmtToPar(sp.diff) : '';
  $('scEndRound').hidden = !isLive(r);
  $('scDelete').hidden = isLive(r);

  const N = r.holes_total;
  const rows = { hole: [], par: [], score: [], fw: [], gir: [], putts: [], first: [], edit: [] };
  const tot = { par: 0, score: 0, fwHit: 0, fwAll: 0, gir: 0, girAll: 0, putts: 0, first: [] };
  for (let n = 1; n <= N; n++) {
    const ch = courseHole(course, n);
    const sc = holeScore(r, n);
    const a = analyzeHole(r, n, ch);
    const h = r.holes[String(n)] || {};
    rows.hole.push(`<th>${n}</th>`);
    rows.par.push(`<td>${a.par || ''}</td>`);
    let cls = '';
    if (a.par && sc.strokes) {
      const d = sc.strokes - a.par;
      cls = d <= -1 ? 'under' : d === 1 ? 'bogey' : d >= 2 ? 'double' : '';
    }
    rows.score.push(`<td><span class="sc-num ${cls}">${sc.strokes || ''}</span></td>`);
    const fwSym = { hit: '<span class="ok">✓</span>', left: '←', right: '→' }[a.fairway] || '';
    rows.fw.push(a.par === 3 ? '<td class="na"></td>' :
      `<td><button data-fw="${n}" class="${h.fairway ? 'manual' : ''}">${sc.strokes ? fwSym || '·' : ''}</button></td>`);
    rows.gir.push(`<td><button data-gir="${n}" class="${h.gir !== null && h.gir !== undefined ? 'manual' : ''}">${
      sc.strokes ? (a.gir === true ? '<span class="ok">✓</span>' : a.gir === false ? '✕' : '·') : ''}</button></td>`);
    rows.putts.push(`<td class="putts"><button data-pp="${n}">+</button><span>${sc.strokes ? sc.putts : ''}</span><button data-pm="${n}">−</button></td>`);
    rows.first.push(`<td>${a.firstPuttM != null ? Math.round(a.firstPuttM * M_TO_FT) : ''}</td>`);
    rows.edit.push(`<td><button data-edit="${n}">✎</button></td>`);
    if (a.par) tot.par += a.par;
    tot.score += sc.strokes;
    if (sc.strokes && a.fairway) { tot.fwAll++; if (a.fairway === 'hit') tot.fwHit++; }
    if (sc.strokes && a.gir !== null) { tot.girAll++; if (a.gir) tot.gir++; }
    tot.putts += sc.putts;
    if (a.firstPuttM != null) tot.first.push(a.firstPuttM);
  }
  const avgFirst = tot.first.length ? (tot.first.reduce((x, y) => x + y, 0) / tot.first.length) * M_TO_FT : null;
  const line = (label, cells, total, cls = '') => `<tr class="${cls}"><th class="lab">${label}</th>${cells.join('')}<td class="tot">${total}</td></tr>`;
  $('scTable').innerHTML = [
    line('Hole', rows.hole, 'TOTAL', 'hole-row'),
    line('Par', rows.par, tot.par || ''),
    line('Score', rows.score, tot.score || '', 'score-row'),
    line('Fairway', rows.fw, tot.fwAll ? `${tot.fwHit}/${tot.fwAll}` : ''),
    line('GIR', rows.gir, tot.girAll ? `${tot.gir}/${tot.girAll}` : ''),
    line('Putts', rows.putts, tot.putts),
    line('1st Putt (ft)', rows.first, avgFirst ? avgFirst.toFixed(1) : ''),
    line('Edit Hole', rows.edit, ''),
  ].join('');
  $('scStats').textContent = '';

  const tbl = $('scTable');
  tbl.querySelectorAll('[data-fw]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.fw); const h = hole(r, n); h.fairway = cycle(FW_CYCLE, h.fairway); persist(); renderScorecard(); render();
  }));
  tbl.querySelectorAll('[data-gir]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.gir); const h = hole(r, n); h.gir = cycle(GIR_CYCLE, h.gir); persist(); renderScorecard(); render();
  }));
  tbl.querySelectorAll('[data-pp]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.pp); setPutts(r, n, hole(r, n).putts + 1); persist(); renderScorecard(); render();
  }));
  tbl.querySelectorAll('[data-pm]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.pm); setPutts(r, n, hole(r, n).putts - 1); persist(); renderScorecard(); render();
  }));
  tbl.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    $('scorecard').close(); goHole(Number(b.dataset.edit)); editMode = true; undoStack = []; render();
  }));
}

$('scoreBoxBtn').addEventListener('click', openScorecard);
$('holeScoreBtn').addEventListener('click', openScorecard);
$('scEndRound').addEventListener('click', () => {
  const r = playRound();
  if (!r || !confirm('Finish this round? You can still edit it from Activity.')) return;
  finishHole(r, play.n);
  r.finished_at = new Date().toISOString();
  state.active_round_id = null;
  persist();
  $('scorecard').close();
  showHome('activity');
  if (confirm('Round saved on this phone. Make a backup file now?')) {
    saveFile(`golf-backup-${r.date}.json`, JSON.stringify(state), 'application/json');
  }
});
$('scDelete').addEventListener('click', () => {
  const r = playRound();
  if (!r || !confirm(`Delete the ${r.date} round at ${r.course_name}? This can't be undone.`)) return;
  state.rounds = state.rounds.filter((x) => x.id !== r.id);
  persist();
  $('scorecard').close();
  showHome('activity');
});

$('backBtn').addEventListener('click', () => showHome(play && play.mode === 'round' ? (isLive(playRound()) ? 'start' : 'activity') : tab));
$('browseStartBtn').addEventListener('click', async () => {
  const list = await loadIndex();
  const c = list.find((x) => x.id === play.courseId);
  if (c) openStart(c);
});

// ---- Sheets ---------------------------------------------------------------------------------------

function openSheet(id) {
  document.querySelectorAll('.sheet.open').forEach((s) => s.classList.remove('open'));
  $('backdrop').hidden = false;
  $(id).classList.add('open');
}
function closeSheet(id) {
  $(id).classList.remove('open');
  if (!document.querySelector('.sheet.open')) $('backdrop').hidden = true;
}
function closeSheets() {
  document.querySelectorAll('.sheet.open').forEach((s) => s.classList.remove('open'));
  $('backdrop').hidden = true;
}
$('backdrop').addEventListener('click', () => { closeSheets(); clubPick = null; });
document.querySelectorAll('.sheet-cancel').forEach((b) => b.addEventListener('click', () => { closeSheets(); clubPick = null; }));

// ---- Bag ------------------------------------------------------------------------------------------

function openBag() {
  $('bagText').value = state.bag.join('\n');
  $('bagDialog').showModal();
}
$('bagSave').addEventListener('click', () => {
  const clubs = [...new Set($('bagText').value.split('\n').map((c) => c.trim()).filter(Boolean))];
  if (!clubs.length) return;
  state.bag = clubs;
  persist();
  $('bagDialog').close();
  if (!play) renderTab();
});
$('bagReset').addEventListener('click', () => { $('bagText').value = DEFAULT_BAG.join('\n'); });

// ---- Keep the screen on during a round (iOS pauses web apps when it locks) --------------------

async function requestWake() {
  if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* Low Power Mode */ }
}
function releaseWake() {
  wantWake = false;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWake) requestWake();
});

// ---- Start-up ----------------------------------------------------------------------------------------

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const ar = activeRound();
if (ar) openRound(ar.id); else showHome('start');
