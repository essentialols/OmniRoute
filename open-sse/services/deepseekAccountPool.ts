/**
 * deepseekAccountPool.ts — P1-3: DeepSeek multi-account (bearer-token) rotation
 *
 * Round-robins a pool of DeepSeek `userToken` bearer tokens with per-token
 * cooldown, temporary mute (biz_code 5), and permanent-invalid marking (401/403),
 * mirroring the shared-relay-proxy `AccountManager` (providers/deepseek.py) but
 * scoped per OmniRoute provider connection.
 *
 * ── Token pool source ────────────────────────────────────────────────────
 * Tokens come from the same place apiKeyRotator.ts uses:
 *   - primary token  → connection `api_key` (the userToken from DeepSeek
 *                      localStorage; see deepseek-web.ts `extractUserToken`)
 *   - extra tokens   → `providerSpecificData.extraApiKeys[]` (plain strings)
 * Each token is addressed by the same keyId scheme apiKeyRotator uses:
 *   "primary" | "extra_0" | "extra_1" | ...
 * so a caller can cross-reference health state between the two modules.
 *
 * ── Rotation semantics (matches deepseek.py) ─────────────────────────────
 *   - Round-robin across tokens that are valid AND not muted.
 *   - Prefer tokens outside the per-token cooldown window (30s default);
 *     fall back to the least-recently-used valid token rather than blocking.
 *   - biz_code 5 (account muted): mute the token for 1h (or the upstream
 *     `mute_until`), then rotate to the next token.
 *   - HTTP 401/403 (token expired/invalid): mark the token invalid
 *     permanently (until process restart or an explicit reset), then rotate.
 *
 * In-memory only. State resets on process restart — intentional, matching
 * apiKeyRotator.ts (even distribution across restarts, no persistence overhead).
 *
 * ── Executor integration (deepseek-web.ts — DO NOT wire here) ─────────────
 * The executor is not modified by this file. To adopt the pool, the executor
 * (or its auto-refresh wrapper) should, per request:
 *   1. Build the token list: primary = extractUserToken(creds),
 *      extras = providerSpecificData.extraApiKeys[] (extract each via the same
 *      JSON-unwrap as extractUserToken).
 *   2. const picked = getNextToken(connectionId, primary, extras);
 *      if (!picked) → surface a "no usable DeepSeek tokens" error.
 *      Use picked.token as the `userToken` fed to acquireAccessToken().
 *   3. On the muted-account signal (biz_code 5 / mute_until in the error body):
 *      muteToken(connectionId, picked.keyId, muteUntilMs?) then re-pick and
 *      retry once (bounded — stop when getNextToken returns null).
 *   4. On HTTP 401/403 (or DeepSeek error 40003):
 *      markTokenInvalid(connectionId, picked.keyId) then re-pick and retry once.
 *   5. On a clean completion: recordTokenSuccess(connectionId, picked.keyId).
 * `connectionId` MUST be the same id passed to apiKeyRotator for this
 * connection so health/rotation state stays aligned across modules.
 */

// Eviction limits to bound memory under heavy connection churn (mirrors apiKeyRotator).
const MAX_POOL_ENTRIES = 500;

const DEFAULT_COOLDOWN_MS = 30_000; // per-token soft cooldown between uses
const DEFAULT_MUTE_MS = 60 * 60 * 1000; // biz_code 5 mute duration (1h)

interface TokenState {
  keyId: string; // "primary" | "extra_0" | ...
  token: string;
  valid: boolean; // false after 401/403 — skipped until reset
  mutedUntil: number; // epoch ms; token skipped while now < mutedUntil
  lastUsedAt: number; // epoch ms of last selection
  totalUses: number;
  totalMutes: number;
  totalInvalidations: number;
}

interface ConnectionPool {
  tokens: Map<string, TokenState>; // keyId → state
  index: number; // round-robin cursor
}

export interface PoolConfig {
  /** Per-token soft cooldown in ms (default 30_000). */
  cooldownMs?: number;
  /** Default mute duration in ms when no upstream mute_until is given (default 3_600_000). */
  muteMs?: number;
}

export interface PickedToken {
  token: string;
  keyId: string;
}

const _pools = new Map<string, ConnectionPool>();

function unwrapToken(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // DeepSeek stores the token as {"value":"..."} in localStorage; unwrap it
  // exactly like deepseek-web.ts `extractUserToken` so both agree on the value.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === "string" && parsed.value.length > 0) {
      return parsed.value;
    }
  } catch {
    // not JSON — use raw
  }
  return raw;
}

function getOrCreatePool(connectionId: string): ConnectionPool {
  let pool = _pools.get(connectionId);
  if (!pool) {
    if (_pools.size >= MAX_POOL_ENTRIES) {
      const oldest = _pools.keys().next().value;
      if (oldest !== undefined) _pools.delete(oldest);
    }
    pool = { tokens: new Map(), index: 0 };
    _pools.set(connectionId, pool);
  }
  return pool;
}

/**
 * Reconcile the in-memory pool with the token list supplied by the caller.
 * New tokens are added; tokens whose value changed are reset (a re-pasted
 * token is treated as freshly valid); removed keyIds are dropped. Preserves
 * mute/invalid/usage state for tokens whose value is unchanged.
 */
