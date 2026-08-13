import test from "node:test";
import assert from "node:assert/strict";

// Baseline characterization guard — written on `main` BEFORE merging
// fix/codex-responses-commentary-translation (b842a6630) and omniroute-setup-audit
// (3ea4c86b5, PR #20). Sibling of responses-to-claude-adjacent-behavior-baseline.test.ts
// (7d2d9e10b), which already pins phase-less-message passthrough and tool_use survival
// on the same real Responses -> OpenAI -> Claude path used by Claude Code subagents.
//
// This file pins the ONE remaining piece of that path's contract those two tests don't
// cover: that a plain (non-commentary) final answer delivered as incremental
// output_text.delta events produces the IDENTICAL visible Claude text as the same
// answer delivered only via the #6570 terminal-snapshot fallback
// (response.output_text.done with no preceding deltas). b842a6630's commentary-drop
// check runs ahead of both branches in openaiResponsesToOpenAIResponseStream — if a
// future change to that early-return widens its match or reorders it relative to the
// #6570 snapshot synthesis, streaming and non-streaming delivery of an ordinary answer
// could silently diverge. Nothing here depends on commentary-drop code (absent on main
// today), so this passes independently of whether either candidate has merged; its job
// is to catch a REGRESSION in this parity after either merge lands.
const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function freshState() {
  return initState(FORMATS.OPENAI_RESPONSES);
}

function runCodexToClaude(events) {
  const state = freshState();
  const out = [];
  for (const ev of events) {
    const res = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state);
    if (Array.isArray(res)) out.push(...res);
  }
  const flush = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state);
  if (Array.isArray(flush)) out.push(...flush);
  return out;
}

function collectText(claudeEvents) {
  const blocks = new Map();
  for (const ev of claudeEvents) {
    if (ev.type === "content_block_start") {
      blocks.set(ev.index, { type: ev.content_block?.type, text: "" });
    } else if (ev.type === "content_block_delta") {
      const b = blocks.get(ev.index) || { type: "unknown", text: "" };
      const d = ev.delta || {};
      if (typeof d.text === "string") b.text += d.text;
      blocks.set(ev.index, b);
    }
  }
  return [...blocks.values()].filter((b) => b.type === "text");
}

const ANSWER_TEXT = "parser.ts has one off-by-one bug on line 42.";

const completedStop = {
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 20 } },
};

test("baseline: streaming delta delivery of a plain final answer", () => {
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_f", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_f", output_index: 0, delta: ANSWER_TEXT },
    completedStop,
  ]);
  const text = collectText(claude);
  assert.equal(text.length, 1, "exactly one visible text block");
  assert.equal(text[0].text, ANSWER_TEXT);
});

test("baseline: non-streaming terminal-snapshot delivery (#6570 fallback, no preceding delta) of the SAME plain final answer", () => {
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_f", role: "assistant", content: [] },
    },
    // No output_text.delta — text is exposed only via the terminal snapshot.
    { type: "response.output_text.done", item_id: "msg_f", output_index: 0, text: ANSWER_TEXT },
    completedStop,
  ]);
  const text = collectText(claude);
  assert.equal(text.length, 1, "exactly one visible text block (the snapshot fallback)");
  assert.equal(text[0].text, ANSWER_TEXT);
});

test("baseline: streaming and non-streaming delivery of a plain final answer are byte-identical", () => {
  const buildEvents = (streaming) => [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_f", role: "assistant", content: [] },
    },
    streaming
      ? { type: "response.output_text.delta", item_id: "msg_f", output_index: 0, delta: ANSWER_TEXT }
      : { type: "response.output_text.done", item_id: "msg_f", output_index: 0, text: ANSWER_TEXT },
    completedStop,
  ];

  const streamed = collectText(runCodexToClaude(buildEvents(true)));
  const snapshot = collectText(runCodexToClaude(buildEvents(false)));

  assert.equal(streamed.length, 1);
  assert.equal(snapshot.length, 1);
  assert.equal(
    streamed[0].text,
    snapshot[0].text,
    "streaming and non-streaming delivery must produce the same visible answer"
  );
  assert.equal(streamed[0].text, ANSWER_TEXT);
});
