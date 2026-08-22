import test from "node:test";
import assert from "node:assert/strict";

// Regression guard: GPT-5.5/Codex Responses streams tag internal reasoning-preamble
// assistant messages with phase "commentary" (e.g. "Need inspect sections. Use Read
// text.") vs phase "final_answer" for the real deliverable. The Responses passthrough
// path drops commentary items (#6199/#6561), but the Responses->OpenAI->Claude
// translation path used by Claude Code subagents did NOT, so commentary text leaked
// into the visible Claude text content block (the "non-content leaking into content"
// symptom). The fix reuses shouldDropResponsesCommentaryEvent in openai-responses.ts.
//
// Drives the real two-hop codex->CC path:
//   translateResponse(OPENAI_RESPONSES /* upstream */, CLAUDE /* client */, chunk, state)

const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

const COMMENTARY_TEXT = "Need inspect sections. Use Read text.";
const ANSWER_TEXT = "parser.ts has one off-by-one bug on line 42.";

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
      blocks.set(ev.index, { type: ev.content_block?.type, text: "" });
    } else if (ev.type === "content_block_delta") {
      const b = blocks.get(ev.index) || { type: "unknown", text: "" };
      const d = ev.delta || {};
      if (typeof d.text === "string") b.text += d.text;
      if (typeof d.thinking === "string") b.text += d.thinking;
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

const completedStop = {
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 20 } },
};

// The commentary item: announced with phase on output_item.added, then its
// output_text.delta / output_text.done / output_item.done carry only item_id.
function commentaryEvents(itemId, text, outputIndex) {
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { type: "message", id: itemId, role: "assistant", phase: "commentary", content: [] },
    },
    { type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text },
    { type: "response.output_text.done", item_id: itemId, output_index: outputIndex, text },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text }],
      },
    },
  ];
}

test("commentary phase before a final_answer: only the answer reaches the visible text block", () => {
  const claude = runCodexToClaude([
    ...commentaryEvents("msg_c", COMMENTARY_TEXT, 0),
    // The real deliverable (phase final_answer), streamed normally.
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_f", role: "assistant", phase: "final_answer", content: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_f", output_index: 1, delta: ANSWER_TEXT },
    completedStop,
  ]);
  const { blocks } = collectBlocks(claude);
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1, "exactly one visible text block (the final answer)");
  assert.equal(text[0].text, ANSWER_TEXT, "the final answer must reach the client");
  // The commentary preamble must not leak into any visible text block.
  for (const b of text) {
    assert.ok(!b.text.includes(COMMENTARY_TEXT), "commentary leaked into visible text");
    assert.ok(!b.text.includes("Need inspect"), "commentary fragment leaked into visible text");
  }
});

test("commentary phase followed by a tool call (no final_answer text): nothing visible leaks", () => {
  const claude = runCodexToClaude([
    ...commentaryEvents("msg_c", COMMENTARY_TEXT, 0),
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "call_1", name: "Read", arguments: "" },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"path":"parser.ts"}',
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 20 } } },
  ]);
  const { blocks, stopReason } = collectBlocks(claude);
  const leaked = blocks.filter((b) => b.type === "text" && b.text.includes(COMMENTARY_TEXT));
  assert.equal(leaked.length, 0, "commentary must not surface as a visible text block");
  assert.ok(
    blocks.some((b) => b.type === "tool_use"),
    "tool_use block must be present"
  );
  assert.equal(stopReason, "tool_use");
});

test("no over-drop: a phase-less assistant message still surfaces as visible text", () => {
  // Older models (or non-commentary items) carry no phase; those must NOT be dropped.
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
  assert.equal(text.length, 1, "phase-less message text must still reach the client");
  assert.equal(text[0].text, ANSWER_TEXT);
});
