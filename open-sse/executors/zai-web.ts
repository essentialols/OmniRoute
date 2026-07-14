/**
 * ZaiWebExecutor — Z.ai Web Chat (chat.z.ai, free web-session / guest-token auth)
 *
 * Distinct from the existing API-key `zai`/`glm`/`glm-cn`/`glmt` providers
 * (Anthropic/OpenAI-compatible `api.z.ai`, see `providers/apikey/regional.ts`).
 * This executor targets the *consumer chat* frontend at chat.z.ai — the same
 * product family as `chatglm.cn` (Zhipu AI), international domain — so users
 * can drive it for free from their browser session (or, with no account at
 * all, via the anonymous guest token the SPA itself mints on load).
 *
 * Endpoint: POST https://chat.z.ai/api/v2/chat/completions
 *           (the legacy `/api/chat/completions` v1 path now 404s; the live SPA
 *            uses v2 — confirmed by direct probe 2026-07.)
 * Version:  `X-FE-Version` header is MANDATORY — omitting it returns a 426
 *           `"client version (unknown) is outdated. Minimum required: 1.0.91"`
 *           SSE frame. Default `1.0.91`; override with `ZAI_WEB_FE_VERSION`
 *           (live SPA currently ships `prod-fe-1.1.75`).
 * Auth:     three tiers, tried in order —
 *           1. A pasted chat.z.ai Cookie header (registered account) → highest
 *              model tier (GLM-5.1 / GLM-5.2 / GLM-5-Turbo …). Sent both as
 *              `Cookie` and as `Authorization: Bearer <token>`; stripping either
 *              has been reported (upstream repos) to 401 the request.
 *           2. A bare JWT pasted as the credential (no `token=` prefix).
 *           3. No credential at all → auto-mint an anonymous guest token via
 *              `GET /api/v1/auths/` (fully programmatic, `role:guest`). Guest
 *              level only reaches `glm-4.7`; other models return a 403
 *              `"Model not available for current user level"` SSE frame.
 * Captcha:  chat.z.ai hard-gates every completion behind an Aliyun invisible
 *           CAPTCHA — a request without a valid `captcha_verify_param`/signature
 *           returns a `FRONTEND_CAPTCHA_REQUIRED` SSE frame. That param can only
 *           be minted inside a browser (the shared-relay-proxy Playwright bridge
 *           did this). This executor forwards a param when one is supplied
 *           (`ZAI_WEB_CAPTCHA_PARAM` env, `credentials.providerSpecificData
 *           .captchaVerifyParam`, or an `x-zai-captcha` client header) so it
 *           works the moment a token is available, but cannot forge one itself.
 * Response: SSE. Frames are z.ai's internal envelope
 *           `{"type":"chat:completion","data":{"delta_content":"...","phase":"answer","done":false}}`
 *           — mirrored from the shared Zhipu chatglm.cn/chat.z.ai frontend
 *           protocol. Some deployments/models instead pass through an already
 *           OpenAI-shaped `{"choices":[{"delta":{"content":"..."}}]}` frame, so
 *           the parser accepts both shapes defensively.
 */
import { randomUUID } from "node:crypto";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import {
  makeExecutorErrorResult as makeErrorResult,
  normalizeCookie,
  sanitizeErrorMessage,
} from "../utils/error.ts";

const BASE_URL = "https://chat.z.ai";
const CHAT_URL = `${BASE_URL}/api/v2/chat/completions`;
const AUTH_URL = `${BASE_URL}/api/v1/auths/`;
const DEFAULT_FE_VERSION = "1.0.91";
/** Guest tier can only reach glm-4.7; use it as the safe default model. */
const DEFAULT_MODEL = "glm-4.7";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Resolve the X-FE-Version to send (env override wins, else the tested default). */
export function resolveFeVersion(): string {
  const env = (process.env.ZAI_WEB_FE_VERSION || "").trim();
  return env || DEFAULT_FE_VERSION;
}

/** Extract the `token` cookie value (JWT) from a full Cookie header string. */
export function extractZaiToken(rawCookie: string): string {
  const cookie = normalizeCookie(rawCookie.trim());
  if (!cookie) return "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (match) return match[1].trim();
  // Users may paste the bare JWT with no `token=` prefix.
  return cookie.includes(";") || cookie.includes("=") ? "" : cookie;
}

