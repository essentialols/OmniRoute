/**
 * Pure protocol helpers for the chatglm.cn (Zhipu 智谱清言) consumer webchat.
 *
 * Kept side-effect free so they can be unit-tested without hitting the network.
 * The executor in ../glm-web.ts wires these into fetch()/SSE handling.
 *
 * Wire format confirmed by direct upstream probe (2026-07-14):
 *   - Guest token:   POST /chatglm/user-api/guest/access  (empty body {})
 *                    → { status:0, result:{ access_token, refresh_token, user_id } }
 *                    access_token is a ~24h JWT. No account required.
 *   - Refresh token: POST /chatglm/user-api/user/refresh   (Authorization: Bearer <refresh>)
 *                    → same shape; higher rate limits than guest.
 *   - Chat:          POST /chatglm/backend-api/assistant/stream  (Authorization: Bearer <access>)
 *                    SSE `data: {…}` frames. Text is CUMULATIVE (full snapshot each
 *                    frame), NOT deltas: parts[].content[] with {type:"text",text} and
 *                    {type:"think",think}. Top-level `status` flips to "finish" at end;
 *                    `last_error.intervene_text` carries a moderation block.
 *   - Every signed call needs X-Sign / X-Timestamp / X-Nonce (see buildSignHeaders).
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

export const GLM_WEB_BASE = "https://chatglm.cn";
export const GLM_GUEST_URL = `${GLM_WEB_BASE}/chatglm/user-api/guest/access`;
export const GLM_REFRESH_URL = `${GLM_WEB_BASE}/chatglm/user-api/user/refresh`;
export const GLM_STREAM_URL = `${GLM_WEB_BASE}/chatglm/backend-api/assistant/stream`;
export const GLM_CONVERSATION_DELETE_URL = `${GLM_WEB_BASE}/chatglm/backend-api/assistant/conversation/delete`;

// Default GLM chat assistant. Every chatglm-* model id maps to this assistant at
// the webchat layer; a caller may pass a raw 24-hex assistant id to target a
// custom assistant. Confirmed stable across the 2024 and 2026 client builds.
export const GLM_DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

// md5 signing secret embedded in the chatglm.cn web client. The site flags it
// in-code as "update when the official site changes"; treat as the most likely
// thing to break. The signature covers only `timestamp-nonce-secret` (NOT the
// body), so it is a request-liveness token, not a payload integrity check.
export const GLM_SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

export const GLM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const uuidHex = (): string => randomUUID().replace(/-/g, "");

/**
 * Reproduce the chatglm.cn `generateSign` timestamp mangle + md5 signature.
 *
 * The client mangles the current-ms timestamp by replacing its 2nd-to-last digit
 * with `(digitSum - that digit) % 10`, then signs `timestamp-nonce-secret`.
 * `now` and `nonce` are injectable for deterministic testing.
 */
export function makeSign(
  now: number = Date.now(),
  nonce: string = uuidHex(),
  secret: string = GLM_SIGN_SECRET
): { timestamp: string; nonce: string; sign: string } {
  const a = String(now);
  const t = a.length;
  const digits = a.split("").map((c) => Number(c));
  const mangled = (digits.reduce((x, y) => x + y, 0) - digits[t - 2]) % 10;
  const timestamp = a.slice(0, t - 2) + String(mangled) + a.slice(t - 1);
  const sign = createHash("md5").update(`${timestamp}-${nonce}-${secret}`).digest("hex");
  return { timestamp, nonce, sign };
}

/** Build the full signed header set the chatglm.cn API requires on every call. */
export function buildSignHeaders(opts?: {
  accessToken?: string | null;
  sse?: boolean;
  referer?: string;
  now?: number;
  nonce?: string;
}): Record<string, string> {
  const { timestamp, nonce, sign } = makeSign(opts?.now, opts?.nonce);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: opts?.sse ? "text/event-stream" : "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": GLM_USER_AGENT,
    Origin: GLM_WEB_BASE,
    Referer: opts?.referer ?? `${GLM_WEB_BASE}/`,
    "App-Name": "chatglm",
    "X-App-Platform": "pc",
    "X-App-Version": "0.0.1",
    "X-Device-Id": uuidHex(),
    "X-Request-Id": uuidHex(),
    "X-Nonce": nonce,
    "X-Sign": sign,
    "X-Timestamp": timestamp,
  };
  if (opts?.accessToken) headers["Authorization"] = `Bearer ${opts.accessToken}`;
  return headers;
}

