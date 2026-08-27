import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB state to avoid polluting production database
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-capture-pii-"));
process.env.DATA_DIR = tmpDir;

// Regression: the numeric PII patterns matched bare JSON numbers in serialized
// capture bodies (e.g. `"created_at":1786952404`) and substituted an unquoted
// [PHONE_REDACTED] token, leaving every affected capture line unparseable.

test("redactPIIForCapture keeps serialized JSON parseable", async (t) => {
  const { redactPIIForCapture } = await import("@/lib/piiSanitizer");

  await t.test("bare numeric object value stays valid JSON", () => {
    const body = JSON.stringify({ type: "response.completed", created_at: 1786952404 });
    const out = redactPIIForCapture(body);
    const parsed = JSON.parse(out);
    assert.equal(parsed.type, "response.completed");
    assert.equal(parsed.created_at, "[PHONE_REDACTED]");
  });

  await t.test("bare numeric array element stays valid JSON", () => {
    const body = JSON.stringify({ stamps: [1786952404, 1786952405] });
    JSON.parse(redactPIIForCapture(body));
  });

  await t.test("nested realistic capture envelope stays valid JSON", () => {
    const body = JSON.stringify({
      leg: "primary",
      response: { created_at: 1786952404, usage: { input_tokens: 42367, output_tokens: 522 } },
    });
    const parsed = JSON.parse(redactPIIForCapture(body));
    // Short numbers are not phone-shaped and must survive untouched.
    assert.equal(parsed.response.usage.input_tokens, 42367);
  });

  await t.test("PII inside a string value is still redacted, without extra quotes", () => {
    const body = JSON.stringify({ note: "call 555-123-4567 now" });
    const parsed = JSON.parse(redactPIIForCapture(body));
    assert.equal(parsed.note, "call [PHONE_REDACTED] now");
  });

  await t.test("quoted numeric value is redacted without double-quoting", () => {
    const body = JSON.stringify({ phone: "5551234567" });
    const parsed = JSON.parse(redactPIIForCapture(body));
    assert.equal(parsed.phone, "[PHONE_REDACTED]");
  });

  await t.test("prose is unaffected by the JSON-position rule", () => {
    const out = redactPIIForCapture("Reach me at 555-123-4567.");
    assert.equal(out, "Reach me at [PHONE_REDACTED].");
  });

  await t.test("a float whose integer part is phone-shaped is replaced whole", () => {
    // Matching only the integer half would leave a stray `.5` and break JSON.
    const parsed = JSON.parse(redactPIIForCapture('{"at":1786952404.5}'));
    assert.equal(parsed.at, "[PHONE_REDACTED]");
  });

  await t.test("negative and exponent-form numbers stay valid JSON", () => {
    JSON.parse(redactPIIForCapture('{"a":-1786952404,"b":1786952404e2}'));
  });

  await t.test("comma-separated values inside a string are left unquoted", () => {
    // Real capture shape: NO_PROXY=localhost,127.0.0.1 lives inside a string,
    // so the IP redaction must NOT gain quotes.
    const parsed = JSON.parse(
      redactPIIForCapture(JSON.stringify({ env: "NO_PROXY=localhost,127.0.0.1,foo" }))
    );
    assert.equal(parsed.env, "NO_PROXY=localhost,[IP_REDACTED],foo");
  });
});