/**
 * Mint an anonymous guest token from chat.z.ai. Returns the JWT string, or ""
 * if the endpoint is unreachable / shape-changed. Guest tokens are heavily
 * rate-limited (a handful of rapid calls trips the WAF), so callers should
 * prefer a real cookie when one is available.
 */
export async function mintGuestToken(signal?: AbortSignal | null): Promise<string> {
  try {
    const resp = await fetch(AUTH_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "X-FE-Version": resolveFeVersion(),
      },
      signal: signal ?? undefined,
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as Record<string, unknown>;
    const token = data?.token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

/**
 * One parsed delta out of a z.ai SSE frame: either a content/reasoning chunk
 * or a signal that the stream has finished.
 */
export interface ZaiDelta {
  content: string;
  reasoning: string;
  done: boolean;
}

/** Parse an already OpenAI-shaped `{choices:[{delta}]}` pass-through frame. */
function parseOpenAiShapedFrame(choices: Array<Record<string, unknown>>): ZaiDelta {
  const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
  const finishReason = choices[0]?.finish_reason;
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
    done: finishReason != null,
  };
}

/** Parse the z.ai / chatglm internal `{data:{delta_content,phase,done}}` envelope. */
function parseInternalEnvelopeFrame(
  frame: Record<string, unknown>,
  data: Record<string, unknown>
): ZaiDelta | null {
  const phase = String(data.phase ?? "");
  const deltaContent = data.delta_content ?? data.edit_content ?? data.content;
  const done =
    data.done === true ||
    phase === "done" ||
    phase === "finish" ||
    String(frame.type ?? "") === "chat:completion:finish";

  if (typeof deltaContent === "string" && deltaContent) {
    const isThinking = phase === "thinking";
    return {
      content: isThinking ? "" : deltaContent,
      reasoning: isThinking ? deltaContent : "",
      done,
    };
  }
  if (done) return { content: "", reasoning: "", done: true };
  return null;
}

/**
 * Extract an upstream error detail from a z.ai SSE frame, if it carries one.
 * Guest-level rejections (403), CAPTCHA gates (FRONTEND_CAPTCHA_REQUIRED) and
 * outdated-client (426) all arrive as `{data:{error:{detail,code}}}` frames
 * with HTTP 200, so we surface them to the caller rather than returning an
 * empty completion.
 */
export function extractZaiError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;
  const data = (frame.data ?? {}) as Record<string, unknown>;
  const inner = (data.data ?? data) as Record<string, unknown>;
  const err = (inner.error ?? data.error ?? frame.error) as Record<string, unknown> | undefined;
  if (err && typeof err === "object") {
    const detail = err.detail ?? err.error_code ?? err.code;
    if (detail != null) return String(detail);
  }
  return null;
}

/**
 * Parse a single decoded z.ai SSE `data:` JSON payload into a normalized
 * delta. Handles both the internal `{data:{delta_content,phase,done}}`
 * envelope and a pass-through OpenAI-shaped `{choices:[{delta}]}` frame.
 */
export function parseZaiFrame(raw: unknown): ZaiDelta | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;

  const choices = frame.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    return parseOpenAiShapedFrame(choices);
  }

  const data = (frame.data ?? frame) as Record<string, unknown>;
  return parseInternalEnvelopeFrame(frame, data);
}

export function foldMessages(
  messages: Array<{ role: string; content: unknown }>
): Array<{ role: string; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
  }));
}

/** Split a chunk of decoded SSE text into complete `data:` payload strings. */
function extractSseDataPayloads(buffer: { text: string }, incoming: string): string[] {
  buffer.text += incoming;
  const lines = buffer.text.split("\n");
  buffer.text = lines.pop() || "";
  const payloads: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    payloads.push(data);
  }
  return payloads;
}

/** Parse a raw SSE payload string into a normalized delta, or null if unusable. */
function parseSsePayload(data: string): ZaiDelta | null {
  try {
    return parseZaiFrame(JSON.parse(data));
  } catch {
    return null;
  }
}

/** Scan an SSE body for an upstream error frame (best-effort, first match wins). */
function scanSseForError(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const err = extractZaiError(JSON.parse(payload));
      if (err) return err;
    } catch {
      /* ignore non-JSON frames */
    }
  }
  return null;
}

