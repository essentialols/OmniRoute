import test from "node:test";
import assert from "node:assert/strict";

import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";

interface ClaudeEvent {
  type: string;
  index?: number;
  content_block?: { type: string; text?: string };
  delta?: { type: string; text?: string };
}

// Drive a sequence of OpenAI stream chunks through the translator, collecting
// every emitted Claude event.
function run(chunks: unknown[]): ClaudeEvent[] {
  const state: Record<string, unknown> = { toolCalls: new Map() };
  const events: ClaudeEvent[] = [];
  for (const chunk of chunks) {
    const out = openaiToClaudeResponse(chunk, state);
    if (Array.isArray(out)) events.push(...(out as ClaudeEvent[]));
  }
  return events;
}

function textBlockStarts(events: ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "text");
}

function textDeltas(events: ClaudeEvent[]): string[] {
  return events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
    .map((e) => e.delta?.text ?? "");
}

const WHITESPACE_LEADING = ["", null, "\n", " ", "\t", "  \n "];

for (const blank of WHITESPACE_LEADING) {
  test(`tool-only turn with leading content=${JSON.stringify(blank)} emits NO empty text block`, () => {
    const events = run([
      { id: "chatcmpl-1", model: "m", choices: [{ delta: { role: "assistant", content: blank } }] },
      {
        id: "chatcmpl-1",
        model: "m",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "search", arguments: '{"q":"x"}' } },
              ],
            },
          },
        ],
      },
      { id: "chatcmpl-1", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    assert.equal(
      textBlockStarts(events).length,
      0,
      "no text content_block_start should reach the client"
    );
    // A tool_use block should still be present.
    const toolStarts = events.filter(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
    );
    assert.ok(toolStarts.length >= 1, "tool_use block should still be emitted");
  });
}

test("normal text turn still streams text unchanged", () => {
  const events = run([
    { id: "chatcmpl-2", model: "m", choices: [{ delta: { role: "assistant", content: "Hello" } }] },
    { id: "chatcmpl-2", model: "m", choices: [{ delta: { content: " world" } }] },
    { id: "chatcmpl-2", model: "m", choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

  assert.equal(textBlockStarts(events).length, 1, "exactly one text block opened");
  assert.equal(textDeltas(events).join(""), "Hello world", "text streamed byte-identical");
});

test("leading whitespace before real text is preserved (buffered, then flushed)", () => {
  const events = run([
    { id: "chatcmpl-3", model: "m", choices: [{ delta: { role: "assistant", content: "\n" } }] },
    { id: "chatcmpl-3", model: "m", choices: [{ delta: { content: "Answer" } }] },
    { id: "chatcmpl-3", model: "m", choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

  assert.equal(textBlockStarts(events).length, 1, "one text block once real text arrives");
  assert.equal(
    textDeltas(events).join(""),
    "\nAnswer",
    "buffered leading whitespace is flushed with the first real text (no content loss)"
  );
});

// Reasoning-only / content-less finish guard (empty-response fix). Terse local
// models (Ornith) put everything into reasoning_content and then finish without
// emitting any visible content or tool call. Without the guard the client renders
// "(empty response)". The guard emits a minimal, non-empty renderable text block
// instead, but ONLY when nothing visible (text or tool_use) was produced.

for (const finish of ["stop", "length"]) {
  test(`reasoning-only turn (finish=${finish}) emits a non-empty renderable text block`, () => {
    const events = run([
      {
        id: "chatcmpl-r",
        model: "m",
        choices: [
          { delta: { role: "assistant", reasoning_content: "The user wants a subagent." } },
        ],
      },
      { id: "chatcmpl-r", model: "m", choices: [{ delta: { reasoning_content: " Deciding." } }] },
      { id: "chatcmpl-r", model: "m", choices: [{ delta: {}, finish_reason: finish }] },
    ]);

    const starts = textBlockStarts(events);
    assert.equal(starts.length, 1, "exactly one renderable text block is emitted");
    const text = textDeltas(events).join("");
    assert.ok(text.length > 0, "placeholder text must be non-empty (never '(empty response)')");
    assert.notEqual(text, "", "placeholder text must not be a literal empty string");
    // A thinking block should still be present (reasoning is preserved).
    const thinkingStarts = events.filter(
      (e) => e.type === "content_block_start" && e.content_block?.type === "thinking"
    );
    assert.ok(thinkingStarts.length >= 1, "reasoning is still surfaced as a thinking block");
  });
}

test("completely empty turn (no content, no reasoning, no tool) emits a renderable text block", () => {
  const events = run([
    { id: "chatcmpl-e", model: "m", choices: [{ delta: { role: "assistant" } }] },
    { id: "chatcmpl-e", model: "m", choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

  assert.equal(textBlockStarts(events).length, 1, "one renderable text block for an empty turn");
  assert.ok(textDeltas(events).join("").length > 0, "placeholder text is non-empty");
});

test("tool-only turn does NOT get a placeholder text block (guard must not fire)", () => {
  const events = run([
    { id: "chatcmpl-t", model: "m", choices: [{ delta: { role: "assistant", content: "" } }] },
    {
      id: "chatcmpl-t",
      model: "m",
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{}" } }],
          },
        },
      ],
    },
    { id: "chatcmpl-t", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);

  assert.equal(
    textBlockStarts(events).length,
    0,
    "no placeholder text block when a tool_use exists"
  );
  const toolStarts = events.filter(
    (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
  );
  assert.ok(toolStarts.length >= 1, "the tool_use block is the renderable content");
});

test("normal text turn does NOT get a duplicate placeholder block (guard must not fire)", () => {
  const events = run([
    { id: "chatcmpl-n", model: "m", choices: [{ delta: { role: "assistant", content: "Hi" } }] },
    { id: "chatcmpl-n", model: "m", choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

  assert.equal(textBlockStarts(events).length, 1, "exactly one text block (no extra placeholder)");
  assert.equal(textDeltas(events).join(""), "Hi", "text is unchanged");
});
