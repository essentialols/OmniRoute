/**
 * Shared browser-TLS-impersonating HTTP client for the web-chat executors.
 *
 * Why this exists: several web-chat providers sit behind JA3/JA4-aware WAFs that
 * pin (or challenge on) the client's TLS fingerprint + HTTP/2 SETTINGS frame
 * ordering. Node's Undici fetch presents a deterministic "Node" handshake; when
 * paired with a browser `User-Agent` that mismatch is itself a bot-detection
 * signal. `perplexityTlsClient.ts` and `chatgptTlsClient.ts` already solve this
 * for Cloudflare-fronted providers by wrapping `tls-client-node` (native shared
 * library built from bogdanfinn/tls-client). This module generalizes that exact
 * pattern into one reusable `tlsFetchWebchat()` so additional executors can
 * adopt browser-TLS impersonation without copy-pasting the singleton/streaming
 * machinery.
 *
 * Kept as an independent module so changes here cannot regress the production
 * perplexity-web / chatgpt-web paths (those keep their own dedicated clients).
 * The first call lazily loads the native binding via koffi; subsequent calls
 * reuse a singleton TLSClient. Process exit hooks stop the sidecar cleanly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION POINTS (P0-1: wire browser-TLS into DeepSeek + Qwen executors)
 * ─────────────────────────────────────────────────────────────────────────────
 * Do NOT modify the executors in this PR — the changes below are the follow-up
 * PR. Every `fetch(...)` call in these two executors currently egresses with a
 * JA3=Node handshake behind a browser UA; route each through `tlsFetchWebchat()`
 * with `profile: "chrome_131"` (matches the Chrome 131 UA/client-hints set from
 * `buildChromeClientHintHeaders()`). The TLS client returns a plain result
 * ({ status, headers: Headers, text, body }), so map the vanilla-fetch usage:
 *   - `resp.ok`                  → `status >= 200 && status < 300`
 *   - `resp.status`              → `result.status`
 *   - `resp.headers.get(name)`   → `result.headers.get(name)`
 *   - `resp.json()`              → `JSON.parse(result.text ?? "")`
 *   - `resp.text()`              → `result.text ?? ""`
 *   - `resp.body` (SSE stream)   → `result.body`  (set `stream: true`)
 *
 * open-sse/executors/deepseek-web.ts  (DeepSeek — Huawei/HWWAF JA3 gate)
 *   Replace `fetch(...)` in ALL FIVE call sites so the whole flow shares one
 *   fingerprint (a mixed JA3 across the handshake sequence is itself a signal):
 *     - `acquireAccessToken()`  line ~563  GET  /v0/users/current   → stream:false
 *     - `createSession()`       line ~617  POST /v0/chat_session/create → stream:false
 *     - `deleteSessionOnDeepSeek()` line ~639 POST /v0/chat_session/delete → stream:false
 *     - `getPowChallenge()`     line ~679  POST /v0/chat/create_pow_challenge → stream:false
 *     - `performCompletion()`   line ~907  POST /v0/chat/completion → stream:true,
 *                                          streamEofSymbol: "[DONE]"
 *   The FAKE_HEADERS Chrome UA in deepseek-web.ts already matches a Chrome
 *   profile; keep it (or swap to `buildChromeClientHintHeaders()`) and pass
 *   `profile: "chrome_131"`.
 *
 * open-sse/executors/qwen-web.ts  (Qwen — Alibaba "baxia" JA3 gate)
 *   Replace `fetch(...)` in BOTH call sites:
 *     - create chat  line ~139  POST /api/v2/chats/new            → stream:false
 *     - completion   line ~186  POST /api/v2/chat/completions?... → stream:true,
 *                                          streamEofSymbol: "[DONE]"
 *   qwen-web.ts sends a Windows Chrome 149 UA via `USER_AGENT`; align it with
 *   the chosen TLS profile (use `profile: "chrome_131"` and switch the UA/hints
 *   to `buildChromeClientHintHeaders()` so the JA3 and UA agree).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * P0-2: client-hint header additions (headers only — no TLS change)
 * ─────────────────────────────────────────────────────────────────────────────
 * open-sse/executors/kimi-web.ts  — Kimi has NO known JA3 gate, so it keeps
 *   vanilla `fetch`. It only lacks the browser client-hint headers. In
 *   `buildKimiHeaders()` (line ~210) add these four to the returned object so
 *   the request looks like the real www.kimi.com SPA (which sends them):
 *     "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
 *     "sec-ch-ua-mobile": "?0",
 *     "sec-ch-ua-platform": '"Windows"',   // kimi-web's UA is Windows — keep them consistent
 *     "Accept-Language": "en-US,en;q=0.9",
 *   (Kimi's UA is Chrome 149 Windows; if you also add Sec-Fetch-* the SPA sends
 *   Sec-Fetch-Dest: empty / Mode: cors / Site: same-origin.) Bump the sec-ch-ua
 *   version to match whatever Chrome major the `USER_AGENT` advertises.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, open, unlink, rmdir, stat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
import { resolveTlsClientProxyUrl } from "./tlsClientProxy.ts";

let clientPromise: Promise<unknown> | null = null;
let exitHookInstalled = false;

/**
 * TLS impersonation profile identifiers understood by `tls-client-node`
 * (bogdanfinn/tls-client client-hello presets). Chrome 131/133 pair with the
 * Chrome client-hints from `buildChromeClientHintHeaders()`; Firefox 148 is
 * kept for parity with the existing perplexity/chatgpt clients.
 */