/**
 * Read the upstream SSE body to completion, invoking `onDelta` for every
 * parsed delta. Returns true when `onDelta` signalled the stream ended
 * (returned true), false when the body was exhausted without a done delta.
 */
async function drainSseDeltas(
  sourceBody: ReadableStream<Uint8Array>,
  onDelta: (delta: ZaiDelta) => boolean
): Promise<boolean> {
  const decoder = new TextDecoder();
  const reader = sourceBody.getReader();
  const buffer = { text: "" };
  while (true) {
    const { done, value } = await reader.read();
    if (done) return false;
    const payloads = extractSseDataPayloads(buffer, decoder.decode(value, { stream: true }));
    for (const raw of payloads) {
      const delta = parseSsePayload(raw);
      if (delta && onDelta(delta)) return true;
    }
  }
}

type ChunkEmitter = (
  controller: ReadableStreamDefaultController,
  delta: Record<string, unknown>,
  finish?: string | null
) => void;

/** Emit role/reasoning/content/stop chunks for one delta. Returns true when the stream ended. */
function emitDeltaChunks(
  controller: ReadableStreamDefaultController,
  delta: ZaiDelta,
  emitChunk: ChunkEmitter,
  roleState: { emitted: boolean }
): boolean {
  if (!roleState.emitted && (delta.content || delta.reasoning)) {
    roleState.emitted = true;
    emitChunk(controller, { role: "assistant", content: "" });
  }
  if (delta.reasoning) emitChunk(controller, { reasoning_content: delta.reasoning });
  if (delta.content) emitChunk(controller, { content: delta.content });
  if (delta.done) {
    emitChunk(controller, {}, "stop");
    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    controller.close();
    return true;
  }
  return false;
}

export class ZaiWebExecutor extends BaseExecutor {
  constructor() {
    super("zai-web", { id: "zai-web", baseUrl: BASE_URL });
  }

