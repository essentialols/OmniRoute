// Tests for the native GLM web executor (chatglm.cn consumer webchat).
//
// This executor reproduces the FREE chatglm.cn path (guest-token / refresh-token
// + md5 signing + cumulative-snapshot SSE) as a native OmniRoute executor, so no
// shared-relay-proxy sidecar is needed. The wire format below was confirmed by a
// direct upstream probe (guest token -> signed stream -> real completion).
//
// These tests pin: the md5 signing, JWT expiry parse, assistant/model resolution,
// message flattening, cumulative-frame parsing, the guest-token acquisition flow,
// and the cumulative-to-delta SSE transform. No network calls (fetch is mocked).

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const proto = await import("../../open-sse/executors/glm-web/protocol.ts");
const mod = await import("../../open-sse/executors/glm-web.ts");

function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function readSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("glm-web protocol: makeSign", () => {
  it("is deterministic for fixed now+nonce and mangles the 2nd-to-last digit", () => {
    const now = 1784040702123; // 13 digits
    const nonce = "abc123";
    const { timestamp, sign } = proto.makeSign(now, nonce, "SECRET");
    // digitSum(1784040702123)=1+7+8+4+0+4+0+7+0+2+1+2+3=39; minus 2nd-to-last (2) = 37; %10 = 7
    // 2nd-to-last digit (index len-2) replaced by 7 => ...123 -> ...173 (the '2' becomes '7')
    assert.equal(timestamp, "1784040702173");
    const expected = createHash("md5").update(`${timestamp}-${nonce}-SECRET`).digest("hex");
    assert.equal(sign, expected);
  });

  it("buildSignHeaders includes all required signed headers + optional bearer", () => {
    const h = proto.buildSignHeaders({ accessToken: "tok123", sse: true });
    assert.equal(h["App-Name"], "chatglm");
    assert.equal(h["X-App-Platform"], "pc");
    assert.ok(h["X-Sign"] && h["X-Timestamp"] && h["X-Nonce"]);
    assert.ok(h["X-Device-Id"] && h["X-Request-Id"]);
    assert.equal(h["Authorization"], "Bearer tok123");
    assert.equal(h["Accept"], "text/event-stream");
  });

  it("buildSignHeaders omits Authorization when no token (guest path)", () => {
    const h = proto.buildSignHeaders({});
    assert.equal(h["Authorization"], undefined);
    assert.equal(h["Accept"], "application/json, text/plain, */*");
  });
});

describe("glm-web protocol: jwtExpSeconds", () => {
  it("decodes the exp claim from a JWT", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1784127138 })).toString("base64url");
    const token = `h.${payload}.s`;
    assert.equal(proto.jwtExpSeconds(token), 1784127138);
  });
  it("returns null for a malformed token", () => {
    assert.equal(proto.jwtExpSeconds("not-a-jwt"), null);
  });
});

describe("glm-web protocol: resolveAssistantId + wantsReasoning", () => {
  it("maps chatglm-* ids to the default assistant", () => {
    assert.equal(proto.resolveAssistantId("chatglm-5.1"), proto.GLM_DEFAULT_ASSISTANT_ID);
    assert.equal(proto.resolveAssistantId("glm-5"), proto.GLM_DEFAULT_ASSISTANT_ID);
    assert.equal(proto.resolveAssistantId(undefined), proto.GLM_DEFAULT_ASSISTANT_ID);
  });
  it("passes a raw 24-hex assistant id through verbatim", () => {
    const custom = "65a232c082ff90a2ad2f15e2";
    assert.equal(proto.resolveAssistantId(custom), custom);
  });
  it("detects reasoning intent from model id and body", () => {
    assert.equal(proto.wantsReasoning("chatglm-5.1-think"), true);
    assert.equal(proto.wantsReasoning("chatglm-5.1"), false);
    assert.equal(proto.wantsReasoning("chatglm-5", { reasoning_effort: "high" }), true);
    assert.equal(proto.wantsReasoning("chatglm-5", { reasoning_effort: "none" }), false);
  });
});

