import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPreSourceRewrites,
  applyPostTargetRewrites,
  ruleMatches,
  stripListBlock,
  resetMessageRewriterLogState,
  type MessageRewriteRule,
  type RewriteContext,
} from "../../open-sse/services/messageRewriter.ts";

const CLAUDE_CTX: RewriteContext = {
  model: "ornith-www-1",
  provider: "ornith",
  sourceFormat: "claude",
  targetFormat: "openai",
};

// ────────────────────────────────────────────────────────────────────────────
// Match matrix
// ────────────────────────────────────────────────────────────────────────────

test("ruleMatches: omitted match is a wildcard", () => {
  assert.equal(ruleMatches(CLAUDE_CTX, undefined), true);
  assert.equal(ruleMatches(CLAUDE_CTX, {}), true);
});

test("ruleMatches: model regex match / non-match / invalid", () => {
  assert.equal(ruleMatches(CLAUDE_CTX, { model: "ornith|M1y" }), true);
  assert.equal(ruleMatches(CLAUDE_CTX, { model: "^claude-3" }), false);
  // Invalid regex ⇒ non-match (fail-open), never throws.
  assert.equal(ruleMatches(CLAUDE_CTX, { model: "(" }), false);
});

test("ruleMatches: provider / sourceFormat / targetFormat exact, AND-combined", () => {
  assert.equal(ruleMatches(CLAUDE_CTX, { provider: "ornith" }), true);
  assert.equal(ruleMatches(CLAUDE_CTX, { provider: "openai" }), false);
  assert.equal(ruleMatches(CLAUDE_CTX, { sourceFormat: "claude" }), true);
  assert.equal(ruleMatches(CLAUDE_CTX, { targetFormat: "openai" }), true);
  // AND: all must hold.
  assert.equal(
    ruleMatches(CLAUDE_CTX, { model: "ornith", provider: "ornith", sourceFormat: "claude" }),
    true
  );
  assert.equal(
    ruleMatches(CLAUDE_CTX, { model: "ornith", provider: "wrong", sourceFormat: "claude" }),
    false
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Ops
// ────────────────────────────────────────────────────────────────────────────

function preRule(op: MessageRewriteRule["op"], role = "system"): MessageRewriteRule {
  return { target: { kind: "message", role }, op };
}

test("op regex_replace edits string message content", () => {
  const body = { messages: [{ role: "system", content: "keep x-header: v\nrest" }] };
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    preRule({ kind: "regex_replace", pattern: "x-header: v\\n", flags: "i", replacement: "" }),
  ]);
  assert.equal(body.messages[0].content, "keep rest");
});

test("op replace_list applies replaceAll for each mapping (object + array forms)", () => {
  const bodyObj = { messages: [{ role: "system", content: "a skill_manage b skill_manage" }] };
  applyPreSourceRewrites(CLAUDE_CTX, bodyObj, [
    preRule({ kind: "replace_list", replacements: { skill_manage: "skill_update" } }),
  ]);
  assert.equal(bodyObj.messages[0].content, "a skill_update b skill_update");

  const bodyArr = { messages: [{ role: "system", content: "foo bar" }] };
  applyPreSourceRewrites(CLAUDE_CTX, bodyArr, [
    preRule({
      kind: "replace_list",
      replacements: [
        { from: "foo", to: "F" },
        { from: "bar", to: "B" },
      ],
    }),
  ]);
  assert.equal(bodyArr.messages[0].content, "F B");
});

test("op remove_between removes delimited span (inclusive default)", () => {
  const body = { messages: [{ role: "system", content: "start<!--secret-->end" }] };
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    preRule({ kind: "remove_between", start: "<!--", end: "-->" }),
  ]);
  assert.equal(body.messages[0].content, "startend");
});

test("op inject prepend/append with idempotency", () => {
  const body = { messages: [{ role: "system", content: "core" }] };
  const rule = preRule({ kind: "inject", position: "prepend", text: "PRE\n" });
  applyPreSourceRewrites(CLAUDE_CTX, body, [rule]);
  assert.equal(body.messages[0].content, "PRE\ncore");
  // Idempotent: a second pass does not double-inject.
  applyPreSourceRewrites(CLAUDE_CTX, body, [rule]);
  assert.equal(body.messages[0].content, "PRE\ncore");
});

