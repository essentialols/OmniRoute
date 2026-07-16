/**
 * chatCore streaming response pipeline assembly (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's streaming success path: chain the response transforms onto the
 * provider stream — disconnect-aware pipe → PII sanitization (explicit transform or feature-flagged
 * SSE transform) → optional progress tracking (Phase 9.3) → SSE heartbeat → optional model-echo
 * (#1311). Returns the assembled `finalStream`; mutates the passed `responseHeaders` to add the
 * progress marker when progress is enabled. Behaviour is byte-identical to the previous inline
 * block, including the exact transform order and branch conditions.
 */
import { pipeWithDisconnect as defaultPipeWithDisconnect } from "../../utils/streamHandler.ts";
import {
  createSseHeartbeatTransform as defaultHeartbeat,
  shapeForClientFormat as defaultShape,
} from "../../utils/sseHeartbeat.ts";
import { createModelEchoTransform as defaultModelEcho } from "../../services/responseModelEcho.ts";
import {
  createProgressTransform as defaultProgress,
  wantsProgress as defaultWantsProgress,
} from "../../utils/progressTracker.ts";
import { createPiiSseTransform as defaultPiiSse } from "@/lib/streamingPiiTransform";
import { isFeatureFlagEnabled as defaultFeatureFlag } from "@/shared/utils/featureFlags";
import { shouldRedactPiiForProvider as defaultShouldRedactPii } from "@/lib/guardrails/piiTrust";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../../config/constants.ts";

type HeadersLike = Headers | Record<string, unknown> | null | undefined;

export interface StreamingPipelineDeps {
  wantsProgress: typeof defaultWantsProgress;
  pipeWithDisconnect: typeof defaultPipeWithDisconnect;
  isFeatureFlagEnabled: typeof defaultFeatureFlag;
  shouldRedactPiiForProvider: typeof defaultShouldRedactPii;
  createPiiSseTransform: typeof defaultPiiSse;
  createProgressTransform: typeof defaultProgress;
  createSseHeartbeatTransform: typeof defaultHeartbeat;
  shapeForClientFormat: typeof defaultShape;
  createModelEchoTransform: typeof defaultModelEcho;
}

const DEFAULT_DEPS: StreamingPipelineDeps = {
  wantsProgress: defaultWantsProgress,
  pipeWithDisconnect: defaultPipeWithDisconnect,
  isFeatureFlagEnabled: defaultFeatureFlag,
  shouldRedactPiiForProvider: defaultShouldRedactPii,
  createPiiSseTransform: defaultPiiSse,
  createProgressTransform: defaultProgress,
  createSseHeartbeatTransform: defaultHeartbeat,
  shapeForClientFormat: defaultShape,
  createModelEchoTransform: defaultModelEcho,
};

export function assembleStreamingPipeline(
  args: {
    providerResponse: unknown;
    transformStream: unknown;
    streamController: { signal: AbortSignal };
    createPiiTransform: unknown;
    clientRawRequestHeaders: HeadersLike;
    clientResponseFormat: unknown;
    echoModel: string | null | undefined;
    responseHeaders: Record<string, string>;
    provider?: string | null;
  },
  deps: StreamingPipelineDeps = DEFAULT_DEPS
) {
  // ── Phase 9.3: Progress tracking (opt-in) ──
  const progressEnabled = deps.wantsProgress(args.clientRawRequestHeaders);
  let finalStream;

  let piiStream = deps.pipeWithDisconnect(
    args.providerResponse,
    args.transformStream,
    args.streamController
  );
  if (typeof args.createPiiTransform === "function") {
    piiStream = piiStream.pipeThrough((args.createPiiTransform as () => TransformStream)());
  } else if (deps.shouldRedactPiiForProvider(args.provider ?? null, "PII_RESPONSE_SANITIZATION")) {
    // Trust-tiered (per-provider) PII sanitization: redact for untrusted
    // destinations even when the global flag is off; skip for trusted/local.
    // An explicit global PII_RESPONSE_SANITIZATION override still wins uniformly.
    piiStream = piiStream.pipeThrough(deps.createPiiSseTransform({ forceEnabled: true }));
  }

  if (progressEnabled) {
    const progressTransform = deps.createProgressTransform({
      signal: args.streamController.signal,
    });
    // Chain: provider → transform → progress → client
    finalStream = piiStream.pipeThrough(progressTransform);
    args.responseHeaders[OMNIROUTE_RESPONSE_HEADERS.progress] = "enabled";
  } else {
    finalStream = piiStream;
  }
  finalStream = finalStream.pipeThrough(
    deps.createSseHeartbeatTransform({
      signal: args.streamController.signal,
      intervalMs: SSE_HEARTBEAT_INTERVAL_MS,
      shape: deps.shapeForClientFormat(args.clientResponseFormat),
    })
  );
  // #1311: echo the requested alias/combo name in each streamed SSE chunk's model field.
  if (args.echoModel) {
    finalStream = finalStream.pipeThrough(deps.createModelEchoTransform(args.echoModel));
  }
  return finalStream;
}
