import state from "./state.js";
import { AVAILABLE_MODELS } from "./config.js";
import { isOAuthEnabled } from "./auth.js";

// ====== Retry Delay Parsing ======
export function parseDuration(duration) {
  if (typeof duration !== "string") return null;
  if (duration.endsWith("ms")) {
    const ms = parseFloat(duration.slice(0, -2));
    return isNaN(ms) ? null : ms / 1000;
  }
  if (duration.endsWith("s")) {
    const sec = parseFloat(duration.slice(0, -1));
    return isNaN(sec) ? null : sec;
  }
  return null;
}

export function parseRetryDelay(errText) {
  try {
    const json = JSON.parse(errText);
    const details = json.error?.details || [];
    for (const d of details) {
      if (d["@type"]?.includes("RetryInfo") && d.retryDelay) {
        const sec = parseDuration(d.retryDelay);
        if (sec > 0) return sec;
      }
      if (d.retryDelay) {
        const sec = parseDuration(d.retryDelay) ?? parseInt(d.retryDelay);
        if (sec > 0) return sec;
      }
    }
    const msg = json.error?.message || "";
    const pleaseRetry = msg.match(/(?:Please )?retry in ([0-9.]+(?:ms|s))/i);
    if (pleaseRetry) {
      const sec = parseDuration(pleaseRetry[1]);
      if (sec > 0) return sec;
    }
    const resetMatch = msg.match(/reset after (\d+)s/i);
    if (resetMatch) return parseInt(resetMatch[1]);
  } catch {}
  const resetMatch = errText.match(/reset after (\d+)s/i);
  if (resetMatch) return parseInt(resetMatch[1]);
  const retryMatch = errText.match(/retry in ([0-9.]+(?:ms|s))/i);
  if (retryMatch) {
    const sec = parseDuration(retryMatch[1]);
    if (sec > 0) return sec;
  }
  return 0;
}

export function isTerminalQuota(errText) {
  try {
    const json = JSON.parse(errText);
    const details = json.error?.details || [];
    for (const d of details) {
      if (d.violations) {
        for (const v of d.violations) {
          if (v.quotaId?.includes("PerDay") || v.quotaId?.includes("Daily")) return true;
        }
      }
      if (d.reason === "QUOTA_EXHAUSTED" || d.reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return true;
    }
  } catch {}
  return false;
}

// ====== Fallback Chain ======
function buildFallbackChain() {
  const oauthChain = [
    "gemini-3-flash-preview@oauth",
    "gemini-3-pro-preview@oauth",
    "gemini-3.1-flash-lite-preview@oauth",
  ];
  const apikeyChain = [
    "gemini-3-flash-preview@apikey",
    "gemini-3.1-flash-lite-preview@apikey",
    "gemini-2.5-flash@apikey",
  ];
  const full = [...oauthChain, ...apikeyChain];

  const chain = {};
  for (const entry of full) {
    chain[entry] = full.filter(e => e !== entry);
  }
  for (const model of AVAILABLE_MODELS) {
    if (!chain[model]) {
      chain[model] = full.filter(e => !e.startsWith(model + "@"));
    }
  }
  return chain;
}

export const MODEL_FALLBACK_CHAIN = buildFallbackChain();

export function parseModelAuth(key) {
  const [model, auth] = key.split("@");
  return { model, auth: auth || null };
}

export function getCurrentKey() {
  return state.forceAuth ? `${state.MODEL}@${state.forceAuth}` : state.MODEL;
}

export function getModelFallback() {
  const key = getCurrentKey();
  const chain = MODEL_FALLBACK_CHAIN[key] || MODEL_FALLBACK_CHAIN[state.MODEL] || [];
  for (const candidate of chain) {
    if (!state.fallbackTried.has(candidate)) {
      const { auth } = parseModelAuth(candidate);
      if (auth === "oauth" && !isOAuthEnabled()) continue;
      if (auth === "apikey" && !state.API_KEY) continue;
      return candidate;
    }
  }
  return null;
}

export function getFlashFallback() {
  return getModelFallback();
}


// ====== Error Classification ======
export function isNetworkError(e) {
  const msg = e?.message || "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("UND_ERR_CONNECT_TIMEOUT") ||
    msg.includes("aborted") ||
    e?.name === "AbortError"
  );
}

export function isRateLimitError(e) {
  return e?.status === 429 || (e?.message && e.message.includes("429"));
}

export function isModelNotFoundError(e) {
  return e?.status === 404 || (e?.message && /404.*[Nn]ot [Ff]ound/.test(e.message));
}

export function isThoughtSignatureError(e) {
  return (e?.status === 400 && e?.message?.includes("thought_signature")) ||
    (e?.message && e.message.includes("thought_signature"));
}

export const DAILY_QUOTA_COOLDOWN = 60 * 60 * 1000;
