/**
 * GlmWebExecutor — free GLM (Zhipu / 智谱清言) via the chatglm.cn consumer webchat.
 *
 * This is a NATIVE OmniRoute executor: it talks to chatglm.cn directly, with no
 * shared-relay-proxy sidecar. The native `glm`/`glmt`/`glm-cn` executors hit the
 * PAID api.z.ai / bigmodel.cn API-key endpoints — a different product. This one
 * reproduces the FREE webchat path (guest-token / refresh-token + md5 signing +
 * cumulative-snapshot SSE) that used to live in the sidecar.
 *
 * Auth (default = free, zero credentials):
 *   1. Guest token — POST /chatglm/user-api/guest/access mints a ~24h JWT with no
 *      account. This is the baseline; the provider works with an empty connection.
 *   2. Optional refresh_token — a chatglm.cn `chatglm_refresh_token` cookie pasted
 *      as the connection credential (or read from ~/.config/glm-refresh-token /
 *      $GLM_REFRESH_TOKEN) exchanges for a higher-limit access token via
 *      POST /chatglm/user-api/user/refresh.
 * Access tokens are cached per credential and re-minted on expiry or a 401.
 *
 * Wire details + the confirming upstream probe live in ./glm-web/protocol.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult, sanitizeErrorMessage } from "../utils/error.ts";
import {
  GLM_WEB_BASE,
  GLM_GUEST_URL,
  GLM_REFRESH_URL,
  GLM_STREAM_URL,
  GLM_CONVERSATION_DELETE_URL,
  buildSignHeaders,
  buildStreamBody,
  extractTokenResult,
  jwtExpSeconds,
  messagesToPrompt,
  parseFrame,
  resolveAssistantId,
  wantsReasoning,
} from "./glm-web/protocol.ts";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// access-token cache keyed by the credential ("__guest__" for the anon path or
// the refresh-token value for the logged-in path). Small + bounded.
const tokenCache = new Map<string, CachedToken>();
const CACHE_MAX = 64;
const REFRESH_LEAD_MS = 60_000;

function cachePut(key: string, accessToken: string): void {
  const exp = jwtExpSeconds(accessToken);
  const expiresAtMs = exp ? exp * 1000 : Date.now() + 23 * 60 * 60 * 1000;
  if (tokenCache.size >= CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(key, { accessToken, expiresAtMs });
}

function cacheGet(key: string): string | null {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAtMs - REFRESH_LEAD_MS > Date.now()) return hit.accessToken;
  if (hit) tokenCache.delete(key);
  return null;
}

/** Pull an optional refresh_token from the connection credential. */
function extractRefreshToken(credentials: Record<string, unknown> | undefined): string | null {
  const raw = credentials?.apiKey ?? credentials?.accessToken;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^bearer\s+/i, "").replace(/^cookie:\s*/i, "");
  if (!trimmed) return null;
  // Accept a full cookie blob and pick chatglm_refresh_token out of it.
  if (trimmed.includes(";") || trimmed.includes("chatglm_refresh_token=")) {
    const m = trimmed.match(/(?:^|;\s*)chatglm_refresh_token=([^;\s]+)/);
    return m ? m[1] : null;
  }
  return trimmed;
}

/**
 * Best-effort read of a refresh token from disk when no connection credential is
 * supplied. Honors the task's optional ~/.config/glm-refresh-token path (override
 * with $GLM_REFRESH_TOKEN or $GLM_REFRESH_TOKEN_PATH). Never throws.
 */
function readRefreshTokenFromDisk(): string | null {
  const envTok = process.env.GLM_REFRESH_TOKEN?.trim();
  if (envTok) return envTok;
  const path = process.env.GLM_REFRESH_TOKEN_PATH?.trim() || join(homedir(), ".config", "glm-refresh-token");
  try {
    const contents = readFileSync(path, "utf-8").trim();
    return contents || null;
  } catch {
    return null;
  }
}

export class GlmWebExecutor extends BaseExecutor {
  constructor() {
    super("glm-web", { id: "glm-web", baseUrl: GLM_WEB_BASE });
  }

