"""
Turn raw OpenStreetMap course data into what the app uses, and render one
satellite image per hole (tee at the bottom, green at the top).

Runs on GitHub Actions after tools/osm_fetch.py. Inputs:
  tools/courses.json            which courses, and which OSM boundary each uses
  data/osm/courses/<id>.json    raw OSM features for each course
Outputs:
  courses/index.json            list of courses for the app
  courses/<id>/course.json      holes: par, tee, green outline, fairways,
                                and how to place GPS points on each image
  courses/<id>/hNN.jpg          hole images (USGS aerial photos, public domain)
  data/coverage.md              what OSM has (and lacks) for each course

Geometry notes:
  * Inside one course everything is treated as flat: east/north meters from a
    local origin. Over 1-2 km the error is far below GPS error.
  * Images are rendered from Web Mercator map tiles. Locally, Mercator is a
    uniform scale of east/north meters, so the whole image is one affine
    transform of Mercator pixel coordinates. That transform is saved per hole
    ("m": [a, b, c, d, e, f]) so the app can place any GPS point:
        u = a*X + b*Y + c,  v = d*X + e*Y + f
    where (X, Y) are Mercator pixel coordinates at zoom "z".
"""
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "GolfShotTracker/1.0 (personal golf app; github.com/poweruperman/GolfShotTracker)"
TILE_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
EARTH_CIRC = 40075016.686  # meters at the equator (Web Mercator sphere)
R = 6378137.0

IMG_W, IMG_H = 768, 1280          # portrait, ~iPhone screen shape
MIN_VIEW_H_M = 240                # never zoom in closer than this (short par 3s)
PAD_GREEN_M = 30                  # space beyond the back of the green
PAD_TEE_M = 45                    # space behind the tee (room for messages and buttons)
PAD_SIDE_M = 30                   # space beside the widest part of the hole
TILE_Z = 18                       # ~0.5 m/px here; USGS NAIP photos are ~0.6 m


# ---------------------------------------------------------------- geometry

