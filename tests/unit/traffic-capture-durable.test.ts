import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Durable traffic-capture (feat: rawcap). Verifies the fetch-layer choke point
// records the transformed upstream request + raw upstream response with
// correlation metadata, for ANY code path (including web executors that bypass
// base.ts), with auth headers scrubbed + body PII redacted + a body cap, and
// that it is a strict no-op when the OMNIROUTE_RAWCAP gate is off (default).
//
// The capture wrapper installs itself onto whatever `globalThis.fetch` is at
// the first `runWithCapture` call, so we pin a controllable stub BEFORE importing
// the seam. We intentionally do NOT import proxyFetch/chatCore here so the native
// fetch is not replaced by the proxy patch (keeps the stub deterministic).
const CAPTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rawcap-"));
process.env.OMNIROUTE_CAPTURE_DIR = CAPTURE_ROOT;

// A single mutable inner-fetch stub. `installFetchCapture` binds the CURRENT
// global fetch as its inner fetch on first use, so this must be set before the
// seam module is imported and the first scope runs.
let nextResponse: (input: unknown, init: unknown) => Response = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init: unknown) =>
  nextResponse(input, init)) as unknown as typeof fetch;

const { runWithCapture } = await import("@omniroute/open-sse/utils/providerRequestLogging.ts");
const durableCapture = await import("@omniroute/open-sse/services/durableCapture.ts");
const { runWithCaptureContext, isCaptureEnabled, redactPIIForCapture } = {
  runWithCaptureContext: durableCapture.runWithCaptureContext,
  isCaptureEnabled: durableCapture.isCaptureEnabled,
  redactPIIForCapture: (await import("@/lib/piiSanitizer")).redactPIIForCapture,
};

// Minimal Capture object (the request-logging feature is exercised elsewhere).
const noopCapture = {
  capture() {},
  body(fallback: unknown) {
    return fallback;
  },
  latest() {
    return null;
  },
};

type CaptureLine = Record<string, unknown>;

function captureDirFor(provider: string): string {
  return path.join(CAPTURE_ROOT, provider);
}

async function readCaptureLines(provider: string, timeoutMs = 3000): Promise<CaptureLine[]> {
  const dir = captureDirFor(provider);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      if (files.length > 0) {
        const lines: CaptureLine[] = [];
        for (const f of files) {
          const raw = fs.readFileSync(path.join(dir, f), "utf8").trim();
          if (raw) {
            for (const line of raw.split("\n")) lines.push(JSON.parse(line));
          }
        }
        // Wait until the response body has been flushed (fire-and-forget microtask).
        if (lines.every((l) => l.responseBody !== null || l.responseBody === undefined)) {
          return lines;
        }
      }
    }
    if (Date.now() > deadline) {
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .flatMap((f) =>
              fs
                .readFileSync(path.join(dir, f), "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l) as CaptureLine)
            )
        : [];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run one upstream fetch inside a capture correlation + logging scope. */
async function runScopedFetch(opts: {
  provider: string;
  model: string;
  correlationId: string;
  attempt: number;
  leg: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  response: Response;
}): Promise<Response> {
  nextResponse = () => opts.response;
  return runWithCaptureContext(
    {
      correlationId: opts.correlationId,
      attempt: opts.attempt,
      provider: opts.provider,
      model: opts.model,
      leg: opts.leg,
      clientHeaders: null,
    },
    () =>
      runWithCapture(noopCapture, async () =>
        globalThis.fetch(opts.url, {
          method: "POST",
          headers: opts.headers,
          body: opts.body,
        })
      )
  );
}

test("(a) fetch choke point records transformed request + response + correlationId + attempt", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  delete process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB;
  const provider = "cap-openai";
  const reqBody = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] });

  await runScopedFetch({
    provider,
    model: "gpt-x",
    correlationId: "corr-abc-123",
    attempt: 2,
    leg: "primary",
    url: "https://api.example.com/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: reqBody,
    response: new Response('{"id":"resp_1","object":"chat.completion"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  const lines = await readCaptureLines(provider);
  assert.equal(lines.length, 1, "exactly one capture line");
  const line = lines[0];
  assert.equal(line.correlationId, "corr-abc-123");
  assert.equal(line.attempt, 2);
  assert.equal(line.leg, "primary");
  assert.equal(line.provider, provider);
  assert.equal(line.model, "gpt-x");
  assert.equal(line.url, "https://api.example.com/v1/chat/completions");
  assert.equal(line.responseStatus, 200);
  // Transformed upstream request body captured.
  assert.match(String(line.requestBody), /"model":"gpt-x"/);
  // Raw upstream response body captured.
  assert.match(String(line.responseBody), /resp_1/);
});

test("(b) web-executor-style path (bypasses base.ts) is still captured at the fetch seam", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "deepseek-web";
  // Simulate a web executor: it overrides execute() and never calls super/base.ts,
  // it just dispatches through globalThis.fetch directly. The seam must still see it.
  const webExecutorExecute = async () =>
    globalThis.fetch("https://chat.deepseek.example/completion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello from web executor" }),
    });

  nextResponse = () =>
    new Response('{"answer":"web-ok"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await runWithCaptureContext(
    {
      correlationId: "corr-web-9",
      attempt: 0,
      provider,
      model: "deepseek-chat",
      leg: "primary",
      clientHeaders: null,
    },
    () => runWithCapture(noopCapture, webExecutorExecute)
  );

  const lines = await readCaptureLines(provider);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].provider, "deepseek-web");
  assert.equal(lines[0].correlationId, "corr-web-9");
  assert.match(String(lines[0].requestBody), /web executor/);
  assert.match(String(lines[0].responseBody), /web-ok/);
});