  async testConnection(
    credentials: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const token = await this.acquireAccessToken(credentials, signal ?? null, false);
      return !!token;
    } catch {
      return false;
    }
  }

  /** Mint (or reuse a cached) chatglm.cn access token. Guest by default. */
  private async acquireAccessToken(
    credentials: Record<string, unknown> | undefined,
    signal: AbortSignal | null,
    forceFresh: boolean,
    log?: ExecuteInput["log"]
  ): Promise<string> {
    const refreshToken = extractRefreshToken(credentials) ?? readRefreshTokenFromDisk();
    const cacheKey = refreshToken ? `rt:${refreshToken.slice(-16)}` : "__guest__";

    if (!forceFresh) {
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
    } else {
      tokenCache.delete(cacheKey);
    }

    const url = refreshToken ? GLM_REFRESH_URL : GLM_GUEST_URL;
    const headers = buildSignHeaders({ accessToken: refreshToken ?? null });
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: "{}",
      signal: signal ?? undefined,
    });
    if (!resp.ok) {
      throw new Error(`token endpoint HTTP ${resp.status} (${refreshToken ? "refresh" : "guest"})`);
    }
    const json = (await resp.json()) as Record<string, unknown>;
    if (typeof json.status === "number" && json.status !== 0) {
      throw new Error(`chatglm token error status=${json.status}: ${String(json.message ?? "")}`);
    }
    const { accessToken } = extractTokenResult(json);
    if (!accessToken) throw new Error("token endpoint returned no access_token");
    cachePut(cacheKey, accessToken);
    log?.info?.("GLM-WEB", `access token acquired via ${refreshToken ? "refresh" : "guest"} path`);
    return accessToken;
  }

  private deleteConversation(accessToken: string, assistantId: string, conversationId: string): void {
    if (!conversationId) return;
    fetch(GLM_CONVERSATION_DELETE_URL, {
      method: "POST",
      headers: buildSignHeaders({ accessToken }),
      body: JSON.stringify({ assistant_id: assistantId, conversation_id: conversationId }),
    }).catch(() => {
      // best-effort cleanup — keeps guest chat history tidy, never fatal.
    });
  }

  async execute({ model, body, stream, credentials, signal, log }: ExecuteInput) {
    const bodyObj = (body || {}) as Record<string, unknown>;
    const rawCreds = credentials as unknown as Record<string, unknown>;
    const clientModel = typeof model === "string" && model.trim() ? model.trim() : "glm-web";
    const assistantId = resolveAssistantId(model);
    const reasoning = wantsReasoning(model, bodyObj);
    const messages = Array.isArray(bodyObj.messages)
      ? (bodyObj.messages as Array<{ role: string; content: unknown }>)
      : [];
    const prompt = messagesToPrompt(messages);
    if (!prompt) {
      return makeErrorResult(400, "glm-web: no user message content to send", body, GLM_STREAM_URL);
    }

    const requestPayload = buildStreamBody({ assistantId, prompt, reasoning });
    const referer = `${GLM_WEB_BASE}/main/alltoolsdetail`;

    // One completion attempt with a given access token. Returns the raw upstream
    // response so the caller can retry once on a 401 with a fresh token.
    const attempt = async (accessToken: string): Promise<Response> => {
      const headers = buildSignHeaders({ accessToken, sse: true, referer });
      return fetch(GLM_STREAM_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: signal ?? undefined,
      });
    };

    try {
      let accessToken = await this.acquireAccessToken(rawCreds, signal ?? null, false, log);
      let resp = await attempt(accessToken);

      // Expired token → mint a fresh one and retry once.
      if (resp.status === 401 || resp.status === 403) {
        log?.warn?.("GLM-WEB", `stream ${resp.status} — re-minting token and retrying`);
        accessToken = await this.acquireAccessToken(rawCreds, signal ?? null, true, log);
        resp = await attempt(accessToken);
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return makeErrorResult(
          resp.status,
          `glm-web error ${resp.status}: ${sanitizeErrorMessage(errText)}`,
          requestPayload,
          GLM_STREAM_URL
        );
      }

      const reqHeaders = buildSignHeaders({ accessToken, sse: true, referer });
      const cleanupToken = accessToken;
      const self = this;

      if (stream !== false) {
        const outStream = transformGlmStream(resp.body!, clientModel, (conversationId) =>
          self.deleteConversation(cleanupToken, assistantId, conversationId)
        );
        return {
          response: new Response(outStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          }),
          url: GLM_STREAM_URL,
          headers: reqHeaders,
          transformedBody: requestPayload,
        };
      }

      // Non-streaming: collect the final cumulative snapshot into a chat.completion.
      const collected = await collectGlmStream(resp.body!);
      this.deleteConversation(cleanupToken, assistantId, collected.conversationId);
      if (collected.interveneText && !collected.text) {
        return makeErrorResult(
          451,
          `glm-web content blocked: ${collected.interveneText}`,
          requestPayload,
          GLM_STREAM_URL
        );
      }
      const message: Record<string, unknown> = { role: "assistant", content: collected.text };
      if (collected.reasoning) message.reasoning_content = collected.reasoning;
      const openaiResponse = {
        id: `chatcmpl-glm-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: clientModel,
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return {
        response: new Response(JSON.stringify(openaiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: GLM_STREAM_URL,
        headers: reqHeaders,
        transformedBody: requestPayload,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === "AbortError") {
        return makeErrorResult(499, "Request cancelled", body, GLM_STREAM_URL);
      }
      log?.error?.("GLM-WEB", `execute failed: ${msg}`);
      return makeErrorResult(502, `glm-web error: ${sanitizeErrorMessage(msg)}`, body, GLM_STREAM_URL);
    }
  }
}

/**
 * Iterate parsed chatglm SSE frames from a raw upstream body, invoking `onFrame`
 * with each JSON frame. Resolves when the stream ends.
 */
async function forEachFrame(
  upstream: ReadableStream<Uint8Array>,
  onFrame: (frame: Record<string, unknown>) => boolean | void
): Promise<void> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      const stop = onFrame(frame);
      if (stop === true) return;
    }
  }
}

/** Transform chatglm cumulative SSE into OpenAI chat.completion.chunk SSE. */
export function transformGlmStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onDone: (conversationId: string) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-glm-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentText = 0;
  let sentReasoning = 0;
  let emittedRole = false;
  let conversationId = "";

  return new ReadableStream({
    async start(controller) {
      const emit = (delta: Record<string, unknown>, finish: string | null = null) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`
          )
        );
      };
      const ensureRole = () => {
        if (!emittedRole) {
          emittedRole = true;
          emit({ role: "assistant", content: "" });
        }
      };
      const finishStream = () => {
        ensureRole();
        emit({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        onDone(conversationId);
      };

      try {
        await forEachFrame(upstream, (raw) => {
          const snap = parseFrame(raw);
          if (snap.conversationId) conversationId = snap.conversationId;

          // chatglm text is cumulative — emit only the newly-appended suffix.
          if (snap.reasoning.length > sentReasoning) {
            ensureRole();
            emit({ reasoning_content: snap.reasoning.slice(sentReasoning) });
            sentReasoning = snap.reasoning.length;
          }
          if (snap.text.length > sentText) {
            ensureRole();
            emit({ content: snap.text.slice(sentText) });
            sentText = snap.text.length;
          }
          if (snap.interveneText && !snap.text) {
            ensureRole();
            emit({ content: `\n[content blocked: ${snap.interveneText}]` });
          }
          if (snap.status === "finish" || snap.status === "intervene") return true;
          return undefined;
        });
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
        return;
      }
      finishStream();
    },
  });
}

/** Drain a chatglm stream into the final cumulative text/reasoning (non-streaming). */
export async function collectGlmStream(
  upstream: ReadableStream<Uint8Array>
): Promise<{ text: string; reasoning: string; conversationId: string; interveneText: string }> {
  let text = "";
  let reasoning = "";
  let conversationId = "";
  let interveneText = "";
  await forEachFrame(upstream, (raw) => {
    const snap = parseFrame(raw);
    if (snap.conversationId) conversationId = snap.conversationId;
    if (snap.text) text = snap.text;
    if (snap.reasoning) reasoning = snap.reasoning;
    if (snap.interveneText) interveneText = snap.interveneText;
    if (snap.status === "finish" || snap.status === "intervene") return true;
    return undefined;
  });
  return { text, reasoning, conversationId, interveneText };
}

export const glmWebExecutor = new GlmWebExecutor();
export { tokenCache };