class Local:
    """East/north meters around an origin (flat-earth approximation)."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * math.pi * R / 180
        self.ky = math.pi * R / 180

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def ll(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)


def merc_px(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def centroid(pts):
    """Area centroid of a polygon given as [(x, y), ...]."""
    a = cx = cy = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    if abs(a) < 1e-9:
        return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n)
    return (cx / (3 * a), cy / (3 * a))


def inside(pt, poly):
    x, y = pt
    ins = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            ins = not ins
        j = i
    return ins


def seg_dist(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def line_dist(p, line):
    return min(seg_dist(p, line[i], line[i + 1]) for i in range(len(line) - 1))


def poly_dist(p, poly):
    if inside(p, poly):
        return 0.0
    return min(seg_dist(p, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))


# ------------------------------------------------------------- OSM parsing

def rings(el):
    """Outer rings of a way or multipolygon relation, as [(lat, lon), ...]."""
    if el["type"] == "way" and "geometry" in el:
        return [[(p["lat"], p["lon"]) for p in el["geometry"]]]
    if el["type"] == "relation":
        out = []
        for m in el.get("members", []):
            if m.get("role") in ("outer", "") and "geometry" in m:
                out.append([(p["lat"], p["lon"]) for p in m["geometry"]])
        # Join outer pieces into closed rings when a relation splits them.
        return join_rings(out)
    return []


def join_rings(parts):
    parts = [p for p in parts if len(p) >= 2]
    done = []
    while parts:
        cur = parts.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, p in enumerate(parts):
                if p[0] == cur[-1]:
                    cur = cur + p[1:]
                elif p[-1] == cur[-1]:
                    cur = cur + p[::-1][1:]
                elif p[-1] == cur[0]:
                    cur = p + cur[1:]
                elif p[0] == cur[0]:
                    cur = p[::-1] + cur[1:]
                else:
                    continue
                parts.pop(i)
                changed = True
                break
        done.append(cur)
    return done


def int_or_none(v):
    try:
        return int(str(v).split(";")[0].strip())
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------- course building

def build_course(cfg, raw):
    els = raw["elements"]
    by_id = {f"{e['type']}/{e['id']}": e for e in els}

    # Course boundary: the OSM golf course outline(s) chosen in tools/courses.json.
    bounds_ll = []
    for oid in cfg["osm"]:
        if oid in by_id:
            bounds_ll += rings(by_id[oid])
    if not bounds_ll:
        raise RuntimeError(f"{cfg['id']}: boundary {cfg['osm']} not in downloaded data")
    allpts = [p for r in bounds_ll for p in r]
    lat0 = sum(p[0] for p in allpts) / len(allpts)
    lon0 = sum(p[1] for p in allpts) / len(allpts)
    loc = Local(lat0, lon0)
    bounds = [[loc.xy(*p) for p in r] for r in bounds_ll]

    def in_course(pt, slack=25):
        return any(inside(pt, b) or poly_dist(pt, b) < slack for b in bounds)

    feats = {"hole": [], "green": [], "tee": [], "fairway": [], "bunker": [], "water": [], "pin": []}
    for e in els:
        t = e.get("tags", {})
        g = t.get("golf")
        kind = None
        if g in feats:
            kind = g
        elif g in ("water_hazard", "lateral_water_hazard") or t.get("natural") == "water":
            kind = "water"
        if not kind:
            continue
        if kind == "hole" and e["type"] == "way":
            line = [loc.xy(p["lat"], p["lon"]) for p in e.get("geometry", [])]
            if len(line) >= 2:
                feats["hole"].append({"tags": t, "line": line, "osm": f"way/{e['id']}"})
        elif kind == "pin" and e["type"] == "node":
            feats["pin"].append(loc.xy(e["lat"], e["lon"]))
        else:
            for r in rings(e):
                if len(r) >= 3:
                    poly = [loc.xy(*p) for p in r]
                    feats[kind].append({"poly": poly, "c": centroid(poly), "tags": t})

    # Keep only holes that belong to this course (matters where two courses
    # share a club house, e.g. North/South). Use the middle of the hole line.
    holes_raw = []
    for h in feats["hole"]:
        # Properties with two courses tag each hole with its course's name.
        if cfg.get("course_name"):
            if h["tags"].get("golf:course:name") == cfg["course_name"]:
                holes_raw.append(h)
            continue
        mid = h["line"][len(h["line"]) // 2]
        if in_course(mid) and in_course(h["line"][0], 60) and in_course(h["line"][-1], 60):
            holes_raw.append(h)
    greens = [g for g in feats["green"] if in_course(g["c"])]
    tees = [t for t in feats["tee"] if in_course(t["c"])]
    fairways = [f for f in feats["fairway"] if in_course(f["c"])]

    holes = {}
    problems = []
    for h in holes_raw:
        t = h["tags"]
        n = int_or_none(t.get("ref"))
        if n is None or n < 1 or n > 27:
            problems.append(f"hole line {h['osm']} has no usable hole number (ref={t.get('ref')!r})")
            continue
        line = h["line"]

        def nearest_green(p):
            best = None
            for g in greens:
                d = poly_dist(p, g["poly"])
                if best is None or d < best[0]:
                    best = (d, g)
            return best

        # Hole lines should run tee -> green; fix ones drawn backwards.
        gs, ge = nearest_green(line[0]), nearest_green(line[-1])
        if gs and ge and gs[0] + 5 < ge[0]:
            line = line[::-1]
            ge = gs
        green = ge[1] if ge and ge[0] < 40 else None
        if n in holes:
            problems.append(f"hole {n} appears twice; kept the first")
            continue
        holes[n] = {
            "n": n,
            "par": int_or_none(t.get("par")),
            "hcp": int_or_none(t.get("handicap")),
            "name": t.get("name"),
            "line": line,
            "green": green["poly"] if green else None,
        }

    # Fairways belong to the hole whose line passes closest to them.
    hole_fw = {n: [] for n in holes}
    for f in fairways:
        best = None
        for n, h in holes.items():
            d = line_dist(f["c"], h["line"])
            if best is None or d < best[0]:
                best = (d, n)
        if best and best[0] < 80:
            hole_fw[best[1]].append(f["poly"])

    out_holes = []
    for n in sorted(holes):
        h = holes[n]
        tee = h["line"][0]
        gc = centroid(h["green"]) if h["green"] else h["line"][-1]
        length = sum(dist(h["line"][i], h["line"][i + 1]) for i in range(len(h["line"]) - 1))
        out_holes.append({
            "n": n, "par": h["par"], "hcp": h["hcp"],
            "length_m": round(length, 1),
            "tee": tee, "green_center": gc, "green": h["green"],
            "line": h["line"], "fairways": hole_fw[n],
        })

    expected = cfg.get("holes", 18)
    have = {h["n"] for h in out_holes}
    missing = [n for n in range(1, expected + 1) if n not in have]
    cov = {
        "holes_expected": expected,
        "holes_found": len(out_holes),
        "missing_holes": missing,
        "with_par": sum(1 for h in out_holes if h["par"]),
        "with_green_outline": sum(1 for h in out_holes if h["green"]),
        "with_fairway": sum(1 for h in out_holes if h["fairways"]),
        "greens_in_course": len(greens),
        "tees_in_course": len(tees),
        "problems": problems,
    }
    return loc, out_holes, cov


# --------------------------------------------------------------- rendering

def hole_frame(h):
    """Where the hole image sits: a rotated rectangle in local meters."""
    tee = h["tee"]
    gc = h["green_center"]
    ang = math.atan2(gc[0] - tee[0], gc[1] - tee[1])  # bearing: 0 = north, clockwise
    ca, sa = math.cos(ang), math.sin(ang)

    def rot(p):  # into hole frame: y runs tee -> green, x to the right
        dx, dy = p[0] - tee[0], p[1] - tee[1]
        return (dx * ca - dy * sa, dx * sa + dy * ca)

    pts = [rot(p) for p in h["line"]]
    if h["green"]:
        pts += [rot(p) for p in h["green"]]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    xmin, xmax = min(xs) - PAD_SIDE_M, max(xs) + PAD_SIDE_M
    ymin, ymax = min(ys) - PAD_TEE_M, max(ys) + PAD_GREEN_M
    H = max(ymax - ymin, MIN_VIEW_H_M)
    W = xmax - xmin
    aspect = IMG_W / IMG_H
    if W / H > aspect:
        H = W / aspect
    else:
        W = H * aspect
    cx = (xmin + xmax) / 2
    cy = (ymin + ymax) / 2
    # Keep the tee near the bottom: if the frame grew, grow it upward mostly.
    bottom = min(ymin, cy - H / 2)
    bottom = max(bottom, cy - H / 2)
    return {"tee": tee, "ca": ca, "sa": sa, "x0": cx - W / 2, "y0": cy - H / 2, "W": W, "H": H,
            "bearing_deg": (math.degrees(ang) + 360) % 360}


def frame_to_local(fr, u, v):
    """Image pixel (u right, v down) -> local east/north meters."""
    hx = fr["x0"] + u / IMG_W * fr["W"]
    hy = fr["y0"] + (IMG_H - v) / IMG_H * fr["H"]
    ca, sa = fr["ca"], fr["sa"]
    # inverse of rot(): dx = hx*ca + hy*sa, dy = -hx*sa + hy*ca
    return (fr["tee"][0] + hx * ca + hy * sa, fr["tee"][1] - hx * sa + hy * ca)


def affine_from_points(src, dst):
    """Solve dst = A*src + t from 3 point pairs; returns (a,b,c,d,e,f)."""
    (x1, y1), (x2, y2), (x3, y3) = src
    det = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)
    res = []
    for k in range(2):
        d1, d2, d3 = dst[0][k], dst[1][k], dst[2][k]
        a = (d1 * (y2 - y3) + d2 * (y3 - y1) + d3 * (y1 - y2)) / det
        b = (x1 * (d2 - d3) + x2 * (d3 - d1) + x3 * (d1 - d2)) / det
        c = (x1 * (y2 * d3 - y3 * d2) + x2 * (y3 * d1 - y1 * d3) + x3 * (y1 * d2 - y2 * d1)) / det
        res += [a, b, c]
    return res


class TileCache:
    def __init__(self):
        self.mem = {}
        self.failed = 0

    def get(self, z, x, y):
        key = (z, x, y)
        if key not in self.mem:
            self.mem[key] = self._fetch(z, x, y)
        return self.mem[key]

    def _fetch(self, z, x, y):
        """A tile image, or None if the server doesn't have it."""
        from PIL import Image
        url = TILE_URL.format(z=z, x=x, y=y)
        last = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=40) as r:
                    return Image.open(io.BytesIO(r.read())).convert("RGB")
            except urllib.error.HTTPError as e:
                last = e
                if e.code == 404:  # the server has no tile here: retrying won't help
                    break
                time.sleep(2 * (attempt + 1))
            except Exception as e:
                last = e
                time.sleep(2 * (attempt + 1))
        self.failed += 1
        if self.failed <= 5:
            print(f"    tile {z}/{y}/{x} failed: {last}", flush=True)
        return None


