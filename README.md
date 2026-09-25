# Golf GPS Spike — Phase 0

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

## Files

```
golf-gps-spike/
├── index.html            page layout
├── style.css             high-contrast styling for sunlight
├── app.js                all the logic (GPS sampling, stats, export)
├── sw.js                 offline caching of the app files
├── manifest.webmanifest  install info (name, icon, standalone mode)
└── icons/                home-screen icons
```

No libraries, no build step. Plain HTML, CSS and JavaScript.

## Step 1: Put it online (GitHub Pages, free)

GPS access in a browser requires **HTTPS**, so the app has to be hosted, not
opened as a file. GitHub Pages gives free HTTPS hosting.

1. Create a free account at github.com if you don't have one.
2. Click **+** → **New repository**. Name it `golf-tracker`. Set it to
   **Public** (Pages on a private repository requires a paid GitHub plan).
   Public is fine: the code contains no personal data. Your GPS readings
   stay on your phone.
3. In the new repository, click **uploading an existing file**, drag in all
   the files *and* the `icons` folder, then **Commit changes**.
4. Go to **Settings** → **Pages**. Under *Build and deployment*, set Source to
   **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. Wait a minute or two. The page shows your link, like
   `https://<your-username>.github.io/golf-tracker/`.

## Step 2: Install on the iPhone

1. Open the link in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open the app **from the new home-screen icon**. The pill at the top should
   read *installed app*.
4. Tap **Record position**. When iOS asks for location, choose **Allow**.

**Check this iPhone setting once:** Settings → Privacy & Security → Location
Services → **Safari Websites** → *While Using the App* and **Precise Location
on**. If Precise Location is off, accuracy will read hundreds of meters and the
app will warn you.

**Expected iOS behavior:** a home-screen web app may ask for location
permission again after it has been fully closed. That's iOS, not a bug in the
app. Note how often it happens during testing, as it affects Phase 1 design.

## Step 3: Field test

### Test A — Scatter at a fixed spot (the Phase 0 pass/fail)

1. Go to a tee box with open sky. Open the app and turn **Keep screen on** ON.
2. Type a label like `Tee marker test`. Tap **New test**.
3. Stand with the phone held over one tee marker. Tap **Record position**. Hold
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
- **Updates:** after you upload a new version, open the app, close it, and
  open it again to pick up the change.
- **Trying it at home first:** fine for checking that it installs and the
  permission works, but indoor accuracy is poor. Judge accuracy outdoors only.
