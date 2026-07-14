/**
 * BraveLeoExecutor — native OmniRoute executor for Brave Leo (Brave's built-in
 * AI assistant), talking directly to the Brave Services Gateway. No sidecar /
 * shared-relay-proxy required.
 *
 * Endpoint: POST https://ai-chat.bsg.brave.com/v1/chat/completions
 *   - Body: OpenAI Chat Completions (+ a non-standard `system_language` field).
 *   - Response: OpenAI format (SSE `data:` chunks when streaming, JSON otherwise).
 *
 * Auth: NOT a bearer token. Brave anonymously authorizes desktop clients with a
 * per-request HMAC-SHA256 signature plus two static "service key" headers, all
 * extracted from the public Brave desktop binary (no Brave account needed):
 *   1. digest        = "SHA-256=" + base64(sha256(bodyBytes))
 *   2. signature     = base64(hmac_sha256(SERVICE_KEY_AICHAT, "digest: " + digest))
 *   3. Authorization = Signature keyId="<KEY_ID>",algorithm="hs2019",
 *                      headers="digest",signature="<signature>"
 *   4. x-brave-key / BraveServiceKey = BRAVE_SERVICES_KEY (static)
 *
 * The signature is computed over the *exact* serialized request body, so the
 * standard buildHeaders() hook (which runs before the body is serialized and is
 * never given the body) cannot produce it. This executor therefore overrides
 * execute() fully — same pattern as the web executors (venice-web, kimi-web).
 *
 * Key rotation: `KEY_ID` is pinned to a Brave desktop release. If Brave rotates
 * the keys, override via env (BRAVE_SERVICES_KEY / BRAVE_AICHAT_KEY /
 * BRAVE_LEO_KEY_ID) with values re-extracted from the current Brave binary.
 *
 * Rate limiting: Brave throttles clients; the executor serializes requests with
 * a >=5s gap by default (override BRAVE_LEO_MIN_INTERVAL_MS), mirroring the
 * sidecar's `min_interval`.
 */
import { createHash, createHmac } from "node:crypto";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult } from "../utils/error.ts";
import { resolvePublicCred } from "../utils/publicCreds.ts";

const BASE_URL = "https://ai-chat.bsg.brave.com/v1";
const CHAT_URL = `${BASE_URL}/chat/completions`;

// Public identifiers extracted from the Brave desktop binary (see publicCreds).
const BRAVE_SERVICES_KEY = resolvePublicCred("brave_services", "BRAVE_SERVICES_KEY");
const SERVICE_KEY_AICHAT = resolvePublicCred("brave_aichat", "BRAVE_AICHAT_KEY");
const KEY_ID = process.env.BRAVE_LEO_KEY_ID?.trim() || "macos-149-release";

const USER_AGENT =
  process.env.BRAVE_LEO_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Brave/1.49.0 Chrome/149.0.0.0 Safari/537.36";

/**
 * OmniRoute model id (what the router / CCR markers send) → Brave upstream id
 * (what ai-chat.bsg.brave.com expects). OmniRoute must NEVER send the upstream
 * id directly; it sends the `brave-*` alias and this map does the translation.
 * `claude-brave-*` is normalized to `brave-*` before lookup.
 */
export const BRAVE_MODEL_MAP: Record<string, string> = {
  "brave-haiku": "claude-3-haiku",
  "brave-glm-5-1": "near-glm-5-1",
  "brave-maverick": "llama-4-maverick",
  "brave-qwen-235b": "qwen-3-235b",
  "brave-glm-flash": "glm-4-7-flash",
  "brave-gpt-oss": "gpt-oss-20b",
  "brave-llama-8b": "llama-3-8b-instruct",
};

/** Brave upstream ids that accept native OpenAI `tools`. Others get DSML in the
 *  Brave client; since this executor does not port the DSML bridge, tools are
 *  dropped for non-native models so plain chat still succeeds. */
const NATIVE_TOOL_UPSTREAMS = new Set(["claude-3-haiku", "qwen-3-235b", "glm-4-7-flash"]);

const DEFAULT_MODEL = "brave-haiku";

/** Resolve an incoming OmniRoute/CCR model id to a Brave upstream id. */
export function resolveBraveUpstreamModel(model: string | undefined | null): string {
  let id = String(model || DEFAULT_MODEL).trim();
  // Drop an optional provider prefix ("brave/brave-haiku" → "brave-haiku").
  if (id.startsWith("brave/")) id = id.slice("brave/".length);
  // Normalize the CCR `claude-brave-*` shortcut to the `brave-*` alias.
  if (id.startsWith("claude-brave-")) id = "brave-" + id.slice("claude-brave-".length);
  if (BRAVE_MODEL_MAP[id]) return BRAVE_MODEL_MAP[id];
  // Already an upstream id (someone sent the raw Brave name) → pass through.
  if (Object.values(BRAVE_MODEL_MAP).includes(id)) return id;
  // Unknown `brave-*` alias: default to the safe/native haiku upstream.
  if (id.startsWith("brave-")) return BRAVE_MODEL_MAP[DEFAULT_MODEL];
  // Anything else: forward unchanged (lets new Brave models work).
  return id;
}

