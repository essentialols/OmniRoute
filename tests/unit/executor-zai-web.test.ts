// Tests for the Z.ai web executor (chat.z.ai, free guest/session cookie auth).
//
// Pins: token extraction, X-FE-Version header, the live v2 endpoint, guest-token
// auto-mint when no cookie is supplied, dual-shape SSE frame parsing (internal
// `{type:"chat:completion",data:{delta_content,phase}}` envelope + pass-through
// OpenAI `choices[].delta`), upstream-error-frame surfacing (403 / CAPTCHA / 426),
// and streaming + non-streaming aggregation.
//
// Endpoint/version/guest facts were confirmed by direct probe of chat.z.ai:
//   - GET /api/v1/auths/            → anonymous role:guest JWT (no account)
//   - POST /api/v2/chat/completions → live endpoint (v1 /api/chat/completions 404s)
//   - X-FE-Version required         → omitting it yields a 426 "outdated" frame
//   - guest reaches glm-4.7 only    → other models return a 403 user-level frame
//   - every completion CAPTCHA-gated → FRONTEND_CAPTCHA_REQUIRED without a param

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/zai-web.ts");

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });

async function readSse(resp: Response): Promise<string> {
  return await resp.text();
}

describe("extractZaiToken", () => {
  it("pulls token= from a full Cookie header", () => {
    assert.equal(mod.extractZaiToken("a=1; token=abc.def.ghi; other=2"), "abc.def.ghi");
  });
  it("strips a leading Cookie: prefix", () => {
    assert.equal(mod.extractZaiToken("Cookie: token=xyz"), "xyz");
  });
  it("accepts a bare JWT with no token= prefix", () => {
    assert.equal(mod.extractZaiToken("eyJhbGciOiJFUzI1NiJ9.payload.sig"), "eyJhbGciOiJFUzI1NiJ9.payload.sig");
  });
  it("returns empty for a cookie header without token=", () => {
    assert.equal(mod.extractZaiToken("a=1; b=2"), "");
  });
});

describe("resolveFeVersion", () => {
  afterEach(() => {
    delete process.env.ZAI_WEB_FE_VERSION;
  });
  it("defaults to 1.0.91", () => {
    delete process.env.ZAI_WEB_FE_VERSION;
    assert.equal(mod.resolveFeVersion(), "1.0.91");
  });
  it("honors the ZAI_WEB_FE_VERSION override", () => {
    process.env.ZAI_WEB_FE_VERSION = "prod-fe-1.1.75";
    assert.equal(mod.resolveFeVersion(), "prod-fe-1.1.75");
  });
});

describe("parseZaiFrame", () => {
  it("parses the internal delta_content/answer envelope", () => {
    const d = mod.parseZaiFrame({
      type: "chat:completion",
      data: { delta_content: "hello", phase: "answer", done: false },
    });
    assert.deepEqual(d, { content: "hello", reasoning: "", done: false });
  });
  it("routes thinking-phase text to reasoning", () => {
    const d = mod.parseZaiFrame({
      type: "chat:completion",
      data: { delta_content: "thinking...", phase: "thinking", done: false },
    });
    assert.deepEqual(d, { content: "", reasoning: "thinking...", done: false });
  });
  it("marks done on phase:done", () => {
    const d = mod.parseZaiFrame({ type: "chat:completion", data: { phase: "done", done: true } });
    assert.deepEqual(d, { content: "", reasoning: "", done: true });
  });
  it("parses a pass-through OpenAI-shaped frame", () => {
    const d = mod.parseZaiFrame({ choices: [{ delta: { content: "hi" }, finish_reason: null }] });
    assert.deepEqual(d, { content: "hi", reasoning: "", done: false });
  });
  it("marks done on an OpenAI finish_reason", () => {
    const d = mod.parseZaiFrame({ choices: [{ delta: {}, finish_reason: "stop" }] });
    assert.equal(d?.done, true);
  });
  it("returns null for junk", () => {
    assert.equal(mod.parseZaiFrame("nope"), null);
    assert.equal(mod.parseZaiFrame(null), null);
  });
});

describe("extractZaiError", () => {
  it("surfaces a user-level 403 error frame", () => {
    const e = mod.extractZaiError({
      type: "chat:completion",
      data: { data: { error: { detail: "Model not available for current user level", code: 403 }, done: true } },
    });
    assert.match(String(e), /current user level/);
  });
  it("surfaces a FRONTEND_CAPTCHA_REQUIRED frame", () => {
    const e = mod.extractZaiError({
      data: { data: { error: { code: "FRONTEND_CAPTCHA_REQUIRED" }, done: true } },
    });
    assert.match(String(e), /CAPTCHA/i);
  });
  it("returns null for a normal content frame", () => {
    assert.equal(
      mod.extractZaiError({ type: "chat:completion", data: { delta_content: "hi", phase: "answer" } }),
      null
    );
  });
});