export type WebchatTlsProfile = "chrome_131" | "chrome_133" | "firefox_148";

const DEFAULT_PROFILE: WebchatTlsProfile = "chrome_133";
const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_WEBCHAT_TLS_TIMEOUT_MS || "", 10) || 60_000;
// Grace period added to the binding's wire-level timeout before our JS-level
// hard timeout fires. Under healthy operation `tls-client-node` honors
// `timeoutMilliseconds` and rejects on its own; the JS-level race only wins
// when the koffi-loaded native library is wedged (which the binding's own timer
// can't escape). Keep the grace small so users don't wait noticeably longer
// than the configured timeout when the binding is dead.
const HARD_TIMEOUT_GRACE_MS =
  Number.parseInt(process.env.OMNIROUTE_WEBCHAT_TLS_GRACE_MS || "", 10) || 10_000;
const STREAM_FIRST_BYTE_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_WEBCHAT_STREAM_FIRST_BYTE_TIMEOUT_MS || "", 10) || 30_000;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const stop = async () => {
    if (!clientPromise) return;
    try {
      const c = (await clientPromise) as { stop?: () => Promise<unknown> };
      await c.stop?.();
    } catch {
      // ignore
    }
  };
  process.once("beforeExit", stop);
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

/**
 * Drop the cached client so the next `getClient()` call respawns it. Called when
 * a request observes the native binding has wedged — releasing the reference
 * lets a fresh TLSClient (and a fresh koffi load) take over without a process
 * restart.
 */
function resetClientCache(): void {
  clientPromise = null;
}

export class TlsClientHangError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientHangError";
  }
}

export class TlsClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientUnavailableError";
  }
}

