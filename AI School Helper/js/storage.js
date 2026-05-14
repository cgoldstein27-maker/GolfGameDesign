/**
 * storage.js — persistence for Study Smart
 *
 * All app data (note sets, SRS stats, weak-topic tallies) lives in the browser’s
 * localStorage under one JSON blob. Nothing is sent to a server unless the user
 * uses the optional OpenAI features elsewhere.
 */

/** Base key; app may append a user id for per-account storage. */
export const STORAGE_KEY_BASE = "study-smart-v1";

/** Fresh empty shape; merged with parsed data on load so new fields get defaults. */
export function defaultState() {
  return {
    docs: [], // saved note sets (content, summary, flashcards, chunks…)
    srs: {}, // per–flashcard-id spaced repetition metadata
    weakTopics: {}, // aggregated wrong/right counts by topic key
    activeDocId: null, // which set is selected in the Library UI
    /** Daily streak: `count` consecutive days ending at `lastDate` (YYYY-MM-DD local). */
    streak: { count: 0, lastDate: null },
    /** Current calendar week (Sunday YYYY-MM-DD) + which weekdays had a study session. */
    weekRing: { start: null, days: [false, false, false, false, false, false, false] },
  };
}

/** Read and parse state; on error or missing data, return defaults. */
export function loadState(storageKey = STORAGE_KEY_BASE) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, docs: parsed.docs || [] };
  } catch {
    return defaultState();
  }
}

/** Serialize the full state object to localStorage. */
export function saveState(state, storageKey = STORAGE_KEY_BASE) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

/** Short unique id for new documents and flashcards (no external deps). */
export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
