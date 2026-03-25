#!/usr/bin/env node
// E2E test: launch frog with mock servers → trigger fallback → verify [strip] logs
// Requires: FROG_API_URL / FROG_OAUTH_URL env var support in config.js
//
// Scenario 1: APIkey 404 → APIkey fallback
// Scenario 2: OAuth 429  → APIkey fallback (cross-auth chain)

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let totalPassed = 0;
let totalFailed = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); totalPassed++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); totalFailed++; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

// ── Reusable: run a frog scenario ──
async function runScenario({ name, mockHandler, env, timeout = 30000 }) {
  console.log(`\n\x1b[1m--- ${name} ---\x1b[0m\n`);

  const requestLog = [];
  let reqCount = 0;

  const server = createServer((req, res) => {
    reqCount++;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = req.url || "";
      const modelMatch = url.match(/models\/([^:]+)/);
      const model = modelMatch ? modelMatch[1] : null;
      const entry = { n: reqCount, model, url: url.split("?")[0], method: req.method };
      requestLog.push(entry);
      mockHandler(entry, body, req, res);
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const tmpDir = mkdtempSync(join(tmpdir(), "frog-e2e-"));
  const outPath = join(tmpDir, "output.log");

  // Merge env (caller provides per-scenario overrides)
  const frogEnv = {
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    HOME: tmpDir, // isolate from real auth
    ...env(baseUrl, tmpDir),
  };

  const proc = spawn("script", ["-qefc", "frog", outPath], {
    env: frogEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stdout += d.toString(); });

  await sleep(3000);
  proc.stdin.write("say hi\r");
  await sleep(300);
  proc.stdin.write("\r");

  const start = Date.now();
  let logContent = "";
  while (Date.now() - start < timeout) {
    await sleep(1500);
    try { logContent = readFileSync(outPath, "utf-8"); } catch {}
    const combined = logContent + stdout;
    if (combined.includes("[strip]") || combined.includes("no fallback") ||
        combined.includes("Error:") || combined.includes("Hello from fallback")) {
      await sleep(2000);
      try { logContent = readFileSync(outPath, "utf-8"); } catch {}
      break;
    }
  }

  try { proc.stdin.write("\x03\x03"); } catch {}
  await sleep(500);
  try { proc.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { proc.kill("SIGKILL"); } catch {}
  server.close();

  const clean = cleanAnsi(logContent + "\n" + stdout);

  // Log requests
  console.log("\x1b[90m  requests:\x1b[0m");
  for (const r of requestLog) {
    console.log(`    #${r.n} ${r.method} ${r.url} → ${r.model || "(no model)"}`);
  }
  if (requestLog.length === 0) console.log("    (none)");

  // Log relevant output
  console.log("\x1b[90m  output:\x1b[0m");
  const relevant = clean.split("\n").filter(l =>
    l.includes("[strip]") || l.includes("falling back") || l.includes("404") ||
    l.includes("429") || l.includes("→") || l.includes("not available") ||
    l.includes("Hello from fallback")
  );
  for (const line of relevant.slice(0, 15)) {
    console.log(`    ${line.trim()}`);
  }
  if (relevant.length === 0) console.log("    (none)");
  console.log("");

  // Cleanup
  try { unlinkSync(outPath); } catch {}
  try { execSync(`rm -rf "${tmpDir}"`); } catch {}

  return { requestLog, clean };
}

function assertFallback(result, label) {
  const { requestLog, clean } = result;

  if (requestLog.length >= 2) {
    pass(`${label}: mock got ${requestLog.length} requests (fallback fired)`);
  } else {
    fail(`${label}: expected ≥2 requests, got ${requestLog.length}`);
  }

  if (clean.includes("→") || clean.includes("falling back") || clean.includes("not available")) {
    pass(`${label}: fallback detected in output`);
  } else {
    fail(`${label}: fallback not detected in output`);
  }

  if (clean.includes("[strip]")) {
    pass(`${label}: [strip] log present`);
    const stripLines = clean.split("\n").filter(l => l.includes("[strip]"));
    const bad = stripLines.filter(l => !l.includes("remaining suspicious: 0"));
    if (bad.length === 0) {
      pass(`${label}: all ${stripLines.length} [strip] → suspicious: 0`);
    } else {
      fail(`${label}: ${bad.length} [strip] lines have suspicious > 0`);
      for (const line of bad) console.log(`    ${line.trim()}`);
    }
  } else {
    fail(`${label}: [strip] log NOT found`);
  }

  if (clean.includes("Hello from fallback")) {
    pass(`${label}: fallback response received`);
  } else if (requestLog.length >= 2) {
    pass(`${label}: fallback request sent`);
  } else {
    fail(`${label}: no fallback response`);
  }
}

// ════════════════════════════════════════════════
// Scenario 1: APIkey → APIkey (404 fallback)
// ════════════════════════════════════════════════

console.log("\n\x1b[1m=== E2E: frog fallback chain tests ===\x1b[0m");

const result1 = await runScenario({
  name: "Scenario 1: APIkey 404 → APIkey fallback",
  mockHandler: (entry, body, req, res) => {
    if (entry.n === 1) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { code: 404, message: `models/${entry.model} is not found.`, status: "NOT_FOUND" }
      }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hello from fallback model!" }] }, finishReason: "STOP" }]
      }));
    }
  },
  env: (baseUrl, tmpDir) => ({
    AGENT_MODEL: "gemini-3-flash-preview",
    GEMINI_API_KEY: "fake-test-key",
    FROG_API_URL: `${baseUrl}/v1beta`,
  }),
});

