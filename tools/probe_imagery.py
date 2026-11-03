"""
Check which free public-domain aerial imagery sources answer from GitHub's
servers, and how close they zoom. Prints a short report; changes nothing.
Runs as the first step of the course-data workflow.
"""
import io
import json
import math
import urllib.request

UA = "GolfShotTracker/1.0 (personal golf app)"
# A spot on Fullerton Golf Course (public place, not personal data).
LAT, LON = 33.8945, -117.9177


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def tile_xy(z):
    n = 2 ** z
    x = int((LON + 180) / 360 * n)
    s = math.sin(math.radians(LAT))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
    return x, y


def report(name, url):
    try:
        st, ct, body = get(url)
        extra = ""
        if ct.startswith("image"):
            try:
                from PIL import Image, ImageStat
                im = Image.open(io.BytesIO(body)).convert("RGB")
                sd = ImageStat.Stat(im).stddev
                extra = f" {im.size} detail(stddev)={sum(sd) / 3:.1f}"
            except Exception as e:  # Pillow not installed yet: size only
                extra = f" ({e.__class__.__name__})"
        print(f"  {name}: {st} {ct} {len(body)} bytes{extra}", flush=True)
        return body
    except Exception as e:
        print(f"  {name}: FAILED {e}", flush=True)
        return None


print("USGSImageryOnly tile cache:")
for z in range(14, 21):
    x, y = tile_xy(z)
    report(f"z{z}", f"https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}")

print("USGSImageryOnly service info:")
body = report("info", "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=json")
if body:
    try:
        info = json.loads(body)
        lods = info.get("tileInfo", {}).get("lods", [])
        print(f"  LOD levels: {[l['level'] for l in lods]}; maxScale={info.get('maxScale')} minScale={info.get('minScale')}")
        print(f"  copyright: {info.get('copyrightText')}")
    except Exception as e:
        print(f"  could not read info: {e}")

# NAIP (USDA, public domain) as an image service: returns any box at full resolution.
for svc in ["https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer",
            "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer"]:
    print(f"{svc.split('/')[-2]}:")
    body = report("info", svc + "?f=json")
    if body:
        try:
            info = json.loads(body)
            print(f"  pixelSize={info.get('pixelSizeX')} copyright={str(info.get('copyrightText'))[:120]}")
        except Exception as e:
            print(f"  could not read info: {e}")
    # 300 m box around the spot, Web Mercator, 600x600 px (= 0.5 m/px)
    R = 6378137.0
    mx = math.radians(LON) * R
    my = math.log(math.tan(math.pi / 4 + math.radians(LAT) / 2)) * R
    k = 1 / math.cos(math.radians(LAT))  # Mercator meters per ground meter
    h = 150 * k
    bbox = f"{mx - h},{my - h},{mx + h},{my + h}"
    report("exportImage 600px", svc + f"/exportImage?bbox={bbox}&bboxSR=3857&imageSR=3857&size=600,600&format=jpg&f=image")
