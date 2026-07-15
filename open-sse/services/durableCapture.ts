/**
 * Durable JSONL traffic capture at the universal fetch choke point.
 *
 * Why this exists: OmniRoute's built-in MITM inspector only sees traffic that
 * flows through the MITM proxy. API-pipeline traffic entering via
 * `/v1/chat/completions` / `/v1/messages` (port 20128) never reaches that hook.
 * This module captures the TRANSFORMED upstream request + the RAW upstream
 * response at the ONE point every provider's upstream call passes through:
 * the `globalThis.fetch` monkey-patch (`open-sse/utils/proxyFetch.ts` →
 * `patchedFetch`), wired via the existing AsyncLocalStorage fetch wrapper in
 * `open-sse/utils/providerRequestLogging.ts::installFetchCapture`.
 *
 * Capturing at the fetch layer (not `BaseExecutor.execute()`) is deliberate:
 * ~9 web executors (deepseek-web, glm-web, kimi-web, perplexity-web,
 * huggingchat, lmarena, antigravity, …) override `execute()` and never call
 * `super`, so a `base.ts` hook silently misses them. Every one of them still
 * dispatches through `globalThis.fetch`, so this seam catches them all.
 *
 * Correlation: every capture line records `correlationId` + `attempt` (+ `leg`,
 * provider, model) read synchronously from the per-request AsyncLocalStorage
 * context set around `executor.execute()` in `chatCore.ts`. This disambiguates
 * one client request's fan-out (combo / fusion / pipeline / retry+rotate).
 *
 * Output: line-delimited JSONL at
 *   <DATA_DIR|~/.omniroute>/captures/<provider>/<YYYY-MM-DD>.jsonl
 * Files rotate daily by name; retention is left to the operator (e.g. a cron
 * `find … -mtime +N -delete`), so an always-on capture cannot grow unbounded.
 *
 * Safety:
 *   - DEFAULT OFF. Capture is a no-op unless the operator opts in with
 *     `OMNIROUTE_RAWCAP=1` (or `=true`). `OMNIROUTE_CAPTURE_DISABLED=1` is an
 *     additional hard kill-switch that wins over the opt-in.
 *   - Auth headers are scrubbed (`sanitizeHeaders` masks authorization/cookie/
 *     api-key/set-cookie, drops hop-by-hop/denylist headers).
 *   - Bodies are secret-masked (`maskSecret`) AND PII-redacted
 *     (`redactPIIForCapture`) before ever touching disk, then capped at a
 *     1 MiB budget (`OMNIROUTE_CAPTURE_MAX_BODY_KB`).
 *   - Binary media endpoints (audio/image/video/speech) and binary
 *     content-types are captured as metadata only — their base64 bodies are
 *     omitted (base64 inflates ~33% and holds no useful text).
 *   - The response body is read via `response.clone()` (an independent tee
 *     branch), leaving the ORIGINAL `Response` fully intact for the caller. All
 *     capture work is fire-and-forget and wrapped in try/catch — a capture
 *     failure can never break, block, or mutate the executor path.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecret } from "@/mitm/maskSecrets";
import { sanitizeHeaders } from "@/mitm/sanitizeHeaders";
import { redactPIIForCapture } from "@/lib/piiSanitizer";

const TRUNCATION_MARKER = "\n…(truncated for capture)";
const BINARY_MEDIA_MARKER = "[binary-media-omitted]";
const AGENT_BACKEND_HEADER = "x-claude-proxy-subagent-backend";
const AGENT_MODEL_HEADER = "x-claude-proxy-subagent-model";

// URL paths whose bodies are binary media (base64-inflated, no useful text).
const BINARY_MEDIA_PATH_RE = /\/(audio|images?|video|speech|transcriptions|translations)(\/|\?|$)/i;

/**
 * Per-request correlation context, set around `executor.execute()` in
 * `chatCore.ts` and read synchronously by the fetch-layer capture.
 */
export interface CaptureContext {
  correlationId: string | null;
  /** Retry/rotate attempt index (0-based) within the current target. */
  attempt: number;
  provider: string;
  model: string;
  /** Which execution leg produced this call (primary/stream-recovery/refresh-retry). */
  leg?: string | null;
  /** Original client request headers — read for agent attribution only. */
  clientHeaders?: Record<string, string> | null;
}

