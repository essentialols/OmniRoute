/**
 * Durable traffic-capture: in-body media redaction + "save it all" (no text
 * truncation by default). Guards two capture requirements:
 *
 *   1. Non-text media embedded INSIDE a normal JSON/chat body (base64 data URIs,
 *      standalone base64 blobs) is replaced with a compact size-annotated
 *      placeholder BEFORE write, so the base64 is never persisted while the
 *      surrounding prompt text stays intact.
 *   2. Text is NOT truncated by default: `OMNIROUTE_CAPTURE_MAX_BODY_KB` unset
 *      (or 0) means unlimited, so a >2 MiB text body is captured in full.
 *
 * Also re-asserts existing behavior: binary-endpoint/content-type responses stay
 * metadata-only, and capture is a strict no-op when gated off (default).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureClientIn, captureUpstreamFromFetch, runWithCaptureContext } =
  await import("../../open-sse/services/durableCapture.ts");

const BINARY_MEDIA_MARKER = "[binary-media-omitted]";
const TRUNCATION_MARKER = "\n…(truncated for capture)";

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function captureFile(dir: string, provider: string): string {
  return join(dir, provider, `${dateStamp()}.jsonl`);
}

/** Poll until `file` has at least `min` JSONL lines (fire-and-forget writes). */
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
  const dir = await mkdtemp(join(tmpdir(), "omniroute-capture-"));
  const prevDir = process.env.OMNIROUTE_CAPTURE_DIR;
  const prevRawcap = process.env.OMNIROUTE_RAWCAP;
  const prevMax = process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB;
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
    if (prevMax === undefined) delete process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB;
    else process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB = prevMax;
    if (prevDisabled === undefined) delete process.env.OMNIROUTE_CAPTURE_DISABLED;
    else process.env.OMNIROUTE_CAPTURE_DISABLED = prevDisabled;
    await rm(dir, { recursive: true, force: true });
  }
}

test("(a) base64 data-URI in a chat body is replaced with a placeholder, prompt text intact", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const base64 = "A".repeat(400); // stands in for encoded PNG bytes
    const provider = "media_data_uri";
    captureClientIn({
      correlationId: "corr-a",
      provider,
      model: "gpt-5.5",
      endpoint: "/v1/chat/completions",
      clientHeaders: { "content-type": "application/json" },
      clientBody: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${base64}` },
              },
            ],
          },
        ],
      },
    });

    const [entry] = await waitForEntries(captureFile(dir, provider));
    const body = entry.requestBody as string;
    assert.ok(body.includes("What is in this image?"), "prompt text preserved");
    assert.ok(body.includes("[binary image/png ~"), "media placeholder present");
    assert.ok(body.includes("omitted]"), "placeholder is well-formed");
    assert.ok(!body.includes(base64), "raw base64 blob is NOT persisted");
    assert.ok(!body.includes("data:image/png;base64,"), "data-URI marker stripped");
  });
});

test("(a2) a standalone base64 output blob (b64_json) is replaced with a placeholder", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const base64 = "Zm9vYmFy".repeat(80); // 640 chars, pure base64, no data-URI prefix
    const provider = "media_b64_json";
    captureClientIn({
      correlationId: "corr-a2",
      provider,
      model: "dall-e",
      endpoint: "/v1/chat/completions", // non-binary endpoint on purpose
      clientHeaders: { "content-type": "application/json" },
      clientBody: { note: "generated image", data: [{ b64_json: base64 }] },
    });

    const [entry] = await waitForEntries(captureFile(dir, provider));
    const body = entry.requestBody as string;
    assert.ok(body.includes("generated image"), "surrounding text preserved");
    assert.ok(body.includes("[binary data ~"), "standalone base64 placeholder present");
    assert.ok(!body.includes(base64), "raw base64 blob is NOT persisted");
  });
});

test("(b) a >2 MiB text body is captured in full (no truncation) under the default", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    delete process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB; // default = unlimited
    const unit = "The quick brown fox jumps over the lazy dog. ";
    const bigText = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length) + 100);
    assert.ok(bigText.length > 2 * 1024 * 1024, "sanity: body exceeds 2 MiB");
    const provider = "big_text";
    captureClientIn({
      correlationId: "corr-b",
      provider,
      model: "gpt-5.5",
      endpoint: "/v1/chat/completions",
      clientHeaders: { "content-type": "application/json" },
      clientBody: { messages: [{ role: "user", content: bigText }] },
    });

    const [entry] = await waitForEntries(captureFile(dir, provider));
    const body = entry.requestBody as string;
    assert.ok(!body.includes(TRUNCATION_MARKER), "text is NOT truncated");
    assert.ok(body.length >= bigText.length, "full text captured");
    assert.ok(body.includes(unit.trim()), "prose content preserved");
  });
});

test("(c) a binary content-type response is captured metadata-only", async () => {
  await withTmpCaptureDir(async (dir) => {
    process.env.OMNIROUTE_RAWCAP = "1";
    const provider = "binary_ct";
    const response = new Response("rawbinarybytespretendpng", {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    runWithCaptureContext(
      { correlationId: "corr-c", attempt: 0, provider, model: "img", leg: "primary" },
      () => {
        captureUpstreamFromFetch({
          url: "https://api.example.com/v1/chat/completions",
          requestHeaders: { "content-type": "application/json" },
          requestBody: JSON.stringify({ prompt: "draw a cat" }),
          response,
          latencyMs: 12,
        });
      }
    );

    const [entry] = await waitForEntries(captureFile(dir, provider));
    assert.equal(entry.responseBody, BINARY_MEDIA_MARKER, "binary body omitted");
    assert.ok((entry.requestBody as string).includes("draw a cat"), "request text still captured");
  });
});

test("(d) capture is a strict no-op when gated off (default)", async () => {
  await withTmpCaptureDir(async (dir) => {
    delete process.env.OMNIROUTE_RAWCAP; // default OFF
    const provider = "gated_off";
    captureClientIn({
      correlationId: "corr-d",
      provider,
      model: "gpt-5.5",
      endpoint: "/v1/chat/completions",
      clientHeaders: { "content-type": "application/json" },
      clientBody: { messages: [{ role: "user", content: "hello" }] },
    });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await fileExists(captureFile(dir, provider)), false, "no capture file written");
  });
});
