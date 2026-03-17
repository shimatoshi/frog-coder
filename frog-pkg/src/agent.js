import { randomBytes } from "node:crypto";
import state from "./state.js";
import {
  CODE_ASSIST_ENDPOINT, getCodeAssistHeaders, getSessionId, MAX_TOOL_LOOPS,
} from "./config.js";
import { ensureValidToken, isOAuthEnabled } from "./auth.js";
import { fetchWithTimeout, sleep, rateLimitWait } from "./net.js";
import { parseRetryDelay } from "./fallback.js";
import { callGemini, stripThoughtSignatures, compactHistory, estimateSize, MAX_PAYLOAD_BYTES, initProject } from "./api.js";
import { tools, TOOL_MAP, SUB_AGENT_TOOLS, SUB_AGENT_TOOL_MAP } from "./tools.js";
import { runHooks } from "./hooks.js";
import { startSpin, stopSpin, titleThinking, titleToolCall, fmtArgs } from "./ui.js";

// ====== Sub-Agent ======
const SUB_AGENT_MAX_LOOPS = 15;

export async function toolSpawnAgent({ task }) {
  process.stdout.write(`\x1b[36m    🔍 sub-agent: ${task.substring(0, 80)}\x1b[0m\n`);

  const subSystemPrompt = `You are a research sub-agent. Your job is to investigate and report findings.
Current working directory: ${state.CWD}

Rules:
- You can ONLY read files, search, list directories, and run read-only commands.
- You CANNOT write, edit, or create files.
- Be efficient. Use search_text to find what you need, not list_directory browsing.
- When done, provide a concise summary of your findings.
- Use absolute paths.`;

  const subHistory = [{ role: "user", parts: [{ text: task }] }];
  let loops = 0;

  while (loops < SUB_AGENT_MAX_LOOPS) {
    if (state.aborted) return { success: false, error: "Aborted by user" };
    loops++;

    let response;
    try {
      await rateLimitWait();

      {
        const valid = await ensureValidToken();
        if (!valid) return { success: false, error: "OAuth token invalid" };
        await initProject();

        const body = {
          project: state.authTokens.project_id || "",
          model: state.MODEL,
          user_prompt_id: randomBytes(16).toString("hex"),
          request: {
            contents: subHistory,
            tools: SUB_AGENT_TOOLS,
            systemInstruction: { parts: [{ text: subSystemPrompt }] },
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
          if (res.status === 429) {
            const serverDelay = parseRetryDelay(errText);
            const waitMs = serverDelay > 0 ? serverDelay * 1000 : 5000;
            process.stdout.write(`\x1b[90m    sub-agent 429, waiting ${Math.ceil(waitMs / 1000)}s...\x1b[0m\n`);
            await sleep(waitMs);
            continue;
          }
          return { success: false, error: `API ${res.status}: ${errText.substring(0, 200)}` };
        }

        const data = await res.json();
        response = data.candidates?.[0]?.content;
      }

      if (!response) return { success: false, error: "Empty response from sub-agent" };
      state.lastApiCall = Date.now();
    } catch (e) {
      return { success: false, error: `Sub-agent error: ${e.message}` };
    }

    subHistory.push(response);
    const parts = response.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length === 0) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join("");
      process.stdout.write(`\x1b[36m    🔍 sub-agent done (${loops} loops)\x1b[0m\n`);
      return { success: true, result: text || "[No findings]" };
    }

    const responses = [];
    for (const part of calls) {
      if (state.aborted) break;
      const { name, args } = part.functionCall;
      process.stdout.write(`\x1b[90m    · ${name}(${fmtArgs(args)})\x1b[0m\n`);

      const result = SUB_AGENT_TOOL_MAP[name]
        ? await SUB_AGENT_TOOL_MAP[name](args || {})
        : { error: `Unknown tool: ${name}` };

      responses.push({ functionResponse: { name, response: result } });
    }

    subHistory.push({ role: "user", parts: responses });
  }

  return { success: true, result: "[Sub-agent reached loop limit. Partial results may be in context.]" };
}

// ====== Abort Cleanup ======
export function cleanupHistoryAfterAbort() {
  while (state.history.length > 0) {
    const last = state.history[state.history.length - 1];
    if (last.role === "model" && last.parts?.some((p) => p.functionCall)) {
      state.history.pop();
    } else {
      break;
    }
  }
}

// ====== Agent Turn ======
const MAX_USER_MSG_BYTES = 50000;

