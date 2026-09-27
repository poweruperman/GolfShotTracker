/*
 * Round data: pure functions with no screen or storage code, so they can be
 * tested on the computer (see tests/round.test.mjs).
 *
 * A round looks like this (all distances in meters, coordinates in degrees):
 *
 *   {
 *     id, course, date, started_at, finished_at, current_hole,
 *     holes: { "1": { putts, end, finished_at, par, fairway, gir }, ... },
 *     shots: [ { id, hole_no, shot_no, club, lat, lon, accuracy_m, samples,
 *                recorded_at, exclude_from_stats, distance_m, distance_yd,
 *                added_by_hand, moved_by_hand } ]
 *   }
 *
 * Shot order on a hole is `shot_no`: new shots go at the end, and the order
 * can be changed by hand (moveShot) or a missed shot inserted (insertShot).
 *
 * `end` is where the last full shot of a hole finished: the ball on the green
 * (recorded with the first putt) or the cup (a chip-in). It lets the last
 * shot of a hole get a distance too.
 */

import { haversineM, M_TO_YD } from './geo.js';

export const DEFAULT_BAG = ['Dr', '3W', '5W', '4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW'];

// Short random id; good enough to tell rounds and shots apart on one phone.
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function newRound({ course = '', startHole = 1, now = new Date() } = {}) {
  return {
    id: newId(),
    course: course.trim(),
    date: localDate(now),
    started_at: now.toISOString(),
    finished_at: null,
    current_hole: startHole,
    holes: {},
    shots: [],
  };
}

// Returns the hole record, creating an empty one the first time it's needed.
export function hole(round, holeNo) {
  const key = String(holeNo);
  if (!round.holes[key]) {
    round.holes[key] = { putts: 0, end: null, finished_at: null, par: null, fairway: null, gir: null };
  }
  return round.holes[key];
}

export const shotsOnHole = (round, holeNo) =>
  round.shots.filter((s) => s.hole_no === holeNo).sort((a, b) => a.shot_no - b.shot_no);

/*
 * Record a shot. `pos` is the GPS result, or null if the GPS failed (the shot
 * still counts toward the score; it just has no position or distance).
 */
export function addShot(round, { club, pos, now = new Date() }) {
  const shot = {
    id: newId(),
    hole_no: round.current_hole,
    shot_no: lastShotNo(round, round.current_hole) + 1, // goes at the end
    club,
    lat: pos ? pos.lat : null,
    lon: pos ? pos.lon : null,
    accuracy_m: pos ? pos.accuracy_m : null,
    samples: pos ? pos.samples : 0,
    recorded_at: pos ? pos.recorded_at : now.toISOString(),
    exclude_from_stats: false,
    distance_m: null,
    distance_yd: null,
  };
  round.shots.push(shot);
  recomputeHole(round, shot.hole_no);
  return shot;
}

function lastShotNo(round, holeNo) {
  return round.shots.filter((s) => s.hole_no === holeNo).reduce((m, s) => Math.max(m, s.shot_no), 0);
}

const hasPos = (p) => p && p.lat != null && p.lon != null;

/*
 * Renumber the shots on a hole 1, 2, 3… in their current order and work out
 * each distance: shot N's distance = from where shot N was hit to where
 * shot N+1 was hit. The last shot measures to the hole's end point (ball on
 * the green, or the cup) if there is one. Distances are recomputed from
 * scratch after every edit, so fixing a club, reordering, adding, moving or
 * deleting a shot always leaves the numbers consistent.
 */
export function recomputeHole(round, holeNo) {
  const shots = round.shots
    .filter((s) => s.hole_no === holeNo)
    .sort((a, b) => a.shot_no - b.shot_no || a.recorded_at.localeCompare(b.recorded_at));
  const end = round.holes[String(holeNo)] ? round.holes[String(holeNo)].end : null;

  shots.forEach((s, i) => {
    s.shot_no = i + 1;
    const target = shots[i + 1] || end || null;
    if (hasPos(s) && hasPos(target)) {
      s.distance_m = Math.round(haversineM(s.lat, s.lon, target.lat, target.lon) * 10) / 10;
      s.distance_yd = Math.round(s.distance_m * M_TO_YD * 10) / 10;
    } else {
      s.distance_m = null;
      s.distance_yd = null;
    }
  });
}

