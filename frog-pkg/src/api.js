import { randomBytes } from "node:crypto";
import state from "./state.js";
import {
  CODE_ASSIST_ENDPOINT, getCodeAssistHeaders, STANDARD_API_URL, getSessionId, resetSessionId,
  saveAuth, getSystemPrompt,
} from "./config.js";
import { ensureValidToken, refreshAccessToken, isOAuthEnabled } from "./auth.js";
import { fetchWithTimeout, sleep, rateLimitWait } from "./net.js";
import {
  parseRetryDelay, isTerminalQuota, isNetworkError, isRateLimitError,
  isModelNotFoundError, isThoughtSignatureError,
  getCurrentKey, getModelFallback, getFlashFallback, parseModelAuth,
  DAILY_QUOTA_COOLDOWN,
} from "./fallback.js";

// Helper: clean up for model switches
// Strips standalone thought parts but preserves thoughtSignature on functionCall parts
function prepareModelSwitch() {
  stripThoughtSignatures(true);
  resetSessionId();
}
import { startSpin, stopSpin } from "./ui.js";
import { tools } from "./tools.js";

// ====== Init Project ======
export async function initProject() {
  if (state.authTokens.project_id) return;

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.authTokens.access_token}`,
        ...getCodeAssistHeaders(),
      },
      body: "{}",
    },
    15000
  );

  if (res.ok) {
    const data = await res.json();
    if (data.cloudaicompanionProject) {
      state.authTokens.project_id = data.cloudaicompanionProject;
      saveAuth(state.authTokens);
      process.stdout.write(`\x1b[90m  project: ${state.authTokens.project_id}\x1b[0m\n`);
    }
  }
}

// ====== OAuth Stream ======
export async function callGeminiOAuthStream(contents, _retried) {
  const valid = await ensureValidToken();
  if (!valid) throw new Error("OAuth token invalid. Run /login to re-authenticate.");

  await initProject();

  const body = {
    project: state.authTokens.project_id || "",
    model: state.MODEL,
    user_prompt_id: randomBytes(16).toString("hex"),
    request: {
      contents,
      tools,
      systemInstruction: { parts: [{ text: getSystemPrompt() }] },
      generationConfig: { temperature: 0.2 },
      session_id: getSessionId(),
    },
  };

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.authTokens.access_token}`,
        Accept: "text/event-stream",
        ...getCodeAssistHeaders(),
      },
      body: JSON.stringify(body),
    },
    90000
  );

  if (!res.ok) {
    const errText = await res.text();
    if ((res.status === 401 || res.status === 403) && !_retried && (await refreshAccessToken())) {
      return callGeminiOAuthStream(contents, true);
    }
    const err = new Error(`CodeAssist API ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 429) { err.status = 429; err.text = errText; }
    if (res.status === 404) { err.status = 404; }
    if (res.status === 400 && errText.includes("thought_signature")) { err.status = 400; }
    throw err;
  }

  // Parse SSE stream
  let fullText = "";
  const allParts = [];
  let streamingText = false;
  let pendingSignature = null;

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (state.aborted) break;
      let readResult;
      try {
        readResult = await reader.read();
      } catch {
        break;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(jsonStr);
          const resp = chunk.response || chunk;
          const parts = resp.candidates?.[0]?.content?.parts || [];

          for (const part of parts) {
            if (part.thought) {
              allParts.push(part);
            } else if (part.thoughtSignature && !part.functionCall && !part.text) {
              pendingSignature = part.thoughtSignature;
            } else if (part.text && !part.thought) {
              if (!streamingText) {
                stopSpin();
                streamingText = true;
              }
              process.stdout.write(part.text);
              fullText += part.text;
            } else if (part.functionCall) {
              if (pendingSignature && !part.thoughtSignature) {
                part.thoughtSignature = pendingSignature;
                pendingSignature = null;
              }
              allParts.push(part);
            }
          }
        } catch {}
      }
    }
  } catch (streamErr) {
    if (allParts.length === 0 && !fullText) {
      throw new Error(`Stream failed: ${streamErr.message}`);
    }
  }

  if (streamingText) process.stdout.write("\n");
  if (fullText) allParts.unshift({ text: fullText });

  if (allParts.length === 0) {
    return { role: "model", parts: [{ text: "[Empty response]" }] };
  }

  return { role: "model", parts: allParts };
}

// ====== OAuth Non-Stream ======
export async function callGeminiOAuthNonStream(contents, _retried) {
  const valid = await ensureValidToken();
  if (!valid) throw new Error("OAuth token invalid. Run /login to re-authenticate.");
  await initProject();

  const body = {
    project: state.authTokens.project_id || "",
    model: state.MODEL,
    user_prompt_id: randomBytes(16).toString("hex"),
    request: {
      contents,
      tools,
      systemInstruction: { parts: [{ text: getSystemPrompt() }] },
      generationConfig: { temperature: 0.2 },
      session_id: getSessionId(),
    },
  };

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.authTokens.access_token}`,
        ...getCodeAssistHeaders(),
      },
      body: JSON.stringify(body),
    },
    90000
  );

  if (!res.ok) {
    const errText = await res.text();
    if ((res.status === 401 || res.status === 403) && !_retried && (await refreshAccessToken())) {
      return callGeminiOAuthNonStream(contents, true);
    }
    const err = new Error(`CodeAssist API ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 429) { err.status = 429; err.text = errText; }
    if (res.status === 404) { err.status = 404; }
    if (res.status === 400 && errText.includes("thought_signature")) { err.status = 400; }
    throw err;
  }

  const data = await res.json();
  const resp = data.response || data;
  if (resp.candidates?.[0]?.content) return resp.candidates[0].content;
  if (resp.candidates?.[0]?.finishReason === "SAFETY") {
    return { role: "model", parts: [{ text: "[Safety filter blocked this response]" }] };
  }
  throw new Error("Unexpected response: " + JSON.stringify(data).substring(0, 300));
}

// ====== Thinking-capable model detection ======
const THINKING_MODELS = /^gemini-(2\.5|3[.-])/;

function isThinkingModel(model) {
  return THINKING_MODELS.test(model);
}

// ====== API Key ======
async function callGeminiApiKey(contents) {
  if (!state.API_KEY) throw new Error("GEMINI_API_KEY not set and OAuth not configured. Run /login");

  const body = {
    contents,
    tools,
    systemInstruction: { parts: [{ text: getSystemPrompt() }] },
    generationConfig: { temperature: 0.2 },
  };

  // Thinking models (2.5+, 3.x) require explicit thinkingConfig via standard API
  if (isThinkingModel(state.MODEL)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 8192 };
  }

  const res = await fetchWithTimeout(
    `${STANDARD_API_URL}/models/${state.MODEL}:generateContent?key=${state.API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    90000
  );

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      throw { status: 429, text: errText };
    }
    const err = new Error(`API ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 404) { err.status = 404; }
    if (res.status === 400 && errText.includes("thought_signature")) { err.status = 400; }
    throw err;
  }

  const data = await res.json();
  if (data.candidates?.[0]?.content) return data.candidates[0].content;
  if (data.candidates?.[0]?.finishReason === "SAFETY") {
    return { role: "model", parts: [{ text: "[Safety filter blocked this response]" }] };
  }
  throw new Error("Unexpected response: " + JSON.stringify(data).substring(0, 300));
}

// ====== Strip Thought Signatures ======
export function stripThoughtSignatures(force = false) {
  // force=true: model switch — strip ALL signatures (including functionCall).
  //             Different model = different signature keys, foreign sigs → 400.
  // force=false: same-model retry — keep functionCall signatures (API requires
  //             them for the current model), skip entirely for OAuth/thinking models.
  if (!force && (state.forceAuth === "oauth" || isThinkingModel(state.MODEL))) return;
  let stripped = 0;
  for (const msg of state.history) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (!force && part.functionCall) continue; // same-model: preserve functionCall sigs
      if (part.thought) { stripped++; delete part.thought; }
      if (part.thoughtSignature) { stripped++; delete part.thoughtSignature; }
    }
    // Remove parts that are now empty (standalone thought-only parts)
    msg.parts = msg.parts.filter((p) => p.text || p.functionCall || p.functionResponse || p.thoughtSignature);
  }
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].parts && state.history[i].parts.length === 0) {
      state.history.splice(i, 1);
    }
  }
  // Debug: check what remains after strip
  let remaining = 0;
  const suspicious = [];
  for (const msg of state.history) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const keys = Object.keys(part);
      for (const k of keys) {
        if (k.toLowerCase().includes("thought") || k.toLowerCase().includes("signature")) {
          remaining++;
          suspicious.push(k);
        }
      }
    }
  }
  process.stdout.write(`\x1b[90m  [strip] removed ${stripped} thought/sig fields. remaining suspicious: ${remaining}${suspicious.length ? " (" + [...new Set(suspicious)].join(", ") + ")" : ""}\x1b[0m\n`);
}

// ====== History Management ======
export const MAX_PAYLOAD_BYTES = 200000;
const TOOL_RESULT_MAX = 30000;

export function estimateSize(obj) {
  return JSON.stringify(obj).length;
}

function truncateStringsInObj(obj, maxLen) {
  if (typeof obj === "string") {
    return obj.length > maxLen ? obj.substring(0, maxLen) + "\n...[truncated]" : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => truncateStringsInObj(v, maxLen));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateStringsInObj(v, maxLen);
    }
    return out;
  }
  return obj;
}

export function compactHistory() {
  let changed = false;
  const keepFullCount = 6;
  const OLD_TEXT_MAX = 2000;
  for (let i = 0; i < Math.max(0, state.history.length - keepFullCount); i++) {
    const msg = state.history[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.functionResponse) {
        const before = estimateSize(part.functionResponse);
        if (before > 2000) {
          part.functionResponse.response = truncateStringsInObj(part.functionResponse.response, 500);
          changed = true;
        }
      }
      if (part.text && !part.thought && part.text.length > OLD_TEXT_MAX) {
        part.text = part.text.substring(0, OLD_TEXT_MAX) + "\n...[compacted]";
        changed = true;
      }
    }
  }

  while (state.history.length > 6 && estimateSize(state.history) > MAX_PAYLOAD_BYTES) {
    state.history.shift();
    changed = true;
  }

  const RECENT_TEXT_MAX = 30000;
  for (const msg of state.history) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.functionResponse) {
        const size = estimateSize(part.functionResponse);
        if (size > TOOL_RESULT_MAX) {
          part.functionResponse.response = truncateStringsInObj(part.functionResponse.response, TOOL_RESULT_MAX);
          changed = true;
        }
      }
      if (part.text && !part.thought && part.text.length > RECENT_TEXT_MAX) {
        part.text = part.text.substring(0, RECENT_TEXT_MAX) + "\n...[truncated]";
        changed = true;
      }
    }
  }

  return changed;
}

// ====== Main callGemini with retry/fallback ======
export async function callGemini(contents) {
  if (estimateSize(contents) > MAX_PAYLOAD_BYTES) {
    compactHistory();
  }
  await rateLimitWait();

  if (state.pendingRestore) {
    const { model: restoreModel, auth: restoreAuth } = parseModelAuth(state.pendingRestore);
    if (state.MODEL !== restoreModel || state.forceAuth !== (restoreAuth || null)) {
      if (state.dailyQuotaHitAt && (Date.now() - state.dailyQuotaHitAt) < DAILY_QUOTA_COOLDOWN) {
        // Skip restore - still in cooldown
      } else {
        state.MODEL = restoreModel;
        state.forceAuth = restoreAuth || null;
        process.stdout.write(`\x1b[90m  (trying to restore: ${state.MODEL}${state.forceAuth ? "@" + state.forceAuth : ""})\x1b[0m\n`);
        state.pendingRestore = null;
        state.dailyQuotaHitAt = null;
        state.fallbackTried.clear();
        prepareModelSwitch();
      }
    }
  }

  const MAX_ATTEMPTS = 7;
  const INITIAL_DELAY = 5000;
  const MAX_DELAY = 30000;

  let currentDelay = INITIAL_DELAY;
  let thoughtSigRetried = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (state.aborted) throw new Error("Aborted by user");
    try {
      let result;
      const useOAuth = state.forceAuth === "oauth" ? true : state.forceAuth === "apikey" ? false : isOAuthEnabled();
      if (useOAuth) {
        result = await callGeminiOAuthStream(contents);
      } else {
        result = await callGeminiApiKey(contents);
      }
      state.lastApiCall = Date.now();
      state.fallbackTried.clear();
      return result;
    } catch (e) {
      if (isRateLimitError(e)) {
        const errText = typeof e.text === "string" ? e.text : e.message || "";

        if (isTerminalQuota(errText)) {
          state.fallbackTried.add(getCurrentKey());
          const flash = getFlashFallback();
          if (flash) {
            const { model: fbModel, auth: fbAuth } = parseModelAuth(flash);
            stopSpin();
            process.stdout.write(`\x1b[33m  ! daily quota reached on ${getCurrentKey()}. falling back to ${flash}\x1b[0m\n`);
            state.pendingRestore = getCurrentKey();
            state.dailyQuotaHitAt = Date.now();
            state.MODEL = fbModel;
            state.forceAuth = fbAuth || null;
            prepareModelSwitch();
            attempt = -1;
            currentDelay = INITIAL_DELAY;
            continue;
          }
          throw new Error(`日次クォータ超過 (${state.MODEL}). しばらく待ってから再試行してください。`);
        }

        if (attempt >= MAX_ATTEMPTS - 1) {
          throw new Error(`Rate limit exceeded. しばらく待ってから再試行してください。`);
        }

        const serverDelay = parseRetryDelay(errText);
        let waitMs;
        if (serverDelay > 0) {
          waitMs = serverDelay * 1000 + currentDelay * 0.2 * Math.random();
          currentDelay = Math.max(currentDelay, serverDelay * 1000);
        } else {
          const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
          waitMs = Math.max(0, currentDelay + jitter);
        }

        stopSpin();
        if (attempt === 0) process.stdout.write(`\x1b[90m  429: ${errText.substring(0, 200)}\x1b[0m\n`);

        if (attempt === 0 && serverDelay > 0 && serverDelay <= 5) {
          const retryMs = serverDelay * 1000 + 500;
          process.stdout.write(`\x1b[33m  ! rate limit. server says ${serverDelay}s, waiting ${Math.ceil(retryMs / 1000)}s...\x1b[0m\n`);
          startSpin(`retrying in ${Math.ceil(retryMs / 1000)}s...`);
          await sleep(retryMs);
          continue;
        }

        if (attempt <= 1) {
          state.fallbackTried.add(getCurrentKey());
          const fallback = getModelFallback();
          if (fallback) {
            const { model: fbModel, auth: fbAuth } = parseModelAuth(fallback);
            process.stdout.write(`\x1b[33m  ! 429 on ${getCurrentKey()} → ${fallback}\x1b[0m\n`);
            state.pendingRestore = state.pendingRestore || getCurrentKey();
            state.MODEL = fbModel;
            state.forceAuth = fbAuth || null;
            prepareModelSwitch();
            attempt = -1;
            currentDelay = INITIAL_DELAY;
            continue;
          }
        }

        const retryWaitMs = serverDelay > 0 ? serverDelay * 1000 + 500 : waitMs;
        process.stdout.write(`\x1b[33m  ! rate limit. waiting ${Math.ceil(retryWaitMs / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...\x1b[0m\n`);
        startSpin(`retrying in ${Math.ceil(retryWaitMs / 1000)}s...`);
        await sleep(retryWaitMs);
        currentDelay = Math.min(MAX_DELAY, currentDelay * 2);
        continue;
      }

      if (isModelNotFoundError(e)) {
        state.fallbackTried.add(getCurrentKey());
        const fallback = getModelFallback();
        if (fallback) {
          const { model: fbModel, auth: fbAuth } = parseModelAuth(fallback);
          stopSpin();
          process.stdout.write(`\x1b[33m  ! ${getCurrentKey()} not available (404). falling back to ${fallback}\x1b[0m\n`);
          state.pendingRestore = state.pendingRestore || getCurrentKey();
          state.MODEL = fbModel;
          state.forceAuth = fbAuth || null;
          prepareModelSwitch();
          attempt = -1;
          currentDelay = INITIAL_DELAY;
          continue;
        }
        throw new Error(`${state.MODEL} is not available and no fallback model found.`);
      }

      if (isThoughtSignatureError(e)) {
        if (!thoughtSigRetried) {
          // Log the actual error on first encounter for debugging
          stopSpin();
          process.stdout.write(`\x1b[90m  thought_sig error: ${(e.message || "").substring(0, 400)}\x1b[0m\n`);
        }
        prepareModelSwitch();
        if (!thoughtSigRetried) {
          // First try: strip + new session, retry same model
          thoughtSigRetried = true;
          attempt = -1;
          currentDelay = INITIAL_DELAY;
          continue;
        }
        // Still failing — fall back to next model
        state.fallbackTried.add(getCurrentKey());
        const fallback = getModelFallback();
        if (fallback) {
          const { model: fbModel, auth: fbAuth } = parseModelAuth(fallback);
          stopSpin();
          process.stdout.write(`\x1b[33m  ! 400 thought_signature on ${getCurrentKey()} → ${fallback}\x1b[0m\n`);
          state.pendingRestore = state.pendingRestore || getCurrentKey();
          state.MODEL = fbModel;
          state.forceAuth = fbAuth || null;
          thoughtSigRetried = false;
          attempt = -1;
          currentDelay = INITIAL_DELAY;
          continue;
        }
        throw e;
      }

      if (state.aborted) throw new Error("Aborted by user");
      if (isNetworkError(e) && attempt < MAX_ATTEMPTS - 1) {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const waitMs = Math.max(0, currentDelay + jitter);
        stopSpin();
        process.stdout.write(`\x1b[33m  ! network error: ${e.message}. retrying in ${Math.ceil(waitMs / 1000)}s...\x1b[0m\n`);
        startSpin(`retrying in ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        currentDelay = Math.min(MAX_DELAY, currentDelay * 2);
        continue;
      }

      throw e;
    }
  }

  throw new Error("Retry attempts exhausted");
}
