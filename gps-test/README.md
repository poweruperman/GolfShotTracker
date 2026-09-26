# GPS Test (Phase 0)

Open it from the tracker: **••• → GPS test**, or `https://poweruperman.github.io/GolfShotTracker/gps-test/`.

A single-page Progressive Web App (PWA) with one job: record the iPhone's GPS
position and how accurate it is. It answers the question the whole tracker
depends on: **how much does a reading scatter when you stand on the same spot?**

## What it does

| Feature | Why it's there |
|---|---|
| **Record position** button samples GPS for 5 s and keeps the most accurate fix | The first fix after the GPS wakes up is often the worst one |
| Accuracy badge: green ≤ 5 m, amber ≤ 10 m, red and ⚑ flagged > 10 m | Tells you on the spot whether to re-take a reading |
| **Test** groups, with scatter stats (distance from average point, widest spread) | This is the Phase 0 field test measurement |
| Distance from previous reading, in m and yd | Lets you check the distance math against yardage markers |
| **Keep screen on** toggle (Screen Wake Lock) | iOS pauses web apps when the screen locks |
| Undo last, Clear all | Mistaken presses |
| Export CSV / JSON through the iPhone share sheet | Readings only live on the phone in Phase 0. Export is the backup |
| Works offline after first load (service worker) | Weak signal on the course. GPS itself doesn't need internet |

## Setup

Hosting and install are the same as the tracker; see the main `README.md`.

## Field test

### Test A — Scatter at a fixed spot (the Phase 0 pass/fail)

A tee marker is ideal, but any fixed point with open sky works (a parking
space corner, a crack in the pavement), away from tall buildings and trees.

1. Go to the spot. Open the app and turn **Keep screen on** ON.
2. Type a label like `Tee marker test`. Tap **New test**.
3. Stand with the phone held over the spot. Tap **Record position**. Hold
   still until it finishes.
4. Walk about 10 steps away and come back, then record again. (Walking away
   makes each reading a fresh one instead of the GPS repeating itself.)
5. Repeat until you have **5 readings**.
6. Screenshot the *Current test* card and tap **Export CSV**.

**What a pass looks like**

| Measure | Pass | Borderline | Fail |
|---|---|---|---|
| Accuracy on each reading | all ≤ 10 m | one reading > 10 m | several > 10 m |
| Worst distance from average point | ≤ 5 m (≈ 5.5 yd) | 5–8 m | > 8 m |

A pass means individual shot distances will usually be within a few yards,
and per-club averages will be reliable. A fail means we need longer sampling
or a different approach before building Phase 1.

### Test B — Distance check between markers (bonus)

1. Tap **New test**. Stand at the 150-yard marker and record.
2. Walk to the 100-yard marker on the same line and record.
3. *Last reading → From previous reading* should read close to **50 yd**.
   Within about 5 yd is a pass.

### Test C — Battery cost

Note the battery % when you start with **Keep screen on** ON, and again after
30 minutes. I don't know the exact drain for your iPhone model. Screen-on plus
GPS is the most power-hungry combination a phone runs, so this number tells us
whether a full 18-hole round needs a battery pack.

**Send back:** the Test A screenshot/CSV, the Test B distance, the battery
numbers, and how often the location prompt reappeared.

## Known limits of this spike

- **Foreground only.** If you lock the phone or switch apps, nothing is
  recorded. That's an iOS rule for web apps.
- **Readings stay on the phone.** Cloud sync arrives in Phase 2. Export after
  each test session.
- **Trying it at home first:** fine for checking that it installs and the
  permission works, but indoor accuracy is poor. Judge accuracy outdoors only.
