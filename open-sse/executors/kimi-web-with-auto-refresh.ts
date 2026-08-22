/**
 * KimiWebWithAutoRefreshExecutor — JWT auto-refresh wrapper around KimiWebExecutor.
 *
 * The base `KimiWebExecutor` (kimi-web.ts) sends the pasted `kimi-auth` JWT as
 * both the Bearer token and the Cookie on every www.kimi.com chat request. When
 * that JWT expires the upstream answers 401 and the base executor surfaces the
 * failure to the client — the user has to re-paste a fresh cookie by hand.
 *
 * This wrapper mirrors the reference Kimi provider
 * (`~/tools/shared-relay-proxy/providers/kimi.py`) and the sibling
 * `deepseek-web-with-auto-refresh.ts` pattern:
 *
 *   1. Proactive refresh — before dispatching, decode the JWT `exp` claim
 *      (base64url, no library) and, if the token expires within
 *      REFRESH_BUFFER_SECONDS (300s), swap in a freshly minted access token.
 *   2. Reactive refresh — on a 401/403 from the upstream, refresh once and
 *      retry the request a single time before giving up.
 *
 * Refreshed access tokens are cached in-process (keyed by the original pasted
 * credential) and persisted back to the stored connection via the
 * `onCredentialsRefreshed` callback so the DB row stays current across restarts.
 *
 * ── Registration (index.ts) ──────────────────────────────────────────────────
 * To make this the primary Kimi web executor, change the import + wiring in
 * `open-sse/executors/index.ts`:
 *
 *   - import { KimiWebExecutor } from "./kimi-web.ts";
 *   + import { KimiWebWithAutoRefreshExecutor } from "./kimi-web-with-auto-refresh.ts";
 *
 *   -  "kimi-web": new KimiWebExecutor(),
 *   +  "kimi-web": new KimiWebWithAutoRefreshExecutor(),
 *
 * (The base `KimiWebExecutor` export can stay for tests / direct use.)
 */
import { KimiWebExecutor, extractKimiJwt } from "./kimi-web.ts";
import type { ExecuteInput, ProviderCredentials } from "./base.ts";

const BASE_URL = "https://www.kimi.com";
const REFRESH_URL = `${BASE_URL}/api/auth/token/refresh`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Refresh a token this many seconds before its `exp` to avoid mid-request expiry. */
const REFRESH_BUFFER_SECONDS = 300;

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds; 0 when the minted token had no decodable `exp`. */
  expiresAt: number;
}

// Keyed by the original pasted JWT so multiple connections don't collide.
const tokenCache = new Map<string, CachedToken>();
// Dedup concurrent refreshes for the same credential.
const inFlight = new Map<string, Promise<CachedToken | null>>();

const MAX_CACHE_ENTRIES = 100;

