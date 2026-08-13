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
  extractLeakedSearchQuery,
  TERMINAL_FALLBACK_TEXT,
  requestDeclaresBridgeableTool,
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
      requestDeclaresBridgeableTool: true,
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
    requestDeclaresBridgeableTool: true,
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

// ── P7P (Pixel 7 Pro): the node id is an opaque hex UUID, so the MODEL must carry locality ──

const P7P = "openai-compatible-chat-38f92fd5-674d-4feb-ac9a-99aff21fe725";

test("P7P: opaque UUID provider is local when the model names an on-device model", () => {
  assert.equal(isLocalBridgeProvider(P7P, "smallthinker-4b-a0.6b"), true);
  assert.equal(isLocalBridgeProvider(P7P, "p7p/smallthinker-4b-a0.6b"), true, "prefix stripped");
  assert.equal(isLocalBridgeProvider(P7P, "lfm2.5-8b-a1b"), true);
});

test("P7P: the UUID provider alone is NOT enough to prove locality", () => {
  assert.equal(isLocalBridgeProvider(P7P), false);
  assert.equal(isLocalBridgeProvider(P7P, ""), false);
  assert.equal(isLocalBridgeProvider(P7P, "gpt-5.5"), false);
});

// The model must never be able to drag CLOUD traffic into server-side tool execution.
test("a cloud provider with a cloud model stays non-local", () => {
  for (const [prov, mdl] of [
    ["openai", "gpt-5.5"],
    ["groq", "llama-3.3-70b"],
    ["claude", "claude-opus-4-8"],
    ["gemini", "gemini-3-pro"],
    ["mistral", "mistral-large"],
  ]) {
    assert.equal(isLocalBridgeProvider(prov, mdl), false, `${prov}/${mdl} must stay cloud`);
  }
});

test("recovery gate activates for P7P via the model", () => {
  assert.deepEqual(
    resolveLocalTurnRecoveryPlan({
      provider: P7P,
      model: "smallthinker-4b-a0.6b",
      isClaudeSource: true,
      clientWantsStream: true,
      nativeCodexPassthrough: false,
      isResponsesEndpoint: false,
      recoveryHeaderPresent: false,
      requestDeclaresBridgeableTool: true,
    }),
    { active: true }
  );
});

test("recovery gate stays inactive for P7P when the model is unknown", () => {
  assert.equal(
    resolveLocalTurnRecoveryPlan({
      provider: P7P,
      model: "some-cloud-model",
      isClaudeSource: true,
      clientWantsStream: true,
      nativeCodexPassthrough: false,
      isResponsesEndpoint: false,
      recoveryHeaderPresent: false,
      requestDeclaresBridgeableTool: true,
    }).active,
    false
  );
});

// ── Announce-then-fabricate: the most dangerous dead turn ──
// Verbatim shape observed from smallthinker-4b-a0.6b on 2026-07-29: it announced a search, emitted
// NO tool call, and invented findings (with invented URLs) that reached the client as a confident
// sourced-looking answer. Claude Code reported "Did 0 searches" and the prose looked authoritative.

const FABRICATED =
  'I\'ll search for information related to "Spotify high quality audio extraction" and its ' +
  "implementation on GitHub. Here's what I found: ### Key Findings: 1. **Spotify Audio Extraction " +
  "(Hypothetical Approach)** - No official API exists for this. See https://github.com/... and " +
  "https://tuneit.org/ for community efforts. 2. Several projects claim to support lossless " +
  "extraction, though quality varies considerably between implementations and regions. " +
  "3. Bitrate ceilings differ per subscription tier, and the Ogg Vorbis container is standard.";

test("announce-then-fabricate IS recovered when a bridged tool was available", () => {
  assert.ok(FABRICATED.length > 500, "fixture must exceed the 500-char announcement cutoff");
  const d = detectDeadTurn(completion({ content: FABRICATED }), true);
  assert.equal(d.recover, true);
  assert.equal(d.reason, "announced_without_tool_call");
});

