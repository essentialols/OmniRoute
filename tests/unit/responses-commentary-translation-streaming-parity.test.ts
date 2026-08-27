import test from "node:test";
import assert from "node:assert/strict";

// Extends the coverage in responses-commentary-phase-leak-translation.test.ts
// (b842a6630) with cases that regression guard doesn't exercise:
//
//   1. A commentary item streamed as MULTIPLE output_text.delta chunks (not
//      just one) — every chunk must be dropped, not just the first.
//   2. A commentary item that never streams a delta at all and is only ever
//      exposed via the terminal `response.output_item.done` snapshot (the
//      #6570 non-streaming fallback path in openai-responses.ts) — must be
//      dropped there too, since the drop check runs before the snapshot
//      branches.
//   3. Streaming vs. non-streaming parity: the same final_answer, delivered
//      either as incremental deltas or as a single terminal snapshot, must
//      produce an identical visible transcript once a commentary item has
//      already been dropped earlier in the same response.
//
// Drives the real two-hop codex->CC path, same harness shape as the sibling
// regression test:
//   translateResponse(OPENAI_RESPONSES /* upstream */, CLAUDE /* client */, chunk, state)

const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

const COMMENTARY_PARTS = ["Need to ", "inspect ", "sections. ", "Use Read text."];
const COMMENTARY_TEXT = COMMENTARY_PARTS.join("");
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

test("multi-chunk streaming commentary: every delta chunk is dropped, none leak", () => {
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_c", role: "assistant", phase: "commentary", content: [] },
    },
    // Stream the commentary text as several separate delta events, the way a
    // real upstream would character/word-chunk it. Every single one must be
    // dropped, not just the first delta for the item.
    ...COMMENTARY_PARTS.map((part) => ({
      type: "response.output_text.delta",
      item_id: "msg_c",
      output_index: 0,
      delta: part,
    })),
    {
      type: "response.output_text.done",
      item_id: "msg_c",
      output_index: 0,
      text: COMMENTARY_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_c",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: COMMENTARY_TEXT }],
      },
    },
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
  assert.equal(text[0].text, ANSWER_TEXT);
  for (const part of COMMENTARY_PARTS) {
    assert.ok(
      !text.some((b) => b.text.includes(part)),
      `commentary chunk "${part}" leaked into visible text`
    );
  }
});

test("non-streaming commentary snapshot (output_item.done only, no deltas) is dropped", () => {
  // Some Codex reasoning models surface the assistant message once at item
  // close, with no preceding output_text.delta/output_text.done events (the
  // #6570 fallback path). A commentary-phase item delivered this way must
  // still be dropped, since the commentary check runs ahead of the snapshot
  // synthesis branches in openaiResponsesToOpenAIResponseStream.
  const claude = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_c", role: "assistant", phase: "commentary", content: [] },
    },
    // No output_text.delta, no output_text.done — text is exposed only here.
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_c",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: COMMENTARY_TEXT }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_f", role: "assistant", content: [] },
    },
    // The final answer is ALSO only exposed via the terminal snapshot, to
    // isolate the non-streaming path end to end.
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "msg_f",
        role: "assistant",
        content: [{ type: "output_text", text: ANSWER_TEXT }],
      },
    },
    completedStop,
  ]);
  const { blocks } = collectBlocks(claude);
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1, "exactly one visible text block (the final answer snapshot)");
  assert.equal(text[0].text, ANSWER_TEXT, "the non-streamed final answer must still reach the client");
  assert.ok(
    !text.some((b) => b.text.includes(COMMENTARY_TEXT)),
    "non-streamed commentary snapshot leaked into visible text"
  );
});

test("streaming and non-streaming final answers are byte-identical once commentary is dropped", () => {
  const buildEvents = (streaming) => [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_c", role: "assistant", phase: "commentary", content: [] },
    },
    streaming
      ? {
          type: "response.output_text.delta",
          item_id: "msg_c",
          output_index: 0,
          delta: COMMENTARY_TEXT,
        }
      : null,
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_c",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: COMMENTARY_TEXT }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_f", role: "assistant", content: [] },
    },
    streaming
      ? { type: "response.output_text.delta", item_id: "msg_f", output_index: 1, delta: ANSWER_TEXT }
      : {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "message",
            id: "msg_f",
            role: "assistant",
            content: [{ type: "output_text", text: ANSWER_TEXT }],
          },
        },
    completedStop,
  ].filter(Boolean);

  const streamed = collectBlocks(runCodexToClaude(buildEvents(true))).blocks.filter(
    (b) => b.type === "text"
  );
  const snapshot = collectBlocks(runCodexToClaude(buildEvents(false))).blocks.filter(
    (b) => b.type === "text"
  );

  assert.equal(streamed.length, 1);
  assert.equal(snapshot.length, 1);
  assert.equal(
    streamed[0].text,
    snapshot[0].text,
    "streaming and non-streaming delivery must produce the same visible answer"
  );
  assert.equal(streamed[0].text, ANSWER_TEXT);
});