function cacheSet(key: string, value: CachedToken): void {
  if (tokenCache.size >= MAX_CACHE_ENTRIES && !tokenCache.has(key)) {
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(key, value);
}

/**
 * Decode the `exp` claim (unix seconds) from a JWT without verifying the
 * signature. Returns null when the token isn't a well-formed 3-part JWT or has
 * no numeric `exp`. Node's "base64url" decoder tolerates the missing padding.
 */
export function decodeJwtExp(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = typeof json.exp === "number" ? json.exp : Number(json.exp);
    return Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** True when `jwt` is decodable and expires within the refresh buffer (or already has). */
export function isExpiringSoon(jwt: string, nowSeconds: number = Date.now() / 1000): boolean {
  const exp = decodeJwtExp(jwt);
  if (exp === null) return false;
  return exp - REFRESH_BUFFER_SECONDS <= nowSeconds;
}

/**
 * Call Kimi's refresh endpoint with the given bearer (a refresh token, or the
 * current access JWT as a fallback — same as the Python provider). Returns the
 * minted access/refresh pair, or null on any failure.
 */
async function refreshKimiToken(
  refreshBearer: string,
  signal?: AbortSignal | null
): Promise<CachedToken | null> {
  let resp: Response;
  try {
    resp = await fetch(REFRESH_URL, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "User-Agent": USER_AGENT,
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        Authorization: `Bearer ${refreshBearer}`,
        Cookie: `kimi-auth=${refreshBearer}`,
      },
      signal: signal ?? undefined,
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const accessToken =
    (typeof data.access_token === "string" && data.access_token) ||
    (typeof data.token === "string" && data.token) ||
    "";
  if (!accessToken) return null;

  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : refreshBearer;

  const exp = decodeJwtExp(accessToken);
  return { accessToken, refreshToken, expiresAt: exp ?? 0 };
}

export class KimiWebWithAutoRefreshExecutor extends KimiWebExecutor {
  override async execute(input: ExecuteInput) {
    const rawCredential = String(input.credentials?.apiKey ?? "").trim();
    const originalJwt = extractKimiJwt(rawCredential);
    // No usable JWT — let the base executor surface its own 400 error.
    if (!originalJwt) return super.execute(input);

    const effective = await this.ensureFreshToken(originalJwt, input);
    const firstInput = effective === originalJwt ? input : withApiKey(input, effective);
    const result = await super.execute(firstInput);

    const status = result?.response?.status;
    if (status === 401 || status === 403) {
      const refreshed = await this.doRefresh(originalJwt, input, /* force */ true);
      if (refreshed) {
        return super.execute(withApiKey(input, refreshed.accessToken));
      }
    }
    return result;
  }

  /**
   * Return the access token to use for this request: a cached-and-current one,
   * the original JWT when it's still comfortably valid, or a freshly refreshed
   * token when the original is decodable and expiring within the buffer. Falls
   * back to the original on any refresh failure so the reactive 401 path can
   * still try.
   */
  private async ensureFreshToken(originalJwt: string, input: ExecuteInput): Promise<string> {
    const now = Date.now() / 1000;
    const cached = tokenCache.get(originalJwt);
    if (cached) {
      if (cached.expiresAt === 0 || cached.expiresAt - REFRESH_BUFFER_SECONDS > now) {
        return cached.accessToken;
      }
      const refreshed = await this.doRefresh(originalJwt, input, /* force */ true);
      return refreshed?.accessToken ?? cached.accessToken;
    }

    if (isExpiringSoon(originalJwt, now)) {
      const refreshed = await this.doRefresh(originalJwt, input, /* force */ true);
      return refreshed?.accessToken ?? originalJwt;
    }
    return originalJwt;
  }

  /**
   * Refresh the access token for `originalJwt`, deduping concurrent refreshes.
   * On success the result is cached and persisted via `onCredentialsRefreshed`.
   * When `force` is false a still-fresh cache entry short-circuits the network call.
   */
  private async doRefresh(
    originalJwt: string,
    input: ExecuteInput,
    force: boolean
  ): Promise<CachedToken | null> {
    const now = Date.now() / 1000;
    const cached = tokenCache.get(originalJwt);
    if (
      !force &&
      cached &&
      (cached.expiresAt === 0 || cached.expiresAt - REFRESH_BUFFER_SECONDS > now)
    ) {
      return cached;
    }

    const existing = inFlight.get(originalJwt);
    if (existing) return existing;

    const refreshBearer = resolveRefreshBearer(originalJwt, input.credentials);
    const promise = (async () => {
      const minted = await refreshKimiToken(refreshBearer, input.signal);
      if (minted) {
        cacheSet(originalJwt, minted);
        try {
          await input.onCredentialsRefreshed?.({
            apiKey: minted.accessToken,
            refreshToken: minted.refreshToken,
            ...(minted.expiresAt
              ? { expiresAt: new Date(minted.expiresAt * 1000).toISOString() }
              : {}),
          });
        } catch (err) {
          input.log?.warn?.(
            "KIMI-WEB-AUTO-REFRESH",
            `Persisting refreshed token failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        input.log?.info?.("KIMI-WEB-AUTO-REFRESH", "Refreshed Kimi access token");
      } else {
        input.log?.warn?.("KIMI-WEB-AUTO-REFRESH", "Kimi token refresh failed");
      }
      return minted;
    })().finally(() => {
      inFlight.delete(originalJwt);
    });

    inFlight.set(originalJwt, promise);
    return promise;
  }
}

/** Clone the input with a replaced `apiKey` credential (the fresh JWT). */
function withApiKey(input: ExecuteInput, apiKey: string): ExecuteInput {
  return { ...input, credentials: { ...input.credentials, apiKey } };
}

/**
 * The bearer to refresh WITH: a dedicated `refreshToken` when the connection
 * carries one, otherwise the current JWT itself (Kimi accepts the pasted
 * `kimi-auth` value here — matches the Python provider's fallback).
 */
function resolveRefreshBearer(originalJwt: string, credentials: ProviderCredentials): string {
  const refreshToken = String(credentials?.refreshToken ?? "").trim();
  return refreshToken || originalJwt;
}

export const kimiWebWithAutoRefreshExecutor = new KimiWebWithAutoRefreshExecutor();
