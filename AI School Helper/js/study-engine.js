/**
 * study-engine.js — text → summaries, chunks, flashcards, quizzes
 *
 * No network calls here. Summaries are extractive (pick important sentences).
 * Chunks split on blank lines; flashcards are generated per chunk.
 * Quizzes reuse card answers as correct options and other answers as distractors.
 */

/** Common words ignored when scoring “important” terms. */
const STOP = new Set(
  "a an the and or but in on at to for of is are was were be been being it its this that these those as by with from into through during before after above below between under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very can will just about into over also".split(
    " "
  )
);

/** Lowercase tokens suitable for overlap / TF scoring. */
function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Split note text into paragraphs (blank-line separated) for chunks & cards. */
function splitChunks(content) {
  const parts = content
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [content.trim()].filter(Boolean);
  return parts;
}

/** Human-readable label for a chunk (first line, trimmed). */
function firstLineLabel(chunk) {
  const line = chunk.split("\n")[0].trim();
  const short = line.length > 72 ? `${line.slice(0, 69)}…` : line;
  return short || "General";
}

/** Body of chunk after the first line (drops title / heading so Q ≠ A). */
function bodyAfterFirstLine(chunk) {
  const nl = chunk.indexOf("\n");
  if (nl === -1) return "";
  return chunk.slice(nl + 1).trim();
}

/** Remove leading text from answer when it repeats the topic or first sentence. */
function stripLeadingDuplicate(label, sentenceStart, answer) {
  let a = (answer || "").trim();
  for (const prefix of [label, sentenceStart]) {
    const p = (prefix || "").replace(/…$/, "").trim();
    if (p.length < 6) continue;
    const pl = p.toLowerCase();
    const al = a.toLowerCase();
    if (al.startsWith(pl)) {
      a = a.slice(p.length).trim();
      if (a.startsWith(":") || a.startsWith("—") || a.startsWith("-")) a = a.slice(1).trim();
    }
  }
  return a;
}

/**
 * When the draft answer still opens like the chunk heading (common for one-line
 * “Key ideas: a; b; c” notes), use text after the first semicolon or the tail
 * of the chunk so the back of the card is not the same string as the title.
 */
function detailAwayFromOpening(fullChunk, opening, candidate) {
  let a = (candidate || "").trim();
  const op = (opening || "").replace(/…$/g, "").trim();
  if (op.length < 10 || a.length < 10) return a;
  const n = Math.min(28, op.length, a.length);
  if (a.slice(0, n).toLowerCase() !== op.slice(0, n).toLowerCase()) return a;
  const semi = fullChunk.indexOf(";");
  if (semi !== -1) {
    const tail = fullChunk.slice(semi + 1).trim();
    if (tail.length > 12) return tail.slice(0, 1200);
  }
  const from = Math.floor(fullChunk.length * 0.35);
  const tail2 = fullChunk.slice(from).trim();
  if (tail2.length > 12) return tail2.slice(0, 1200);
  return a.slice(Math.min(op.length, a.length)).trim().slice(0, 1200) || a;
}

/** True if two strings are substring variants (bad MC distractors). */
function answersTooSimilar(a, b) {
  const al = (a || "").toLowerCase().trim();
  const bl = (b || "").toLowerCase().trim();
  if (al.length < 12 || bl.length < 12) return false;
  if (al === bl) return true;
  if (al.includes(bl) || bl.includes(al)) return Math.min(al.length, bl.length) >= 18;
  return false;
}