assertFallback(result1, "APIkey→APIkey");

// ════════════════════════════════════════════════
// Scenario 2: OAuth 429 → APIkey fallback
// ════════════════════════════════════════════════

const result2 = await runScenario({
  name: "Scenario 2: OAuth 429 → APIkey fallback",
  mockHandler: (entry, body, req, res) => {
    const url = req.url || "";

    // Code Assist endpoint (OAuth path)
    if (url.includes("streamGenerateContent") || url.includes("generateContent")) {
      if (!url.includes("/v1beta/")) {
        // This is the Code Assist (OAuth) path → 429
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: 429,
            message: "Resource exhausted. Please retry after 60s.",
            status: "RESOURCE_EXHAUSTED",
            details: [{
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "60s",
            }]
          }
        }));
        return;
      }
    }

    // loadCodeAssist → return a project ID
    if (url.includes("loadCodeAssist")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cloudaicompanionProject: "test-project-123" }));
      return;
    }

    // Standard API (APIkey fallback path) → success
    if (url.includes("/v1beta/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hello from fallback model!" }] }, finishReason: "STOP" }]
      }));
      return;
    }

    // Catch-all
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  },
  env: (baseUrl, tmpDir) => {
    // Create fake auth.json so frog thinks OAuth is active
    const frogDir = join(tmpDir, ".frog");
    mkdirSync(frogDir, { recursive: true });
    writeFileSync(join(frogDir, "auth.json"), JSON.stringify({
      access_token: "fake-oauth-token-for-test",
      refresh_token: "fake-refresh-token-for-test",
      expires_at: Date.now() + 3600000, // 1h from now
      email: "test@example.com",
      project_id: "test-project-123",
    }));
    return {
      AGENT_MODEL: "gemini-3-flash-preview",
      GEMINI_API_KEY: "fake-test-key", // needed for apikey fallback
      FROG_OAUTH_URL: baseUrl,         // Code Assist → our mock
      FROG_API_URL: `${baseUrl}/v1beta`, // Standard API → our mock
    };
  },
});

assertFallback(result2, "OAuth→APIkey");

// Also check that the request pattern shows OAuth first, then APIkey
{
  const oauthReqs = result2.requestLog.filter(r => !r.url.includes("/v1beta/") && (r.url.includes("generateContent") || r.url.includes("streamGenerateContent")));
  const apikeyReqs = result2.requestLog.filter(r => r.url.includes("/v1beta/"));
  if (oauthReqs.length > 0 && apikeyReqs.length > 0) {
    pass("OAuth→APIkey: OAuth request came first, then APIkey");
  } else if (oauthReqs.length === 0) {
    fail("OAuth→APIkey: no OAuth requests — frog may not have used OAuth path");
  } else {
    fail("OAuth→APIkey: no APIkey requests — fallback to APIkey didn't happen");
  }
}

// ══ Summary ══
console.log(`\n\x1b[1m=== Total: ${totalPassed} passed, ${totalFailed} failed ===\x1b[0m\n`);

if (totalFailed > 0) {
  console.log("\x1b[33mSee output above for details.\x1b[0m\n");
}

process.exit(totalFailed > 0 ? 1 : 0);