def render_hole(loc, h, tiles, out_path):
    from PIL import Image
    fr = hole_frame(h)
    z = TILE_Z
    corners_px = [(0, 0), (IMG_W, 0), (IMG_W, IMG_H), (0, IMG_H)]
    corners_ll = [loc.ll(*frame_to_local(fr, u, v)) for u, v in corners_px]
    merc = [merc_px(lat, lon, z) for lat, lon in corners_ll]
    tx0 = int(min(m[0] for m in merc) // 256)
    tx1 = int(max(m[0] for m in merc) // 256)
    ty0 = int(min(m[1] for m in merc) // 256)
    ty1 = int(max(m[1] for m in merc) // 256)
    keys = [(z, x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]
    with ThreadPoolExecutor(8) as ex:
        got = list(ex.map(lambda k: tiles.get(*k), keys))
    # Never save a hole image that is mostly missing photo.
    missing = sum(1 for t in got if t is None)
    if missing > len(keys) * 0.1:
        print(f"    hole {h['n']}: {missing}/{len(keys)} tiles missing; no image", flush=True)
        return None
    mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), (40, 48, 40))
    for (_, x, y), t in zip(keys, got):
        if t is not None:
            mosaic.paste(t, ((x - tx0) * 256, (y - ty0) * 256))

    # Image pixel -> Mercator pixel (affine, from 3 corners); PIL wants the
    # mapping from output pixel to input (mosaic) pixel.
    src = corners_px[:3]
    dst = [(m[0] - tx0 * 256, m[1] - ty0 * 256) for m in merc[:3]]
    inv = affine_from_points(src, dst)
    img = mosaic.transform((IMG_W, IMG_H), Image.AFFINE, data=inv, resample=Image.BICUBIC)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, "JPEG", quality=78, optimize=True, progressive=True)

    # The app needs the opposite: Mercator pixel -> image pixel.
    fwd = affine_from_points([m for m in merc[:3]], src)
    return {
        "z": z, "m": [round(v, 9) for v in fwd], "w": IMG_W, "h": IMG_H,
        "corners": [[round(a, 7), round(b, 7)] for a, b in corners_ll],
        "bearing_deg": round(fr["bearing_deg"], 1),
        "m_per_px": round(fr["H"] / IMG_H, 4),
    }


# ------------------------------------------------------------------- main

def ll_list(loc, pts, nd=6):
    return [[round(a, nd), round(b, nd)] for a, b in (loc.ll(*p) for p in pts)]


def main():
    render = "--no-render" not in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    cfg = json.load(open(os.path.join(ROOT, "tools/courses.json")))
    index = []
    rendered_ok = 0
    failed_holes = 0
    imagery_down = False
    cov_lines = ["# Course data coverage", "",
                 "Generated by `tools/build_courses.py` from OpenStreetMap. "
                 "Missing holes need mapping in OpenStreetMap (or a manual fix in "
                 "`tools/courses.json`).", "",
                 "| Course | Holes found | Par | Green outlines | Fairways | Missing holes | Notes |",
                 "|---|---|---|---|---|---|---|"]
    for c in cfg["courses"]:
        if only and c["id"] not in only:
            continue
        raw_path = os.path.join(ROOT, f"data/osm/courses/{c['osm_file']}.json")
        if not os.path.exists(raw_path):
            print(f"{c['id']}: no raw data yet")
            continue
        raw = json.load(open(raw_path))
        try:
            loc, holes, cov = build_course(c, raw)
        except Exception as e:
            print(f"{c['id']}: FAILED {e}")
            cov_lines.append(f"| {c['name']} | – | – | – | – | – | build failed: {e} |")
            continue
        print(f"{c['id']}: {cov['holes_found']}/{cov['holes_expected']} holes", flush=True)
        cdir = os.path.join(ROOT, f"courses/{c['id']}")
        tiles = TileCache()
        # Images rendered by an earlier run are kept (delete a course's folder,
        # or run with --rerender, to draw them again).
        prev = {}
        prev_path = os.path.join(cdir, "course.json")
        if os.path.exists(prev_path) and "--rerender" not in sys.argv:
            prev = {ph["n"]: ph.get("image") for ph in json.load(open(prev_path))["holes"]}
        out = []
        for h in holes:
            img = None
            fname = f"h{h['n']:02d}.jpg"
            if prev.get(h["n"]) and os.path.exists(os.path.join(cdir, fname)):
                img = prev[h["n"]]
            elif render and not imagery_down:
                img = render_hole(loc, h, tiles, os.path.join(cdir, fname))
                if img:
                    img["file"] = fname
                    rendered_ok += 1
                else:
                    failed_holes += 1
                    # Imagery server not answering at all: stop instead of
                    # spending hours on failures.
                    if failed_holes >= 3 and rendered_ok == 0:
                        imagery_down = True
                        print("  IMAGERY UNAVAILABLE: skipping all remaining images", flush=True)
            out.append({
                "n": h["n"], "par": h["par"], "hcp": h["hcp"],
                "length_m": h["length_m"],
                "tee": ll_list(loc, [h["tee"]])[0],
                "green_center": ll_list(loc, [h["green_center"]])[0],
                "green": ll_list(loc, h["green"]) if h["green"] else None,
                "line": ll_list(loc, h["line"]),
                "fairways": [ll_list(loc, f) for f in h["fairways"]],
                "image": img,
            })
        course = {
            "id": c["id"], "name": c["name"], "city": c.get("city", ""),
            "holes_expected": cov["holes_expected"],
            "center": [round(loc.lat0, 6), round(loc.lon0, 6)],
            "holes": out,
            "attribution": "Course data © OpenStreetMap contributors (ODbL). Imagery: USGS The National Map.",
        }
        os.makedirs(cdir, exist_ok=True)
        with open(os.path.join(cdir, "course.json"), "w") as f:
            json.dump(course, f, separators=(",", ":"))
        index.append({
            "id": c["id"], "name": c["name"], "city": c.get("city", ""),
            "center": course["center"], "holes": len(out), "holes_expected": cov["holes_expected"],
            "par": sum(h["par"] or 0 for h in out) or None,
        })
        notes = "; ".join(cov["problems"][:3])
        cov_lines.append(
            f"| {c['name']} | {cov['holes_found']}/{cov['holes_expected']} | {cov['with_par']} | "
            f"{cov['with_green_outline']} | {cov['with_fairway']} | "
            f"{', '.join(map(str, cov['missing_holes'])) or '–'} | {notes} |")
        if tiles.failed:
            print(f"  {tiles.failed} tiles failed")

    if not only:
        os.makedirs(os.path.join(ROOT, "courses"), exist_ok=True)
        os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
        index.sort(key=lambda c: c["name"])
        with open(os.path.join(ROOT, "courses/index.json"), "w") as f:
            json.dump({"courses": index}, f, indent=1)
        with open(os.path.join(ROOT, "data/coverage.md"), "w") as f:
            f.write("\n".join(cov_lines) + "\n")


if __name__ == "__main__":
    main()
