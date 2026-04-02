#!/usr/bin/env node
// Test suite for frog-pkg fallback chain behavior
// Run: node test-frog-fixes.mjs

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    failed++;
  }
}

// ============================================================
// Extract logic from frog-pkg/src/ for unit testing
// ============================================================

const THINKING_MODELS = /^gemini-(2\.5|3[.-])/;

function isThoughtSignatureError(e) {
  return (e?.status === 400 && e?.message?.includes("thought_signature")) ||
    (e?.message && e.message.includes("thought_signature"));
}

function isModelNotFoundError(e) {
  return e?.status === 404 || (e?.message && /404.*[Nn]ot [Ff]ound/.test(e.message));
}

// Matches the FIXED stripThoughtSignatures (with convertTools support)
function stripThoughtSignatures(history, force, forceAuth, MODEL, convertTools = false) {
  if (!force && (forceAuth === "oauth" || THINKING_MODELS.test(MODEL))) return;
  for (const msg of history) {
    if (!msg.parts) continue;
    for (let i = 0; i < msg.parts.length; i++) {
      const part = msg.parts[i];
      if (!force && part.functionCall) continue; // same-model: preserve functionCall sigs

      // Cross-auth switch: convert functionCall to text to avoid signature catch-22
      if (convertTools && part.functionCall) {
        const fc = part.functionCall;
        const argStr = fc.args ? JSON.stringify(fc.args) : "{}";
        const summary = argStr.length > 200 ? argStr.substring(0, 200) + "..." : argStr;
        msg.parts[i] = { text: `[Tool call: ${fc.name}(${summary})]` };
        continue;
      }
      if (convertTools && part.functionResponse) {
        const fr = part.functionResponse;
        const resStr = fr.response ? JSON.stringify(fr.response) : "";
        const summary = resStr.length > 500 ? resStr.substring(0, 500) + "..." : resStr;
        msg.parts[i] = { text: `[Tool result: ${fr.name}: ${summary}]` };
        continue;
      }

      if (part.thought) { delete part.thought; }
      if (part.thoughtSignature) { delete part.thoughtSignature; }
    }
    msg.parts = msg.parts.filter((p) => p.text || p.functionCall || p.functionResponse || p.thoughtSignature);
  }
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].parts && history[i].parts.length === 0) {
      history.splice(i, 1);
    }
  }
}

// Matches the FIXED callGeminiApiKey error construction
function makeApiKeyError(status, errText) {
  if (status === 429) return { status: 429, text: errText };
  const err = new Error(`API ${status}: ${errText.substring(0, 500)}`);
  if (status === 404) { err.status = 404; }
  if (status === 400 && errText.includes("thought_signature")) { err.status = 400; }
  return err;
}

// ============================================================
// Tests
// ============================================================

console.log("\n\x1b[1m=== isThoughtSignatureError ===\x1b[0m\n");

assert(
  isThoughtSignatureError({ status: 400, message: "400: thought_signature invalid" }),
  "400 + thought_signature → true"
);
assert(
  !isThoughtSignatureError({ status: 400, message: "400: INVALID_ARGUMENT: bad request" }),
  "400 without thought_signature → false"
);
assert(
  isThoughtSignatureError({ message: "API 400: thought_signature mismatch" }),
  "no .status but message has thought_signature → true"
);
assert(!isThoughtSignatureError({ status: 429, message: "Rate limit" }), "429 → false");
assert(!isThoughtSignatureError(null), "null → false");

console.log("\n\x1b[1m=== callGeminiApiKey error handling ===\x1b[0m\n");

{
  const err = makeApiKeyError(404, "Model not found");
  assert(err.status === 404, "404 → .status = 404");
  assert(isModelNotFoundError(err), "404 → isModelNotFoundError true");
}
{
  const err = makeApiKeyError(404, '{"error":{"code":404,"message":"resource unavailable"}}');
  assert(err.status === 404, "404 unusual message → .status = 404 (no longer relying on regex)");
  assert(isModelNotFoundError(err), "404 unusual message → detected via .status");
}
{
  const err = makeApiKeyError(400, "thought_signature invalid");
  assert(err.status === 400, "400 thought_signature → .status = 400");
  assert(isThoughtSignatureError(err), "400 thought_signature → detected");
}
{
  const err = makeApiKeyError(400, "INVALID_ARGUMENT: content too large");
  assert(err.status === undefined, "400 generic → .status NOT set");
  assert(!isThoughtSignatureError(err), "400 generic → NOT thought_signature");
}