// The safety property: without a bridged tool on the request, the same text is a normal answer.
test("the SAME text is NOT recovered when no bridged tool was available", () => {
  assert.equal(detectDeadTurn(completion({ content: FABRICATED }), false).recover, false);
  assert.equal(detectDeadTurn(completion({ content: FABRICATED })).recover, false, "defaults off");
});

test("a long legitimate answer that merely mentions searching is NOT recovered", () => {
  const legit =
    "The bitrate ceiling depends on the subscription tier. Free accounts top out lower than " +
    "Premium, and the container is Ogg Vorbis in both cases. If you want to verify this yourself " +
    "you could search the developer documentation, but the values above are already confirmed by " +
    "the platform's published specifications and have not changed in several years. Nothing here " +
    "requires further lookup, and the numbers are stable across regions and client versions.";
  assert.ok(legit.length > 400);
  assert.equal(detectDeadTurn(completion({ content: legit }), true).recover, false);
});

test("a turn WITH tool_calls is still never a dead turn, tool available or not", () => {
  const withTool = completion({
    content: FABRICATED,
    tool_calls: [{ id: "c1", type: "function", function: { name: "WebSearch", arguments: "{}" } }],
  });
  assert.equal(detectDeadTurn(withTool, true).recover, false);
});

test("a trailing question is not recovered even with a tool available", () => {
  assert.equal(
    detectDeadTurn(
      completion({ content: "I'll search for that. Which region should I check?" }),
      true
    ).recover,
    false
  );
});

// ── Leak SALVAGE: a leaked tool call still contains the query, so run it ──
// H1 gemma leaks the call as prose, gets nudged, and leaks again -- the user sees "Did 0 searches"
// while the query the model wanted was sitting in the text the whole time.

const GEMMA_LEAK_OBJ =
  '<|tool_call>call:google_search:search{queries:[{"query":"spotdl github stars"}]}<tool_call|>';
const GEMMA_LEAK_STR =
  '<|tool_call>call:google_search:search{queries:["spotify lossless extraction"]}<tool_call|>';
const GENERIC_LEAK =
  '<tool_call>{"name":"web_search","arguments":{"query":"ogg vorbis bitrate"}}</tool_call>';

test("extractLeakedSearchQuery handles the dialects local models actually emit", () => {
  assert.equal(extractLeakedSearchQuery(GEMMA_LEAK_OBJ), "spotdl github stars");
  assert.equal(extractLeakedSearchQuery(GEMMA_LEAK_STR), "spotify lossless extraction");
  assert.equal(extractLeakedSearchQuery(GENERIC_LEAK), "ogg vorbis bitrate");
});

test("extractLeakedSearchQuery refuses non-search leaks and junk", () => {
  // A leaked Bash call must never be turned into a web search.
  assert.equal(
    extractLeakedSearchQuery(
      '<tool_call>{"name":"Bash","arguments":{"command":"rm -rf /"}}</tool_call>'
    ),
    null
  );
  assert.equal(extractLeakedSearchQuery("I will search the web for you."), null, "no query arg");
  assert.equal(extractLeakedSearchQuery(""), null);
});

test("salvage: a leaked search is EXECUTED and the model answers from the results", async () => {
  const first = completion({ content: GEMMA_LEAK_OBJ });
  const executed: Array<[string, Json]> = [];
  let resamples = 0;
  const final = await runLocalTurnRecovery(first, {
    baseMessages: [{ role: "user", content: "find spotdl" }],
    bridgedToolAvailable: true,
    executeBridgedTool: async (name, args) => {
      executed.push([name, args]);
      return {
        results: [{ title: "spotDL", url: "https://github.com/spotDL/spotify-downloader" }],
      };
    },
    reinvoke: async () => {
      resamples += 1;
      return completion({
        content: "spotDL has ~20k stars: https://github.com/spotDL/spotify-downloader",
      });
    },
  });

  assert.deepEqual(executed, [["web_search", { query: "spotdl github stars" }]], "search must run");
  assert.equal(resamples, 1, "exactly one resample, no nudge round needed");
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.ok(String(msg.content).includes("github.com/spotDL"), "answer must use the real result");
});

