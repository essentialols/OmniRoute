import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB state (some transitively-imported modules touch DATA_DIR).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-responses-pii-"));
process.env.DATA_DIR = tmpDir;

// Reproduce the production config that exposed the bug: PII response
// sanitization ON (redact) + the streaming SSE PII transform active.
process.env.PII_RESPONSE_SANITIZATION = "true";
process.env.PII_TEST_BYPASS_MIN_WINDOW = "true";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { createPiiSseTransform } from "../../src/lib/streamingPiiTransform.ts";

const ASSISTANT_TEXT = "Hello! How can I help you today?";
const UPSTREAM_ID = "chatcmpl-6296dc23";

// Content is deliberately chunked into several small deltas; the upstream
// rapid-mlx stream also interleaves `: keepalive` SSE comment lines between
// data events, which we replicate here.
const CONTENT_TOKENS = ["Hello", "! ", "How ", "can ", "I ", "help ", "you ", "today?"];

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

// Build the upstream (chat/completions) SSE exactly as rapid-mlx emits it.
function buildUpstreamSse(): string[] {
  const chunks: string[] = [];
  chunks.push(chatChunk({ role: "assistant" }));
  chunks.push(`: keepalive\n\n`);
  for (const tok of CONTENT_TOKENS) {
    chunks.push(chatChunk({ content: tok }));
    chunks.push(`: keepalive\n\n`);
  }
  // Final chunk: finish_reason + usage.
  chunks.push(
    `data: ${JSON.stringify({
      id: UPSTREAM_ID,
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "M1y",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    })}\n\n`
  );
  chunks.push(`data: [DONE]\n\n`);
  return chunks;
}

// Re-split the byte stream so `data:` events and `: keepalive` comments land
// across chunk boundaries (mirrors real network framing, and is what desyncs a
// buffer-offset-sensitive reframer).
function reframeAcrossBoundaries(sse: string): Uint8Array[] {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  const step = 7; // odd stride, splits mid-line and mid-JSON
  const bytes = enc.encode(sse);
  for (let i = 0; i < bytes.length; i += step) {
    out.push(bytes.slice(i, i + step));
  }
  return out;
}

async function runPipeline(upstreamChunks: string[] = buildUpstreamSse()): Promise<string> {
  // Stage 1: the real chat/completions to Responses-API reframer used by
  // POST /api/v1/responses (stream:true): translate openai to openai-responses.
  const translate = createSSETransformStreamWithLogger(
    "openai", // targetFormat: upstream (rapid-mlx) speaks chat/completions
    "openai-responses", // sourceFormat: client (Responses API) shape
    "rapid-mlx",
    null,
    null,
    "M1y",
    null,
    { model: "M1y" }
  );

  // Stage 2: the streaming PII transform applied by assembleStreamingPipeline
  // for openai-responses clients (forceEnabled mirrors redact mode).
  const pii = createPiiSseTransform({ forceEnabled: true, windowSize: 8 });

  const upstream = upstreamChunks.join("");
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

test("POST /v1/responses streaming: chat to Responses reframe keeps delta/item_id fields intact", async () => {
  const raw = await runPipeline();
  const events = parseSse(raw);

  // The canonical message item id announced by response.output_item.added.
  const addedItem = events.find(
    (e) =>
      e.data?.type === "response.output_item.added" &&
      typeof (e.data.item as { id?: unknown } | undefined)?.id === "string"
  );
  assert.ok(addedItem, "expected a response.output_item.added event with an item id");
  const canonicalItemId = (addedItem!.data.item as { id: string }).id;
  assert.match(
    canonicalItemId,
    /^msg_resp_/,
    `output_item id should be msg_resp_*, got "${canonicalItemId}"`
  );

  const deltaEvents = events.filter((e) => e.data?.type === "response.output_text.delta");
  assert.ok(deltaEvents.length > 0, "expected at least one response.output_text.delta event");

  // (a) Visible text integrity. The PII rolling window can hold back the final
  // window-sized tail and flush it at stream end (same behaviour as the clean
  // chat/completions path), so integrity is judged two ways, both of which the
  // field-scrambling bug breaks:
  //   (a1) the authoritative output_text.done snapshot equals the assistant text;
  //   (a2) every emitted `delta` fragment, concatenated in order, equals it too.
  const doneEvent = events.find((e) => e.data?.type === "response.output_text.done");
  assert.ok(doneEvent, "expected a response.output_text.done snapshot event");
  assert.equal(
    String(doneEvent!.data.text ?? ""),
    ASSISTANT_TEXT,
    `output_text.done snapshot corrupted: got ${JSON.stringify(doneEvent!.data.text)}`
  );
  const visible = events
    .map((e) => (typeof e.data.delta === "string" ? e.data.delta : ""))
    .join("");
  assert.equal(visible, ASSISTANT_TEXT, `visible text corrupted: got ${JSON.stringify(visible)}`);

  // (b) Every item_id must be the proper msg_resp id, never content, never a fragment.
  for (const e of events) {
    if (typeof e.data.item_id === "string") {
      assert.equal(
        e.data.item_id,
        canonicalItemId,
        `item_id corrupted on ${e.data.type}: ${JSON.stringify(e.data.item_id)}`
      );
    }
  }

  // (c) No delta field may contain OmniRoute-internal strings.
  const FOREIGN = ["in_progress", "resp_chatcmpl", "chatcmpl"];
  for (const e of deltaEvents) {
    const d = String(e.data.delta ?? "");
    for (const needle of FOREIGN) {
      assert.ok(
        !d.includes(needle),
        `foreign substring "${needle}" leaked into a delta: ${JSON.stringify(d)}`
      );
    }
  }
});

// --- Function-call (tool-call) streaming path -----------------------------
// Same untagged-structural-string corruption class hit the tool path: on
// response.output_item.added the call_id is a bare non-snapshot string, and the
// function_call_arguments.delta `delta` carries argument JSON (not prose). Both
// were routed through the PII rolling-content buffer and scrambled.

const TOOL_CALL_ID = "call_abc123XYZ";
const TOOL_NAME = "lookup_weather";
const TOOL_ARGS = '{"location":"San Francisco, CA","units":"celsius","days":3}';
// Argument fragments streamed incrementally across separate chunks; deliberately
// not prefixes/supersets of the running buffer, so they append verbatim.
const ARG_FRAGMENTS = ['{"location":"San ', 'Francisco, CA",', '"units":"celsius"', ',"days":3}'];

function buildToolCallUpstreamSse(): string[] {
  const chunks: string[] = [];
  chunks.push(chatChunk({ role: "assistant" }));
  chunks.push(`: keepalive\n\n`);
  // Opening tool-call chunk: id + name, empty arguments.
  chunks.push(
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: TOOL_CALL_ID,
          type: "function",
          function: { name: TOOL_NAME, arguments: "" },
        },
      ],
    })
  );
  chunks.push(`: keepalive\n\n`);
  // Argument fragments, each in its own chunk, interleaved with keepalives.
  for (const frag of ARG_FRAGMENTS) {
    chunks.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: frag } }] }));
    chunks.push(`: keepalive\n\n`);
  }
  chunks.push(
    `data: ${JSON.stringify({
      id: UPSTREAM_ID,
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "M1y",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
    })}\n\n`
  );
  chunks.push(`data: [DONE]\n\n`);
  return chunks;
}

