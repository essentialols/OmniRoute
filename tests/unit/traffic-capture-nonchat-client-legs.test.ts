/**
 * Non-chat client-leg traffic capture (`withNonChatCapture`). The standalone v1
 * endpoints (embeddings, image gen, audio, moderations, rerank) do not flow
 * through the chat pipeline, so this shared route wrapper adds their two CLIENT
 * legs. Guards:
 *
 *   1. A JSON non-chat request emits BOTH client_in and client_out under ONE
 *      correlationId (before/after pairing), provider/model parsed from the body.
 *   2. In-body base64 media in a non-chat request is placeholder-redacted in
 *      client_in (reuses the same scrubBody/redactMediaBlobs path as chat).
 *   3. A multipart/form-data (binary upload) request is captured metadata-only
 *      in client_in (body omitted), under the provider fallback label.
 *   4. Strict no-op when capture is gated off (default): the wrapper does not
 *      even clone the request, and nothing is written.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { withNonChatCapture } = await import("../../src/app/api/v1/_shared/captureNonChat.ts");

const BINARY_MEDIA_MARKER = "[binary-media-omitted]";

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function captureFile(dir: string, provider: string): string {
  return join(dir, provider, `${dateStamp()}.jsonl`);
}

async function waitForEntries(
  file: string,
  min = 1,
  timeoutMs = 3000
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(file, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length >= min) return lines.map((l) => JSON.parse(l));
    } catch {
      // file not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${min} entries in ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function withTmpCaptureDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "omniroute-nonchat-"));
  const prevDir = process.env.OMNIROUTE_CAPTURE_DIR;
  const prevRawcap = process.env.OMNIROUTE_RAWCAP;
  const prevDisabled = process.env.OMNIROUTE_CAPTURE_DISABLED;
  process.env.OMNIROUTE_CAPTURE_DIR = dir;
  delete process.env.OMNIROUTE_CAPTURE_DISABLED;
  try {
    return await fn(dir);
  } finally {
    if (prevDir === undefined) delete process.env.OMNIROUTE_CAPTURE_DIR;
    else process.env.OMNIROUTE_CAPTURE_DIR = prevDir;
    if (prevRawcap === undefined) delete process.env.OMNIROUTE_RAWCAP;
    else process.env.OMNIROUTE_RAWCAP = prevRawcap;
    if (prevDisabled === undefined) delete process.env.OMNIROUTE_CAPTURE_DISABLED;
    else process.env.OMNIROUTE_CAPTURE_DISABLED = prevDisabled;
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonRequest(endpoint: string, body: unknown): Request {
  return new Request(`https://omniroute.local${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("(1) a JSON non-chat request emits client_in + client_out correlated by one id", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const handler = withNonChatCapture(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { endpoint: "/v1/embeddings", providerFallback: "embeddings" }
    );

    const response = await handler(
      jsonRequest("/v1/embeddings", { model: "nebius/Qwen3-Embedding-8B", input: "hello world" })
    );
    assert.equal(response.status, 200, "handler response passes through");
    assert.ok(response.headers.get("X-Correlation-Id"), "correlation id header set on response");

    // provider parsed from `model` ("nebius/…") → both legs land under "nebius".
    const [a, b] = await waitForEntries(captureFile(dir, "nebius"), 2);
    const legs = [a, b];
    const clientIn = legs.find((e) => e.leg === "client_in");
    const clientOut = legs.find((e) => e.leg === "client_out");
    assert.ok(clientIn, "client_in leg present");
    assert.ok(clientOut, "client_out leg present");
    assert.equal(
      clientIn!.correlationId,
      clientOut!.correlationId,
      "both legs share correlationId"
    );
    assert.equal(clientIn!.model, "nebius/Qwen3-Embedding-8B", "model captured on client_in");
    assert.ok((clientIn!.requestBody as string).includes("hello world"), "request text captured");
    assert.equal(clientOut!.responseStatus, 200, "client_out records final status");
    assert.ok((clientOut!.responseBody as string).includes("embedding"), "response body captured");
  });
});

test("(2) in-body base64 media in a non-chat request is placeholder-redacted in client_in", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const base64 = "A".repeat(400);
    const handler = withNonChatCapture(async () => new Response("{}", { status: 200 }), {
      endpoint: "/v1/images/edits",
      providerFallback: "images",
    });

    await handler(
      jsonRequest("/v1/images/edits", {
        model: "openai/dall-e",
        prompt: "make it brighter",
        image: `data:image/png;base64,${base64}`,
      })
    );

    const [entry] = await waitForEntries(captureFile(dir, "openai"), 1);
    const body = entry.requestBody as string;
    assert.ok(body.includes("make it brighter"), "prompt text preserved");
    assert.ok(body.includes("[binary image/png ~"), "media placeholder present");
    assert.ok(!body.includes(base64), "raw base64 blob is NOT persisted");
  });
});

test("(3) a multipart/form-data request is captured metadata-only in client_in", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const form = new FormData();
    form.set("model", "openai/whisper-1");
    form.set("file", new Blob([new Uint8Array([1, 2, 3, 4, 5])]), "audio.mp3");
    const request = new Request("https://omniroute.local/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });

    const handler = withNonChatCapture(
      async () =>
        new Response(JSON.stringify({ text: "transcribed words" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { endpoint: "/v1/audio/transcriptions", providerFallback: "audio" }
    );

    await handler(request);

    // multipart → binary → no model parsed → provider fallback "audio".
    const [a, b] = await waitForEntries(captureFile(dir, "audio"), 2);
    const clientIn = [a, b].find((e) => e.leg === "client_in");
    const clientOut = [a, b].find((e) => e.leg === "client_out");
    assert.ok(clientIn, "client_in leg present");
    assert.equal(clientIn!.requestBody, BINARY_MEDIA_MARKER, "binary upload body omitted");
    assert.ok(clientOut, "client_out leg present");
    assert.ok(
      (clientOut!.responseBody as string).includes("transcribed words"),
      "text response captured"
    );
  });
});

test("(4) capture is a strict no-op when gated off (default)", async () => {
  await withTmpCaptureDir(async (dir) => {
    delete process.env.OMNIROUTE_RAWCAP; // default OFF
    let handlerCalled = false;
    const handler = withNonChatCapture(
      async () => {
        handlerCalled = true;
        return new Response("{}", { status: 200 });
      },
      { endpoint: "/v1/embeddings", providerFallback: "embeddings" }
    );

    const response = await handler(
      jsonRequest("/v1/embeddings", { model: "nebius/x", input: "y" })
    );
    assert.equal(handlerCalled, true, "wrapped handler still runs");
    assert.equal(response.status, 200, "response passes through unchanged");
    assert.equal(
      response.headers.get("X-Correlation-Id"),
      null,
      "no correlation id when gated off"
    );

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await fileExists(captureFile(dir, "nebius")), false, "no capture file written");
    assert.equal(
      await fileExists(captureFile(dir, "embeddings")),
      false,
      "no capture file written"
    );
  });
});
