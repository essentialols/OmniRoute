/**
 * Unit tests for the native Brave Leo executor (open-sse/executors/brave-leo.ts).
 *
 * Covers: model-id mapping (brave-* / claude-brave-* / raw upstream), upstream
 * body construction (content flattening, sampling passthrough, tool gating),
 * HMAC-SHA256 request signing, reasoning-field stripping (JSON + SSE), and the
 * fetch/error paths. Network is fully mocked; no real Brave request is made.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

// Disable the 5s inter-request throttle for fast, deterministic tests.
process.env.BRAVE_LEO_MIN_INTERVAL_MS = "0";

const mod = await import("../../open-sse/executors/brave-leo.ts");
const { BraveLeoExecutor, resolveBraveUpstreamModel, BRAVE_MODEL_MAP } = mod;
const { resolvePublicCred } = await import("../../open-sse/utils/publicCreds.ts");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[], status = 200): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("");
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("resolveBraveUpstreamModel", () => {
  it("maps brave-* aliases to Brave upstream ids", () => {
    assert.equal(resolveBraveUpstreamModel("brave-haiku"), "claude-3-haiku");
    assert.equal(resolveBraveUpstreamModel("brave-glm-5-1"), "near-glm-5-1");
    assert.equal(resolveBraveUpstreamModel("brave-maverick"), "llama-4-maverick");
    assert.equal(resolveBraveUpstreamModel("brave-qwen-235b"), "qwen-3-235b");
    assert.equal(resolveBraveUpstreamModel("brave-glm-flash"), "glm-4-7-flash");
    assert.equal(resolveBraveUpstreamModel("brave-gpt-oss"), "gpt-oss-20b");
    assert.equal(resolveBraveUpstreamModel("brave-llama-8b"), "llama-3-8b-instruct");
  });

  it("normalizes the claude-brave-* CCR shortcut", () => {
    assert.equal(resolveBraveUpstreamModel("claude-brave-haiku"), "claude-3-haiku");
    assert.equal(resolveBraveUpstreamModel("claude-brave-glm-5-1"), "near-glm-5-1");
  });

  it("strips an optional provider prefix", () => {
    assert.equal(resolveBraveUpstreamModel("brave/brave-maverick"), "llama-4-maverick");
  });

  it("passes a raw upstream id through unchanged", () => {
    assert.equal(resolveBraveUpstreamModel("claude-3-haiku"), "claude-3-haiku");
  });

  it("defaults unknown brave-* aliases to the native haiku upstream", () => {
    assert.equal(resolveBraveUpstreamModel("brave-does-not-exist"), "claude-3-haiku");
  });

  it("defaults empty/undefined to haiku upstream", () => {
    assert.equal(resolveBraveUpstreamModel(undefined), "claude-3-haiku");
    assert.equal(resolveBraveUpstreamModel(""), "claude-3-haiku");
  });
});

describe("BraveLeoExecutor.buildUpstreamBody", () => {
  const exec = new BraveLeoExecutor();

  it("sets upstream model, stream, and system_language", () => {
    const out = exec.buildUpstreamBody(
      "brave-haiku",
      { messages: [{ role: "user", content: "hi" }] },
      false
    );
    assert.equal(out.model, "claude-3-haiku");
    assert.equal(out.stream, false);
    assert.equal(out.system_language, "en");
  });

  it("flattens OpenAI content-part arrays to plain text", () => {
    const out = exec.buildUpstreamBody(
      "brave-haiku",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      false
    );
    const msgs = out.messages as Array<{ content: unknown }>;
    assert.equal(msgs[0].content, "ab");
  });

  it("forwards sampling knobs when present", () => {
    const out = exec.buildUpstreamBody(
      "brave-haiku",
      { messages: [], temperature: 0.5, max_tokens: 100, top_p: 0.9 },
      false
    );
    assert.equal(out.temperature, 0.5);
    assert.equal(out.max_tokens, 100);
    assert.equal(out.top_p, 0.9);
  });

  it("keeps tools for native-tool models but drops them otherwise", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    const native = exec.buildUpstreamBody("brave-haiku", { messages: [], tools }, false);
    assert.ok(Array.isArray(native.tools));
    const dsml = exec.buildUpstreamBody("brave-maverick", { messages: [], tools }, false);
    assert.equal(dsml.tools, undefined);
  });
});

describe("BraveLeoExecutor request signing", () => {
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    captured = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch;
  });

  it("computes the HMAC digest + Signature header over the exact body bytes", async () => {
    const exec = new BraveLeoExecutor();
    await exec.execute({
      model: "brave-haiku",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    assert.ok(captured, "fetch should have been called");
    const headers = captured!.init.headers as Record<string, string>;
    const sentBody = captured!.init.body as string;

    // Recompute the expected signature independently.
    const svc = resolvePublicCred("brave_services", "BRAVE_SERVICES_KEY");
    const aichat = resolvePublicCred("brave_aichat", "BRAVE_AICHAT_KEY");
    const expectedDigest =
      "SHA-256=" + createHash("sha256").update(Buffer.from(sentBody)).digest("base64");
    const expectedSig = createHmac("sha256", aichat)
      .update("digest: " + expectedDigest)
      .digest("base64");

    assert.equal(captured!.url, "https://ai-chat.bsg.brave.com/v1/chat/completions");
    assert.equal(headers.digest, expectedDigest);
    assert.equal(headers["x-brave-key"], svc);
    assert.equal(headers.BraveServiceKey, svc);
    assert.ok(headers.Authorization.includes(`signature="${expectedSig}"`));
    assert.ok(headers.Authorization.startsWith("Signature keyId="));
    assert.ok(headers.Authorization.includes('algorithm="hs2019"'));
  });
});

describe("BraveLeoExecutor non-streaming response", () => {
  it("strips reasoning_content and provider_specific_fields", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "x",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Red, blue, green",
              reasoning_content: "internal thoughts",
              provider_specific_fields: { refusal: null },
            },
            provider_specific_fields: { foo: 1 },
          },
        ],
        provider_specific_fields: { bar: 2 },
      })) as typeof fetch;

    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-glm-5-1",
      body: { messages: [{ role: "user", content: "colors" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    const data = (await result.response.json()) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    assert.equal(message.content, "Red, blue, green");
    assert.equal(message.reasoning_content, undefined);
    assert.equal(message.provider_specific_fields, undefined);
    assert.equal(choice.provider_specific_fields, undefined);
    assert.equal(data.provider_specific_fields, undefined);
  });

  it("propagates upstream error status", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "nope" }, 429)) as typeof fetch;
    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-haiku",
      body: { messages: [] },
      stream: false,
      credentials: {},
      signal: null,
    });
    assert.equal(result.response.status, 429);
    const body = (await result.response.json()) as { error: { message: string } };
    assert.ok(!body.error.message.includes("at /"));
  });

  it("returns 502 when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-haiku",
      body: { messages: [] },
      stream: false,
      credentials: {},
      signal: null,
    });
    assert.equal(result.response.status, 502);
  });
});

describe("BraveLeoExecutor streaming response", () => {
  it("forwards content deltas, strips reasoning, and emits [DONE]", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "Re", role: "assistant" } }],
          provider_specific_fields: {},
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "d", reasoning_content: "hmm" } }],
        }),
        "[DONE]",
      ])) as typeof fetch;

    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-haiku",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      signal: null,
    });
    assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
    const text = await result.response.text();
    // Reassemble visible content (the think-stripper may batch a short tail into
    // the flush chunk, so assert on the assembled text, not per-chunk framing).
    let assembled = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]" || !p) continue;
      assembled += JSON.parse(p)?.choices?.[0]?.delta?.content || "";
    }
    assert.equal(assembled, "Red");
    assert.ok(!text.includes("reasoning_content"));
    assert.ok(!text.includes("provider_specific_fields"));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  });

  it("strips inline <think> blocks even when split across chunks", async () => {
    // "<think>reasoning</think>Hello" delivered across arbitrary boundaries,
    // with the tags themselves straddling chunk edges.
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "<thi" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "nk>secret reason" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "ing</thi" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "nk>Hello wor" } }] }),
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "ld" }, finish_reason: "stop" }],
        }),
        "[DONE]",
      ])) as typeof fetch;

    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-glm-5-1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      signal: null,
    });
    const text = await result.response.text();

    // Reassemble the visible content the client would see.
    let assembled = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]" || !p) continue;
      assembled += JSON.parse(p)?.choices?.[0]?.delta?.content || "";
    }
    assert.equal(assembled, "Hello world");
    assert.ok(!text.includes("secret reason"));
    assert.ok(!text.includes("<think>"));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  });
});

describe("BraveLeoExecutor non-streaming <think> stripping", () => {
  it("removes a leading <think> block from message content", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "<think>let me reason about colors</think>Red, blue, green",
            },
          },
        ],
      })) as typeof fetch;
    const exec = new BraveLeoExecutor();
    const result = await exec.execute({
      model: "brave-gpt-oss",
      body: { messages: [{ role: "user", content: "colors" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    const data = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(data.choices[0].message.content, "Red, blue, green");
  });
});

describe("Brave public credentials", () => {
  it("resolves service + aichat keys to the expected shapes", () => {
    const svc = resolvePublicCred("brave_services", "BRAVE_SERVICES_KEY");
    const aichat = resolvePublicCred("brave_aichat", "BRAVE_AICHAT_KEY");
    // Service key: 32-char alphanumeric token.
    assert.match(svc, /^[A-Za-z0-9]{32}$/);
    // AI-chat signing key: 64-char lowercase hex.
    assert.match(aichat, /^[0-9a-f]{64}$/);
  });

  it("BRAVE_MODEL_MAP exposes all seven catalog models", () => {
    assert.equal(Object.keys(BRAVE_MODEL_MAP).length, 7);
  });
});