export function findShot(round, shotId) {
  return round.shots.find((s) => s.id === shotId) || null;
}

// changes: any of { club, hole_no, exclude_from_stats }
export function editShot(round, shotId, changes) {
  const shot = findShot(round, shotId);
  if (!shot) return null;
  const oldHole = shot.hole_no;
  if (changes.club !== undefined) shot.club = changes.club;
  if (changes.exclude_from_stats !== undefined) shot.exclude_from_stats = !!changes.exclude_from_stats;
  if (changes.hole_no !== undefined && Number(changes.hole_no) !== oldHole) {
    shot.hole_no = Number(changes.hole_no);
    shot.shot_no = lastShotNo(round, shot.hole_no) + 1; // joins the end of that hole
  }
  recomputeHole(round, oldHole);
  if (shot.hole_no !== oldHole) recomputeHole(round, shot.hole_no);
  return shot;
}

export function deleteShot(round, shotId) {
  const shot = findShot(round, shotId);
  if (!shot) return false;
  round.shots = round.shots.filter((s) => s.id !== shotId);
  recomputeHole(round, shot.hole_no);
  return true;
}

// Put a shot at a new place in its hole's order (0 = first).
export function moveShot(round, shotId, newIndex) {
  const shot = findShot(round, shotId);
  if (!shot) return;
  const others = shotsOnHole(round, shot.hole_no).filter((s) => s.id !== shotId);
  const i = Math.max(0, Math.min(newIndex, others.length));
  others.splice(i, 0, shot);
  others.forEach((s, n) => { s.shot_no = n + 1; });
  recomputeHole(round, shot.hole_no);
}

// Change where a shot was hit (dragged on the map).
export function setShotPosition(round, shotId, lat, lon) {
  const shot = findShot(round, shotId);
  if (!shot) return;
  shot.lat = lat;
  shot.lon = lon;
  shot.moved_by_hand = true;
  recomputeHole(round, shot.hole_no);
}

/*
 * Where a shot added by hand fits best in the hole's order: the position
 * that adds the least walking distance to the path tee -> ... -> end point.
 * The player can still reorder afterwards.
 */
export function bestInsertIndex(round, holeNo, lat, lon) {
  const pts = shotsOnHole(round, holeNo).filter(hasPos);
  const h = round.holes[String(holeNo)];
  if (h && hasPos(h.end)) pts.push(h.end);
  if (!pts.length) return 0;
  const d = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);
  const p = { lat, lon };
  let best = 0;
  let bestCost = d(p, pts[0]); // before the first shot
  for (let i = 1; i <= pts.length; i++) {
    const cost = i < pts.length ? d(pts[i - 1], p) + d(p, pts[i]) - d(pts[i - 1], pts[i]) : d(pts[i - 1], p);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  // An insert after the end point still belongs before it in the shot list.
  const shotCount = shotsOnHole(round, holeNo).length;
  return Math.min(best, shotCount);
}

// Add a shot the player forgot to record, at a spot tapped on the map.
export function insertShot(round, { holeNo, club, lat, lon, index = null, now = new Date() }) {
  // Work out the position before adding the shot, so it isn't compared with itself.
  const at = index == null ? bestInsertIndex(round, holeNo, lat, lon) : index;
  const shot = {
    id: newId(),
    hole_no: holeNo,
    shot_no: lastShotNo(round, holeNo) + 1,
    club,
    lat, lon,
    accuracy_m: null,
    samples: 0,
    recorded_at: now.toISOString(),
    exclude_from_stats: false,
    distance_m: null,
    distance_yd: null,
    added_by_hand: true,
  };
  round.shots.push(shot);
  moveShot(round, shot.id, at);
  return shot;
}

// ---- Scorecard fields (entered by hand for now) ----------------------------------