test("op strip_list_block keeps only whitelisted entries (string form)", () => {
  const input = [
    "Available agent types for the Agent tool:",
    "- balanced: keep",
    "- Explore: drop",
    "",
    "tail",
  ].join("\n");
  const out = stripListBlock(input, {
    kind: "strip_list_block",
    marker: "Available agent types for the Agent tool:",
    entryPattern: "^- ([A-Za-z0-9_-]+):",
    whitelist: ["balanced"],
  });
  assert.equal(
    out,
    ["Available agent types for the Agent tool:", "- balanced: keep", "", "tail"].join("\n")
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Ordering
// ────────────────────────────────────────────────────────────────────────────

test("rules apply in array order", () => {
  const body = { messages: [{ role: "system", content: "AAA" }] };
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    preRule({ kind: "replace_list", replacements: { AAA: "BBB" } }),
    preRule({ kind: "replace_list", replacements: { BBB: "CCC" } }),
  ]);
  assert.equal(body.messages[0].content, "CCC");
});

// ────────────────────────────────────────────────────────────────────────────
// Fail-open + identity
// ────────────────────────────────────────────────────────────────────────────

test("no matching rule ⇒ identical object returned untouched", () => {
  const body = { system: "hello", messages: [{ role: "user", content: "hi" }] };
  const out = applyPreSourceRewrites(CLAUDE_CTX, body, [
    {
      match: { model: "^does-not-match$" },
      target: { kind: "system_field" },
      op: { kind: "regex_replace", pattern: "hello", flags: "", replacement: "X" },
    },
  ]);
  assert.equal(out, body); // same reference
  assert.equal(body.system, "hello"); // untouched
});

test("disabled rule is skipped", () => {
  const body = { messages: [{ role: "system", content: "keep" }] };
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    {
      enabled: false,
      target: { kind: "message", role: "system" },
      op: { kind: "replace_list", replacements: { keep: "GONE" } },
    },
  ]);
  assert.equal(body.messages[0].content, "keep");
});

test("phase routing: pre-source hook ignores post_target rules and vice versa", () => {
  const preBody = { system: "skill_manage" };
  applyPreSourceRewrites(CLAUDE_CTX, preBody, [
    {
      phase: "post_target",
      target: { kind: "system_field" },
      op: { kind: "replace_list", replacements: { skill_manage: "skill_update" } },
    },
  ]);
  assert.equal(preBody.system, "skill_manage"); // post_target rule not run here

  const postBody = { system: "skill_manage" };
  applyPostTargetRewrites({ ...CLAUDE_CTX, targetFormat: "claude" }, postBody, [
    {
      phase: "post_target",
      target: { kind: "system_field" },
      op: { kind: "replace_list", replacements: { skill_manage: "skill_update" } },
    },
  ]);
  assert.equal(postBody.system, "skill_update");
});

test("throwing rule is caught + skipped (fail-open); later rules still run", () => {
  resetMessageRewriterLogState();
  const body = { messages: [{ role: "system", content: "target" }] };
  // A replacements object whose getter throws forces the engine's per-rule catch.
  const boobyTrap = {} as Record<string, string>;
  Object.defineProperty(boobyTrap, "x", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    {
      id: "bad",
      target: { kind: "message", role: "system" },
      op: { kind: "replace_list", replacements: boobyTrap },
    },
    {
      id: "good",
      target: { kind: "message", role: "system" },
      op: { kind: "replace_list", replacements: { target: "OK" } },
    },
  ]);
  assert.equal(body.messages[0].content, "OK");
});

// ────────────────────────────────────────────────────────────────────────────
// Block-preservation + cache_control (review #4)
// ────────────────────────────────────────────────────────────────────────────

test("message rule on mixed block array edits only text, preserves order + cache_control", () => {
  const body = {
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "skill_manage here", cache_control: { type: "ephemeral" } },
          { type: "image", source: { type: "base64", data: "AAA" } },
          { type: "tool_use", id: "t1", name: "run", input: { a: 1 } },
          { type: "tool_result", tool_use_id: "t1", content: "skill_manage" },
          { type: "thinking", thinking: "skill_manage" },
        ],
      },
    ],
  };
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    preRule({ kind: "replace_list", replacements: { skill_manage: "skill_update" } }),
  ]);
  const blocks = body.messages[0].content as Array<Record<string, unknown>>;
  // Order preserved.
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "image", "tool_use", "tool_result", "thinking"]
  );
  // Only the text block's .text edited.
  assert.equal(blocks[0].text, "skill_update here");
  // cache_control preserved on the text block.
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  // Non-text blocks untouched (verbatim, including their inner text-like fields).
  assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", data: "AAA" } });
  assert.deepEqual(blocks[2], { type: "tool_use", id: "t1", name: "run", input: { a: 1 } });
  assert.equal((blocks[3] as { content: string }).content, "skill_manage");
  assert.equal((blocks[4] as { thinking: string }).thinking, "skill_manage");
});

test("system_field rule preserves cache_control + ttl on system blocks (#2069 shape)", () => {
  const result = {
    system: [
      { type: "text", text: "skill_manage", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  applyPostTargetRewrites({ ...CLAUDE_CTX, targetFormat: "claude" }, result, [
    {
      phase: "post_target",
      target: { kind: "system_field" },
      op: { kind: "replace_list", replacements: { skill_manage: "skill_update" } },
    },
  ]);
  assert.deepEqual(result.system[0], {
    type: "text",
    text: "skill_update",
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

test("tool adjacency invariant: tool_use + following tool_result survive a rule pass unchanged", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "grep", input: { q: "x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t9", content: "res" }],
      },
    ],
  };
  const before = JSON.parse(JSON.stringify(body));
  applyPreSourceRewrites(CLAUDE_CTX, body, [
    preRule({ kind: "replace_list", replacements: { nothing: "x" } }, "assistant"),
  ]);
  assert.deepEqual(body, before);
});
