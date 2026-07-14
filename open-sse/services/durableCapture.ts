/**
 * Durable JSONL traffic capture for the executor fetch boundary (Layer 2).
 *
 * Why this exists: OmniRoute's built-in MITM inspector
 * (`src/mitm/inspector/agentBridgeHook.ts`) only sees traffic that flows
 * through the MITM proxy (port 8080). API-pipeline traffic entering via
 * `/v1/messages` (port 20128) never reaches that hook. This module captures at
 * the ONE point every provider's upstream call passes through:
 * `BaseExecutor.execute()`'s `fetch()`. One hook, all providers, all formats.
 *
 * Output: line-delimited JSONL at
 *   <DATA_DIR|~/.omniroute>/captures/<provider>/<YYYY-MM-DD>.jsonl
 * Headers are sanitized (`sanitizeHeaders`) and bodies masked (`maskSecret`);
 * body sizes are capped at the same 1 MiB budget as the inspector buffer.
 *
 * Streaming safety: the response body is read via `response.clone()`, whose
 * body stream is an independent tee branch. `clone()` is used instead of a raw
 * `response.body.tee()` on purpose — it preserves the ORIGINAL `Response`
 * object (its `url`, `ok`, `type`, `status`, `headers`, and body) untouched for
 * the caller, so nothing downstream has to reconstruct a Response. This mirrors
 * the pattern `base.ts` already relies on for its 400-fallback error reads
 * (`response.clone().text()`), which proves clone() is safe at this callsite.
 * All capture work is fire-and-forget and fully wrapped in try/catch so a
 * capture failure can never break the executor path.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INTEGRATION (separate PR — do NOT edit base.ts here):
 *
 * In `open-sse/executors/base.ts`, inside `execute()`:
 *
 *   1. Just before the upstream fetch (line ~1207, `let response = await
 *      fetchWithStartTimeout(url, fetchOptions);`), record the start time:
 *
 *        const __captureStart = Date.now();
 *
 *   2. Just before the success return (line ~1295,
 *      `return { response, url, headers: finalHeaders, transformedBody: ... };`),
 *      add:
 *
 *        captureUpstreamExchange({
 *          provider: this.provider,
 *          model,
 *          clientHeaders,
 *          requestHeaders: finalHeaders,
 *          requestBody: bodyString,
 *          response,
 *          latencyMs: Date.now() - __captureStart,
 *        });
 *
 *   3. (Optional) in the catch block (line ~1296) before it rethrows/falls
 *      back, add:
 *
 *        captureUpstreamError({
 *          provider: this.provider,
 *          model,
 *          clientHeaders,
 *          requestHeaders: finalHeaders,
 *          requestBody: typeof bodyString === "string" ? bodyString : null,
 *          error: err,
 *          latencyMs: Date.now() - __captureStart,
 *        });
 *
 *   Both functions return void, never throw, and never mutate `response`.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecret } from "@/mitm/maskSecrets";
import { sanitizeHeaders } from "@/mitm/sanitizeHeaders";

const TRUNCATION_MARKER = "\n…(truncated for capture)";
const AGENT_BACKEND_HEADER = "x-claude-proxy-subagent-backend";
const AGENT_MODEL_HEADER = "x-claude-proxy-subagent-model";

export interface CaptureInput {
  provider: string;
  model: string;
  /** Original client request headers — read for agent attribution. */
  clientHeaders?: Record<string, string> | null;
  /** Final headers actually sent upstream. */
  requestHeaders: Record<string, string>;
  /** Serialized request body actually sent upstream. */
  requestBody: string | null;
  /** The upstream Response. Left fully intact for the caller. */
  response: Response;
  latencyMs: number;
}

export interface CaptureErrorInput {
  provider: string;
  model: string;
  clientHeaders?: Record<string, string> | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  error: unknown;
  latencyMs: number;
}

interface CaptureEntry {
  timestamp: string;
  provider: string;
  model: string;
  agentBackend: string | null;
  agentModel: string | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  latencyMs: number;
  error: string | null;
}

function isDisabled(): boolean {
  return process.env.OMNIROUTE_CAPTURE_DISABLED === "1";
}

function maxBodyBytes(): number {
  const raw =
    process.env.OMNIROUTE_CAPTURE_MAX_BODY_KB ?? process.env.INSPECTOR_MAX_BODY_KB;
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

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function capString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + TRUNCATION_MARKER;
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

function baseEntry(
  input: Pick<
    CaptureInput,
    "provider" | "model" | "clientHeaders" | "requestHeaders" | "requestBody" | "latencyMs"
  >
): CaptureEntry {
  const limit = maxBodyBytes();
  const requestBody =
    typeof input.requestBody === "string" && input.requestBody.length > 0
      ? maskSecret(capString(input.requestBody, limit))
      : null;
  return {
    timestamp: new Date().toISOString(),
    provider: input.provider,
    model: input.model,
    agentBackend: headerLookup(input.clientHeaders, AGENT_BACKEND_HEADER),
    agentModel: headerLookup(input.clientHeaders, AGENT_MODEL_HEADER),
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    requestBody,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    latencyMs: input.latencyMs,
    error: null,
  };
}

/**
 * Capture a completed upstream exchange. Fire-and-forget: schedules the write
 * on a microtask, returns immediately, never throws, never mutates `response`.
 */
export function captureUpstreamExchange(input: CaptureInput): void {
  if (isDisabled()) return;
  try {
    const entry = baseEntry(input);
    entry.responseStatus = input.response.status;
    entry.responseHeaders = sanitizeHeaders(headersToRecord(input.response.headers));

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
        entry.responseBody = body.length > 0 ? maskSecret(body) : null;
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
 * Capture a failed upstream exchange (fetch threw / timed out). Fire-and-forget.
 */
export function captureUpstreamError(input: CaptureErrorInput): void {
  if (isDisabled()) return;
  try {
    const entry = baseEntry(input);
    entry.error = input.error instanceof Error ? input.error.message : String(input.error);
    void writeEntry(entry).catch(() => {});
  } catch {
    // best-effort — never surface capture failures
  }
}
