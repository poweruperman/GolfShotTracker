# Golf Shot Tracker

A free golf GPS and shot tracker for iPhone, built as a web app (installed
from Safari with **Share → Add to Home Screen**). It works like a dedicated
golf GPS app: each hole fills the screen on an aerial photo with the tee at
the bottom, you get live distances to the green, and every shot is drawn with
its club and yardage. There are no sensors: you tap the club before each shot.

**Live app:** https://poweruperman.github.io/GolfShotTracker/

## Using it on the course

1. **Start Round** tab → pick the course (nearest first) → starting hole →
   **Start round**. The course's hole photos download for offline use.
2. Walk to your ball. **Stand at the ball** (not in the cart), tap **+ SHOT**,
   and pick the club you're about to hit. The app listens to the GPS for a
   few seconds and saves the most accurate position.
3. When you record the next shot, the previous one gets its distance:
   from where you hit it to where you hit the next one. That's
   **carry + roll, not carry**.
4. On the green, tap **+** under PUTTS for each putt. The **first** putt also
   marks where your ball is, which gives the approach shot its distance.
5. After you putt out, the next **+ SHOT** moves to the next hole by itself.
   Use the hole numbers at the top to jump anywhere.
6. When you're done: tap the score box (top right) → **Finish round**.

### On the hole screen

| What | Does |
|---|---|
| **F / C / B** (top left) | Live yards to the front, center and back of the green, when you're on the hole |
| Tap the photo | Drops a target: yards from you (or your last shot) to it, and from it to the green |
| Pinch / double-tap | Zoom in and out; drag to look around |
| ☰ | This hole's shots with results: Hit Fairway, Missed Left/Right, Hit GIR, Missed GIR, Lay Up, Chip/Pitch |
| **EDIT** | Drag a shot to where it really was, tap the photo to add a missed shot, tap a shot to change its club, move it earlier/later, exclude it from stats or delete it. **Undo** works step by step |
| Score box / SCORE | Scorecard: par, score, fairway, GIR, putts (+/−), 1st putt (ft), ✎ edit a hole |

Fairway and GIR are worked out from the course map. Tap them on the
scorecard to correct them (corrected ones show in yellow). The 1st-putt
distance is measured to the **center** of the green, because the app can't
know where the pin is that day.

### Other tabs

- **Activity:** past rounds. Open one to review or fix it.
- **Clubs:** average distance per club (plus longest and range) from every
  recorded shot. Chips and shots you excluded are left out.
- **Courses:** look through any course's holes without starting a round.
- **Player:** totals (fairways, GIR, putts), your bag, **back up / restore**,
  CSV export and the GPS accuracy test.

### Accuracy and battery

- Phone GPS is a few meters off per reading, so one shot can be 5–10 yards
  off. Club averages over many shots are the trustworthy number.
- During a round the screen stays on, and the GPS runs continuously for the
  green distances. That's the heaviest battery use a phone has. Start with a
  full charge or bring a battery pack.
- iPhone pauses web apps when the screen locks or you switch apps. Shots are
  only recorded while the app is open.

### Your data

Rounds are stored **only on your phone**. iPhone can clear web-app storage,
so use **Player → Back up all rounds** after each round and keep the file
(in Files or iCloud Drive). **Restore** brings it back.

## Courses

Built from **OpenStreetMap** (hole lines, greens, fairways, par; ©
OpenStreetMap contributors, ODbL) and **USGS** aerial photos (public domain).
See [`data/coverage.md`](data/coverage.md) for what each course has. Where a
hole isn't mapped in OpenStreetMap, the app can still score it but has no
photo for it. Anyone can fix that by mapping the hole on openstreetmap.org,
then re-running the course build.

### Adding or rebuilding a course

1. Add the course to `tools/courses.json` (its OpenStreetMap outline id goes
   under `facilities`, and its entry under `courses`).
2. Push. The **course-data** GitHub Action downloads the map data and USGS
   photos on GitHub's servers, renders the hole images and commits them back.

## For developers

Plain HTML, CSS and JavaScript; no framework, no build step.

```
index.html, css/app.css   screens and styles
js/app.js                 screen logic
js/round.js               round data, distances, shot results, stats (pure, tested)
js/geo.js                 GPS sampling, distances, image <-> GPS math (pure, tested)
js/holeview.js            hole photo with shots, zoom/pan, drag
js/courses.js             loads course files, offline download
js/store.js               on-phone storage, backup files
sw.js                     offline cache
courses/                  generated course data and hole images
tools/                    course pipeline (runs on GitHub Actions)
data/                     raw OpenStreetMap downloads + coverage report
gps-test/                 standalone GPS accuracy test
tests/                    unit tests
```

- Unit tests: `node --test tests/*.test.mjs`
- Run locally: `python3 -m http.server 8000`, then open http://localhost:8000
