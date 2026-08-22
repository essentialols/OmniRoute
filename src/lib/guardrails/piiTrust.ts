/**
 * Per-provider PII trust tiering.
 *
 * PII redaction/sanitization used to be a single global toggle
 * (`PII_REDACTION_ENABLED` / `PII_RESPONSE_SANITIZATION`). That is too coarse:
 * OmniRoute proxies both for local / high-trust upstreams (where the operator
 * owns the data and mutating payloads would silently corrupt legitimate
 * traffic — Hard Rule #20) AND for untrusted third-party webchat endpoints
 * (Chinese / free webchat providers) where leaking real PII to the upstream is
 * the actual risk.
 *
 * This module classifies the DESTINATION provider into a trust tier and decides
 * whether PII redaction should apply for that request:
 *
 *   - TRUSTED (no redaction): local, privatemode, and high-trust cloud CLIs
 *     (cc/claude, codex, gemini, agy/antigravity).
 *   - UNTRUSTED (redact by default): every other provider — deepseek(-web),
 *     kimi(-web), qwen(-web), glm(-web), zai(-web), siliconflow, baidu,
 *     tencent, bazaarlink, and anything not explicitly trusted.
 *
 * The legacy global env/DB flags remain a full override: if an operator has
 * explicitly set `PII_REDACTION_ENABLED` / `PII_RESPONSE_SANITIZATION` (via env
 * or a DB feature-flag override), that value wins uniformly for ALL providers.
 * Only when there is NO explicit override does the trust-tiered default apply.
 *
 * This honors the spirit of Hard Rule #20 (no silent GLOBAL mutation): mutation
 * is now an explicit, operator-approved, per-tier decision, and requests with no
 * destination context are never mutated by default.
 */

import { getFeatureFlagOverride } from "@/lib/db/featureFlags";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

/**
 * Providers whose data the operator is presumed to own or trust: local runtimes
 * and high-trust first-party cloud CLIs. PII is NEVER redacted for these by
 * default (an explicit global override can still force it on).
 */
export const PII_TRUSTED_PROVIDERS = new Set<string>([
  // Local runtimes
  "local",
  "localai",
  "ollama",
  "lmstudio",
  "lm-studio",
  "llamacpp",
  "llama-cpp",
  "llama-swap",
  "vllm",
  "koboldcpp",
  "text-generation-webui",
  "jan",
  "gpt4all",
  // Confidential-compute / privacy tier
  "privatemode",
  // High-trust first-party CLIs / providers
  "cc",
  "claude-code",
  "claude",
  "anthropic",
  "codex",
  "openai-codex",
  "gemini",
  "gemini-cli",
  "google",
  "google-gemini",
  "google-vertex",
  "vertex",
  "agy",
  "antigravity",
]);

export function normalizeProviderId(provider?: string | null): string {
  return (provider || "").toLowerCase().trim();
}

/**
 * True when the provider is in the trusted tier (no PII redaction by default).
 * A missing/empty provider is treated as trusted so that requests without a
 * destination context are never mutated by default.
 */
export function isTrustedProvider(provider?: string | null): boolean {
  const id = normalizeProviderId(provider);
  if (!id) return true;
  if (PII_TRUSTED_PROVIDERS.has(id)) return true;
  // Local-ish heuristics (custom local endpoints, "local-*", "ollama-*").
  if (id.startsWith("local")) return true;
  if (id.startsWith("ollama")) return true;
  if (id.startsWith("privatemode")) return true;
  return false;
}

/**
 * Whether the operator has explicitly pinned a PII feature flag (env var set to
 * a non-empty value, or a DB override present). When true, that global value
 * wins uniformly and the trust-tiered default is bypassed.
 */
export function hasExplicitPiiOverride(flagKey: string): boolean {
  try {
    if (getFeatureFlagOverride(flagKey) !== undefined) return true;
  } catch {
    // DB not available (e.g. early boot / some unit contexts) — fall back to env.
  }
  const envValue = process.env[flagKey];
  return envValue !== undefined && envValue !== "";
}

/**
 * Central decision: should PII redaction apply for this destination provider and
 * feature flag?
 *
 * - Explicit global override (env/DB) → that value wins for all providers.
 * - Otherwise (default) → trust-tiered: redact iff the provider is UNTRUSTED and
 *   a destination provider is actually known.
 */
export function shouldRedactPiiForProvider(
  provider: string | null | undefined,
  flagKey: string
): boolean {
  if (hasExplicitPiiOverride(flagKey)) {
    return isFeatureFlagEnabled(flagKey);
  }
  if (!provider) return false;
  return !isTrustedProvider(provider);
}
