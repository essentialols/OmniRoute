import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB state (some transitively-imported modules touch DATA_DIR).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-responses-pii-reasoning-"));
process.env.DATA_DIR = tmpDir;

// Reproduce the production config that exposed the bug: PII response
// sanitization ON (redact) + the streaming SSE PII transform active.
process.env.PII_RESPONSE_SANITIZATION = "true";
process.env.PII_TEST_BYPASS_MIN_WINDOW = "true";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { createPiiSseTransform } from "../../src/lib/streamingPiiTransform.ts";

const REASONING_TEXT = "Let me reason about the user question step by step before answering.";
const ASSISTANT_TEXT = "The answer to your question is definitely forty-two.";
const UPSTREAM_ID = "chatcmpl-reason01";

const REASONING_TOKENS = [
  "Let me ",
  "reason ",
  "about ",
  "the user ",
  "question ",
  "step by step ",
  "before answering.",
];
const CONTENT_TOKENS = [
  "The ",
  "answer ",
  "to your ",
  "question ",
  "is ",
  "definitely ",
  "forty-two.",
];

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const payload = {
    id: UPSTREAM_ID,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "M1y",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// Upstream chat/completions SSE: reasoning_content deltas, then content deltas,
// then a finish snapshot. Interleaved with `: keepalive` comments like rapid-mlx.
function buildUpstreamSse(): string[] {
  const chunks: string[] = [];
  chunks.push(chatChunk({ role: "assistant" }));
  chunks.push(`: keepalive\n\n`);
  for (const tok of REASONING_TOKENS) {
    chunks.push(chatChunk({ reasoning_content: tok }));
    chunks.push(`: keepalive\n\n`);
  }
  for (const tok of CONTENT_TOKENS) {
    chunks.push(chatChunk({ content: tok }));
    chunks.push(`: keepalive\n\n`);
  }
  chunks.push(
    `data: ${JSON.stringify({
      id: UPSTREAM_ID,
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "M1y",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
    })}\n\n`
  );
  chunks.push(`data: [DONE]\n\n`);
  return chunks;
}

function reframeAcrossBoundaries(sse: string): Uint8Array[] {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  const step = 7;
  const bytes = enc.encode(sse);
  for (let i = 0; i < bytes.length; i += step) {
    out.push(bytes.slice(i, i + step));
  }
  return out;
}

async function runPipeline(windowSize: number): Promise<string> {
  const translate = createSSETransformStreamWithLogger(
    "openai",
    "openai-responses",
    "rapid-mlx",
    null,
    null,
    "M1y",
    null,
    { model: "M1y" }
  );
  const pii = createPiiSseTransform({ forceEnabled: true, windowSize });

  const upstream = buildUpstreamSse().join("");
  const inputBytes = reframeAcrossBoundaries(upstream);

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of inputBytes) controller.enqueue(b);
      controller.close();
    },
  });

  const outStream = source.pipeThrough(translate).pipeThrough(pii);
  const reader = outStream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

type SseEvent = { event: string | null; data: Record<string, unknown> };

function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let eventName: string | null = null;
    let dataStr: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
    }
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      events.push({ event: eventName, data: JSON.parse(dataStr) });
    } catch {
      // ignore non-JSON metadata comments
    }
  }
  return events;
}

for (const windowSize of [8, 200]) {
  test(`POST /v1/responses streaming (window=${windowSize}): answer not duplicated, reasoning isolated`, async () => {
    const raw = await runPipeline(windowSize);
    const events = parseSse(raw);

    // (d) Every event's `event:` line must match its data.type. The snapshot-flush
    // bug bolts the window-held tail onto a response.completed / output_item.done
    // payload while the SSE `event:` line still says response.output_text.delta.
    for (const e of events) {
      if (e.event && typeof e.data.type === "string") {
        assert.equal(
          e.event,
          e.data.type,
          `event line "${e.event}" != data.type "${e.data.type}" — framing mismatch`
        );
      }
    }

    // (a) Concatenated visible output_text deltas equal the answer EXACTLY ONCE.
    const outputTextDeltas = events.filter((e) => e.data?.type === "response.output_text.delta");
    const visible = outputTextDeltas.map((e) => String(e.data.delta ?? "")).join("");
    assert.equal(
      visible,
      ASSISTANT_TEXT,
      `visible output_text corrupted/duplicated: got ${JSON.stringify(visible)}`
    );

    // (b) The output_text.done snapshot equals the answer and introduces no extra text.
    const doneEvent = events.find((e) => e.data?.type === "response.output_text.done");
    assert.ok(doneEvent, "expected a response.output_text.done snapshot event");
    assert.equal(
      String(doneEvent!.data.text ?? ""),
      ASSISTANT_TEXT,
      `output_text.done snapshot corrupted: got ${JSON.stringify(doneEvent!.data.text)}`
    );

    // (c) Reasoning text must NEVER appear in any output_text delta or done.
    const reasoningNeedles = ["reason", "step by step", "before answering"];
    for (const e of outputTextDeltas) {
      const d = String(e.data.delta ?? "");
      for (const needle of reasoningNeedles) {
        assert.ok(
          !d.includes(needle),
          `reasoning leaked into output_text.delta: ${JSON.stringify(d)}`
        );
      }
    }
    for (const needle of reasoningNeedles) {
      assert.ok(
        !String(doneEvent!.data.text ?? "").includes(needle),
        `reasoning leaked into output_text.done: ${JSON.stringify(doneEvent!.data.text)}`
      );
    }

    // (c) Reasoning appears in reasoning events, once. Concatenated reasoning
    // summary deltas equal the reasoning text.
    const reasoningDeltas = events.filter(
      (e) => e.data?.type === "response.reasoning_summary_text.delta"
    );
    const reasoningVisible = reasoningDeltas.map((e) => String(e.data.delta ?? "")).join("");
    assert.equal(
      reasoningVisible,
      REASONING_TEXT,
      `reasoning deltas corrupted/duplicated: got ${JSON.stringify(reasoningVisible)}`
    );
  });
}
