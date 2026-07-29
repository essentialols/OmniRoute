// tests/unit/local-turn-recovery.test.ts
// Unit coverage for the local-turn dead-turn detector + tool-bridge/recovery orchestrator (task
// #17). Pure logic; no network. Validates the exact detector rules and the resample protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDeadTurn,
  runLocalTurnRecovery,
  resolveLocalTurnRecoveryPlan,
  canonicalBridgedName,
  isLocalBridgeProvider,
  TERMINAL_FALLBACK_TEXT,
} from "../../open-sse/services/localTurnRecovery.ts";

// Real provider ids are composed (`openai-compatible-chat-h1-llamaswap`), so an exact-only
// allowlist check never matched the backends this module exists to serve: a raw-tool-call leak
// from the H1 gemma went unrecovered and surfaced to the client as "Did 0 searches".
test("allowlist matches composed local provider ids by token", () => {
  assert.equal(isLocalBridgeProvider("openai-compatible-chat-h1-llamaswap"), true);
  assert.equal(isLocalBridgeProvider("openai-compatible-chat-m2-mlx-router"), true);
  assert.equal(isLocalBridgeProvider("llama-swap"), true);
  assert.equal(isLocalBridgeProvider("ornith"), true);
});

test("allowlist does NOT match cloud providers or substring lookalikes", () => {
  for (const p of [
    "openai",
    "groq",
    "cerebras",
    "mistral",
    "deepseek-web",
    "claude",
    "gemini",
    "mlxcloud",
    "notlocalhost",
    "",
  ]) {
    assert.equal(isLocalBridgeProvider(p), false, `${p} must not be treated as local`);
  }
});

test("recovery gate activates for the composed H1 provider id", () => {
  assert.deepEqual(
    resolveLocalTurnRecoveryPlan({
      provider: "openai-compatible-chat-h1-llamaswap",
      isClaudeSource: true,
      clientWantsStream: true,
      nativeCodexPassthrough: false,
      isResponsesEndpoint: false,
      recoveryHeaderPresent: false,
    }),
    { active: true }
  );
});

type Json = Record<string, unknown>;

function completion(message: Json, finish_reason = "stop"): Json {
  return {
    id: "chatcmpl-test",
    model: "lfm2-8b",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
  };
}

// ── detector ──────────────────────────────────────────────────────────────────────────────

test("dead-turn: empty content recovers", () => {
  assert.equal(detectDeadTurn(completion({ content: "" })).recover, true);
  assert.equal(detectDeadTurn(completion({ content: "   " })).recover, true);
});

test("dead-turn: raw tool-call leak recovers", () => {
  assert.equal(detectDeadTurn(completion({ content: "<tool_call>{...}" })).recover, true);
  assert.equal(detectDeadTurn(completion({ content: '{"tool_name": "x"}' })).recover, true);
  assert.equal(detectDeadTurn(completion({ content: "[WebSearch(query='x')" })).recover, true);
});

test("dead-turn: trailing action announcement recovers", () => {
  assert.equal(
    detectDeadTurn(completion({ content: "Sure. I'll search the web for that now." })).recover,
    true
  );
  assert.equal(
    detectDeadTurn(completion({ content: "Let me read the file to check." })).recover,
    true
  );
  assert.equal(
    detectDeadTurn(completion({ content: "Next action: dispatch the agents." })).recover,
    true
  );
});

test("dead-turn: false-capability refusal recovers", () => {
  assert.equal(
    detectDeadTurn(completion({ content: "I don't have the ability to search the web." })).recover,
    true
  );
  assert.equal(
    detectDeadTurn(completion({ content: "I cannot browse external sites." })).recover,
    true
  );
});

test("healthy turns do NOT recover", () => {
  assert.equal(
    detectDeadTurn(completion({ content: "The capital of France is Paris." })).recover,
    false
  );
  // A genuine clarifying question ends in "?" and must not be treated as a dead turn.
  assert.equal(detectDeadTurn(completion({ content: "Which file should I read?" })).recover, false);
});

test("turns with tool_calls or non-stop finish do NOT recover", () => {
  const withTool = completion({
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }],
  });
  assert.equal(detectDeadTurn(withTool).recover, false);
  assert.equal(detectDeadTurn(completion({ content: "" }, "length")).recover, false);
});

test("long announced text (> 500 chars) does not trigger the announcement branch", () => {
  const long = "x ".repeat(300) + "let me search now.";
  assert.equal(detectDeadTurn(completion({ content: long })).recover, false);
});

// ── bridged tool name mapping ───────────────────────────────────────────────────────────────

test("bridged tool names map to canonical builtin handlers", () => {
  assert.equal(canonicalBridgedName("WebSearch"), "web_search");
  assert.equal(canonicalBridgedName("web_search"), "web_search");
  assert.equal(canonicalBridgedName("omniroute_web_search"), "web_search");
  assert.equal(canonicalBridgedName("WebFetch"), "web_fetch");
  assert.equal(canonicalBridgedName("web_fetch"), "web_fetch");
  assert.equal(canonicalBridgedName("Bash"), null);
});

