import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import state from "./state.js";

// ====== .env loading ======
export function loadEnv(rootDir) {
  try {
    const envPath = join(rootDir, ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  } catch {}
}

// ====== OAuth Constants ======
export const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "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";
export const OAUTH_REDIRECT_URI = "http://localhost:8085/oauth2callback";
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
export const CODE_ASSIST_ENDPOINT = process.env.FROG_OAUTH_URL || "https://cloudcode-pa.googleapis.com";

export function getCodeAssistHeaders() {
  return {
    "User-Agent": `GeminiCLI/0.31.0/${state.MODEL} (${process.platform}; ${process.arch})`,
  };
}

// ====== Tool Logging ======
export const FROG_LOG_FILE = join(homedir(), ".frog", "tool.log");
export function frogLog(tool, detail) {
  try {
    const ts = new Date().toISOString();
    const line = `${ts}\t${tool}\t${JSON.stringify(detail)}\n`;
    appendFileSync(FROG_LOG_FILE, line);
  } catch {}
}

// ====== General Config ======
export const AVAILABLE_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
];

export const STANDARD_API_URL = process.env.FROG_API_URL || "https://generativelanguage.googleapis.com/v1beta";
export const MAX_TOOL_LOOPS = 30;

export function getSessionId() {
  if (!state.sessionId) state.sessionId = randomUUID();
  return state.sessionId;
}

export function resetSessionId() {
  state.sessionId = randomUUID();
  return state.sessionId;
}

// ====== Auth Storage ======
export const AUTH_DIR = join(homedir(), ".frog");
export const AUTH_FILE = join(AUTH_DIR, "auth.json");

export function loadAuth() {
  try {
    if (existsSync(AUTH_FILE)) {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

export function saveAuth(tokens) {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

// ====== Dangerous Patterns ======
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf])/,
  /\brm\s+--(?:recursive|force)/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bchmod\s+(-R\s+)?777/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\s+rm\b/,
  /\bfmt\s+\/dev\//,
];

export function isDangerous(command) {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

// ====== System Prompt ======
export const getSystemPrompt = () => `You are a coding agent running in a terminal.
Current working directory: ${state.CWD}

# Context Efficiency (CRITICAL)
You have limited tool calls per turn. Minimize unnecessary calls.

Strategy:
1. Use search_text (grep) to find what you need. Do NOT list directories to browse.
2. Read only the files you actually need to modify.
3. Plan ALL changes first, then execute writes in as few calls as possible.
4. Use write_files (plural) to create multiple files in ONE call.
5. Use absolute paths. Do NOT use cd commands.
6. Do NOT read a file after writing to verify. Trust the write.
7. Combine shell commands with && when possible.

Workflow: Research → Strategy → Execution
- Research: Use search_text and read_file to understand the codebase. Be targeted.
- Strategy: Plan your changes before acting. Do not start writing code until you know what to change.
- Execution: Apply changes surgically. Validate with tests/builds if applicable.

Rules:
- Use edit_file for modifications, write_file/write_files for new files
- Be concise. Under 3 lines of text output unless explaining complex changes.
- Respond in the same language the user uses
- NEVER run interactive commands. Use non-interactive flags (-y, --yes, -m, etc.)
- Do NOT explore aimlessly. If you cannot find something in 2-3 searches, ask the user.`
+ (state.sessionStartContext ? `\n\n${state.sessionStartContext}` : "");
