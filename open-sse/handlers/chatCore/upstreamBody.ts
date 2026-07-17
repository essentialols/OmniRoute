/**
 * chatCore upstream body preparation (Quality Gate v2 / Fase 9 — chatCore god-file decomposition,
 * #3501 — first internal sub-slice of executeProviderRequest).
 *
 * Extracted from handleChatCore's execute() closure: prepares the body actually sent upstream for a
 * given target model. Pins the model id, applies the configured payload rules, truncates the tool
 * list to the provider's effective limit, backfills a default `user` for Qwen OAuth requests, and
 * injects an OpenAI `prompt_cache_key` for caching-capable providers. Pure with respect to handler
 * state (returns a fresh body, only logs as a side effect); behaviour is byte-identical to the
 * previous inline block. Split into small private steps so each stays under the complexity cap.
 */

import {
  applyConfiguredPayloadRules,
  resolvePayloadRuleProtocols,
} from "../../services/payloadRules.ts";
import { getEffectiveToolLimit, getKnownToolLimit } from "../../services/toolLimitDetector.ts";
import { providerSupportsCaching } from "../../utils/cacheControlPolicy.ts";
import {
  stripUnsupportedToolFields,
  stripHeavyCodexToolsForBudget,
  anchorJsonSchemaPatterns,
  canonicalizeTools,
} from "../../config/providerFieldStrips.ts";
import { normalizeOpenAICompatMessages } from "./openaiCompatMessages.ts";
import { FORMATS } from "../../translator/formats.ts";
import { isLocalProvider } from "@/shared/constants/providers";

type LoggerLike = { debug?: (...args: unknown[]) => void } | null | undefined;
type Body = Record<string, unknown>;
type CredentialsLike = { apiKey?: unknown; accessToken?: unknown } | null | undefined;

function buildAppliedRulesSummary(
  applied: Array<{ type: string; path: string; value?: unknown }>
): string {
  return applied
    .map((rule) => {
      if (rule.type === "filter") return `${rule.type}:${rule.path}`;
      const serializedValue = JSON.stringify(rule.value);
      const safeValue =
        typeof serializedValue === "string" && serializedValue.length > 80
          ? `${serializedValue.slice(0, 77)}...`
          : serializedValue;
      return `${rule.type}:${rule.path}=${safeValue}`;
    })
    .join(", ");
}

function truncateToolList(
  bodyToSend: Body,
  provider: string | null | undefined,
  bypassDefaultToolLimit: boolean,
  log?: LoggerLike
): Body {
  if (!Array.isArray(bodyToSend.tools)) return bodyToSend;

  const knownLimit = getKnownToolLimit(provider);
  if (knownLimit !== null) {
    if (bodyToSend.tools.length > knownLimit) {
      const originalCount = bodyToSend.tools.length;
      const truncatedTools = bodyToSend.tools.slice(0, knownLimit);
      bodyToSend = { ...bodyToSend, tools: truncatedTools };
      log?.debug?.(
        "TOOL_LIMIT",
        `Truncated ${originalCount} tools to ${knownLimit} for ${provider}`
      );
    }
    return bodyToSend;
  }

  if (bypassDefaultToolLimit === true) return bodyToSend;

  const effectiveToolLimit = getEffectiveToolLimit(provider);
  if (bodyToSend.tools.length > effectiveToolLimit) {
    const originalCount = bodyToSend.tools.length;
    const truncatedTools = bodyToSend.tools.slice(0, effectiveToolLimit);
    bodyToSend = { ...bodyToSend, tools: truncatedTools };
    log?.debug?.(
      "TOOL_LIMIT",
      `Truncated ${originalCount} tools to ${effectiveToolLimit} for ${provider}`
    );
  }
  return bodyToSend;
}

// Qwen OAuth rejects requests without a non-empty `user` field. Some minimal OpenAI-compatible
// clients omit it, so we backfill a stable default only for OAuth mode (API key mode is unaffected).
function backfillQwenOAuthUser(
  bodyToSend: Body,
  provider: string | null | undefined,
  credentials: CredentialsLike,
  log?: LoggerLike
): Body {
  const hasValidQwenUser = typeof bodyToSend.user === "string" && bodyToSend.user.trim().length > 0;
  const isQwenOAuthRequest =
    provider === "qwen" &&
    !credentials?.apiKey &&
    typeof credentials?.accessToken === "string" &&
    credentials.accessToken.trim().length > 0;
  if (isQwenOAuthRequest && !hasValidQwenUser) {
    bodyToSend = { ...bodyToSend, user: "omniroute-qwen-oauth" };
    log?.debug?.("QWEN", "Injected fallback user for OAuth request");
  }
  return bodyToSend;
}

