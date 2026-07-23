import test from "node:test";
import assert from "node:assert/strict";

// #6570 regression guard: Codex (GPT-5.x) Responses streams that surface the visible
// assistant message ONLY as a terminal snapshot (`response.output_text.done` or the
// message `response.output_item.done`, with NO preceding `response.output_text.delta`)
// previously had their whole answer dropped by the Responses->OpenAI hub translator.
// The reasoning channel survived (mapped to a Claude `thinking` block) but the visible
// text did not, so the reasoning-only-finish guard in openai-to-claude rendered the
// turn as the single-char "…" placeholder: the empty-deliverable symptom. The fix adds
// a text done-snapshot fallback symmetric with the #5786 reasoning done-snapshot path.
//
// These assertions drive the real two-hop response path used for codex->CC:
//   translateResponse(OPENAI_RESPONSES /* upstream */, CLAUDE /* client */, chunk, state)
// which chains openaiResponsesToOpenAIResponse -> openaiToClaudeResponse over one shared
// state object.

const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

const REASONING_TEXT = "Weighing the two files before answering.";
const ANSWER_TEXT = "The review found one real bug in parser.ts and two cleanups.";

function freshState() {
  // OPENAI_RESPONSES init is a superset (base + responses fields) sufficient to drive
  // both hub legs in a unit test.
  return initState(FORMATS.OPENAI_RESPONSES);
}

// Feed a list of Responses-API event objects through the codex->Claude hub, then flush.
// Returns the flat list of emitted Claude Messages-SSE event objects.
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

// Reduce Claude SSE events to per-block { type, text } where text is the concatenation of
// this block's text_delta / thinking_delta payloads.
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

const reasoningDelta = {
  type: "response.reasoning_summary_text.delta",
  item_id: "rs_1",
  delta: REASONING_TEXT,
};

const completedStop = {
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 20 } },
};

test("#6570 output_text.done-only: visible answer lands in a Claude text block, not '…'", () => {
  const claude = runCodexToClaude([
    reasoningDelta,
    // Codex emits the message body ONLY as the terminal snapshot (no output_text.delta).
    { type: "response.output_text.done", item_id: "msg_1", text: ANSWER_TEXT },
    completedStop,
  ]);
  const { blocks, stopReason } = collectBlocks(claude);

  const thinking = blocks.filter((b) => b.type === "thinking");
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(thinking.length, 1, "reasoning must be a single thinking block");
  assert.equal(thinking[0].text, REASONING_TEXT);
  assert.equal(text.length, 1, "message text must be exactly one text block");
  assert.equal(text[0].text, ANSWER_TEXT, "the full answer must reach the client");
  assert.notEqual(text[0].text, "…", "must NOT be the empty-deliverable placeholder");
  // Reasoning must never leak into the visible text block.
  assert.ok(!text[0].text.includes(REASONING_TEXT), "reasoning leaked into visible text");
  assert.equal(stopReason, "end_turn");
});

test("#6570 message output_item.done-only: visible answer lands in a Claude text block", () => {
  const claude = runCodexToClaude([
    reasoningDelta,
    // No output_text.delta and no output_text.done; text appears only on the message item.
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: ANSWER_TEXT }],
      },
    },
    completedStop,
  ]);
  const { blocks } = collectBlocks(claude);
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1);
  assert.equal(text[0].text, ANSWER_TEXT);
  assert.ok(blocks.some((b) => b.type === "thinking" && b.text === REASONING_TEXT));
});

test("#6570 reasoning + tool_use with done-only text: thinking, text, and tool_use all present", () => {
  const claude = runCodexToClaude([
    reasoningDelta,
    { type: "response.output_text.done", item_id: "msg_1", text: ANSWER_TEXT },
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: "" },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"parser.ts"}',
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 20 } } },
  ]);
  const { blocks, stopReason } = collectBlocks(claude);
  assert.ok(blocks.some((b) => b.type === "thinking" && b.text === REASONING_TEXT));
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1);
  assert.equal(text[0].text, ANSWER_TEXT, "answer must survive alongside the tool call");
  assert.ok(
    blocks.some((b) => b.type === "tool_use"),
    "tool_use block must be present"
  );
  assert.equal(stopReason, "tool_use");
});

test("#6570 normal streamed deltas + trailing snapshots: text is NOT duplicated", () => {
  const claude = runCodexToClaude([
    reasoningDelta,
    { type: "response.output_text.delta", item_id: "msg_1", delta: "The review found " },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "one real bug." },
    // Trailing full snapshots that the fallback must suppress (deltas already carried text).
    { type: "response.output_text.done", item_id: "msg_1", text: "The review found one real bug." },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "The review found one real bug." }],
      },
    },
    completedStop,
  ]);
  const { blocks } = collectBlocks(claude);
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1, "streamed text must remain a single block");
  assert.equal(
    text[0].text,
    "The review found one real bug.",
    "snapshot fallback must not duplicate already-streamed text"
  );
});