/** Decode the `exp` (unix seconds) claim from a JWT without verifying it. */
export function jwtExpSeconds(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return typeof json?.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the assistant id for a client model string.
 *   - a bare 24+ char hex id → used verbatim (custom assistant)
 *   - anything else (chatglm-5.1, glm-5, …) → the default GLM assistant
 */
export function resolveAssistantId(model?: string): string {
  const m = (model || "").trim();
  if (/^[a-z0-9]{24,}$/i.test(m)) return m;
  return GLM_DEFAULT_ASSISTANT_ID;
}

/** Whether the model id asks for GLM's reasoning ("zero") chat mode. */
export function wantsReasoning(model?: string, body?: Record<string, unknown>): boolean {
  const m = (model || "").toLowerCase();
  if (m.includes("think") || m.includes("reason") || m.includes("-zero")) return true;
  if (body?.reasoning_effort && body.reasoning_effort !== "none") return true;
  if (body?.thinking === true) return true;
  return false;
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((it) => it?.type === "text" && typeof it.text === "string")
      .map((it) => it.text as string)
      .join("\n");
  }
  return typeof content === "string" ? content : "";
}

/**
 * Flatten an OpenAI `messages[]` array into the single user-turn string the
 * chatglm.cn webchat consumes. A single user message is sent as-is; multi-turn
 * conversations are stitched into a role-tagged transcript (system prompt leads).
 */
export function messagesToPrompt(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>
): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const systemParts: string[] = [];
  const turns: Array<{ role: string; text: string }> = [];
  for (const m of messages) {
    const text = contentText(m.content).trim();
    if (!text) continue;
    if (m.role === "system") systemParts.push(text);
    else if (m.role === "user" || m.role === "assistant") turns.push({ role: m.role, text });
    else if (m.role === "tool") turns.push({ role: "tool", text });
  }

  const system = systemParts.join("\n\n");

  // Single user turn (the common case): send just the text, prefixed by system.
  if (turns.length <= 1) {
    const only = turns[0]?.text ?? "";
    return system ? `${system}\n\n${only}` : only;
  }

  const transcript = turns
    .map((t) =>
      t.role === "assistant"
        ? `<|assistant|>\n${t.text}`
        : t.role === "tool"
          ? `<|observation|>\n${t.text}`
          : `<|user|>\n${t.text}`
    )
    .join("\n");
  const head = system ? `<|system|>\n${system}\n` : "";
  return `${head}${transcript}\n<|assistant|>\n`;
}

/** Build the assistant/stream request body. */
export function buildStreamBody(opts: {
  assistantId: string;
  prompt: string;
  reasoning: boolean;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    if_plus_model: false,
    is_test: false,
    input_question_type: "xxxx",
    channel: "",
    draft_id: "",
    quote_log_id: "",
    platform: "pc",
  };
  if (opts.reasoning) meta.chat_mode = "zero";
  return {
    assistant_id: opts.assistantId,
    conversation_id: "",
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
    meta_data: meta,
  };
}

export interface GlmFrameSnapshot {
  /** Full cumulative answer text across all `text` parts. */
  text: string;
  /** Full cumulative reasoning text across all `think` parts. */
  reasoning: string;
  /** Upstream conversation id (needed for cleanup). */
  conversationId: string;
  /** Top-level frame status: init | processing | finish | intervene. */
  status: string;
  /** Moderation-block text, when the frame reports last_error.intervene_text. */
  interveneText: string;
}

/**
 * Reduce one parsed chatglm SSE frame into a cumulative snapshot. chatglm sends
 * the FULL text each frame; the executor diffs successive snapshots to derive
 * OpenAI deltas.
 */
export function parseFrame(frame: Record<string, unknown>): GlmFrameSnapshot {
  let text = "";
  let reasoning = "";
  const parts = Array.isArray(frame?.parts) ? (frame.parts as Array<Record<string, unknown>>) : [];
  for (const part of parts) {
    const content = Array.isArray(part?.content)
      ? (part.content as Array<Record<string, unknown>>)
      : [];
    for (const c of content) {
      if (c?.type === "text" && typeof c.text === "string") text += c.text;
      else if (c?.type === "think" && typeof c.think === "string") reasoning += c.think;
    }
  }
  const lastError = (frame?.last_error ?? {}) as Record<string, unknown>;
  const interveneText =
    typeof lastError?.intervene_text === "string" ? lastError.intervene_text : "";
  return {
    text,
    reasoning,
    conversationId: typeof frame?.conversation_id === "string" ? frame.conversation_id : "",
    status: typeof frame?.status === "string" ? frame.status : "",
    interveneText,
  };
}

/** Extract the `access_token` (+ optional `refresh_token`) from a token response. */
export function extractTokenResult(json: unknown): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  const j = (json ?? {}) as Record<string, unknown>;
  const result = (j.result ?? j.data ?? {}) as Record<string, unknown>;
  const accessToken =
    typeof result.access_token === "string"
      ? result.access_token
      : typeof result.accessToken === "string"
        ? result.accessToken
        : null;
  const refreshToken =
    typeof result.refresh_token === "string"
      ? result.refresh_token
      : typeof result.refreshToken === "string"
        ? result.refreshToken
        : null;
  return { accessToken, refreshToken };
}
