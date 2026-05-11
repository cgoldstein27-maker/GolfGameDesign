/**
 * openai-api.js — single place for OpenAI-compatible chat/completions calls.
 * Used by Ask notes, quiz generation, and refine-notes.
 *
 * Optional base URL (localStorage) points at any OpenAI-compatible gateway;
 * default is https://api.openai.com/v1
 */

export const OPENAI_API_BASE_STORAGE_KEY = "study-smart-openai-api-base";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

export function getOpenAiApiBase() {
  try {
    const raw = localStorage.getItem(OPENAI_API_BASE_STORAGE_KEY);
    const t = (raw || "").trim().replace(/\/+$/, "");
    if (!t || !/^https?:\/\//i.test(t)) return DEFAULT_OPENAI_BASE;
    return t;
  } catch {
    return DEFAULT_OPENAI_BASE;
  }
}

export function chatCompletionsUrl() {
  return `${getOpenAiApiBase()}/chat/completions`;
}

/**
 * POST /chat/completions with Bearer auth and AbortController timeout.
 * @param {string} apiKey
 * @param {object} payload  Full JSON body (model, messages, …)
 * @param {number} [timeoutMs=90000]
 * @returns {Promise<Response>}
 */
export async function fetchOpenAiChatCompletions(apiKey, payload, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(chatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}
