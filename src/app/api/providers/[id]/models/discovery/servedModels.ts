import {
  buildNamedOpenAiStyleHeaders,
  buildOptionalBearerHeaders,
  getProviderBaseUrl,
  isLocalOpenAIStyleProvider,
} from "./helpers";
import { normalizeOpenAiLikeModelsResponse } from "./normalizers";
import { isNamedOpenAIStyleProvider } from "./providerSets";
import { PROVIDER_MODELS_CONFIG, type ProviderModelsConfigEntry } from "./providerModelsConfig";

/**
 * Served-set model discovery for a single provider connection.
 *
 * Reuses the same scaffolding the sibling `models/route.ts` relies on
 * (`PROVIDER_MODELS_CONFIG`, the OpenAI-like normalizer, and the named/local
 * OpenAI-style provider sets) so the two stay in lock-step, and exposes a pure
 * `discoverServedModels()` that takes an injected `fetchImpl` so the resolution
 * + normalization path is unit-testable without a live network or DB.
 */

export interface ServedModel {
  id: string;
  name: string;
  owned_by: string;
}

export interface ServedModelsDiscovery {
  supported: boolean;
  provider: string;
  models: ServedModel[];
}

export type ServedModelsFetchInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

export type ServedModelsFetch = (url: string, init: ServedModelsFetchInit) => Promise<Response>;

/** Thrown when the provider's upstream model-list endpoint fails. Carries an
 *  HTTP status so the route can map it to a sanitized 4xx/5xx response. */
export class ServedModelsUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ServedModelsUpstreamError";
    this.status = status;
  }
}

interface UpstreamPlan {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Provider-specific extraction. The result is always run back through
   *  `normalizeOpenAiLikeModelsResponse` so the response contract is uniform. */
  parse: (data: unknown) => unknown;
}

function cleanOpenAiStyleBaseUrl(baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    base = base.slice(0, -"/chat/completions".length);
  } else if (base.endsWith("/completions")) {
    base = base.slice(0, -"/completions".length);
  }
  return base;
}

/**
 * Decide which upstream model-list endpoint (if any) exposes the provider's
 * served set. Prefers the hardcoded `PROVIDER_MODELS_CONFIG`, then falls back to
 * a generic OpenAI-like `<baseUrl>/models` probe for named/local OpenAI-style
 * providers or any connection carrying a `baseUrl`. Returns `null` when the
 * provider has no discoverable model-list endpoint.
 */
export function resolveServedModelsUpstream(
  provider: string,
  providerSpecificData: unknown,
  apiKey: string,
  accessToken: string
): UpstreamPlan | null {
  const config: ProviderModelsConfigEntry | undefined =
    provider in PROVIDER_MODELS_CONFIG
      ? PROVIDER_MODELS_CONFIG[provider as keyof typeof PROVIDER_MODELS_CONFIG]
      : undefined;

  if (config) {
    const token = accessToken || apiKey;
    let url = config.url;
    if (config.authQuery) {
      url += `${url.includes("?") ? "&" : "?"}${config.authQuery}=${token}`;
    }
    const headers = config.buildHeaders ? config.buildHeaders(token) : { ...config.headers };
    if (!config.buildHeaders && config.authHeader && !config.authQuery) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }
    return {
      url,
      method: config.method,
      headers,
      body:
        config.method === "POST" && config.body !== undefined
          ? JSON.stringify(config.body)
          : undefined,
      parse: (data) => config.parseResponse(data),
    };
  }

  const baseUrl = getProviderBaseUrl(providerSpecificData);
  const isOpenAiLike =
    isNamedOpenAIStyleProvider(provider) ||
    isLocalOpenAIStyleProvider(provider) ||
    Boolean(baseUrl);
  if (isOpenAiLike && baseUrl) {
    const token = apiKey || accessToken;
    const base = cleanOpenAiStyleBaseUrl(baseUrl);
    const headers = isNamedOpenAIStyleProvider(provider)
      ? buildNamedOpenAiStyleHeaders(provider, token)
      : buildOptionalBearerHeaders(token);
    return {
      url: `${base}/models`,
      method: "GET",
      headers,
      // Generic OpenAI-like endpoints are normalized directly by the caller.
      parse: (data) => data,
    };
  }

  return null;
}

/**
 * Fetch and normalize a provider's served model set.
 *
 * - No discoverable endpoint -> `{ supported: false, provider, models: [] }`.
 * - Upstream non-2xx -> throws `ServedModelsUpstreamError` (route sanitizes it).
 * - Success -> `{ supported: true, provider, models }` with `{id,name,owned_by}`.
 */
export async function discoverServedModels(params: {
  provider: string;
  providerSpecificData: unknown;
  apiKey: string;
  accessToken: string;
  fetchImpl: ServedModelsFetch;
}): Promise<ServedModelsDiscovery> {
  const { provider, providerSpecificData, apiKey, accessToken, fetchImpl } = params;

  const plan = resolveServedModelsUpstream(provider, providerSpecificData, apiKey, accessToken);
  if (!plan) {
    return { supported: false, provider, models: [] };
  }

  const response = await fetchImpl(plan.url, {
    method: plan.method,
    headers: plan.headers,
    ...(plan.body ? { body: plan.body } : {}),
  });

  if (!response.ok) {
    throw new ServedModelsUpstreamError(
      `Upstream model-list request for ${provider} failed with status ${response.status}`,
      response.status
    );
  }

  const data: unknown = await response.json();
  const parsed = plan.parse(data);
  const models = normalizeOpenAiLikeModelsResponse(parsed, provider);
  return { supported: true, provider, models };
}
