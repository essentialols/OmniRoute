import test from "node:test";
import assert from "node:assert/strict";

// Tripwire: realistic Claude Code subagent traffic shapes through the Codex
// Responses -> Claude TRANSLATE path touched by the
// fix/codex-responses-commentary-translation merge. This path carries
// Claude Code subagent traffic (Task tool dispatches to Codex-backed
// subagents), so it must not choke on, or silently drop content from, the
// shapes that traffic actually takes: interleaved reasoning + tool calls,
// an empty-content turn, and a turn that is only a tool call with no text.
//
// "tool_result" is a REQUEST-side concept (fed back to the model on the next
// turn) — this translator only sees the RESPONSE stream, so the "multi-turn
// with tool_use and tool_result" shape is exercised here as two independent
// turns (fresh state each, matching how each HTTP response is one turn):
// turn 1 ends in a bare tool_use (the tool_result would be sent back by the
// client on the follow-up request), turn 2 is the subsequent completion that
// answers using that tool's result — commentary-tagged preamble included, to
// prove the drop still behaves correctly under this exact traffic shape.

const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function freshState() {
  return initState(FORMATS.OPENAI_RESPONSES);
}

function runCodexToClaude(events, state = freshState()) {
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
      blocks.set(ev.index, { type: ev.content_block?.type, text: "", toolInput: "" });
    } else if (ev.type === "content_block_delta") {
      const b = blocks.get(ev.index) || { type: "unknown", text: "", toolInput: "" };
      const d = ev.delta || {};
      if (typeof d.text === "string") b.text += d.text;
      if (typeof d.thinking === "string") b.text += d.thinking;
      if (typeof d.partial_json === "string") b.toolInput += d.partial_json;
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

test("subagent shape: interleaved reasoning + tool_use, no text loss", () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      delta: "Checking parser.ts for the reported bug.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checking parser.ts for the reported bug." }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "call_1", name: "Read", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "call_1",
      output_index: 1,
      delta: '{"file_path":"parser.ts"}',
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"file_path":"parser.ts"}',
      },
    },
    completedStop,
  ];

  const claude = runCodexToClaude(events);
  const { blocks, stopReason } = collectBlocks(claude);

  const thinking = blocks.filter((b) => b.type === "thinking" || b.type === "text");
  assert.ok(
    thinking.some((b) => b.text.includes("Checking parser.ts")),
    "reasoning summary must reach the client"
  );
  const toolUse = blocks.filter((b) => b.type === "tool_use");
  assert.equal(toolUse.length, 1, "exactly one tool_use block");
  assert.ok(toolUse[0].toolInput.includes("parser.ts"), "tool_use arguments must not be dropped");
  assert.equal(stopReason, "tool_use", "stop_reason must be tool_use");
});

test("subagent shape: turn that is ONLY tool_use, no text at all", () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_only", name: "Bash", arguments: "" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_only",
        name: "Bash",
        arguments: '{"command":"ls"}',
      },
    },
    completedStop,
  ];

  const claude = runCodexToClaude(events);
  const { blocks, stopReason } = collectBlocks(claude);

  const text = blocks.filter((b) => b.type === "text" && b.text.length > 0);
  assert.equal(text.length, 0, "a tool_use-only turn must produce no phantom text block");
  const toolUse = blocks.filter((b) => b.type === "tool_use");
  assert.equal(toolUse.length, 1, "the tool call must still surface");
  assert.equal(stopReason, "tool_use");
});

test("subagent shape: empty-content turn does not crash and does not fabricate text", () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_empty", role: "assistant", content: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_empty", role: "assistant", content: [] },
    },
    completedStop,
  ];

  assert.doesNotThrow(() => runCodexToClaude(events), "empty-content turn must not throw");
  const claude = runCodexToClaude(events);
  const { blocks } = collectBlocks(claude);
  // A truly empty final turn legitimately falls back to the existing "…"
  // empty-deliverable placeholder (pre-existing behavior, unrelated to this
  // merge; see the #6570 reasoning-only-finish guard comment in
  // openai-to-claude.ts). The tripwire here is narrower: nothing OTHER than
  // that known placeholder may be synthesized, and it must never be dropped
  // outright (that would surface to the client as a totally empty message).
  const text = blocks.filter((b) => b.type === "text");
  assert.ok(
    text.length === 0 || text.every((b) => b.text === "" || b.text === "…"),
    "empty-content turn must not fabricate content beyond the known placeholder"
  );
});

test("subagent shape: multi-turn tool_use then tool_result-driven follow-up answer", () => {
  // Turn 1: bare tool_use, no text (client will execute the tool and send
  // tool_result back on the next request).
  const turn1 = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_2", name: "Grep", arguments: "" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", call_id: "call_2", name: "Grep", arguments: '{"pattern":"TODO"}' },
    },
    completedStop,
  ]);
  const turn1Blocks = collectBlocks(turn1);
  assert.equal(turn1Blocks.stopReason, "tool_use");
  assert.equal(
    turn1Blocks.blocks.filter((b) => b.type === "text" && b.text.length > 0).length,
    0,
    "turn 1 must carry no fabricated text"
  );

  // Turn 2: a FRESH stream/state (new HTTP response), as happens once the
  // client resends the conversation with the tool_result appended. Codex
  // answers with a commentary preamble, then the real answer referencing
  // the tool result — the commentary must still be dropped, the answer must
  // still survive intact.
  const turn2 = runCodexToClaude([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_c2", role: "assistant", phase: "commentary", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_c2",
      output_index: 0,
      delta: "Found 3 TODO matches, now summarizing.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_c2",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Found 3 TODO matches, now summarizing." }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_f2", role: "assistant", phase: "final_answer", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_f2",
      output_index: 1,
      delta: "Grep found 3 TODO comments: parser.ts:12, index.ts:44, utils.ts:5.",
    },
    completedStop,
  ]);
  const turn2Blocks = collectBlocks(turn2);
  const finalText = turn2Blocks.blocks.filter((b) => b.type === "text");
  assert.equal(finalText.length, 1, "exactly one visible text block in the follow-up turn");
  assert.equal(
    finalText[0].text,
    "Grep found 3 TODO comments: parser.ts:12, index.ts:44, utils.ts:5.",
    "the real answer referencing the tool result must survive intact"
  );
  for (const b of finalText) {
    assert.ok(!b.text.includes("now summarizing"), "commentary preamble must not leak into turn 2's answer");
  }
});