  private buildZaiHeaders(rawCookie: string, token: string, captcha: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      "X-FE-Version": resolveFeVersion(),
    };
    if (rawCookie) headers.Cookie = rawCookie;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (captcha) headers["x-signature"] = captcha;
    return headers;
  }

  private buildRequestBody(
    messages: Array<{ role: string; content: unknown }>,
    modelId: string,
    captcha: string
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      stream: true,
      model: modelId,
      messages: foldMessages(messages),
      chat_id: randomUUID(),
      id: randomUUID(),
      params: {},
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: false,
        enable_thinking: false,
      },
    };
    // Forward a CAPTCHA verify param when one is supplied; chat.z.ai rejects
    // completions without it (FRONTEND_CAPTCHA_REQUIRED).
    if (captcha) (body.params as Record<string, unknown>).captcha_verify_param = captcha;
    return body;
  }

  /** Resolve a CAPTCHA verify param from env / providerSpecificData / client header. */
  private resolveCaptcha(input: ExecuteInput): string {
    const fromEnv = (process.env.ZAI_WEB_CAPTCHA_PARAM || "").trim();
    if (fromEnv) return fromEnv;
    const psd = input.credentials?.providerSpecificData as Record<string, unknown> | undefined;
    const fromPsd = psd?.captchaVerifyParam;
    if (typeof fromPsd === "string" && fromPsd.trim()) return fromPsd.trim();
    const fromHeader = input.clientHeaders?.["x-zai-captcha"];
    if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
    return "";
  }

  /** Drain the streaming response body into an OpenAI-shaped SSE ReadableStream. */
  private buildStreamingBody(
    sourceBody: ReadableStream<Uint8Array>,
    emitChunk: ChunkEmitter,
    signal: AbortSignal | null | undefined
  ): ReadableStream {
    return new ReadableStream({
      async start(controller) {
        const roleState = { emitted: false };
        try {
          const ended = await drainSseDeltas(sourceBody, (delta) =>
            emitDeltaChunks(controller, delta, emitChunk, roleState)
          );
          if (ended) return; // emitDeltaChunks already sent [DONE] and closed
          if (!roleState.emitted) emitChunk(controller, { role: "assistant", content: "" });
          emitChunk(controller, {}, "stop");
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          if (!signal?.aborted) {
            try {
              controller.error(err);
            } catch {
              /* controller already closed */
            }
          }
        }
      },
    });
  }

  /** Drain the response body and aggregate all deltas into a single answer/reasoning pair. */
  private async collectNonStreaming(
    sourceBody: ReadableStream<Uint8Array>
  ): Promise<{ answer: string; reasoning: string; error: string | null }> {
    let answer = "";
    let reasoning = "";
    let error: string | null = null;
    try {
      await drainSseDeltas(sourceBody, (delta) => {
        if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) answer += delta.content;
        return delta.done;
      });
    } catch {
      /* best-effort — return what we have */
    }
    return { answer, reasoning, error };
  }

  /** POST the chat request upstream. Returns either the upstream Response or an error result. */
  private async fetchUpstream(
    reqHeaders: Record<string, string>,
    reqBody: Record<string, unknown>,
    body: unknown,
    signal: AbortSignal | null | undefined
  ): Promise<{ upstream: Response } | { errorResult: ReturnType<typeof makeErrorResult> }> {
    let upstream: Response;
    try {
      upstream = await fetch(CHAT_URL, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(reqBody),
        signal: signal ?? undefined,
      });
    } catch (err) {
      return {
        errorResult: makeErrorResult(
          502,
          `Z.ai fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
          body,
          CHAT_URL
        ),
      };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return {
        errorResult: makeErrorResult(
          upstream.status,
          `Z.ai error: ${sanitizeErrorMessage(errText)}`,
          body,
          CHAT_URL
        ),
      };
    }
    return { upstream };
  }

  private makeChunkEmitter(id: string, created: number, modelId: string): ChunkEmitter {
    return (controller, delta, finish = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    };
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;

    // Tier 1/2: a pasted cookie or bare JWT. Tier 3: mint an anonymous guest token.
    const rawCookie = normalizeCookie(String(credentials?.apiKey ?? "").trim());
    let token = extractZaiToken(rawCookie);
    let cookieHeader = rawCookie;
    if (!token && !rawCookie) {
      token = await mintGuestToken(signal);
      cookieHeader = token ? `token=${token}` : "";
      if (!token) {
        return makeErrorResult(
          502,
          "Z.ai guest-token mint failed and no chat.z.ai Cookie was supplied. Paste the full Cookie header from chat.z.ai (must contain token=<JWT>) or retry (guest endpoint is rate-limited).",
          body,
          AUTH_URL
        );
      }
    } else if (!token && rawCookie) {
      // Cookie header present but without a recognizable `token=`; still send it.
      token = "";
    }

    const captcha = this.resolveCaptcha(input);
    const messages = (bodyObj.messages as Array<{ role: string; content: unknown }>) || [];
    const modelId = (bodyObj.model as string) || DEFAULT_MODEL;
    const reqBody = this.buildRequestBody(messages, modelId, captcha);
    const reqHeaders = this.buildZaiHeaders(cookieHeader, token, captcha);

    const fetched = await this.fetchUpstream(reqHeaders, reqBody, body, signal);
    if ("errorResult" in fetched) return fetched.errorResult;
    const { upstream } = fetched;

    const id = `chatcmpl-zai-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const emitChunk = this.makeChunkEmitter(id, created, modelId);

    if (wantStream) {
      const sourceBody = upstream.body ?? new ReadableStream({ start: (c) => c.close() });
      const outStream = this.buildStreamingBody(sourceBody, emitChunk, signal);
      return {
        response: new Response(outStream, {
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

    // Non-streaming: buffer the whole SSE body once so we can both detect an
    // upstream error frame (403 user-level / CAPTCHA / 426) and aggregate text.
    const fullText = await upstream.text().catch(() => "");
    const upstreamError = scanSseForError(fullText);
    if (upstreamError) {
      return makeErrorResult(
        502,
        `Z.ai upstream rejected the request: ${upstreamError}`,
        body,
        CHAT_URL
      );
    }
    const bufferedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(fullText));
        controller.close();
      },
    });
    const { answer, reasoning } = await this.collectNonStreaming(bufferedStream);
    const message: Record<string, unknown> = { role: "assistant", content: answer };
    if (reasoning) message.reasoning_content = reasoning;
    const completion = {
      id,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: "stop" }],
    };
    return {
      response: new Response(JSON.stringify(completion), {
        headers: { "Content-Type": "application/json" },
      }),
      url: CHAT_URL,
      headers: reqHeaders,
      transformedBody: reqBody,
    };
  }
}
