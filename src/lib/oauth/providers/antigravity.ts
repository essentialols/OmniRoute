import { ANTIGRAVITY_CONFIG } from "../constants/oauth";
import {
  antigravityNativeOAuthUserAgent,
  getAntigravityHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { extractCodeAssistOnboardTierId } from "@omniroute/open-sse/services/codeAssistSubscription.ts";

// Bound every Antigravity post-exchange call. Without this an unreachable/slow
// upstream made the `/exchange` request (and therefore the whole OAuth login)
// hang forever — the dashboard "just spins". Mirrors the AbortSignal.timeout
// pattern already used by antigravityProjectBootstrap.ts.
const POSTEXCHANGE_TIMEOUT_MS = 8_000;
// Total budget for the BLOCKING onboarding path (account owns no project yet). Bounded so a
// slow/unreachable upstream can never hang the OAuth login, which is what the original
// fire-and-forget design was guarding against.
const ONBOARD_TOTAL_BUDGET_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 5_000;

/** `cloudaicompanionProject` is either a bare string or an object carrying `id`. */
export function extractCloudaicompanionProjectId(value: unknown): string {
  const raw = (value as Record<string, unknown> | undefined)?.cloudaicompanionProject;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string") {
    return ((raw as Record<string, unknown>).id as string).trim();
  }
  return "";
}

async function fetchFirstOk(endpoints: string[], init: RequestInit, timeoutMs?: number) {
  let lastError: unknown = null;
  // One shared deadline for the WHOLE fallback list — a stalled set of endpoints
  // must bound to a single timeout, not timeoutMs × endpoints (that re-introduced
  // a ~40s login wait). A reachable endpoint still returns immediately.
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : init.signal;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { ...init, signal });
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Antigravity endpoints configured");
}

export const antigravity = {
  config: ANTIGRAVITY_CONFIG,
  // NO PKCE. The embedded Antigravity client is a Google "Desktop/native" OAuth client;
  // sending a PKCE code_challenge (combined with the openid scope) pushed Google into the
  // `signin/oauth/firstparty/nativeapp` consent flow that hangs and never redirects back
  // (operator report 2026-06-27). The working 9router flow uses a plain authorization_code
  // grant with client_secret and no code_challenge — match it exactly. The token exchange
  // already sends client_secret (ANTIGRAVITY_OAUTH_CLIENT_SECRET) and omits code_verifier.
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  // NOTE: no PKCE. Antigravity is a plain authorization_code grant now (see flowType
  // above). The shared generateAuthData() still mints a codeVerifier for every flow, but
  // we MUST NOT forward it here — the authorize URL carries no code_challenge, so sending
  // a code_verifier makes Google reject the exchange with invalid_grant ("code_verifier
  // provided but code_challenge was not"), surfacing as a 500 on /exchange. Ignore it and
  // authenticate with client_secret only, exactly like the working 9router flow.
  exchangeToken: async (config, code, redirectUri) => {
    const bodyParams: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: code,
      redirect_uri: redirectUri,
    };

    if (config.clientSecret) {
      bodyParams.client_secret = config.clientSecret;
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": antigravityNativeOAuthUserAgent(),
      },
      body: new URLSearchParams(bodyParams),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    const headers = getAntigravityHeaders("loadCodeAssist", tokens.access_token);
    const metadata = getAntigravityLoadCodeAssistMetadata();

    // Best-effort + bounded: a slow userinfo endpoint must never hang the login.
    const userInfoRes = await fetch(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(POSTEXCHANGE_TIMEOUT_MS),
    }).catch(() => null);
    const userInfo = userInfoRes?.ok ? await userInfoRes.json() : {};

    let projectId = "";
    let tierId = "legacy-tier";
    let loadSucceeded = false;
    try {
      const loadRes = await fetchFirstOk(
        ANTIGRAVITY_CONFIG.loadCodeAssistEndpoints,
        { method: "POST", headers, body: JSON.stringify({ metadata }) },
        POSTEXCHANGE_TIMEOUT_MS
      );
      const data = await loadRes.json();
      projectId = extractCloudaicompanionProjectId(data);
      tierId = extractCodeAssistOnboardTierId(data);
      loadSucceeded = true;
    } catch (e) {
      console.log("Failed to load code assist:", e);
    }

    // Poll onboardUser (a long-running operation) until it reports `done`, and return the
    // project id Google provisions in the LRO response envelope.
    const runOnboarding = async (budgetMs: number): Promise<string> => {
      const deadline = Date.now() + budgetMs;
      do {
        let result: Record<string, unknown>;
        try {
          const onboardRes = await fetchFirstOk(
            ANTIGRAVITY_CONFIG.onboardUserEndpoints,
            { method: "POST", headers, body: JSON.stringify({ tier_id: tierId, metadata }) },
            POSTEXCHANGE_TIMEOUT_MS
          );
          result = await onboardRes.json();
        } catch {
          return "";
        }
        const provisioned =
          extractCloudaicompanionProjectId(result.response) ||
          extractCloudaicompanionProjectId(result);
        if (provisioned) return provisioned;
        if (result.done === true) return "";
        await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
      } while (Date.now() < deadline);
      return "";
    };

    if (loadSucceeded && !projectId) {
      // loadCodeAssist answered but the account owns no cloudaicompanionProject: it never
      // completed Gemini Code Assist onboarding. onboardUser (free tier) is the ONLY way it
      // can ever get one, and persisting a connection with an empty projectId produces a dead
      // account that 422s ("Missing Google projectId") on every single request. We onboard
      // ONLY when loadCodeAssist actually succeeded with an empty project. If it stalled or
      // errored we do not know the account's real state, so we leave projectId empty (the
      // request-time bootstrap retries) rather than block the login on a 30s onboard loop.
      //
      // The previous `if (projectId)` guard inverted this: it onboarded only when a project
      // ALREADY existed and skipped onboarding in precisely the case that required it. Its
      // comment claimed onboarding was "also performed lazily at request time by
      // antigravityProjectBootstrap.ts", which was never true: the bootstrap only ever
      // called loadCodeAssist. So an un-onboarded Google account could never be provisioned
      // by any code path.
      //
      // Await it here (bounded by ONBOARD_TOTAL_BUDGET_MS) because the login is worthless
      // without a project. The budget preserves the "never hang the OAuth login" guarantee
      // that motivated the fire-and-forget design.
      projectId = await runOnboarding(ONBOARD_TOTAL_BUDGET_MS);
    } else if (projectId) {
      // A project already exists: onboardUser is just an idempotent refresh, so keep it
      // fire-and-forget and never block the login on it. (#5180-followup / login hang)
      void runOnboarding(ONBOARD_TOTAL_BUDGET_MS).catch(() => {});
    }

    return { userInfo, projectId, tierId };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
    providerSpecificData: {
      projectId: extra?.projectId,
      tier: extra?.tierId,
    },
  }),
};
