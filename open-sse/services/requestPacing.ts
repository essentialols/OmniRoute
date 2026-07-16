/**
 * requestPacing.ts — P1-4: per-connection minimum-interval request pacing
 *
 * Enforces a configurable minimum gap between successive requests to the same
 * provider connection, so scrape-sensitive upstreams (DeepSeek web, Brave Leo)
 * are not hit faster than they tolerate. Mirrors the `min_interval` config on
 * the shared-relay-proxy providers (config.json: brave_leo min_interval 5).
 *
 * ── Design ───────────────────────────────────────────────────────────────
 *   - Per-connection `nextAvailableAt` timestamp (a reservation cursor, not a
 *     plain last-used stamp). Each call reserves the next free slot:
 *       slot = max(now, nextAvailableAt); nextAvailableAt = slot + minInterval.
 *     This staggers CONCURRENT requests correctly — N in-flight calls resolve
 *     at now, now+interval, now+2·interval, … rather than all at once.
 *   - Resolves via a single setTimeout (never busy-waits, never blocks the
 *     event loop). If enough time has already passed, resolves immediately.
 *   - Default interval 0 (no pacing). DeepSeek 30s, Brave Leo 5s by default;
 *     override per call.
 *
 * ── Executor integration (DO NOT wire here) ──────────────────────────────
 * This module is standalone; no executor is modified by this file. To adopt
 * pacing, an executor should `await waitForPacing(connectionId, provider)`
 * immediately before dispatching its upstream fetch, e.g.:
 *
 *     await waitForPacing(connectionId, "deepseek-web");
 *     const resp = await fetch(COMPLETION_URL, { ... });
 *
 * Use the same `connectionId` used elsewhere (apiKeyRotator / deepseekAccountPool)
 * so pacing is scoped to one account, not the whole provider. Pass an explicit
 * `overrideMs` when a connection carries its own configured interval
 * (e.g. providerSpecificData.minIntervalMs).
 */

// Provider-keyed default intervals in ms. Keys are matched case-insensitively
// with "-"/"_" treated as equivalent (so "deepseek-web" and "deepseek_web" match).
const DEFAULT_INTERVALS_MS: Record<string, number> = {
  deepseek: 30_000,
  "deepseek-web": 30_000,
  "brave-leo": 5_000,
  brave: 5_000,
};

// Bound memory under heavy connection churn (mirrors apiKeyRotator eviction).
const MAX_PACING_ENTRIES = 1000;

const _nextAvailableAt = new Map<string, number>();

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/_/g, "-");
}

/** Resolve the default minimum interval (ms) configured for a provider. */
export function getMinInterval(provider: string | null | undefined): number {
  if (!provider) return 0;
  return DEFAULT_INTERVALS_MS[normalizeProvider(provider)] ?? 0;
}

function reserveSlotDelay(connectionId: string, intervalMs: number): number {
  const now = Date.now();
  if (intervalMs <= 0) {
    _nextAvailableAt.set(connectionId, now);
    return 0;
  }
  if (!_nextAvailableAt.has(connectionId) && _nextAvailableAt.size >= MAX_PACING_ENTRIES) {
    const oldest = _nextAvailableAt.keys().next().value;
    if (oldest !== undefined) _nextAvailableAt.delete(oldest);
  }
  const prevNext = _nextAvailableAt.get(connectionId) ?? 0;
  const slot = Math.max(now, prevNext);
  _nextAvailableAt.set(connectionId, slot + intervalMs);
  return slot - now;
}

/**
 * Wait until this connection is allowed to send its next request, then resolve.
 *
 * @param connectionId Per-account/connection key (scope pacing here, not per provider).
 * @param provider     Provider name — used to look up the default interval.
 * @param overrideMs   Explicit interval override (e.g. a connection-configured value).
 *                     When provided it fully replaces the provider default.
 * @returns A promise that resolves once the reserved time slot is reached
 *          (immediately when no wait is required). setTimeout-based, non-blocking.
 */
export function waitForPacing(
  connectionId: string,
  provider?: string | null,
  overrideMs?: number
): Promise<void> {
  const intervalMs =
    typeof overrideMs === "number" && overrideMs >= 0 ? overrideMs : getMinInterval(provider);
  const delay = reserveSlotDelay(connectionId, intervalMs);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    // Don't keep the process alive solely for a pacing wait.
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  });
}

/** Remaining wait (ms) before this connection's next slot, without reserving it. */
export function getPacingDelayMs(connectionId: string): number {
  const next = _nextAvailableAt.get(connectionId);
  if (next === undefined) return 0;
  return Math.max(0, next - Date.now());
}

/** Drop pacing state for a connection (call on connection delete). */
export function removeConnectionPacing(connectionId: string): void {
  _nextAvailableAt.delete(connectionId);
}
