# Golf Shot Tracker

A free, self-built golf shot tracker. It's a Progressive Web App (PWA): a web
page installed to the iPhone home screen, with no App Store and no subscription.

**Live app:** https://poweruperman.github.io/GolfShotTracker/

## How it works on the course

1. **Stand at the ball** (not the cart) and tap the club you're about to hit.
   The app listens to the GPS for 5 seconds and saves the most accurate
   reading, with the date and time.
2. When you tap the next club at your next ball, the previous shot's
   **distance is calculated and saved automatically**.
3. On the green, tap **Putt +** for each putt. The **first** putt also records
   where the ball is, which gives your approach shot its distance.
4. Tap **Finish hole ›** to close the hole and move to the next one.
5. **Shots** lists every shot of the round in order. Tap one to change the
   club or hole, mark it *Exclude from stats*, or delete it. Distances
   recalculate by themselves.

Distances are from one tap to the next: **carry + roll, not carry**. Phone GPS
is off by a few meters per reading, so one shot can be off by 5–10 yards.
Averages over many shots are the reliable number.

| Screen part | What it does |
|---|---|
| Hole bar `‹ Hole 3 ›` | Current hole and its score. Arrows change the hole if you forgot to finish one |
| Map | Satellite photo with this hole's shots numbered, joined by a line and labeled with club and distance. ⚑ marks the ball on the green |
| Status box | Result of your last tap, and the GPS accuracy (red ⚑ = worse than 10 m) |
| Club buttons | Your bag. Change them in **••• → My bag** |
| ••• menu | Keep screen on, export this round, My bag, GPS test, End round |

## Where the data lives

For now, **only on your phone** (in the browser's storage). Cloud sync is
Phase 2. iOS can clear web-app storage, so **export after every round**
(••• → Export, or *Export CSV/JSON* on the start screen) and save it to Files
or email it to yourself.

Each shot records: hole, shot number, club, latitude/longitude, GPS accuracy,
number of GPS fixes, date and time, distance (meters and yards) and the
exclude-from-stats flag. Each hole records putts and the ball-on-green point.

**Never commit exports to this repository.** It's public, and exports contain
your real locations. `.gitignore` blocks `*.csv` and `*.json` as a safety net.

## Map imagery

Satellite photos come from the **USGS National Map** (US aerial photography,
public domain, free with credit to USGS). It covers the US only. The phone
needs signal to load new map areas; recording shots works without signal.

## Install and update

1. Open the live link in **Safari** → **Share** → **Add to Home Screen**.
2. iPhone setting, once: Settings → Privacy & Security → Location Services →
   **Safari Websites** → *While Using the App*, **Precise Location on**.
3. **After an update:** open the app, close it fully, and open it again.

## Field test: Phase 1

1. **What to do:** play 3 holes (or walk them at the range/par-3). Tap a club
   at every ball, putts on the green, **Finish hole** after each. On one hole,
   tap at a yardage marker (e.g. 150) and hit/walk to the green center.
2. **What to look for:**
   - the distance shown after each tap, and the map pins against where you stood;
   - the yardage-marker shot's distance against the marker (150 minus what's
     left to the green center);
   - whether the satellite map is sharp or blurry when zoomed in, or grey;
   - whether iOS asked for location permission again, and how often.
3. **What a pass looks like:** every shot saved with a distance; the marker
   check within about 10 yd; pins on the right spots on the map; nothing lost
   after closing and reopening the app mid-hole.
4. **What to send back:** screenshots of the map and the Shots list for each
   hole, the marker-check numbers, and notes on the map and permission
   prompts. Don't send or commit the CSV (it holds your real locations).

The Phase 0 **GPS test** (accuracy scatter) is still in the app: ••• → GPS test.
Its guide is in [`gps-test/README.md`](gps-test/README.md).

## For developers

Plain HTML, CSS and JavaScript. No build step. One vendored library:
[Leaflet](https://leafletjs.com) 1.9.4 for the map (`vendor/leaflet`).

```
index.html, style.css     tracker screen
js/app.js                 screen logic (buttons, dialogs, rendering)
js/round.js               round data and distance rules (pure functions)
js/geo.js                 GPS sampling and haversine distance
js/store.js               on-phone storage and file export
js/map.js                 satellite map and shot pins
sw.js                     offline cache of the app files
gps-test/                 Phase 0 GPS accuracy test
tests/                    unit tests
```

Run the unit tests: `node --test tests/*.test.mjs`
Run locally: `python3 -m http.server 8000`, then open http://localhost:8000