describe("foldMessages", () => {
  it("stringifies non-string content", () => {
    const out = mod.foldMessages([
      { role: "user", content: "plain" },
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    assert.equal(out[0].content, "plain");
    assert.equal(out[1].content, JSON.stringify([{ type: "text", text: "x" }]));
  });
});

describe("mintGuestToken", () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  it("mints a token from GET /api/v1/auths/", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ token: "guest.jwt.tok", role: "guest" }), { status: 200 });
    }) as typeof fetch;
    const tok = await mod.mintGuestToken(null);
    assert.equal(tok, "guest.jwt.tok");
    assert.ok(calledUrl.endsWith("/api/v1/auths/"), calledUrl);
  });
  it("returns empty string on failure", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    assert.equal(await mod.mintGuestToken(null), "");
  });
});

describe("ZaiWebExecutor.execute", () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.ZAI_WEB_FE_VERSION;
    delete process.env.ZAI_WEB_CAPTCHA_PARAM;
  });

  it("targets /api/v2/chat/completions with the X-FE-Version header and Bearer auth", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(String(init.body));
      return new Response(streamOf([sse({ data: { phase: "done", done: true } })]), { status: 200 });
    }) as typeof fetch;

    const executor = new mod.ZaiWebExecutor();
    await executor.execute({
      model: "GLM-5.1",
      body: { model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=real.session.jwt" },
      signal: null,
    } as never);

    assert.equal(capturedUrl, "https://chat.z.ai/api/v2/chat/completions");
    assert.equal(capturedHeaders["X-FE-Version"], "1.0.91");
    assert.equal(capturedHeaders.Authorization, "Bearer real.session.jwt");
    assert.equal(capturedHeaders.Cookie, "token=real.session.jwt");
    assert.equal(capturedBody.model, "GLM-5.1");
    assert.equal(capturedBody.stream, true);
  });

  it("auto-mints a guest token when no cookie is supplied", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/v1/auths/")) {
        return new Response(JSON.stringify({ token: "guest.tok", role: "guest" }), { status: 200 });
      }
      const hdrs = (init?.headers as Record<string, string>) || {};
      assert.equal(hdrs.Authorization, "Bearer guest.tok");
      return new Response(streamOf([sse({ data: { delta_content: "ok", phase: "answer" } }), sse({ data: { done: true } })]), {
        status: 200,
      });
    }) as typeof fetch;

    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    } as never);

    assert.ok(urls[0].endsWith("/api/v1/auths/"));
    assert.ok(urls[1].endsWith("/api/v2/chat/completions"));
    const body = (await res.response.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0].message.content, "ok");
  });

  it("returns a 502 error when guest mint fails and no cookie given", async () => {
    globalThis.fetch = (async () => new Response("blocked", { status: 429 })) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    } as never);
    assert.equal(res.response.status, 502);
    const body = (await res.response.json()) as { error: { message: string } };
    assert.match(body.error.message, /guest-token mint failed|Cookie/i);
  });

  it("forwards a CAPTCHA param from ZAI_WEB_CAPTCHA_PARAM into params + header", async () => {
    process.env.ZAI_WEB_CAPTCHA_PARAM = "captcha-abc-123";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      capturedHeaders = (init.headers as Record<string, string>) || {};
      return new Response(streamOf([sse({ data: { done: true } })]), { status: 200 });
    }) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=t" },
      signal: null,
    } as never);
    assert.equal((capturedBody.params as Record<string, unknown>).captcha_verify_param, "captcha-abc-123");
    assert.equal(capturedHeaders["x-signature"], "captcha-abc-123");
  });

  it("streams OpenAI-shaped chunks from the internal envelope", async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamOf([
          sse({ type: "chat:completion", data: { delta_content: "Hel", phase: "answer" } }),
          sse({ type: "chat:completion", data: { delta_content: "lo", phase: "answer" } }),
          sse({ type: "chat:completion", data: { phase: "done", done: true } }),
        ]),
        { status: 200 }
      )) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=t" },
      signal: null,
    } as never);
    const text = await readSse(res.response);
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /"content":"Hel"/);
    assert.match(text, /"content":"lo"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("aggregates non-streaming answer + reasoning", async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamOf([
          sse({ data: { delta_content: "think", phase: "thinking" } }),
          sse({ data: { delta_content: "Answer", phase: "answer" } }),
          sse({ data: { done: true } }),
        ]),
        { status: 200 }
      )) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t" },
      signal: null,
    } as never);
    const body = (await res.response.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };
    assert.equal(body.choices[0].message.content, "Answer");
    assert.equal(body.choices[0].message.reasoning_content, "think");
  });

  it("surfaces an upstream 403 user-level error frame as a 502 (non-streaming)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamOf([
          sse({ data: { data: { error: { detail: "Model not available for current user level", code: 403 }, done: true } } }),
        ]),
        { status: 200 }
      )) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t" },
      signal: null,
    } as never);
    assert.equal(res.response.status, 502);
    const body = (await res.response.json()) as { error: { message: string } };
    assert.match(body.error.message, /current user level|rejected/i);
  });

  it("propagates a non-2xx upstream status", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const executor = new mod.ZaiWebExecutor();
    const res = await executor.execute({
      model: "glm-4.7",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t" },
      signal: null,
    } as never);
    assert.equal(res.response.status, 500);
  });
});