test("salvage does NOT fire when no bridged tool was available", async () => {
  let called = false;
  await runLocalTurnRecovery(completion({ content: GEMMA_LEAK_OBJ }), {
    baseMessages: [],
    bridgedToolAvailable: false,
    executeBridgedTool: async () => {
      called = true;
      return {};
    },
    reinvoke: async () => completion({ content: "done." }),
  });
  assert.equal(called, false, "no search tool on the request means nothing to salvage");
});

test("salvage falls back to the nudge path when the post-salvage turn is still dead", async () => {
  let resamples = 0;
  const final = await runLocalTurnRecovery(completion({ content: GEMMA_LEAK_OBJ }), {
    baseMessages: [{ role: "user", content: "q" }],
    bridgedToolAvailable: true,
    executeBridgedTool: async () => ({ results: [] }),
    reinvoke: async () => {
      resamples += 1;
      // First (post-salvage) reply leaks again; second (post-nudge) reply is healthy.
      return resamples === 1
        ? completion({ content: GEMMA_LEAK_STR })
        : completion({ content: "No results were found for that query." });
    },
  });
  assert.equal(resamples, 2, "salvage resample, then the nudge resample");
  const msg = ((final.choices as Json[])[0] as Json).message as Json;
  assert.equal(msg.content, "No results were found for that query.");
});

// A LONG false-capability refusal padded with fabricated knowledge. Verbatim shape from H1 gemma
// on 2026-07-29; the 500-char refusal cutoff could never see it, and the padding is what made it
// long in the first place.
const LONG_FALSE_REFUSAL =
  "I do not have access to a web search tool or any other external tools by default. Therefore, " +
  "I cannot perform a live web search for you. However, based on my internal knowledge (cutoff " +
  "January 2025), I can provide information regarding spotdl: GitHub Stars: spotdl is a very " +
  "popular repository with approximately 6,000+ stars. Lossless Quality: while spotdl is highly " +
  "popular, users often use it to get the highest available bitrate provided by the source, and " +
  "the container is typically Ogg Vorbis rather than a true lossless format in most regions.";

test("a LONG false-capability refusal IS recovered when the tool was available", () => {
  assert.ok(LONG_FALSE_REFUSAL.length > 500, "fixture must exceed the 500-char refusal cutoff");
  const d = detectDeadTurn(completion({ content: LONG_FALSE_REFUSAL }), true);
  assert.equal(d.recover, true);
  assert.equal(d.reason, "false_refusal_with_tool");
});

test("the same refusal is NOT recovered when no tool was available (it may be true)", () => {
  assert.equal(detectDeadTurn(completion({ content: LONG_FALSE_REFUSAL }), false).recover, false);
});

test("legitimate refusals about a concrete object stay untouched even with a tool available", () => {
  for (const c of [
    "I can't access the file because it doesn't exist.",
    "I cannot read that path, it is outside the workspace.",
  ]) {
    assert.equal(detectDeadTurn(completion({ content: c }), true).recover, false, c);
  }
});

// ── bridgeable-tool gate ────────────────────────────────────────────────────────────────────
//
// An active plan forces the UPSTREAM call non-streaming, so nothing reaches the client until the
// local model finishes generating. On a request with no bridgeable tool there is nothing to
// execute server-side, so that cost buys only the "empty" dead-turn resample. These tests pin the
// trade so it cannot regress silently in either direction.

test("gate: inactive when the request declares no bridgeable tool", () => {
  const base = {
    provider: "rapid-mlx",
    isClaudeSource: true,
    clientWantsStream: true,
    nativeCodexPassthrough: false,
    isResponsesEndpoint: false,
    recoveryHeaderPresent: false,
  };
  // Positive control: identical input WITH a bridgeable tool stays active, so the assertion
  // below cannot pass merely because some other condition is failing.
  assert.equal(
    resolveLocalTurnRecoveryPlan({ ...base, requestDeclaresBridgeableTool: true }).active,
    true,
    "control: a bridgeable tool must keep the plan active"
  );
  assert.equal(
    resolveLocalTurnRecoveryPlan({ ...base, requestDeclaresBridgeableTool: false }).active,
    false,
    "no bridgeable tool must not force a non-streaming upstream call"
  );
});

