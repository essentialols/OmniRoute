import test from "node:test";
import assert from "node:assert/strict";

const { stripBuiltinAgentRoster } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");

// A representative Claude Code roster system message: the "Available agent types"
// header, a mix of built-in (claude, Explore, general-purpose, Plan,
// statusline-setup) and Ornith (balanced/creative/precise/wild) plus the
// operator's custom lowercase explore/plan, then the trailing "When you launch"
// line, then an unrelated "skills" list that must be preserved verbatim.
const ROSTER = [
  "Available agent types for the Agent tool:",
  "- balanced: Local Ornith BALANCED profile. (Tools: All tools)",
  "- claude: Catch-all for any task. (Tools: *)",
  "- creative: Local Ornith CREATIVE profile. (Tools: All tools)",
  "- explore: Custom read-only Ornith explore. (Tools: Read, Grep, Glob, Bash)",
  "- Explore: Read-only search agent. (Tools: All tools except Agent, Edit, Write)",
  "- general-purpose: General-purpose agent. (Tools: *)",
  "- Plan: Software architect agent. (Tools: All tools except Agent, Edit, Write)",
  "- plan: Custom read-only Ornith plan. (Tools: Read, Grep, Glob, Bash)",
  "- precise: Local Ornith PRECISE profile. (Tools: All tools)",
  "- statusline-setup: Configure the status line. (Tools: Read, Edit)",
  "- wild: Local Ornith WILD profile. (Tools: All tools)",
  "",
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
  "",
  "# MCP Server Instructions",
  "",
  "The following skills are available for use with the Skill tool:",
  "- deep-research: Hybrid research pipeline.",
  "- dataviz: Use this skill whenever you create a chart.",
].join("\n");

test("stripBuiltinAgentRoster keeps only whitelisted agents and preserves surrounding blocks", () => {
  const out = stripBuiltinAgentRoster(ROSTER);

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
    ["balanced", "creative", "explore", "general-purpose", "plan", "precise", "wild"].sort(),
    "only whitelisted agents survive"
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

test("stripBuiltinAgentRoster is a no-op when the roster marker is absent", () => {
  const text = "You are Claude Code.\n- balanced: not a roster entry here\n";
  assert.equal(stripBuiltinAgentRoster(text), text);
});