/**
 * Input for capturing leg (1) `client_in`: the raw client request exactly as
 * received, BEFORE OmniRoute translates/compresses it. Emitted from the request
 * ingress in `chatCore.ts` (and the `/v1/responses` adapter) under the SAME
 * `correlationId` used for the upstream legs, so all legs of one client request
 * correlate.
 */
export interface CaptureClientInInput {
  correlationId: string | null;
  provider: string;
  model: string;
  /** Client endpoint the request arrived on (e.g. `/v1/chat/completions`). */
  endpoint: string;
  /** Raw client headers (Headers instance or plain record). Scrubbed on write. */
  clientHeaders: Headers | Record<string, string | string[] | undefined> | null | undefined;
  /** Raw client body (object or already-serialized string), pre-translation. */
  clientBody: unknown;
  /** Optional attempt index; client_in is normally attempt-independent (0). */
  attempt?: number;
}

/**
 * Input for capturing leg (4) `client_out`: the FINAL response OmniRoute returns
 * to the client, AFTER post-processing (decompression, translation back, SSE
 * reframing incl. the Responses-API `TransformStream`). The response is teed
 * with `clone()` the same backpressure-safe way (3) is, and left fully intact.
 */
export interface CaptureClientOutInput {
  correlationId: string | null;
  provider: string;
  model: string;
  /** Client endpoint (optional, used only for binary-media detection). */
  endpoint?: string | null;
  /** The final client-facing Response. Left fully intact for the caller. */
  response: Response;
  attempt?: number;
}

export interface CaptureFromFetchInput {
  /** Final upstream URL actually requested. */
  url: string;
  /** Final headers actually sent upstream. */
  requestHeaders: Record<string, string>;
  /** Serialized request body actually sent upstream (null if non-text/binary). */
  requestBody: string | null;
  /** The upstream Response. Left fully intact for the caller. */
  response: Response;
  latencyMs: number;
}

interface CaptureEntry {
  timestamp: string;
  correlationId: string | null;
  attempt: number;
  leg: string | null;
  provider: string;
  model: string;
  agentBackend: string | null;
  agentModel: string | null;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  latencyMs: number;
  error: string | null;
}

/**
 * DEFAULT OFF. Effective gate: opt-in via `OMNIROUTE_RAWCAP`, unless the hard
 * kill-switch `OMNIROUTE_CAPTURE_DISABLED=1` is set (which always wins).
 */
export function isCaptureEnabled(): boolean {
  if (process.env.OMNIROUTE_CAPTURE_DISABLED === "1") return false;
  const raw = process.env.OMNIROUTE_RAWCAP;
  return raw === "1" || raw === "true";
}

function maxBodyBytes(): number {
  const raw = process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB ?? process.env.INSPECTOR_MAX_BODY_KB;
  const kb = raw ? Number(raw) : NaN;
  const resolved = Number.isFinite(kb) && kb > 0 ? kb : 1024;
  return Math.max(1, Math.floor(resolved)) * 1024;
}

function baseCaptureDir(): string {
  const override = process.env.OMNIROUTE_CAPTURE_DIR;
  if (override) return override;
  const dataDir = process.env.DATA_DIR || join(homedir(), ".omniroute");
  return join(dataDir, "captures");
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Keep provider names safe as a single path segment (no traversal, no separators). */
function sanitizeSegment(value: string): string {
  const cleaned = (value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function headerLookup(
  headers: Record<string, string> | null | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

/**
 * Scrub headers for capture. `sanitizeHeaders` masks authorization/api-key,
 * drops denylist headers, and hard-redacts `set-cookie`, but the REQUEST
 * `cookie` header can carry a short session/CSRF id that `maskSecret`'s
 * length heuristics miss. Hard-redact it here so no cookie secret is ever
 * persisted to a capture file.
 */
function scrubHeadersForCapture(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out = sanitizeHeaders(headers);
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "cookie") out[key] = "[REDACTED]";
  }
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * Normalize an incoming client header carrier to a plain record. Client
 * requests reach OmniRoute either as a `Headers` instance (fetch/Web) or as a
 * plain object (Node/worker), and `chatCore` already treats both shapes; the
 * capture layer must too.
 */
function toHeaderRecord(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined
): Record<string, string | string[] | undefined> {
  if (!headers) return {};
  const maybeHeaders = headers as Headers;
  if (typeof maybeHeaders.forEach === "function" && typeof maybeHeaders.get === "function") {
    return headersToRecord(maybeHeaders);
  }
  return headers as Record<string, string | string[] | undefined>;
}

/** Serialize a client body (object or already-serialized string) for capture. */
function serializeBody(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

function capString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + TRUNCATION_MARKER;
}

/** Mask secrets + redact PII + cap. Used for both request and response bodies. */
function scrubBody(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const capped = capString(value, limit);
  return redactPIIForCapture(maskSecret(capped));
}

function isBinaryMediaUrl(url: string): boolean {
  try {
    return BINARY_MEDIA_PATH_RE.test(new URL(url).pathname);
  } catch {
    return BINARY_MEDIA_PATH_RE.test(url);
  }
}

function isBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("audio/") ||
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("application/octet-stream")
  );
}

/**
 * Read a response body stream, retaining at most `limit` bytes but always
 * draining to completion so the other tee branch (the real response the caller
 * consumes) is never blocked by backpressure.
 */
async function readCappedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (truncated || !value) continue; // keep draining, discard extra
      const remaining = limit - bytes;
      if (value.byteLength <= remaining) {
        out += decoder.decode(value, { stream: true });
        bytes += value.byteLength;
      } else {
        if (remaining > 0) {
          out += decoder.decode(value.subarray(0, remaining), { stream: true });
        }
        truncated = true;
      }
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return truncated ? out + TRUNCATION_MARKER : out;
}

