/**
 * Shared client-leg traffic capture for the NON-CHAT v1 endpoints (embeddings,
 * image generation/edits, audio speech/transcription/translation, moderations,
 * rerank).
 *
 * The chat + responses pipeline emits all four capture legs via
 * `handleChatCore` (client_in, upstream 2/3) and `withCorrelationId`
 * (client_out). The standalone handlers do not flow through that pipeline, so
 * this wrapper adds the two CLIENT legs for them at the single route seam that
 * sees both the raw client request and the final client response:
 *
 *   (1) client_in  - the raw client request exactly as received (pre-handler).
 *   (4) client_out - the final Response OmniRoute returns to the client.
 *
 * Both legs share one generated `correlationId` (same `generateRequestId()`
 * format the chat path uses) and one provider/model label, so a consumer can
 * pair the before/after for a single non-chat request. The capture reuses the
 * SAME durable sink, gate, header scrub, and body redaction as the chat legs
 * (`captureClientIn` / `captureClientOut`), so all the safety properties hold:
 * DEFAULT OFF (strict no-op unless `OMNIROUTE_RAWCAP=1`), fire-and-forget,
 * secret/PII/media-scrubbed, and it never blocks, throws, or mutates the
 * request/response path.
 *
 * NOTE: the upstream legs (2/3) are NOT wired here. Those fire only inside an
 * `executor.execute()` correlation scope (`runWithCaptureContext` +
 * `runWithCapture`), which the standalone handlers do not currently enter; the
 * non-chat endpoints therefore capture the two client legs only. See
 * `docs/frameworks/TRAFFIC_INSPECTOR.md`.
 */

import {
  captureClientIn,
  captureClientOut,
  isBinaryRequestContentType,
  isCaptureEnabled,
} from "@omniroute/open-sse/services/durableCapture.ts";
import { generateRequestId } from "@/shared/utils/requestId";

type RouteHandler = (request: Request, context?: unknown) => Promise<Response> | Response;

interface NonChatCaptureOptions {
  /** Client endpoint the request arrives on, e.g. `/v1/embeddings`. */
  endpoint: string;
  /**
   * Provider label used when the request body has no parseable `model` field
   * (e.g. multipart audio uploads). Keeps both legs grouped under one dir.
   */
  providerFallback: string;
}

/**
 * Wrap a route POST handler so it emits the client_in + client_out capture
 * legs. Compose it OUTERMOST (outside `withInjectionGuard`) so client_in sees
 * the truly raw request and client_out sees the final response:
 *
 *   export const POST = withNonChatCapture(withInjectionGuard(postHandler), {
 *     endpoint: "/v1/embeddings",
 *     providerFallback: "embeddings",
 *   });
 */
export function withNonChatCapture(
  handler: RouteHandler,
  options: NonChatCaptureOptions
): RouteHandler {
  return async (request: Request, context?: unknown): Promise<Response> => {
    // Strict no-op when capture is off (the default): no clone, no read, no
    // correlationId, zero overhead on the normal request path.
    if (!isCaptureEnabled()) return handler(request, context);

    const correlationId = generateRequestId();
    let provider = options.providerFallback;
    let model = "";

    try {
      const clientHeaders = Object.fromEntries(request.headers.entries());
      const contentType = request.headers.get("content-type");
      let clientBody: unknown = null;

      // Only read a JSON/text body. A binary upload (multipart/form-data, e.g.
      // audio transcription/translation) is marked metadata-only by
      // captureClientIn via its content-type, and its body is never read.
      if (!isBinaryRequestContentType(contentType)) {
        const raw = await request
          .clone()
          .text()
          .catch(() => "");
        clientBody = raw.length > 0 ? raw : null;

        // Best-effort provider/model from the request's `model` field
        // (`provider/model`). Shared by BOTH legs so they group and correlate.
        try {
          const parsed = raw ? JSON.parse(raw) : null;
          const m =
            parsed && typeof (parsed as { model?: unknown }).model === "string"
              ? (parsed as { model: string }).model
              : "";
          if (m) {
            model = m;
            const slash = m.indexOf("/");
            if (slash > 0) provider = m.slice(0, slash);
          }
        } catch {
          // non-JSON text body: keep the fallback labels
        }
      }

      captureClientIn({
        correlationId,
        provider,
        model,
        endpoint: options.endpoint,
        clientHeaders,
        clientBody,
      });
    } catch {
      // best-effort: capture must never block or break the request path
    }

    const response = await handler(request, context);

    try {
      // No endpoint passed: response binary-ness is decided by its content-type
      // plus in-body media redaction (a JSON image response keeps its envelope,
      // only the base64 blob is stripped), matching the upstream-leg policy.
      captureClientOut({ correlationId, provider, model, response });
    } catch {
      // best-effort: capture must never break the client response path
    }

    try {
      response.headers.set("X-Correlation-Id", correlationId);
    } catch {
      // some Response objects carry immutable headers; non-fatal for capture
    }

    return response;
  };
}
