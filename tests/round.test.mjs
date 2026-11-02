/*
 * Unit tests for the round rules and the map math.
 * Run on the computer: node --test tests/*.test.mjs
 * Every coordinate here is made up (the repository is public).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM, mercPx, mercToLatLon, latLonToImage, imageToLatLon, greenDistances, sideOffset,
  pointInPolygon,
} from '../js/geo.js';
import {
  newRound, addShot, setHoleEnd, editShot, deleteShot, moveShot, insertShot, setShotPosition,
  setPutts, holeScore, scoreToPar, fmtToPar, toParWords, analyzeHole, clubStats, shotsOnHole,
  finishHole, nextHoleNo, shotsToCsv, hole,
} from '../js/round.js';

// A made-up straight hole running due north from (10.0, 20.0).
// 0.001° of latitude ≈ 111.2 m.
const LAT = 10.0;
const LON = 20.0;
const P = (dLat, dLon = 0) => [LAT + dLat, LON + dLon];
const box = (cLat, cLon, h, w) => [[cLat - h, cLon - w], [cLat - h, cLon + w], [cLat + h, cLon + w], [cLat + h, cLon - w]];
const HOLE = {
  n: 1, par: 4,
  tee: P(0),
  green_center: P(0.0035),
  green: box(LAT + 0.0035, LON, 0.00013, 0.00013), // ~30 m across
  fairways: [box(LAT + 0.002, LON, 0.0012, 0.00025)], // ~55 m wide strip
};
const COURSE = { id: 'test', name: 'Made-up Links', holes_expected: 18, holes: [HOLE] };

let clock = Date.UTC(2026, 0, 1, 12);
const at = (lat, lon) => {
  clock += 60000;
  return { lat, lon, accuracy_m: 4, samples: 5, recorded_at: new Date(clock).toISOString() };
};
const shotAt = (r, club, p) => addShot(r, { club, pos: at(p[0], p[1]) });

test('haversine: 0.001° of latitude is about 111.2 m', () => {
  const d = haversineM(10, 20, 10.001, 20);
  assert.ok(Math.abs(d - 111.2) < 0.1, `got ${d}`);
});

test('Mercator pixels round-trip to the same lat/lon', () => {
  const [x, y] = mercPx(33.8, -117.9, 18);
  const [lat, lon] = mercToLatLon(x, y, 18);
  assert.ok(Math.abs(lat - 33.8) < 1e-9 && Math.abs(lon + 117.9) < 1e-9);
});

test('image transform: lat/lon -> image pixel -> lat/lon', () => {
  // A made-up image: 0.5 scale and 30° rotation of Mercator pixels plus an offset.
  const [X0, Y0] = mercPx(33.8, -117.9, 18);
  const c = Math.cos(Math.PI / 6) * 0.5;
  const s = Math.sin(Math.PI / 6) * 0.5;
  const img = { z: 18, m: [c, -s, -(c * X0 - s * Y0) + 400, s, c, -(s * X0 + c * Y0) + 600] };
  const [u, v] = latLonToImage(img, 33.8, -117.9);
  assert.ok(Math.abs(u - 400) < 1e-6 && Math.abs(v - 600) < 1e-6);
  const [lat, lon] = imageToLatLon(img, 123, 456);
  const [u2, v2] = latLonToImage(img, lat, lon);
  assert.ok(Math.abs(u2 - 123) < 1e-6 && Math.abs(v2 - 456) < 1e-6);
});

test('front / center / back of the green from the tee', () => {
  const g = greenDistances(HOLE.tee, HOLE.green, HOLE.green_center);
  assert.ok(Math.abs(g.center - 389.2) < 0.5, `center ${g.center}`);
  assert.ok(Math.abs(g.front - (389.2 - 14.5)) < 0.5, `front ${g.front}`);
  assert.ok(Math.abs(g.back - (389.2 + 14.5)) < 0.5, `back ${g.back}`);
});

test('side of the line and point in polygon', () => {
  assert.ok(sideOffset(HOLE.tee, HOLE.green_center, P(0.002, 0.001)) > 0, 'east of a northward line is right');
  assert.ok(sideOffset(HOLE.tee, HOLE.green_center, P(0.002, -0.001)) < 0);
  assert.equal(pointInPolygon(P(0.0035), HOLE.green), true);
  assert.equal(pointInPolygon(P(0.003), HOLE.green), false);
});

test('shot distance goes to the next shot; the last shot to the ball on the green', () => {
  const r = newRound({ course: COURSE });
  const dr = shotAt(r, 'Dr', P(0));
  assert.equal(dr.distance_m, null);
  const iron = shotAt(r, '8i', P(0.002));
  assert.ok(Math.abs(dr.distance_m - 222.4) < 0.2);
  setHoleEnd(r, 1, at(...P(0.0034)));
  assert.ok(Math.abs(iron.distance_m - 155.7) < 0.2);
});

test('results: fairway hit, GIR, first putt; missed left; chip', () => {
  const r = newRound({ course: COURSE });
  shotAt(r, 'Dr', P(0));
  shotAt(r, '8i', P(0.002));            // in the fairway
  setHoleEnd(r, 1, at(...P(0.0035, 0.00005)));
  setPutts(r, 1, 2);
  let a = analyzeHole(r, 1, HOLE);
  assert.deepEqual(a.labels, ['Hit Fairway', 'Hit GIR']);
  assert.equal(a.fairway, 'hit');
  assert.equal(a.gir, true);
  assert.ok(a.firstPuttM > 3 && a.firstPuttM < 8, `first putt ${a.firstPuttM}`);

  const r2 = newRound({ course: COURSE });
  shotAt(r2, 'Dr', P(0));
  shotAt(r2, '7i', P(0.002, -0.0006));   // west of the fairway = left
  shotAt(r2, 'SW', P(0.0033, 0.0002));   // short of the green, within chip range
  setHoleEnd(r2, 1, at(...P(0.0035)));
  setPutts(r2, 1, 1);
  a = analyzeHole(r2, 1, HOLE);
  assert.deepEqual(a.labels, ['Missed Left', 'Missed GIR', 'Chip/Pitch']);
  assert.equal(a.fairway, 'left');
  assert.equal(a.gir, false);
});

test('manual fairway / GIR choices win over the computed ones', () => {
  const r = newRound({ course: COURSE });
  shotAt(r, 'Dr', P(0));
  shotAt(r, '8i', P(0.002));
  hole(r, 1).fairway = 'right';
  hole(r, 1).gir = false;
  setPutts(r, 1, 2);
  const a = analyzeHole(r, 1, HOLE);
  assert.equal(a.fairway, 'right');
  assert.equal(a.gir, false);
});

test('editing: reorder, add a missed shot, drag, delete, change club and hole', () => {
  const r = newRound({ course: COURSE });
  const a = shotAt(r, 'Dr', P(0));
  const b = shotAt(r, 'PW', P(0.003));
  const added = insertShot(r, { holeNo: 1, club: '7i', lat: LAT + 0.00205, lon: LON + 0.00005 });
  assert.deepEqual(shotsOnHole(r, 1).map((s) => s.club), ['Dr', '7i', 'PW']);
  assert.equal(added.added_by_hand, true);
  moveShot(r, b.id, 0);
  assert.deepEqual(shotsOnHole(r, 1).map((s) => s.club), ['PW', 'Dr', '7i']);
  moveShot(r, b.id, 2);
  setShotPosition(r, added.id, LAT + 0.001, LON);
  assert.ok(Math.abs(a.distance_m - 111.2) < 0.2);
  editShot(r, a.id, { club: '3W', exclude_from_stats: true });
  assert.equal(a.club, '3W');
  deleteShot(r, added.id);
  assert.ok(Math.abs(a.distance_m - 333.6) < 0.3);
  editShot(r, b.id, { hole_no: 2 });
  assert.equal(b.shot_no, 1);
  assert.equal(a.distance_m, null);
});

test('scoring: strokes, score to par, words, hole wrap', () => {
  const r = newRound({ course: COURSE });
  shotAt(r, 'Dr', P(0));
  shotAt(r, '8i', P(0.002));
  setPutts(r, 1, 3);
  setPutts(r, 1, -1); // can't go below zero
  setPutts(r, 1, 3);
  assert.deepEqual(holeScore(r, 1), { shots: 2, putts: 3, strokes: 5 });
  const sp = scoreToPar(r, (n) => (n === 1 ? 4 : null));
  assert.deepEqual(sp, { diff: 1, holes: 1, strokes: 5 });
  assert.equal(fmtToPar(1), '+1');
  assert.equal(fmtToPar(0), 'E');
  assert.equal(toParWords(4), '4 Over');
  assert.equal(toParWords(-1), '1 Under');
  assert.equal(nextHoleNo(r, 18), 1);
  finishHole(r, 1);
  assert.ok(r.holes['1'].finished_at);
});

test('club stats skip chips and excluded shots', () => {
  const r = newRound({ course: COURSE });
  shotAt(r, 'Dr', P(0));
  shotAt(r, '8i', P(0.002));
  shotAt(r, 'SW', P(0.0033));
  setHoleEnd(r, 1, at(...P(0.0035)));
  setPutts(r, 1, 1);
  const st = clubStats([r], () => HOLE);
  assert.ok(Math.abs(st.Dr.avg_m - 222.4) < 0.2);
  assert.equal(st.SW, undefined, 'chip left out');
  editShot(r, shotsOnHole(r, 1)[0].id, { exclude_from_stats: true });
  assert.equal(clubStats([r], () => HOLE).Dr, undefined);
});

test('CSV export has one row per shot', () => {
  const r = newRound({ course: COURSE });
  shotAt(r, 'Dr', P(0));
  shotAt(r, '8i', P(0.002));
  const lines = shotsToCsv([r]).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('round_id,date,course'));
});
