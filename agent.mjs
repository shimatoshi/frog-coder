#!/usr/bin/env node
// ============================================
// Coding Agent for Termux
// Zero dependencies. Gemini OAuth + API key.
// ============================================

import { createInterface } from "node:readline";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

// ====== Load .env (zero-dep) ======
try {
  const envPath = join(dirname(new URL(import.meta.url).pathname), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}

// ====== OAuth Config (from Gemini CLI open source) ======
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_HEADERS = {
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata":
    "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

// ====== General Config ======
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.AGENT_MODEL || "gemini-2.5-flash";
const STANDARD_API_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOOL_LOOPS = 30;
let CWD = process.cwd();

// ====== Auth Storage ======
const AUTH_DIR = join(homedir(), ".ai-coder");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

function loadAuth() {
  try {
    if (existsSync(AUTH_FILE)) {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveAuth(tokens) {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

let authTokens = loadAuth();

// ====== PKCE ======
function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ====== OAuth Flow ======
async function startOAuthLogin() {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  console.log("\x1b[36m\nブラウザで以下のURLを開いてGoogleログインしてください:\x1b[0m\n");
  console.log(authUrl + "\n");

  // Try to open browser
  try {
    execSync(`termux-open-url "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
    console.log("\x1b[90mブラウザを開きました...\x1b[0m");
  } catch {
    try {
      execSync(`xdg-open "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
    } catch {
      console.log("\x1b[90mURLをコピーしてブラウザで開いてください。\x1b[0m");
    }
  }

  // Wait for callback
  const code = await waitForOAuthCallback(state);

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, verifier);
  authTokens = tokens;
  saveAuth(tokens);

  console.log(`\x1b[32m\n認証成功！\x1b[0m`);
  if (tokens.email) console.log(`\x1b[90mAccount: ${tokens.email}\x1b[0m`);
  console.log("");
}

function waitForOAuthCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:8085");

      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>認証エラー: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body style='text-align:center;padding:50px;font-family:sans-serif'>" +
          "<h1>認証完了！</h1><p>ターミナルに戻ってください。</p></body></html>"
      );
      server.close();
      resolve(code);
    });

    server.listen(8085, () => {
      console.log("\x1b[90m認証待機中 (port 8085)...\x1b[0m");
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error("Port 8085 is already in use. Close other instances first."));
      } else {
        reject(e);
      }
    });

    // Timeout after 3 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("認証タイムアウト（3分）"));
    }, 180000);
  });
}

async function exchangeCodeForTokens(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    code_verifier: verifier,
  });

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, 15000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const data = await res.json();

  // Get user email
  let email = null;
  try {
    const userRes = await fetchWithTimeout(
      "https://www.googleapis.com/oauth2/v1/userinfo",
      { headers: { Authorization: `Bearer ${data.access_token}` } },
      10000
    );
    if (userRes.ok) {
      const user = await userRes.json();
      email = user.email;
    }
  } catch {}

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    email,
  };
}

async function refreshAccessToken() {
  if (!authTokens?.refresh_token) return false;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: authTokens.refresh_token,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });

  try {
    const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, 15000);

    if (!res.ok) return false;

    const data = await res.json();
    authTokens.access_token = data.access_token;
    authTokens.expires_at = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) authTokens.refresh_token = data.refresh_token;
    saveAuth(authTokens);
    return true;
  } catch {
    return false;
  }
}

async function ensureValidToken() {
  if (!authTokens) return false;
  // Refresh if expiring within 60 seconds
  if (Date.now() > authTokens.expires_at - 60000) {
    process.stdout.write("\x1b[90m  (refreshing token...)\x1b[0m\n");
    return await refreshAccessToken();
  }
  return true;
}

function isOAuthEnabled() {
  return authTokens?.access_token && authTokens?.refresh_token;
}

// ====== State ======
let history = [];
let pasteMode = false;
let pasteBuffer = [];
let turnCount = 0;
let _sseRes = null; // Set during web mode SSE response