describe("glm-web protocol: messagesToPrompt", () => {
  it("sends a single user message as-is (with system prefix)", () => {
    const p = proto.messagesToPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Hi" },
    ]);
    assert.equal(p, "Be terse.\n\nHi");
  });
  it("flattens multi-turn into a role-tagged transcript ending on assistant", () => {
    const p = proto.messagesToPrompt([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    assert.match(p, /<\|user\|>\na/);
    assert.match(p, /<\|assistant\|>\nb/);
    assert.ok(p.trimEnd().endsWith("<|assistant|>"));
  });
  it("extracts text from array content parts", () => {
    const p = proto.messagesToPrompt([
      { role: "user", content: [{ type: "text", text: "hello" }] as never },
    ]);
    assert.equal(p, "hello");
  });
});

describe("glm-web protocol: parseFrame (cumulative snapshots)", () => {
  it("accumulates text + reasoning parts and reads status/conversation/intervene", () => {
    const frame = {
      conversation_id: "conv1",
      status: "init",
      parts: [
        {
          content: [
            { type: "think", think: "reasoning..." },
            { type: "text", text: "Hello there!" },
          ],
        },
      ],
      last_error: {},
    };
    const snap = proto.parseFrame(frame);
    assert.equal(snap.text, "Hello there!");
    assert.equal(snap.reasoning, "reasoning...");
    assert.equal(snap.conversationId, "conv1");
    assert.equal(snap.status, "init");
  });
  it("surfaces last_error.intervene_text", () => {
    const snap = proto.parseFrame({ status: "intervene", parts: [], last_error: { intervene_text: "blocked" } });
    assert.equal(snap.interveneText, "blocked");
  });
});

describe("glm-web protocol: buildStreamBody + extractTokenResult", () => {
  it("builds the assistant/stream body and sets chat_mode=zero for reasoning", () => {
    const body = proto.buildStreamBody({ assistantId: "aid", prompt: "hi", reasoning: true }) as Record<
      string,
      unknown
    >;
    assert.equal(body.assistant_id, "aid");
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    assert.equal((body.meta_data as Record<string, unknown>).chat_mode, "zero");
  });
  it("omits chat_mode when reasoning is off", () => {
    const body = proto.buildStreamBody({ assistantId: "aid", prompt: "hi", reasoning: false }) as Record<
      string,
      unknown
    >;
    assert.equal((body.meta_data as Record<string, unknown>).chat_mode, undefined);
  });
  it("extracts access + refresh token from the result envelope", () => {
    const r = proto.extractTokenResult({ status: 0, result: { access_token: "AT", refresh_token: "RT" } });
    assert.equal(r.accessToken, "AT");
    assert.equal(r.refreshToken, "RT");
  });
});

describe("transformGlmStream (cumulative -> OpenAI deltas)", () => {
  it("emits only the newly-appended suffix per frame and a final stop", async () => {
    const frames = [
      sseFrame({ conversation_id: "c1", status: "init", parts: [] }),
      sseFrame({ conversation_id: "c1", status: "init", parts: [{ content: [{ type: "text", text: "Hello" }] }] }),
      sseFrame({ conversation_id: "c1", status: "init", parts: [{ content: [{ type: "text", text: "Hello there" }] }] }),
      sseFrame({ conversation_id: "c1", status: "finish", parts: [{ content: [{ type: "text", text: "Hello there!" }] }] }),
    ];
    let deletedConv = "";
    const out = mod.transformGlmStream(streamOf(frames), "chatglm-5.1", (cid) => {
      deletedConv = cid;
    });
    const text = await readSSE(out);
    // Reconstruct the streamed content deltas.
    const contents: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const chunk = JSON.parse(line.slice(6));
      const d = chunk.choices?.[0]?.delta;
      if (typeof d?.content === "string" && d.content) contents.push(d.content);
    }
    assert.equal(contents.join(""), "Hello there!");
    // No duplicated cumulative text: deltas are "Hello", " there", "!"
    assert.deepEqual(contents, ["Hello", " there", "!"]);
    assert.ok(text.includes('"finish_reason":"stop"'));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
    assert.equal(deletedConv, "c1");
  });

  it("routes think parts to reasoning_content deltas", async () => {
    const frames = [
      sseFrame({ status: "init", parts: [{ content: [{ type: "think", think: "step1" }] }] }),
      sseFrame({ status: "finish", parts: [{ content: [{ type: "think", think: "step1 step2" }, { type: "text", text: "Done" }] }] }),
    ];
    const out = mod.transformGlmStream(streamOf(frames), "chatglm-5.1-think", () => {});
    const text = await readSSE(out);
    assert.ok(text.includes('"reasoning_content":"step1"'));
    assert.ok(text.includes('"reasoning_content":" step2"'));
    assert.ok(text.includes('"content":"Done"'));
  });
});

