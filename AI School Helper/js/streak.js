/**
 * streak.js — consecutive-day study streak (local calendar).
 *
 * A qualifying day is recorded when the user rates an SRS card or answers a quiz
 * question. Missing more than one calendar day since the last activity clears the streak.
 */

/** @param {Date} [d] */
export function calendarDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function yesterdayKey() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return calendarDateKey(d);
}

/** Sunday YYYY-MM-DD of the week containing `d` (local time). */
export function weekSundayKey(d = new Date()) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const dow = x.getDay();
  x.setDate(x.getDate() - dow);
  return calendarDateKey(x);
}

/** Ensure `state.weekRing` matches the current calendar week. @returns {boolean} changed */
export function syncWeekRingToCalendar(state) {
  const ws = weekSundayKey();
  if (
    !state.weekRing ||
    typeof state.weekRing !== "object" ||
    !Array.isArray(state.weekRing.days) ||
    state.weekRing.days.length !== 7
  ) {
    state.weekRing = { start: ws, days: [false, false, false, false, false, false, false] };
    return true;
  }
  if (state.weekRing.start !== ws) {
    state.weekRing.start = ws;
    state.weekRing.days = [false, false, false, false, false, false, false];
    return true;
  }
  return false;
}

export function markWeekRingDayStudied(state) {
  syncWeekRingToCalendar(state);
  const dow = new Date().getDay();
  state.weekRing.days[dow] = true;
}

/** @returns {{ kind: 'done' | 'missed' | 'today' | 'future', dow: number }[]} */
export function getWeekRingSlots(state) {
  syncWeekRingToCalendar(state);
  const dow = new Date().getDay();
  const days = state.weekRing.days;
  const out = [];
  for (let i = 0; i < 7; i++) {
    if (days[i]) out.push({ kind: "done", dow: i });
    else if (i < dow) out.push({ kind: "missed", dow: i });
    else if (i === dow) out.push({ kind: "today", dow: i });
    else out.push({ kind: "future", dow: i });
  }
  return out;
}

export function weekCompletedCount(state) {
  if (!state.weekRing?.days) return 0;
  return state.weekRing.days.filter(Boolean).length;
}

/** @returns {{ lead: string, hot: string }} */
export function streakWeekMotivation(doneInWeek) {
  if (doneInWeek === 0) {
    return { lead: "Start strong — ", hot: "one session today locks it in." };
  }
  if (doneInWeek <= 3) {
    return { lead: "You're halfway to your ", hot: "perfect week!" };
  }
  if (doneInWeek <= 5) {
    return { lead: "You're close to a ", hot: "full week of studying." };
  }
  return { lead: "", hot: "Perfect week — incredible consistency!" };
}

/** Ensure `state.streak` exists with expected shape. */
export function ensureStreak(state) {
  if (!state.streak || typeof state.streak !== "object") {
    state.streak = { count: 0, lastDate: null };
    return;
  }
  if (typeof state.streak.count !== "number" || state.streak.count < 0) state.streak.count = 0;
  if (state.streak.lastDate != null && typeof state.streak.lastDate !== "string") state.streak.lastDate = null;
}

/**
 * If the last activity was more than one calendar day ago, clear the streak.
 * @returns {boolean} true if state was changed
 */
export function streakNormalizeIfLapsed(state) {
  ensureStreak(state);
  const last = state.streak.lastDate;
  if (!last) return false;
  const today = calendarDateKey();
  if (last === today) return false;
  const yKey = yesterdayKey();
  if (last === yKey) return false;
  state.streak.count = 0;
  state.streak.lastDate = null;
  return true;
}

/**
 * Mark today as an active study day (idempotent per calendar day).
 * @returns {boolean} true if streak fields were updated (caller may persist)
 */
export function applyStreakActivity(state) {
  ensureStreak(state);
  const today = calendarDateKey();
  if (state.streak.lastDate === today) return false;

  const last = state.streak.lastDate;
  const yKey = yesterdayKey();
  if (last == null) {
    state.streak.count = 1;
  } else if (last === yKey) {
    state.streak.count = Math.max(1, state.streak.count + 1);
  } else {
    state.streak.count = 1;
  }
  state.streak.lastDate = today;
  markWeekRingDayStudied(state);
  return true;
}

/** Visual tier 0–5: larger / hotter as count grows. */
export function streakFlameTier(count) {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 6) return 2;
  if (n <= 13) return 3;
  if (n <= 29) return 4;
  return 5;
}

/**
 * @returns {{ count: number, tier: number, atRisk: boolean }}
 */
export function getStreakUiState(state) {
  ensureStreak(state);
  const today = calendarDateKey();
  const last = state.streak.lastDate;
  const count = state.streak.count;
  const atRisk = count > 0 && last !== today;
  return { count, tier: streakFlameTier(count), atRisk };
}
