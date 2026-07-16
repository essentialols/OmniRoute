/**
 * Antigravity project bootstrap — loadCodeAssist.
 *
 * The Google Cloud Code Assist API (/v1internal:models) requires a prior
 * /v1internal:loadCodeAssist call to assign a project context to the
 * OAuth token. Without this bootstrap, :models returns 404.
 *
 * This module provides an idempotent ensureAntigravityProjectAssigned()
 * helper that is called once per access-token before every discovery
 * attempt. Results are memoized per-token for the process lifetime to
 * avoid redundant round-trips.
 *
 * Based on the Antigravity loadCodeAssist flow and the CLIProxyAPI reference
 * implementation in internal/runtime/executor/antigravity_executor.go.
 */

import {
  getAntigravityHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "./antigravityHeaders.ts";
import {
  getAntigravityBootstrapHeaders,
  type AntigravityClientProfile,
} from "./antigravityClientProfile.ts";
import { extractCodeAssistOnboardTierId } from "./codeAssistSubscription.ts";
import { ANTIGRAVITY_BASE_URLS } from "../config/antigravityUpstream.ts";

const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const BOOTSTRAP_TIMEOUT_MS = 8_000;
// onboardUser is a long-running operation. In practice Google reports `done` on the 2nd
// poll; cap the attempts so a request can never hang on a stuck LRO.
const ONBOARD_MAX_ATTEMPTS = 4;
const ONBOARD_POLL_INTERVAL_MS = 5_000;

/** Ordered list of loadCodeAssist endpoint URLs (mirrors the models discovery order). */
export function getAntigravityLoadCodeAssistUrls(): string[] {
  return ANTIGRAVITY_BASE_URLS.map((base) => `${base}${LOAD_CODE_ASSIST_PATH}`);
}

/** Ordered list of onboardUser endpoint URLs. */
export function getAntigravityOnboardUserUrls(): string[] {
  return ANTIGRAVITY_BASE_URLS.map((base) => `${base}${ONBOARD_USER_PATH}`);
}

/** `cloudaicompanionProject` is either a bare string or an object carrying `id`. */
export function extractCloudaicompanionProjectId(value: unknown): string {
  const raw = (value as Record<string, unknown> | undefined)?.cloudaicompanionProject;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string") {
    return ((raw as Record<string, unknown>).id as string).trim();
  }
  return "";
}

/** Per-token memoization cache (lives for the process lifetime). */
const projectCache = new Map<string, string>();

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function getProjectCacheKey(accessToken: string, clientProfile: AntigravityClientProfile): string {
  return `${clientProfile}:${accessToken}`;
}

/**
 * Attempt loadCodeAssist against each known base URL in order.
 *
 * Returns `{ projectId, baseUrl, payload }` for the first endpoint that answers 200.
 * `projectId` is "" when the Google account owns no Cloud Code project yet — that is NOT a
 * failure, it means the account has never completed Gemini Code Assist onboarding, and the
 * caller must run onboardUser against the SAME base URL to provision one. Returns null only
 * when every endpoint failed outright.
 */
