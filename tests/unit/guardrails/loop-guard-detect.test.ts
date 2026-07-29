// tests/unit/guardrails/loop-guard-detect.test.ts
// Coverage for the local-model loop detector. This guard is the only thing standing between a
// degenerate local model (Ornith / Gemma re-issuing one action forever) and an agent harness that
// resends the full transcript every turn, so it was shipped with zero tests. Anthropic wire format
// is exercised first: that is what Claude Code sends on /v1/messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMessagesForLoop,
  type LoopGuardDetectConfig,
} from "../../../src/lib/guardrails/loopGuardDetect";

// Mirrors DEFAULT_LOOP_GUARD_CONFIG in src/lib/db/loopGuard.ts.
const CFG: LoopGuardDetectConfig = { window: 6, steerThreshold: 3, stopThreshold: 5 };

function toolUse(name: string, input: unknown) {
  return { role: "assistant", content: [{ type: "tool_use", name, input }] };
}

function text(t: string) {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}

test("anthropic: no loop for distinct actions", () => {
  const messages = [
    toolUse("Read", { file_path: "/a" }),
    toolUse("Read", { file_path: "/b" }),
    toolUse("Grep", { pattern: "x" }),
  ];
  assert.equal(analyzeMessagesForLoop(messages, "anthropic", CFG).decision, "none");
});

test("anthropic: identical tool action repeated 3x in window steers", () => {
  const messages = Array.from({ length: 3 }, () => toolUse("Read", { file_path: "/same" }));
  const r = analyzeMessagesForLoop(messages, "anthropic", CFG);
  assert.equal(r.decision, "steer");
  assert.equal(r.repeatCount, 3);
  assert.ok(r.fingerprint);
});

test("anthropic: identical tool action repeated 5x in window hard-stops", () => {
  const messages = Array.from({ length: 5 }, () => toolUse("Read", { file_path: "/same" }));
  const r = analyzeMessagesForLoop(messages, "anthropic", CFG);
  assert.equal(r.decision, "stop");
  assert.equal(r.repeatCount, 5);
});

// The reason this is frequency-in-window and not a consecutive counter: a model can hold a naive
// counter at zero by alternating a novel no-op action with the repeated one.
test("anthropic: interleaved X,Y,X,Y,X loop is still caught", () => {
  const messages = [
    toolUse("Read", { file_path: "/same" }),
    toolUse("Grep", { pattern: "novel-1" }),
    toolUse("Read", { file_path: "/same" }),
    toolUse("Grep", { pattern: "novel-2" }),
    toolUse("Read", { file_path: "/same" }),
  ];
  const r = analyzeMessagesForLoop(messages, "anthropic", CFG);
  assert.equal(r.decision, "steer");
  assert.equal(r.repeatCount, 3);
});

test("anthropic: repeated short TEXT emission is caught (no tool call needed)", () => {
  const messages = Array.from({ length: 5 }, () => text("OK"));
  assert.equal(analyzeMessagesForLoop(messages, "anthropic", CFG).decision, "stop");
});

test("anthropic: same tool with DIFFERENT args is not a loop", () => {
  const messages = Array.from({ length: 5 }, (_, i) => toolUse("Read", { file_path: `/f${i}` }));
  assert.equal(analyzeMessagesForLoop(messages, "anthropic", CFG).decision, "none");
});

test("window bounds the lookback: old repeats outside the window are ignored", () => {
  const messages = [
    ...Array.from({ length: 3 }, () => toolUse("Read", { file_path: "/old" })),
    ...Array.from({ length: 6 }, (_, i) => toolUse("Grep", { pattern: `p${i}` })),
  ];
  assert.equal(analyzeMessagesForLoop(messages, "anthropic", CFG).decision, "none");
});

test("openai wire format: tool_calls loop is caught", () => {
  const msg = {
    role: "assistant",
    tool_calls: [{ function: { name: "Read", arguments: '{"file_path":"/same"}' } }],
  };
  const messages = Array.from({ length: 5 }, () => msg);
  assert.equal(analyzeMessagesForLoop(messages, "openai", CFG).decision, "stop");
});

test("user messages are ignored (only assistant actions count)", () => {
  const messages = Array.from({ length: 5 }, () => ({
    role: "user",
    content: [{ type: "text", text: "same question" }],
  }));
  assert.equal(analyzeMessagesForLoop(messages, "anthropic", CFG).decision, "none");
});

// Pure + fail-open: the guard must never throw into the request path.
test("malformed input fails open, never throws", () => {
  for (const bad of [null, undefined, [], {}, "str", 42, [null], [{}], [{ role: 1 }]]) {
    assert.equal(analyzeMessagesForLoop(bad, "anthropic", CFG).decision, "none");
  }
});