/**
 * Race a `client.request()` promise against (a) a JS-level hard timeout and
 * (b) the caller's abort signal. The native binding's `timeoutMilliseconds`
 * already covers the wire path; this guards the case where the koffi binding
 * itself deadlocks (observed after sustained load), where neither the binding's
 * own timer nor a post-call `signal.aborted` re-check can recover.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | null | undefined
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const racers: Promise<T>[] = [
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TlsClientHangError(
              `tls-client-node call exceeded ${timeoutMs}ms — native binding likely deadlocked`
            )
          );
        }, timeoutMs);
      }),
    ];
    if (signal) {
      racers.push(
        new Promise<T>((_, reject) => {
          if (signal.aborted) {
            reject(makeAbortError(signal));
            return;
          }
          abortListener = () => reject(makeAbortError(signal));
          signal.addEventListener("abort", abortListener, { once: true });
        })
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function getClient(): Promise<{
  request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
}> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const mod = await import("tls-client-node");
        const TLSClient = (mod as { TLSClient: new (opts?: Record<string, unknown>) => unknown })
          .TLSClient;
        // Native mode loads the shared library directly via koffi, avoiding the
        // managed sidecar's localhost HTTP calls that OmniRoute's global fetch
        // proxy patch interferes with.
        const client = new TLSClient({ runtimeMode: "native" }) as {
          start: () => Promise<void>;
          request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
        };
        await client.start();

        installExitHook();
        return client;
      } catch (err) {
        clientPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TlsClientUnavailableError(
          `TLS impersonation client failed to start: ${msg}. ` +
            `Verify tls-client-node is installed and its native binary downloaded.`
        );
      }
    })();
  }
  return clientPromise as Promise<{
    request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
  }>;
}

interface TlsResponseLike {
  status: number;
  headers: Record<string, string[]>;
  body: string; // for non-streaming requests, the full response body
  cookies?: Record<string, string>;
  text: () => Promise<string>;
  bytes: () => Promise<Uint8Array>;
  json: <T = unknown>() => Promise<T>;
}

export interface WebchatTlsFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /**
   * TLS impersonation profile. Defaults to `chrome_133`. Pass `chrome_131` for
   * the Chrome 131 UA/client-hints pairing from `buildChromeClientHintHeaders()`.
   */
  profile?: WebchatTlsProfile;
  /**
   * If true, the response body is streamed to a temp file and exposed as a
   * ReadableStream<Uint8Array>. Use for SSE responses (chat completion
   * endpoints). Otherwise, the full body is read into memory.
   */
  stream?: boolean;
  /** EOF marker the upstream sends to signal end of stream (default: "[DONE]"). */
  streamEofSymbol?: string;
  /**
   * If true, instructs the underlying tls-client to return the response body as
   * a base64 `data:<mime>;base64,...` string (so binary payloads survive the
   * JSON marshalling step). Default false (text mode).
   */
  byteResponse?: boolean;
  /**
   * Optional upstream proxy URL (`http://user:pass@host:port` or `socks5://...`).
   * When set, the request is tunneled through this proxy before reaching the
   * upstream.
   *
   * Resolution order:
   *   1. `options.proxyUrl` (per-call override from caller)
   *   2. dashboard AsyncLocalStorage context / env (`resolveProxyForRequest`)
   *   3. `process.env.HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
   *
   * The native `tls-client-node` binding does NOT consult Go's
   * `http.ProxyFromEnvironment`, so callers / env must be plumbed in here at the
   * JS layer. See `resolveProxyUrl()` for the lookup order.
   */
  proxyUrl?: string;
  /**
   * Temp-file prefix for the streaming spool dir (default `webchat-stream-`).
   * Purely cosmetic — lets callers tell spool files apart per provider.
   */
  streamTempPrefix?: string;
}

export interface WebchatTlsFetchResult {
  status: number;
  headers: Headers;
  /** Full response body as text — only populated for non-streaming requests. */
  text: string | null;
  /** Streaming body — only populated when options.stream === true. */
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Resolve the proxy URL for a tls-client request against `targetUrl`. Per-call
 * value wins; otherwise we use the standard proxy fetch resolution which reads
 * from the dashboard AsyncLocalStorage context or falls back to env vars.
 *
 * Fail-closed: if resolution throws (e.g. a configured socks5 proxy with
 * ENABLE_SOCKS5_PROXY=false), this rethrows rather than returning undefined —
 * undefined would let the native binding connect directly and leak the real IP.
 */
function resolveProxyUrl(targetUrl: string, perCall: string | undefined): string | undefined {
  return resolveTlsClientProxyUrl(targetUrl, perCall, resolveProxyForRequest);
}

// Test-only injection point. Tests call __setWebchatTlsFetchOverrideForTesting()
// to replace the real TLS client with a mock; production never touches this.
let testOverride:
  ((url: string, options: WebchatTlsFetchOptions) => Promise<WebchatTlsFetchResult>) | null = null;

export function __setWebchatTlsFetchOverrideForTesting(fn: typeof testOverride): void {
  testOverride = fn;
}

/**
 * Make a single HTTP request to `url` with a browser-like TLS fingerprint,
 * selected by `options.profile` (default `chrome_133`).
 *
 * Throws TlsClientUnavailableError if the native binary failed to load.
 */
export async function tlsFetchWebchat(
  url: string,
  options: WebchatTlsFetchOptions = {}
): Promise<WebchatTlsFetchResult> {
  if (testOverride) return testOverride(url, options);
  // Honor abort signals up-front. tls-client-node's koffi binding doesn't accept
  // an AbortSignal mid-flight (the binary call is opaque), so the best we can do
  // is bail before issuing the call. We also re-check after — if the caller
  // aborted while the upstream was running, throw rather than returning a stale
  // response so the caller doesn't try to use it.
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }
  const client = await getClient();
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestOptions: Record<string, unknown> = {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
    tlsClientIdentifier: options.profile ?? DEFAULT_PROFILE,
    timeoutMilliseconds: timeoutMs,
    followRedirects: true,
    withRandomTLSExtensionOrder: true,
    isByteResponse: options.byteResponse === true,
    // Plumb the configured proxy through to the native binding. tls-client-node
    // consults `proxyUrl` in the per-call options (it does NOT auto-pick up
    // HTTP_PROXY / HTTPS_PROXY env), so callers / env have to be threaded in
    // explicitly. See `resolveProxyUrl()` for the lookup order. Without this
    // line, every call egresses with the bare host IP regardless of dashboard
    // proxy config.
    proxyUrl: resolveProxyUrl(url, options.proxyUrl),
  };

