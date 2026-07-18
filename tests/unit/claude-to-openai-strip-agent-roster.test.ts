import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPreSourceRewrites,
  type MessageRewriteRule,
} from "../../open-sse/services/messageRewriter.ts";

// The hardcoded `stripBuiltinAgentRoster` was REMOVED from claude-to-openai.ts;
// the roster strip is now driven ONLY by the message-rewrite engine (Hook A /
// pre-source) via a `strip_list_block` rule targeting role:"system" messages.
// This rule mirrors the shipped ~/.omniroute/messageRewriteRules.json entry,
// pinned to the CURRENT www agent whitelist (code/general/research/explore/plan)
// plus the Claude Code built-in `general-purpose` fallback.
const ROSTER_RULE: MessageRewriteRule = {
  id: "strip-builtin-agent-roster",
  enabled: true,
  phase: "pre_source",
  match: { model: "ornith|M1y" },
  target: { kind: "message", role: "system" },
  op: {
    kind: "strip_list_block",
    marker: "Available agent types for the Agent tool:",
    entryPattern: "^- ([A-Za-z0-9_-]+):",
    whitelist: ["code", "general", "research", "explore", "plan", "general-purpose"],
    caseSensitive: true,
  },
};

// A representative Claude Code roster system message: the "Available agent types"
// header, the current www agents (code/general/research) + the CC built-in
// general-purpose + operator custom lowercase explore/plan, a mix of CC built-ins
// to drop (claude, Explore, Plan, statusline-setup; case-sensitive), then the
// trailing "When you launch" line, then an unrelated "skills" list that must be
// preserved verbatim.
const ROSTER = [
  "Available agent types for the Agent tool:",
  "- claude: Catch-all for any task. (Tools: *)",
  "- code: www code agent. (Tools: All tools)",
  "- Explore: Read-only search agent. (Tools: All tools except Agent, Edit, Write)",
  "- explore: Custom read-only agent. (Tools: Read, Grep, Glob, Bash)",
  "- general: www general agent. (Tools: All tools)",
  "- general-purpose: General-purpose agent. (Tools: *)",
  "- Plan: Software architect agent. (Tools: All tools except Agent, Edit, Write)",
  "- plan: Custom read-only agent. (Tools: Read, Grep, Glob, Bash)",
  "- research: www research agent. (Tools: All tools)",
  "- statusline-setup: Configure the status line. (Tools: Read, Edit)",
  "",
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
  "",
  "# MCP Server Instructions",
  "",
  "The following skills are available for use with the Skill tool:",
  "- deep-research: Hybrid research pipeline.",
  "- dataviz: Use this skill whenever you create a chart.",
].join("\n");

// Drive the engine exactly as the translator's Hook A does: run the rule against
// a Claude-shaped body carrying the roster as a role:"system" STRING message,
// scoped to an ornith model so the `match` fires.
function stripViaEngine(roster: string): string {
  const body = { messages: [{ role: "system", content: roster }] };
  applyPreSourceRewrites(
    {
      model: "ornith-35b-c-balanced",
      provider: "m2",
      sourceFormat: "claude",
      targetFormat: "openai",
    },
    body,
    [ROSTER_RULE]
  );
  return body.messages[0].content as string;
}

test("engine roster strip keeps only whitelisted agents and preserves surrounding blocks", () => {
  const out = stripViaEngine(ROSTER);

  // Header + trailing guidance + skills list are preserved verbatim.
  assert.ok(out.includes("Available agent types for the Agent tool:"), "header line preserved");
  assert.ok(
    out.includes("When you launch multiple agents for independent work"),
    "trailing multi-agent guidance preserved"
  );
  assert.ok(
    out.includes("The following skills are available for use with the Skill tool:"),
    "skills header preserved"
  );

  // Extract only the agent-roster entry names ("- name:") that appear BEFORE the
  // "When you launch" boundary, so the skills list below is excluded.
  const rosterSection = out.slice(0, out.indexOf("When you launch multiple agents"));
  const keptAgents = [...rosterSection.matchAll(/^- ([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);

  assert.deepEqual(
    keptAgents.sort(),
    ["code", "explore", "general", "general-purpose", "plan", "research"].sort(),
    "only whitelisted agents survive (current www set + general-purpose)"
  );

  // Built-ins are gone (case-sensitive: capitalized Explore/Plan dropped, lowercase kept).
  for (const dropped of ["claude", "statusline-setup"]) {
    assert.ok(!rosterSection.includes(`- ${dropped}:`), `built-in ${dropped} dropped`);
  }
  assert.ok(!rosterSection.includes("- Explore:"), "built-in Explore dropped");
  assert.ok(!rosterSection.includes("- Plan:"), "built-in Plan dropped");
  assert.ok(rosterSection.includes("- explore:"), "custom explore kept");
  assert.ok(rosterSection.includes("- plan:"), "custom plan kept");

  // Skills list entries are never touched even though they use the same "- name:" shape.
  assert.ok(
    out.includes("- deep-research: Hybrid research pipeline."),
    "skill deep-research preserved"
  );
  assert.ok(
    out.includes("- dataviz: Use this skill whenever you create a chart."),
    "skill dataviz preserved"
  );
});

test("engine roster strip is a no-op when the roster marker is absent", () => {
  const text = "You are Claude Code.\n- code: not a roster entry here\n";
  assert.equal(stripViaEngine(text), text);
});

test("engine roster rule does not fire for non-ornith models (model match scope)", () => {
  const body = { messages: [{ role: "system", content: ROSTER }] };
  applyPreSourceRewrites(
    { model: "gpt-4o", provider: "openai", sourceFormat: "claude", targetFormat: "openai" },
    body,
    [ROSTER_RULE]
  );
  // Non-matching model ⇒ roster untouched (built-ins still present).
  assert.equal(body.messages[0].content, ROSTER, "roster untouched for non-ornith model");
});
