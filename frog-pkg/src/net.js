import state from "./state.js";

export const MIN_INTERVAL = 3000;
const THROTTLED_INTERVAL = 8000;  // after hitting 429, slow down for a while
const THROTTLE_DURATION = 60000;  // stay throttled for 60s after last 429

export function sleep(ms) {
  return new Promise((r, rej) => {
    const timer = setTimeout(r, ms);
    const check = setInterval(() => {
      if (state.aborted) { clearTimeout(timer); clearInterval(check); rej(new Error("Aborted by user")); }
    }, 200);
    setTimeout(() => clearInterval(check), ms);
  });
}

export function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  state.currentAbortController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (state.currentAbortController === controller) state.currentAbortController = null;
  });
}

// Call this when a 429 is received to activate throttle mode
export function markRateLimited() {
  state.lastRateLimitAt = Date.now();
}

export async function rateLimitWait() {
  // Use longer interval if we recently hit a 429
  const isThrottled = state.lastRateLimitAt && (Date.now() - state.lastRateLimitAt) < THROTTLE_DURATION;
  const interval = isThrottled ? THROTTLED_INTERVAL : MIN_INTERVAL;

  const elapsed = Date.now() - state.lastApiCall;
  if (elapsed < interval) {
    const waitMs = interval - elapsed;
    if (waitMs > 3000) {
      process.stdout.write(`\x1b[90m  (cooldown ${Math.ceil(waitMs / 1000)}s...)\x1b[0m\n`);
    }
    await sleep(waitMs);
  }
}