// Normalize the OpenAI `prompt_cache_key` cache-routing hint per provider capability.
//
// Two responsibilities for OpenAI-format upstreams:
//  1. STRIP a client-supplied key for providers that do not support caching. Responses-API
//     clients (notably the Codex CLI) always send a session-scoped `prompt_cache_key`, but
//     strict OpenAI-compatible upstreams that never implemented it reject the whole request
//     with a 400 (e.g. Groq: "property 'prompt_cache_key' is unsupported"). Cerebras/Mistral
//     silently ignore it today, but stripping is the correct, provider-agnostic normalization.
//  2. INJECT a stable key for caching-capable providers when the client didn't supply one
//     (unchanged behavior). `codex`/`xai`/`nvidia` are excluded from injection: codex injects
//     its own downstream, and xai/nvidia reject the field. For the latter two, step 1 also
//     strips any client-supplied key since providerSupportsCaching() is false for them.
async function injectPromptCacheKey(
  bodyToSend: Body,
  provider: string | null | undefined,
  targetFormat: string
): Promise<Body> {
  if (targetFormat !== FORMATS.OPENAI) return bodyToSend;

  if (!providerSupportsCaching(provider)) {
    if (bodyToSend.prompt_cache_key !== undefined || bodyToSend.promptCacheKey !== undefined) {
      const cleaned = { ...bodyToSend };
      delete cleaned.prompt_cache_key;
      delete cleaned.promptCacheKey;
      return cleaned;
    }
    return bodyToSend;
  }

  if (
    !bodyToSend.prompt_cache_key &&
    Array.isArray(bodyToSend.messages) &&
    !["nvidia", "codex", "xai"].includes(provider)
  ) {
    const { generatePromptCacheKey } = await import("@/lib/promptCache");
    const cacheKey = generatePromptCacheKey(bodyToSend.messages);
    if (cacheKey) {
      bodyToSend = { ...bodyToSend, prompt_cache_key: cacheKey };
    }
  }
  return bodyToSend;
}

// Normalize an OpenAI-format upstream body for strict OpenAI-compatible executors.
//
// Only runs for targetFormat === "openai" (gemini/claude have dedicated handling), and
// only rewrites when something is unroutable as-is. Fixes Codex/Responses-API injections
// that strict OpenAI-compat upstreams reject:
//  - text-only multipart content arrays -> string (llm7 "does not support vision input");
//  - adjacent system messages (from developer -> system normalization) merged into one
//    (uncloseai "System message must be at the beginning");
//  - tool fields the provider cannot accept (cohere parallel_tool_calls 422; publicai
//    tools/tool_choice 400 without --enable-auto-tool-choice).
function normalizeOpenAICompatUpstreamBody(
  bodyToSend: Body,
  provider: string | null | undefined,
  targetFormat: string
): Body {
  if (targetFormat !== FORMATS.OPENAI) return bodyToSend;
  let next = normalizeOpenAICompatMessages(bodyToSend) as Body;
  next = stripUnsupportedToolFields(next, provider);
  // Drop codex's heavy sub-agent orchestration tool group for providers whose per-request
  // token budget cannot fit the full codex tool catalog (e.g. Groq free tier's 12k TPM cap,
  // which 413s a ~12.9k-token codex request before streaming).
  next = stripHeavyCodexToolsForBudget(next, provider);
  if (
    isLocalProvider(provider) ||
    (typeof provider === "string" && provider.startsWith("openai-compatible"))
  ) {
    // Canonicalize tool definitions so identical tool sets always produce the same
    // token prefix, maximizing llama-server's KV prefix cache hit rate.
    next = canonicalizeTools(next);
    next = anchorJsonSchemaPatterns(next);
  }
  return next;
}

export async function prepareUpstreamBody(opts: {
  translatedBody: Body;
  modelToCall: string;
  provider: string | null | undefined;
  targetFormat: string;
  credentials: CredentialsLike;
  bypassDefaultToolLimit?: boolean;
  log?: LoggerLike;
}): Promise<Body> {
  const {
    translatedBody,
    modelToCall,
    provider,
    targetFormat,
    credentials,
    bypassDefaultToolLimit = false,
    log,
  } = opts;

  let bodyToSend: Body =
    translatedBody.model === modelToCall
      ? translatedBody
      : { ...translatedBody, model: modelToCall };
  const payloadRuleModel =
    typeof bodyToSend.model === "string" && bodyToSend.model.length > 0
      ? bodyToSend.model
      : modelToCall;
  const payloadRuleProtocols = resolvePayloadRuleProtocols({ provider, targetFormat });
  const payloadRuleResult = await applyConfiguredPayloadRules(
    bodyToSend,
    payloadRuleModel,
    payloadRuleProtocols
  );
  bodyToSend = payloadRuleResult.payload;

  if (payloadRuleResult.applied.length > 0) {
    log?.debug?.(
      "PAYLOAD_RULES",
      `Applied ${payloadRuleResult.applied.length} rule(s) for ${payloadRuleModel} (${payloadRuleProtocols.join(", ")}): ${buildAppliedRulesSummary(payloadRuleResult.applied)}`
    );
  }

  bodyToSend = truncateToolList(bodyToSend, provider, bypassDefaultToolLimit ?? false, log);
  bodyToSend = backfillQwenOAuthUser(bodyToSend, provider, credentials, log);
  bodyToSend = await injectPromptCacheKey(bodyToSend, provider, targetFormat);
  bodyToSend = normalizeOpenAICompatUpstreamBody(bodyToSend, provider, targetFormat);

  return bodyToSend;
}
