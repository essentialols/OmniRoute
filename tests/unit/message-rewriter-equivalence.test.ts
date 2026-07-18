import test from "node:test";
import assert from "node:assert/strict";

import {
  stripListBlock,
  applyPreSourceRewrites,
  applyPostTargetRewrites,
  type StripListBlockOp,
  type MessageRewriteRule,
  type RewriteContext,
} from "../../open-sse/services/messageRewriter.ts";

// The roster strip is now handled ONLY by the engine (Hook A / pre-source): the
// hardcoded `stripBuiltinAgentRoster` was REMOVED from claude-to-openai.ts. The
// `strip_list_block` op below is pinned to the CURRENT www agent whitelist
// (code/general/research/explore/plan + the CC built-in `general-purpose`
// fallback). These tests assert the engine produces the correct output directly
// (kept vs dropped), not equivalence to a now-deleted function.
const ROSTER_OP: StripListBlockOp = {
  kind: "strip_list_block",
  marker: "Available agent types for the Agent tool:",
  entryPattern: "^- ([A-Za-z0-9_-]+):",
  whitelist: ["code", "general", "research", "explore", "plan", "general-purpose"],
  caseSensitive: true,
  stopAtFirstNonListLine: true,
};

// ────────────────────────────────────────────────────────────────────────────
// Rule #1 — roster strip correctness (engine only)
// ────────────────────────────────────────────────────────────────────────────

// A representative Claude Code roster: the header, the current www agents
// (code/general/research) + operator custom lowercase explore/plan +
// general-purpose, a mix of CC built-ins to drop (claude/Explore/Plan/
// statusline-setup; case-sensitive), the "When you launch" trailer, and an
// unrelated skills list that must be preserved verbatim.
const CANONICAL_ROSTER = [
  "Available agent types for the Agent tool:",
  "- claude: Catch-all. (Tools: *)",
  "- code: www code agent. (Tools: All)",
  "- Explore: Built-in read-only. (Tools: All)",
  "- explore: Custom read-only. (Tools: Read)",
  "- general: www general agent. (Tools: All)",
  "- general-purpose: General. (Tools: *)",
  "- Plan: Architect. (Tools: All)",
  "- plan: Custom read-only. (Tools: Read)",
  "- research: www research agent. (Tools: All)",
  "- statusline-setup: Configure. (Tools: Read, Edit)",
  "",
  "When you launch multiple agents for independent work, send them in one message.",
  "",
  "The following skills are available for use with the Skill tool:",
  "- deep-research: Hybrid pipeline.",
].join("\n");

// Expected engine output: KEEP code/general/research/explore/plan/general-purpose,
// DROP claude/Explore/Plan/statusline-setup; header + trailer + skills preserved.
const CANONICAL_ROSTER_EXPECTED = [
  "Available agent types for the Agent tool:",
  "- code: www code agent. (Tools: All)",
  "- explore: Custom read-only. (Tools: Read)",
  "- general: www general agent. (Tools: All)",
  "- general-purpose: General. (Tools: *)",
  "- plan: Custom read-only. (Tools: Read)",
  "- research: www research agent. (Tools: All)",
  "",
  "When you launch multiple agents for independent work, send them in one message.",
  "",
  "The following skills are available for use with the Skill tool:",
  "- deep-research: Hybrid pipeline.",
].join("\n");

const ROSTER_FIXTURES: Array<[string, string, string]> = [
  ["canonical roster ending on blank line", CANONICAL_ROSTER, CANONICAL_ROSTER_EXPECTED],
  [
    "block ended by 'When you launch…' line",
    [
      "Available agent types for the Agent tool:",
      "- code: keep. (Tools: All)",
      "- statusline-setup: drop. (Tools: Read)",
      "When you launch multiple agents, send them in one message.",
      "- deep-research: this is a skill, must be preserved.",
    ].join("\n"),
    [
      "Available agent types for the Agent tool:",
      "- code: keep. (Tools: All)",
      "When you launch multiple agents, send them in one message.",
      "- deep-research: this is a skill, must be preserved.",
    ].join("\n"),
  ],
  [
    "block ended by a '#…' heading line",
    [
      "Available agent types for the Agent tool:",
      "- research: keep. (Tools: All)",
      "- claude: drop. (Tools: *)",
      "# MCP Server Instructions",
      "- something: preserved after heading.",
    ].join("\n"),
    [
      "Available agent types for the Agent tool:",
      "- research: keep. (Tools: All)",
      "# MCP Server Instructions",
      "- something: preserved after heading.",
    ].join("\n"),
  ],
  [
    "marker only mentioned in prose ⇒ early-out no-op",
    "See the section 'Available agent types for the Agent tool:' which is inline prose, not a header.",
    "See the section 'Available agent types for the Agent tool:' which is inline prose, not a header.",
  ],
  [
    "no marker at all ⇒ identity",
    "Just a normal system prompt with a - dash: line.",
    "Just a normal system prompt with a - dash: line.",
  ],
  [
    "capitalized built-ins dropped, lowercase customs kept",
    [
      "Available agent types for the Agent tool:",
      "- Explore: drop",
      "- explore: keep",
      "- Plan: drop",
      "- plan: keep",
      "- general-purpose: keep",
      "",
    ].join("\n"),
    [
      "Available agent types for the Agent tool:",
      "- explore: keep",
      "- plan: keep",
      "- general-purpose: keep",
      "",
    ].join("\n"),
  ],
];

