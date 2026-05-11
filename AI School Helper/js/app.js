/**
 * app.js — Study Smart UI and glue code
 *
 * Wires the HTML (tabs, forms, lists) to storage + study-engine + SRS + chat.
 * Two ways to run the app:
 *   - `index.html` with this file as `type="module"` (needs a local server for some browsers).
 *   - `study-smart-bundle.js` (no modules; for opening index.html from disk).
 */

import { loadState, saveState, newId, defaultState, STORAGE_KEY_BASE } from "./storage.js";
import { buildStudyMaterial, summarize, buildQuiz } from "./study-engine.js";
import { scheduleReview, defaultSrsMeta, isDue } from "./srs.js";
import { recordWeak, weakTopicList } from "./weak-topics.js";
import {
  answerQuestion,
  generateNotesForTopic,
  generateResearchNotes,
  refineNotesWithAI,
  generateConceptualQuiz,
  generateAdvancedQuiz,
} from "./chat.js";
import { fetchWikipediaContext } from "./web-research.js";
import { OPENAI_API_BASE_STORAGE_KEY, fetchOpenAiChatCompletions } from "./openai-api.js";

/** localStorage key for the optional OpenAI API key (never sent except to your chosen AI API by chat.js). */
const OPENAI_STORAGE = "study-smart-openai-key";
const USER_INDEX_KEY = "study-smart-users-v1";

/** Local “login” (display name + stay signed in). Not a server account. */
const SESSION_KEY = "study-smart-session";
/** Last main tab so we can reopen where the user left off. */
const LAST_TAB_KEY = "study-smart-last-tab";
const VALID_TABS = new Set(["library", "create", "study", "quiz", "insights", "chat"]);

let mainAppInitialized = false;

/** @type {ReturnType<typeof loadState>} */
let currentStateStorageKey = STORAGE_KEY_BASE;
let state = defaultState();

/** Shorthand for one DOM node (matches how the HTML ids are set up). */
const $ = (sel) => document.querySelector(sel);

function readApiKey() {
  const norm = (v) => (v == null || typeof v !== "string" ? "" : v.trim().replace(/\u00a0/g, ""));
  return (
    norm($("#research-openai-key")?.value) ||
    norm($("#openai-key")?.value) ||
    norm($("#quiz-openai-key")?.value) ||
    norm(localStorage.getItem(OPENAI_STORAGE)) ||
    ""
  );
}

function syncOpenAiKeyFields() {
  const v = localStorage.getItem(OPENAI_STORAGE) || "";
  for (const id of ["openai-key", "research-openai-key", "quiz-openai-key"]) {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = v;
  }
}

function persistOpenAiKeyFromField(el) {
  if (!el) return;
  const v = el.value.trim();
  if (v) localStorage.setItem(OPENAI_STORAGE, v);
  else localStorage.removeItem(OPENAI_STORAGE);
  for (const id of ["openai-key", "research-openai-key", "quiz-openai-key"]) {
    const node = document.getElementById(id);
    if (node && node !== el) node.value = v;
  }
}

function syncOpenAiBaseField() {
  const el = $("#openai-api-base");
  if (!el) return;
  try {
    const v = localStorage.getItem(OPENAI_API_BASE_STORAGE_KEY) || "";
    if (v && !el.value) el.value = v;
  } catch {
    /* ignore */
  }
}

function persistOpenAiBaseFromField() {
  const el = $("#openai-api-base");
  if (!el) return;
  const v = (el.value || "").trim().replace(/\/+$/, "");
  try {
    if (!v) localStorage.removeItem(OPENAI_API_BASE_STORAGE_KEY);
    else if (/^https?:\/\//i.test(v)) localStorage.setItem(OPENAI_API_BASE_STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

/** Write current in-memory state to localStorage. */
function persist() {
  saveState(state, currentStateStorageKey);
}

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

function userIdFromEmail(email) {
  const e = normalizeEmail(email);
  let hash = 0;
  for (let i = 0; i < e.length; i++) hash = (hash * 31 + e.charCodeAt(i)) >>> 0;
  return `u-${hash.toString(36)}`;
}

function storageKeyForSession(s) {
  if (!s?.userId) return STORAGE_KEY_BASE;
  return `${STORAGE_KEY_BASE}::${s.userId}`;
}

function loadUserIndex() {
  try {
    const raw = localStorage.getItem(USER_INDEX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveUserIndex(index) {
  localStorage.setItem(USER_INDEX_KEY, JSON.stringify(index || {}));
}

function randomSaltHex() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

function loadSessionRecord() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || !s.email || !s.userId) return null;
    return s;
  } catch {
    return null;
  }
}

function saveSessionRecord(email, rememberMe) {
  const norm = normalizeEmail(email);
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      email: norm,
      userId: userIdFromEmail(norm),
      rememberMe: Boolean(rememberMe),
    })
  );
}