const createdDirs = new Set<string>();
let writeChain: Promise<void> = Promise.resolve();

/** Serialize appends so concurrent captures never interleave partial lines. */
async function writeEntry(entry: CaptureEntry): Promise<void> {
  const dir = join(baseCaptureDir(), sanitizeSegment(entry.provider));
  const file = join(dir, `${dateStamp()}.jsonl`);
  const line = JSON.stringify(entry) + "\n";
  writeChain = writeChain
    .then(async () => {
      if (!createdDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        createdDirs.add(dir);
      }
      await appendFile(file, line, "utf8");
    })
    .catch(() => {
      // best-effort: a failed write must not poison the chain for later entries
    });
  await writeChain;
}

function baseEntry(ctx: CaptureContext, input: CaptureFromFetchInput): CaptureEntry {
  const limit = maxBodyBytes();
  return {
    timestamp: new Date().toISOString(),
    correlationId: ctx.correlationId ?? null,
    attempt: ctx.attempt,
    leg: ctx.leg ?? null,
    provider: ctx.provider,
    model: ctx.model,
    agentBackend: headerLookup(ctx.clientHeaders, AGENT_BACKEND_HEADER),
    agentModel: headerLookup(ctx.clientHeaders, AGENT_MODEL_HEADER),
    url: input.url,
    requestHeaders: scrubHeadersForCapture(input.requestHeaders),
    requestBody: scrubBody(input.requestBody, limit),
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    latencyMs: input.latencyMs,
    error: null,
  };
}

// ── AsyncLocalStorage correlation context ──

const captureContextStore = new AsyncLocalStorage<CaptureContext>();

/**
 * Run `fn` with a capture correlation context in scope, so any upstream fetch
 * it triggers is recorded with the right correlationId/attempt/provider/model.
 * When capture is OFF this is a zero-overhead pass-through (no context set).
 */
export function runWithCaptureContext<T>(ctx: CaptureContext, fn: () => T): T {
  if (!isCaptureEnabled()) return fn();
  return captureContextStore.run(ctx, fn);
}

export function getCaptureContext(): CaptureContext | null {
  return captureContextStore.getStore() ?? null;
}

/**
 * Capture a completed upstream exchange observed at the fetch layer.
 * Fire-and-forget: reads status/headers + correlation synchronously, defers
 * only the response-body read onto a microtask. Never throws, never mutates
 * `input.response`. No-op unless capture is enabled AND a correlation context
 * is active (which scopes capture to provider upstream calls).
 */
