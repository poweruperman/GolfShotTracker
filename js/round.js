/*
 * Round data and golf rules. Pure functions only (no screen, no storage),
 * so they can be tested on the computer: node --test tests/*.test.mjs
 *
 * round = {
 *   id, course_id, course_name, date, started_at, finished_at,
 *   current_hole, start_hole, holes_total,
 *   holes: { "1": { putts, end, finished_at, fairway, gir }, ... },
 *   shots: [ { id, hole_no, shot_no, club, lat, lon, accuracy_m, samples,
 *              recorded_at, exclude_from_stats, distance_m,
 *              added_by_hand, moved_by_hand } ]
 * }
 *
 * - Shot N's distance runs from where shot N was hit to where shot N+1 was
 *   hit; the last shot on a hole runs to `end` (the ball on the green,
 *   recorded with the first putt, or the cup on a chip-in).
 * - `fairway` / `gir` on a hole are manual overrides; when null the app
 *   works them out from the course outlines (see analyzeHole).
 */

import { haversineM, distM, pointInPolygon, sideOffset } from './geo.js';

export const DEFAULT_BAG = ['Dr', '3W', '5W', '4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW'];

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function newRound({ course, startHole = 1, now = new Date() }) {
  return {
    id: newId(),
    course_id: course.id,
    course_name: course.name,
    date: localDate(now),
    started_at: now.toISOString(),
    finished_at: null,
    start_hole: startHole,
    current_hole: startHole,
    holes_total: course.holes_expected || course.holes.length || 18,
    holes: {},
    shots: [],
  };
}

export function hole(round, n) {
  const k = String(n);
  if (!round.holes[k]) round.holes[k] = { putts: 0, end: null, finished_at: null, fairway: null, gir: null };
  return round.holes[k];
}

export const shotsOnHole = (round, n) =>
  round.shots.filter((s) => s.hole_no === n).sort((a, b) => a.shot_no - b.shot_no);

const lastShotNo = (round, n) =>
  round.shots.filter((s) => s.hole_no === n).reduce((m, s) => Math.max(m, s.shot_no), 0);

const hasPos = (p) => p && p.lat != null && p.lon != null;

// Renumber a hole's shots in order and recompute every distance on it.
export function recomputeHole(round, n) {
  const shots = round.shots
    .filter((s) => s.hole_no === n)
    .sort((a, b) => a.shot_no - b.shot_no || a.recorded_at.localeCompare(b.recorded_at));
  const end = round.holes[String(n)] ? round.holes[String(n)].end : null;
  shots.forEach((s, i) => {
    s.shot_no = i + 1;
    const target = shots[i + 1] || end || null;
    s.distance_m = hasPos(s) && hasPos(target)
      ? Math.round(haversineM(s.lat, s.lon, target.lat, target.lon) * 10) / 10
      : null;
  });
}

export function addShot(round, { club, pos, holeNo = round.current_hole, now = new Date() }) {
  const shot = {
    id: newId(),
    hole_no: holeNo,
    shot_no: lastShotNo(round, holeNo) + 1,
    club,
    lat: pos ? pos.lat : null,
    lon: pos ? pos.lon : null,
    accuracy_m: pos ? pos.accuracy_m : null,
    samples: pos ? pos.samples : 0,
    recorded_at: pos ? pos.recorded_at : now.toISOString(),
    exclude_from_stats: false,
    distance_m: null,
  };
  round.shots.push(shot);
  recomputeHole(round, holeNo);
  return shot;
}

export const findShot = (round, id) => round.shots.find((s) => s.id === id) || null;

export function editShot(round, id, changes) {
  const s = findShot(round, id);
  if (!s) return null;
  const oldHole = s.hole_no;
  if (changes.club !== undefined) s.club = changes.club;
  if (changes.exclude_from_stats !== undefined) s.exclude_from_stats = !!changes.exclude_from_stats;
  if (changes.hole_no !== undefined && Number(changes.hole_no) !== oldHole) {
    s.hole_no = Number(changes.hole_no);
    s.shot_no = lastShotNo(round, s.hole_no) + 1;
  }
  recomputeHole(round, oldHole);
  if (s.hole_no !== oldHole) recomputeHole(round, s.hole_no);
  return s;
}

export function deleteShot(round, id) {
  const s = findShot(round, id);
  if (!s) return false;
  round.shots = round.shots.filter((x) => x.id !== id);
  recomputeHole(round, s.hole_no);
  return true;
}

export function moveShot(round, id, newIndex) {
  const s = findShot(round, id);
  if (!s) return;
  const others = shotsOnHole(round, s.hole_no).filter((x) => x.id !== id);
  others.splice(Math.max(0, Math.min(newIndex, others.length)), 0, s);
  others.forEach((x, i) => { x.shot_no = i + 1; });
  recomputeHole(round, s.hole_no);
}

