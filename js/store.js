/*
 * On-phone database: everything is kept in the browser's localStorage as one
 * JSON document. A full round is only a few kilobytes, so this is plenty for
 * now. Cloud sync (Phase 2) will copy the same records to Firebase/Supabase.
 *
 * iOS can wipe browser storage (for example after weeks without opening the
 * app), so export after each round until cloud sync exists.
 */

import { DEFAULT_BAG } from './round.js';

const KEY = 'golfTracker.v1';

function emptyState() {
  return { version: 1, bag: [...DEFAULT_BAG], active_round_id: null, rounds: [] };
}

export function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.version === 1) return s;
  } catch (e) { /* fall through to a fresh state */ }
  return emptyState();
}

// Returns false if the phone refused to save (storage full or blocked).
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

export function activeRound(state) {
  return state.rounds.find((r) => r.id === state.active_round_id) || null;
}

/*
 * On iPhone the share sheet is the reliable way to get a file out of a
 * home-screen app ("Save to Files", Mail, AirDrop). Fall back to a normal
 * download link where sharing files is not supported.
 */
export async function saveFile(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // share sheet closed
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
