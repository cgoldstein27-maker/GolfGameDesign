/**
 * weak-topics.js — track which sections you struggle with
 *
 * Topics are keyed by a normalized string (from the first line of each note chunk).
 * Quiz misses and SRS “Again” increase `wrong`; successful reviews increase `correct`.
 * The insights tab sorts by miss rate so you see what to revisit.
 */

export function recordWeak(state, topicKey, label, deltaWrong = 0, deltaCorrect = 0) {
  if (!topicKey) return;
  const w = state.weakTopics[topicKey] || {
    label: label || topicKey,
    wrong: 0,
    correct: 0,
  };
  if (label) w.label = label;
  w.wrong += deltaWrong;
  w.correct += deltaCorrect;
  state.weakTopics[topicKey] = w;
}

/** Sorted list of topics with at least one event, highest miss rate first. */
export function weakTopicList(state) {
  return Object.entries(state.weakTopics)
    .map(([key, v]) => {
      const total = v.wrong + v.correct;
      const rate = total ? v.wrong / total : 0;
      return { key, label: v.label, wrong: v.wrong, correct: v.correct, total, rate };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.rate - a.rate || b.wrong - a.wrong);
}

/** Clear all aggregated miss/hit counts (quiz + SRS). Does not change notes or SRS schedules. */
export function resetWeakTopics(state) {
  state.weakTopics = {};
}
