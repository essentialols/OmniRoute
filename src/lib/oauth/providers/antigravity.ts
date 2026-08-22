import { ANTIGRAVITY_CONFIG } from "../constants/oauth";
import type { AntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
import {
  getAntigravityContentHeaders,
  getAntigravityIdeNodeHeaders,
  getAntigravityLoadCodeAssistMetadata,
  getAntigravityOAuthUserAgent,
} from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { extractCodeAssistOnboardTierId } from "@omniroute/open-sse/services/codeAssistSubscription.ts";

const POSTEXCHANGE_TIMEOUT_MS = 8_000;

/** `cloudaicompanionProject` is either a bare string or an object carrying `id`. */
export function extractCloudaicompanionProjectId(value: unknown): string {
  const raw = (value as Record<string, unknown> | undefined)?.cloudaicompanionProject;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string") {
    return ((raw as Record<string, unknown>).id as string).trim();
  }
  return "";
}

type AntigravityOAuthConfig = typeof ANTIGRAVITY_CONFIG;
type AntigravityTokenPayload = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};
type AntigravityPostExchange = {
  projectId: string;
  tierId: string;
  userInfo: { email?: string };
};

async function fetchFirstOk(endpoints: string[], init: RequestInit, timeoutMs?: number) {
  let lastError: unknown = null;
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

function getPostExchangeHeaders(
  profile: AntigravityClientProfile,
  accessToken: string
): Record<string, string> {
  return profile === "cli"
    ? getAntigravityContentHeaders("cli", accessToken)
    : getAntigravityIdeNodeHeaders(accessToken);
}

function buildAntigravityAuthUrl(
  config: AntigravityOAuthConfig,
  redirectUri: string,
  state: string,
  codeChallenge?: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.authorizeUrl}?${params.toString()}`;
}

async function exchangeAntigravityToken(
  config: AntigravityOAuthConfig,
  clientProfile: AntigravityClientProfile,
  code: string,
  redirectUri: string
): Promise<AntigravityTokenPayload> {
  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
  };
  if (config.clientSecret) bodyParams.client_secret = config.clientSecret;

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": getAntigravityOAuthUserAgent(clientProfile),
    },
    body: new URLSearchParams(bodyParams),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }
  return (await response.json()) as AntigravityTokenPayload;
}

function extractProjectId(data: Record<string, unknown>): string {
  const project = data.cloudaicompanionProject;
  if (typeof project === "string") return project;
  if (!project || typeof project !== "object" || Array.isArray(project)) return "";
  const id = (project as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}

async function onboardAntigravityUser(
  config: AntigravityOAuthConfig,
  headers: Record<string, string>,
  tierId: string,
  metadata: Record<string, string>
): Promise<void> {
  // Bounded onboarding: cap retries (was 10) and jitter the delay so a stuck
  // loop cannot look like scripted automation to the upstream (ban-safety).
  const MAX_ONBOARD_RETRIES = 3;
  const BASE_RETRY_MS = 3000;
  const JITTER_MS = 4000;
  for (let i = 0; i < MAX_ONBOARD_RETRIES; i++) {
    try {
      const response = await fetchFirstOk(
        config.onboardUserEndpoints,
        { method: "POST", headers, body: JSON.stringify({ tier_id: tierId, metadata }) },
        POSTEXCHANGE_TIMEOUT_MS
      );
      const result = (await response.json()) as { done?: boolean };
      if (result.done === true) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, BASE_RETRY_MS + Math.random() * JITTER_MS));
  }
}

async function postExchangeAntigravity(
  config: AntigravityOAuthConfig,
  clientProfile: AntigravityClientProfile,
  tokens: AntigravityTokenPayload
): Promise<AntigravityPostExchange> {
  const headers = getPostExchangeHeaders(clientProfile, tokens.access_token);
  const metadata = getAntigravityLoadCodeAssistMetadata();
  const userInfoResponse = await fetch(`${config.userInfoUrl}?alt=json`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(POSTEXCHANGE_TIMEOUT_MS),
  }).catch(() => null);
  const userInfo = userInfoResponse?.ok
    ? ((await userInfoResponse.json()) as { email?: string })
    : {};

  let projectId = "";
  let tierId = "legacy-tier";
  let loadSucceeded = false;
  try {
    const response = await fetchFirstOk(
      config.loadCodeAssistEndpoints,
      { method: "POST", headers, body: JSON.stringify({ metadata }) },
      POSTEXCHANGE_TIMEOUT_MS
    );
    const data = (await response.json()) as Record<string, unknown>;
    projectId = extractProjectId(data);
    tierId = extractCodeAssistOnboardTierId(data);
    loadSucceeded = true;
  } catch (error) {
    console.log("Failed to load code assist:", error);
  }

  if (projectId) {
    // A project already exists: onboardUser is just an idempotent refresh, so keep it
    // fire-and-forget and never block the login on it. (#5180-followup / login hang)
    void onboardAntigravityUser(config, headers, tierId, metadata).catch(() => {});
  } else if (loadSucceeded && config.onboardUserEndpoints.length > 0) {
    // loadCodeAssist answered but the account owns no cloudaicompanionProject: it never
    // completed Gemini Code Assist onboarding. onboardUser (free tier) is the ONLY way it can
    // ever get one, and persisting a connection with an empty projectId produces a dead account
    // that 422s ("Missing Google projectId") on every single request. We onboard ONLY when
    // loadCodeAssist actually succeeded with an empty project: if it stalled or errored we do
    // not know the account's real state, so we leave projectId empty (the request-time
    // bootstrap retries) rather than block the login on an onboarding round-trip.
    try {
      const onboardResponse = await fetchFirstOk(
        config.onboardUserEndpoints,
        { method: "POST", headers, body: JSON.stringify({ tier_id: tierId, metadata }) },
        POSTEXCHANGE_TIMEOUT_MS
      );
      // onboardUser is a long-running operation: Google returns the project it provisions in
      // the LRO envelope, so prefer that over a second discovery round-trip.
      const onboardResult = (await onboardResponse.json()) as Record<string, unknown>;
      projectId =
        extractCloudaicompanionProjectId(onboardResult.response) ||
        extractCloudaicompanionProjectId(onboardResult);
      if (!projectId) {
        const retryResponse = await fetchFirstOk(
          config.loadCodeAssistEndpoints,
          { method: "POST", headers, body: JSON.stringify({ metadata }) },
          POSTEXCHANGE_TIMEOUT_MS
        );
        projectId = extractProjectId((await retryResponse.json()) as Record<string, unknown>);
      }
    } catch {
      // Lazy request-time bootstrap retries if onboarding or discovery is unavailable.
    }
  }
  return { userInfo, projectId, tierId };
}

function mapAntigravityTokens(
  clientProfile: AntigravityClientProfile,
  tokens: AntigravityTokenPayload,
  extra?: AntigravityPostExchange
) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
    providerSpecificData: {
      clientProfile,
      projectId: extra?.projectId,
      tier: extra?.tierId,
    },
  };
}

export function createAntigravityOAuthProvider(
  config: AntigravityOAuthConfig,
  clientProfile: AntigravityClientProfile
) {
  return {
    config,
    flowType: "authorization_code" as const,
    buildAuthUrl: buildAntigravityAuthUrl,
    exchangeToken: (runtimeConfig, code, redirectUri) =>
      exchangeAntigravityToken(runtimeConfig, clientProfile, code, redirectUri),
    postExchange: (tokens) => postExchangeAntigravity(config, clientProfile, tokens),
    mapTokens: (tokens, extra) => mapAntigravityTokens(clientProfile, tokens, extra),
  };
}

export const antigravity = createAntigravityOAuthProvider(ANTIGRAVITY_CONFIG, "ide");