async function tryLoadCodeAssist(
  accessToken: string,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile
): Promise<{ projectId: string; baseUrl: string; payload: Record<string, unknown> } | null> {
  const urls = getAntigravityLoadCodeAssistUrls();
  const headers =
    clientProfile === "harness"
      ? getAntigravityBootstrapHeaders(clientProfile, accessToken)
      : getAntigravityHeaders("loadCodeAssist", accessToken);

  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(
          `[models] antigravity loadCodeAssist failed at ${url} (${response.status}) — trying next`
        );
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const projectId = extractCloudaicompanionProjectId(data);

      if (!projectId) {
        console.warn(
          `[models] antigravity loadCodeAssist at ${url} returned no project id — account is not onboarded`
        );
      }

      return { projectId, baseUrl: ANTIGRAVITY_BASE_URLS[index], payload: data };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity loadCodeAssist threw for ${url}: ${msg} — trying next`);
    }
  }
  return null;
}

/**
 * Provision a Cloud Code project for an account that has none, via onboardUser on the FREE
 * tier (Gemini Code Assist for individuals). Never creates a billed GCP resource: the tier id
 * is whatever loadCodeAssist itself advertises as the default allowed tier (`free-tier`).
 *
 * onboardUser is a long-running operation, so poll until it reports `done` and read the
 * provisioned project out of the LRO `response` envelope.
 */
async function tryOnboardUser(
  accessToken: string,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile,
  baseUrl: string,
  loadPayload: Record<string, unknown>
): Promise<string | null> {
  const headers =
    clientProfile === "harness"
      ? getAntigravityBootstrapHeaders(clientProfile, accessToken)
      : getAntigravityHeaders("loadCodeAssist", accessToken);
  const tierId = extractCodeAssistOnboardTierId(loadPayload);
  const url = `${baseUrl}${ONBOARD_USER_PATH}`;

  for (let attempt = 1; attempt <= ONBOARD_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tier_id: tierId,
          metadata: getAntigravityLoadCodeAssistMetadata(),
        }),
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(
          `[models] antigravity onboardUser failed at ${url} (${response.status}) — giving up`
        );
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const projectId =
        extractCloudaicompanionProjectId(data.response) || extractCloudaicompanionProjectId(data);

      if (projectId) {
        console.warn(
          `[models] antigravity onboardUser provisioned project ${projectId} (tier=${tierId})`
        );
        return projectId;
      }
      if (data.done === true) {
        console.warn(`[models] antigravity onboardUser reported done with no project id`);
        return null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity onboardUser threw for ${url}: ${msg}`);
      return null;
    }

    if (attempt < ONBOARD_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
    }
  }
  return null;
}

/**
 * Ensure a project is assigned to the given access token by calling
 * loadCodeAssist if not already cached. Idempotent — repeated calls
 * for the same token return the cached result without a network round-trip.
 *
 * Failures are non-fatal: the caller should proceed with the :models
 * request regardless (the stored project_id in the DB may still be valid).
 *
 * @param accessToken  The OAuth bearer token for the current connection.
 * @param fetchImpl    Injected fetch implementation (defaults to globalThis.fetch).
 */
export async function ensureAntigravityProjectAssigned(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  clientProfile: AntigravityClientProfile = "ide"
): Promise<string | undefined> {
  const cacheKey = getProjectCacheKey(accessToken, clientProfile);
  if (projectCache.has(cacheKey)) {
    return projectCache.get(cacheKey); // already bootstrapped for this token
  }

  const loaded = await tryLoadCodeAssist(accessToken, fetchImpl, clientProfile);
  // Non-fatal: if every endpoint failed outright, proceed without caching.
  if (!loaded) return undefined;

  if (loaded.projectId) {
    projectCache.set(cacheKey, loaded.projectId);
    return loaded.projectId;
  }

  // loadCodeAssist answered 200 but the account owns no Cloud Code project: it never
  // completed Gemini Code Assist onboarding. Provision one on the free tier instead of
  // letting the executor abort with 422 missing_project_id. Google persists the project
  // server-side, so every later loadCodeAssist (this process or the next) returns it.
  const onboarded = await tryOnboardUser(
    accessToken,
    fetchImpl,
    clientProfile,
    loaded.baseUrl,
    loaded.payload
  );

  if (onboarded) {
    projectCache.set(cacheKey, onboarded);
    return onboarded;
  }
  return undefined;
}

/** Exported for tests. */
export function clearAntigravityProjectCache(): void {
  projectCache.clear();
}

/** Exported for tests — inspect cache state. */
export function getAntigravityProjectFromCache(
  accessToken: string,
  clientProfile: AntigravityClientProfile = "ide"
): string | undefined {
  return projectCache.get(getProjectCacheKey(accessToken, clientProfile));
}
