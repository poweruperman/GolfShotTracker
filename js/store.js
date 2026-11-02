/*
 * On-phone storage: one JSON document in localStorage. Rounds are small (a
 * few KB), so this holds years of golf. iOS can clear web-app storage, so
 * the Player tab offers a backup file and restore.
 */

import { DEFAULT_BAG } from './round.js';

const KEY = 'gst.v2';

function empty() {
  return { version: 2, bag: [...DEFAULT_BAG], active_round_id: null, rounds: [] };
}

export function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.version === 2) return s;
  } catch (e) { /* start fresh */ }
  return empty();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

// Restore from a backup file made by exportBackup. Returns the new state or throws.
export function parseBackup(text) {
  const s = JSON.parse(text);
  if (!s || s.version !== 2 || !Array.isArray(s.rounds)) throw new Error('Not a backup file from this app.');
  return s;
}

/*
 * The share sheet is the reliable way to get a file out of a home-screen app
 * on iPhone ("Save to Files", Mail, AirDrop). Falls back to a download link.
 */
export async function saveFile(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
