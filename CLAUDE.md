# CLAUDE.md — Golf Tracker

This file gives you (Claude Code) the background, goals, fixed decisions and
working rules for this repository. Read it fully before making changes.
Planning and decisions happen in a separate Claude chat Project. This file
is the bridge between that Project and this repository.

- **Repository:** `poweruperman/GolfShotTracker` (renamed from an earlier name
  that used a trademarked product name; keep product names out of repo, app
  and file names)
- **Live app:** https://poweruperman.github.io/GolfShotTracker/

---

## 1. Why this project exists

David used **Arccos** (club sensors + subscription) to track his golf shots.
This project replaces that subscription with a **free, self-built system**.
Cancelling the subscription is the point, so **never add a paid service,
subscription or paid API without asking David first.**

**Ultimate objective.** After a round, David can:

1. see every shot, its club and its distance, plotted on a map of each hole;
2. see his average distance (and spread) per club;
3. do all of this with no subscription.

## 2. Who David is (as the user and owner)

- Right-handed golfer, beginner. First broke 100 in June 2026.
- Plays courses around Anaheim / Orange County, California.
- Previously used Arccos, so its club averages are his baseline for comparison.
- Uses an iPhone for the app and a 2020 Intel MacBook Pro for development.
- **Learning to code as we build.** He is not a professional developer.
  Explain the *why* behind technical choices briefly, in plain language.

## 3. The two workstreams

1. **Shot Tracker (PWA).** A Progressive Web App installed to the iPhone home
   screen from a link (no App Store). Before each shot David taps the club he
   is about to hit. The app records the GPS position at that moment. Shot
   distance = distance between the GPS position at one press and the next.
   Data syncs to a free cloud database.
2. **Course Images.** A pipeline that generates hole-by-hole map images for any
   course on demand: satellite imagery with fairway, green, bunker, water and
   tee outlines drawn on top, from free OpenStreetMap golf data.

They meet on one screen: the tracker's map shows the hole image with each shot
plotted on it.

## 4. Fixed decisions (do not relitigate without a stated reason)

| Topic | Decision |
|---|---|
| App type | PWA, installed to the iPhone home screen from a link |
| Club selection | Manual. David taps the club before each shot (no sensors) |
| Shot distance | Haversine distance between the GPS reading at press N and press N+1, attributed to the club chosen at press N |
| Last shot on a hole | "Holed out" button closes the hole. A simple counter logs putts without GPS |
| Data storage | Free cloud database: Supabase preferred, Firebase acceptable |
| Course images | Satellite tile background + OpenStreetMap golf outlines |
| Course coverage | Any course, on demand, degrading gracefully where OSM data is incomplete |
| Hosting | GitHub Pages from this repository (public repo, free HTTPS) |
| Code style | Plain HTML/CSS/JavaScript, no framework, no build step, few dependencies |

**Open question, not decided:** David has said this should "eventually be an
app." A native/App Store version would mainly gain background GPS (iOS
suspends web apps when the screen locks), but it costs a paid Apple Developer
membership. The current plan is to keep building the PWA and revisit after
Phase 6, possibly wrapping the same code with a tool like Capacitor. Do not
start native work unless David decides this.

## 5. Units

- **Golf distances, yardages, club distances: yards** (for display).
- **Everything else: metric** (GPS accuracy, engineering measurements, map scale).
- **Storage:** coordinates in decimal degrees, distances in meters. Convert to
  yards only for display (1 m = 1.0936133 yd).

## 6. Technical guardrails — Shot Tracker

- **HTTPS is required** for geolocation. GitHub Pages provides it. Local
  testing works on `localhost`.
- **Foreground only.** iOS suspends web apps in the background. Use the Screen
  Wake Lock API to keep the screen on (works in home-screen apps from iOS 18.4).
  Re-acquire it on `visibilitychange`. Always tell David about the battery cost.
- **GPS sampling.** Use `enableHighAccuracy: true`, `maximumAge: 0`. On each
  press, watch the GPS for a few seconds and keep the reading with the best
  (smallest) accuracy, not the first reading.
- **Show accuracy on screen** and flag readings worse than about 10 m.
- **Press at the ball.** Distance is measured between where David stands at each
  press, so he must press standing at the ball, not from the cart. The UI must
  make this obvious.
- **Label distances honestly:** they are total distance to the next ball
  position (carry + roll), **not carry**.
- **Exclude from stats** flag per shot, for penalty drops, mulligans,
  provisional balls and punch-outs.
- **Undo** the last press, and **edit** club and hole after the fact.
- **Never rely on browser storage alone.** Queue shots locally first, sync to
  the cloud when a connection exists, and offer CSV/JSON export as a backup.
  Assume signal at courses is weak.
- **Accuracy expectation:** phone GPS is typically off by several meters per
  reading, so a single shot distance can be off by roughly 5–10 yards. Averages
  over many shots per club are the reliable number. Present stats with that in
  mind.

### Suggested data model (adjust as we build)

```
rounds:  id, date, course_id, tees, notes
holes:   round_id, hole_no, putts, holed_out_at
shots:   id, round_id, hole_no, shot_no, club, lat, lon, accuracy_m,
         recorded_at, exclude_from_stats,
         distance_yd   -- computed from the next shot or the holed-out position
courses: id, name, osm_id, center_lat, center_lon, image_status
```