function getLastTab() {
  try {
    const t = localStorage.getItem(LAST_TAB_KEY);
    return t && VALID_TABS.has(t) ? t : "library";
  } catch {
    return "library";
  }
}

function persistLastTab(name) {
  if (!VALID_TABS.has(name)) return;
  try {
    localStorage.setItem(LAST_TAB_KEY, name);
  } catch {
    /* quota / private mode */
  }
}

function updateSessionHeader() {
  const s = loadSessionRecord();
  const wrap = $("#header-session");
  const greet = $("#session-greeting");
  if (!wrap || !greet) return;
  const email = s?.email?.trim();
  if (email) {
    greet.textContent = `Signed in as ${email}`;
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

function showStartGate() {
  const gate = $("#start-screen");
  if (gate) gate.hidden = false;
  document.body.classList.add("start-gate-active");
}

function hideStartGate() {
  const gate = $("#start-screen");
  if (gate) gate.hidden = true;
  document.body.classList.remove("start-gate-active");
}

/** Show one main panel and mark the matching tab as active (accessibility + CSS). */
function setTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${name}`);
    p.hidden = p.id !== `panel-${name}`;
  });
  persistLastTab(name);
}

function getDoc(id) {
  return state.docs.find((d) => d.id === id);
}

/** Rebuild the Library sidebar list from `state.docs`. */
function renderDocList() {
  const ul = $("#doc-list");
  const empty = $("#doc-empty");
  ul.innerHTML = "";
  if (state.docs.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const d of state.docs) {
    const li = document.createElement("li");
    li.dataset.id = d.id;
    li.classList.toggle("active", d.id === state.activeDocId);
    li.innerHTML = `<span class="title"></span><span class="meta"></span>`;
    li.querySelector(".title").textContent = d.title;
    li.querySelector(".meta").textContent = `${d.flashcards?.length || 0} cards`;
    li.addEventListener("click", () => {
      state.activeDocId = d.id;
      persist();
      renderDocList();
      renderActiveDoc();
      refreshSelectors();
    });
    ul.appendChild(li);
  }
}

/** Show summary + a few flashcards for the currently active set. */
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
  (doc.flashcards || []).slice(0, 8).forEach((fc) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong></strong><span></span>`;
    li.querySelector("strong").textContent = fc.q;
    li.querySelector("span").textContent = fc.a;
    prev.appendChild(li);
  });
}

/**
 * Pull plain text from a PDF using pdf.js (ES module build from CDN).
 * Used when running with a server; the file:// bundle uses global pdfjsLib instead.
 */
async function extractPdfText(file) {
  const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n\n";
  }
  return text.trim();
}

/**
 * Turn raw text into a saved document: chunks, summary, flashcards, and initial SRS rows.
 * Also clears the compose form and refreshes dependent UI.
 */
function processAndSaveDoc(title, content) {
  const trimmed = content.trim();
  if (!trimmed) {
    $("#upload-status").textContent = "Add some text before saving.";
    return;
  }
  const id = newId();
  const { chunks, flashcards } = buildStudyMaterial(trimmed, id);
  const summary = summarize(trimmed, 6);
  const doc = {
    id,
    title: title.trim() || "Untitled",
    content: trimmed,
    summary,
    chunks,
    flashcards,
    createdAt: Date.now(),
  };
  state.docs.unshift(doc);
  state.activeDocId = id;
  for (const fc of flashcards) {
    if (!state.srs[fc.id]) state.srs[fc.id] = { ...defaultSrsMeta(), nextReview: 0 };
  }
  persist();
  $("#upload-status").textContent = `Saved “${doc.title}” with ${flashcards.length} flashcards.`;
  $("#doc-title").value = "";
  $("#doc-content").value = "";
  renderDocList();
  renderActiveDoc();
  refreshSelectors();
  renderWeakTopics();
}

