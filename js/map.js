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
let tapHandler = null;

export function createMap(elementId) {
  map = L.map(elementId, {
    zoomControl: false, // pinch to zoom; keeps the map clear like the rest of the screen
    attributionControl: true,
    maxZoom: 20,
  }).setView([39.5, -98.35], 4); // continental US until we know where we are

  L.tileLayer(IMAGERY_URL, {
    maxNativeZoom: IMAGERY_MAX_NATIVE_ZOOM,
    maxZoom: 20,
    attribution: 'Imagery: <a href="https://www.usgs.gov/">USGS</a>',
  }).addTo(map);

  shotLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => { if (tapHandler) tapHandler(e.latlng.lat, e.latlng.lng); });
  return map;
}

// While set, a tap on the map calls fn(lat, lon) (used to add a missed shot).
export function onMapTap(fn) {
  tapHandler = fn;
  if (map) map.getContainer().classList.toggle('tap-mode', !!fn);
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
      radius: 7, color: '#fff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1, interactive: false,
    }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lon]);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A pin: a dot on the exact spot, with a label (club badge + distance) beside it.
function pinIcon(badge, text, side, extraClass = '') {
  return L.divIcon({
    className: `pin pin-${side} ${extraClass}`,
    html: `<span class="pin-dot"></span><span class="pin-label">` +
      (side === 'left' ? `<span class="pin-text">${esc(text)}</span><span class="pin-badge">${esc(badge)}</span>`
        : `<span class="pin-badge">${esc(badge)}</span><span class="pin-text">${esc(text)}</span>`) +
      `</span>`,
    iconSize: [0, 0], // the CSS positions everything around the anchor point
  });
}

/*
 * Draw one hole: a pin per shot (club + distance), a white line along the
 * shots, and the ball-on-green point with the putt count.
 *
 * opts: { fmt(m) -> text, putts, onShotTap(id), movingShotId, onMoved(lat, lon), fit }
 */
export function drawHole(shots, end, opts) {
  if (!map) return;
  shotLayer.clearLayers();

  const pts = shots.filter((s) => s.lat != null);
  const path = pts.map((s) => [s.lat, s.lon]);
  const lastShot = shots[shots.length - 1];
  const endUsed = end && lastShot;
  if (endUsed) path.push([end.lat, end.lon]);

  if (path.length > 1) {
    L.polyline(path, { color: '#fff', weight: 3, opacity: 0.95, interactive: false }).addTo(shotLayer);
  }

  pts.forEach((s, i) => {
    // Alternate label sides so neighbouring labels overlap less.
    const side = i % 2 === 0 ? 'right' : 'left';
    const text = s.distance_m == null ? '–' : opts.fmt(s.distance_m);
    const moving = s.id === opts.movingShotId;
    const cls = (s.exclude_from_stats ? 'excluded ' : '') + (moving ? 'moving' : '');
    const m = L.marker([s.lat, s.lon], {
      icon: pinIcon(s.club, text, side, cls),
      draggable: moving,
      zIndexOffset: moving ? 1000 : 0,
    }).addTo(shotLayer);
    if (moving) {
      m.on('dragend', () => { const p = m.getLatLng(); opts.onMoved(p.lat, p.lng); });
    } else if (opts.onShotTap) {
      m.on('click', () => opts.onShotTap(s.id));
    }
  });

  if (endUsed) {
    const text = opts.putts ? `${opts.putts} putt${opts.putts === 1 ? '' : 's'}` : 'on green';
    L.marker([end.lat, end.lon], {
      icon: pinIcon('⚑', text, pts.length % 2 === 0 ? 'right' : 'left', 'pin-end'),
      interactive: false,
    }).addTo(shotLayer);
  }

  if (opts.fit === false) return;
  // No animation: jumping straight to the hole keeps labels attached to
  // their pins and is easier to read at a glance.
  if (path.length === 1) map.setView(path[0], Math.max(map.getZoom(), 17), { animate: false });
  else if (path.length > 1) {
    // Extra room at the top for messages and at the bottom for the buttons.
    map.fitBounds(L.latLngBounds(path), {
      paddingTopLeft: [70, 100], paddingBottomRight: [70, 170], maxZoom: 19, animate: false,
    });
  }
}
