/*
 * Course map: satellite imagery with the current hole's shots drawn on top.
 * Uses Leaflet (vendor/leaflet), loaded as a plain script, so it's the
 * global `L` here.
 *
 * Imagery: USGS The National Map "USGSImageryOnly" (US aerial photos,
 * mostly the ~0.6–1 m NAIP program). USGS imagery is US public domain: free
 * to use and store, with USGS credited as the source. It covers the US only.
 */

const IMAGERY_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
// Highest zoom level we ask the server for. Beyond it, Leaflet enlarges the
// last tiles instead. If the map turns grey when zoomed in, lower this; if
// it looks blurry, try raising it (the service is listed up to 20).
const IMAGERY_MAX_NATIVE_ZOOM = 18;

const L = window.L;

let map = null;
let shotLayer = null;
let meMarker = null;

export function createMap(elementId) {
  map = L.map(elementId, {
    zoomControl: true,
    attributionControl: true,
    maxZoom: 20,
  }).setView([39.5, -98.35], 4); // continental US until we know where we are

  L.tileLayer(IMAGERY_URL, {
    maxNativeZoom: IMAGERY_MAX_NATIVE_ZOOM,
    maxZoom: 20,
    attribution: 'Imagery: <a href="https://www.usgs.gov/">USGS</a> The National Map',
  }).addTo(map);

  shotLayer = L.layerGroup().addTo(map);
  return map;
}

// Leaflet measures its box once; call this when the map's size may have changed.
export function refreshSize() {
  if (map) map.invalidateSize();
}

export function centerOn(lat, lon, zoom = 17) {
  if (map) map.setView([lat, lon], zoom, { animate: false });
}

// Small blue dot for "you are here" (only updated when a reading is taken).
export function showMe(lat, lon) {
  if (!map) return;
  if (!meMarker) {
    meMarker = L.circleMarker([lat, lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lon]);
  }
}

/*
 * Draw one hole: a numbered marker per shot, lines between consecutive
 * shots labeled with the distance, and a flag where the ball finished.
 * shots: sorted by shot_no. end: the hole's end point or null.
 */
export function drawHole(shots, end, fmtDistance) {
  if (!map) return;
  shotLayer.clearLayers();

  const pts = shots.filter((s) => s.lat != null);
  const path = pts.map((s) => [s.lat, s.lon]);
  const lastShot = shots[shots.length - 1];
  const endUsed = end && lastShot && lastShot.lat != null && end.recorded_at >= lastShot.recorded_at;
  if (endUsed) path.push([end.lat, end.lon]);

  if (path.length > 1) {
    L.polyline(path, { color: '#ffeb3b', weight: 3, opacity: 0.9 }).addTo(shotLayer);
  }

  for (const s of pts) {
    const label = `${s.shot_no}`;
    const icon = L.divIcon({
      className: 'shot-pin' + (s.exclude_from_stats ? ' excluded' : ''),
      html: `<span>${label}</span>`,
      iconSize: [26, 26],
    });
    const dist = s.distance_m == null ? '–' : fmtDistance(s.distance_m);
    L.marker([s.lat, s.lon], { icon })
      .bindTooltip(`${s.club} · ${dist}`, { permanent: true, direction: 'right', className: 'shot-tip', offset: [12, 0] })
      .addTo(shotLayer);
  }

  if (endUsed) {
    const icon = L.divIcon({ className: 'end-pin', html: '⚑', iconSize: [24, 24] });
    L.marker([end.lat, end.lon], { icon }).addTo(shotLayer);
  }

  // No animation: jumping straight to the hole keeps labels attached to
  // their pins and is easier to read at a glance.
  if (path.length === 1) map.setView(path[0], Math.max(map.getZoom(), 17), { animate: false });
  else if (path.length > 1) map.fitBounds(L.latLngBounds(path), { padding: [40, 40], maxZoom: 19, animate: false });
}