/** Cached AP-style starter topics loaded from `js/ap-starter-topics.json`. */
let apStarterDataCache = null;

async function loadApStarterData() {
  if (apStarterDataCache) return apStarterDataCache;
  const res = await fetch("js/ap-starter-topics.json", { cache: "force-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  apStarterDataCache = await res.json();
  return apStarterDataCache;
}

/** Course/topic pickers: load bundled starter outlines (no upload). */
function wireApStarterPickers() {
  const courseSel = $("#ap-starter-course");
  const topicSel = $("#ap-starter-topic");
  const btn = $("#btn-ap-starter-load");
  const statusEl = $("#ap-starter-status");
  if (!courseSel || !topicSel || !btn) return;

  loadApStarterData()
    .then((data) => {
      const courses = data.courses || [];
      courseSel.innerHTML = "";
      for (const c of courses) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        courseSel.appendChild(opt);
      }
      const refillTopics = () => {
        const cid = courseSel.value;
        const course = courses.find((x) => x.id === cid);
        topicSel.innerHTML = "";
        if (!course?.topics?.length) return;
        course.topics.forEach((t, idx) => {
          const o = document.createElement("option");
          o.value = String(idx);
          o.textContent = t.title;
          topicSel.appendChild(o);
        });
      };
      courseSel.addEventListener("change", refillTopics);
      refillTopics();
      btn.addEventListener("click", () => {
        const cid = courseSel.value;
        const course = courses.find((x) => x.id === cid);
        const tidx = Number.parseInt(topicSel.value, 10);
        if (!course?.topics?.[tidx]) return;
        const topic = course.topics[tidx];
        processAndSaveDoc(topic.title, topic.content);
        if (statusEl) statusEl.textContent = `Loaded “${topic.title}” into your library.`;
      });
      if (statusEl) statusEl.textContent = "Choose a topic, then click Add topic to library.";
    })
    .catch(() => {
      if (statusEl) {
        statusEl.textContent =
          "Starter topics need a web server (GitHub Pages or python -m http.server). file:// cannot load the topic list.";
      }
    });
}

/** Replace an existing set’s body and rebuild chunks, summary, flashcards, and SRS rows. */
function replaceDocNotes(docId, title, content) {
  const doc = getDoc(docId);
  if (!doc) return;
  const trimmed = content.trim();
  if (!trimmed) return;
  for (const fc of doc.flashcards || []) delete state.srs[fc.id];
  doc.title = (title || "").trim() || doc.title;
  doc.content = trimmed;
  const { chunks, flashcards } = buildStudyMaterial(doc.content, doc.id);
  doc.chunks = chunks;
  doc.flashcards = flashcards;
  doc.summary = summarize(doc.content, 6);
  for (const fc of flashcards) {
    state.srs[fc.id] = { ...defaultSrsMeta(), nextReview: 0 };
  }
  state.activeDocId = doc.id;
  persist();
  renderDocList();
  renderActiveDoc();
  refreshSelectors();
  renderWeakTopics();
}

/** Remove the active set and its SRS entries; pick another active doc if any remain. */
function deleteActiveDoc() {
  const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
  if (!doc) return;
  if (!confirm(`Delete “${doc.title}” and its study data?`)) return;
  for (const fc of doc.flashcards || []) delete state.srs[fc.id];
  state.docs = state.docs.filter((d) => d.id !== doc.id);
  state.activeDocId = state.docs[0]?.id || null;
  persist();
  renderDocList();
  renderActiveDoc();
  refreshSelectors();
  srsQueue = [];
  renderWeakTopics();
}

/* ---------- Spaced repetition (Study tab) ---------- */
let srsQueue = [];
let srsIndex = 0;
let srsRevealed = false;

/** All flashcards across all sets whose nextReview is in the past (or unset). */
function collectDueCards() {
  const due = [];
  for (const d of state.docs) {
    for (const fc of d.flashcards || []) {
      const meta = state.srs[fc.id] || { ...defaultSrsMeta(), nextReview: 0 };
      if (isDue(meta)) due.push({ doc: d, card: fc, meta });
    }
  }
  return due.sort(() => Math.random() - 0.5);
}

function renderSrsCard() {
  const empty = $("#srs-empty");
  const session = $("#srs-session");
  if (srsQueue.length === 0) {
    empty.hidden = false;
    session.hidden = true;
    return;
  }
  empty.hidden = true;
  session.hidden = false;
  const item = srsQueue[srsIndex];
  const card = $("#srs-card");
  $("#srs-progress").textContent = `Card ${srsIndex + 1} of ${srsQueue.length}`;
  $("#srs-q").textContent = item.card.q;
  const ans = $("#srs-a");
  ans.textContent = item.card.a;
  ans.classList.add("srs-concealed");
  const aLabel = $("#srs-a-label");
  if (aLabel) aLabel.classList.add("srs-concealed");
  $("#srs-reveal").hidden = false;
  $("#srs-rates").setAttribute("hidden", "");
  if (card) {
    card.classList.add("srs-pending");
    card.setAttribute("tabindex", "0");
  }
  srsRevealed = false;
}

function startSrsSession() {
  srsQueue = collectDueCards();
  srsIndex = 0;
  renderSrsCard();
}

function revealSrs() {
  const a = $("#srs-a");
  if (!a || !a.classList.contains("srs-concealed")) return;
  srsRevealed = true;
  const card = $("#srs-card");
  if (card) {
    card.classList.remove("srs-pending");
    card.setAttribute("tabindex", "-1");
  }
  a.classList.remove("srs-concealed");
  const lbl = $("#srs-a-label");
  if (lbl) lbl.classList.remove("srs-concealed");
  $("#srs-reveal").hidden = true;
  $("#srs-rates").removeAttribute("hidden");
}

/** Map button quality to SM-2 update and weak-topic stats, then advance the queue. */
function rateSrs(quality) {
  const item = srsQueue[srsIndex];
  if (!item) return;
  const prev = state.srs[item.card.id] || defaultSrsMeta();
  state.srs[item.card.id] = scheduleReview(quality, prev);
  if (quality < 3) {
    recordWeak(state, item.card.topicKey, item.card.topic, 1, 0);
  } else {
    recordWeak(state, item.card.topicKey, item.card.topic, 0, 1);
  }
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

/* ---------- Quiz ---------- */
let quizItems = [];
let quizIdx = 0;
let quizLocked = false;

/** Fill quiz + chat + research-notes dropdowns from `state.docs`. */
function refreshSelectors() {
  const qSel = $("#quiz-doc-select");
  const cSel = $("#chat-doc-select");
  if (qSel && cSel) {
    qSel.innerHTML = "";
    cSel.innerHTML = "";
    for (const d of state.docs) {
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
  refreshCreateNotesTarget();
}

/** “Research notes” tab: new set vs replace an existing one. */
function refreshCreateNotesTarget() {
  const sel = $("#create-notes-target");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  const optNew = document.createElement("option");
  optNew.value = "";
  optNew.textContent = "— New note set —";
  sel.appendChild(optNew);
  for (const d of state.docs) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = `${d.title} (replace notes)`;
    sel.appendChild(o);
  }
  const ids = new Set([...sel.options].map((o) => o.value));
  if (prev && ids.has(prev)) sel.value = prev;
  else if (state.activeDocId && ids.has(state.activeDocId)) sel.value = state.activeDocId;
}

function renderQuizEmpty() {
  const qSel = $("#quiz-doc-select");
  if (!qSel) return;
  const area = $("#quiz-area");
  const empty = $("#quiz-empty");
  const docId = qSel.value;
  const doc = docId ? getDoc(docId) : null;
  const hasFlash = doc && (doc.flashcards || []).length > 0;
  const hasContent = doc && (doc.content || "").trim().length >= 40;
  empty.hidden = hasFlash || hasContent;
  area.hidden = true;
  const std = $("#btn-start-quiz");
  if (std) std.disabled = !(hasFlash || hasContent);
}

/** Standard quiz: AI paraphrases main ideas into MC questions when a key + note text exist; else flashcard-based. */
async function startQuiz() {
  const docId = $("#quiz-doc-select").value;
  const doc = getDoc(docId);
  const fb = $("#quiz-feedback");
  if (!doc) {
    $("#quiz-empty").hidden = false;
    return;
  }
  const hasFlash = (doc.flashcards || []).length > 0;
  const hasEnoughText = (doc.content || "").trim().length >= 40;
  if (!hasFlash && !hasEnoughText) {
    $("#quiz-empty").hidden = false;
    return;
  }
  fb.hidden = false;
  fb.textContent = "";
  const apiKey = readApiKey();
  /** Shown under Q1 after render (renderQuizQuestion clears feedback first). */
  let quizHint = "";

  if (apiKey.startsWith("sk-") && hasEnoughText) {
    fb.textContent = "Generating paraphrased questions from your notes…";
    const result = await generateConceptualQuiz(doc.content, doc.title, apiKey);
    if (result.ok) {
      quizItems = result.items;
      quizIdx = 0;
      quizLocked = false;
      $("#quiz-area").hidden = false;
      $("#quiz-empty").hidden = true;
      renderQuizQuestion();
      return;
    }
    quizHint = `${result.error} Using flashcard-based questions instead.`;
  }

  if (!hasFlash) {
    fb.textContent =
      apiKey.startsWith("sk-") && hasEnoughText
        ? quizHint
        : "Add an OpenAI API key for paraphrased questions, or save notes that include flashcards.";
    return;
  }

  quizItems = buildQuiz(doc.flashcards);
  quizIdx = 0;
  quizLocked = false;
  $("#quiz-area").hidden = false;
  $("#quiz-empty").hidden = true;
  if (quizHint) {
    /* already set from failed AI */
  } else if (!apiKey.startsWith("sk-") || !hasEnoughText) {
    quizHint =
      "Quick mode: questions follow your flashcards. Add an API key for paraphrased questions from full notes.";
  }
  renderQuizQuestion();
  if (quizHint) fb.textContent = quizHint;
}

/** Harder MC quiz: OpenAI + optional Wikipedia extract (see web-research.js). */
async function startAdvancedQuiz() {
  const docId = $("#quiz-doc-select").value;
  const doc = getDoc(docId);
  const fb = $("#quiz-feedback");
  if (!doc || !(doc.content || "").trim()) {
    $("#quiz-empty").hidden = false;
    return;
  }
  const apiKey = readApiKey();
  if (!apiKey.startsWith("sk-")) {
    fb.textContent = "Advanced quiz requires an OpenAI API key. Add it under Ask notes or Research notes.";
    fb.hidden = false;
    return;
  }
  fb.hidden = false;
  try {
    fb.textContent = "Looking up reference material on Wikipedia…";
    const topicHint = (doc.title || "").trim() || (doc.content || "").split("\n")[0].trim().slice(0, 100);
    const wiki = await fetchWikipediaContext(topicHint);
    const webExtract = wiki?.extract || "";
    const webLabel = wiki?.extract ? `Wikipedia (“${wiki.title}”)` : "";
    fb.textContent = wiki?.extract
      ? `Building advanced quiz from your notes + ${webLabel}…`
      : wiki?.timedOut
        ? "Wikipedia slow, continuing with notes-only."
        : "No Wikipedia article matched; building advanced quiz from your notes only…";

    const result = await generateAdvancedQuiz(doc.content, doc.title, webExtract, webLabel, apiKey);
    if (!result.ok) {
      fb.textContent = result.error;
      return;
    }
    quizItems = result.items;
    quizIdx = 0;
    quizLocked = false;
    $("#quiz-area").hidden = false;
    $("#quiz-empty").hidden = true;
    fb.textContent = "";
    renderQuizQuestion();
  } catch (e) {
    fb.textContent = `Advanced quiz failed: ${e.message || e}. Check your network and API key.`;
  }
}

function renderQuizQuestion() {
  const item = quizItems[quizIdx];
  $("#quiz-progress").textContent = `Question ${quizIdx + 1} of ${quizItems.length}`;
  $("#quiz-question").textContent = item.question;
  $("#quiz-feedback").textContent = "";
  $("#quiz-next").hidden = true;
  const opts = $("#quiz-options");
  opts.innerHTML = "";
  quizLocked = false;
  item.options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.text.length > 200 ? `${opt.text.slice(0, 197)}…` : opt.text;
    btn.dataset.correct = opt.correct ? "1" : "0";
    btn.addEventListener("click", () => onQuizPick(btn, item, opt));
    opts.appendChild(btn);
  });
}

function onQuizPick(btn, item, opt) {
  if (quizLocked) return;
  quizLocked = true;
  const buttons = $("#quiz-options").querySelectorAll("button");
  // Freeze the question after one attempt and reveal which option is correct.
  buttons.forEach((b) => {
    b.disabled = true;
    if (b.dataset.correct === "1") b.classList.add("correct");
  });
  // Feed weak-topic stats so Insights reflects real mistakes over time.
  if (!opt.correct) {
    btn.classList.add("wrong");
    recordWeak(state, item.topicKey, null, 1, 0);
  } else {
    recordWeak(state, item.topicKey, null, 0, 1);
  }
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

/* ---------- Weak topics (Insights tab) ---------- */
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
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "weak-item";
    const pct = Math.round(r.rate * 100);
    div.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="weak-bar"><span style="width:${pct}%"></span></div>
      </div>
      <div class="stats"></div>`;
    div.querySelector(".name").textContent = r.label;
    div.querySelector(".stats").textContent = `${r.wrong} miss · ${r.correct} hit · ${pct}% miss rate`;
    list.appendChild(div);
  }
}

/* ---------- Chat log ---------- */
function appendChat(role, text, cites) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  if (cites && cites.length) {
    const cite = document.createElement("div");
    cite.className = "cite";
    cite.textContent = `Sections: ${cites.join(" · ")}`;
    div.appendChild(cite);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

/* ---------- Wire DOM events once ---------- */
function bindUi() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      const name = t.dataset.tab;
      setTab(name);
      if (name === "study") startSrsSession();
      if (name === "quiz") refreshSelectors();
      if (name === "insights") renderWeakTopics();
      if (name === "chat" || name === "create") {
        refreshSelectors();
        syncOpenAiKeyFields();
      }
    });
  });

  $("#btn-save-doc").addEventListener("click", () => {
    const title = $("#doc-title").value;
    const content = $("#doc-content").value;
    processAndSaveDoc(title, content);
  });

  $("#doc-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    $("#upload-status").textContent = `Reading ${file.name}…`;
    try {
      let text = "";
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        text = await extractPdfText(file);
      } else {
        text = await file.text();
      }
      $("#doc-content").value = text;
      if (!$("#doc-title").value) $("#doc-title").value = file.name.replace(/\.[^.]+$/, "");
      $("#upload-status").textContent = "Loaded into the editor. Click Save & process when ready.";
    } catch (err) {
      $("#upload-status").textContent = `Could not read file: ${err.message || err}`;
    }
  });

  $("#btn-delete-doc").addEventListener("click", deleteActiveDoc);
  $("#btn-regenerate").addEventListener("click", () => {
    const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
    if (!doc) return;
    for (const fc of doc.flashcards || []) delete state.srs[fc.id];
    const { chunks, flashcards } = buildStudyMaterial(doc.content, doc.id);
    doc.chunks = chunks;
    doc.flashcards = flashcards;
    doc.summary = summarize(doc.content, 6);
    for (const fc of flashcards) {
      state.srs[fc.id] = { ...defaultSrsMeta(), nextReview: 0 };
    }
    persist();
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    renderWeakTopics();
    $("#upload-status").textContent = "Regenerated summary and cards.";
  });

  $("#btn-refine-notes").addEventListener("click", async () => {
    const doc = state.activeDocId ? getDoc(state.activeDocId) : null;
    const status = $("#refine-status");
    if (!doc) return;
    const apiKey = readApiKey();
    status.textContent = "Refining notes…";
    const result = await refineNotesWithAI(doc.content, doc.title, apiKey);
    if (!result.ok) {
      status.textContent = result.error;
      return;
    }
    for (const fc of doc.flashcards || []) delete state.srs[fc.id];
    doc.content = result.text.trim();
    const { chunks, flashcards } = buildStudyMaterial(doc.content, doc.id);
    doc.chunks = chunks;
    doc.flashcards = flashcards;
    doc.summary = summarize(doc.content, 6);
    for (const fc of flashcards) {
      state.srs[fc.id] = { ...defaultSrsMeta(), nextReview: 0 };
    }
    persist();
    renderDocList();
    renderActiveDoc();
    refreshSelectors();
    renderWeakTopics();
    status.textContent = "Notes refined. Summary and flashcards were rebuilt from the improved text.";
  });

  $("#srs-reveal").addEventListener("click", (e) => {
    e.stopPropagation();
    revealSrs();
  });
  $("#srs-card").addEventListener("click", (e) => {
    if (e.target.closest("[data-quality]")) return;
    revealSrs();
  });
  $("#srs-card").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!$("#srs-card").classList.contains("srs-pending")) return;
    e.preventDefault();
    revealSrs();
  });
  $("#srs-rates").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-quality]");
    if (!btn) return;
    rateSrs(Number(btn.dataset.quality));
  });

  $("#quiz-doc-select").addEventListener("change", () => renderQuizEmpty());

  $("#btn-start-quiz").addEventListener("click", startQuiz);
  $("#quiz-next").addEventListener("click", quizNext);

  $("#openai-key")?.addEventListener("change", () => persistOpenAiKeyFromField($("#openai-key")));
  $("#research-openai-key")?.addEventListener("change", () =>
    persistOpenAiKeyFromField($("#research-openai-key"))
  );
  $("#quiz-openai-key")?.addEventListener("change", () => persistOpenAiKeyFromField($("#quiz-openai-key")));
  $("#openai-api-base")?.addEventListener("change", persistOpenAiBaseFromField);
  $("#btn-test-api")?.addEventListener("click", async () => {
    const status = $("#api-test-status");
    const btn = $("#btn-test-api");
    const apiKey = readApiKey();
    if (!apiKey || !apiKey.startsWith("sk-")) {
      status.textContent = "Add a valid OpenAI API key first (starts with sk-).";
      return;
    }
    status.textContent = "Testing OpenAI connection…";
    if (btn) btn.disabled = true;
    try {
      const res = await fetchOpenAiChatCompletions(
        apiKey,
        {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 5,
          temperature: 0,
        },
        25000
      );
      if (res.ok) {
        status.textContent = "API connection successful. Your key and network are working.";
      } else {
        const body = await res.text();
        status.textContent = `API reachable, but request failed (${res.status}). ${body.slice(0, 140)}`;
      }
    } catch (err) {
      status.textContent = `Network/connectivity error while reaching OpenAI: ${String(
        err?.message || err || "unknown error"
      )}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#btn-create-notes-gen")?.addEventListener("click", async () => {
    const status = $("#create-notes-status");
    const btn = $("#btn-create-notes-gen");
    const topic = $("#create-notes-topic").value.trim();
    const prompt = $("#create-notes-prompt").value.trim();
    const useWeb = $("#create-notes-use-web")?.checked !== false;
    if (!topic && !prompt) {
      status.textContent = "Enter a topic or instructions (or both).";
      return;
    }
    const apiKey = readApiKey();
    status.textContent = useWeb ? "Fetching Wikipedia reference…" : "Calling OpenAI…";
    if (btn) btn.disabled = true;
    try {
      const result = await generateResearchNotes({
        topic: topic || prompt.slice(0, 120),
        userPrompt: prompt || `Write study notes on: ${topic}.`,
        apiKey,
        useWeb,
      });
      if (!result.ok) {
        status.textContent = result.error;
        return;
      }
      $("#create-notes-preview").value = result.text;
      status.textContent = result.wikiUsed
        ? `Notes generated using Wikipedia (“${result.wikiTitle}”) + OpenAI. Edit if needed, then save.`
        : result.wikiTimedOut
          ? "Wikipedia slow, continuing with notes-only. Notes generated from model knowledge; edit and save."
          : "Notes generated (no Wikipedia match—model used general knowledge). Edit if needed, then save.";
    } catch (err) {
      status.textContent = `Could not generate notes right now. Check your internet/API key and try again. (${String(
        err?.message || err || "unknown error"
      )})`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#btn-create-notes-save")?.addEventListener("click", () => {
    const status = $("#create-notes-status");
    const preview = $("#create-notes-preview").value.trim();
    if (!preview) {
      status.textContent = "Generate notes first, or paste text into the preview.";
      return;
    }
    const targetId = $("#create-notes-target")?.value || "";
    const topic = $("#create-notes-topic").value.trim() || "Research notes";
    if (targetId) {
      replaceDocNotes(targetId, topic, preview);
      status.textContent = `Updated “${getDoc(targetId)?.title || "set"}” in your library.`;
    } else {
      processAndSaveDoc(topic, preview);
      status.textContent = `Saved new set “${topic}”. Open Library to review.`;
    }
  });

  $("#btn-chat-send").addEventListener("click", async () => {
    const q = $("#chat-input").value.trim();
    const status = $("#chat-status");
    if (!q) {
      status.textContent = "Type a question or a topic first.";
      return;
    }
    status.textContent = "Thinking…";
    appendChat("user", q);
    $("#chat-input").value = "";
    const apiKey = readApiKey();

    try {
      // Prefer chat dropdown, then whichever set is active in the Library.
      let docId = $("#chat-doc-select").value;
      if (!docId && state.activeDocId) docId = state.activeDocId;
      const doc = docId ? getDoc(docId) : null;

      if (doc) {
        const chunks =
          doc.chunks?.length > 0 ? doc.chunks : buildStudyMaterial(doc.content, doc.id).chunks;
        const res = await answerQuestion(q, chunks, apiKey);
        status.textContent =
          res.source === "openai"
            ? "Answer from model + your notes."
            : "Answer from your notes (local retrieval).";
        appendChat("bot", res.text, res.cites);
        return;
      }

      status.textContent = "No notes yet — creating a new notes set for this topic…";
      const notes = await generateNotesForTopic(q, apiKey);
      const shortTitle = q.length > 60 ? `${q.slice(0, 57)}…` : q;
      processAndSaveDoc(shortTitle || "AI-generated notes", notes);
      const newDoc = state.activeDocId ? getDoc(state.activeDocId) : null;
      if (newDoc) {
        const chunks =
          newDoc.chunks?.length > 0 ? newDoc.chunks : buildStudyMaterial(newDoc.content, newDoc.id).chunks;
        const res = await answerQuestion(q, chunks, apiKey);
        status.textContent =
          res.source === "openai"
            ? "Answer from freshly generated notes."
            : "Answer from freshly generated notes (local retrieval).";
        appendChat("bot", res.text, res.cites);
      } else {
        status.textContent = "Created notes outline, but something went wrong linking it to chat.";
      }
    } catch (e) {
      status.textContent = "Could not complete chat. Check your connection or try again.";
      appendChat("bot", String(e?.message || e), []);
    }
  });

  wireApStarterPickers();
}