console.log("\n\x1b[1m=== stripThoughtSignatures: force=true (model switch) ===\x1b[0m\n");

{
  const history = [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [
      { thought: true, text: "thinking...", thoughtSignature: "flash_sig_001" },
      { text: "answer" },
      { functionCall: { name: "readFile", args: { path: "x.js" } }, thoughtSignature: "flash_sig_002" },
    ]},
  ];
  stripThoughtSignatures(history, true, "oauth", "gemini-3-pro-preview");
  const modelParts = history[1].parts;

  assert(!modelParts[0].thought, "thought flag removed");
  assert(!modelParts[0].thoughtSignature, "thought sig removed");
  assert(modelParts[1].text === "answer", "text preserved");

  const fcPart = modelParts.find(p => p.functionCall);
  assert(fcPart !== undefined, "functionCall part preserved");
  assert(!fcPart.thoughtSignature, "functionCall sig STRIPPED (foreign model's sig)");
}

{
  // Signature-only part (no text, no functionCall) → removed entirely
  const history = [
    { role: "model", parts: [
      { thoughtSignature: "orphan_sig" },
      { text: "answer" },
    ]},
  ];
  stripThoughtSignatures(history, true, "oauth", "gemini-3-flash-preview");
  assert(history[0].parts.length === 1, "orphan signature part removed");
  assert(history[0].parts[0].text === "answer", "text kept");
}

{
  // Empty message after stripping → removed
  const history = [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ thoughtSignature: "only_sig" }] },
    { role: "user", parts: [{ text: "next" }] },
  ];
  stripThoughtSignatures(history, true, "apikey", "gemini-2.5-flash");
  assert(history.length === 2, "empty message removed");
  assert(history[0].parts[0].text === "hi", "first user msg kept");
  assert(history[1].parts[0].text === "next", "second user msg kept");
}

console.log("\n\x1b[1m=== stripThoughtSignatures: force=false (same-model retry) ===\x1b[0m\n");

{
  const history = [
    { role: "model", parts: [
      { thought: true, text: "thinking", thoughtSignature: "sig001" },
      { text: "answer" },
      { functionCall: { name: "ls", args: {} }, thoughtSignature: "sig002" },
    ]},
  ];
  stripThoughtSignatures(history, false, "oauth", "gemini-3-flash-preview");
  assert(history[0].parts[0].thought === true, "OAuth same-model: skip entirely (sigs valid)");
  assert(history[0].parts[2].thoughtSignature === "sig002", "OAuth same-model: functionCall sig kept");
}

{
  // Non-thinking model + apikey → strip thoughts but keep functionCall sigs
  const history = [
    { role: "model", parts: [
      { thought: true, text: "thinking", thoughtSignature: "sig001" },
      { functionCall: { name: "ls", args: {} }, thoughtSignature: "sig002" },
    ]},
  ];
  stripThoughtSignatures(history, false, "apikey", "some-legacy-model");
  assert(!history[0].parts[0].thought, "non-thinking apikey: thought stripped");
  assert(history[0].parts[1].thoughtSignature === "sig002", "non-thinking apikey: functionCall sig preserved (same model)");
}

console.log("\n\x1b[1m=== Integration: OAuth→OAuth model switch ===\x1b[0m\n");

{
  const history = [
    { role: "user", parts: [{ text: "write code" }] },
    { role: "model", parts: [
      { thought: true, text: "Let me think...", thoughtSignature: "flash_001" },
      { text: "Here:" },
      { functionCall: { name: "writeFile", args: { path: "a.js", content: "..." } }, thoughtSignature: "flash_002" },
    ]},
    { role: "user", parts: [
      { functionResponse: { name: "writeFile", response: { success: true } } },
    ]},
    { role: "model", parts: [
      { thought: true, text: "done", thoughtSignature: "flash_003" },
      { text: "Created a.js" },
    ]},
  ];

  // prepareModelSwitch → stripThoughtSignatures(true)
  stripThoughtSignatures(history, true, "oauth", "gemini-3-pro-preview");

  let sigCount = 0;
  for (const msg of history) {
    for (const part of msg.parts || []) {
      if (part.thoughtSignature) sigCount++;
    }
  }
  assert(sigCount === 0, "ALL signatures removed (including functionCall)");
  assert(history.length === 4, "all messages preserved");

  const fc = history[1].parts.find(p => p.functionCall);
  assert(fc && fc.functionCall.name === "writeFile", "functionCall data intact");
  assert(!fc.thoughtSignature, "functionCall sig gone → no 400 on new model");
}

