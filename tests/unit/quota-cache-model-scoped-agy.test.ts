import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Model scoping in `isQuotaExhaustedForRequest` must not be codex-only.
 *
 * Observed 2026-08-10 on the `agy` provider (Antigravity OAuth, 2 Google accounts):
 * the `gemini-3.x` windows sat at 0% on a shared 7-day pool (reset 2026-08-14T02:07Z)
 * while `gemini-2.5-flash` / `gemini-2.5-pro` / `claude-sonnet-4-6` were at 100% on
 * their own daily/weekly buckets. Every one of those healthy models was refused with
 * "All agy accounts have exhausted their quota (reset after 82h)" because
 * `isQuotaExhaustedForRequest` short-circuited to `true` for every provider except
 * codex once the account-wide flag was set.
 *
 * The account-wide flag itself (`isExhausted` = AND across all windows, mirrored by
 * `hydrateQuotaCacheFromSnapshots`) is deliberately NOT changed here — reducing the
 * per-window flags with OR is what caused #5923/#4438. The model scope is a per-request
 * check layered on top, so it can only relax the aggregate, never tighten it.
 */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-model-scope-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const HOUR_MS = 60 * 60 * 1000;

function isoAhead(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("agy: an exhausted account still serves a model whose own window has quota", () => {
  const connectionId = "conn-agy-mixed-windows";
  quotaCache.__clearForTests();

  quotaCache.setQuotaCache(connectionId, "agy", {
    // The shared gemini-3.x 7-day pool, burned to 0%.
    "gemini-3.5-flash-medium": { remainingPercentage: 0, resetAt: isoAhead(82 * HOUR_MS) },
    "gemini-3-pro-high": { remainingPercentage: 0, resetAt: isoAhead(82 * HOUR_MS) },
    // Separate daily / weekly buckets, untouched.
    "gemini-2.5-flash": { remainingPercentage: 100, resetAt: isoAhead(11 * HOUR_MS) },
    "gemini-2.5-pro": { remainingPercentage: 100, resetAt: isoAhead(11 * HOUR_MS) },
    "claude-sonnet-4-6": { remainingPercentage: 100, resetAt: isoAhead(5 * 24 * HOUR_MS) },
  });

  // Force the account-wide verdict on. A live `setQuotaCache` cannot produce it from
  // mixed windows (that is the #5923 AND semantics, which stay untouched), but a 429
  // mark or a stale aggregate can — and that is precisely the state the per-request
  // model scope has to survive.
  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry, "the connection must be cached");
  entry!.exhausted = true;
  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "precondition: the account-wide flag is set"
  );

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "gemini-3.5-flash-medium"),
    true,
    "the requested model's own window is at 0% — the request must still be refused"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "gemini-2.5-flash"),
    false,
    "gemini-2.5-flash has its own window at 100% — it must NOT be refused"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "claude-sonnet-4-6"),
    false,
    "claude-sonnet-4-6 has its own weekly window at 100% — it must NOT be refused"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", null),
    true,
    "with no requested model there is nothing to scope to — the account verdict stands"
  );
});

test("agy: a model with no cached window is not refused on missing evidence", () => {
  const connectionId = "conn-agy-window-subset";
  quotaCache.__clearForTests();

  // The upstream usage fetch returned only the burned gemini-3.x buckets this tick,
  // so `isExhausted` (AND across the windows we actually have) is genuinely true.
  quotaCache.setQuotaCache(connectionId, "agy", {
    "gemini-3.5-flash-medium": { remainingPercentage: 0, resetAt: isoAhead(82 * HOUR_MS) },
    "gemini-3-pro-high": { remainingPercentage: 0, resetAt: isoAhead(82 * HOUR_MS) },
  });

  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "precondition: every window we know about is at 0%"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "gemini-3.5-flash-medium"),
    true,
    "a model whose window IS cached at 0% must stay refused"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "gemini-2.5-flash-lite"),
    false,
    "an absent window is missing evidence, not evidence of exhaustion — fail open"
  );
});

test("antigravity: the same scoping applies to the sibling provider id", () => {
  const connectionId = "conn-antigravity-mixed-windows";
  quotaCache.__clearForTests();

  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-3-pro-high": { remainingPercentage: 0, resetAt: isoAhead(82 * HOUR_MS) },
    "gpt-oss-120b-medium": { remainingPercentage: 100, resetAt: isoAhead(5 * 24 * HOUR_MS) },
  });

  const entry = quotaCache.getQuotaCache(connectionId);
  entry!.exhausted = true;

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "antigravity", "gemini-3-pro-high"),
    true
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "antigravity", "gpt-oss-120b-medium"),
    false
  );
});

test("providers without per-model windows keep the account-wide verdict", () => {
  const connectionId = "conn-generic-provider";
  quotaCache.__clearForTests();

  quotaCache.setQuotaCache(connectionId, "kimi-coding", {
    "session (5h)": { remainingPercentage: 0, resetAt: isoAhead(2 * HOUR_MS) },
    "weekly (7d)": { remainingPercentage: 0, resetAt: isoAhead(3 * 24 * HOUR_MS) },
  });

  assert.equal(quotaCache.isAccountQuotaExhausted(connectionId), true);
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "kimi-coding", "kimi-k2-thinking"),
    true,
    "an unregistered provider must behave exactly as before the model scoping"
  );
});

test("a 429-marked account with no window data stays refused for every model", () => {
  const connectionId = "conn-agy-429-no-windows";
  quotaCache.__clearForTests();

  quotaCache.markAccountExhaustedFrom429(connectionId, "agy");

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "agy", "gemini-2.5-flash"),
    true,
    "no cached windows means nothing to scope to — the 429 cooldown must hold"
  );
});
