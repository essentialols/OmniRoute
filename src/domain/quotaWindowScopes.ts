/**
 * Quota Window Scopes — Domain Layer
 *
 * Maps `(provider, requestedModel)` to the subset of a connection's cached quota
 * windows that actually govern that model.
 *
 * Why this exists: `isAccountQuotaExhausted()` is a single account-wide boolean,
 * computed as an AND across every window (see the #5923 / #4438 comments in
 * `quotaCache.ts` — an OR reduction caused an outage where one dead window blocked
 * every model). That aggregate is deliberately coarse, so a *per-request* model
 * scope has to be layered ON TOP of it rather than folded into it.
 *
 * Only `codex` had such a scope, so every other provider refused a request for a
 * healthy model as soon as the account-wide flag was set. Observed 2026-08-10 on
 * `agy`: the `gemini-3.x` windows sat at 0% on a shared 7-day pool while
 * `gemini-2.5-flash`, `gemini-2.5-pro`, `claude-sonnet-4-6` etc. were at 100% —
 * and all of them were rejected with "All agy accounts have exhausted their quota".
 *
 * A provider without an entry here keeps today's behaviour exactly: no filter,
 * so the account-wide verdict stands.
 *
 * @module domain/quotaWindowScopes
 */

import { getCodexQuotaWindowFilterForModel } from "@omniroute/open-sse/config/codexQuotaScopes.ts";
import { toClientAntigravityQuotaModelId } from "@omniroute/open-sse/config/antigravityModelAliases.ts";

/** Predicate selecting the cached quota-window keys that govern the requested model. */
export type QuotaWindowFilter = (windowName: string) => boolean;

/** Builds the window filter for one provider, or `undefined` when the model is unscopable. */
export type QuotaWindowScopeResolver = (model: string) => QuotaWindowFilter | undefined;

/** Same normalization `quotaCache.resolveQuotaWindow` uses, so keys compare identically. */
function normalizeScopeKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strip a routing prefix: "agy/gemini-2.5-flash", "antigravity/…", "google/…". */
function stripModelPrefix(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Antigravity / agy quota windows are keyed by the CLIENT model id itself
 * (`open-sse/services/usage/antigravity.ts` writes `quotas[modelKey]`), so the
 * window that governs a request can be looked up directly by name.
 *
 * Deliberately an exact (normalized) match: the family-level aggregates the same
 * response carries (`gemini_weekly`, `claude_gpt_weekly`, `credits`) are NOT
 * treated as governing windows. Folding them in under the AND below would let a
 * healthy family bucket unblock a model whose own bucket is genuinely at 0%.
 */
function antigravityWindowFilter(model: string): QuotaWindowFilter | undefined {
  const bare = stripModelPrefix(String(model || "").trim());
  if (!bare) return undefined;

  const candidates = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = normalizeScopeKey(value);
    if (normalized) candidates.add(normalized);
  };
  add(bare);
  // Upstream quota buckets live in a different id namespace than the client catalog
  // (see ANTIGRAVITY_QUOTA_BUCKET_TO_CLIENT); accept either spelling.
  try {
    add(toClientAntigravityQuotaModelId(bare));
  } catch {
    // Alias resolution is best-effort — the bare id is always a valid candidate.
  }

  if (candidates.size === 0) return undefined;
  return (windowName: string) => candidates.has(normalizeScopeKey(windowName));
}

const QUOTA_WINDOW_SCOPE_RESOLVERS: Record<string, QuotaWindowScopeResolver> = {
  // Codex windows are scope-labelled (`codex` vs `codex-spark`), not model-keyed.
  codex: (model) => getCodexQuotaWindowFilterForModel(model),
  antigravity: antigravityWindowFilter,
  agy: antigravityWindowFilter,
};

/** True when this provider reports per-model quota windows we can scope a request to. */
export function hasQuotaWindowScoping(provider: string | null | undefined): boolean {
  return Boolean(QUOTA_WINDOW_SCOPE_RESOLVERS[String(provider || "").toLowerCase()]);
}

/**
 * Resolve the quota-window filter for a request.
 * Returns `undefined` when the provider has no per-model windows or no model was
 * requested — callers must then fall back to the account-wide verdict.
 */
export function getQuotaWindowFilterForRequest(
  provider: string | null | undefined,
  model: string | null | undefined
): QuotaWindowFilter | undefined {
  if (!model) return undefined;
  const resolver = QUOTA_WINDOW_SCOPE_RESOLVERS[String(provider || "").toLowerCase()];
  if (!resolver) return undefined;
  return resolver(model);
}
