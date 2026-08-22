import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Client-side traffic-capture legs (feat: rawcap ①④). Verifies the two
// client-facing legs added on top of the fetch-layer upstream legs (②③):
//   ① client_in  = the RAW client request BEFORE OmniRoute translates it
//   ④ client_out = the FINAL client response AFTER post-processing (incl. the
//                  Responses-API TransformStream reframing)
// correlated with the upstream legs by the SAME correlationId, PII/secret
// scrubbed + capped, tee-safe (never breaks/reorders the real client stream),
// and a strict no-op when the OMNIROUTE_RAWCAP gate is off (default).
//
// As with the upstream-leg test, we pin a controllable inner fetch BEFORE
// importing the seam so the correlation scope + fetch tap stay deterministic.
const CAPTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rawcap-client-"));
process.env.OMNIROUTE_CAPTURE_DIR = CAPTURE_ROOT;

let nextResponse: (input: unknown, init: unknown) => Response = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init: unknown) =>
  nextResponse(input, init)) as unknown as typeof fetch;

const { runWithCapture } = await import("@omniroute/open-sse/utils/providerRequestLogging.ts");
const durableCapture = await import("@omniroute/open-sse/services/durableCapture.ts");
const { createResponsesApiTransformStream } =
  await import("@omniroute/open-sse/transformer/responsesTransformer.ts");
const { captureClientIn, captureClientOut, runWithCaptureContext, isCaptureEnabled } =
  durableCapture;

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

/**
 * Read all capture lines for a provider, waiting until at least `minLines`
 * exist and every teed `client_out`/`upstream` line has flushed its async body.
 */
async function readCaptureLines(
  provider: string,
  minLines = 1,
  timeoutMs = 3000
): Promise<CaptureLine[]> {
  const dir = captureDirFor(provider);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      const lines: CaptureLine[] = [];
      for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), "utf8").trim();
        if (raw) for (const line of raw.split("\n")) lines.push(JSON.parse(line));
      }
      const bodiesFlushed = lines.every((l) => l.leg === "client_in" || l.responseBody !== null);
      if (lines.length >= minLines && bodiesFlushed) return lines;
      if (Date.now() > deadline) return lines;
    } else if (Date.now() > deadline) {
      return [];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run one upstream fetch inside a capture correlation + logging scope (leg ②③). */
async function runScopedUpstreamFetch(opts: {
  provider: string;
  model: string;
  correlationId: string;
  url: string;
  body: string;
  response: Response;
}): Promise<Response> {
  nextResponse = () => opts.response;
  return runWithCaptureContext(
    {
      correlationId: opts.correlationId,
      attempt: 0,
      provider: opts.provider,
      model: opts.model,
      leg: "primary",
      clientHeaders: null,
    },
    () =>
      runWithCapture(noopCapture, async () =>
        globalThis.fetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: opts.body,
        })
      )
  );
}