export function captureUpstreamFromFetch(input: CaptureFromFetchInput): void {
  if (!isCaptureEnabled()) return;
  const ctx = getCaptureContext();
  if (!ctx) return;
  try {
    const entry = baseEntry(ctx, input);
    entry.responseStatus = input.response.status;
    entry.responseHeaders = scrubHeadersForCapture(headersToRecord(input.response.headers));

    const contentType = input.response.headers.get("content-type");
    if (isBinaryMediaUrl(input.url) || isBinaryContentType(contentType)) {
      entry.responseBody = BINARY_MEDIA_MARKER;
      void writeEntry(entry).catch(() => {});
      return;
    }

    // clone() tees the body internally, leaving input.response fully intact.
    const clone = input.response.clone();
    const limit = maxBodyBytes();

    void (async () => {
      try {
        let body: string;
        if (clone.body) {
          body = await readCappedStream(clone.body, limit);
        } else {
          body = capString(await clone.text().catch(() => ""), limit);
        }
        entry.responseBody = scrubBody(body, limit);
        await writeEntry(entry);
      } catch {
        // best-effort — never surface capture failures
      }
    })();
  } catch {
    // best-effort — never surface capture failures
  }
}

/**
 * Capture leg (1) `client_in`: the raw client request as received, BEFORE
 * OmniRoute translates/compresses it. Unlike the fetch-layer legs (2)(3), this
 * does NOT read the AsyncLocalStorage context — the caller passes `correlationId`
 * (+ provider/model) explicitly, because ingress runs before the executor scope
 * is entered. Fire-and-forget: never throws, never blocks or mutates the request
 * path. No-op unless capture is enabled (default OFF; see `isCaptureEnabled`).
 */
export function captureClientIn(input: CaptureClientInInput): void {
  if (!isCaptureEnabled()) return;
  try {
    const limit = maxBodyBytes();
    const headers = toHeaderRecord(input.clientHeaders);
    const isBinary = isBinaryMediaUrl(input.endpoint);
    const bodyStr = serializeBody(input.clientBody);
    const entry: CaptureEntry = {
      timestamp: new Date().toISOString(),
      correlationId: input.correlationId ?? null,
      attempt: input.attempt ?? 0,
      leg: "client_in",
      provider: input.provider,
      model: input.model,
      agentBackend: headerLookup(
        headers as Record<string, string> | null,
        AGENT_BACKEND_HEADER
      ),
      agentModel: headerLookup(headers as Record<string, string> | null, AGENT_MODEL_HEADER),
      url: input.endpoint,
      requestHeaders: scrubHeadersForCapture(headers),
      requestBody: isBinary ? BINARY_MEDIA_MARKER : scrubBody(bodyStr, limit),
      responseStatus: null,
      responseHeaders: null,
      responseBody: null,
      latencyMs: 0,
      error: null,
    };
    void writeEntry(entry).catch(() => {});
  } catch {
    // best-effort — never surface capture failures
  }
}

/**
 * Capture leg (4) `client_out`: the FINAL response OmniRoute returns to the
 * client, AFTER all post-processing. Tees the body via `response.clone()` +
 * `readCappedStream` (the same backpressure-safe branch (3) uses), so the real
 * client stream is never blocked, broken, or reordered. Fire-and-forget: never
 * throws, never mutates `input.response`. No-op unless capture is enabled.
 */
export function captureClientOut(input: CaptureClientOutInput): void {
  if (!isCaptureEnabled()) return;
  try {
    const { response } = input;
    const limit = maxBodyBytes();
    const entry: CaptureEntry = {
      timestamp: new Date().toISOString(),
      correlationId: input.correlationId ?? null,
      attempt: input.attempt ?? 0,
      leg: "client_out",
      provider: input.provider,
      model: input.model,
      agentBackend: null,
      agentModel: null,
      url: input.endpoint ?? "",
      requestHeaders: {},
      requestBody: null,
      responseStatus: response.status,
      responseHeaders: scrubHeadersForCapture(headersToRecord(response.headers)),
      responseBody: null,
      latencyMs: 0,
      error: null,
    };

    const contentType = response.headers.get("content-type");
    if (
      (input.endpoint && isBinaryMediaUrl(input.endpoint)) ||
      isBinaryContentType(contentType)
    ) {
      entry.responseBody = BINARY_MEDIA_MARKER;
      void writeEntry(entry).catch(() => {});
      return;
    }

    // clone() tees the body internally, leaving input.response fully intact.
    const clone = response.clone();

    void (async () => {
      try {
        let body: string;
        if (clone.body) {
          body = await readCappedStream(clone.body, limit);
        } else {
          body = capString(await clone.text().catch(() => ""), limit);
        }
        entry.responseBody = scrubBody(body, limit);
        await writeEntry(entry);
      } catch {
        // best-effort — never surface capture failures
      }
    })();
  } catch {
    // best-effort — never surface capture failures
  }
}
