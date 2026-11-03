"""
Download golf course data from OpenStreetMap (via the Overpass API).

Runs on GitHub Actions (see .github/workflows/course-data.yml), because the
development environment can't reach map servers.

Steps (each runs only when its output is missing or its input changed):
  1. region:  list every golf course in the LA / Orange County / Inland
              Empire area -> data/osm/region_courses.json
  2. courses: for each course in tools/courses.json, download every golf
              feature (holes, tees, greens, fairways, bunkers, water) in and
              around it -> data/osm/courses/<id>.json

OpenStreetMap data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
UA = "GolfShotTracker/1.0 (personal golf app; github.com/poweruperman/GolfShotTracker)"
# south, west, north, east: covers LA, Orange County and the western Inland Empire
REGION = (33.35, -118.50, 34.25, -117.25)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def overpass(query, attempts=4):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(attempts):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        t0 = time.time()
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=100) as r:
                res = json.loads(r.read().decode("utf-8"))
            print(f"  ok via {url} in {time.time() - t0:.0f}s", flush=True)
            return res
        except Exception as e:  # rate limit, timeout, server busy: try the next server
            last = e
            print(f"  attempt {attempt + 1} via {url} failed after {time.time() - t0:.0f}s: {e}", flush=True)
            time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {last}")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), sort_keys=True)
    print(f"  wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)", flush=True)


def step_region():
    out = os.path.join(ROOT, "data/osm/region_courses.json")
    if os.path.exists(out):
        print("region: already downloaded")
        return
    s, w, n, e = REGION
    q = f"""[out:json][timeout:200];
(way["leisure"="golf_course"]({s},{w},{n},{e});
 relation["leisure"="golf_course"]({s},{w},{n},{e}););
out tags center bb;"""
    print("region: listing golf courses", flush=True)
    res = overpass(q)
    courses = []
    for el in res["elements"]:
        c = el.get("center", {})
        b = el.get("bounds", {})
        courses.append({
            "osm": f"{el['type']}/{el['id']}",
            "name": el.get("tags", {}).get("name", ""),
            "center": [c.get("lat"), c.get("lon")],
            "bounds": [b.get("minlat"), b.get("minlon"), b.get("maxlat"), b.get("maxlon")],
            "tags": el.get("tags", {}),
        })
    courses.sort(key=lambda c: c["name"])
    write_json(out, {"source": "OpenStreetMap contributors (ODbL)", "courses": courses})


def step_courses():
    """Everything golf-related inside (and just around) each course outline."""
    cfg_path = os.path.join(ROOT, "tools/courses.json")
    if not os.path.exists(cfg_path):
        print("courses: tools/courses.json not written yet; skipping")
        return
    cfg = json.load(open(cfg_path))
    for fac in cfg["facilities"]:
        out = os.path.join(ROOT, f"data/osm/courses/{fac['file']}.json")
        if os.path.exists(out) and not fac.get("refetch"):
            continue
        ways = [o.split("/")[1] for o in fac["osm"] if o.startswith("way/")]
        rels = [o.split("/")[1] for o in fac["osm"] if o.startswith("relation/")]
        sel = ""
        if ways:
            sel += f"way(id:{','.join(ways)});"
        if rels:
            sel += f"relation(id:{','.join(rels)});"
        print(f"courses: {fac['file']}", flush=True)
        q = f"""[out:json][timeout:90];
({sel})->.c;
.c map_to_area->.a;
(nwr["golf"](area.a);
 nwr["golf"](around.c:60);
 nwr["natural"="water"](area.a);
 nwr["leisure"="golf_course"](area.a);
 .c;);
out geom;"""
        try:
            res = overpass(q)
        except RuntimeError as e:  # skip this one; the rest still download
            print(f"  SKIPPED {fac['file']}: {e}", flush=True)
            continue
        write_json(out, {"source": "OpenStreetMap contributors (ODbL)", "file": fac["file"],
                         "osm": fac["osm"], "elements": res["elements"]})
        time.sleep(3)  # be polite to the free Overpass servers


def step_search():
    """Find courses by name in a wider area (for names not in the region list)."""
    cfg_path = os.path.join(ROOT, "tools/courses.json")
    if not os.path.exists(cfg_path):
        return
    cfg = json.load(open(cfg_path))
    out = os.path.join(ROOT, "data/osm/search.json")
    if not cfg.get("search") or os.path.exists(out):
        return
    found = []
    for srch in cfg["search"]:
        s, w, n, e = srch["bbox"]
        q = f"""[out:json][timeout:60];
(way["leisure"="golf_course"]({s},{w},{n},{e});
 relation["leisure"="golf_course"]({s},{w},{n},{e}););
out tags center;"""
        try:
            res = overpass(q, attempts=2)
        except RuntimeError as e:
            print(f"  search skipped: {e}", flush=True)
            continue
        res["elements"] = [el for el in res["elements"]
                           if srch["name"].lower() in el.get("tags", {}).get("name", "").lower()]
        for el in res["elements"]:
            c = el.get("center", {})
            found.append({"query": srch["name"], "osm": f"{el['type']}/{el['id']}",
                          "name": el.get("tags", {}).get("name", ""),
                          "center": [c.get("lat"), c.get("lon")], "tags": el.get("tags", {})})
    write_json(out, {"source": "OpenStreetMap contributors (ODbL)", "results": found})


if __name__ == "__main__":
    steps = sys.argv[1:] or ["region", "courses", "search"]
    for st in steps:
        {"region": step_region, "search": step_search, "courses": step_courses}[st]()