for (const [label, input, expected] of ROSTER_FIXTURES) {
  test(`roster strip correctness — ${label}`, () => {
    const engine = stripListBlock(input, ROSTER_OP);
    assert.equal(engine, expected, "engine strip_list_block must produce the correct roster");
  });
}

test("roster strip via applyPreSourceRewrites on a role:system STRING message", () => {
  const rule: MessageRewriteRule = {
    target: { kind: "message", role: "system" },
    op: ROSTER_OP,
  };
  const body = { messages: [{ role: "system", content: CANONICAL_ROSTER }] };
  applyPreSourceRewrites({ sourceFormat: "claude" }, body, [rule]);
  assert.equal(body.messages[0].content, CANONICAL_ROSTER_EXPECTED);
});

// ────────────────────────────────────────────────────────────────────────────
// Rule #2 — billing-header strip byte-equivalence
// ────────────────────────────────────────────────────────────────────────────

// Pinned reference — exact source of `stripAnthropicBillingHeader`
// (claude-to-openai.ts:16-19), which is module-private (not importable).
function legacyStripBillingHeader(text: string): string {
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");
}

const BILLING_OP = {
  kind: "regex_replace" as const,
  pattern: "^x-anthropic-billing-header:[^\\n]*(?:\\r?\\n)?",
  flags: "i",
  replacement: "",
};

const BILLING_FIXTURES = [
  "x-anthropic-billing-header: cc_version=1.0; cch=00000;\nYou are a helpful assistant.",
  "X-Anthropic-Billing-Header: MixedCase; cch=abcde;\r\nrest",
  "no billing header here\nsecond line",
  "x-anthropic-billing-header: trailing-newline-absent",
];

for (const [i, input] of BILLING_FIXTURES.entries()) {
  test(`billing-header byte-equivalence (string system) — fixture ${i}`, () => {
    const body: { system?: unknown } = { system: input };
    applyPreSourceRewrites({ sourceFormat: "claude" }, body, [
      { target: { kind: "system_field" }, op: BILLING_OP },
    ]);
    assert.equal(body.system, legacyStripBillingHeader(input));
  });
}

test("billing-header byte-equivalence across a block-array system (per-entry parity)", () => {
  const blocks = BILLING_FIXTURES.map((t) => ({ type: "text", text: t }));
  const body: { system?: unknown } = { system: blocks.map((b) => ({ ...b })) };
  applyPreSourceRewrites({ sourceFormat: "claude" }, body, [
    { target: { kind: "system_field" }, op: BILLING_OP },
  ]);
  const out = body.system as Array<{ text: string }>;
  out.forEach((block, i) => {
    assert.equal(block.text, legacyStripBillingHeader(BILLING_FIXTURES[i]));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Rule #3 — system-field term sanitizer byte-equivalence
// ────────────────────────────────────────────────────────────────────────────

// Pinned reference — exact source of the sanitizer
// (openai-to-claude.ts:29-41), module-private.
const LEGACY_SANITIZE_MAP: Record<string, string> = { skill_manage: "skill_update" };
function legacySanitizeSystemTextField(text: string): string {
  let result = text;
  for (const [blocked, replacement] of Object.entries(LEGACY_SANITIZE_MAP)) {
    if (result.includes(blocked)) result = result.replaceAll(blocked, replacement);
  }
  return result;
}

const SANITIZE_OP = {
  kind: "replace_list" as const,
  replacements: { skill_manage: "skill_update" },
};

const CLAUDE_TARGET_CTX: RewriteContext = {
  model: "claude-x",
  provider: "anthropic",
  sourceFormat: "openai",
  targetFormat: "claude",
};

test("term-sanitizer byte-equivalence on a result.system block array (replaceAll)", () => {
  const texts = ["use skill_manage twice: skill_manage", "no trigger here", "skill_manageX edge"];
  const result: { system?: unknown } = { system: texts.map((t) => ({ type: "text", text: t })) };
  applyPostTargetRewrites(CLAUDE_TARGET_CTX, result, [
    { phase: "post_target", target: { kind: "system_field" }, op: SANITIZE_OP },
  ]);
  const out = result.system as Array<{ text: string }>;
  out.forEach((block, i) => {
    assert.equal(block.text, legacySanitizeSystemTextField(texts[i]));
  });
});

test("term-sanitizer broadened coverage: claude→claude passthrough is now sanitized (§2 Hook B)", () => {
  // The inline sanitizer only ran on the openai→claude path. The post-target
  // hook keys on targetFormat===claude, so claude→claude ALSO sanitizes now.
  const result: { system?: unknown } = { system: [{ type: "text", text: "skill_manage" }] };
  applyPostTargetRewrites(
    { model: "claude-x", provider: "anthropic", sourceFormat: "claude", targetFormat: "claude" },
    result,
    [{ phase: "post_target", target: { kind: "system_field" }, op: SANITIZE_OP }]
  );
  assert.equal((result.system as Array<{ text: string }>)[0].text, "skill_update");
});
