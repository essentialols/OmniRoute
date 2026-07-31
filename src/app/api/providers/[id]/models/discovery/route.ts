import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SAFE_OUTBOUND_FETCH_PRESETS,
  SafeOutboundFetchError,
  getSafeOutboundFetchErrorStatus,
  safeOutboundFetch,
} from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuard";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { getProviderConnectionById } from "@/lib/db/providers";
import { resolveProxyForProvider } from "@/lib/db/proxies";
import { handleCorsOptions } from "@/shared/utils/cors";
import { buildStaleEncryptionKeyResponse } from "../staleEncryptionGuard";
import {
  discoverServedModels,
  ServedModelsUpstreamError,
  type ServedModelsFetch,
} from "./servedModels";

/**
 * GET /api/providers/[id]/models/discovery
 *
 * Returns the provider connection's OWN currently-served model list (the
 * "served set") for the given connection `[id]`, reusing the discovery
 * scaffolding (`PROVIDER_MODELS_CONFIG` + the OpenAI-like normalizer). A sidecar
 * depends on this exact response shape:
 *   - supported + success: { supported: true, provider, models: [...], count }
 *   - no discoverable endpoint: { supported: false, provider, models: [] } (200)
 *   - connection not found: sanitized error body, 404
 *   - upstream failure: sanitized error body, mapped 4xx/5xx
 *
 * Auth: matches the sibling `models/route.ts` — no in-handler auth gate (this is
 * a management/dashboard route classified upstream; it spawns no child process,
 * so no `isLocalOnlyPath` classification is required).
 */

const paramsSchema = z.object({ id: z.string().min(1) });

/** CORS preflight, using the shared responder. */
export async function OPTIONS(): Promise<Response> {
  return handleCorsOptions();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
): Promise<Response> {
  try {
    const parsedParams = paramsSchema.safeParse(await context.params);
    if (!parsedParams.success) {
      return NextResponse.json(buildErrorBody(400, "Invalid provider connection id"), {
        status: 400,
      });
    }
    const { id } = parsedParams.data;

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json(buildErrorBody(404, "Provider connection not found"), {
        status: 404,
      });
    }

    // #6148 parity — a stored credential that no longer decrypts must not be
    // coerced to an empty-Bearer probe; short-circuit with the shared guard.
    const staleEncryptionResponse = buildStaleEncryptionKeyResponse(connection);
    if (staleEncryptionResponse) return staleEncryptionResponse;

    const provider =
      typeof connection.provider === "string" && connection.provider.trim().length > 0
        ? connection.provider
        : null;
    if (!provider) {
      return NextResponse.json(buildErrorBody(400, "Invalid connection provider"), {
        status: 400,
      });
    }

    const apiKey = typeof connection.apiKey === "string" ? connection.apiKey : "";
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken : "";
    const proxy = await resolveProxyForProvider(provider);

    const fetchImpl: ServedModelsFetch = (url, init) =>
      safeOutboundFetch(url, {
        ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
        guard: getProviderOutboundGuard(),
        proxyConfig: proxy,
        method: init.method,
        headers: init.headers,
        ...(init.body ? { body: init.body } : {}),
      });

    const discovery = await discoverServedModels({
      provider,
      providerSpecificData: connection.providerSpecificData,
      apiKey,
      accessToken,
      fetchImpl,
    });

    if (!discovery.supported) {
      return NextResponse.json({
        supported: false,
        provider: discovery.provider,
        models: [],
      });
    }

    return NextResponse.json({
      supported: true,
      provider: discovery.provider,
      models: discovery.models,
      count: discovery.models.length,
    });
  } catch (error) {
    if (error instanceof ServedModelsUpstreamError) {
      return NextResponse.json(buildErrorBody(error.status, error.message), {
        status: error.status,
      });
    }
    if (error instanceof SafeOutboundFetchError && error.code === "URL_GUARD_BLOCKED") {
      return NextResponse.json(buildErrorBody(400, error.message), { status: 400 });
    }
    const outboundStatus = getSafeOutboundFetchErrorStatus(error);
    if (outboundStatus) {
      const message = error instanceof Error ? error.message : "Failed to fetch models";
      return NextResponse.json(buildErrorBody(outboundStatus, message), {
        status: outboundStatus,
      });
    }
    return NextResponse.json(buildErrorBody(500, "Failed to fetch provider models"), {
      status: 500,
    });
  }
}