/** Stable key for weak-topic tracking (same topic → same bucket). */
function topicKey(label) {
  return label.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

/** Rough sentence split on . ! ? for summarization. */
function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/**
 * Simple extractive summary: score sentences by term frequency in document.
 * Picks the top few sentences and joins them (order preserved in doc flow via index pick).
 */
export function summarize(content, maxSentences = 5) {
  const sentences = splitSentences(content);
  if (sentences.length === 0) return content.slice(0, 500);
  const docTokens = tokenize(content);
  const tf = {};
  for (const t of docTokens) tf[t] = (tf[t] || 0) + 1;
  const maxTf = Math.max(...Object.values(tf), 1);

  const scored = sentences.map((s, i) => {
    const st = tokenize(s);
    let score = 0;
    for (const t of st) score += (tf[t] || 0) / maxTf;
    score += st.length * 0.02;
    return { s, i, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = new Set(scored.slice(0, maxSentences).map((x) => x.i));
  const ordered = sentences.filter((_, i) => picked.has(i));
  return ordered.join(" ");
}

/**
 * Build searchable chunks + flashcards from raw note text.
 * @returns {{ chunks: { text, topic, topicKey }[], flashcards: { id, topic, topicKey, q, a }[] }}
 */
export function buildStudyMaterial(content, idPrefix) {
  const rawChunks = splitChunks(content);
  const chunks = rawChunks.map((text) => {
    const topic = firstLineLabel(text);
    return { text, topic, topicKey: topicKey(topic) };
  });

  const flashcards = [];
  let n = 0;
  for (const c of chunks) {
    const sentences = splitSentences(c.text);
    if (sentences.length === 0) continue;
    const head = sentences[0];
    const rest = sentences.slice(1).join(" ");
    const firstLineFull = c.text.split("\n")[0].trim();
    const afterLine = bodyAfterFirstLine(c.text);
    // Answer = supporting detail only, not the same line as the “topic” prompt.
    let back =
      rest.length > 12
        ? rest
        : afterLine.length > 12
          ? afterLine
          : sentences.length >= 2
            ? sentences.slice(1).join(" ")
            : summarize(c.text, 3);
    back = stripLeadingDuplicate(firstLineFull, head, back);
    if (back.length < 15) {
      back = summarize(c.text, 4).slice(0, 1200);
      back = stripLeadingDuplicate(firstLineFull, head, back);
    }
    if (back.length < 12) back = c.text.trim().slice(0, 1200);
    back = stripLeadingDuplicate(firstLineFull, head, back);
    if (back.length < 12 && head.length > 36) {
      const cut = Math.floor(head.length * 0.5);
      back = head.slice(cut).trim();
    }
    back = detailAwayFromOpening(c.text, firstLineFull, back);
    back = stripLeadingDuplicate(firstLineFull, head, back);
    if (back.length < 12) {
      back = detailAwayFromOpening(c.text, firstLineFull, summarize(c.text, 4)).slice(0, 1200);
    }

    const longHeading =
      firstLineFull.length > 44 || c.topic.endsWith("…") || c.topic.endsWith("...");
    const qStem = longHeading
      ? rest.length > 12 || afterLine.length > 12
        ? "Which detail is spelled out in this part of your notes?"
        : "Which statement best matches what this part of your notes is about?"
      : rest.length > 12 || afterLine.length > 12
        ? `What does your text say about “${c.topic}”?`
        : `What is the main idea for “${c.topic}”?`;

    flashcards.push({
      id: `${idPrefix}-fc-${n++}`,
      topic: c.topic,
      topicKey: c.topicKey,
      q: qStem,
      a: back.slice(0, 1200),
    });
    if (sentences.length >= 2) {
      flashcards.push({
        id: `${idPrefix}-fc-${n++}`,
        topic: c.topic,
        topicKey: c.topicKey,
        q: `In your notes, what follows this idea? “${head.slice(0, 120)}${head.length > 120 ? "…" : ""}”`,
        a: sentences[1].slice(0, 800),
      });
    }
  }

  if (flashcards.length === 0 && content.trim()) {
    flashcards.push({
      id: `${idPrefix}-fc-0`,
      topic: "Overview",
      topicKey: "overview",
      q: "What is the main takeaway from this material?",
      a: summarize(content, 3).slice(0, 1000),
    });
  }

  return { chunks, flashcards };
}

/**
 * @param {{ q: string, a: string }[]} cards
 * @returns {{ question: string, options: { text: string, correct: boolean }[], topicKey?: string }[] }
 */
const FALLBACK_DISTRACTORS = [
  "Not stated in these notes.",
  "A different concept from another section.",
  "The opposite of what the material describes.",
];

/** One MC question per card; wrong answers stolen from other cards when possible. */
export function buildQuiz(cards) {
  const answers = cards.map((c) => c.a);
  const quiz = [];
  for (let i = 0; i < cards.length; i++) {
    const correct = cards[i].a;
    const distractors = answers
      .filter((_, j) => j !== i)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    let safety = 0;
    while (distractors.length < 3 && answers.length > 1 && safety++ < 20) {
      const extra = answers[Math.floor(Math.random() * answers.length)];
      if (extra !== correct && !distractors.includes(extra)) distractors.push(extra);
    }
    for (const f of FALLBACK_DISTRACTORS) {
      if (distractors.length >= 3) break;
      if (f !== correct && !distractors.includes(f)) distractors.push(f);
    }
    const filtered = distractors.filter((d) => !answersTooSimilar(correct, d));
    let fillTries = 0;
    while (filtered.length < 3 && answers.length > 1 && fillTries++ < 40) {
      const extra = answers[Math.floor(Math.random() * answers.length)];
      if (
        extra !== correct &&
        !filtered.includes(extra) &&
        !answersTooSimilar(correct, extra)
      ) {
        filtered.push(extra);
      }
    }
    while (filtered.length < 3) {
      const f = FALLBACK_DISTRACTORS.find((x) => x !== correct && !filtered.includes(x));
      if (!f) break;
      filtered.push(f);
    }
    let question = cards[i].q;
    const cor = (correct || "").trim();
    if (cor.length >= 24) {
      const ql = question.toLowerCase();
      for (let len = Math.min(80, cor.length); len >= 22; len -= 6) {
        const frag = cor.slice(0, len).trim().toLowerCase();
        if (frag.length >= 20 && ql.includes(frag)) {
          question = "Which option matches what your notes say for this card?";
          break;
        }
      }
    }
    const options = [{ text: correct, correct: true }, ...filtered.slice(0, 3).map((t) => ({ text: t, correct: false }))].sort(
      () => Math.random() - 0.5
    );
    quiz.push({
      question,
      options,
      topicKey: cards[i].topicKey,
    });
  }
  return quiz.sort(() => Math.random() - 0.5);
}

/** For chat: rank note chunks by token overlap with the user’s question. */
export function rankChunksForQuestion(chunks, question, topK = 3) {
  const qTokens = new Set(tokenize(question));
  if (qTokens.size === 0) return chunks.slice(0, topK);
  const scored = chunks.map((c) => {
    const ct = tokenize(c.text);
    let hit = 0;
    for (const t of ct) if (qTokens.has(t)) hit++;
    return { c, score: hit / Math.sqrt(ct.length + 1) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0).slice(0, topK).map((x) => x.c);
}