test("POST /v1/responses streaming: chat to Responses reframe keeps call_id/tool-arg fields intact", async () => {
  const raw = await runPipeline(buildToolCallUpstreamSse());
  const events = parseSse(raw);

  // Canonical function_call item id + call_id from response.output_item.added.
  const added = events.find((e) => e.data?.type === "response.output_item.added");
  assert.ok(added, "expected a response.output_item.added event for the function_call");
  const item = added!.data.item as { id?: string; call_id?: string; type?: string };
  assert.equal(item.type, "function_call", "expected a function_call item");
  const canonicalItemId = String(item.id);
  assert.equal(
    item.call_id,
    TOOL_CALL_ID,
    `call_id corrupted on output_item.added: ${item.call_id}`
  );
  assert.equal(canonicalItemId, `fc_${TOOL_CALL_ID}`);

  const argDeltaEvents = events.filter(
    (e) => e.data?.type === "response.function_call_arguments.delta"
  );
  assert.ok(argDeltaEvents.length > 0, "expected function_call_arguments.delta events");

  // (a) call_id identical on every event that carries one; never a fragment/foreign string.
  const collectCallIds = (obj: unknown, out: string[]) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "call_id" && typeof v === "string") out.push(v);
      else if (v && typeof v === "object") collectCallIds(v, out);
    }
  };
  for (const e of events) {
    const ids: string[] = [];
    collectCallIds(e.data, ids);
    for (const id of ids) {
      assert.equal(id, TOOL_CALL_ID, `call_id corrupted on ${e.data.type}: ${JSON.stringify(id)}`);
    }
  }

  // (b) Concatenated function_call_arguments deltas equal the original arguments JSON,
  // and the authoritative .done snapshot matches too.
  const argsVisible = argDeltaEvents.map((e) => String(e.data.delta ?? "")).join("");
  assert.equal(
    argsVisible,
    TOOL_ARGS,
    `tool-arg deltas corrupted: got ${JSON.stringify(argsVisible)}`
  );

  const argsDone = events.find((e) => e.data?.type === "response.function_call_arguments.done");
  assert.ok(argsDone, "expected a response.function_call_arguments.done event");
  assert.equal(
    String(argsDone!.data.arguments ?? ""),
    TOOL_ARGS,
    `function_call_arguments.done corrupted: got ${JSON.stringify(argsDone!.data.arguments)}`
  );

  // (c) item_id is the canonical fc_* id on every event, and no arg delta leaks
  // OmniRoute-internal strings.
  const FOREIGN = ["in_progress", "resp_chatcmpl", "chatcmpl"];
  for (const e of events) {
    if (typeof e.data.item_id === "string") {
      assert.equal(
        e.data.item_id,
        canonicalItemId,
        `item_id corrupted on ${e.data.type}: ${JSON.stringify(e.data.item_id)}`
      );
    }
  }
  for (const e of argDeltaEvents) {
    const d = String(e.data.delta ?? "");
    for (const needle of FOREIGN) {
      assert.ok(
        !d.includes(needle),
        `foreign substring "${needle}" leaked into a tool-arg delta: ${JSON.stringify(d)}`
      );
    }
  }
});