test("① client_in records the RAW pre-translation client body, correlated with the upstream leg", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  delete process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB;
  const provider = "cap-client-in";
  const correlationId = "corr-in-1";

  // Raw client request in Anthropic /v1/messages shape (pre-translation).
  const rawClientBody = {
    model: "claude-sonnet",
    system: "be terse",
    messages: [{ role: "user", content: "hello" }],
  };
  captureClientIn({
    correlationId,
    provider,
    model: "claude-sonnet",
    endpoint: "/v1/messages",
    clientHeaders: { "content-type": "application/json", "x-api-key": "sk-should-be-scrubbed-xyz" },
    clientBody: rawClientBody,
  });

  // The upstream leg for the SAME request, in TRANSLATED OpenAI chat shape.
  const translatedUpstreamBody = JSON.stringify({
    model: "gpt-x",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ],
  });
  await runScopedUpstreamFetch({
    provider,
    model: "gpt-x",
    correlationId,
    url: "https://api.example.com/v1/chat/completions",
    body: translatedUpstreamBody,
    response: new Response('{"id":"resp_1"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  const lines = await readCaptureLines(provider, 2);
  const clientIn = lines.find((l) => l.leg === "client_in");
  const upstream = lines.find((l) => l.leg === "primary");
  assert.ok(clientIn, "a client_in line was recorded");
  assert.ok(upstream, "an upstream leg was recorded");

  // Both legs share the one correlationId.
  assert.equal(clientIn!.correlationId, correlationId);
  assert.equal(upstream!.correlationId, correlationId);

  // client_in is the RAW client body: carries the Anthropic-only `system` field,
  // and it DIFFERS from the translated upstream body (no `system` key upstream).
  assert.match(String(clientIn!.requestBody), /"system":"be terse"/);
  assert.equal(clientIn!.url, "/v1/messages");
  assert.notEqual(clientIn!.requestBody, upstream!.requestBody);
  assert.ok(
    !String(upstream!.requestBody).includes('"system":'),
    "translated upstream body has no top-level Anthropic `system` field"
  );

  // Client auth header scrubbed (never stored verbatim).
  assert.ok(!JSON.stringify(clientIn!.requestHeaders).includes("sk-should-be-scrubbed-xyz"));
});

test("④ client_out records the final JSON client response, correlated + scrubbed", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "cap-client-out-json";
  const correlationId = "corr-out-json";

  captureClientOut({
    correlationId,
    provider,
    model: "gpt-x",
    endpoint: "/v1/chat/completions",
    response: new Response(
      JSON.stringify({ id: "resp_final", reply: "reach me at eve@example.com" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    ),
  });

  const lines = await readCaptureLines(provider, 1);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.leg, "client_out");
  assert.equal(line.correlationId, correlationId);
  assert.equal(line.responseStatus, 200);
  assert.match(String(line.responseBody), /resp_final/);
  // PII redacted in the client-facing body too.
  assert.ok(!String(line.responseBody).includes("eve@example.com"));
});

test("④ client_out streaming tee does NOT break or reorder the real client stream", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "cap-client-out-stream";
  const correlationId = "corr-out-stream";

  const chunks = [
    'data: {"i":0}\n\n',
    'data: {"i":1}\n\n',
    'data: {"i":2}\n\n',
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  const clientStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const clientResponse = new Response(clientStream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  // Tee for capture, then the caller consumes the ORIGINAL response.
  captureClientOut({
    correlationId,
    provider,
    model: "gpt-x",
    endpoint: "/v1/chat/completions",
    response: clientResponse,
  });

  const clientSeen = await clientResponse.text();
  // The real client stream is intact and in-order after the tee.
  assert.equal(clientSeen, chunks.join(""));

  const lines = await readCaptureLines(provider, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].leg, "client_out");
  assert.equal(lines[0].correlationId, correlationId);
  assert.equal(lines[0].responseBody, chunks.join(""));
});

test("④ client_out captures the Responses-API TransformStream output, tee-safe", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "cap-client-out-responses";
  const correlationId = "corr-out-responses";

  // A minimal upstream OpenAI chat SSE stream, reframed through the REAL
  // Responses-API transformer (the egress seam named in the task).
  const encoder = new TextEncoder();
  const openaiChatSse = [
    'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
    'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const upstreamStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of openaiChatSse) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const responsesApiStream = upstreamStream.pipeThrough(createResponsesApiTransformStream(null));
  const clientResponse = new Response(responsesApiStream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  captureClientOut({
    correlationId,
    provider,
    model: "gpt-x",
    endpoint: "/v1/responses",
    response: clientResponse,
  });

  const clientSeen = await clientResponse.text();
  // The client still receives valid Responses-API framing (not broken/reordered),
  // and the real client stream is NOT mutated by the capture tee.
  assert.match(clientSeen, /event: response\./);
  assert.match(clientSeen, /response\.completed/);
  assert.match(clientSeen, /data: \[DONE\]/);
  assert.match(clientSeen, /"created_at":\d+/, "client stream keeps its real (un-redacted) fields");

  const lines = await readCaptureLines(provider, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].leg, "client_out");
  assert.equal(lines[0].correlationId, correlationId);
  // The captured client_out body is the Responses-API-reframed stream, and it is
  // independently PII-scrubbed (the 10-digit `created_at` reads as a phone number
  // to the redactor), so it diverges from the intact client stream. This proves
  // the capture branch is a separate tee, not the client's own body.
  assert.match(String(lines[0].responseBody), /response\.completed/);
  assert.notEqual(lines[0].responseBody, clientSeen);
});

test("④ withCorrelationId egress seam records client_out with provider/model from headers", async () => {
  process.env.OMNIROUTE_RAWCAP = "1";
  const provider = "openai";
  const correlationId = "corr-egress-seam";
  const { withCorrelationId } = await import("@/sse/handlers/chatHelpers");

  const response = new Response(JSON.stringify({ id: "resp_egress" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "X-OmniRoute-Provider": provider,
      "X-OmniRoute-Model": "gpt-x",
    },
  });

  const returned = withCorrelationId(response, correlationId);
  // The seam is transparent: it still sets X-Correlation-Id and returns a body.
  assert.equal(returned.headers.get("X-Correlation-Id"), correlationId);
  const clientSeen = await returned.text();
  assert.match(clientSeen, /resp_egress/);

  const lines = await readCaptureLines(provider, 1);
  const line = lines.find((l) => l.correlationId === correlationId);
  assert.ok(line, "withCorrelationId emitted a client_out line");
  assert.equal(line!.leg, "client_out");
  assert.equal(line!.provider, provider);
  assert.equal(line!.model, "gpt-x");
  assert.match(String(line!.responseBody), /resp_egress/);
});

test("gate OFF (default) records neither ① nor ④; kill-switch overrides opt-in", async () => {
  delete process.env.OMNIROUTE_RAWCAP;
  assert.equal(isCaptureEnabled(), false, "gate off by default");
  const provider = "cap-client-off";

  captureClientIn({
    correlationId: "corr-off",
    provider,
    model: "m",
    endpoint: "/v1/chat/completions",
    clientHeaders: null,
    clientBody: { model: "m" },
  });
  captureClientOut({
    correlationId: "corr-off",
    provider,
    model: "m",
    endpoint: "/v1/chat/completions",
    response: new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  });

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(captureDirFor(provider)), "no capture dir when gate is off");

  // Kill-switch wins even with the opt-in set.
  process.env.OMNIROUTE_RAWCAP = "1";
  process.env.OMNIROUTE_CAPTURE_DISABLED = "1";
  assert.equal(isCaptureEnabled(), false, "kill-switch overrides opt-in");
  const provider2 = "cap-client-killswitch";
  captureClientIn({
    correlationId: "corr-kill",
    provider: provider2,
    model: "m",
    endpoint: "/v1/chat/completions",
    clientHeaders: null,
    clientBody: { model: "m" },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(captureDirFor(provider2)), "kill-switch: nothing written");
  delete process.env.OMNIROUTE_CAPTURE_DISABLED;
});

test.after(() => {
  try {
    fs.rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
