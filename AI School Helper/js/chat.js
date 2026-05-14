/**
 * chat.js — Q&A over your notes + optional OpenAI
 *
 * Without an API key: answers are built by pulling the chunks that best match
 * the question (keyword overlap). With a key: the model must answer only from
 * those chunks. generateNotesForTopic can draft a full note when the user has
 * no saved material yet (see app.js).
 */

import { rankChunksForQuestion } from "./study-engine.js";
import { fetchOpenAiChatCompletions } from "./openai-api.js";

const STUDY_TUTOR_SYSTEM_PROMPT =
  "You are an advanced study tutor. Teach clearly in simple steps, assume high-school level unless the student asks for another level, and keep responses concise but meaningful. Use examples when helpful. If the student seems confused or asks repeated questions, explicitly say: \"This seems like a weak area. Let’s practice it more.\" Then simplify and give extra practice. For problem-solving, guide step-by-step instead of only giving final answers. After each explanation, include 3-5 flashcards in this exact format on separate lines: Q: ... then A: ... . When appropriate, include a short 3-4 question multiple-choice quiz and list the correct answers at the end. Never mention being an AI model.";

/** Best-effort answer using only local retrieval (no network). */
function localAnswer(question, chunks) {
  const ranked = rankChunksForQuestion(chunks, question, 3);
  if (ranked.length === 0) {
    return {
      text:
        "I couldn’t find a strong match in your notes. This seems like a weak area. Let’s practice it more.\n\nTry sharing a little more detail, then I’ll teach it step-by-step with examples, flashcards, and a short quiz.",
      cites: [],
    };
  }
  const bullets = ranked.map((c, i) => `${i + 1}. ${c.topic}: ${c.text.slice(0, 220)}${c.text.length > 220 ? "…" : ""}`);
  const flashcards = ranked
    .slice(0, 3)
    .map(
      (c) =>
        `Q: What is the key idea in “${c.topic}”?\nA: ${c.text.slice(0, 160)}${c.text.length > 160 ? "…" : ""}`
    )
    .join("\n\n");

  const quiz = ranked
    .slice(0, 3)
    .map((c, i) => `${i + 1}) Which topic best matches this note? "${c.text.slice(0, 90)}..."`)
    .join("\n");

  return {
    text: `Step-by-step explanation based on your notes:\n1) Identify the core ideas:\n${bullets.join(
      "\n"
    )}\n2) Connect them to your question: focus on how these ideas relate directly to "${question}".\n3) Check understanding: explain each idea in your own words.\n\nFlashcards:\n${flashcards}\n\nQuick quiz:\n${quiz}\n\nCorrect answers:\n1) Topic 1\n2) Topic 2\n3) Topic 3`,
    cites: ranked.map((c) => c.topic),
  };
}

/**
 * Answer a question given note chunks. Uses OpenAI only if apiKey looks valid.
 * Falls back to localAnswer on error or missing key.
 */