console.log("\n\x1b[1m=== Integration: OAuth→APIkey model switch (no convertTools) ===\x1b[0m\n");

{
  const history = [
    { role: "user", parts: [{ text: "help" }] },
    { role: "model", parts: [
      { thought: true, text: "thinking", thoughtSignature: "oauth_sig" },
      { text: "done" },
      { functionCall: { name: "ls", args: {} }, thoughtSignature: "oauth_fc_sig" },
    ]},
    { role: "user", parts: [
      { functionResponse: { name: "ls", response: { files: ["a.js"] } } },
    ]},
  ];

  // force=true but convertTools=false (same auth type switch)
  stripThoughtSignatures(history, true, "apikey", "gemini-2.5-flash", false);

  const fc = history[1].parts.find(p => p.functionCall);
  assert(!fc.thoughtSignature, "OAuth→APIkey: functionCall sig stripped");
  assert(fc.functionCall.name === "ls", "functionCall data intact");
}

console.log("\n\x1b[1m=== Integration: OAuth→APIkey with convertTools (cross-auth) ===\x1b[0m\n");

{
  const history = [
    { role: "user", parts: [{ text: "help" }] },
    { role: "model", parts: [
      { thought: true, text: "thinking", thoughtSignature: "oauth_sig" },
      { text: "done" },
      { functionCall: { name: "list_directory", args: { path: "src" } }, thoughtSignature: "oauth_fc_sig" },
    ]},
    { role: "user", parts: [
      { functionResponse: { name: "list_directory", response: { files: ["a.js", "b.js"] } } },
    ]},
  ];

  // convertTools=true: functionCall/functionResponse become text summaries
  stripThoughtSignatures(history, true, "apikey", "gemini-3-flash-preview", true);

  // No functionCall parts should remain
  const allParts = history.flatMap(m => m.parts || []);
  assert(!allParts.some(p => p.functionCall), "convertTools: no functionCall parts remain");
  assert(!allParts.some(p => p.functionResponse), "convertTools: no functionResponse parts remain");

  // Should have text summaries instead
  const toolCallText = allParts.find(p => p.text?.includes("[Tool call:"));
  assert(toolCallText, "convertTools: functionCall converted to text summary");
  assert(toolCallText.text.includes("list_directory"), "convertTools: tool name preserved in summary");

  const toolResultText = allParts.find(p => p.text?.includes("[Tool result:"));
  assert(toolResultText, "convertTools: functionResponse converted to text summary");

  // Thought/signature should also be stripped
  assert(!allParts.some(p => p.thought), "convertTools: thoughts also stripped");
  assert(!allParts.some(p => p.thoughtSignature), "convertTools: signatures also stripped");
}

console.log("\n\x1b[1m=== Integration: OAuth→OAuth (same auth, no convertTools) ===\x1b[0m\n");

{
  const history = [
    { role: "user", parts: [{ text: "help" }] },
    { role: "model", parts: [
      { functionCall: { name: "read_file", args: { path: "x.js" } }, thoughtSignature: "sig1" },
    ]},
    { role: "user", parts: [
      { functionResponse: { name: "read_file", response: { content: "hello" } } },
    ]},
  ];

  // Same auth (oauth→oauth), just model switch: should NOT convert tools
  stripThoughtSignatures(history, true, "oauth", "gemini-3-pro-preview", false);

  const fc = history[1].parts.find(p => p.functionCall);
  assert(fc, "OAuth→OAuth: functionCall preserved (same auth, no convert)");
  assert(!fc.thoughtSignature, "OAuth→OAuth: signature stripped");
  assert(fc.functionCall.name === "read_file", "OAuth→OAuth: functionCall data intact");
}

// ============================================================
// Summary
// ============================================================

console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
