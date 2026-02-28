import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// Load auth
const AUTH_FILE = join(homedir(), ".ai-coder", "auth.json");
const authTokens = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));

const MODEL = process.env.AGENT_MODEL || "gemini-2.5-flash";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_HEADERS = {
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

const tools = [{
  functionDeclarations: [{
    name: "list_directory",
    description: "List files and directories.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Directory path" },
      },
    },
  }],
}];

const systemPrompt = `You are a coding agent. Current directory: ${process.cwd()}. Be concise.`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAPI(contents) {
  const body = {
    project: authTokens.project_id || "",
    model: MODEL,
    user_prompt_id: randomBytes(16).toString("hex"),
    request: {
      contents,
      tools,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.2 },
    },
  };

  const res = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authTokens.access_token}`,
      ...CODE_ASSIST_HEADERS,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.response?.candidates?.[0]?.content;
}

async function test() {
  const history = [
    { role: "user", parts: [{ text: "List files in /data/data/com.termux/files/home/tmp" }] },
  ];

  // Call 1
  console.log("=== Call 1: asking to list files ===");
  const t1 = Date.now();
  const resp1 = await callAPI(history);
  console.log(`  Took: ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  if (!resp1) { console.log("No response"); return; }

  history.push(resp1);

  // Check for function calls
  const fc = resp1.parts.find(p => p.functionCall);
  if (!fc) {
    const text = resp1.parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
    console.log("  Text response:", text.substring(0, 200));
    console.log("  (No function call - done)");
    return;
  }

  console.log(`  Function call: ${fc.functionCall.name}(${JSON.stringify(fc.functionCall.args)})`);

  // Execute tool
  const entries = readdirSync(fc.functionCall.args?.path || "/tmp").slice(0, 10);
  console.log(`  Tool result: ${entries.length} entries`);

  // Add tool response
  history.push({
    role: "user",
    parts: [{ functionResponse: { name: fc.functionCall.name, response: { success: true, entries } } }],
  });

  // Wait for cooldown
  const elapsed = Date.now() - t1;
  const wait = Math.max(0, 62000 - elapsed);
  console.log(`\n  Waiting ${(wait / 1000).toFixed(0)}s for cooldown...`);
  await sleep(wait);

  // Call 2
  console.log("\n=== Call 2: sending tool result ===");
  const t2 = Date.now();
  const resp2 = await callAPI(history);
  console.log(`  Took: ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  if (!resp2) { console.log("No response"); return; }

  const text = resp2.parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
  console.log("  Response:", text.substring(0, 500));
  console.log("\n=== SUCCESS ===");
}

test().catch(e => console.error("FAILED:", e.message));