  if (options.stream) {
    return await tlsFetchStreaming(
      client,
      url,
      requestOptions,
      options.streamEofSymbol,
      options.signal ?? null,
      timeoutMs + HARD_TIMEOUT_GRACE_MS,
      STREAM_FIRST_BYTE_TIMEOUT_MS,
      options.streamTempPrefix ?? "webchat-stream-"
    );
  }

  let tlsResponse: TlsResponseLike;
  try {
    tlsResponse = await raceWithTimeout(
      client.request(url, requestOptions),
      timeoutMs + HARD_TIMEOUT_GRACE_MS,
      options.signal ?? null
    );
  } catch (err) {
    if (err instanceof TlsClientHangError) {
      // The native binding is wedged — drop the singleton so the next request
      // respawns a fresh client (and a fresh koffi load).
      resetClientCache();
    }
    throw err;
  }
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }
  return {
    status: tlsResponse.status,
    headers: toHeaders(tlsResponse.headers),
    text: tlsResponse.body,
    body: null,
  };
}

// ─── Client-hint header builder ─────────────────────────────────────────────

export interface ChromeClientHintOptions {
  /** Full `User-Agent` string. Defaults to the macOS Chrome 131 desktop UA. */
  userAgent?: string;
  /** Chrome major version stamped into `sec-ch-ua`. Default 131. */
  chromeMajor?: number;
  /** `sec-ch-ua-platform` value (quotes added automatically). Default "macOS". */
  platform?: string;
  /** `Sec-Fetch-Site` value. Default "same-origin". */
  fetchSite?: "same-origin" | "same-site" | "cross-site" | "none";
  /** `Accept-Language` header. Default "en-US,en;q=0.9". */
  acceptLanguage?: string;
}

const DEFAULT_CHROME_MAJOR = 131;
const DEFAULT_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Build a matched set of Chrome client-hint + fetch-metadata headers so a
 * request presents a coherent browser identity. Pair with a Chrome TLS profile
 * (`profile: "chrome_131"` / `"chrome_133"`) — sending these hints under a Node
 * JA3 is the exact mismatch this whole module exists to avoid.
 *
 * Returns the header set; merge it into the executor's request headers (the
 * executor still adds its own Origin/Referer/Authorization/Cookie/etc.).
 */