test("requestDeclaresBridgeableTool: both wire shapes, and no false positives", () => {
  // Claude shape.
  assert.equal(requestDeclaresBridgeableTool({ tools: [{ name: "WebSearch" }] }), true);
  assert.equal(requestDeclaresBridgeableTool({ tools: [{ name: "WebFetch" }] }), true);
  // OpenAI function shape.
  assert.equal(
    requestDeclaresBridgeableTool({ tools: [{ function: { name: "web_search" } }] }),
    true
  );
  // The fallback tool OmniRoute injects for native web_search.
  assert.equal(requestDeclaresBridgeableTool({ tools: [{ name: "omniroute_web_search" }] }), true);
  // Non-bridgeable tools must NOT activate the plan.
  assert.equal(
    requestDeclaresBridgeableTool({ tools: [{ name: "Bash" }, { name: "Read" }] }),
    false
  );
  // Malformed / absent input must not throw and must not activate.
  assert.equal(requestDeclaresBridgeableTool({}), false);
  assert.equal(requestDeclaresBridgeableTool({ tools: "nope" }), false);
  assert.equal(requestDeclaresBridgeableTool({ tools: [null, 42, { name: 7 }] }), false);
  assert.equal(requestDeclaresBridgeableTool(null), false);
  assert.equal(requestDeclaresBridgeableTool(undefined), false);
});

// ── Announcement at unlimited length needs a CLAIM OF RESULTS to be fabrication ────────────────
//
// Regression for a live incident on 2026-08-13. A user asked ornith-35b-c (local lane) to build a
// 20-step workflow pipeline. Upstream returned HTTP 200 with 332 output tokens of real planning
// prose. The client saw only TERMINAL_FALLBACK_TEXT, twice in a row: the unlimited-length branch
// matched on announcement language alone, the rescue resample then failed, and a correct answer was
// deleted and replaced with a 12-word apology.
//
// That branch's documented safety property was `bridgedToolAvailable`, but Claude Code offers
// WebSearch/WebFetch on essentially every request, so the gate is true almost always and cannot
// carry the weight. Announcing AND claiming results already in hand is what separates fabrication
// from planning.
//
// NOTE the division of labour, which these tests pin: the <=500 branch inspects only the TRAILING
// sentences, so "announced an action and then stopped" is still a dead turn and is still recovered.
// Only the unlimited-length branch is narrowed here.

test("LONG planning prose that announces actions is NOT a dead turn, tool available", () => {
  const planning =
    "Here is how I will approach the 20-step pipeline for the game. " +
    "Each stage covers brainstorming, puzzle design, implementation and verification. ".repeat(8) +
    "I will use the existing workflow conventions rather than inventing new ones.";
  assert.ok(planning.length > 500, "fixture must exceed 500 chars to reach the branch under test");
  const d = detectDeadTurn(completion({ content: planning }), true);
  assert.equal(d.recover, false, "planning claims no results, so it is not fabrication");
  assert.equal(d.reason, "ok");
});

test("a LONG correct answer whose last sentence announces is NOT a dead turn", () => {
  const long =
    "Here is the full design for the game. " +
    "The verb-coin interface needs nine verbs and an inventory pane. ".repeat(30) +
    "Let me run through the remaining steps.";
  assert.ok(long.length > 500);
  assert.equal(detectDeadTurn(completion({ content: long }), true).recover, false);
});

test("LONG announcement PLUS a claim of results is still caught as fabrication", () => {
  const fabricated =
    "I'll search for Monkey Island design documents and pull the relevant ones. " +
    "Here's what I found: the SCUMM engine shipped in 1990 and the verb list was standardised. " +
    "Community archives host scans of the original design notes and puzzle dependency charts. ".repeat(
      4
    );
  assert.ok(fabricated.length > 500);
  const d = detectDeadTurn(completion({ content: fabricated }), true);
  assert.equal(d.recover, true, "announce + results-claim is the fabrication shape");
  assert.equal(d.reason, "announced_without_tool_call");
});