function syncPool(pool: ConnectionPool, entries: Array<{ keyId: string; token: string }>): void {
  const seen = new Set<string>();
  for (const { keyId, token } of entries) {
    seen.add(keyId);
    const existing = pool.tokens.get(keyId);
    if (!existing) {
      pool.tokens.set(keyId, {
        keyId,
        token,
        valid: true,
        mutedUntil: 0,
        lastUsedAt: 0,
        totalUses: 0,
        totalMutes: 0,
        totalInvalidations: 0,
      });
    } else if (existing.token !== token) {
      // Token value replaced by the operator — treat as recovered.
      existing.token = token;
      existing.valid = true;
      existing.mutedUntil = 0;
    }
  }
  for (const keyId of [...pool.tokens.keys()]) {
    if (!seen.has(keyId)) pool.tokens.delete(keyId);
  }
}

function buildEntries(
  primaryToken: string | null | undefined,
  extraTokens: Array<string | null | undefined> = []
): Array<{ keyId: string; token: string }> {
  const entries: Array<{ keyId: string; token: string }> = [];
  const primary = unwrapToken(primaryToken);
  if (primary) entries.push({ keyId: "primary", token: primary });
  extraTokens.forEach((raw, i) => {
    const t = unwrapToken(raw);
    if (t) entries.push({ keyId: `extra_${i}`, token: t });
  });
  return entries;
}

/**
 * Select the next usable DeepSeek token for a connection via round-robin.
 *
 * Skips invalid tokens and tokens muted past `now`. Prefers tokens outside the
 * cooldown window; if all valid tokens are within cooldown, returns the
 * least-recently-used one (rather than blocking) so a single-token connection
 * still works.
 *
 * @returns The picked token + keyId, or null when no valid/unmuted token exists.
 */
export function getNextToken(
  connectionId: string,
  primaryToken: string | null | undefined,
  extraTokens: Array<string | null | undefined> = [],
  config: PoolConfig = {}
): PickedToken | null {
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const pool = getOrCreatePool(connectionId);
  syncPool(pool, buildEntries(primaryToken, extraTokens));

  const now = Date.now();
  const usable = [...pool.tokens.values()].filter((t) => t.valid && t.mutedUntil <= now);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const only = usable[0];
    only.lastUsedAt = now;
    only.totalUses++;
    return { token: only.token, keyId: only.keyId };
  }

  const cooled = usable.filter((t) => now - t.lastUsedAt >= cooldownMs);
  // Prefer cooled-down tokens; otherwise fall back to least-recently-used.
  const candidates =
    cooled.length > 0 ? cooled : [...usable].sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  const chosen = candidates[pool.index % candidates.length];
  pool.index++;
  chosen.lastUsedAt = now;
  chosen.totalUses++;
  return { token: chosen.token, keyId: chosen.keyId };
}

/**
 * Mute a token after a biz_code 5 (account-muted) response. The token is
 * skipped by getNextToken until `muteUntilMs`, or for `config.muteMs`
 * (default 1h) when no upstream timestamp is supplied.
 */
export function muteToken(
  connectionId: string,
  keyId: string,
  muteUntilMs?: number,
  config: PoolConfig = {}
): void {
  const pool = _pools.get(connectionId);
  const state = pool?.tokens.get(keyId);
  if (!state) return;
  const until =
    typeof muteUntilMs === "number" && muteUntilMs > Date.now()
      ? muteUntilMs
      : Date.now() + (config.muteMs ?? DEFAULT_MUTE_MS);
  state.mutedUntil = until;
  state.totalMutes++;
}

/**
 * Mark a token permanently invalid after HTTP 401/403 (or DeepSeek error
 * 40003). Skipped by getNextToken until resetToken()/removeConnection() or a
 * process restart. Re-pasting a new token value auto-clears this via syncPool.
 */
export function markTokenInvalid(connectionId: string, keyId: string): void {
  const pool = _pools.get(connectionId);
  const state = pool?.tokens.get(keyId);
  if (!state) return;
  state.valid = false;
  state.totalInvalidations++;
}

/** Clear mute + invalid flags after a successful completion (optional). */
export function recordTokenSuccess(connectionId: string, keyId: string): void {
  const pool = _pools.get(connectionId);
  const state = pool?.tokens.get(keyId);
  if (!state) return;
  state.mutedUntil = 0;
  state.valid = true;
}

/** Manually restore a token to valid/unmuted (e.g. operator reset from dashboard). */
export function resetToken(connectionId: string, keyId: string): void {
  recordTokenSuccess(connectionId, keyId);
}

/** Pool health summary for observability (mirrors deepseek.py account_summary). */
export function getPoolSummary(connectionId: string): {
  total: number;
  valid: number;
  ready: number;
  muted: number;
  invalid: number;
} {
  const pool = _pools.get(connectionId);
  if (!pool) return { total: 0, valid: 0, ready: 0, muted: 0, invalid: 0 };
  const now = Date.now();
  let valid = 0;
  let ready = 0;
  let muted = 0;
  let invalid = 0;
  for (const t of pool.tokens.values()) {
    if (!t.valid) {
      invalid++;
      continue;
    }
    valid++;
    if (t.mutedUntil > now) muted++;
    else ready++;
  }
  return { total: pool.tokens.size, valid, ready, muted, invalid };
}

/** Drop all state for a connection (call on connection delete). */
export function removeConnection(connectionId: string): void {
  _pools.delete(connectionId);
}
