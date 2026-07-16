// tests/unit/chatcore-upstream-body.test.ts
// Characterization of prepareUpstreamBody — the first internal sub-slice of executeProviderRequest
// (chatCore god-file decomposition, #3501). Uses a fresh temp DB (no payload rules / no detected
// tool limits → defaults). Locks: target-model pinning, the Qwen OAuth user backfill (and its
// guards), and the prompt_cache_key gating (excluded providers + non-OPENAI format never inject).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-upstream-body-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("pins the target model when it differs from the translated body model", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "model-a", messages: [] },
    modelToCall: "model-b",
    provider: "some-provider",
    targetFormat: "claude",
    credentials: null,
  });
  assert.equal(out.model, "model-b");
});

test("leaves the model untouched when it already matches", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "model-a", messages: [] },
    modelToCall: "model-a",
    provider: "some-provider",
    targetFormat: "claude",
    credentials: null,
  });
  assert.equal(out.model, "model-a");
});

// PR #5563: the `effectiveToolLimit < MAX_TOOLS_LIMIT` gate was removed from
// truncateToolList, so providers whose proactive limit is >= the 128 default
// (e.g. grok-cli at 200) are actually truncated. Without the gate removal these
// two assertions fail (250 tools would pass through untruncated).
test("truncates the tool list to the grok-cli proactive limit (200) when exceeded", async () => {
  const tools = Array.from({ length: 250 }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, parameters: {} },
  }));
  const out = await prepareUpstreamBody({
    translatedBody: { model: "grok-cli-model", messages: [], tools },
    modelToCall: "grok-cli-model",
    provider: "grok-cli",
    targetFormat: "claude",
    credentials: null,
  });
  assert.ok(Array.isArray(out.tools));
  assert.equal(out.tools.length, 200);
});

test("preserves the full tool list when within the grok-cli limit", async () => {
  const tools = Array.from({ length: 150 }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, parameters: {} },
  }));
  const out = await prepareUpstreamBody({
    translatedBody: { model: "grok-cli-model", messages: [], tools },
    modelToCall: "grok-cli-model",
    provider: "grok-cli",
    targetFormat: "claude",
    credentials: null,
  });
  assert.equal(out.tools.length, 150);
});

test("backfills the Qwen OAuth user when missing", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "qwen-max", messages: [] },
    modelToCall: "qwen-max",
    provider: "qwen",
    targetFormat: "claude",
    credentials: { accessToken: "tok-123" },
  });
  assert.equal(out.user, "omniroute-qwen-oauth");
});

test("does not backfill the Qwen user when an apiKey is present (API-key mode)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "qwen-max", messages: [] },
    modelToCall: "qwen-max",
    provider: "qwen",
    targetFormat: "claude",
    credentials: { apiKey: "k", accessToken: "tok-123" },
  });
  assert.equal(out.user, undefined);
});

test("does not backfill the Qwen user when one is already set", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "qwen-max", messages: [], user: "real-user" },
    modelToCall: "qwen-max",
    provider: "qwen",
    targetFormat: "claude",
    credentials: { accessToken: "tok-123" },
  });
  assert.equal(out.user, "real-user");
});

test("never injects prompt_cache_key for an excluded provider (codex)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "gpt-5-codex", messages: [{ role: "user", content: "hi" }] },
    modelToCall: "gpt-5-codex",
    provider: "codex",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.prompt_cache_key, undefined);
});

test("never injects prompt_cache_key when the target format is not OpenAI", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
    modelToCall: "claude-x",
    provider: "claude",
    targetFormat: "claude",
    credentials: null,
  });
  assert.equal(out.prompt_cache_key, undefined);
});

// Codex CLI (Responses API) always sends a session-scoped prompt_cache_key. Strict
// OpenAI-compatible upstreams that don't implement it (e.g. Groq) reject the whole
// request with a 400 "property 'prompt_cache_key' is unsupported". Strip it for any
// OpenAI-format provider that does not support caching.
test("strips a client-supplied prompt_cache_key for a non-caching OpenAI provider (groq)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "codex-session-abc",
    },
    modelToCall: "llama-3.3-70b-versatile",
    provider: "groq",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.prompt_cache_key, undefined);
});

test("also strips the camelCase promptCacheKey variant for a non-caching OpenAI provider", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
      promptCacheKey: "codex-session-def",
    },
    modelToCall: "mistral-large",
    provider: "mistral",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.promptCacheKey, undefined);
  assert.equal(out.prompt_cache_key, undefined);
});

// A caching-capable provider must keep a client-supplied key untouched (no strip, no
// overwrite). This includes codex, which is excluded from injection but still uses the key.
test("preserves a client-supplied prompt_cache_key for a caching provider (openai)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "client-key-123",
    },
    modelToCall: "gpt-4o",
    provider: "openai",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.prompt_cache_key, "client-key-123");
});

test("preserves a client-supplied prompt_cache_key for codex passthrough", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "gpt-5-codex",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "codex-session-xyz",
    },
    modelToCall: "gpt-5-codex",
    provider: "codex",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.prompt_cache_key, "codex-session-xyz");
});

// ── Codex OpenAI-compat upstream normalization (system-first / vision / tool fields) ──
// prepareUpstreamBody applies normalizeOpenAICompatUpstreamBody for targetFormat "openai"
// only; claude/gemini keep their own dedicated handling.

test("merges adjacent system messages for OpenAI-format upstreams (uncloseai)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "m",
      messages: [
        { role: "system", content: "instructions" },
        { role: "system", content: [{ type: "text", text: "perm" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
    modelToCall: "m",
    provider: "uncloseai",
    targetFormat: "openai",
    credentials: null,
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "instructions\n\nperm");
  assert.equal(msgs[1].content, "hi"); // text-only array flattened
});

test("does NOT touch messages for non-OpenAI targetFormat (claude)", async () => {
  const messages = [
    { role: "system", content: "a" },
    { role: "system", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const out = await prepareUpstreamBody({
    translatedBody: { model: "m", messages },
    modelToCall: "m",
    provider: "uncloseai",
    targetFormat: "claude",
    credentials: null,
  });
  assert.deepEqual(out.messages, messages); // untouched for claude
});

test("strips parallel_tool_calls for cohere (openai)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "command-a-03-2025",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "shell" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    },
    modelToCall: "command-a-03-2025",
    provider: "cohere",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.parallel_tool_calls, undefined);
  assert.ok(Array.isArray(out.tools));
});

test("strips the whole tool trio for publicai (openai)", async () => {
  const out = await prepareUpstreamBody({
    translatedBody: {
      model: "swiss-ai/apertus-8b-instruct",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "shell" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    },
    modelToCall: "swiss-ai/apertus-8b-instruct",
    provider: "publicai",
    targetFormat: "openai",
    credentials: null,
  });
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.parallel_tool_calls, undefined);
});