function minIntervalMs(): number {
  const raw = Number(process.env.BRAVE_LEO_MIN_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 5000;
}

// Serialized client-side throttle: chain each request behind the previous one
// so consecutive Brave requests are spaced >= minIntervalMs apart (per process).
let throttleChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
function throttle(): Promise<void> {
  const wait = throttleChain.then(async () => {
    const gap = minIntervalMs();
    const elapsed = Date.now() - lastRequestAt;
    if (gap > 0 && elapsed < gap) {
      await new Promise((r) => setTimeout(r, gap - elapsed));
    }
    lastRequestAt = Date.now();
  });
  // Keep the chain alive even if a waiter is cancelled upstream.
  throttleChain = wait.catch(() => {});
  return wait;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Flatten an OpenAI content-part array to plain text (Leo is text-only). */
function flattenContent(content: unknown): unknown {
  if (typeof content === "string" || !Array.isArray(content)) return content;
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

/** Strip Brave's non-standard reasoning fields so the response is clean OpenAI. */
function stripReasoning(obj: Record<string, unknown>): void {
  delete obj.reasoning_content;
  delete obj.provider_specific_fields;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Remove complete `<think>...</think>` reasoning blocks from a full string. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^\s+/, "");
}

/**
 * Incremental `<think>...</think>` stripper for streaming deltas. Some Brave
 * models (GLM, GPT-OSS, Maverick) emit reasoning inline in `delta.content`
 * rather than in `reasoning_content`; the tags can straddle chunk boundaries,
 * so this holds back a short tail that could be a partial open/close tag.
 */
function createThinkStripper() {
  let buf = "";
  let inThink = false;
  const maxTagLen = Math.max(THINK_OPEN.length, THINK_CLOSE.length);
  return {
    push(text: string): string {
      buf += text;
      let out = "";
      // Loop until we cannot make further definite progress on `buf`.
      for (;;) {
        if (!inThink) {
          const idx = buf.indexOf(THINK_OPEN);
          if (idx !== -1) {
            out += buf.slice(0, idx);
            buf = buf.slice(idx + THINK_OPEN.length);
            inThink = true;
            continue;
          }
          // No full open tag. Emit everything except a tail that might be the
          // start of a split `<think>` tag.
          const safe = buf.length - (maxTagLen - 1);
          if (safe > 0) {
            out += buf.slice(0, safe);
            buf = buf.slice(safe);
          }
          break;
        } else {
          const idx = buf.indexOf(THINK_CLOSE);
          if (idx !== -1) {
            buf = buf.slice(idx + THINK_CLOSE.length);
            inThink = false;
            continue;
          }
          // Still inside a think block; discard all but a possible partial close.
          const keep = THINK_CLOSE.length - 1;
          if (buf.length > keep) buf = buf.slice(buf.length - keep);
          break;
        }
      }
      return out;
    },
    /** Emit any buffered non-think remainder at end of stream. */
    flush(): string {
      if (inThink) {
        buf = "";
        return "";
      }
      const rest = buf;
      buf = "";
      return rest;
    },
  };
}

function sign(bodyBytes: Uint8Array): { digest: string; authorization: string } {
  const digest = "SHA-256=" + createHash("sha256").update(bodyBytes).digest("base64");
  const signature = createHmac("sha256", SERVICE_KEY_AICHAT)
    .update("digest: " + digest)
    .digest("base64");
  const authorization = `Signature keyId="${KEY_ID}",algorithm="hs2019",headers="digest",signature="${signature}"`;
  return { digest, authorization };
}

export class BraveLeoExecutor extends BaseExecutor {
  constructor(provider = "brave") {
    super(provider, { id: provider, baseUrl: BASE_URL, format: "openai" });
  }

  buildUpstreamBody(
    model: string,
    body: Record<string, unknown>,
    stream: boolean
  ): Record<string, unknown> {
    const upstreamModel = resolveBraveUpstreamModel(model);

    const rawMessages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    const messages = rawMessages.map((m) =>
      isRecord(m) && Array.isArray(m.content) ? { ...m, content: flattenContent(m.content) } : m
    );

    const out: Record<string, unknown> = {
      model: upstreamModel,
      messages,
      stream,
      // Brave's client always sends this; harmless and expected upstream.
      system_language: "en",
    };

    // Forward the standard sampling knobs when present.
    for (const key of ["temperature", "top_p", "max_tokens", "stop"] as const) {
      if (body[key] !== undefined) out[key] = body[key];
    }

    // Native tools only for models that support them upstream; otherwise drop
    // (this executor does not port the sidecar's DSML tool bridge).
    if (body.tools !== undefined && NATIVE_TOOL_UPSTREAMS.has(upstreamModel)) {
      out.tools = body.tools;
      if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
    }

    return out;
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, signal } = input;
    const bodyObj = isRecord(body) ? body : {};
    const reqBody = this.buildUpstreamBody(model, bodyObj, stream);
    const modelIdForResponse = resolveBraveUpstreamModel(model);

    // Serialize + sign the EXACT bytes we send (signature is over the body).
    const bodyString = JSON.stringify(reqBody);
    const bodyBytes = new TextEncoder().encode(bodyString);
    const { digest, authorization } = sign(bodyBytes);

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": USER_AGENT,
      digest,
      Authorization: authorization,
      "x-brave-key": BRAVE_SERVICES_KEY,
      BraveServiceKey: BRAVE_SERVICES_KEY,
    };

    await throttle();

    let upstream: Response;
    try {
      upstream = await fetch(CHAT_URL, {
        method: "POST",
        headers: reqHeaders,
        body: bodyString,
        signal: signal ?? undefined,
      });
    } catch (err) {
      return makeErrorResult(
        502,
        `Brave Leo fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
        reqBody,
        CHAT_URL
      );
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return makeErrorResult(
        upstream.status,
        `Brave Leo error (${upstream.status}): ${errText.slice(0, 500)}`,
        reqBody,
        CHAT_URL
      );
    }

    if (!stream) {
      let data: Record<string, unknown>;
      try {
        data = (await upstream.json()) as Record<string, unknown>;
      } catch (err) {
        return makeErrorResult(
          502,
          `Brave Leo returned invalid JSON: ${err instanceof Error ? err.message : "unknown"}`,
          reqBody,
          CHAT_URL
        );
      }
      const choices = Array.isArray(data.choices) ? data.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        stripReasoning(choice);
        if (isRecord(choice.message)) {
          stripReasoning(choice.message);
          if (typeof choice.message.content === "string") {
            choice.message.content = stripThinkTags(choice.message.content);
          }
        }
      }
      stripReasoning(data);

      return {
        response: new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: CHAT_URL,
        headers: reqHeaders,
        transformedBody: reqBody,
      };
    }

    // Streaming: forward Brave's SSE, dropping reasoning fields + inline
    // `<think>` blocks from each chunk. `lastChunk` is reused to synthesize a
    // final delta carrying any think-tail flushed at end of stream.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const thinker = createThinkStripper();
    let lastChunk: Record<string, unknown> | null = null;
    const outStream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "") continue;
              if (payload === "[DONE]") {
                const tail = thinker.flush();
                if (tail && lastChunk) {
                  const finalChunk = {
                    ...lastChunk,
                    choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              try {
                const parsed = JSON.parse(payload) as Record<string, unknown>;
                lastChunk = parsed;
                const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
                let hasContentDelta = false;
                let emittedContent = "";
                for (const choice of choices) {
                  if (!isRecord(choice)) continue;
                  stripReasoning(choice);
                  if (isRecord(choice.delta)) {
                    stripReasoning(choice.delta);
                    if (typeof choice.delta.content === "string") {
                      hasContentDelta = true;
                      const kept = thinker.push(choice.delta.content);
                      choice.delta.content = kept;
                      emittedContent += kept;
                    }
                  }
                }
                stripReasoning(parsed);
                // Suppress chunks that were pure reasoning (all content stripped)
                // and carry nothing else meaningful, to avoid empty-delta spam.
                const meaningful = choices.some((c) => {
                  if (!isRecord(c)) return false;
                  if (c.finish_reason) return true;
                  const d = isRecord(c.delta) ? c.delta : null;
                  if (!d) return false;
                  return d.role !== undefined || d.tool_calls !== undefined;
                });
                if (hasContentDelta && emittedContent === "" && !meaningful) continue;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              } catch {
                // Unparseable chunk: forward verbatim rather than drop content.
                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
              }
            }
          }
        } catch (err) {
          // Never swallow stream errors (Hard Rule #6) unless the client aborted.
          if (!signal?.aborted) {
            controller.error(err);
            return;
          }
        } finally {
          controller.close();
        }
      },
    });

    void modelIdForResponse;
    return {
      response: new Response(outStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: CHAT_URL,
      headers: reqHeaders,
      transformedBody: reqBody,
    };
  }
}

export default BraveLeoExecutor;
