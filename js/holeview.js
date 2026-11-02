/*
 * Hole view: one hole's aerial image (tee at the bottom, green at the top)
 * with shots, the shot line, "you are here" and a tap-to-measure target
 * drawn on top. Supports pinch to zoom, drag to pan, double-tap to zoom,
 * tap to measure (or to add a shot in edit mode) and dragging shots while
 * editing.
 *
 * Coordinates: image pixels (from the course file) -> screen pixels by a
 * scale `s` and offset (ox, oy) that this module manages.
 */

import { latLonToImage, imageToLatLon } from './geo.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createHoleView(root, handlers) {
  root.innerHTML = `
    <div class="hv-stage">
      <img class="hv-img" alt="" draggable="false">
      <svg class="hv-svg"></svg>
      <div class="hv-pins"></div>
      <div class="hv-empty" hidden></div>
    </div>`;
  const stage = root.querySelector('.hv-stage');
  const img = root.querySelector('.hv-img');
  const svg = root.querySelector('.hv-svg');
  const pins = root.querySelector('.hv-pins');
  const empty = root.querySelector('.hv-empty');

  let meta = null;        // image info from the course file ({w, h, z, m})
  let overlay = {};       // what to draw
  let s0 = 1;             // scale that makes the image cover the screen
  let k = 1;              // extra zoom from pinching
  let ox = 0;
  let oy = 0;
  let dragPin = null;     // { id, x, y } while a shot is being dragged

  const toScreen = (lat, lon) => {
    const [u, v] = latLonToImage(meta, lat, lon);
    const s = s0 * k;
    return [u * s + ox, v * s + oy];
  };
  const toLatLon = (x, y) => {
    const s = s0 * k;
    return imageToLatLon(meta, (x - ox) / s, (y - oy) / s);
  };

  function fit() {
    if (!meta) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    s0 = Math.max(cw / meta.w, ch / meta.h);
    k = 1;
    ox = (cw - meta.w * s0) / 2;
    oy = (ch - meta.h * s0) / 2;
    apply();
  }

  // Keep the image covering the screen while panning/zooming.
  function clamp() {
    const s = s0 * k;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    ox = Math.min(0, Math.max(cw - meta.w * s, ox));
    oy = Math.min(0, Math.max(ch - meta.h * s, oy));
  }

  function zoomAt(x, y, newK) {
    newK = Math.max(1, Math.min(5, newK));
    const s = s0 * k;
    const ns = s0 * newK;
    ox = x - ((x - ox) / s) * ns;
    oy = y - ((y - oy) / s) * ns;
    k = newK;
    clamp();
    apply();
  }

  function apply() {
    const s = s0 * k;
    img.style.width = `${meta.w}px`;
    img.style.height = `${meta.h}px`;
    img.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
    draw();
  }

  function pinHtml(p, side) {
    const label = p.text ? `<span class="pin-text">${esc(p.text)}</span>` : '';
    const badge = `<span class="pin-badge${p.badgeClass ? ' ' + p.badgeClass : ''}">${esc(p.badge)}</span>`;
    return `<span class="pin-dot"></span><span class="pin-label pin-${side}">` +
      (side === 'right' ? badge + label : label + badge) + '</span>';
  }

  function draw() {
    if (!meta) return;
    svg.innerHTML = '';
    pins.innerHTML = '';
    const o = overlay;
    const shots = (o.shots || []).filter((sh) => sh.lat != null);

    // Shot line: through every shot, then to where the ball finished.
    const path = shots.map((sh) => (dragPin && dragPin.id === sh.id ? [dragPin.x, dragPin.y] : toScreen(sh.lat, sh.lon)));
    if (o.end) path.push(toScreen(o.end.lat, o.end.lon));
    if (path.length > 1) {
      const pl = document.createElementNS(SVGNS, 'polyline');
      pl.setAttribute('points', path.map((p) => p.join(',')).join(' '));
      pl.setAttribute('class', 'hv-line');
      svg.appendChild(pl);
    }

    // Target: tapped point with distances from the player and to the green.
    if (o.target) {
      const t = toScreen(o.target.lat, o.target.lon);
      const segs = [];
      if (o.target.from) segs.push([toScreen(o.target.from[0], o.target.from[1]), t, o.target.l1]);
      if (o.target.to) segs.push([t, toScreen(o.target.to[0], o.target.to[1]), o.target.l2]);
      for (const [a, b, text] of segs) {
        const ln = document.createElementNS(SVGNS, 'line');
        ln.setAttribute('x1', a[0]); ln.setAttribute('y1', a[1]);
        ln.setAttribute('x2', b[0]); ln.setAttribute('y2', b[1]);
        ln.setAttribute('class', 'hv-target-line');
        svg.appendChild(ln);
        if (text) {
          const el = document.createElement('div');
          el.className = 'hv-seg-label';
          el.textContent = text;
          el.style.left = `${(a[0] + b[0]) / 2}px`;
          el.style.top = `${(a[1] + b[1]) / 2}px`;
          pins.appendChild(el);
        }
      }
      const ring = document.createElement('div');
      ring.className = 'hv-target';
      ring.style.left = `${t[0]}px`;
      ring.style.top = `${t[1]}px`;
      pins.appendChild(ring);
    }

    shots.forEach((sh, i) => {
      const [x, y] = dragPin && dragPin.id === sh.id ? [dragPin.x, dragPin.y] : toScreen(sh.lat, sh.lon);
      const el = document.createElement('div');
      el.className = 'pin' + (o.editMode ? ' editable' : '') + (sh.excluded ? ' excluded' : '') +
        (dragPin && dragPin.id === sh.id ? ' dragging' : '');
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.innerHTML = o.editMode
        ? `<span class="pin-edit">${esc(sh.club)}</span>`
        : pinHtml({ badge: sh.club, text: sh.text }, i % 2 === 0 ? 'right' : 'left');
      el.dataset.id = sh.id;
      pins.appendChild(el);
    });

    if (o.end) {
      const [x, y] = toScreen(o.end.lat, o.end.lon);
      const el = document.createElement('div');
      el.className = 'pin pin-end';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.innerHTML = pinHtml({ badge: o.end.badge, text: o.end.text, badgeClass: 'putt' },
        shots.length % 2 === 0 ? 'right' : 'left');
      pins.appendChild(el);
    }

    if (o.me) {
      const [x, y] = toScreen(o.me[0], o.me[1]);
      const el = document.createElement('div');
      el.className = 'hv-me';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      pins.appendChild(el);
    }
  }

  // ---- Touch handling: pan, pinch, double-tap, tap, drag a shot -------------------

  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  stage.addEventListener('pointerdown', (e) => {
    if (!meta) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinEl = e.target.closest('.pin');
    if (pointers.size === 1) {
      gesture = { kind: 'maybe-tap', x0: e.clientX, y0: e.clientY, ox0: ox, oy0: oy, t0: Date.now(),
        pinId: pinEl && pinEl.dataset.id ? pinEl.dataset.id : null };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), k0: k };
      dragPin = null;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = stage.getBoundingClientRect();
    if (gesture.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, gesture.k0 * (d / gesture.d0));
      return;
    }
    const dx = e.clientX - gesture.x0;
    const dy = e.clientY - gesture.y0;
    if (gesture.kind === 'maybe-tap' && Math.hypot(dx, dy) > 8) {
      gesture.kind = gesture.pinId && overlay.editMode ? 'drag-pin' : 'pan';
    }
    if (gesture.kind === 'pan') {
      ox = gesture.ox0 + dx;
      oy = gesture.oy0 + dy;
      clamp();
      apply();
    } else if (gesture.kind === 'drag-pin') {
      // Lift the pin a little above the finger so it stays visible.
      dragPin = { id: gesture.pinId, x: e.clientX - rect.left, y: e.clientY - rect.top - 30 };
      draw();
    }
  });

  function end(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    const rect = stage.getBoundingClientRect();
    if (gesture.kind === 'drag-pin' && dragPin) {
      const [lat, lon] = toLatLon(dragPin.x, dragPin.y);
      const id = dragPin.id;
      dragPin = null;
      handlers.onPinDrag && handlers.onPinDrag(id, lat, lon);
    } else if (gesture.kind === 'maybe-tap' && Date.now() - gesture.t0 < 500) {
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (gesture.pinId) {
        handlers.onPinTap && handlers.onPinTap(gesture.pinId);
      } else if (Date.now() - lastTap < 300 && !overlay.editMode) {
        zoomAt(x, y, k > 1.5 ? 1 : 2.4); // double tap
        lastTap = 0;
      } else {
        lastTap = Date.now();
        const [lat, lon] = toLatLon(x, y);
        handlers.onTap && handlers.onTap(lat, lon);
      }
    }
    if (pointers.size === 0) gesture = null;
  }
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (meta) fit(); });

  return {
    // Show a hole. `src` is the image URL; `info` its image metadata.
    show(src, info, message) {
      meta = info || null;
      overlay = {};
      empty.hidden = !!meta;
      img.hidden = !meta;
      if (!meta) {
        empty.textContent = message || 'No image for this hole yet.';
        svg.innerHTML = '';
        pins.innerHTML = '';
        return;
      }
      img.onload = () => fit();
      img.src = src;
      fit();
    },
    setOverlay(o) {
      overlay = o;
      draw();
    },
    refit: fit,
    hasImage: () => !!meta,
  };
}