export async function answerQuestion(question, chunks, apiKey) {
  const local = localAnswer(question, chunks);
  if (!apiKey || !apiKey.startsWith("sk-")) {
    return { ...local, source: "local" };
  }

  const context = chunks.map((c) => `[${c.topic}]\n${c.text}`).join("\n\n").slice(0, 12000);

  try {
    const res = await fetchOpenAiChatCompletions(apiKey, {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${STUDY_TUTOR_SYSTEM_PROMPT} Also: answer ONLY using the provided NOTES; if an answer is not in NOTES, say that clearly and ask for more material.`,
        },
        {
          role: "user",
          content: `NOTES:\n${context}\n\nQUESTION: ${question}\n\nReturn format:\n- Clear step-by-step explanation\n- 3-5 flashcards (Q:/A:)\n- Optional 3-4 question MC quiz when useful + answer key`,
        },
      ],
      max_tokens: 600,
      temperature: 0.3,
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        text: `API error (${res.status}). Showing local retrieval instead:\n\n${local.text}`,
        cites: local.cites,
        source: "fallback",
        detail: err.slice(0, 200),
      };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || local.text;
    return { text, cites: local.cites, source: "openai" };
  } catch (e) {
    return {
      text: `Network error. Local context:\n\n${local.text}`,
      cites: local.cites,
      source: "fallback",
      detail: String(e.message || e),
    };
  }
}

/**
 * Produce long-form notes for a topic (used when user has no saved set).
 * Without API key: returns a structured template the app still turns into flashcards.
 */
export async function generateNotesForTopic(topic, apiKey) {
  const safeTopic = topic.trim() || "the requested subject";
  if (!apiKey || !apiKey.startsWith("sk-")) {
    return `Title: ${safeTopic}\n\nOverview\n- Definition and key idea of ${safeTopic}.\n- Why it matters in the course.\n\nCore concepts\n- Main terms, formulas, or rules.\n- Typical examples you might see on homework or tests.\n\nWorked example\n- Step-by-step example problem using ${safeTopic}.\n\nCommon mistakes\n- 2–3 ways students usually get confused about ${safeTopic}.\n\nSummary\n- 3–5 bullet recap of the most important ideas.`;
  }

  try {
    const res = await fetchOpenAiChatCompletions(apiKey, {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a study tutor writing detailed notes for a high-school student. Use clear headings, simple language, step-by-step structure, examples, and at least one worked example. End with 3-5 flashcards in Q:/A: format and a short 3-4 question multiple-choice quiz with answer key.",
        },
        {
          role: "user",
          content: `Write detailed, student-friendly notes on: ${safeTopic}. Include:\n- High-level overview\n- Definitions of key terms\n- Important formulas or rules (if any)\n- At least one worked example\n- Common mistakes and tips\n- Short summary bullets at the end.`,
        },
      ],
      max_tokens: 900,
      temperature: 0.4,
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn("generateNotesForTopic API error", res.status, err);
      return `Could not reach the notes API (status ${res.status}). Here is a generic outline for ${safeTopic}:\n\n- Definition and key idea\n- Why it matters\n- Main concepts and examples\n- Common mistakes\n- Summary bullets.`;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || `Notes on ${safeTopic}.`;
  } catch (e) {
    console.warn("generateNotesForTopic network error", e);
    return `Network error while generating notes. Here is a generic outline for ${safeTopic}:\n\n- Definition and key idea\n- Why it matters\n- Main concepts and examples\n- Common mistakes\n- Summary bullets.`;
  }
}

function parseJsonFromModelContent(raw) {
  let t = (raw || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* try next */
      }
    }
    throw new Error("No valid JSON object in model output.");
  }
}

const QUIZ_AI_TIMEOUT_MS = 120000;

/** Chat completion for quiz JSON; retries without json_object if the API rejects that mode (400). */
async function openAiQuizChat(userBlock, systemContent, temperature, apiKey) {
  const base = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userBlock },
    ],
    max_tokens: 4096,
    temperature,
  };

  let res = await fetchOpenAiChatCompletions(
    apiKey,
    { ...base, response_format: { type: "json_object" } },
    QUIZ_AI_TIMEOUT_MS
  );

  if (!res.ok && res.status === 400) {
    const errBody = await res.text();
    if (/response_format|json_object/i.test(errBody)) {
      res = await fetchOpenAiChatCompletions(apiKey, base, QUIZ_AI_TIMEOUT_MS);
    } else {
      return { ok: false, error: `API error (400): ${errBody.slice(0, 200)}` };
    }
  }

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `API error (${res.status}): ${err.slice(0, 200)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Invalid response body from API." };
  }
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) return { ok: false, error: "Empty quiz response." };
  return { ok: true, raw };
}

/** Turn model JSON { questions: [...] } into quiz UI items (options shuffled). */
function normQuizOpt(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeAiMcOptions(rawOpts, correctIndex) {
  const o = rawOpts.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (o.length < 2) return null;
  const ci = Math.min(o.length - 1, Math.max(0, Number(correctIndex) || 0));
  const correctStr = o[ci];
  const correctNorm = normQuizOpt(correctStr);
  const seen = new Set();
  const uniq = [];
  for (const t of o) {
    const n = normQuizOpt(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    uniq.push(t);
  }
  let correctPos = uniq.findIndex((t) => normQuizOpt(t) === correctNorm);
  if (correctPos < 0) {
    uniq.unshift(correctStr);
    correctPos = 0;
    seen.add(correctNorm);
  }
  const PAD = [
    "Not stated in these notes.",
    "Only partly supported by the notes.",
    "Misstates the relationship the notes describe.",
    "Describes a different case than the notes emphasize.",
  ];
  let pi = 0;
  while (uniq.length < 4) {
    const p = PAD[pi++ % PAD.length];
    const pn = normQuizOpt(p);
    if (!seen.has(pn)) {
      seen.add(pn);
      uniq.push(p);
    }
    if (pi > 20) break;
  }
  const four = uniq.slice(0, 4);
  correctPos = Math.min(3, four.findIndex((t) => normQuizOpt(t) === correctNorm));
  if (correctPos < 0) correctPos = 0;
  const tagged = four.map((text, i) => ({ text, correct: i === correctPos }));
  return tagged.sort(() => Math.random() - 0.5);
}

function mapParsedQuestionsToItems(parsed, defaultTopicKey) {
  const qs = parsed?.questions;
  if (!Array.isArray(qs) || qs.length === 0) {
    return { ok: false, error: "Quiz response had no questions." };
  }
  const items = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") continue;
    const qText = String(q.question ?? "").trim();
    let opts = Array.isArray(q.options) ? q.options.map((x) => String(x)) : [];
    opts = opts.filter((s) => s.length > 0);
    if (qText.length < 3 || opts.length < 2) continue;
    const deduped = dedupeAiMcOptions(opts, q.correctIndex);
    if (!deduped) continue;
    const topicKey = typeof q.topicKey === "string" && q.topicKey ? q.topicKey : defaultTopicKey;
    items.push({
      question: qText,
      options: deduped,
      topicKey,
    });
  }
  if (items.length === 0) {
    return { ok: false, error: "Quiz response had no usable questions." };
  }
  return { ok: true, items };
}

const NO_VERBATIM_QUIZ_RULES =
  "CRITICAL: Do not copy sentences or long phrases from STUDENT_NOTES. Paraphrase every question and every answer option in fresh wording. Test understanding of ideas, not recognition of exact wording.";

/**
 * Standard study quiz: infer main ideas from notes and write MC questions in new words (OpenAI).
 */
export async function generateConceptualQuiz(notesContent, docTitle, apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) {
    return { ok: false, error: "Add an OpenAI API key for paraphrased quiz questions." };
  }
  const notes = (notesContent || "").trim().slice(0, 14000);
  if (notes.length < 40) {
    return { ok: false, error: "Notes are too short to build a conceptual quiz." };
  }
  const title = (docTitle || "").trim() || "Study set";

  const userBlock =
    `Document title: ${title}\n\nSTUDENT_NOTES:\n${notes}\n\n` +
    `${NO_VERBATIM_QUIZ_RULES}\n\n` +
    `First infer the main concepts from the notes, then write questions that check those concepts (recall, application, or "which best describes…").\n\n` +
    `Return ONLY valid JSON (no markdown fences) with this shape:\n` +
    `{"questions":[` +
    `{"question":"string","options":["A","B","C","D"],"correctIndex":0,"topicKey":"short-topic-slug"}` +
    `]}\n` +
    `Rules: 6 to 8 questions. Four options each. correctIndex 0-3. Distractors must be plausible but wrong. topicKey: short lowercase slug per question.`;

  try {
    const chat = await openAiQuizChat(
      userBlock,
      "You write multiple-choice study questions. Respond with a single JSON object only (no markdown). Never quote or closely mimic the student’s note text—always rephrase.",
      0.4,
      apiKey
    );
    if (!chat.ok) return chat;
    let parsed;
    try {
      parsed = parseJsonFromModelContent(chat.raw);
    } catch {
      return { ok: false, error: "Could not parse quiz JSON. Try again." };
    }
    return mapParsedQuestionsToItems(parsed, "concept-quiz");
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Build harder multiple-choice questions using student notes + optional Wikipedia extract.
 * Returns items compatible with the existing quiz UI: { question, options: [{text, correct}], topicKey }.
 */
export async function generateAdvancedQuiz(notesContent, docTitle, webExtract, webSourceLabel, apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) {
    return { ok: false, error: "Add an OpenAI API key to generate an advanced quiz." };
  }
  const notes = (notesContent || "").trim().slice(0, 14000);
  const web = (webExtract || "").trim().slice(0, 12000);
  const label = webSourceLabel || "Wikipedia";

  const userBlock =
    `STUDENT_NOTES:\n${notes}\n\n` +
    (web
      ? `REFERENCE (${label}, for extra context—prefer aligning with student notes when they conflict):\n${web}\n\n`
      : "No web reference was retrieved; base questions on STUDENT_NOTES only.\n\n") +
    `${NO_VERBATIM_QUIZ_RULES}\n\n` +
    `Return ONLY valid JSON (no markdown fences) with this shape:\n` +
    `{"questions":[` +
    `{"question":"string","options":["A","B","C","D"],"correctIndex":0,"topicKey":"short-topic-slug"}` +
    `]}\n` +
    `Rules: 6 to 8 questions. Four options each. correctIndex 0-3. Questions should be harder than simple recall: application, comparison, "which is FALSE", cause/effect, edge cases. Distractors must be plausible. topicKey should be a short lowercase slug (e.g. "photosynthesis-light-reactions").`;

  try {
    const chat = await openAiQuizChat(
      userBlock,
      "You write challenging multiple-choice questions for students. Respond with a single JSON object only (no markdown or prose). Never copy phrasing verbatim from the student notes—rephrase questions and options.",
      0.45,
      apiKey
    );
    if (!chat.ok) return chat;
    let parsed;
    try {
      parsed = parseJsonFromModelContent(chat.raw);
    } catch {
      return { ok: false, error: "Could not parse quiz JSON. Try again." };
    }
    return mapParsedQuestionsToItems(parsed, "advanced-quiz");
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
