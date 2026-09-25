/*
 * Unit tests for the pure round/distance logic.
 * Run on the computer with:  node --test tests/*.test.mjs
 * All coordinates here are made up (the repository is public).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM } from '../js/geo.js';
import {
  newRound, addShot, setHoleEnd, editShot, deleteShot, addPutt, removePutt,
  finishHole, holeSummary, totalStrokes, shotsToCsv, shotsOnHole,
} from '../js/round.js';

// Made-up spot. 0.001° of latitude is about 111.2 m anywhere on Earth.
const BASE = { lat: 10.0, lon: 20.0 };
let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
function pos(dLat) {
  clock += 60_000; // each press one minute after the previous
  return { lat: BASE.lat + dLat, lon: BASE.lon, accuracy_m: 4, samples: 5,
    recorded_at: new Date(clock).toISOString() };
}

test('haversine: 0.001° of latitude is about 111.2 m', () => {
  const d = haversineM(10, 20, 10.001, 20);
  assert.ok(Math.abs(d - 111.2) < 0.2, `got ${d}`);
});

test('shot distance is measured to the next press, attributed to the earlier club', () => {
  const r = newRound({ course: 'Test', now: new Date(clock) });
  const drive = addShot(r, { club: 'Dr', pos: pos(0) });
  assert.equal(drive.distance_m, null, 'unknown until the next press');
  const iron = addShot(r, { club: '7i', pos: pos(0.002) });
  assert.ok(Math.abs(drive.distance_m - 222.4) < 0.5, `drive ${drive.distance_m}`);
  assert.ok(Math.abs(drive.distance_yd - 243.2) < 0.6, `drive yd ${drive.distance_yd}`);
  assert.equal(iron.distance_m, null);
  assert.deepEqual(shotsOnHole(r, 1).map((s) => s.shot_no), [1, 2]);
});

test('ball-on-green end point gives the last shot a distance; later shots ignore a stale end', () => {
  const r = newRound({ now: new Date(clock) });
  addShot(r, { club: 'Dr', pos: pos(0) });
  const approach = addShot(r, { club: '9i', pos: pos(0.002) });
  setHoleEnd(r, 1, pos(0.003));
  assert.ok(Math.abs(approach.distance_m - 111.2) < 0.3);

  // A chip after the end point was recorded: the end point is older than the
  // chip, so it must not be used as the chip's destination.
  const chip = addShot(r, { club: 'SW', pos: pos(0.0031) });
  assert.equal(chip.distance_m, null);
});

test('a shot with no GPS still counts but has no distance, and neither does the one before', () => {
  const r = newRound({ now: new Date(clock) });
  const a = addShot(r, { club: 'Dr', pos: pos(0) });
  clock += 60_000;
  addShot(r, { club: '7i', pos: null, now: new Date(clock) });
  assert.equal(a.distance_m, null);
  assert.equal(holeSummary(r, 1).shots, 2);
});

test('editing club, hole and exclude flag, and deleting, keep numbering and distances consistent', () => {
  const r = newRound({ now: new Date(clock) });
  const a = addShot(r, { club: 'Dr', pos: pos(0) });
  const b = addShot(r, { club: '7i', pos: pos(0.001) });
  const c = addShot(r, { club: 'PW', pos: pos(0.0015) });

  editShot(r, a.id, { club: '3W', exclude_from_stats: true });
  assert.equal(a.club, '3W');
  assert.equal(a.exclude_from_stats, true);

  // Delete the middle shot: shot 1 now measures to the old shot 3.
  deleteShot(r, b.id);
  assert.deepEqual(shotsOnHole(r, 1).map((s) => s.club), ['3W', 'PW']);
  assert.ok(Math.abs(a.distance_m - 166.8) < 0.4, `after delete ${a.distance_m}`);

  // Move the last shot to hole 2: it becomes shot 1 there, and hole 1's shot
  // loses its destination.
  editShot(r, c.id, { hole_no: 2 });
  assert.equal(c.shot_no, 1);
  assert.equal(a.distance_m, null);
});

test('putts, finishing a hole and total strokes', () => {
  const r = newRound({ now: new Date(clock) });
  addShot(r, { club: 'Dr', pos: pos(0) });
  addShot(r, { club: '8i', pos: pos(0.002) });
  addPutt(r, 1); addPutt(r, 1); addPutt(r, 1); removePutt(r, 1);
  assert.deepEqual(holeSummary(r, 1), { shots: 2, putts: 2, strokes: 4, finished: false });

  finishHole(r, new Date(clock));
  assert.equal(r.current_hole, 2);
  assert.equal(holeSummary(r, 1).finished, true);
  removePutt(r, 2); // can't go below zero
  addShot(r, { club: 'Dr', pos: pos(0.01) });
  assert.equal(totalStrokes(r), 5);
});

test('CSV has a header and one row per shot, with quoting', () => {
  const r = newRound({ course: 'Made-up Links, North', now: new Date(clock) });
  addShot(r, { club: 'Dr', pos: pos(0) });
  addShot(r, { club: '7i', pos: pos(0.001) });
  const lines = shotsToCsv([r]).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('round_id,date,course,hole_no'));
  assert.ok(lines[1].includes('"Made-up Links, North"'));
});
