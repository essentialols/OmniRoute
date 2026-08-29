import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB state (some transitively-imported modules touch DATA_DIR).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-pii-opaque-"));
process.env.DATA_DIR = tmpDir;

// Reproduce the production config that exposed the bug: PII response
// sanitization ON (redact) + the streaming SSE PII transform active.
process.env.PII_RESPONSE_SANITIZATION = "true";
process.env.PII_TEST_BYPASS_MIN_WINDOW = "true";

import { sanitizePII, sanitizePIIResponse } from "../../src/lib/piiSanitizer.ts";
import { createPiiSseTransform } from "../../src/lib/streamingPiiTransform.ts";

// Real-shape Codex reasoning ciphertext. Base64url uses `-` and `_`, so a chance
// `-pk_<20+ alnum>_` run appears inside it and matches the `api_key_generic`
// pattern. Captured 2026-08-29: redacting that slice made every later turn of the
// conversation fail upstream with 400 `invalid_encrypted_content`.
const CIPHERTEXT =
  "gAAAAABo9XG-pk_ZmFrZWNpcGhlcnRleHQ4OTc_bCiRk5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubxQ==";

// Anthropic thinking-block signature, same round-trip-or-die class.
const SIGNATURE = "ErUBCkYIBRgCKkA+token_aaaaaaaaaaaaaaaaaaaaaaaa+bbbEgxsaWJyYXJ5GgIYAg==";

test("api_key_generic really does match inside the ciphertext (the hazard is live)", () => {
  // If this ever stops matching, the regex changed and the guard below is moot.
  assert.notEqual(
    sanitizePII(CIPHERTEXT, false, true).text,
    CIPHERTEXT,
    "expected the raw text sanitizer to corrupt this blob"
  );
  assert.notEqual(sanitizePII(SIGNATURE, false, true).text, SIGNATURE);
});

test("sanitizePIIResponse leaves opaque round-trip blobs byte-exact", () => {
  const response = {
    id: "resp_1",
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspecting chat history counts" }],
        encrypted_content: CIPHERTEXT,
      },
      {
        type: "thinking",
        thinking: "Contact me at jane.doe@example.com",
        signature: SIGNATURE,
      },
    ],
  };

  const out = sanitizePIIResponse(response, true);

  assert.equal(out.output[0].encrypted_content, CIPHERTEXT);
  assert.equal(out.output[1].signature, SIGNATURE);
  // Control: sanitization is still doing its job on actual model output.
  assert.ok(
    !out.output[1].thinking.includes("jane.doe@example.com"),
    "visible reasoning text must still be redacted"
  );
});

async function pumpThroughPiiTransform(sse: string): Promise<string> {
  const pii = createPiiSseTransform({ forceEnabled: true, windowSize: 8 });
  const enc = new TextEncoder();
  const bytes = enc.encode(sse);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      // Odd stride so events split mid-JSON, mirroring real network framing.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });

  const reader = source.pipeThrough(pii).getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

test("streaming SSE transform leaves reasoning encrypted_content byte-exact", async () => {
  const item = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Inspecting chat history counts" }],
      encrypted_content: CIPHERTEXT,
    },
  };
  const sse =
    `event: response.output_item.done\ndata: ${JSON.stringify(item)}\n\n` + `data: [DONE]\n\n`;

  const out = await pumpThroughPiiTransform(sse);

  assert.ok(
    out.includes(CIPHERTEXT),
    "encrypted_content must survive the streaming PII transform unmodified"
  );
  assert.ok(
    !out.includes("[API_KEY_REDACTED]"),
    "no redaction marker may be spliced into the ciphertext"
  );
});

// Anthropic redacted_thinking carries the same opaque blob under the generic key
// `data`, so the skip is keyed on the containing block's type, not the key alone.
const REDACTED_THINKING_DATA =
  "EroBCoYBCkC+api_ZGVhZGJlZWZkZWFkYmVlZg+dGhpbmtpbmdfYmxvYl9wYXlsb2FkEgxyZWRhY3RlZA==";

test("sanitizePIIResponse leaves redacted_thinking data byte-exact", () => {
  assert.notEqual(
    sanitizePII(REDACTED_THINKING_DATA, false, true).text,
    REDACTED_THINKING_DATA,
    "expected the raw text sanitizer to corrupt this blob"
  );

  const response = {
    id: "msg_1",
    content: [
      { type: "redacted_thinking", data: REDACTED_THINKING_DATA },
      { type: "text", data: "reach me at jane.doe@example.com" },
    ],
  };

  const out = sanitizePIIResponse(response, true);

  assert.equal(out.content[0].data, REDACTED_THINKING_DATA);
  // Control: `data` is only skipped inside a redacted_thinking block, never generally.
  assert.ok(
    !out.content[1].data.includes("jane.doe@example.com"),
    "a data field outside redacted_thinking must still be redacted"
  );
});

test("streaming SSE transform leaves redacted_thinking data byte-exact", async () => {
  const payload = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "redacted_thinking", data: REDACTED_THINKING_DATA },
  };
  const sse =
    `event: content_block_start\ndata: ${JSON.stringify(payload)}\n\n` + `data: [DONE]\n\n`;

  const out = await pumpThroughPiiTransform(sse);

  assert.ok(out.includes(REDACTED_THINKING_DATA), "redacted_thinking data must survive intact");
  assert.ok(!out.includes("[API_KEY_REDACTED]"), "no redaction marker may be spliced in");
});