export function setShotPosition(round, id, lat, lon) {
  const s = findShot(round, id);
  if (!s) return;
  s.lat = lat;
  s.lon = lon;
  s.moved_by_hand = true;
  recomputeHole(round, s.hole_no);
}

// Where a shot added by hand fits best: the place that adds the least path length.
export function bestInsertIndex(round, n, lat, lon) {
  const shots = shotsOnHole(round, n);
  const pts = shots.filter(hasPos);
  const h = round.holes[String(n)];
  if (h && hasPos(h.end)) pts.push(h.end);
  if (!pts.length) return 0;
  const d = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);
  const p = { lat, lon };
  let best = 0;
  let bestCost = d(p, pts[0]);
  for (let i = 1; i <= pts.length; i++) {
    const cost = i < pts.length ? d(pts[i - 1], p) + d(p, pts[i]) - d(pts[i - 1], pts[i]) : d(pts[i - 1], p);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  return Math.min(best, shots.length);
}

export function insertShot(round, { holeNo, club, lat, lon, index = null, now = new Date() }) {
  const at = index == null ? bestInsertIndex(round, holeNo, lat, lon) : index;
  const s = {
    id: newId(), hole_no: holeNo, shot_no: lastShotNo(round, holeNo) + 1, club, lat, lon,
    accuracy_m: null, samples: 0, recorded_at: now.toISOString(),
    exclude_from_stats: false, distance_m: null, added_by_hand: true,
  };
  round.shots.push(s);
  moveShot(round, s.id, at);
  return s;
}

export function setHoleEnd(round, n, pos) {
  hole(round, n).end = pos;
  recomputeHole(round, n);
}

export function setPutts(round, n, putts) {
  hole(round, n).putts = Math.max(0, putts);
}

export function finishHole(round, n, now = new Date()) {
  hole(round, n).finished_at = now.toISOString();
}

export function nextHoleNo(round, n) {
  return n >= round.holes_total ? 1 : n + 1;
}

// ---- Scoring -------------------------------------------------------------------------

export function holeScore(round, n) {
  const shots = shotsOnHole(round, n).length;
  const h = round.holes[String(n)];
  const putts = h ? h.putts : 0;
  return { shots, putts, strokes: shots + putts };
}

/*
 * Score vs par across holes that have both a score and a par.
 * parOf(n) returns the hole's par or null.
 */
export function scoreToPar(round, parOf) {
  let diff = 0;
  let holes = 0;
  let strokes = 0;
  for (let n = 1; n <= round.holes_total; n++) {
    const { strokes: st } = holeScore(round, n);
    if (!st) continue;
    strokes += st;
    const par = parOf(n);
    if (par) { diff += st - par; holes++; }
  }
  return { diff, holes, strokes };
}

export const fmtToPar = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);
export function toParWords(d) {
  if (d === 0) return 'Par';
  return d > 0 ? `${d} Over` : `${-d} Under`;
}

// ---- Shot results, fairway and GIR (from the course outlines) ----------------------

const CHIP_M = 45; // shots starting within ~50 yds of the green are chips/pitches

/*
 * Work out, for one hole: each shot's result label, fairway hit, green in
 * regulation and the first putt's distance. `ch` is the course hole:
 * { par, tee, green_center, green (outline), fairways: [outline, ...] }.
 * Manual overrides on the round's hole win over what is computed here.
 */
