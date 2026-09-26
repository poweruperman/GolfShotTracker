/*
 * Round data: pure functions with no screen or storage code, so they can be
 * tested on the computer (see tests/round.test.mjs).
 *
 * A round looks like this (all distances in meters, coordinates in degrees):
 *
 *   {
 *     id, course, date, started_at, finished_at, current_hole,
 *     holes: { "1": { putts, end, finished_at }, ... },
 *     shots: [ { id, hole_no, shot_no, club, lat, lon, accuracy_m, samples,
 *                recorded_at, exclude_from_stats, distance_m, distance_yd } ]
 *   }
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
  if (!round.holes[key]) round.holes[key] = { putts: 0, end: null, finished_at: null };
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
    shot_no: 0, // set by recomputeHole
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

const hasPos = (p) => p && p.lat != null && p.lon != null;

/*
 * Number the shots on a hole in time order and work out each distance:
 * shot N's distance = from where shot N was pressed to where shot N+1 was
 * pressed. The last shot uses the hole's end point, if it was recorded after
 * that shot. Distances are recomputed from scratch after every edit, so
 * fixing a club, deleting a shot or moving it to another hole always leaves
 * the numbers consistent.
 */
export function recomputeHole(round, holeNo) {
  const shots = round.shots
    .filter((s) => s.hole_no === holeNo)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const end = round.holes[String(holeNo)] ? round.holes[String(holeNo)].end : null;

  shots.forEach((s, i) => {
    s.shot_no = i + 1;
    let target = shots[i + 1] || null;
    if (!target && end && end.recorded_at >= s.recorded_at) target = end;
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
  if (changes.hole_no !== undefined) shot.hole_no = Number(changes.hole_no);
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
  return { shots, putts, strokes: shots + putts, finished: !!(h && h.finished_at) };
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
  'hole_putts'];

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
      };
      rows.push(CSV_COLS.map((c) => csvCell(row[c])).join(','));
    }
  }
  return rows.join('\n');
}