test("the <=500 trailing-announcement rule is deliberately UNCHANGED", () => {
  // Announced an action and then stopped: still a dead turn, still worth a nudge.
  const short = "I will read the plan document and summarise the twenty stages.";
  assert.ok(short.length <= 500);
  const d = detectDeadTurn(completion({ content: short }), true);
  assert.equal(d.recover, true);
  assert.equal(d.reason, "announcement");
});

// ── A failed rescue must never destroy a successful turn ───────────────────────────────────────
//
// Regression for 2026-08-13. Narrowing the announcement heuristic did NOT stop the user-visible
// failure: two ornith-35b-c turns still came back HTTP 200 with 172 and 206 output tokens while the
// client saw only TERMINAL_FALLBACK_TEXT. Some other detector branch classified them. The guard
// therefore belongs at the sink: buildTerminalFallback is reachable from several branches, and in
// every one of them overwriting real output with an apology loses information the user paid for.

test("terminal fallback preserves real content instead of replacing it", async () => {
  const withContent = completion({ content: "Here is the 20-step pipeline you asked for." });
  // reinvoke returns null => the rescue failed => the terminal-fallback path is taken.
  const out = await runLocalTurnRecovery(completion({ content: "" }), {
    reinvoke: async () => null,
    baseMessages: [{ role: "user", content: "plan something" }],
    executeBridgedTool: async () => ({}),
    bridgedToolAvailable: true,
  });
  const text = out.choices?.[0]?.message?.content ?? "";
  assert.ok(typeof text === "string");
  // The input here genuinely had nothing, so the canned text is correct in THIS case.
  assert.equal(text, TERMINAL_FALLBACK_TEXT);

  // But a turn carrying content must survive untouched.
  const kept = await runLocalTurnRecovery(withContent, {
    reinvoke: async () => null,
    baseMessages: [{ role: "user", content: "plan something" }],
    executeBridgedTool: async () => ({}),
    bridgedToolAvailable: true,
  });
  assert.equal(
    kept.choices?.[0]?.message?.content,
    "Here is the 20-step pipeline you asked for.",
    "a successful turn with real content must never be replaced by the apology"
  );
});

test("terminal fallback surfaces reasoning_content when content is empty", async () => {
  // ornith/lfm2 routinely spend the whole budget in reasoning_content and leave content empty.
  // rawContent does not look at reasoning_content, so the detector calls this "empty" - but the
  // model did produce output, and showing it beats an apology.
  const resp = completion({ content: "" });
  resp.choices[0].message.reasoning_content =
    "1. Understand the request. 2. Draft the twenty stages. 3. Verify each one.";
  const out = await runLocalTurnRecovery(resp, {
    reinvoke: async () => null,
    baseMessages: [{ role: "user", content: "plan something" }],
    executeBridgedTool: async () => ({}),
    bridgedToolAvailable: true,
  });
  const text = String(out.choices?.[0]?.message?.content ?? "");
  assert.ok(text.includes("twenty stages"), "reasoning was discarded: " + text);
  assert.notEqual(text, TERMINAL_FALLBACK_TEXT);
});

// The recovery trace must ACTUALLY reach disk. The first attempt used `require`, which is
// undefined in this ESM module, so every write threw into a silent catch and recorded nothing --
// the same class of failure as ctx.log, which is wired but never reaches daemon.log. Instrumentation
// that silently records nothing is worse than none, so this asserts a real file append.
test("dead-turn classifications are recorded to disk", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const trace = `${os.homedir()}/.omniroute/local-recovery.log`;
  const before = fs.existsSync(trace) ? fs.statSync(trace).size : 0;

  await runLocalTurnRecovery(completion({ content: "" }), {
    baseMessages: [],
    executeBridgedTool: async () => ({}),
    reinvoke: async () => null,
  });

  // The append is fire-and-forget; give the microtask + fs a moment.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(trace), "trace file was never created at " + trace);
  const after = fs.statSync(trace).size;
  assert.ok(after > before, "trace file did not grow; the write path is silently failing");
  const last = fs.readFileSync(trace, "utf8").trim().split("\n").pop() || "";
  const row = JSON.parse(last);
  assert.equal(row.reason, "empty");
  assert.equal(typeof row.content_len, "number");
});