function initMainApp() {
  if (mainAppInitialized) return;
  mainAppInitialized = true;
  currentStateStorageKey = storageKeyForSession(loadSessionRecord());
  state = loadState(currentStateStorageKey);
  if (!state.docs.length) state = { ...defaultState(), ...state };
  bindUi();
  syncOpenAiKeyFields();
  syncOpenAiBaseField();
  renderDocList();
  renderActiveDoc();
  refreshSelectors();
  renderWeakTopics();
  setTab(getLastTab());
  updateSessionHeader();
}

async function onStartContinue() {
  const err = $("#start-error");
  const emailInput = $("#start-email");
  const passInput = $("#start-password");
  const remember = $("#start-remember");
  const email = normalizeEmail(emailInput?.value);
  const pass = String(passInput?.value || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (err) err.textContent = "Enter a valid email address.";
    return;
  }
  if (pass.length < 8) {
    if (err) err.textContent = "Password must be at least 8 characters.";
    return;
  }
  if (err) err.textContent = "Signing in…";
  const users = loadUserIndex();
  const existing = users[email];
  const salt = existing?.salt || randomSaltHex();
  let hash = "";
  try {
    hash = await sha256Hex(`${salt}|${pass}`);
  } catch (e) {
    if (err) err.textContent = String(e?.message || e);
    return;
  }
  if (existing && existing.passHash !== hash) {
    if (err) err.textContent = "Incorrect password for this email.";
    return;
  }
  if (!existing) {
    users[email] = { email, salt, passHash: hash, createdAt: Date.now() };
    saveUserIndex(users);
  }
  saveSessionRecord(email, remember?.checked !== false);
  hideStartGate();
  initMainApp();
}

function signOut() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

function shouldSkipStartGate() {
  const s = loadSessionRecord();
  return Boolean(s?.rememberMe && s.userId && s.email);
}

function boot() {
  $("#btn-start-continue")?.addEventListener("click", onStartContinue);
  $("#btn-sign-out")?.addEventListener("click", signOut);
  $("#start-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStartContinue();
  });
  $("#start-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStartContinue();
  });

  if (shouldSkipStartGate()) {
    document.documentElement.classList.add("auto-signed-in");
    hideStartGate();
    initMainApp();
    return;
  }

  const prev = loadSessionRecord();
  if (prev?.email && $("#start-email")) {
    $("#start-email").value = prev.email;
  }
  if ($("#start-remember")) {
    $("#start-remember").checked = prev?.rememberMe !== false;
  }
  showStartGate();
}

boot();