describe("GlmWebExecutor.execute (guest-token flow, mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  const savedTokenEnv = process.env.GLM_REFRESH_TOKEN;
  const savedPathEnv = process.env.GLM_REFRESH_TOKEN_PATH;
  beforeEach(() => {
    // Isolate from any real ~/.config/glm-refresh-token on the host + stale cache.
    delete process.env.GLM_REFRESH_TOKEN;
    process.env.GLM_REFRESH_TOKEN_PATH = "/nonexistent/glm-refresh-token";
    mod.tokenCache.clear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedTokenEnv === undefined) delete process.env.GLM_REFRESH_TOKEN;
    else process.env.GLM_REFRESH_TOKEN = savedTokenEnv;
    if (savedPathEnv === undefined) delete process.env.GLM_REFRESH_TOKEN_PATH;
    else process.env.GLM_REFRESH_TOKEN_PATH = savedPathEnv;
    mod.tokenCache.clear();
  });

  it("mints a guest token (no creds) then streams a completion", async () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/user-api/guest/access")) {
        // guest endpoint must be called with a signature header + empty body
        const h = (init?.headers ?? {}) as Record<string, string>;
        assert.ok(h["X-Sign"], "guest call must be signed");
        assert.equal(init?.body, "{}");
        return new Response(JSON.stringify({ status: 0, result: { access_token: jwt, refresh_token: "RT" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/assistant/stream")) {
        const h = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(h["Authorization"], `Bearer ${jwt}`, "stream must use the minted access token");
        return new Response(
          streamOf([
            sseFrame({ conversation_id: "c9", status: "init", parts: [{ content: [{ type: "text", text: "Paris" }] }] }),
            sseFrame({ conversation_id: "c9", status: "finish", parts: [{ content: [{ type: "text", text: "Paris." }] }] }),
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      // conversation cleanup
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const executor = new mod.GlmWebExecutor();
    const result = await executor.execute({
      model: "chatglm-5.1",
      body: { messages: [{ role: "user", content: "capital of France?" }] },
      stream: true,
      credentials: {},
      signal: null,
    } as never);

    assert.equal(result.response.status, 200);
    const text = await readSSE(result.response.body as ReadableStream<Uint8Array>);
    let content = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const d = JSON.parse(line.slice(6)).choices?.[0]?.delta;
      if (typeof d?.content === "string") content += d.content;
    }
    assert.equal(content, "Paris.");
    assert.ok(calls.some((c) => c.includes("/user-api/guest/access")));
    assert.ok(calls.some((c) => c.includes("/assistant/stream")));
  });

  it("uses the refresh endpoint when a refresh_token credential is provided", async () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
    let tokenUrl = "";
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/user-api/user/refresh")) {
        tokenUrl = u;
        const h = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(h["Authorization"], "Bearer MY_REFRESH", "refresh call carries the refresh token");
        return new Response(JSON.stringify({ status: 0, result: { access_token: jwt } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/user-api/guest/access")) {
        throw new Error("guest endpoint must not be called when a refresh token is present");
      }
      if (u.includes("/assistant/stream")) {
        return new Response(
          streamOf([sseFrame({ status: "finish", parts: [{ content: [{ type: "text", text: "ok" }] }] })]),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const executor = new mod.GlmWebExecutor();
    const result = await executor.execute({
      model: "chatglm-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "MY_REFRESH" },
      signal: null,
    } as never);
    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0].message.content, "ok");
    assert.ok(tokenUrl.includes("/user-api/user/refresh"));
  });

  it("returns a 400 when there is no user content to send", async () => {
    const executor = new mod.GlmWebExecutor();
    const result = await executor.execute({
      model: "chatglm-5.1",
      body: { messages: [] },
      stream: false,
      credentials: {},
      signal: null,
    } as never);
    assert.equal(result.response.status, 400);
  });
});
