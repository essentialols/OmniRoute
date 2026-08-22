import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tripwire: regression isolation for the PASSTHROUGH stream mode.
//
// The merge of fix/codex-responses-commentary-translation touches ONLY
// open-sse/translator/response/openai-responses.ts (the TRANSLATE-mode
// Responses->Chat hop) plus a new test file. `git diff --numstat <merge>^1
// <merge>` confirms open-sse/utils/stream.ts (which implements
// STREAM_MODE.PASSTHROUGH) was NOT touched. STREAM_MODE.TRANSLATE and
// STREAM_MODE.PASSTHROUGH are supposed to be mutually exclusive branches in
// createSSEStream (see the `mode === STREAM_MODE.PASSTHROUGH` checks in
// open-sse/utils/stream.ts). This file locks PASSTHROUGH's current, correct
// behavior in place so a FUTURE edit that touches shared code (e.g.
// open-sse/utils/responsesCommentaryDrop.ts) while "fixing" TRANSLATE cannot
// silently change PASSTHROUGH without a red test.
//
// This is a golden/snapshot-style test: exact input -> exact expected
// substrings/exclusions in the passthrough SSE output, for a realistic
// Claude-Code-subagent-shaped Responses stream (reasoning + commentary +
// tool call + final answer, interleaved).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-passthrough-isolation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const core = await import("../../src/lib/db/core.ts");

const { createSSEStream } = await import("../../open-sse/utils/stream.ts");

const textEncoder = new TextEncoder();

async function readTransformed(chunks, options) {
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(textEncoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(source.pipeThrough(createSSEStream(options))).text();
}

test.after(() => {
  core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

const COMMENTARY_TEXT = "internal chain-of-thought commentary that must stay hidden";
const REASONING_TEXT = "Thinking about which file to check first.";
const FINAL_TEXT = "The final answer visible to the user.";

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// A realistic Claude-Code-subagent-shaped Responses stream: reasoning, then a
// commentary item (internal, must be dropped), then a tool call, then the
// real final answer.
function buildSubagentShapedStream() {
  return [
    sse({ type: "response.created", response: { id: "resp_iso", output: [] } }),
    sse({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] },
    }),
    sse({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      delta: REASONING_TEXT,
    }),
    sse({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: REASONING_TEXT }] },
    }),
    sse({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "msg_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [],
      },
    }),
    sse({
      type: "response.output_text.delta",
      output_index: 1,
      item_id: "msg_commentary",
      delta: COMMENTARY_TEXT,
    }),
    sse({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "msg_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: COMMENTARY_TEXT }],
      },
    }),
    sse({
      type: "response.output_item.added",
      output_index: 2,
      item: { id: "call_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "" },
    }),
    sse({
      type: "response.output_item.done",
      output_index: 2,
      item: {
        id: "call_1",
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"file_path":"parser.ts"}',
      },
    }),
    sse({
      type: "response.output_item.added",
      output_index: 3,
      item: { id: "msg_final", type: "message", role: "assistant", phase: "final", content: [] },
    }),
    sse({
      type: "response.output_text.delta",
      output_index: 3,
      item_id: "msg_final",
      delta: FINAL_TEXT,
    }),
    sse({
      type: "response.output_item.done",
      output_index: 3,
      item: {
        id: "msg_final",
        type: "message",
        role: "assistant",
        phase: "final",
        content: [{ type: "output_text", text: FINAL_TEXT }],
      },
    }),
    sse({
      type: "response.completed",
      response: {
        id: "resp_iso",
        output: [
          { id: "call_1", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":"parser.ts"}' },
          { id: "msg_final", type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: FINAL_TEXT }] },
        ],
      },
    }),
  ];
}

const PASSTHROUGH_OPTIONS = {
  mode: "passthrough",
  provider: "openai",
  clientResponseFormat: "openai-responses",
  dropResponsesCommentary: true,
};

test("PASSTHROUGH golden: commentary dropped, reasoning/tool/final all forwarded", async () => {
  const output = await readTransformed(buildSubagentShapedStream(), PASSTHROUGH_OPTIONS);

  assert.ok(!output.includes(COMMENTARY_TEXT), "commentary text must be dropped");
  assert.ok(!output.includes("msg_commentary"), "commentary item must be dropped entirely");
  assert.ok(output.includes(REASONING_TEXT), "reasoning must be forwarded unchanged");
  assert.ok(output.includes(FINAL_TEXT), "final answer must be forwarded unchanged");
  assert.ok(output.includes('"call_1"'), "tool call must be forwarded unchanged");
  assert.ok(output.includes("file_path"), "tool call arguments must be forwarded unchanged");
  assert.ok(output.includes("parser.ts"), "tool call argument value must be forwarded unchanged");
});

// ---------------------------------------------------------------------------
// ISOLATION PROOF (manual mutation drill; results recorded in the delivering
// agent's report, not left checked in):
//
//   Mutation A (TRANSLATE-only): neutralize the merge's new drop wiring in
//   open-sse/translator/response/openai-responses.ts (comment out the
//   `if (shouldDropResponsesCommentaryEvent(...)) return null;` block added
//   by the merge). Re-run THIS file: still 100% GREEN, because this file
//   never calls the TRANSLATE-mode function. Proves the merge's TRANSLATE
//   change cannot silently alter PASSTHROUGH.
//
//   Mutation B (PASSTHROUGH-only): neutralize the passthrough call site in
//   open-sse/utils/stream.ts (the `shouldDropResponsesCommentary &&
//   shouldDropResponsesCommentaryEvent(...)` check around line 1334, e.g.
//   force it to `false &&`). Re-run THIS file: RED (commentary leaks
//   through). Proves this test is actually watching the PASSTHROUGH code
//   path and is not vacuously green.
// ---------------------------------------------------------------------------