export function analyzeHole(round, n, ch) {
  const shots = shotsOnHole(round, n);
  const h = round.holes[String(n)] || { putts: 0, end: null };
  const par = ch && ch.par ? ch.par : null;
  const green = ch && ch.green && ch.green.length >= 3 ? ch.green : null;
  const gc = ch ? ch.green_center : null;
  const onGreen = (p) => (green ? pointInPolygon(p, green) : null);

  // Where each shot finished: the next shot's spot, or the hole's end point.
  const after = shots.map((s, i) => {
    const nx = shots[i + 1];
    if (nx && hasPos(nx)) return [nx.lat, nx.lon];
    if (!nx && hasPos(h.end)) return [h.end.lat, h.end.lon];
    return null;
  });

  const labels = shots.map((s, i) => {
    const from = hasPos(s) ? [s.lat, s.lon] : null;
    const to = after[i];
    const stroke = i + 1;
    const isLast = i === shots.length - 1;
    // The last shot before putting finished on the green (we putted from there).
    const reachedGreen = to ? (onGreen(to) ?? (isLast && h.putts > 0)) : (isLast && h.putts > 0);
    if (i === 0 && par && par >= 4) {
      if (!to) return 'Tee Shot';
      const fw = fairwayResult(ch, from || (ch && ch.tee), to);
      return { hit: 'Hit Fairway', left: 'Missed Left', right: 'Missed Right' }[fw] || 'Tee Shot';
    }
    if (from && gc && distM(from, gc) <= CHIP_M) return 'Chip/Pitch';
    if (reachedGreen) return par && stroke <= par - 2 ? 'Hit GIR' : 'Hit Green';
    if (par && stroke === par - 2) return 'Missed GIR';
    if (to && gc && par && stroke < par - 2 && distM(to, gc) > 55) return 'Lay Up';
    return 'Missed Green';
  });

  // Fairway: tee shot on a par 4 or 5.
  let fairway = null;
  if (par && par >= 4 && shots.length && after[0]) {
    const s0 = shots[0];
    fairway = fairwayResult(ch, hasPos(s0) ? [s0.lat, s0.lon] : ch.tee, after[0]);
  }
  if (h.fairway) fairway = h.fairway;

  // GIR: on the green in (par - 2) strokes or fewer. Putting means we were on.
  let gir = null;
  if (par && (shots.length || h.putts)) {
    let strokesToGreen = null;
    for (let i = 0; i < shots.length; i++) {
      if (after[i] && onGreen(after[i])) { strokesToGreen = i + 1; break; }
    }
    if (strokesToGreen == null && h.putts > 0) strokesToGreen = shots.length;
    if (strokesToGreen == null && h.finished_at && h.putts === 0) strokesToGreen = shots.length; // holed out
    gir = strokesToGreen != null && strokesToGreen <= par - 2;
  }
  if (h.gir !== null && h.gir !== undefined) gir = h.gir;

  // First putt: ball-on-green spot to the green's center (the pin moves daily,
  // so this is an estimate).
  const firstPuttM = hasPos(h.end) && h.putts > 0 && gc ? distM([h.end.lat, h.end.lon], gc) : null;

  return { labels, fairway, gir, firstPuttM, par };
}

// 'hit', 'left', 'right' or null (no fairway outline to judge by).
export function fairwayResult(ch, from, to) {
  if (!ch || !ch.fairways || !ch.fairways.length || !to) return null;
  if (ch.fairways.some((f) => pointInPolygon(to, f))) return 'hit';
  const a = from || ch.tee;
  return sideOffset(a, ch.green_center, to) > 0 ? 'right' : 'left';
}

// ---- Club statistics ------------------------------------------------------------------

/*
 * Average distance per club over many rounds. Leaves out shots flagged
 * "exclude from stats", chips/pitches (not full swings) and shots without
 * a measured distance. courseHoleOf(round, n) returns the course hole or null.
 */
export function clubStats(rounds, courseHoleOf) {
  const by = {};
  for (const r of rounds) {
    const done = new Set();
    for (const s of r.shots) {
      if (done.has(s.hole_no)) continue;
      done.add(s.hole_no);
      const a = analyzeHole(r, s.hole_no, courseHoleOf(r, s.hole_no));
      shotsOnHole(r, s.hole_no).forEach((sh, i) => {
        if (sh.exclude_from_stats || sh.distance_m == null || a.labels[i] === 'Chip/Pitch') return;
        (by[sh.club] = by[sh.club] || []).push(sh.distance_m);
      });
    }
  }
  const out = {};
  for (const [club, ds] of Object.entries(by)) {
    const sorted = [...ds].sort((x, y) => x - y);
    out[club] = {
      count: ds.length,
      avg_m: ds.reduce((x, y) => x + y, 0) / ds.length,
      median_m: sorted[Math.floor(sorted.length / 2)],
      max_m: sorted[sorted.length - 1],
      min_m: sorted[0],
    };
  }
  return out;
}

// ---- Export ---------------------------------------------------------------------------

const CSV_COLS = ['round_id', 'date', 'course', 'hole_no', 'shot_no', 'club', 'lat', 'lon',
  'accuracy_m', 'samples', 'recorded_at', 'distance_m', 'distance_yd', 'exclude_from_stats',
  'added_by_hand', 'moved_by_hand', 'hole_putts'];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function shotsToCsv(rounds) {
  const rows = [CSV_COLS.join(',')];
  for (const r of rounds) {
    for (const s of [...r.shots].sort((a, b) => a.hole_no - b.hole_no || a.shot_no - b.shot_no)) {
      const h = r.holes[String(s.hole_no)];
      const row = {
        round_id: r.id, date: r.date, course: r.course_name, ...s,
        distance_yd: s.distance_m == null ? null : Math.round(s.distance_m * 1.0936133 * 10) / 10,
        added_by_hand: !!s.added_by_hand, moved_by_hand: !!s.moved_by_hand,
        hole_putts: h ? h.putts : 0,
      };
      rows.push(CSV_COLS.map((c) => csvCell(row[c])).join(','));
    }
  }
  return rows.join('\n');
}
