import test from "node:test";
import assert from "node:assert/strict";

// Baseline characterization guard — written on `main` BEFORE merging
// fix/codex-responses-commentary-translation (b842a6630, "drop Codex commentary-phase
// messages in Responses to Claude translation"). That fix edits
// open-sse/translator/response/openai-responses.ts (specifically
// openaiResponsesToOpenAIResponseStream) to drop output_text.delta / .done /
// output_item.done events for items announced with phase "commentary".
//
// This is NOT a test of the commentary-drop behavior itself (that's the fix's own
// regression test). This pins two ADJACENT behaviors of the SAME function, along the
// same real two-hop Responses -> OpenAI -> Claude path used by Claude Code subagents,
// that the fix must NOT change:
//   1. A phase-less assistant message (no `phase` field at all — older/other models)
//      still streams through as visible Claude text.
//   2. A function_call (tool_use) item streams through unaffected, with the
//      tool_use content block and a tool_use stop_reason.
//
// If the merge's early-return for dropped commentary events accidentally widens its
// match (e.g. drops by output_index alone in a way that collides with an unrelated
// item, or the gating logic shadows the tool-call branch), one of these goes red.
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

function collectBlocks(claudeEvents) {
  const blocks = new Map();
  let stopReason = null;
  for (const ev of claudeEvents) {
    if (ev.type === "content_block_start") {
      blocks.set(ev.index, {
        type: ev.content_block?.type,
        text: "",
        name: ev.content_block?.name,
        partialJson: "",
      });
    } else if (ev.type === "content_block_delta") {
      const b = blocks.get(ev.index) || { type: "unknown", text: "", partialJson: "" };
      const d = ev.delta || {};
      if (typeof d.text === "string") b.text += d.text;
      if (typeof d.thinking === "string") b.text += d.thinking;
      if (typeof d.partial_json === "string") b.partialJson += d.partial_json;
      blocks.set(ev.index, b);
    } else if (ev.type === "message_delta") {
      stopReason = ev.delta?.stop_reason ?? stopReason;
    }
  }
  return {
    blocks: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    stopReason,
  };
}

const ANSWER_TEXT = "parser.ts has one off-by-one bug on line 42.";

const completedStop = {
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 20 } },
};

test("baseline: a phase-less assistant message still reaches the visible Claude text block", () => {
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: ANSWER_TEXT },
    completedStop,
  ]);
  const { blocks } = collectBlocks(claude);
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1, "exactly one visible text block");
  assert.equal(text[0].text, ANSWER_TEXT);
});

test("baseline: a function_call (tool_use) item passes through with tool_use stop_reason", () => {
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "Read", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "call_1",
      delta: '{"path":"parser.ts"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"path":"parser.ts"}',
      },
    },
    completedStop,
  ]);
  const { blocks, stopReason } = collectBlocks(claude);
  const toolUse = blocks.filter((b) => b.type === "tool_use");
  assert.equal(toolUse.length, 1, "exactly one tool_use block");
  assert.equal(toolUse[0].name, "Read");
  assert.match(toolUse[0].partialJson, /parser\.ts/);
  assert.equal(stopReason, "tool_use");
});
