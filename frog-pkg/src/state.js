// Shared mutable state — leaf module with no imports from src/
// All other modules import this to read/write shared state.

const state = {
  MODEL: process.env.AGENT_MODEL || "gemini-3-flash-preview",
  API_KEY: process.env.GEMINI_API_KEY || "",
  CWD: process.cwd(),
  authTokens: null,
  history: [],
  turnCount: 0,
  safetyMode: "blocklist",
  aborted: false,
  agentRunning: false,
  currentAbortController: null,
  lastApiCall: 0,
  forceAuth: null,
  fallbackTried: new Set(),
  pendingRestore: null,
  dailyQuotaHitAt: null,
  lastFallbackAt: null,
  hooksConfig: null,
  sessionStartContext: "",
  spinTimer: null,
  spinIdx: 0,
  sessionId: null,
};

export default state;
