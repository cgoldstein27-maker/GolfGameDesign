/*!
 * study-smart-bundle.js — Study Smart in one script for file://
 *
 * Browsers often block ES module `import` when you open HTML from disk.
 * This file inlines the same logic as js/storage.js, study-engine.js, srs.js,
 * weak-topics.js, chat.js, and app.js inside one IIFE so nothing is global
 * except what PDF.js sets (pdfjsLib) from index.html.
 *
 * Section order: STORAGE → STUDY ENGINE → SRS → WEAK TOPICS → CHAT → APP UI
 */

(function () {
  "use strict";

  /** Optional OpenAI-compatible API root (localStorage); default https://api.openai.com/v1 */
  var OPENAI_API_BASE_LS = "study-smart-openai-api-base";

  /* ========== STORAGE (localStorage) ========== */
  const STORAGE_KEY_BASE = "study-smart-v1";
  let CURRENT_STATE_KEY = STORAGE_KEY_BASE;

  function defaultState() {
    return { docs: [], srs: {}, weakTopics: {}, activeDocId: null };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(CURRENT_STATE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return { ...defaultState(), ...parsed, docs: parsed.docs || [] };
    } catch {
      return defaultState();
    }
  }

  function saveState(state) {
    localStorage.setItem(CURRENT_STATE_KEY, JSON.stringify(state));
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /* ========== STUDY ENGINE (summaries, chunks, cards, quiz, chunk rank) ========== */
  /** Words ignored when scoring “important” terms for summaries / chat match. */
  const STOP = new Set(
    "a an the and or but in on at to for of is are was were be been being it its this that these those as by with from into through during before after above below between under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very can will just about into over also".split(
      " "
    )
  );

  function tokenize(text) {
    if (text == null) return [];
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w));
  }

  function splitChunks(content) {
    const parts = content
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return [content.trim()].filter(Boolean);
    return parts;
  }

  function firstLineLabel(chunk) {
    const line = chunk.split("\n")[0].trim();
    const short = line.length > 72 ? `${line.slice(0, 69)}…` : line;
    return short || "General";
  }

  function bodyAfterFirstLine(chunk) {
    const nl = chunk.indexOf("\n");
    if (nl === -1) return "";
    return chunk.slice(nl + 1).trim();
  }

  function stripLeadingDuplicate(label, sentenceStart, answer) {
    var a = (answer || "").trim();
    var prefixes = [label, sentenceStart];
    for (var pi = 0; pi < prefixes.length; pi++) {
      var p = (prefixes[pi] || "").replace(/…$/, "").trim();
      if (p.length < 6) continue;
      var pl = p.toLowerCase();
      var al = a.toLowerCase();
      if (al.indexOf(pl) === 0) {
        a = a.slice(p.length).trim();
        if (a.charAt(0) === ":" || a.charAt(0) === "—" || a.charAt(0) === "-") a = a.slice(1).trim();
      }
    }
    return a;
  }

  function topicKey(label) {
    return label.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
  }

  function splitSentences(text) {
    return text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
  }

  /** Pick top sentences by TF overlap with the whole doc (extractive summary). */
  function summarize(content, maxSentences) {
    maxSentences = maxSentences === undefined ? 5 : maxSentences;
    const sentences = splitSentences(content);
    if (sentences.length === 0) return content.slice(0, 500);
    const docTokens = tokenize(content);
    const tf = {};
    for (const t of docTokens) tf[t] = (tf[t] || 0) + 1;
    const maxTf = Math.max.apply(null, Object.values(tf).concat([1]));

    const scored = sentences.map(function (s, i) {
      const st = tokenize(s);
      let score = 0;
      for (let ti = 0; ti < st.length; ti++) score += (tf[st[ti]] || 0) / maxTf;
      score += st.length * 0.02;
      return { s: s, i: i, score: score };
    });

    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    const picked = new Set(scored.slice(0, maxSentences).map(function (x) {
      return x.i;
    }));
    const ordered = sentences.filter(function (_, i) {
      return picked.has(i);
    });
    return ordered.join(" ");
  }

  /** Split into paragraphs → chunks with topic labels; build flashcard Q/A per chunk. */
  function buildStudyMaterial(content, idPrefix) {
    const rawChunks = splitChunks(content);
    const chunks = rawChunks.map(function (text) {
      const topic = firstLineLabel(text);
      return { text: text, topic: topic, topicKey: topicKey(topic) };
    });

    const flashcards = [];
    let n = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      const sentences = splitSentences(c.text);
      if (sentences.length === 0) continue;
      const head = sentences[0];
      const rest = sentences.slice(1).join(" ");
      const firstLineFull = c.text.split("\n")[0].trim();
      const afterLine = bodyAfterFirstLine(c.text);
      var back =
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
        back = head.slice(Math.floor(head.length * 0.5)).trim();
      }
      var qStem =
        rest.length > 12 || afterLine.length > 12
          ? 'What does your text say about "' + c.topic + '"?'
          : 'What is the main idea for "' + c.topic + '"?';
      flashcards.push({
        id: idPrefix + "-fc-" + n++,
        topic: c.topic,
        topicKey: c.topicKey,
        q: qStem,
        a: back.slice(0, 1200),
      });
      if (sentences.length >= 2) {
        flashcards.push({
          id: idPrefix + "-fc-" + n++,
          topic: c.topic,
          topicKey: c.topicKey,
          q:
            'In your notes, what follows this idea? "' +
            head.slice(0, 120) +
            (head.length > 120 ? "…" : "") +
            '"',
          a: sentences[1].slice(0, 800),
        });
      }
    }

    if (flashcards.length === 0 && content.trim()) {
      flashcards.push({
        id: idPrefix + "-fc-0",
        topic: "Overview",
        topicKey: "overview",
        q: "What is the main takeaway from this material?",
        a: summarize(content, 3).slice(0, 1000),
      });
    }

    return { chunks: chunks, flashcards: flashcards };
  }

  const FALLBACK_DISTRACTORS = [
    "Not stated in these notes.",
    "A different concept from another section.",
    "The opposite of what the material describes.",
  ];

  /** One multiple-choice question per card; distractors from other cards or fallbacks. */
  function buildQuiz(cards) {
    const answers = cards.map(function (c) {
      return c.a;
    });
    const quiz = [];
    for (let i = 0; i < cards.length; i++) {
      const correct = cards[i].a;
      const distractors = answers
        .filter(function (_, j) {
          return j !== i;
        })
        .sort(function () {
          return Math.random() - 0.5;
        })
        .slice(0, 3);
      let safety = 0;
      while (distractors.length < 3 && answers.length > 1 && safety++ < 20) {
        const extra = answers[Math.floor(Math.random() * answers.length)];
        if (extra !== correct && distractors.indexOf(extra) === -1) distractors.push(extra);
      }
      for (let fi = 0; fi < FALLBACK_DISTRACTORS.length; fi++) {
        const f = FALLBACK_DISTRACTORS[fi];
        if (distractors.length >= 3) break;
        if (f !== correct && distractors.indexOf(f) === -1) distractors.push(f);
      }
      const options = [{ text: correct, correct: true }].concat(
        distractors.map(function (t) {
          return { text: t, correct: false };
        })
      );
      options.sort(function () {
        return Math.random() - 0.5;
      });
      quiz.push({
        question: cards[i].q,
        options: options,
        topicKey: cards[i].topicKey,
      });
    }
    return quiz.sort(function () {
      return Math.random() - 0.5;
    });
  }

  /** Score chunks by token overlap with the user question (used by local chat). */
  function rankChunksForQuestion(chunks, question, topK) {
    topK = topK === undefined ? 3 : topK;
    const qTokens = new Set(tokenize(question));
    if (qTokens.size === 0) return chunks.slice(0, topK);
    const scored = chunks.map(function (c) {
      const ct = tokenize(c.text);
      let hit = 0;
      for (let ti = 0; ti < ct.length; ti++) if (qTokens.has(ct[ti])) hit++;
      return { c: c, score: hit / Math.sqrt(ct.length + 1) };
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored
      .filter(function (x) {
        return x.score > 0;
      })
      .slice(0, topK)
      .map(function (x) {
        return x.c;
      });
  }

  /* ========== SRS (SM-2 spaced repetition) ========== */
  function scheduleReview(quality, card) {
    let easeFactor = card.easeFactor === undefined ? 2.5 : card.easeFactor;
    let interval = card.interval === undefined ? 0 : card.interval;
    let repetitions = card.repetitions === undefined ? 0 : card.repetitions;
    const q = Math.min(5, Math.max(0, quality));

    if (q < 3) {
      repetitions = 0;
      interval = 1;
    } else {
      if (repetitions === 0) interval = 1;
      else if (repetitions === 1) interval = 6;
      else interval = Math.round(interval * easeFactor);
      repetitions += 1;
    }

    easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (easeFactor < 1.3) easeFactor = 1.3;

    const dayMs = 24 * 60 * 60 * 1000;
    const nextReview = Date.now() + interval * dayMs;

    return { easeFactor: easeFactor, interval: interval, repetitions: repetitions, nextReview: nextReview };
  }

  function defaultSrsMeta() {
    return { easeFactor: 2.5, interval: 0, repetitions: 0, nextReview: 0 };
  }

  function isDue(meta) {
    if (!meta || meta.nextReview === undefined) return true;
    return meta.nextReview <= Date.now();
  }

  /* ========== WEAK TOPICS (quiz + SRS mistakes) ========== */
  function recordWeak(state, topicKey, label, deltaWrong, deltaCorrect) {
    deltaWrong = deltaWrong || 0;
    deltaCorrect = deltaCorrect || 0;
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

  function weakTopicList(state) {
    return Object.keys(state.weakTopics)
      .map(function (key) {
        const v = state.weakTopics[key];
        const total = v.wrong + v.correct;
        const rate = total ? v.wrong / total : 0;
        return { key: key, label: v.label, wrong: v.wrong, correct: v.correct, total: total, rate: rate };
      })
      .filter(function (x) {
        return x.total > 0;
      })
      .sort(function (a, b) {
        return b.rate - a.rate || b.wrong - a.wrong;
      });
  }

  /* ========== CHAT (local retrieval + optional OpenAI) ========== */
  const STUDY_TUTOR_SYSTEM_PROMPT =
    "You are an advanced study tutor. Teach clearly in simple steps, assume high-school level unless the student asks for another level, and keep responses concise but meaningful. Use examples when helpful. If the student seems confused or asks repeated questions, explicitly say: \"This seems like a weak area. Let’s practice it more.\" Then simplify and give extra practice. For problem-solving, guide step-by-step instead of only giving final answers. After each explanation, include 3-5 flashcards in this exact format on separate lines: Q: ... then A: ... . When appropriate, include a short 3-4 question multiple-choice quiz and list the correct answers at the end. Never mention being an AI model.";

  function openAiChatCompletionsUrl() {
    var def = "https://api.openai.com/v1/chat/completions";
    try {
      var b = localStorage.getItem(OPENAI_API_BASE_LS);
      var base = (b || "").trim().replace(/\/+$/, "");
      if (!base || !/^https?:\/\//i.test(base)) return def;
      return base + "/chat/completions";
    } catch (e) {
      return def;
    }
  }

  /** OpenAI-compatible chat/completions with abort so the UI cannot hang on a stalled request. */
  function openaiChatFetch(apiKey, payload, timeoutMs) {
    timeoutMs = timeoutMs === undefined ? 90000 : timeoutMs;
    var ctrl = new AbortController();
    var tid = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs);
    return fetch(openAiChatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).finally(function () {
      clearTimeout(tid);
    });
  }

  function normalizeChatChunks(chunks) {
    if (!Array.isArray(chunks)) return [];
    return chunks
      .map(function (c) {
        if (!c || typeof c !== "object") return null;
        return {
          topic: c.topic != null ? String(c.topic) : "",
          text: c.text != null ? String(c.text) : "",
        };
      })
      .filter(function (c) {
        return c && c.text.length > 0;
      });
  }

  function localAnswer(question, chunks) {
    const ranked = rankChunksForQuestion(chunks, question, 3);
    if (ranked.length === 0) {
      return {
        text:
          "I couldn’t find a strong match in your notes. This seems like a weak area. Let’s practice it more.\n\nTry sharing a little more detail, then I’ll teach it step-by-step with examples, flashcards, and a short quiz.",
        cites: [],
      };
    }
    const bullets = ranked
      .map(function (c) {
        return c.topic + ": " + c.text.slice(0, 220) + (c.text.length > 220 ? "…" : "");
      })
      .join("\n");
    const flashcards = ranked
      .slice(0, 3)
      .map(function (c) {
        return (
          "Q: What is the key idea in \"" +
          c.topic +
          "\"?\nA: " +
          c.text.slice(0, 160) +
          (c.text.length > 160 ? "…" : "")
        );
      })
      .join("\n\n");
    const quiz = ranked
      .slice(0, 3)
      .map(function (c, i) {
        return i + 1 + ") Which topic best matches this note? \"" + c.text.slice(0, 90) + "...\"";
      })
      .join("\n");
    return {
      text:
        "Step-by-step explanation based on your notes:\n1) Identify the core ideas:\n" +
        bullets +
        '\n2) Connect them to your question: focus on how these ideas relate directly to "' +
        question +
        "\".\n3) Check understanding: explain each idea in your own words.\n\nFlashcards:\n" +
        flashcards +
        "\n\nQuick quiz:\n" +
        quiz +
        "\n\nCorrect answers:\n1) Topic 1\n2) Topic 2\n3) Topic 3",
      cites: ranked.map(function (c) {
        return c.topic;
      }),
    };
  }

  /** Returns a Promise (fetch) so the UI can .then() without async/await if needed. */
  function answerQuestion(question, chunks, apiKey) {
    const safeChunks = normalizeChatChunks(chunks);
    var local;
    try {
      local = localAnswer(question, safeChunks);
    } catch (err) {
      local = {
        text:
          "Something went wrong reading your notes. Try reloading the page or re-uploading your file.\n\n" +
          String(err && err.message ? err.message : err),
        cites: [],
      };
    }
    if (!apiKey || apiKey.indexOf("sk-") !== 0) {
      return Promise.resolve(Object.assign({}, local, { source: "local" }));
    }

    const context = safeChunks
      .map(function (c) {
        return "[" + c.topic + "]\n" + c.text;
      })
      .join("\n\n")
      .slice(0, 12000);

    return openaiChatFetch(apiKey, {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            STUDY_TUTOR_SYSTEM_PROMPT +
            " Also: answer ONLY using the provided NOTES; if an answer is not in NOTES, say that clearly and ask for more material.",
        },
        {
          role: "user",
          content:
            "NOTES:\n" +
            context +
            "\n\nQUESTION: " +
            question +
            "\n\nReturn format:\n- Clear step-by-step explanation\n- 3-5 flashcards (Q:/A:)\n- Optional 3-4 question MC quiz when useful + answer key",
        },
      ],
      max_tokens: 600,
      temperature: 0.3,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (err) {
            return {
              text: "API error (" + res.status + "). Showing local retrieval instead:\n\n" + local.text,
              cites: local.cites,
              source: "fallback",
              detail: err.slice(0, 200),
            };
          });
        }
        return res.json().then(function (data) {
          const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
            ? data.choices[0].message.content.trim()
            : local.text);
          return { text: text, cites: local.cites, source: "openai" };
        });
      })
      .catch(function (e) {
        return {
          text: "Network error. Local context:\n\n" + local.text,
          cites: local.cites,
          source: "fallback",
          detail: String(e.message || e),
        };
      });
  }

  /** Long-form notes for “no saved set yet” flow; template if no API key. */
  function generateNotesForTopic(topic, apiKey) {
    const safeTopic = topic.trim() || "the requested subject";
    if (!apiKey || apiKey.indexOf("sk-") !== 0) {
      return Promise.resolve(
        "Title: " +
          safeTopic +
          "\n\nOverview\n- Definition and key idea of " +
          safeTopic +
          ".\n- Why it matters in the course.\n\nCore concepts\n- Main terms, formulas, or rules.\n- Typical examples you might see on homework or tests.\n\nWorked example\n- Step-by-step example problem using " +
          safeTopic +
          ".\n\nCommon mistakes\n- 2–3 ways students usually get confused about " +
          safeTopic +
          ".\n\nSummary\n- 3–5 bullet recap of the most important ideas."
      );
    }

    return openaiChatFetch(apiKey, {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a study tutor writing detailed notes for a high-school student. Use clear headings, simple language, step-by-step structure, examples, and at least one worked example. End with 3-5 flashcards in Q:/A: format and a short 3-4 question multiple-choice quiz with answer key.",
        },
        {
          role: "user",
          content:
            "Write detailed, student-friendly notes on: " +
            safeTopic +
            ". Include:\n- High-level overview\n- Definitions of key terms\n- Important formulas or rules (if any)\n- At least one worked example\n- Common mistakes and tips\n- Short summary bullets at the end.",
        },
      ],
      max_tokens: 900,
      temperature: 0.4,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (err) {
            console.warn("generateNotesForTopic API error", res.status, err);
            return (
              "Could not reach the notes API (status " +
              res.status +
              "). Here is a generic outline for " +
              safeTopic +
              ":\n\n- Definition and key idea\n- Why it matters\n- Main concepts and examples\n- Common mistakes\n- Summary bullets."
            );
          });
        }
        return res.json().then(function (data) {
          const text =
            data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
              ? data.choices[0].message.content.trim()
              : null;
          return text || "Notes on " + safeTopic + ".";
        });
      })
      .catch(function (e) {
        console.warn("generateNotesForTopic network error", e);
        return (
          "Network error while generating notes. Here is a generic outline for " +
          safeTopic +
          ":\n\n- Definition and key idea\n- Why it matters\n- Main concepts and examples\n- Common mistakes\n- Summary bullets."
        );
      });
  }

  /* ========== WEB + AI (Wikipedia context, note refine, advanced quiz) ========== */
  var WIKI_REQUEST_TIMEOUT_MS = 8000;
  var WIKI_TOTAL_TIMEOUT_MS = 12000;

  function wikiTimedOutResult() {
    return { title: "", extract: "", url: "", timedOut: true };
  }

  function fetchJsonWithTimeout(url, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs);
    return fetch(url, { signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .finally(function () {
        clearTimeout(tid);
      });
  }

  function fetchWikipediaContext(query, maxChars) {
    maxChars = maxChars === undefined ? 12000 : maxChars;
    var q = (query || "").trim().slice(0, 200);
    if (!q) return Promise.resolve(null);
    var startedAt = Date.now();
    function timeLeft() {
      return Math.max(0, WIKI_TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
    }
    var searchUrl =
      "https://en.wikipedia.org/w/api.php?action=opensearch&search=" +
      encodeURIComponent(q) +
      "&limit=1&namespace=0&format=json&origin=*";
    var sTimeout = Math.min(WIKI_REQUEST_TIMEOUT_MS, Math.max(1200, timeLeft()));
    if (sTimeout <= 0) return Promise.resolve(wikiTimedOutResult());
    return fetchJsonWithTimeout(searchUrl, sTimeout)
      .then(function (sRes) {
        var sData = sRes;
        if (!sData || !Array.isArray(sData[1])) return null;
        var titles = sData[1];
        if (!titles.length) return null;
        var title = titles[0];
        var extractUrl =
          "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&exintro=false&explaintext=true&titles=" +
          encodeURIComponent(title);
        var eTimeout = Math.min(WIKI_REQUEST_TIMEOUT_MS, Math.max(1200, timeLeft()));
        if (eTimeout <= 0) return wikiTimedOutResult();
        return fetchJsonWithTimeout(extractUrl, eTimeout).then(function (eData) {
          if (!eData) return null;
            var pages = eData.query && eData.query.pages;
            if (!pages) return null;
            var page = pages[Object.keys(pages)[0]];
            if (!page || page.missing) return null;
            var extract = (page.extract || "").replace(/\s+/g, " ").trim();
            if (maxChars && extract.length > maxChars) extract = extract.slice(0, maxChars) + "…";
            var url = "https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
            return { title: title, extract: extract, url: url };
        });
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") return wikiTimedOutResult();
        return null;
      });
  }

  function parseJsonFromModelContent(raw) {
    var t = (raw || "").trim();
    if (t.indexOf("```") === 0) {
      t = t.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    }
    try {
      return JSON.parse(t);
    } catch (e1) {
      var start = t.indexOf("{");
      var end = t.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(t.slice(start, end + 1));
        } catch (e2) {
          /* fall through */
        }
      }
      throw new Error("No valid JSON object in model output.");
    }
  }

  function openAiQuizChat(userBlock, systemContent, temperature, apiKey) {
    var base = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userBlock },
      ],
      max_tokens: 4096,
      temperature: temperature,
    };
    function finishResponse(res) {
      if (!res.ok) {
        return res.text().then(function (err) {
          return { ok: false, error: "API error (" + res.status + "): " + err.slice(0, 200) };
        });
      }
      return res.json().then(function (data) {
        var raw =
          data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
            ? data.choices[0].message.content.trim()
            : "";
        if (!raw) return { ok: false, error: "Empty quiz response." };
        return { ok: true, raw: raw };
      });
    }
    return openaiChatFetch(apiKey, Object.assign({}, base, { response_format: { type: "json_object" } }), 120000)
      .then(function (res) {
        if (!res.ok && res.status === 400) {
          return res.text().then(function (errBody) {
            if (/response_format|json_object/i.test(errBody)) {
              return openaiChatFetch(apiKey, base, 120000).then(finishResponse);
            }
            return { ok: false, error: "API error (400): " + errBody.slice(0, 200) };
          });
        }
        return finishResponse(res);
      })
      .catch(function (e) {
        return { ok: false, error: String(e.message || e) };
      });
  }

  function refineNotesWithAI(rawNotes, title, apiKey) {
    if (!apiKey || apiKey.indexOf("sk-") !== 0) {
      var local = String(rawNotes || "").trim();
      if (!local) return Promise.resolve({ ok: false, error: "No note text to refine." });
      var lines = local.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
      var bullets = lines.slice(0, 12).map(function (x) { return "- " + x; }).join("\n");
      var localRefined =
        "# " +
        (title || "Refined notes") +
        "\n\n## Overview\n" +
        bullets +
        "\n\n## Key terms\n- Add or clarify definitions from your class notes.\n\n## Core ideas\n- Group related points into clear sections.\n\n## Examples / applications\n- Add one worked example using your own wording.\n\n## Common confusions\n- List what is easiest to mix up and why.\n\n## Review checklist\n- [ ] I can explain this topic from memory.\n- [ ] I can answer one practice question.\n";
      return Promise.resolve({ ok: true, text: localRefined });
    }
    var trimmed = (rawNotes || "").trim().slice(0, 28000);
    if (!trimmed) return Promise.resolve({ ok: false, error: "No note text to refine." });
    return openaiChatFetch(
      apiKey,
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an academic study coach. Rewrite the student's notes into polished study notes: clear headings, precise definitions, numbered steps where useful, and short examples. Expand only with widely standard educational explanations that are consistent with the student's text. Do not invent specific facts, dates, or citations not implied by the notes; if something is unclear, write [verify] instead of guessing. Tone: formal but readable for high school. No meta commentary.",
          },
          {
            role: "user",
            content:
              "Document title (context): " +
              (title || "Untitled") +
              "\n\nORIGINAL NOTES:\n" +
              trimmed +
              "\n\nProduce refined notes with sections: Overview, Key terms, Core ideas, Examples / applications, Common confusions, Short review checklist (bullets).",
          },
        ],
        max_tokens: 3500,
        temperature: 0.35,
      },
      120000
    )
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (err) {
            return { ok: false, error: "API error (" + res.status + "): " + err.slice(0, 180) };
          });
        }
        return res.json().then(function (data) {
          var text =
            data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
              ? data.choices[0].message.content.trim()
              : "";
          if (!text) return { ok: false, error: "Empty response from API." };
          return { ok: true, text: text };
        });
      })
      .catch(function (e) {
        return { ok: false, error: String(e.message || e) };
      });
  }

  var NO_VERBATIM_QUIZ_RULES =
    "CRITICAL: Do not copy sentences or long phrases from STUDENT_NOTES. Paraphrase every question and every answer option in fresh wording. Test understanding of ideas, not recognition of exact wording.";

  function mapParsedQuestionsToItems(parsed, defaultTopicKey) {
    var qs = parsed && parsed.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
      return { ok: false, error: "Quiz response had no questions." };
    }
    var items = [];
    for (var iq = 0; iq < qs.length; iq++) {
      var q = qs[iq];
      if (!q || typeof q !== "object") continue;
      var qText = String(q.question != null ? q.question : "").trim();
      var opts = [];
      if (Array.isArray(q.options)) {
        for (var j = 0; j < q.options.length; j++) {
          opts.push(String(q.options[j]));
        }
      }
      opts = opts.filter(function (s) {
        return s.length > 0;
      }).slice(0, 4);
      if (qText.length < 3 || opts.length < 2) continue;
      while (opts.length < 4) opts.push("(option)");
      var idx = Math.min(3, Math.max(0, Number(q.correctIndex) || 0));
      var topicKey = typeof q.topicKey === "string" && q.topicKey ? q.topicKey : defaultTopicKey;
      var tagged = opts.map(function (text, i) {
        return { text: text, correct: i === idx };
      });
      var shuffled = tagged.sort(function () {
        return Math.random() - 0.5;
      });
      items.push({
        question: qText,
        options: shuffled.map(function (x) {
          return { text: x.text, correct: x.correct };
        }),
        topicKey: topicKey,
      });
    }
    if (items.length === 0) {
      return { ok: false, error: "Quiz response had no usable questions." };
    }
    return { ok: true, items: items };
  }

  function generateConceptualQuiz(notesContent, docTitle, apiKey) {
    if (!apiKey || apiKey.indexOf("sk-") !== 0) {
      return Promise.resolve({ ok: false, error: "AI paraphrasing is unavailable in local mode." });
    }
    var notes = (notesContent || "").trim().slice(0, 14000);
    if (notes.length < 40) {
      return Promise.resolve({ ok: false, error: "Notes are too short to build a conceptual quiz." });
    }
    var title = (docTitle || "").trim() || "Study set";
    var userBlock =
      "Document title: " +
      title +
      "\n\nSTUDENT_NOTES:\n" +
      notes +
      "\n\n" +
      NO_VERBATIM_QUIZ_RULES +
      "\n\n" +
      "First infer the main concepts from the notes, then write questions that check those concepts (recall, application, or which best describes…).\n\n" +
      'Return ONLY valid JSON (no markdown fences) with this shape:\n{"questions":[{"question":"string","options":["A","B","C","D"],"correctIndex":0,"topicKey":"short-topic-slug"}]}\n' +
      "Rules: 6 to 8 questions. Four options each. correctIndex 0-3. Distractors must be plausible but wrong. topicKey: short lowercase slug per question.";

    return openAiQuizChat(
      userBlock,
      "You write multiple-choice study questions. Respond with a single JSON object only (no markdown). Never quote or closely mimic the student’s note text—always rephrase.",
      0.4,
      apiKey
    ).then(function (chat) {
      if (!chat.ok) return chat;
      var parsed;
      try {
        parsed = parseJsonFromModelContent(chat.raw);
      } catch (e) {
        return { ok: false, error: "Could not parse quiz JSON. Try again." };
      }
      return mapParsedQuestionsToItems(parsed, "concept-quiz");
    });
  }

  function generateAdvancedQuiz(notesContent, docTitle, webExtract, webSourceLabel, apiKey) {
    if (!apiKey || apiKey.indexOf("sk-") !== 0) {
      return Promise.resolve({ ok: false, error: "Advanced AI quiz is unavailable in local mode." });
    }
    var notes = (notesContent || "").trim().slice(0, 14000);
    var web = (webExtract || "").trim().slice(0, 12000);
    var label = webSourceLabel || "Wikipedia";
    var userBlock =
      "STUDENT_NOTES:\n" +
      notes +
      "\n\n" +
      (web
        ? "REFERENCE (" +
          label +
          ", for extra context—prefer aligning with student notes when they conflict):\n" +
          web +
          "\n\n"
        : "No web reference was retrieved; base questions on STUDENT_NOTES only.\n\n") +
      NO_VERBATIM_QUIZ_RULES +
      "\n\n" +
      'Return ONLY valid JSON (no markdown fences) with this shape:\n{"questions":[{"question":"string","options":["A","B","C","D"],"correctIndex":0,"topicKey":"short-topic-slug"}]}\nRules: 6 to 8 questions. Four options each. correctIndex 0-3. Questions should be harder than simple recall: application, comparison, "which is FALSE", cause/effect, edge cases. Distractors must be plausible. topicKey should be a short lowercase slug (e.g. "photosynthesis-light-reactions").';

    return openAiQuizChat(
      userBlock,
      "You write challenging multiple-choice questions for students. Respond with a single JSON object only (no markdown or prose). Never copy phrasing verbatim from the student notes—rephrase questions and options.",
      0.45,
      apiKey
    ).then(function (chat) {
      if (!chat.ok) return chat;
      var parsed;
      try {
        parsed = parseJsonFromModelContent(chat.raw);
      } catch (e) {
        return { ok: false, error: "Could not parse quiz JSON. Try again." };
      }
      return mapParsedQuestionsToItems(parsed, "advanced-quiz");
    });
  }

  /* ========== APP (DOM, tabs, Library, SRS UI, Quiz, Chat wiring) ========== */
  const OPENAI_STORAGE = "study-smart-openai-key";
  const USER_INDEX_KEY = "study-smart-users-v1";
  const SESSION_KEY = "study-smart-session";
  const LAST_TAB_KEY = "study-smart-last-tab";
  var VALID_TABS = { library: 1, study: 1, quiz: 1, insights: 1, chat: 1 };
  var mainAppInitialized = false;
  let state = defaultState();
  const $ = function (sel) {
    return document.querySelector(sel);
  };

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function userIdFromEmail(email) {
    var e = normalizeEmail(email);
    var hash = 0;
    for (var i = 0; i < e.length; i++) hash = (hash * 31 + e.charCodeAt(i)) >>> 0;
    return "u-" + hash.toString(36);
  }

  function storageKeyForSession(s) {
    if (!s || !s.userId) return STORAGE_KEY_BASE;
    return STORAGE_KEY_BASE + "::" + s.userId;
  }

  function loadUserIndex() {
    try {
      var raw = localStorage.getItem(USER_INDEX_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveUserIndex(index) {
    localStorage.setItem(USER_INDEX_KEY, JSON.stringify(index || {}));
  }

  function randomSaltHex() {
    var arr = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    var out = "";
    for (var i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
    return out;
  }

  function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.reject(new Error("Secure hashing is unavailable in this browser."));
    }
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || ""))).then(function (buf) {
      var arr = new Uint8Array(buf);
      var out = "";
      for (var i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
      return out;
    });
  }

  function loadSessionRecord() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object" || !s.userId || !s.email) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function saveSessionRecord(email, rememberMe) {
    var norm = normalizeEmail(email);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        email: norm,
        userId: userIdFromEmail(norm),
        rememberMe: !!rememberMe,
      })
    );
  }

  function getLastTab() {
    try {
      var t = localStorage.getItem(LAST_TAB_KEY);
      return t && VALID_TABS[t] ? t : "library";
    } catch (e) {
      return "library";
    }
  }

  function persistLastTab(name) {
    if (!VALID_TABS[name]) return;
    try {
      localStorage.setItem(LAST_TAB_KEY, name);
    } catch (e) {}
  }

  function updateSessionHeader() {
    var s = loadSessionRecord();
    var wrap = $("#header-session");
    var greet = $("#session-greeting");
    if (!wrap || !greet) return;
    var email = s && s.email ? String(s.email).trim() : "";
    if (email) {
      greet.textContent = "Signed in as " + email;
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }

  function showStartGate() {
    var gate = $("#start-screen");
    if (gate) gate.hidden = false;
    document.body.classList.add("start-gate-active");
  }

  function hideStartGate() {
    var gate = $("#start-screen");
    if (gate) gate.hidden = true;
    document.body.classList.remove("start-gate-active");
  }

  function shouldSkipStartGate() {
    var s = loadSessionRecord();
    return !!(s && s.rememberMe && s.userId && s.email);
  }

  function initMainApp() {
    if (mainAppInitialized) return;
    mainAppInitialized = true;
    var s = loadSessionRecord();
    CURRENT_STATE_KEY = storageKeyForSession(s);
    state = loadState();
    if (!state.docs.length) state = Object.assign(defaultState(), state);
    bindUi();
    syncOpenAiKeyFields();
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    renderWeakTopics();
    setTab(getLastTab());
    updateSessionHeader();
  }

  function onStartContinue() {
    var err = $("#start-error");
    var emailInput = $("#start-email");
    var passInput = $("#start-password");
    var remember = $("#start-remember");
    var email = normalizeEmail(emailInput && emailInput.value);
    var pass = String((passInput && passInput.value) || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (err) err.textContent = "Enter a valid email address.";
      return;
    }
    if (pass.length < 8) {
      if (err) err.textContent = "Password must be at least 8 characters.";
      return;
    }
    if (err) err.textContent = "Signing in…";
    var users = loadUserIndex();
    var existing = users[email];
    var salt = existing && existing.salt ? existing.salt : randomSaltHex();
    sha256Hex(salt + "|" + pass)
      .then(function (hash) {
        if (existing) {
          if (existing.passHash !== hash) {
            if (err) err.textContent = "Incorrect password for this email.";
            return;
          }
        } else {
          users[email] = { email: email, salt: salt, passHash: hash, createdAt: Date.now() };
          saveUserIndex(users);
        }
        saveSessionRecord(email, remember ? remember.checked !== false : true);
        hideStartGate();
        initMainApp();
      })
      .catch(function (e) {
        if (err) err.textContent = String(e && e.message ? e.message : e);
      });
  }

  function signOut() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
    location.reload();
  }

  function readApiKey() {
    function norm(v) {
      return v == null || typeof v !== "string" ? "" : v.trim().replace(/\u00a0/g, "");
    }
    var c = $("#openai-key");
    var q = $("#quiz-openai-key");
    return (
      norm(c && c.value) ||
      norm(q && q.value) ||
      norm(localStorage.getItem(OPENAI_STORAGE)) ||
      ""
    );
  }

  function syncOpenAiKeyFields() {
    var v = localStorage.getItem(OPENAI_STORAGE) || "";
    var keys = ["openai-key", "quiz-openai-key"];
    for (var i = 0; i < keys.length; i++) {
      var el = document.getElementById(keys[i]);
      if (el && !el.value) el.value = v;
    }
  }

  function persistOpenAiKeyFromField(el) {
    if (!el) return;
    var v = (el.value || "").trim();
    if (v) localStorage.setItem(OPENAI_STORAGE, v);
    else localStorage.removeItem(OPENAI_STORAGE);
    var keys2 = ["openai-key", "quiz-openai-key"];
    for (var j = 0; j < keys2.length; j++) {
      var other = document.getElementById(keys2[j]);
      if (other && other !== el) other.value = v;
    }
  }

  function syncOpenAiBaseField() {
    var el = $("#openai-api-base");
    if (!el) return;
    try {
      var v = localStorage.getItem(OPENAI_API_BASE_LS) || "";
      if (v && !el.value) el.value = v;
    } catch (e) {}
  }

  function persistOpenAiBaseFromField() {
    var el = $("#openai-api-base");
    if (!el) return;
    var v = (el.value || "").trim().replace(/\/+$/, "");
    try {
      if (!v) localStorage.removeItem(OPENAI_API_BASE_LS);
      else if (/^https?:\/\//i.test(v)) localStorage.setItem(OPENAI_API_BASE_LS, v);
    } catch (e) {}
  }

  function persist() {
    saveState(state);
  }

  function setTab(name) {
    const tabs = document.querySelectorAll(".tab");
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      const on = t.getAttribute("data-tab") === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
    const panels = document.querySelectorAll(".panel");
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      const active = p.id === "panel-" + name;
      p.classList.toggle("active", active);
      p.hidden = !active;
    }
    persistLastTab(name);
  }

  function getDoc(id) {
    for (let i = 0; i < state.docs.length; i++) if (state.docs[i].id === id) return state.docs[i];
    return null;
  }

  function renderDocList() {
    const ul = $("#doc-list");
    const empty = $("#doc-empty");
    ul.innerHTML = "";
    if (state.docs.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (let i = 0; i < state.docs.length; i++) {
      const d = state.docs[i];
      const li = document.createElement("li");
      li.dataset.id = d.id;
      li.classList.toggle("active", d.id === state.activeDocId);
      li.innerHTML = '<span class="title"></span><span class="meta"></span>';
      li.querySelector(".title").textContent = d.title;
      li.querySelector(".meta").textContent =
        (d.flashcards && d.flashcards.length ? d.flashcards.length : 0) + " cards";
      li.addEventListener(
        "click",
        (function (docId) {
          return function () {
            state.activeDocId = docId;
            persist();
            renderDocList();
            renderActiveDoc();
            refreshSelectors();
          };
        })(d.id)
      );
      ul.appendChild(li);
    }
  }

  function renderActiveDoc() {
    const card = $("#active-doc-card");
    const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
    if (!doc) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $("#active-doc-title").textContent = doc.title;
    $("#active-summary").textContent = doc.summary || "—";
    const prev = $("#active-cards-preview");
    prev.innerHTML = "";
    const fcs = doc.flashcards || [];
    for (let i = 0; i < Math.min(8, fcs.length); i++) {
      const fc = fcs[i];
      const li = document.createElement("li");
      li.innerHTML = "<strong></strong><span></span>";
      li.querySelector("strong").textContent = fc.q;
      li.querySelector("span").textContent = fc.a;
      prev.appendChild(li);
    }
  }

  /**
   * Prefer global pdfjsLib from index.html (works on file://).
   * Otherwise dynamic-import the v4 module (usually when served over http).
   */
  function extractPdfText(file) {
    if (typeof pdfjsLib !== "undefined" && pdfjsLib.getDocument) {
      return file.arrayBuffer().then(function (buf) {
        return pdfjsLib.getDocument({ data: buf }).promise.then(function (pdf) {
          let text = "";
          const num = pdf.numPages;
          function pageLoop(n) {
            if (n > num) return Promise.resolve(text.trim());
            return pdf.getPage(n).then(function (page) {
              return page.getTextContent().then(function (content) {
                let line = "";
                for (let i = 0; i < content.items.length; i++) line += content.items[i].str + " ";
                text += line + "\n\n";
                return pageLoop(n + 1);
              });
            });
          }
          return pageLoop(1);
        });
      });
    }
    return import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs")
      .then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
        return file.arrayBuffer().then(function (buf) {
          return pdfjs.getDocument({ data: buf }).promise;
        });
      })
      .then(function (pdf) {
        let text = "";
        const chain = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          chain.push(i);
        }
        return chain.reduce(function (p, pageNum) {
          return p.then(function () {
            return pdf.getPage(pageNum).then(function (page) {
              return page.getTextContent().then(function (content) {
                text +=
                  content.items
                    .map(function (it) {
                      return it.str;
                    })
                    .join(" ") + "\n\n";
              });
            });
          });
        }, Promise.resolve()).then(function () {
          return text.trim();
        });
      });
  }

  /** Build chunks/cards/summary, push doc, init SRS due-now, refresh UI. */
  function processAndSaveDoc(title, content) {
    const trimmed = content.trim();
    if (!trimmed) {
      $("#upload-status").textContent = "Add some text before saving.";
      return;
    }
    const id = newId();
    const built = buildStudyMaterial(trimmed, id);
    const chunks = built.chunks;
    const flashcards = built.flashcards;
    const summary = summarize(trimmed, 6);
    const doc = {
      id: id,
      title: title.trim() || "Untitled",
      content: trimmed,
      summary: summary,
      chunks: chunks,
      flashcards: flashcards,
      createdAt: Date.now(),
    };
    state.docs.unshift(doc);
    state.activeDocId = id;
    for (let i = 0; i < flashcards.length; i++) {
      const fc = flashcards[i];
      if (!state.srs[fc.id]) state.srs[fc.id] = Object.assign({}, defaultSrsMeta(), { nextReview: 0 });
    }
    persist();
    $("#upload-status").textContent = "Saved “" + doc.title + "” with " + flashcards.length + " flashcards.";
    $("#doc-title").value = "";
    $("#doc-content").value = "";
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    renderWeakTopics();
  }

  var apStarterDataCache = null;
  function loadApStarterData() {
    if (apStarterDataCache) return Promise.resolve(apStarterDataCache);
    return fetch("js/ap-starter-topics.json", { cache: "force-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        apStarterDataCache = data;
        return data;
      });
  }

  function wireApStarterPickers() {
    var courseSel = $("#ap-starter-course");
    var topicSel = $("#ap-starter-topic");
    var btn = $("#btn-ap-starter-load");
    var statusEl = $("#ap-starter-status");
    if (!courseSel || !topicSel || !btn) return;
    loadApStarterData()
      .then(function (data) {
        var courses = data.courses || [];
        courseSel.innerHTML = "";
        for (var i = 0; i < courses.length; i++) {
          var c = courses[i];
          var opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.name;
          courseSel.appendChild(opt);
        }
        function refillTopics() {
          var cid = courseSel.value;
          var course = null;
          for (var j = 0; j < courses.length; j++) {
            if (courses[j].id === cid) {
              course = courses[j];
              break;
            }
          }
          topicSel.innerHTML = "";
          if (!course || !course.topics || !course.topics.length) return;
          for (var k = 0; k < course.topics.length; k++) {
            var t = course.topics[k];
            var o = document.createElement("option");
            o.value = String(k);
            o.textContent = t.title;
            topicSel.appendChild(o);
          }
        }
        courseSel.addEventListener("change", refillTopics);
        refillTopics();
        btn.addEventListener("click", function () {
          var cid = courseSel.value;
          var course = null;
          for (var j = 0; j < courses.length; j++) {
            if (courses[j].id === cid) {
              course = courses[j];
              break;
            }
          }
          var tidx = parseInt(topicSel.value, 10);
          if (!course || !course.topics || !course.topics[tidx]) return;
          var topic = course.topics[tidx];
          processAndSaveDoc(topic.title, topic.content);
          if (statusEl) statusEl.textContent = "Loaded \u201c" + topic.title + "\u201d into your library.";
        });
        if (statusEl) statusEl.textContent = "Choose a topic, then click Add topic to library.";
      })
      .catch(function () {
        if (statusEl) {
          statusEl.textContent =
            "Starter topics need a web server (GitHub Pages or python -m http.server). file:// cannot load the topic list.";
        }
      });
  }

  function replaceDocNotes(docId, title, content) {
    var doc = getDoc(docId);
    if (!doc) return;
    var trimmed = content.trim();
    if (!trimmed) return;
    var fcs0 = doc.flashcards || [];
    for (var fi = 0; fi < fcs0.length; fi++) delete state.srs[fcs0[fi].id];
    doc.title = (title || "").trim() || doc.title;
    doc.content = trimmed;
    var built = buildStudyMaterial(doc.content, doc.id);
    doc.chunks = built.chunks;
    doc.flashcards = built.flashcards;
    doc.summary = summarize(doc.content, 6);
    for (var fj = 0; fj < doc.flashcards.length; fj++) {
      state.srs[doc.flashcards[fj].id] = Object.assign({}, defaultSrsMeta(), { nextReview: 0 });
    }
    state.activeDocId = doc.id;
    persist();
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    renderWeakTopics();
  }

  function deleteActiveDoc() {
    const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
    if (!doc) return;
    if (!confirm('Delete "' + doc.title + '" and its study data?')) return;
    const fcs = doc.flashcards || [];
    for (let i = 0; i < fcs.length; i++) delete state.srs[fcs[i].id];
    state.docs = state.docs.filter(function (d) {
      return d.id !== doc.id;
    });
    state.activeDocId = state.docs[0] ? state.docs[0].id : null;
    persist();
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    srsQueue = [];
    renderWeakTopics();
  }

  let srsQueue = [];
  let srsIndex = 0;

  /** Cards whose nextReview is due (or missing) across every saved set. */
  function collectDueCards() {
    const due = [];
    for (let di = 0; di < state.docs.length; di++) {
      const d = state.docs[di];
      const fcs = d.flashcards || [];
      for (let fi = 0; fi < fcs.length; fi++) {
        const fc = fcs[fi];
        const meta = state.srs[fc.id] || Object.assign({}, defaultSrsMeta(), { nextReview: 0 });
        if (isDue(meta)) due.push({ doc: d, card: fc, meta: meta });
      }
    }
    return due.sort(function () {
      return Math.random() - 0.5;
    });
  }

  function renderSrsCard() {
    var empty = $("#srs-empty");
    var session = $("#srs-session");
    if (srsQueue.length === 0) {
      empty.hidden = false;
      session.hidden = true;
      return;
    }
    empty.hidden = true;
    session.hidden = false;
    var item = srsQueue[srsIndex];
    var card = $("#srs-card");
    $("#srs-progress").textContent = "Card " + (srsIndex + 1) + " of " + srsQueue.length;
    $("#srs-q").textContent = item.card.q;
    var ans = $("#srs-a");
    ans.textContent = item.card.a;
    ans.classList.add("srs-concealed");
    var aLabel = $("#srs-a-label");
    if (aLabel) aLabel.classList.add("srs-concealed");
    $("#srs-reveal").hidden = false;
    $("#srs-rates").setAttribute("hidden", "");
    if (card) {
      card.classList.add("srs-pending");
      card.setAttribute("tabindex", "0");
    }
  }

  function startSrsSession() {
    srsQueue = collectDueCards();
    srsIndex = 0;
    renderSrsCard();
  }

  function revealSrs() {
    var a = $("#srs-a");
    if (!a || !a.classList.contains("srs-concealed")) return;
    var card = $("#srs-card");
    if (card) {
      card.classList.remove("srs-pending");
      card.setAttribute("tabindex", "-1");
    }
    a.classList.remove("srs-concealed");
    var lbl = $("#srs-a-label");
    if (lbl) lbl.classList.remove("srs-concealed");
    $("#srs-reveal").hidden = true;
    $("#srs-rates").removeAttribute("hidden");
  }

  function rateSrs(quality) {
    const item = srsQueue[srsIndex];
    if (!item) return;
    const prev = state.srs[item.card.id] || defaultSrsMeta();
    state.srs[item.card.id] = scheduleReview(quality, prev);
    if (quality < 3) recordWeak(state, item.card.topicKey, item.card.topic, 1, 0);
    else recordWeak(state, item.card.topicKey, item.card.topic, 0, 1);
    persist();
    srsIndex += 1;
    if (srsIndex >= srsQueue.length) {
      srsQueue = collectDueCards();
      srsIndex = 0;
      if (srsQueue.length === 0) {
        renderSrsCard();
        renderWeakTopics();
        return;
      }
    }
    renderSrsCard();
    renderWeakTopics();
  }

  let quizItems = [];
  let quizIdx = 0;
  let quizLocked = false;

  function refreshSelectors() {
    const qSel = $("#quiz-doc-select");
    const cSel = $("#chat-doc-select");
    if (qSel && cSel) {
      qSel.innerHTML = "";
      cSel.innerHTML = "";
      for (let i = 0; i < state.docs.length; i++) {
        const d = state.docs[i];
        const o1 = document.createElement("option");
        o1.value = d.id;
        o1.textContent = d.title;
        qSel.appendChild(o1);
        const o2 = document.createElement("option");
        o2.value = d.id;
        o2.textContent = d.title;
        cSel.appendChild(o2);
      }
      if (state.activeDocId) {
        qSel.value = state.activeDocId;
        cSel.value = state.activeDocId;
      }
      renderQuizEmpty();
    }
  }

  function renderQuizEmpty() {
    var qSel = $("#quiz-doc-select");
    if (!qSel) return;
    var area = $("#quiz-area");
    var empty = $("#quiz-empty");
    var docId = qSel.value;
    var doc = docId ? getDoc(docId) : null;
    var hasFlash = doc && doc.flashcards && doc.flashcards.length > 0;
    var hasContent = doc && (doc.content || "").trim().length >= 40;
    empty.hidden = hasFlash || hasContent;
    area.hidden = true;
    var std = $("#btn-start-quiz");
    if (std) std.disabled = !(hasFlash || hasContent);
  }

  function startQuiz() {
    var docId = $("#quiz-doc-select").value;
    var doc = getDoc(docId);
    var fb = $("#quiz-feedback");
    if (!doc) {
      $("#quiz-empty").hidden = false;
      return;
    }
    var hasFlash = doc.flashcards && doc.flashcards.length > 0;
    var hasEnoughText = (doc.content || "").trim().length >= 40;
    if (!hasFlash && !hasEnoughText) {
      $("#quiz-empty").hidden = false;
      return;
    }
    fb.hidden = false;
    fb.textContent = "";
    var apiKey = readApiKey();
    var quizHint = "";

    function runFlashcardFallback() {
      if (!hasFlash) {
        fb.textContent = quizHint || "Save notes that include flashcards to run local quiz mode.";
        return;
      }
      quizItems = buildQuiz(doc.flashcards);
      quizIdx = 0;
      quizLocked = false;
      $("#quiz-area").hidden = false;
      $("#quiz-empty").hidden = true;
      if (!quizHint && (apiKey.indexOf("sk-") !== 0 || !hasEnoughText)) {
        quizHint =
          "Quick mode: questions follow your flashcards. Add an API key for paraphrased questions from full notes.";
      }
      renderQuizQuestion();
      if (quizHint) fb.textContent = quizHint;
    }

    if (apiKey.indexOf("sk-") === 0 && hasEnoughText) {
      fb.textContent = "Generating paraphrased questions from your notes…";
      generateConceptualQuiz(doc.content, doc.title, apiKey)
        .then(function (result) {
          if (result && result.ok) {
            quizItems = result.items;
            quizIdx = 0;
            quizLocked = false;
            $("#quiz-area").hidden = false;
            $("#quiz-empty").hidden = true;
            renderQuizQuestion();
            return;
          }
          quizHint =
            ((result && result.error) || "Quiz failed.") + " Using flashcard-based questions instead.";
          runFlashcardFallback();
        })
        .catch(function (e) {
          quizHint = String(e.message || e) + " Using flashcard-based questions instead.";
          runFlashcardFallback();
        });
      return;
    }

    runFlashcardFallback();
  }

  function startAdvancedQuiz() {
    var docId = $("#quiz-doc-select").value;
    var doc = getDoc(docId);
    var fb = $("#quiz-feedback");
    if (!doc || !(doc.content || "").trim()) {
      $("#quiz-empty").hidden = false;
      return;
    }
    var apiKey = readApiKey();
    if (apiKey.indexOf("sk-") !== 0) {
      fb.textContent = "No API key found. Using local quiz mode instead.";
      fb.hidden = false;
      startQuiz();
      return;
    }
    fb.hidden = false;
    fb.textContent = "Looking up reference material on Wikipedia…";
    var topicHint = (doc.title || "").trim() || (doc.content || "").split("\n")[0].trim().slice(0, 100);
    fetchWikipediaContext(topicHint)
      .then(function (wiki) {
        var webExtract = wiki && wiki.extract ? wiki.extract : "";
        var webLabel = wiki && wiki.extract ? 'Wikipedia (“' + wiki.title + '”)' : "";
        fb.textContent =
          wiki && wiki.extract
            ? "Building advanced quiz from your notes + " + webLabel + "…"
            : wiki && wiki.timedOut
              ? "Wikipedia slow, continuing with notes-only."
              : "No Wikipedia article matched; building advanced quiz from your notes only…";
        return generateAdvancedQuiz(doc.content, doc.title, webExtract, webLabel, apiKey);
      })
      .then(function (result) {
        if (!result || !result.ok) {
          fb.textContent = (result && result.error) || "Quiz generation failed.";
          return;
        }
        quizItems = result.items;
        quizIdx = 0;
        quizLocked = false;
        $("#quiz-area").hidden = false;
        $("#quiz-empty").hidden = true;
        fb.textContent = "";
        renderQuizQuestion();
      })
      .catch(function (e) {
        fb.textContent =
          "Advanced quiz failed: " + String(e.message || e) + ". Check your network and API key.";
      });
  }

  function renderQuizQuestion() {
    const item = quizItems[quizIdx];
    $("#quiz-progress").textContent = "Question " + (quizIdx + 1) + " of " + quizItems.length;
    $("#quiz-question").textContent = item.question;
    $("#quiz-feedback").textContent = "";
    $("#quiz-next").hidden = true;
    const opts = $("#quiz-options");
    opts.innerHTML = "";
    quizLocked = false;
    for (let i = 0; i < item.options.length; i++) {
      const opt = item.options[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = opt.text.length > 200 ? opt.text.slice(0, 197) + "…" : opt.text;
      btn.dataset.correct = opt.correct ? "1" : "0";
      btn.addEventListener(
        "click",
        (function (b, it, o) {
          return function () {
            onQuizPick(b, it, o);
          };
        })(btn, item, opt)
      );
      opts.appendChild(btn);
    }
  }

  function onQuizPick(btn, item, opt) {
    if (quizLocked) return;
    quizLocked = true;
    const buttons = $("#quiz-options").querySelectorAll("button");
    // One-attempt behavior: disable all options and reveal the correct one.
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      b.disabled = true;
      if (b.dataset.correct === "1") b.classList.add("correct");
    }
    if (!opt.correct) {
      btn.classList.add("wrong");
      recordWeak(state, item.topicKey, null, 1, 0);
    } else recordWeak(state, item.topicKey, null, 0, 1);
    persist();
    $("#quiz-feedback").textContent = opt.correct ? "Correct." : "Not quite — green shows the right answer.";
    $("#quiz-next").hidden = false;
    renderWeakTopics();
  }

  function quizNext() {
    quizIdx += 1;
    if (quizIdx >= quizItems.length) {
      $("#quiz-area").hidden = true;
      $("#quiz-feedback").textContent = "Quiz complete.";
      renderQuizEmpty();
      return;
    }
    renderQuizQuestion();
  }

  function renderWeakTopics() {
    const list = $("#weak-list");
    const empty = $("#weak-empty");
    const rows = weakTopicList(state);
    list.innerHTML = "";
    if (rows.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const div = document.createElement("div");
      div.className = "weak-item";
      const pct = Math.round(r.rate * 100);
      div.innerHTML =
        "<div><div class=\"name\"></div><div class=\"weak-bar\"><span style=\"width:" +
        pct +
        '%"></span></div></div><div class="stats"></div>';
      div.querySelector(".name").textContent = r.label;
      div.querySelector(".stats").textContent = r.wrong + " miss · " + r.correct + " hit · " + pct + "% miss rate";
      list.appendChild(div);
    }
  }

  function appendChat(role, text, cites) {
    const log = $("#chat-log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "chat-msg " + role;
    div.textContent = text;
    if (cites && cites.length) {
      const cite = document.createElement("div");
      cite.className = "cite";
      cite.textContent = "Sections: " + cites.join(" · ");
      div.appendChild(cite);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  /** Attach all click/change handlers once at startup. */
  function bindUi() {
    const tabEls = document.querySelectorAll(".tab");
    for (let i = 0; i < tabEls.length; i++) {
      tabEls[i].addEventListener(
        "click",
        (function (tabEl) {
          return function () {
            const name = tabEl.getAttribute("data-tab");
            setTab(name);
            if (name === "study") startSrsSession();
            if (name === "quiz") refreshSelectors();
            if (name === "insights") renderWeakTopics();
            if (name === "chat") {
              refreshSelectors();
              syncOpenAiKeyFields();
              syncOpenAiBaseField();
            }
          };
        })(tabEls[i])
      );
    }

    $("#btn-save-doc").addEventListener("click", function () {
      processAndSaveDoc($("#doc-title").value, $("#doc-content").value);
    });

    $("#doc-file").addEventListener("change", function (e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      $("#upload-status").textContent = "Reading " + file.name + "…";
      const isPdf =
        file.type === "application/pdf" ||
        (file.name && file.name.toLowerCase().slice(-4) === ".pdf");
      const p = isPdf ? extractPdfText(file) : file.text();
      Promise.resolve(p)
        .then(function (text) {
          $("#doc-content").value = text;
          if (!$("#doc-title").value) $("#doc-title").value = file.name.replace(/\.[^.]+$/, "");
          $("#upload-status").textContent = "Loaded into the editor. Click Save & process when ready.";
        })
        .catch(function (err) {
          $("#upload-status").textContent = "Could not read file: " + (err.message || err);
        });
    });

    $("#btn-delete-doc").addEventListener("click", deleteActiveDoc);
    $("#btn-regenerate").addEventListener("click", function () {
      const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
      if (!doc) return;
      const fcs = doc.flashcards || [];
      for (let i = 0; i < fcs.length; i++) delete state.srs[fcs[i].id];
      const built = buildStudyMaterial(doc.content, doc.id);
      doc.chunks = built.chunks;
      doc.flashcards = built.flashcards;
      doc.summary = summarize(doc.content, 6);
      for (let i = 0; i < doc.flashcards.length; i++) {
        state.srs[doc.flashcards[i].id] = Object.assign({}, defaultSrsMeta(), { nextReview: 0 });
      }
      persist();
      renderDocList();
      renderActiveDoc();
      refreshSelectors();
      renderWeakTopics();
      $("#upload-status").textContent = "Regenerated summary and cards.";
    });

    $("#btn-refine-notes").addEventListener("click", function () {
      var doc = state.activeDocId ? getDoc(state.activeDocId) : null;
      var status = $("#refine-status");
      if (!doc) return;
      var apiKey = readApiKey();
      status.textContent = "Refining notes…";
      refineNotesWithAI(doc.content, doc.title, apiKey).then(function (result) {
        if (!result.ok) {
          status.textContent = result.error;
          return;
        }
        var fcs = doc.flashcards || [];
        for (var i = 0; i < fcs.length; i++) delete state.srs[fcs[i].id];
        doc.content = result.text.trim();
        var built = buildStudyMaterial(doc.content, doc.id);
        doc.chunks = built.chunks;
        doc.flashcards = built.flashcards;
        doc.summary = summarize(doc.content, 6);
        for (var j = 0; j < doc.flashcards.length; j++) {
          state.srs[doc.flashcards[j].id] = Object.assign({}, defaultSrsMeta(), { nextReview: 0 });
        }
        persist();
        renderDocList();
        renderActiveDoc();
        refreshSelectors();
        renderWeakTopics();
        status.textContent =
          "Notes refined. Summary and flashcards were rebuilt from the improved text.";
      });
    });

    $("#srs-reveal").addEventListener("click", function (e) {
      e.stopPropagation();
      revealSrs();
    });
    $("#srs-card").addEventListener("click", function (e) {
      if (e.target.closest("[data-quality]")) return;
      revealSrs();
    });
    $("#srs-card").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!$("#srs-card").classList.contains("srs-pending")) return;
      e.preventDefault();
      revealSrs();
    });
    $("#srs-rates").addEventListener("click", function (e) {
      const btn = e.target.closest("[data-quality]");
      if (!btn) return;
      rateSrs(Number(btn.getAttribute("data-quality")));
    });

    $("#quiz-doc-select").addEventListener("change", function () {
      renderQuizEmpty();
    });

    $("#btn-start-quiz").addEventListener("click", startQuiz);
    $("#quiz-next").addEventListener("click", quizNext);

    $("#openai-key").addEventListener("change", function () {
      persistOpenAiKeyFromField($("#openai-key"));
    });
    var quizKeyEl = $("#quiz-openai-key");
    if (quizKeyEl) {
      quizKeyEl.addEventListener("change", function () {
        persistOpenAiKeyFromField($("#quiz-openai-key"));
      });
    }
    var apiBaseEl = $("#openai-api-base");
    if (apiBaseEl) {
      apiBaseEl.addEventListener("change", function () {
        persistOpenAiBaseFromField();
      });
    }
    var btnTestApi = $("#btn-test-api");
    if (btnTestApi) {
      btnTestApi.addEventListener("click", function () {
        var status = $("#api-test-status");
        var apiKey = readApiKey();
        if (!apiKey || apiKey.indexOf("sk-") !== 0) {
          status.textContent = "Add a valid OpenAI API key first (starts with sk-).";
          return;
        }
        status.textContent = "Testing OpenAI connection…";
        btnTestApi.disabled = true;
        openaiChatFetch(
          apiKey,
          {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 5,
            temperature: 0,
          },
          25000
        )
          .then(function (res) {
            if (res.ok) {
              status.textContent = "API connection successful. Your key and network are working.";
              return;
            }
            return res.text().then(function (body) {
              status.textContent =
                "API reachable, but request failed (" + res.status + "). " + String(body || "").slice(0, 140);
            });
          })
          .catch(function (err) {
            status.textContent =
              "Network/connectivity error while reaching OpenAI: " +
              String((err && err.message) || err || "unknown error");
          })
          .finally(function () {
            btnTestApi.disabled = false;
          });
      });
    }

    var btnChatSend = $("#btn-chat-send");
    if (btnChatSend) {
      btnChatSend.addEventListener("click", function () {
        var status = $("#chat-status");
        var inputEl = $("#chat-input");
        try {
          var q = (inputEl && inputEl.value ? inputEl.value : "").trim();
          if (!q) {
            if (status) status.textContent = "Type a question or a topic first.";
            return;
          }
          if (status) status.textContent = "Thinking…";
          appendChat("user", q);
          if (inputEl) inputEl.value = "";
          var apiKey = readApiKey();

          // Chat dropdown first; if empty, use the Library’s active set.
          var sel = $("#chat-doc-select");
          var docId = sel && sel.value ? sel.value : "";
          if (!docId && state.activeDocId) docId = state.activeDocId;
          var doc = docId ? getDoc(docId) : null;

          if (doc) {
            var chunks =
              doc.chunks && doc.chunks.length > 0 ? doc.chunks : buildStudyMaterial(doc.content, doc.id).chunks;
            answerQuestion(q, chunks, apiKey)
              .then(function (res) {
                if (!res || typeof res.text !== "string") {
                  if (status) status.textContent = "Got an unexpected response. Try again.";
                  appendChat("bot", "Something went wrong formatting the answer. Please try again.", []);
                  return;
                }
                if (status) {
                  status.textContent =
                    res.source === "openai"
                      ? "Answer from model + your notes."
                      : "Answer from your notes (local retrieval).";
                }
                appendChat("bot", res.text, res.cites);
              })
              .catch(function (e) {
                if (status) status.textContent = "Could not finish the answer. Check your connection or API key.";
                appendChat("bot", String(e.message || e), []);
              });
            return;
          }

          if (status) status.textContent = "No notes yet — creating a new notes set for this topic…";
          generateNotesForTopic(q, apiKey)
            .then(function (notes) {
              var shortTitle = q.length > 60 ? q.slice(0, 57) + "…" : q;
              processAndSaveDoc(shortTitle || "AI-generated notes", notes);
              var newDoc = state.activeDocId ? getDoc(state.activeDocId) : null;
              if (newDoc) {
                var chunks2 =
                  newDoc.chunks && newDoc.chunks.length > 0
                    ? newDoc.chunks
                    : buildStudyMaterial(newDoc.content, newDoc.id).chunks;
                return answerQuestion(q, chunks2, apiKey).then(function (res) {
                  if (!res || typeof res.text !== "string") {
                    if (status) status.textContent = "Got an unexpected response. Try again.";
                    appendChat("bot", "Something went wrong formatting the answer. Please try again.", []);
                    return;
                  }
                  if (status) {
                    status.textContent =
                      res.source === "openai"
                        ? "Answer from freshly generated notes."
                        : "Answer from freshly generated notes (local retrieval).";
                  }
                  appendChat("bot", res.text, res.cites);
                });
              }
              if (status) status.textContent = "Created notes outline, but something went wrong linking it to chat.";
            })
            .catch(function (e) {
              if (status) status.textContent = "Could not create notes or answer. Check your connection or API key.";
              appendChat("bot", String(e.message || e), []);
            });
        } catch (err) {
          if (status) status.textContent = "Error: " + String(err && err.message ? err.message : err);
          appendChat("bot", String(err && err.message ? err.message : err), []);
        }
      });
    }

    wireApStarterPickers();
  }

  function boot() {
    var btnCont = $("#btn-start-continue");
    if (btnCont) btnCont.addEventListener("click", onStartContinue);
    var btnOut = $("#btn-sign-out");
    if (btnOut) btnOut.addEventListener("click", signOut);
    var emailEl = $("#start-email");
    var passEl = $("#start-password");
    if (emailEl) emailEl.addEventListener("keydown", function (e) { if (e.key === "Enter") onStartContinue(); });
    if (passEl) passEl.addEventListener("keydown", function (e) { if (e.key === "Enter") onStartContinue(); });

    if (shouldSkipStartGate()) {
      document.documentElement.classList.add("auto-signed-in");
      hideStartGate();
      initMainApp();
      return;
    }

    var prev = loadSessionRecord();
    if (prev && prev.email && emailEl) emailEl.value = prev.email;
    var rem = $("#start-remember");
    if (rem) rem.checked = prev ? prev.rememberMe !== false : true;
    showStartGate();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