## 7. Technical guardrails — Course Images

- Source outlines from OpenStreetMap via the **Overpass API**. Relevant tags:
  `leisure=golf_course` (boundary) and `golf=hole | tee | fairway | green |
  bunker | water_hazard | lateral_water_hazard | rough`.
- **Coverage varies by course.** Before generating images, report a coverage
  score per course (which holes have hole lines, greens, fairways, bunkers).
  Where outlines are missing, fall back to a satellite-only image with the hole
  line.
- **Per-hole image:** rotate so the tee is at the bottom and the green at the
  top, crop to the hole with padding, draw outlines with a fixed color legend.
- **Cache** generated images per course so each is built once.
- **Imagery provider:** before choosing one, check its *current* terms on
  caching, storing and displaying imagery, and its attribution requirements.
  Never assume a provider allows storing tiles. Always show required
  attribution (OpenStreetMap contributors plus the imagery provider).

## 8. Privacy rules

- **Location history is personal data.** It lives only on David's phone and in
  his own database.
- **This repository is public.** Never commit real GPS coordinates, exported
  rounds, CSV/JSON exports, database keys or other secrets. Use dummy data
  (made-up coordinates) in examples, tests and demos.
- Keep `*.csv`, `*.json` exports and any `.env` files in `.gitignore`.
- Supabase: only the public "anon" key may appear in client code, and only
  with Row Level Security enabled. Never commit the service-role key.

## 9. Phases and current status

| Phase | Deliverable | Field test | Status |
|---|---|---|---|
| 0. GPS spike | Single-page PWA, one button that logs position + accuracy, installed to home screen | Stand at a tee marker 5 times; check scatter | **Built, not yet field-tested** |
| 1. Tracker MVP | Club buttons, hole/shot counter, distance between presses, holed-out + putt counter, local queue | Play 3 holes; compare distances with yardage markers | Not started |
| 2. Cloud sync | Supabase tables, sync queue, CSV export | Airplane mode mid-hole, reconnect; no shots lost | Not started |
| 3. Course images (one course) | Overpass fetch, coverage report, per-hole images for one home course | Compare with the course's scorecard map | Not started |
| 4. Overlay | Shots plotted on the hole image during and after the round | Review a full round on the map | Not started |
| 5. Any course on demand | Course search, automatic image generation, coverage fallbacks | Try an unfamiliar course, incl. one with sparse OSM data | Not started |
| 6. Stats | Average and range per club, dispersion by club, shots to green | Compare with Arccos club averages before cancelling | Not started |

**Phase 0 pass criteria:** every reading's accuracy ≤ 10 m, and the worst
reading within 5 m (≈ 5.5 yd) of the average point over 5 readings at the same
spot. The Phase 0 results decide the sampling time and permission handling for
Phase 1. Don't build Phase 1 on assumptions that the field test may overturn.

Update the Status column when a phase changes state.

### Open items

- **Imagery provider:** pick one and confirm caching/attribution terms before Phase 3.
- **Cloud database:** confirm Supabase free-tier limits still fit (row count,
  pause-after-inactivity rules) before Phase 2.
- **Arccos baseline:** David must capture club averages and any round data he
  wants to keep before the subscription ends (screenshots are the only export).
- **Pin position:** decide later whether to track distance to the pin (needs a
  green position per day) or only shot-to-shot distance.
- **iOS location prompt:** home-screen web apps may re-ask for location
  permission after a full close. Phase 0 testing will show how often.

## 10. Repository layout (current)

```
/                     Phase 0 GPS spike (served by GitHub Pages)
├── index.html
├── style.css
├── app.js            GPS sampling, stats, export
├── sw.js             service worker (caches app files only, never location data)
├── manifest.webmanifest
├── icons/
├── README.md         setup + field test guide for Phase 0
└── CLAUDE.md         this file
```

When the service worker's cached files change, bump `CACHE_NAME` in `sw.js`
so phones pick up the new version.

## 11. How to work with David

- **Lead with the answer or the change,** then the detail.
- **Commit to a recommendation** instead of listing every possibility. Offer
  alternatives only when the trade-off is real, and state it.
- **Ask before starting** when a request is ambiguous.
- **Break work into small steps** with clear reasoning. Prefer small, focused
  commits with clear messages, so David can follow the history and revert
  easily.
- **Flag changes with the reason,** especially anything touching a fixed decision.
- **Verify anything that changes over time** (API endpoints, pricing, provider
  terms, iOS/Safari behavior) with a web search, not memory, and say what you
  checked.
- **Say "I don't know"** when that is the case, then propose how to find out.
- **Acknowledge and correct earlier mistakes openly.**
- **Beginner-readable code:** plain JavaScript, few dependencies, comments on
  the non-obvious parts (the "why", not the obvious "what").
- **Documents** are Markdown files in the repo.

### Testing: the field is the truth

Every feature ships with a **field test** David can run on a real hole or at a
range. Write it in this format:

1. **What to do:** exact steps on the course.
2. **What to look for:** the on-screen values to note.
3. **What a pass looks like:** concrete numbers or behavior.
4. **What to send back:** screenshots, exports or numbers.

Run what you can locally first (syntax checks, unit tests on pure functions
like distance math, a local server). **David's field results always override
any simulation.** If a field result contradicts your expectation, trust the
field result and investigate.