export const setPar = (round, holeNo, par) => { hole(round, holeNo).par = par; };
// fairway: null (not set), 'hit', 'left', 'right'
export const setFairway = (round, holeNo, v) => { hole(round, holeNo).fairway = v; };
// gir (green in regulation): null (not set), true, false
export const setGir = (round, holeNo, v) => { hole(round, holeNo).gir = v; };

// Where the ball finished on this hole (ball on the green, or the cup).
export function setHoleEnd(round, holeNo, pos) {
  hole(round, holeNo).end = pos;
  recomputeHole(round, holeNo);
}

export function addPutt(round, holeNo) {
  hole(round, holeNo).putts++;
}

export function removePutt(round, holeNo) {
  const h = hole(round, holeNo);
  if (h.putts > 0) h.putts--;
}

export function holeSummary(round, holeNo) {
  const shots = shotsOnHole(round, holeNo).length;
  const h = round.holes[String(holeNo)];
  const putts = h ? h.putts : 0;
  const strokes = shots + putts;
  const par = h && h.par ? h.par : null;
  return {
    shots, putts, strokes, par,
    toPar: par && strokes ? strokes - par : null,
    fairway: h ? h.fairway ?? null : null,
    gir: h ? h.gir ?? null : null,
    finished: !!(h && h.finished_at),
  };
}

// Strokes over/under par, counting only holes that have a par and a score.
export function scoreToPar(round) {
  let diff = 0;
  let holes = 0;
  for (const key of Object.keys(round.holes)) {
    const sum = holeSummary(round, Number(key));
    if (sum.toPar !== null) { diff += sum.toPar; holes++; }
  }
  return { diff, holes };
}

// "E", "+3", "-1"
export const fmtToPar = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);

// "Par", "2 Over", "1 Under", as on a scorecard
export function toParWords(d) {
  if (d === 0) return 'Par';
  return d > 0 ? `${d} Over` : `${-d} Under`;
}

export const HOLES = 18;

// Next/previous hole number, wrapping 18 -> 1 (for rounds started on the back nine).
export const nextHoleNo = (n) => (n >= HOLES ? 1 : n + 1);
export const prevHoleNo = (n) => (n <= 1 ? HOLES : n - 1);

// Close the current hole and move to the next one.
export function finishHole(round, now = new Date()) {
  hole(round, round.current_hole).finished_at = now.toISOString();
  round.current_hole = nextHoleNo(round.current_hole);
}

export const finishedHoleCount = (round) =>
  Object.values(round.holes).filter((h) => h.finished_at).length;

export function totalStrokes(round) {
  const holeNos = new Set([
    ...round.shots.map((s) => s.hole_no),
    ...Object.keys(round.holes).map(Number),
  ]);
  let total = 0;
  for (const n of holeNos) total += holeSummary(round, n).strokes;
  return total;
}

// ---- Export ------------------------------------------------------------------

const CSV_COLS = ['round_id', 'date', 'course', 'hole_no', 'shot_no', 'club', 'lat', 'lon',
  'accuracy_m', 'samples', 'recorded_at', 'distance_m', 'distance_yd', 'exclude_from_stats',
  'hole_putts', 'hole_par', 'added_by_hand', 'moved_by_hand'];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per shot, across all rounds given.
export function shotsToCsv(rounds) {
  const rows = [CSV_COLS.join(',')];
  for (const r of rounds) {
    const shots = [...r.shots].sort((a, b) => a.hole_no - b.hole_no || a.shot_no - b.shot_no);
    for (const s of shots) {
      const h = r.holes[String(s.hole_no)];
      const row = {
        round_id: r.id, date: r.date, course: r.course, ...s,
        hole_putts: h ? h.putts : 0,
        hole_par: h && h.par ? h.par : '',
        added_by_hand: !!s.added_by_hand,
        moved_by_hand: !!s.moved_by_hand,
      };
      rows.push(CSV_COLS.map((c) => csvCell(row[c])).join(','));
    }
  }
  return rows.join('\n');
}