export function buildChromeClientHintHeaders(
  opts: ChromeClientHintOptions = {}
): Record<string, string> {
  const major = opts.chromeMajor ?? DEFAULT_CHROME_MAJOR;
  const platform = opts.platform ?? "macOS";
  return {
    "User-Agent": opts.userAgent ?? DEFAULT_CHROME_UA,
    "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${platform}"`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": opts.fetchSite ?? "same-origin",
    "Accept-Language": opts.acceptLanguage ?? "en-US,en;q=0.9",
  };
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

function toHeaders(raw: Record<string, string[]>): Headers {
  const h = new Headers();
  for (const [k, vs] of Object.entries(raw || {})) {
    for (const v of vs) h.append(k, v);
  }
  return h;
}

// ─── Streaming via temp file ────────────────────────────────────────────────
// tls-client-node's streaming primitive writes the response body chunk-by-chunk
// to a file path, terminating when the upstream sends `streamOutputEOFSymbol`.
// We tail the file from a worker and surface the bytes as a ReadableStream.

async function tlsFetchStreaming(
  client: { request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike> },
  url: string,
  requestOptions: Record<string, unknown>,
  eofSymbol = "[DONE]",
  signal: AbortSignal | null = null,
  hardTimeoutMs: number = DEFAULT_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS,
  firstByteTimeoutMs: number = STREAM_FIRST_BYTE_TIMEOUT_MS,
  tempPrefix = "webchat-stream-"
): Promise<WebchatTlsFetchResult> {
  const dir = await mkdtemp(join(tmpdir(), tempPrefix));
  const path = join(dir, `${randomUUID()}.sse`);

  const streamOpts = {
    ...requestOptions,
    streamOutputPath: path,
    streamOutputBlockSize: 1024,
    streamOutputEOFSymbol: eofSymbol,
  };

  // Kick off the request without awaiting — tls-client writes the body to `path`
  // chunk-by-chunk while the call runs. The Promise resolves when the request
  // fully completes (full body written). Wrapping in raceWithTimeout guarantees
  // this promise eventually settles even if the koffi binding wedges; on hang we
  // reset the singleton so the next request respawns.
  let resetOnHang = true;
  const requestPromise = raceWithTimeout(
    client.request(url, streamOpts),
    hardTimeoutMs,
    signal
  ).catch((err: unknown) => {
    if (resetOnHang && err instanceof TlsClientHangError) {
      resetClientCache();
      resetOnHang = false;
    }
    // Re-throw so downstream consumers (waitForContent, tailFile) observe the
    // rejection and surface it instead of treating the stream as having ended
    // cleanly.
    throw err;
  });

  // Wait for the file to exist AND have at least one byte. tls-client-node
  // creates the output file when the request starts, but the file can be empty
  // for a brief window before the first body chunk lands — peeking during that
  // window would return "" and misclassify the response as non-SSE, dropping us
  // into the buffered-wait branch and silently turning a streaming request into
  // a buffered one. Waiting for content avoids that race; if the request
  // actually fails before producing any bytes, the timeout falls through to the
  // requestPromise drain below (returning the real upstream status).
  const ready = await waitForContent(path, firstByteTimeoutMs, requestPromise);
  if (!ready) {
    const r = await requestPromise.catch(
      (e) => ({ status: 502, headers: {}, body: String(e) }) as TlsResponseLike
    );
    // If the first byte arrived after our first-byte wait but before the request
    // settled, tls-client-node may have written the full SSE body to
    // streamOutputPath while leaving r.body empty. Prefer those captured bytes
    // over misclassifying a successful delayed stream as "empty response body".
    const fileText = await readTextFileIfExists(path);
    await cleanupTempPath(path);
    return {
      status: r.status,
      headers: toHeaders(r.headers),
      text: fileText || r.body,
      body: null,
    };
  }

  // Peek the first bytes to decide whether this looks like SSE. Anything that
  // doesn't positively look like SSE (JSON `{...}`, HTML `<...>`, plain text
  // rate-limit messages, WAF challenge pages, etc.) gets surfaced as a
  // non-streaming response so the executor sees the real upstream status and
  // body — otherwise non-2xx error pages get silently treated as 200 OK and the
  // SSE parser produces an empty completion.
  const peek = await readFirstBytes(path, 256);
  if (!looksLikeSse(peek)) {
    const r = await requestPromise.catch(
      (e) => ({ status: 502, headers: {}, body: String(e) }) as TlsResponseLike
    );
    const fileText = await readTextFileIfExists(path);
    await cleanupTempPath(path);
    return {
      status: r.status,
      headers: toHeaders(r.headers),
      text: r.body || fileText,
      body: null,
    };
  }

  // Looks like SSE — start tailing. SSE bodies in practice are always 2xx;
  // tls-client-node doesn't expose response status separately from full-body
  // completion, so we report 200 and let the SSE parser consume the stream.
  const stream = tailFile(path, eofSymbol, requestPromise, signal);
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  return { status: 200, headers, text: null, body: stream };
}

/**
 * Returns true if the peeked response body looks like an SSE stream — i.e.,
 * begins (after any leading whitespace) with one of the SSE field markers
 * (`data:`, `event:`, `id:`, `retry:`) or a comment line (`:`).
 *
 * Exported for tests.
 */
export function looksLikeSse(text: string): boolean {
  const trimmed = text.replace(/^[\s\r\n]+/, "");
  if (!trimmed) return false;
  if (trimmed.startsWith(":")) return true;
  return /^(data|event|id|retry):/i.test(trimmed);
}

async function cleanupTempPath(path: string): Promise<void> {
  await unlink(path).catch(() => {});
  const dir = path.substring(0, path.lastIndexOf("/"));
  await rmdir(dir).catch(() => {});
}

async function readTextFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readFirstBytes(path: string, n: number): Promise<string> {
  const fd = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fd.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * Wait for the streaming output file to exist AND contain at least one byte.
 * Returns false if the request settles before any bytes arrive (so the caller
 * can drain `requestPromise` and surface the real upstream status). Returns true
 * as soon as the file has data — even one byte is enough for the SSE heuristic
 * to give a useful answer.
 */
async function waitForContent(
  path: string,
  timeoutMs: number,
  requestPromise: Promise<TlsResponseLike>
): Promise<boolean> {
  let requestSettled = false;
  requestPromise.then(
    () => {
      requestSettled = true;
    },
    () => {
      requestSettled = true;
    }
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await stat(path);
      if (s.size > 0) return true;
    } catch {
      // file doesn't exist yet
    }
    // If the request finished without producing any bytes, no point waiting out
    // the rest of the timeout — let the caller drain it.
    if (requestSettled) return false;
    await sleep(25);
  }
  return false;
}

function tailFile(
  path: string,
  eofSymbol: string,
  done: Promise<TlsResponseLike>,
  signal: AbortSignal | null = null
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const fd = await open(path, "r");
      const buf = Buffer.alloc(64 * 1024);
      let offset = 0;
      let finished = false;
      let aborted = false;
      let upstreamError: Error | null = null;

      // Track request settlement, capturing both fulfillment and rejection.
      // Without the rejection branch, a mid-stream tls-client-node error becomes
      // an unhandledRejection — the stream cleans up silently and the consumer
      // sees what looks like a successful truncated response.
      done.then(
        () => {
          finished = true;
        },
        (err) => {
          upstreamError = err instanceof Error ? err : new Error(String(err));
          finished = true;
        }
      );

      // If the caller aborts, stop tailing immediately.
      const onAbort = () => {
        aborted = true;
      };
      if (signal) {
        if (signal.aborted) aborted = true;
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      let errored = false;
      try {
        while (!aborted) {
          const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
          if (bytesRead > 0) {
            const chunk = buf.subarray(0, bytesRead);
            offset += bytesRead;
            const text = chunk.toString("utf8");
            if (text.includes(eofSymbol)) {
              const cutAt = text.indexOf(eofSymbol) + eofSymbol.length;
              controller.enqueue(new Uint8Array(chunk.subarray(0, cutAt)));
              break;
            }
            controller.enqueue(new Uint8Array(chunk));
          } else if (finished) {
            // No more data and request completed. If the request rejected,
            // surface the error so the consumer doesn't think the stream ended
            // cleanly.
            if (upstreamError) {
              controller.error(upstreamError);
              errored = true;
            }
            break;
          } else {
            await sleep(25);
          }
        }
      } catch (err) {
        controller.error(err);
        errored = true;
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        await fd.close().catch(() => {});
        await unlink(path).catch(() => {});
        const dir = path.substring(0, path.lastIndexOf("/"));
        await rmdir(dir).catch(() => {});
        if (!errored) controller.close();
      }
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
