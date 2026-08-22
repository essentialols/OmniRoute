import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB state (the transform pulls in DB-backed config on import).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-thinking-textdelta-"));
process.env.DATA_DIR = tmpDir;
// Allow a sub-200 rolling window so the reasoning tail is held back and flushed
// without needing a multi-hundred-char fixture.
process.env.PII_TEST_BYPASS_MIN_WINDOW = "true";

import { createPiiSseTransform } from "../../src/lib/streamingPiiTransform.ts";

type ClaudeEvent = {
  type: string;
  index?: number;
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; thinking?: string };
};

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function pump(transform: TransformStream, input: string): Promise<string> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const writePromise = (async () => {
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  })();
  const chunks: string[] = [];
  let res = await reader.read();
  while (!res.done) {
    chunks.push(new TextDecoder().decode(res.value));
    res = await reader.read();
  }
  await writePromise;
  return chunks.join("");
}

function parseClaudeEvents(output: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]" || payload[0] !== "{") continue;
    try {
      events.push(JSON.parse(payload) as ClaudeEvent);
    } catch {
      // ignore non-JSON data lines
    }
  }
  return events;
}

// Reproduces the ornith / local-MLX failure: a reasoning-first Claude stream whose
// buffered thinking tail is flushed by the PII SSE transform at the thinking->text
// transition. The flush MUST stay a thinking_delta on the thinking block, never a
// text_delta on a thinking block, which Claude Code rejects with
// "Content block is not a text block", forcing a non-streaming retry that doubles load.
test("PII SSE transform never flushes buffered reasoning as text_delta on a thinking block", async () => {
  // Small rolling window so a reasoning tail is guaranteed to be held back and flushed.
  const transform = createPiiSseTransform({ forceEnabled: false, windowSize: 8 });

  const reasoningParts = [
    "WAL keeps a checkpoint",
    " journal so readers proceed",
    " while a writer commits.",
  ];
  const fullReasoning = reasoningParts.join("");
  const textParts = ["WAL improves write concurrency ", "by not blocking readers."];
  const fullText = textParts.join("");

  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    ...reasoningParts.map((thinking) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ...textParts.map((textPiece) => ({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: textPiece },
    })),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];

  const output = await pump(transform, events.map(sse).join(""));
  const parsed = parseClaudeEvents(output);

  // Map block index to started content-block type.
  const blockType = new Map<number, string>();
  for (const ev of parsed) {
    if (ev.type === "content_block_start" && typeof ev.index === "number") {
      blockType.set(ev.index, ev.content_block?.type ?? "");
    }
  }
  assert.equal(blockType.get(0), "thinking");
  assert.equal(blockType.get(1), "text");

  // CORE GUARANTEE: no text_delta may ever target a thinking block.
  for (const ev of parsed) {
    if (ev.type !== "content_block_delta") continue;
    const idx = typeof ev.index === "number" ? ev.index : -1;
    if (ev.delta?.type === "text_delta") {
      assert.notEqual(
        blockType.get(idx),
        "thinking",
        `text_delta emitted on thinking block index ${idx}: ${JSON.stringify(ev)}`
      );
    }
    // A thinking block must only ever carry thinking_delta.
    if (blockType.get(idx) === "thinking") {
      assert.equal(
        ev.delta?.type,
        "thinking_delta",
        `non-thinking_delta on thinking block index ${idx}: ${JSON.stringify(ev)}`
      );
    }
  }

  // The thinking block must be closed before the text block opens.
  const orderedTypes = parsed.map((e) => `${e.type}#${e.index ?? ""}`);
  const thinkingStop = orderedTypes.indexOf("content_block_stop#0");
  const textStart = orderedTypes.indexOf("content_block_start#1");
  assert.ok(thinkingStop >= 0 && textStart >= 0 && thinkingStop < textStart);

  // No reasoning is lost or leaked into the text block: the full reasoning is
  // reconstructable from thinking_delta events on index 0, and the text from
  // text_delta events on index 1.
  let reconThinking = "";
  let reconText = "";
  for (const ev of parsed) {
    if (ev.type !== "content_block_delta") continue;
    if (ev.index === 0 && ev.delta?.type === "thinking_delta") {
      reconThinking += ev.delta.thinking ?? "";
    }
    if (ev.index === 1 && ev.delta?.type === "text_delta") {
      reconText += ev.delta.text ?? "";
    }
  }
  assert.equal(reconThinking, fullReasoning, "reasoning must round-trip on the thinking block");
  assert.ok(reconText.length > 0 && fullText.startsWith(reconText.slice(0, 3)));
});

// Secondary bug: createSseTextTransform used a single once-only `flushed` guard across
// all onFlush call sites. A reasoning->text stream has TWO content_block_stop signals
// (the thinking block's, then the text block's). The thinking stop drained the reasoning
// buffer and set flushed=true, so the text block's stop was blocked by `!flushed` and the
// content buffer's held-back rolling-window tail (the last ~W chars of the ANSWER) was
// never emitted -> the answer was silently truncated. onFlush drains exactly one buffer
// per call and returns null once empty, so it must be allowed to fire on EACH stop.
test("PII SSE transform flushes each block's held-back tail on its own stop (answer tail not dropped or duplicated)", async () => {
  const transform = createPiiSseTransform({ forceEnabled: false, windowSize: 8 });

  const reasoningParts = ["Reasoning about WAL ", "and rollback journals here."];
  const fullReasoning = reasoningParts.join("");
  const textParts = ["WAL lets readers proceed while ", "a writer commits without blocking."];
  const fullText = textParts.join("");

  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    ...reasoningParts.map((thinking) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ...textParts.map((textPiece) => ({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: textPiece },
    })),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];

  const output = await pump(transform, events.map(sse).join(""));
  const parsed = parseClaudeEvents(output);

  const blockType = new Map<number, string>();
  for (const ev of parsed) {
    if (ev.type === "content_block_start" && typeof ev.index === "number") {
      blockType.set(ev.index, ev.content_block?.type ?? "");
    }
  }

  let reconThinking = "";
  let reconText = "";
  for (const ev of parsed) {
    if (ev.type !== "content_block_delta") continue;
    // Primary-fix guard stays enforced: text_delta only ever on a text block.
    if (ev.delta?.type === "text_delta") {
      assert.notEqual(
        blockType.get(typeof ev.index === "number" ? ev.index : -1),
        "thinking",
        `text_delta on thinking block: ${JSON.stringify(ev)}`
      );
    }
    if (ev.index === 0 && ev.delta?.type === "thinking_delta") {
      reconThinking += ev.delta.thinking ?? "";
    }
    if (ev.index === 1 && ev.delta?.type === "text_delta") {
      reconText += ev.delta.text ?? "";
    }
  }

  // The answer's held-back tail must be flushed on the text block's own content_block_stop:
  // present (not dropped) AND exact (not duplicated).
  assert.equal(
    reconText,
    fullText,
    "full answer text must be emitted (tail not dropped, not duplicated)"
  );
  assert.equal(
    reconThinking,
    fullReasoning,
    "full reasoning must round-trip on the thinking block"
  );
});