export async function agentTurn(userMessage) {
  if (userMessage.length > MAX_USER_MSG_BYTES) {
    const truncated = userMessage.substring(0, MAX_USER_MSG_BYTES);
    process.stdout.write(
      `\x1b[33m  ! input truncated: ${userMessage.length} -> ${MAX_USER_MSG_BYTES} bytes\x1b[0m\n`
    );
    userMessage = truncated + "\n\n...[truncated - input too large]";
  }
  state.history.push({ role: "user", parts: [{ text: userMessage }] });
  state.turnCount++;

  let loops = 0;
  const callLog = [];
  let exploreCount = 0;
  const EXPLORE_BUDGET = 12;
  const EXPLORE_TOOLS = new Set(["list_directory", "find_files", "search_text"]);

  while (loops < MAX_TOOL_LOOPS) {
    if (state.aborted) {
      state.aborted = false;
      cleanupHistoryAfterAbort();
      process.stdout.write(`\x1b[33m  ⏹ Turn aborted by user.\x1b[0m\n`);
      return "";
    }
    loops++;
    titleThinking();
    startSpin(loops === 1 ? "thinking..." : "continuing...");

    let response;
    try {
      response = await callGemini(state.history);
    } catch (e) {
      stopSpin();
      if (state.aborted) {
        cleanupHistoryAfterAbort();
        process.stdout.write(`\x1b[33m  ⏹ Turn aborted by user.\x1b[0m\n`);
        return "";
      }
      throw e;
    }
    stopSpin();

    state.history.push(response);

    const parts = response.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length === 0) {
      if (!isOAuthEnabled()) {
        return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      }
      return "";
    }

    const responses = [];
    for (const part of calls) {
      if (state.aborted) break;
      const { name, args } = part.functionCall;
      process.stdout.write(`\x1b[90m  > ${name}(${fmtArgs(args)})\x1b[0m\n`);
      titleToolCall(name);

      const callKey = JSON.stringify({ name, args });
      const repeatCount = callLog.filter((k) => k === callKey).length;
      callLog.push(callKey);

      if (repeatCount >= 2) {
        process.stdout.write(`\x1b[33m    ! loop detected: ${name} called ${repeatCount + 1} times with same args\x1b[0m\n`);
        responses.push({ functionResponse: { name, response: {
          success: false,
          error: `This exact call (${name} with same arguments) has been made ${repeatCount + 1} times already. You are in a loop. Stop repeating and either try a different approach or respond with what you have so far.`,
        } } });
        continue;
      }

      if (EXPLORE_TOOLS.has(name)) {
        exploreCount++;
        if (exploreCount > EXPLORE_BUDGET) {
          process.stdout.write(`\x1b[33m    ! explore budget exceeded (${exploreCount}/${EXPLORE_BUDGET}). Blocked.\x1b[0m\n`);
          responses.push({ functionResponse: { name, response: {
            success: false,
            error: `Exploration budget exhausted (${EXPLORE_BUDGET} calls used). You MUST now work with the files you have already found. Do NOT call list_directory, find_files, or search_text again. Write code or respond to the user.`,
          } } });
          continue;
        }
      }

      const hookResult = await runHooks("BeforeTool", name, args || {});
      if (hookResult?.denied) {
        process.stdout.write(`\x1b[33m    ! hook: ${hookResult.reason}\x1b[0m\n`);
        responses.push({ functionResponse: { name, response: { success: false, error: hookResult.reason } } });
        continue;
      }

      const result = TOOL_MAP[name] ? await TOOL_MAP[name](args || {}) : { error: `Unknown tool: ${name}` };
      if (result.success === false) {
        process.stdout.write(`\x1b[31m    x ${result.error || "failed"}\x1b[0m\n`);
      }

      const afterResult = await runHooks("AfterTool", name, {
        _raw: { tool_name: name, tool_input: args || {}, tool_response: result },
      });
      if (afterResult?.outputs) {
        for (const out of afterResult.outputs) {
          const msg = out.systemMessage || out.hookSpecificOutput?.additionalContext;
          if (msg) {
            process.stdout.write(`\x1b[33m    hook: ${msg}\x1b[0m\n`);
            result._hookFeedback = (result._hookFeedback || "") + msg + "\n";
          }
        }
      }

      responses.push({ functionResponse: { name, response: result } });
    }

    if (state.aborted && responses.length < calls.length) {
      state.history.pop();
      continue;
    }

    state.history.push({ role: "user", parts: responses });
  }
  return "[Tool loop limit reached]";
}
