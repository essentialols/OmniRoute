/**
 * TDD (RED -> GREEN) for the local-model loop-guard guardrail.
 * Run: node --import tsx/esm --test tests/unit/guardrails/loopGuard.test.ts
 *
 * Contract: LoopGuardGuardrail.preCall() wraps the pure analyzeMessagesForLoop()
 * detector into a request-side guardrail. When a matching local model is stuck in
 * an agentic loop it appends a steering (steer) or terminal (stop) message to
 * payload.messages, and on stop forces tool_choice to none so the model must
 * finalize. It is fail-open: disabled config, non-matching model, or malformed
 * payload all yield a no-op { block:false } with no payload mutation, and it never
 * throws. Config is injected here (deps.getConfig) so the test needs no SQLite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LoopGuardGuardrail } from "../../../src/lib/guardrails/loopGuard.ts";
import type { LoopGuardConfig } from "../../../src/lib/db/loopGuard.ts";
import type { GuardrailContext } from "../../../src/lib/guardrails/base.ts";

// ─── config + guardrail builders ──────────────────────────────────────────────

function config(overrides: Partial<LoopGuardConfig> = {}): LoopGuardConfig {
  return {
    enabled: true,
    window: 6,
    steerThreshold: 3,
    stopThreshold: 5,
    modelPattern: "ornith|M1y|gemma",
    ...overrides,
  };
}

function guardrail(overrides: Partial<LoopGuardConfig> = {}) {
  return new LoopGuardGuardrail({ deps: { getConfig: () => config(overrides) } });
}

// ─── payload builders ─────────────────────────────────────────────────────────

function anthropicToolMsg(name: string, input: Record<string, unknown>) {
  return { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] };
}
function anthropicResult(text: string) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] };
}
function anthropicLoopBody(n: number, model = "ornith-35b") {
  const messages: unknown[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < n; i++) {
    messages.push(anthropicToolMsg("Bash", { command: "ls" }));
    messages.push(anthropicResult(`r${i}`));
  }
  return { model, system: "you are a coder", messages, tools: [{ name: "Bash" }] };
}

function openaiToolMsg(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}
function openaiResult(text: string) {
  return { role: "tool", tool_call_id: "c", content: text };
}
function openaiLoopBody(n: number, model = "gemma-4-26b") {
  const messages: unknown[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < n; i++) {
    messages.push(openaiToolMsg("Bash", { command: "ls" }));
    messages.push(openaiResult(`r${i}`));
  }
  return { model, messages, tools: [{ type: "function", function: { name: "Bash" } }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object", "expected a modifiedPayload object");
  return value as Record<string, unknown>;
}
function lastMessage(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  assert.ok(Array.isArray(messages), "messages must be an array");
  return messages[messages.length - 1] as Record<string, unknown>;
}

// ─── (a) steer: Anthropic loop at steer threshold ─────────────────────────────

describe("LoopGuardGuardrail: steer", () => {
  it("Anthropic loop at steerThreshold appends a steering user message, tools untouched", async () => {
    const body = anthropicLoopBody(3);
    const context: GuardrailContext = { model: "ornith-35b", sourceFormat: "claude" };
    const result = await guardrail().preCall(body, context);

    assert.equal(result?.block, false);
    const modified = asRecord(result?.modifiedPayload);
    // one message appended (steer nudge), original 7 -> 8
    assert.equal((modified.messages as unknown[]).length, (body.messages as unknown[]).length + 1);
    const nudge = lastMessage(modified);
    assert.equal(nudge.role, "user");
    assert.match(String(nudge.content), /Loop guard/);
    assert.match(String(nudge.content), /materially different/);
    assert.match(String(nudge.content), /Bash/);
    // steer must NOT force tool_choice, and tools must be preserved verbatim
    assert.equal(modified.tool_choice, undefined);
    assert.deepEqual(modified.tools, body.tools);
    // input payload not mutated (frozen-input safety)
    assert.equal((body.messages as unknown[]).length, 7);
  });
});

// ─── (b) stop: Anthropic loop at stop threshold ───────────────────────────────

describe("LoopGuardGuardrail: stop (Anthropic)", () => {
  it("Anthropic loop at stopThreshold appends terminal message AND sets tool_choice none", async () => {
    const body = anthropicLoopBody(5);
    const context: GuardrailContext = { model: "ornith-35b" };
    const result = await guardrail().preCall(body, context);

    assert.equal(result?.block, false);
    const modified = asRecord(result?.modifiedPayload);
    const nudge = lastMessage(modified);
    assert.equal(nudge.role, "user");
    assert.match(String(nudge.content), /Loop guard/);
    assert.match(String(nudge.content), /final answer/);
    assert.match(String(nudge.content), /Bash/);
    assert.deepEqual(modified.tool_choice, { type: "none" });
    assert.deepEqual(modified.tools, body.tools);
  });
});

// ─── (c) stop: OpenAI-format loop ─────────────────────────────────────────────

describe("LoopGuardGuardrail: stop (OpenAI)", () => {
  it('OpenAI loop at stopThreshold appends terminal message AND sets tool_choice "none"', async () => {
    const body = openaiLoopBody(5);
    // no sourceFormat -> format derived from payload shape (tool_calls => openai)
    const result = await guardrail().preCall(body, { model: "gemma-4-26b" });

    assert.equal(result?.block, false);
    const modified = asRecord(result?.modifiedPayload);
    const nudge = lastMessage(modified);
    assert.equal(nudge.role, "system");
    assert.match(String(nudge.content), /Loop guard/);
    assert.match(String(nudge.content), /final answer/);
    assert.equal(modified.tool_choice, "none");
  });
});

// ─── (d) non-matching model → no-op ───────────────────────────────────────────

describe("LoopGuardGuardrail: model gate", () => {
  it("non-matching model (gpt-5) is a no-op even when clearly looping", async () => {
    const body = openaiLoopBody(5, "gpt-5");
    const result = await guardrail().preCall(body, { model: "gpt-5" });
    assert.deepEqual(result, { block: false });
    // payload untouched
    assert.equal((body.messages as unknown[]).length, 11);
  });
});

// ─── (e) malformed payload → fail-open, no throw ──────────────────────────────

describe("LoopGuardGuardrail: fail-open on malformed input", () => {
  it("non-object payload does not throw", async () => {
    const result = await guardrail().preCall(42, { model: "ornith-35b" });
    assert.deepEqual(result, { block: false });
  });

  it("messages not an array does not throw", async () => {
    const body = { model: "ornith-35b", messages: { nope: true } };
    const result = await guardrail().preCall(body, { model: "ornith-35b" });
    assert.deepEqual(result, { block: false });
  });

  it("null payload does not throw", async () => {
    const result = await guardrail().preCall(null, { model: "ornith-35b" });
    assert.deepEqual(result, { block: false });
  });
});

// ─── (f) disabled config → no-op ──────────────────────────────────────────────

describe("LoopGuardGuardrail: disabled config", () => {
  it("disabled config is a no-op even for a matching, looping model", async () => {
    const body = anthropicLoopBody(5);
    const result = await guardrail({ enabled: false }).preCall(body, { model: "ornith-35b" });
    assert.deepEqual(result, { block: false });
    assert.equal((body.messages as unknown[]).length, 11);
  });
});
