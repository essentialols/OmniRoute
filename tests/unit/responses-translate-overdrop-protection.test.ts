import test from "node:test";
import assert from "node:assert/strict";

// Tripwire: over-drop protection for the Codex Responses -> Claude TRANSLATE
// path (open-sse/translator/response/openai-responses.ts, wired in the merge
// of fix/codex-responses-commentary-translation).
//
// The merge makes this path drop `phase: "commentary"` output items via
// shouldDropResponsesCommentaryEvent (open-sse/utils/responsesCommentaryDrop.ts).
// The loud failure mode (commentary leaking into the visible answer) is
// covered by tests/unit/responses-commentary-phase-leak-translation.test.ts.
// This file covers the QUIET, dangerous failure mode: a filter that is too
// aggressive silently eats a REAL answer that merely resembles commentary,
// and the user gets nothing (or a truncated answer) with no visible error.
//
// This is the same failure class that bit `localTurnRecovery`'s ANNOUNCE_RE:
// a correct 200-token answer whose last sentence happened to "announce"
// something got overwritten by a 12-word apology, and only a live incident
// caught it because nothing tested the negative case. See
// tests/unit/local-turn-recovery.test.ts's
// "a LONG correct answer whose last sentence announces is NOT a dead turn".
//
// Every scenario here must reach the client's visible text block
// BYTE-IDENTICAL to what was sent by the upstream. The current drop logic
// (isResponsesCommentaryMessageItem in open-sse/handlers/responseSanitizer.ts)
// keys ONLY off the explicit `phase === "commentary"` field on the item, never
// off text content — these tests lock that property in place. See the "prove
// it" mutation drill in the file header comment at the bottom.

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

// One streamed assistant message, with an OPTIONAL explicit phase (defaults to
// undefined, i.e. what most non-commentary Codex output actually looks like).
function messageTurn(text, { phase, itemId = "msg_1", outputIndex = 0 } = {}) {
  const item = { type: "message", id: itemId, role: "assistant", content: [] };
  if (phase !== undefined) item.phase = phase;
  return [
    { type: "response.output_item.added", output_index: outputIndex, item },
    { type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text },
    completedStop,
  ];
}

function assertSurvivesIntact(events, expectedText, label) {
  const { blocks } = collectBlocks(runCodexToClaude(events));
  const text = blocks.filter((b) => b.type === "text");
  assert.equal(text.length, 1, `${label}: exactly one visible text block`);
  assert.equal(text[0].text, expectedText, `${label}: text must survive byte-identical`);
}

test("over-drop: an answer that begins with a plan then delivers survives intact", () => {
  const text =
    "Plan: read the file, find the bug, then fix it. " +
    "I read parser.ts and found the bug on line 42: an off-by-one in the loop bound.";
  assertSurvivesIntact(messageTurn(text), text, "plan-then-deliver");
});

test("over-drop: an answer whose final sentence announces a next step survives intact", () => {
  const text =
    "The bug is a missing null check in handleRequest(). I've fixed it in the patch below. " +
    "Next, I will run the test suite to confirm.";
  assertSurvivesIntact(messageTurn(text), text, "trailing-announcement");
});

test("over-drop: an answer discussing the word 'commentary' as content survives intact", () => {
  const text =
    "In this codebase, 'commentary' refers to the internal reasoning-preamble phase " +
    "Codex tags on some assistant messages; it is distinct from the final answer.";
  assertSurvivesIntact(messageTurn(text), text, "word-commentary-as-content");
});

test("over-drop: a short terse answer survives intact", () => {
  assertSurvivesIntact(messageTurn("42."), "42.", "terse-answer");
  assertSurvivesIntact(messageTurn("Yes."), "Yes.", "terse-answer-2");
});

test("over-drop: an answer with a code block and tool-ish text survives intact", () => {
  const text =
    "Here is the fix:\n```ts\nfunction read(path: string) {\n  return fs.readFileSync(path, \"utf8\");\n}\n```\n" +
    'It replaces the call `Read({ file_path: "parser.ts" })`.';
  assertSurvivesIntact(messageTurn(text), text, "code-block");
});

// The load-bearing property: the drop is keyed on the explicit `phase` field,
// never on the text itself. Prove it by using the EXACT probe text from the
// merge's own leak-regression test (the real commentary string) but WITHOUT
// the commentary phase — it must still surface, because content resemblance
// is not the signal.
test("over-drop: text identical to the known commentary probe, but phase absent, survives intact", () => {
  const COMMENTARY_PROBE_TEXT = "Need inspect sections. Use Read text.";
  assertSurvivesIntact(messageTurn(COMMENTARY_PROBE_TEXT), COMMENTARY_PROBE_TEXT, "phase-absent");
});

test("over-drop: same probe text with phase explicitly 'final_answer' survives intact", () => {
  const COMMENTARY_PROBE_TEXT = "Need inspect sections. Use Read text.";
  assertSurvivesIntact(
    messageTurn(COMMENTARY_PROBE_TEXT, { phase: "final_answer" }),
    COMMENTARY_PROBE_TEXT,
    "phase-final_answer"
  );
});

// ---------------------------------------------------------------------------
// MUTATION PROOF (manual drill, not run automatically — see deliverable notes):
//
//   1. Edit open-sse/handlers/responseSanitizer.ts:isResponsesCommentaryMessageItem
//      to ALSO return true when the item's text content matches a
//      content-based heuristic, e.g.:
//        const text = JSON.stringify(itemRecord.content ?? "");
//        if (/plan|next|commentary/i.test(text)) return true;
//      (This mirrors the shape of the real ANNOUNCE_RE bug: a keyword-based
//      heuristic on real content.)
//   2. Run this file: every test above whose text contains "plan", "next", or
//      "commentary" goes RED (over-drop reproduced).
//   3. Revert the edit. Run again: all GREEN.
//
// Evidence of this drill is recorded in the delivering agent's report, not
// left in this file, so the aggressive mutant is never checked in.
// ---------------------------------------------------------------------------