function sseWrite(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

// ====== System Prompt ======
const getSystemPrompt = () => `You are a coding agent running in a terminal on Android (Termux).
You help developers by reading, writing, and editing code, running commands, and navigating projects.

Current working directory: ${CWD}

CRITICAL - Minimize API calls (rate limit is ~1 per minute):
- Use ABSOLUTE PATHS for all file operations (based on current working directory shown above)
- Do NOT use cd commands. Use absolute paths instead.
- ALWAYS use write_files (plural) to create multiple files in ONE tool call. NEVER call write_file multiple times in a row.
- Do NOT read a file right after writing it just to verify - trust the write succeeded
- Plan your work first, then execute ALL file writes in a single write_files call
- When creating a project, put ALL files in one write_files call
- Combine as much work as possible into each tool call to minimize round-trips

Rules:
- Use edit_file for modifications to existing files, write_file for new files
- Be concise. Show what you did, not lengthy explanations
- When you encounter errors, fix them and retry
- Respond in the same language the user uses
- NEVER run interactive commands. Always use non-interactive flags:
  - npm create vite → npm create vite@latest myapp -- --template react-ts
  - npm init → npm init -y
  - npx create-react-app → npx create-react-app myapp --template typescript
  - pip install → pip install -y / --yes where applicable
  - git commit → always use -m flag
  - Any command that prompts: add --yes, -y, or pipe input to avoid hangs`;

// ====== Tool Definitions ======
const tools = [
  {
    functionDeclarations: [
      {
        name: "read_file",
        description:
          "Read file contents. Use this before editing. Returns the full content with line numbers.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "File path (absolute or relative to cwd)" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description:
          "Create a new file or completely overwrite an existing file. Creates parent directories automatically.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "File path" },
            content: { type: "STRING", description: "Complete file content" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "write_files",
        description:
          "Create/overwrite MULTIPLE files at once. Use this when creating a project or writing more than one file. Much more efficient than calling write_file multiple times.",
        parameters: {
          type: "OBJECT",
          properties: {
            files: {
              type: "ARRAY",
              description: "Array of files to write",
              items: {
                type: "OBJECT",
                properties: {
                  path: { type: "STRING", description: "File path" },
                  content: { type: "STRING", description: "Complete file content" },
                },
                required: ["path", "content"],
              },
            },
          },
          required: ["files"],
        },
      },
      {
        name: "edit_file",
        description:
          "Edit a file by replacing exact text. old_text must match exactly and uniquely in the file.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "File path" },
            old_text: { type: "STRING", description: "Exact text to find (must be unique in file)" },
            new_text: { type: "STRING", description: "Replacement text" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "list_directory",
        description: "List files and directories. Shows type (file/dir) for each entry.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Directory path (default: cwd)" },
            recursive: { type: "BOOLEAN", description: "List recursively up to 3 levels deep (default: false)" },
          },
        },
      },
      {
        name: "execute_command",
        description:
          "Run a shell command and return stdout/stderr. Use for builds, tests, git, etc.",
        parameters: {
          type: "OBJECT",
          properties: {
            command: { type: "STRING", description: "Shell command to run" },
            timeout: { type: "NUMBER", description: "Timeout in seconds (default: 30, max: 120)" },
          },
          required: ["command"],
        },
      },
      {
        name: "find_files",
        description: "Find files by name pattern (glob). Ignores node_modules and .git.",
        parameters: {
          type: "OBJECT",
          properties: {
            pattern: { type: "STRING", description: 'Filename pattern, e.g. "*.tsx", "package.json"' },
            path: { type: "STRING", description: "Search root directory (default: cwd)" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "search_text",
        description:
          "Search for text/regex in files (like grep -rn). Returns matching lines with paths and line numbers.",
        parameters: {
          type: "OBJECT",
          properties: {
            pattern: { type: "STRING", description: "Text or regex pattern to search for" },
            path: { type: "STRING", description: "File or directory to search in (default: cwd)" },
            file_pattern: { type: "STRING", description: 'Only search files matching this glob, e.g. "*.py"' },
          },
          required: ["pattern"],
        },
      },
    ],
  },
];

// ====== Tool Implementations ======
function resolvePath(p) {
  if (!p) return CWD;
  return resolve(CWD, p);
}

function toolReadFile({ path }) {
  try {
    const full = resolvePath(path);
    const content = readFileSync(full, "utf-8");
    const lines = content.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join("\n");
    if (lines.length > 2000) {
      return { success: true, path: full, total_lines: lines.length, content: numbered.substring(0, 50000), truncated: true };
    }
    return { success: true, path: full, total_lines: lines.length, content: numbered };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toolWriteFile({ path, content }) {
  try {
    const full = resolvePath(path);
    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content, "utf-8");
    return { success: true, path: full, lines: content.split("\n").length, bytes: Buffer.byteLength(content) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toolWriteFiles({ files }) {
  const results = [];
  for (const f of files || []) {
    results.push(toolWriteFile(f));
  }
  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;
  return { success: fail === 0, wrote: ok, failed: fail, results };
}

function toolEditFile({ path, old_text, new_text }) {
  try {
    const full = resolvePath(path);
    const content = readFileSync(full, "utf-8");
    if (!content.includes(old_text)) return { success: false, error: "old_text not found in file" };
    const count = content.split(old_text).length - 1;
    if (count > 1) return { success: false, error: `old_text found ${count} times. Provide more context.` };
    writeFileSync(full, content.replace(old_text, new_text), "utf-8");
    return { success: true, path: full };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toolListDirectory({ path, recursive }) {
  try {
    const full = resolvePath(path);
    if (recursive) {
      const r = spawnSync("find", [full, "-maxdepth", "3", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/__pycache__/*"], { encoding: "utf-8", timeout: 10000 });
      return { success: true, path: full, entries: (r.stdout || "").trim().split("\n").filter(Boolean).slice(0, 300) };
    }
    const entries = readdirSync(full, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
    return { success: true, path: full, entries };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toolExecuteCommand({ command, timeout }) {
  // Handle cd command - update CWD
  const cdMatch = command.match(/^cd\s+(.+)$/);
  if (cdMatch) {
    const target = resolve(CWD, cdMatch[1].replace(/^["']|["']$/g, ""));
    if (existsSync(target)) {
      CWD = target;
      return { success: true, output: `Changed directory to ${CWD}` };
    }
    return { success: false, error: `Directory not found: ${target}` };
  }

  const ms = Math.min((timeout || 30) * 1000, 120000);
  try {
    const output = execSync(command, { encoding: "utf-8", timeout: ms, cwd: CWD, maxBuffer: 2 * 1024 * 1024, input: "\n", env: { ...process.env, CI: "true" } });
    return { success: true, output: output.substring(0, 15000) };
  } catch (e) {
    return { success: false, exit_code: e.status, stdout: (e.stdout || "").substring(0, 8000), stderr: (e.stderr || "").substring(0, 8000) };
  }
}

function toolFindFiles({ pattern, path }) {
  try {
    const full = resolvePath(path);
    const r = spawnSync("find", [full, "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { encoding: "utf-8", timeout: 10000 });
    const files = (r.stdout || "").trim().split("\n").filter(Boolean).slice(0, 100);
    return { success: true, files, count: files.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toolSearchText({ pattern, path, file_pattern }) {
  try {
    const full = resolvePath(path);
    const args = ["-rn", "--color=never", "-I"];
    if (file_pattern) args.push("--include=" + file_pattern);
    args.push("--exclude-dir=node_modules", "--exclude-dir=.git", pattern, full);
    const r = spawnSync("grep", args, { encoding: "utf-8", timeout: 15000 });
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean).slice(0, 80);
    return { success: true, matches: lines, count: lines.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const TOOL_MAP = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  write_files: toolWriteFiles,
  edit_file: toolEditFile,
  list_directory: toolListDirectory,
  execute_command: toolExecuteCommand,
  find_files: toolFindFiles,
  search_text: toolSearchText,
};

// ====== Spinner ======
const SPIN = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];
let spinTimer = null;
let spinIdx = 0;

function startSpin(msg) {
  if (_sseRes) return;
  spinIdx = 0;
  spinTimer = setInterval(() => {
    process.stdout.write(`\r\x1b[90m${SPIN[spinIdx++ % SPIN.length]} ${msg}\x1b[0m`);
  }, 80);
}

function stopSpin() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
    process.stdout.write("\r\x1b[K");
  }
}

// ====== Rate Limit ======
const MIN_INTERVAL = 60000; // 60s between calls (Code Assist actual limit: ~1 RPM)
let lastApiCall = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function rateLimitWait() {
  const elapsed = Date.now() - lastApiCall;
  if (elapsed < MIN_INTERVAL) {
    const waitMs = MIN_INTERVAL - elapsed;
    if (waitMs > 3000) {
      process.stdout.write(`\x1b[90m  (cooldown ${Math.ceil(waitMs / 1000)}s...)\x1b[0m\n`);
    }
    await sleep(waitMs);
  }
  // Note: lastApiCall is set AFTER response completes (in callGemini),
  // so streaming time counts toward the cooldown
}

function parseRetryDelay(errText) {
  // Match "reset after 45s" format from Code Assist
  const resetMatch = errText.match(/reset after (\d+)s/i);
  if (resetMatch) return parseInt(resetMatch[1]);
  // Match "retry in 30s" format
  const retryMatch = errText.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (retryMatch) return Math.ceil(parseFloat(retryMatch[1]));
  try {
    const json = JSON.parse(errText);
    // Check message field for "reset after Xs"
    const msg = json.error?.message || "";
    const msgMatch = msg.match(/reset after (\d+)s/i);
    if (msgMatch) return parseInt(msgMatch[1]);
    for (const d of json.error?.details || []) {
      if (d.retryDelay) {
        const sec = parseInt(d.retryDelay);
        if (sec > 0) return sec;
      }
    }
  } catch {}
  return 60;
}

// ====== Gemini API ======
async function initProject() {
  if (authTokens.project_id) return;

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authTokens.access_token}`,
        ...CODE_ASSIST_HEADERS,
      },
      body: "{}",
    },
    15000
  );

  if (res.ok) {
    const data = await res.json();
    if (data.cloudaicompanionProject) {
      authTokens.project_id = data.cloudaicompanionProject;
      saveAuth(authTokens);
      process.stdout.write(`\x1b[90m  project: ${authTokens.project_id}\x1b[0m\n`);
    }
  }
}

async function callGeminiOAuthStream(contents, _retried) {
  const valid = await ensureValidToken();
  if (!valid) throw new Error("OAuth token invalid. Run /login to re-authenticate.");

  await initProject();

  const body = {
    project: authTokens.project_id || "",
    model: MODEL,
    user_prompt_id: randomBytes(16).toString("hex"),
    request: {
      contents,
      tools,
      systemInstruction: { parts: [{ text: getSystemPrompt() }] },
      generationConfig: { temperature: 0.2 },
    },
  };

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authTokens.access_token}`,
        Accept: "text/event-stream",
        ...CODE_ASSIST_HEADERS,
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
    throw new Error(`CodeAssist API ${res.status}: ${errText.substring(0, 500)}`);
  }

  // Parse SSE stream
  let fullText = "";
  const allParts = [];
  let streamingText = false;
  let pendingSignature = null; // Buffer for thoughtSignature arriving before functionCall

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        // Stream read error - use what we have so far
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
              // thoughtSignature alone in a separate chunk - buffer it
              pendingSignature = part.thoughtSignature;
            } else if (part.text && !part.thought) {
              if (!streamingText) {
                stopSpin();
                streamingText = true;
              }
              if (_sseRes) {
                sseWrite(_sseRes, { type: "text", content: part.text });
              } else {
                process.stdout.write(part.text);
              }
              fullText += part.text;
            } else if (part.functionCall) {
              // Merge buffered thoughtSignature if the part doesn't already have one
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
    // Fallback: if streaming fails entirely, try non-streaming
    if (allParts.length === 0 && !fullText) {
      throw new Error(`Stream failed: ${streamErr.message}`);
    }
  }

  if (streamingText && !_sseRes) process.stdout.write("\n");

  // Build final parts
  if (fullText) allParts.unshift({ text: fullText });

  if (allParts.length === 0) {
    return { role: "model", parts: [{ text: "[Empty response]" }] };
  }

  return { role: "model", parts: allParts };
}

async function callGeminiOAuthNonStream(contents, _retried) {
  const valid = await ensureValidToken();
  if (!valid) throw new Error("OAuth token invalid. Run /login to re-authenticate.");
  await initProject();

  const body = {
    project: authTokens.project_id || "",
    model: MODEL,
    user_prompt_id: randomBytes(16).toString("hex"),
    request: {
      contents,
      tools,
      systemInstruction: { parts: [{ text: getSystemPrompt() }] },
      generationConfig: { temperature: 0.2 },
    },
  };

  const res = await fetchWithTimeout(
    `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authTokens.access_token}`,
        ...CODE_ASSIST_HEADERS,
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
    throw new Error(`CodeAssist API ${res.status}: ${errText.substring(0, 500)}`);
  }

  const data = await res.json();
  const resp = data.response || data;
  if (resp.candidates?.[0]?.content) return resp.candidates[0].content;
  if (resp.candidates?.[0]?.finishReason === "SAFETY") {
    return { role: "model", parts: [{ text: "[Safety filter blocked this response]" }] };
  }
  throw new Error("Unexpected response: " + JSON.stringify(data).substring(0, 300));
}

async function callGeminiApiKey(contents) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY not set and OAuth not configured. Run /login");

  const body = {
    contents,
    tools,
    systemInstruction: { parts: [{ text: getSystemPrompt() }] },
    generationConfig: { temperature: 0.2 },
  };

  const res = await fetchWithTimeout(
    `${STANDARD_API_URL}/models/${MODEL}:generateContent?key=${API_KEY}`,
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
    throw new Error(`API ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  if (data.candidates?.[0]?.content) return data.candidates[0].content;
  if (data.candidates?.[0]?.finishReason === "SAFETY") {
    return { role: "model", parts: [{ text: "[Safety filter blocked this response]" }] };
  }
  throw new Error("Unexpected response: " + JSON.stringify(data).substring(0, 300));
}

function isNetworkError(e) {
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

function isRateLimitError(e) {
  return e?.status === 429 || (e?.message && e.message.includes("429"));
}

async function callGemini(contents, retries = 3) {
  // Auto-compact if payload too large
  if (estimateSize(contents) > MAX_PAYLOAD_BYTES) {
    compactHistory();
  }
  await rateLimitWait();

  try {
    let result;
    if (isOAuthEnabled()) {
      // Streaming: thoughtSignature is buffered and merged into functionCall parts
      result = await callGeminiOAuthStream(contents);
    } else {
      result = await callGeminiApiKey(contents);
    }
    lastApiCall = Date.now(); // Set AFTER response completes
    return result;
  } catch (e) {
    // Handle rate limit with retry
    if (isRateLimitError(e)) {
      const errText = typeof e.text === "string" ? e.text : e.message || "";
      if (retries > 0) {
        const waitSec = parseRetryDelay(errText) + 2;
        stopSpin();
        process.stdout.write(`\x1b[33m  ! rate limit. waiting ${waitSec}s...\x1b[0m\n`);
        startSpin(`retrying in ${waitSec}s...`);
        await sleep(waitSec * 1000);
        lastApiCall = Date.now();
        return callGemini(contents, retries - 1);
      }
      throw new Error(`Rate limit exceeded. しばらく待ってから再試行してください。`);
    }

    // Handle network errors with retry
    if (isNetworkError(e) && retries > 0) {
      const waitSec = 5;
      stopSpin();
      process.stdout.write(`\x1b[33m  ! network error: ${e.message}. retrying in ${waitSec}s...\x1b[0m\n`);
      startSpin(`retrying in ${waitSec}s...`);
      await sleep(waitSec * 1000);
      lastApiCall = Date.now();
      return callGemini(contents, retries - 1);
    }

    throw e;
  }
}

// ====== Format tool args ======
function fmtArgs(args) {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 60 ? `${k}:"${s.substring(0, 57)}..."` : `${k}:${s}`;
    })
    .join(" ");
}

// ====== Agent Turn ======
const MAX_USER_MSG_BYTES = 50000; // 50KB max per user message

async function agentTurn(userMessage) {
  // Truncate extremely large user input before adding to history
  if (userMessage.length > MAX_USER_MSG_BYTES) {
    const truncated = userMessage.substring(0, MAX_USER_MSG_BYTES);
    process.stdout.write(
      `\x1b[33m  ! input truncated: ${userMessage.length} -> ${MAX_USER_MSG_BYTES} bytes\x1b[0m\n`
    );
    userMessage = truncated + "\n\n...[truncated - input too large]";
  }
  history.push({ role: "user", parts: [{ text: userMessage }] });
  turnCount++;

  let loops = 0;
  while (loops < MAX_TOOL_LOOPS) {
    loops++;
    startSpin(loops === 1 ? "thinking..." : "continuing...");

    let response;
    try {
      response = await callGemini(history);
    } finally {
      stopSpin();
    }

    history.push(response);

    const parts = response.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length === 0) {
      return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    }

    // Execute tool calls
    const responses = [];
    for (const part of calls) {
      const { name, args } = part.functionCall;
      process.stdout.write(`\x1b[90m  > ${name}(${fmtArgs(args)})\x1b[0m\n`);
      const result = TOOL_MAP[name] ? TOOL_MAP[name](args || {}) : { error: `Unknown tool: ${name}` };
      if (result.success === false) {
        process.stdout.write(`\x1b[31m    x ${result.error || "failed"}\x1b[0m\n`);
      }
      responses.push({ functionResponse: { name, response: result } });
    }

    history.push({ role: "user", parts: responses });
  }
  return "[Tool loop limit reached]";
}

// ====== History Management ======
const MAX_PAYLOAD_BYTES = 200000; // 200KB max payload
const TOOL_RESULT_MAX = 30000;   // 30KB per tool result (enough for error logs)

function estimateSize(obj) {
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

function compactHistory() {
  let changed = false;

  // Phase 1: Truncate tool results AND large text in OLD messages (keep last 6 messages full)
  const keepFullCount = 6;
  const OLD_TEXT_MAX = 2000;
  for (let i = 0; i < Math.max(0, history.length - keepFullCount); i++) {
    const msg = history[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.functionResponse) {
        const before = estimateSize(part.functionResponse);
        if (before > 2000) {
          part.functionResponse.response = truncateStringsInObj(part.functionResponse.response, 500);
          changed = true;
        }
      }
      // Also truncate large text parts in old user/model messages
      if (part.text && !part.thought && part.text.length > OLD_TEXT_MAX) {
        part.text = part.text.substring(0, OLD_TEXT_MAX) + "\n...[compacted]";
        changed = true;
      }
    }
  }

  // Phase 2: If still too big, drop oldest messages (keep at least last 6)
  while (history.length > 6 && estimateSize(history) > MAX_PAYLOAD_BYTES) {
    history.shift();
    changed = true;
  }

  // Phase 3: Cap individual tool results and large text in ALL remaining messages
  const RECENT_TEXT_MAX = 30000;
  for (const msg of history) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.functionResponse) {
        const size = estimateSize(part.functionResponse);
        if (size > TOOL_RESULT_MAX) {
          part.functionResponse.response = truncateStringsInObj(part.functionResponse.response, TOOL_RESULT_MAX);
          changed = true;
        }
      }
      // Safety net: cap any single text part that's still too big
      if (part.text && !part.thought && part.text.length > RECENT_TEXT_MAX) {
        part.text = part.text.substring(0, RECENT_TEXT_MAX) + "\n...[truncated]";
        changed = true;
      }
    }
  }

  return changed;
}

// ====== Commands ======
function showHelp() {
  console.log(`\x1b[36m
Commands:
  /paste    複数行入力モード（/end で送信）
  /login    Googleアカウントで認証（1000回/日）
  /logout   認証情報を削除
  /status   認証状態を表示
  /clear    会話履歴をクリア
  /compact  履歴を圧縮（トークン節約）
  /history  履歴の状態を表示
  /model    現在のモデルを表示
  /help     このヘルプを表示
  Ctrl+C    終了

起動オプション:
  --web     Web UIモードで起動 (http://localhost:3456)
\x1b[0m`);
}

function showStatus() {
  if (isOAuthEnabled()) {
    const remaining = Math.max(0, Math.floor((authTokens.expires_at - Date.now()) / 60000));
    console.log(`\x1b[32mOAuth: Active\x1b[0m`);
    console.log(`\x1b[90mAccount: ${authTokens.email || "unknown"}`);
    console.log(`Token expires in: ${remaining} min`);
    console.log(`Endpoint: Code Assist (1000 RPD)\x1b[0m`);
  } else if (API_KEY) {
    console.log(`\x1b[33mAPI Key: Active\x1b[0m`);
    console.log(`\x1b[90mEndpoint: Standard API (20 RPD per model)\x1b[0m`);
    console.log(`\x1b[90m/login でOAuth認証すると1000回/日に増えます\x1b[0m`);
  } else {
    console.log(`\x1b[31mNot authenticated\x1b[0m`);
    console.log(`\x1b[90m/login でGoogleアカウント認証してください\x1b[0m`);
  }
}

// ====== Web UI ======
const WEB_PORT = parseInt(process.env.AGENT_WEB_PORT || "3456");
let webProcessing = false;

const WEB_HTML = `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Coding Agent</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;height:100dvh;display:flex;flex-direction:column}
#header{padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d;font-size:13px;color:#8b949e;display:flex;justify-content:space-between;align-items:center}
#header button{background:none;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
#header button:hover{border-color:#8b949e}
#chat{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:88%;padding:10px 14px;font-size:14px;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.msg.user{align-self:flex-end;background:#1f6feb;border-radius:12px 12px 2px 12px}
.msg.assistant{align-self:flex-start;background:#161b22;border:1px solid #30363d;border-radius:12px 12px 12px 2px}
.msg pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px;overflow-x:auto;font-size:13px;margin:6px 0;white-space:pre}
.msg code{background:#1c2128;padding:1px 5px;border-radius:3px;font-size:13px}
.tool{font-size:12px;color:#8b949e;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:5px 10px;align-self:flex-start;max-width:95%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool.err{border-color:#f85149;color:#f85149}
.thinking{color:#8b949e;font-style:italic;font-size:13px;align-self:flex-start}
#input-area{padding:10px 12px;background:#161b22;border-top:1px solid #30363d;display:flex;gap:8px;align-items:flex-end}
#msg{flex:1;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:10px 12px;font-size:15px;resize:none;min-height:48px;max-height:40vh;font-family:inherit;outline:none;line-height:1.4}
#msg:focus{border-color:#1f6feb}
#send{background:#238636;color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer;white-space:nowrap}
#send:hover{background:#2ea043}
#send:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
</style>
</head><body>
<div id="header">
  <span>Coding Agent &mdash; <span id="model">...</span></span>
  <button onclick="clearChat()">Clear</button>
</div>
<div id="chat"></div>
<div id="input-area">
  <textarea id="msg" placeholder="メッセージを入力... (Ctrl+Enter で送信)" rows="2"></textarea>
  <button id="send" onclick="sendMsg()">送信</button>
</div>
<script>
const chat=document.getElementById('chat'),msgEl=document.getElementById('msg'),sendBtn=document.getElementById('send');
let sending=false;
msgEl.addEventListener('input',()=>{msgEl.style.height='auto';msgEl.style.height=Math.min(msgEl.scrollHeight,window.innerHeight*0.4)+'px'});
msgEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendMsg()}});
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmt(t){
  t=t.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,(_,l,c)=>'<pre><code>'+esc(c.trim())+'</code></pre>');
  t=t.replace(/\`([^\`]+)\`/g,(_, c)=>'<code>'+esc(c)+'</code>');
  t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  return t;
}
function addEl(cls,html){const d=document.createElement('div');d.className=cls;d.innerHTML=html;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d}
function scroll(){chat.scrollTop=chat.scrollHeight}
async function clearChat(){
  await fetch('/api/clear',{method:'POST'});
  chat.innerHTML='';
}
async function sendMsg(){
  if(sending)return;
  const text=msgEl.value;
  if(!text.trim())return;
  sending=true;sendBtn.disabled=true;
  msgEl.value='';msgEl.style.height='auto';
  addEl('msg user',esc(text));
  const aDiv=addEl('msg assistant','<span class="thinking">thinking...</span>');
  let full='';
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})});
    const reader=res.body.getReader();
    const dec=new TextDecoder();
    let buf='';
    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\\n');buf=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const j=line.slice(6);if(j==='[DONE]')continue;
        try{
          const e=JSON.parse(j);
          if(e.type==='text'){full+=e.content;aDiv.innerHTML=fmt(full);scroll()}
          else if(e.type==='tool'){addEl('tool','&#9654; '+esc(e.name)+'('+esc(e.summary||'')+')')}
          else if(e.type==='tool_error'){addEl('tool err','&#10007; '+esc(e.name)+': '+esc(e.error))}
          else if(e.type==='error'){aDiv.innerHTML='<span style="color:#f85149">'+esc(e.content)+'</span>'}
        }catch{}
      }
    }
    if(!full&&aDiv.querySelector('.thinking'))aDiv.innerHTML='<span style="color:#8b949e">[empty]</span>';
  }catch(e){aDiv.innerHTML='<span style="color:#f85149">Error: '+esc(e.message)+'</span>'}
  sending=false;sendBtn.disabled=false;msgEl.focus();
}
fetch('/api/status').then(r=>r.json()).then(d=>{document.getElementById('model').textContent=d.model}).catch(()=>{});
</script>
</body></html>`;

async function handleWebChat(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let message;
  try { message = JSON.parse(body).message; } catch {
    res.writeHead(400); res.end("Bad request"); return;
  }
  if (!message?.trim()) { res.writeHead(400); res.end("Empty"); return; }

  if (webProcessing) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Already processing" }));
    return;
  }
  webProcessing = true;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  _sseRes = res;

  try {
    // Truncate oversized input
    if (message.length > MAX_USER_MSG_BYTES) {
      message = message.substring(0, MAX_USER_MSG_BYTES) + "\n\n...[truncated]";
      sseWrite(res, { type: "status", content: "Input truncated" });
    }

    history.push({ role: "user", parts: [{ text: message }] });
    turnCount++;

    let loops = 0;
    while (loops < MAX_TOOL_LOOPS) {
      loops++;

      let response;
      try {
        response = await callGemini(history);
      } catch (e) {
        sseWrite(res, { type: "error", content: e.message });
        break;
      }

      history.push(response);

      const parts = response.parts || [];
      const calls = parts.filter((p) => p.functionCall);

      // Send text via SSE (all modes are non-streaming now)
      const textParts = parts.filter((p) => p.text && !p.thought);
      if (textParts.length > 0) {
        sseWrite(res, { type: "text", content: textParts.map((p) => p.text).join("") });
      }

      if (calls.length === 0) break;

      // Execute tools
      const responses = [];
      for (const part of calls) {
        const { name, args } = part.functionCall;
        const summary = fmtArgs(args);
        sseWrite(res, { type: "tool", name, summary });

        const result = TOOL_MAP[name] ? TOOL_MAP[name](args || {}) : { error: `Unknown tool: ${name}` };
        if (result.success === false) {
          sseWrite(res, { type: "tool_error", name, error: result.error || "failed" });
        }
        responses.push({ functionResponse: { name, response: result } });
      }

      history.push({ role: "user", parts: responses });
    }

    compactHistory();
  } catch (e) {
    sseWrite(res, { type: "error", content: e.message });
  } finally {
    _sseRes = null;
    webProcessing = false;
  }

  sseWrite(res, { type: "done" });
  res.end();
}

function startWebServer() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WEB_HTML);
      return;
    }

    if (req.method === "GET" && req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: MODEL, cwd: CWD, auth: isOAuthEnabled() ? "oauth" : API_KEY ? "api_key" : "none" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/clear") {
      history = []; turnCount = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      await handleWebChat(req, res);
      return;
    }

    res.writeHead(404); res.end("Not found");
  });

  server.listen(WEB_PORT, () => {
    console.log(`\x1b[36mCoding Agent v0.2 (Web)\x1b[0m`);
    console.log(`\x1b[90mModel: ${MODEL} | Dir: ${CWD}\x1b[0m`);
    if (isOAuthEnabled()) console.log(`\x1b[32mOAuth: ${authTokens.email || "authenticated"}\x1b[0m`);
    console.log(`\x1b[32m\nWeb UI: http://localhost:${WEB_PORT}\x1b[0m`);
    console.log(`\x1b[90mCtrl+C で終了\x1b[0m\n`);
    try { execSync(`termux-open-url "http://localhost:${WEB_PORT}"`, { stdio: "ignore", timeout: 3000 }); } catch {}
  });
}

// ====== Main ======
async function main() {
  if (process.argv.includes("--web")) {
    startWebServer();
    return;
  }

  console.log(`\x1b[36mCoding Agent v0.2\x1b[0m`);
  console.log(`\x1b[90mModel: ${MODEL} | Dir: ${CWD}\x1b[0m`);

  if (isOAuthEnabled()) {
    console.log(`\x1b[32mOAuth: ${authTokens.email || "authenticated"}\x1b[0m`);
  } else if (API_KEY) {
    console.log(`\x1b[33mAPI Key mode (制限あり). /login でOAuth認証推奨\x1b[0m`);
  } else {
    console.log(`\x1b[31m認証なし. /login でGoogleアカウント認証してください\x1b[0m`);
  }

  console.log(`\x1b[90m/help でコマンド一覧\x1b[0m\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[32m> \x1b[0m",
  });

  let processing = false;

  rl.prompt();

  rl.on("line", async (line) => {
    if (processing) return;

    // Paste mode
    if (pasteMode) {
      if (line.trim() === "/end") {
        pasteMode = false;
        const input = pasteBuffer.join("\n");
        pasteBuffer = [];
        if (!input.trim()) { rl.prompt(); return; }
        processing = true;
        try {
          const res = await agentTurn(input);
          if (res) console.log(`\n${res}\n`);
          compactHistory();
        } catch (e) {
          console.error(`\x1b[31mError: ${e.message}\x1b[0m\n`);
        }
        processing = false;
        rl.prompt();
      } else {
        pasteBuffer.push(line);
      }
      return;
    }

    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Commands
    if (input === "/login") {
      processing = true;
      try { await startOAuthLogin(); } catch (e) {
        console.error(`\x1b[31mLogin failed: ${e.message}\x1b[0m\n`);
      }
      processing = false;
      rl.prompt();
      return;
    }
    if (input === "/logout") {
      authTokens = null;
      try { writeFileSync(AUTH_FILE, "{}", "utf-8"); } catch {}
      console.log("\x1b[90mLogged out.\x1b[0m");
      rl.prompt(); return;
    }
    if (input === "/status") { showStatus(); rl.prompt(); return; }
    if (input === "/clear") { history = []; turnCount = 0; console.log("\x1b[90mCleared.\x1b[0m"); rl.prompt(); return; }
    if (input === "/compact") {
      if (compactHistory()) console.log(`\x1b[90mCompacted. ${history.length} msgs.\x1b[0m`);
      else console.log(`\x1b[90mAlready small (${history.length} msgs).\x1b[0m`);
      rl.prompt(); return;
    }
    if (input === "/history") {
      const tc = history.filter((m) => m.parts?.some((p) => p.functionCall)).length;
      console.log(`\x1b[90mMessages: ${history.length} | Tool calls: ${tc} | Turns: ${turnCount}\x1b[0m`);
      rl.prompt(); return;
    }
    if (input === "/paste") { pasteMode = true; pasteBuffer = []; console.log("\x1b[90mPaste mode. /end で送信。\x1b[0m"); return; }
    if (input === "/model") { console.log(`\x1b[90m${MODEL}\x1b[0m`); rl.prompt(); return; }
    if (input === "/help") { showHelp(); rl.prompt(); return; }

    // Agent turn
    processing = true;
    try {
      const res = await agentTurn(input);
      if (res) console.log(`\n${res}\n`);
      else console.log("");
      compactHistory();
    } catch (e) {
      console.error(`\x1b[31mError: ${e.message}\x1b[0m\n`);
    }
    processing = false;
    rl.prompt();
  });

  rl.on("close", () => {
    stopSpin();
    console.log("\n\x1b[90mBye.\x1b[0m");
    process.exit(0);
  });
}

main();