// ── gating ──────────────────────────────────────────────────────────────────────────────────

test("gate: active only for allowlisted local provider on streaming Claude path", () => {
  const base = {
    provider: "rapid-mlx",
    isClaudeSource: true,
    clientWantsStream: true,
    nativeCodexPassthrough: false,
    isResponsesEndpoint: false,
    recoveryHeaderPresent: false,
  };
  assert.equal(resolveLocalTurnRecoveryPlan(base).active, true);
  assert.equal(resolveLocalTurnRecoveryPlan({ ...base, provider: "openai" }).active, false);
  assert.equal(resolveLocalTurnRecoveryPlan({ ...base, isClaudeSource: false }).active, false);
  assert.equal(resolveLocalTurnRecoveryPlan({ ...base, clientWantsStream: false }).active, false);
  assert.equal(
    resolveLocalTurnRecoveryPlan({ ...base, nativeCodexPassthrough: true }).active,
    false
  );
  assert.equal(
    resolveLocalTurnRecoveryPlan({ ...base, recoveryHeaderPresent: true }).active,
    false
  );
});

// ── orchestrator ──────────────────────────────────────────────────────────────────────────

test("tool bridge: executes bridged call, resamples, returns model answer", async () => {
  const first = completion({
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "WebSearch", arguments: '{"query":"omniroute"}' },
      },
    ],
  });
  const executed: string[] = [];
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [{ role: "user", content: "search omniroute" }],
    executeBridgedTool: async (name, args) => {
      executed.push(`${name}:${JSON.stringify(args)}`);
      return { results: ["r1"] };
    },
    reinvoke: async () => completion({ content: "Here is what I found: r1." }),
  });
  assert.deepEqual(executed, ['web_search:{"query":"omniroute"}']);
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.content, "Here is what I found: r1.");
});

test("native tool call is passed through untouched (no interception)", async () => {
  const first = completion({
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }],
  });
  let reinvoked = false;
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [],
    executeBridgedTool: async () => ({}),
    reinvoke: async () => {
      reinvoked = true;
      return completion({ content: "should not happen" });
    },
  });
  assert.equal(reinvoked, false);
  assert.deepEqual(final, first);
});

test("dead-turn recovery: single resample fixes an announced-but-not-acted turn", async () => {
  const first = completion({ content: "Let me search for that now." });
  let calls = 0;
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [{ role: "user", content: "q" }],
    executeBridgedTool: async () => ({}),
    reinvoke: async () => {
      calls += 1;
      return completion({ content: "The answer is 42." });
    },
  });
  assert.equal(calls, 1);
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.content, "The answer is 42.");
});

test("terminal fallback: recovery resample also dead-stops", async () => {
  const first = completion({ content: "" });
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [],
    executeBridgedTool: async () => ({}),
    reinvoke: async () => completion({ content: "I'll call the tool now." }),
  });
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.content, TERMINAL_FALLBACK_TEXT);
  assert.equal(((final.choices as Json[])[0] as Json).finish_reason, "stop");
});

test("terminal fallback when the recovery resample itself fails (null)", async () => {
  const first = completion({ content: "" });
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [],
    executeBridgedTool: async () => ({}),
    reinvoke: async () => null,
  });
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.content, TERMINAL_FALLBACK_TEXT);
});

// ── Regression: a legitimate refusal must NOT be treated as a false-capability refusal ──

test("detectDeadTurn: legitimate refusals naming a concrete object are NOT recovered", () => {
  for (const content of [
    "I can't access the file because it doesn't exist.",
    "I cannot read that path, it is outside the workspace.",
    "I don't have access to that database table.",
    "I can't run the migration until you confirm the target.",
  ]) {
    assert.equal(
      detectDeadTurn(completion({ content })).recover,
      false,
      `must not nudge over a correct refusal: ${content}`
    );
  }
});

test("detectDeadTurn: false-capability refusals about tooling ARE recovered", () => {
  for (const content of [
    "I do not have access to a live web search tool or the internet.",
    "I cannot browse online.",
    "I don't have the ability to run shell commands.",
    "I can't use external tools in this environment.",
  ]) {
    assert.equal(
      detectDeadTurn(completion({ content })).recover,
      true,
      `must recover a false-capability refusal: ${content}`
    );
  }
});

// ── Regression: a failed resample must never hand back un-executable tool_calls ──

test("bridge: resample failure after execution surfaces results and drops tool_calls", async () => {
  const first = completion({
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "WebSearch", arguments: '{"query":"q"}' } },
    ],
  });
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [{ role: "user", content: "q" }],
    executeBridgedTool: async () => ({ results: ["REAL_SEARCH_HIT"] }),
    reinvoke: async () => null,
  });

  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.tool_calls, undefined, "un-executable tool_calls must be dropped");
  assert.ok(
    String(msg.content).includes("REAL_SEARCH_HIT"),
    "executed tool results must not be discarded"
  );
  assert.equal(((final.choices as Json[])[0] as Json).finish_reason, "stop");
});