test("(c) auth headers scrubbed, body PII redacted, and body cap enforced", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB = "1"; // 1 KiB cap
  const provider = "cap-secure";
  // Prose filler (with spaces) so it is NOT mistaken for a base64 media blob by
  // the in-body media redaction (which strips only long pure-base64 runs); this
  // keeps the test exercising the size CAP path. > 1 KiB forces truncation.
  const bigFiller = "lorem ipsum dolor sit amet ".repeat(200);
  const reqBody = JSON.stringify({
    model: "m",
    email: "alice@example.com",
    note: bigFiller,
  });

  await runScopedFetch({
    provider,
    model: "m",
    correlationId: "corr-sec",
    attempt: 0,
    leg: "primary",
    url: "https://api.secure.example/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-supersecret-token-value-1234567890",
      cookie: "session=abcdef123456; csrf=zzz",
    },
    body: reqBody,
    response: new Response(JSON.stringify({ reply: "contact bob@example.com or 123-45-6789" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB = ""; // reset for later tests
  const lines = await readCaptureLines(provider);
  assert.equal(lines.length, 1);
  const line = lines[0];

  // Auth headers scrubbed (never stored verbatim).
  const reqHeaders = line.requestHeaders as Record<string, string>;
  assert.ok(!JSON.stringify(reqHeaders).includes("sk-supersecret-token-value-1234567890"));
  assert.ok(!JSON.stringify(reqHeaders).includes("abcdef123456"));
  assert.ok(
    reqHeaders.authorization === undefined || !reqHeaders.authorization.includes("supersecret")
  );

  // Body PII redacted in both request and response.
  assert.ok(!String(line.requestBody).includes("alice@example.com"));
  assert.match(String(line.requestBody), /\[EMAIL_REDACTED\]/);
  assert.ok(!String(line.responseBody).includes("bob@example.com"));
  assert.ok(!String(line.responseBody).includes("123-45-6789"));

  // Body cap enforced (truncation marker present, filler not stored whole).
  assert.match(String(line.requestBody), /truncated for capture/);
  assert.ok(String(line.requestBody).length < reqBody.length);
});

test("(d) capture is a strict no-op when the gate is off (default)", async () => {
  delete process.env.OMNIROUTE_RAWCAP;
  assert.equal(isCaptureEnabled(), false, "gate off by default");
  const provider = "cap-off";

  await runScopedFetch({
    provider,
    model: "m",
    correlationId: "corr-off",
    attempt: 0,
    leg: "primary",
    url: "https://api.off.example/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
    response: new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  // Give any (erroneous) async write a chance to land, then assert nothing wrote.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(captureDirFor(provider)), "no capture dir when gate is off");
});

test("(e) OMNIROUTE_CAPTURE_DISABLED hard kill-switch overrides the opt-in", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  process.env.OMNIROUTE_CAPTURE_DISABLED = "1";
  assert.equal(isCaptureEnabled(), false, "kill-switch wins over opt-in");
  delete process.env.OMNIROUTE_CAPTURE_DISABLED;
});

test("(f) binary media endpoints capture metadata only, not the base64 body", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "cap-audio";

  await runScopedFetch({
    provider,
    model: "tts-1",
    correlationId: "corr-audio",
    attempt: 0,
    leg: "primary",
    url: "https://api.example.com/v1/audio/speech",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tts-1", input: "hello" }),
    response: new Response("BINARYAUDIOBYTES".repeat(50), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }),
  });

  const lines = await readCaptureLines(provider);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].responseStatus, 200);
  assert.equal(lines[0].responseBody, "[binary-media-omitted]");
  assert.ok(!String(lines[0].responseBody).includes("BINARYAUDIOBYTES"));
});

test("(g) redactPIIForCapture redacts unconditionally and never throws", () => {
  const input = "reach me at carol@example.com or 555-123-4567, ssn 123-45-6789";
  const out = redactPIIForCapture(input);
  assert.ok(!out.includes("carol@example.com"));
  assert.match(out, /\[EMAIL_REDACTED\]/);
  assert.ok(!out.includes("123-45-6789"));
  // Non-string / empty inputs are safe.
  assert.equal(redactPIIForCapture(""), "");
  assert.doesNotThrow(() => redactPIIForCapture("no pii here"));
});

test.after(() => {
  try {
    fs.rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
