import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Hydrating the quota cache from `quota_snapshots` must not invent exhaustion.
 *
 * Observed 2026-07-31 on the `antigravity` provider: every request was rejected with
 * "All antigravity accounts have exhausted their quota (reset after 23h 4m 38s)" while
 * the SAME two Google accounts served through the sibling provider id `agy` returned
 * 200. Both antigravity connection rows carried one snapshot row for the retired
 * window `gemini-3-pro-preview` (0% remaining, `next_reset_at` NULL, last written
 * 2026-07-30T12:44Z); the `agy` rows had never observed that window.
 *
 * Two hydration defects combined:
 *   1. `exhausted` was reduced with OR over the per-window `is_exhausted` flags (#5923
 *      made those flags per-window), while the live path (`setQuotaCache` ->
 *      `isExhausted`) means "EVERY window is at 0%". One stale window therefore
 *      blocked every model on the connection.
 *   2. `nextResetAt` was borrowed from the earliest reset across ALL windows — a
 *      HEALTHY daily window 23h out — so neither escape hatch in
 *      `isAccountQuotaExhausted` (the EXHAUSTED_TTL_MS expiry, which requires
 *      `!nextResetAt`, and the auto-advance, which requires a past reset) could clear
 *      the verdict. It survived until a live refetch, i.e. every restart re-poisoned it.
 *
 * Snapshots are only written on change (#4438), so a window the provider stopped
 * reporting keeps its last row forever: the poison never expires by itself.
 */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-hydrate-retired-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const HOUR_MS = 60 * 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoAhead(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Persist a snapshot row and backdate its `created_at` (saveQuotaSnapshot stamps now). */
function saveSnapshotAt(
  row: {
    provider: string;
    connection_id: string;
    window_key: string;
    remaining_percentage: number;
    is_exhausted: number;
    next_reset_at: string | null;
  },
  createdAt: string
): void {
  quotaSnapshotsDb.saveQuotaSnapshot({
    ...row,
    window_duration_ms: null,
    raw_data: null,
  });
  const db = coreDb.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
  };
  db.prepare(
    `UPDATE quota_snapshots SET created_at = ?
     WHERE id = (SELECT MAX(id) FROM quota_snapshots WHERE connection_id = ? AND window_key = ?)`
  ).run(createdAt, row.connection_id, row.window_key);
}

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("a retired 0% window does not make a healthy connection look exhausted", () => {
  const connectionId = "conn-antigravity-retired-window";
  quotaCache.__clearForTests();

  // The window the provider stopped reporting: 0%, no reset time, last seen 14h ago.
  saveSnapshotAt(
    {
      provider: "antigravity",
      connection_id: connectionId,
      window_key: "gemini-3-pro-preview",
      remaining_percentage: 0,
      is_exhausted: 1,
      next_reset_at: null,
    },
    isoAgo(14 * HOUR_MS)
  );

  // Windows the provider still reports: full quota, daily reset ~23h out.
  for (const windowKey of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.5-flash-medium"]) {
    saveSnapshotAt(
      {
        provider: "antigravity",
        connection_id: connectionId,
        window_key: windowKey,
        remaining_percentage: 100,
        is_exhausted: 0,
        next_reset_at: isoAhead(23 * HOUR_MS),
      },
      isoAgo(55 * 60 * 1000)
    );
  }

  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    false,
    "one stale 0% window must not mark the whole connection exhausted"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "antigravity", "gemini-3.5-flash-medium"),
    false,
    "the requested model's window has 100% quota — the request must not be rejected"
  );

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry, "the connection must still hydrate an entry");
  assert.equal(entry?.exhausted, false);
  assert.equal(
    entry?.nextResetAt,
    null,
    "a non-exhausted entry must not carry a borrowed reset time"
  );
  assert.equal(
    Object.hasOwn(entry?.quotas ?? {}, "gemini-3-pro-preview"),
    false,
    "the stale, unverifiable exhaustion claim must be dropped, not just outvoted"
  );
});

test("a connection whose windows are all at 0% still hydrates as exhausted", () => {
  const connectionId = "conn-antigravity-really-exhausted";
  quotaCache.__clearForTests();

  const resetAt = isoAhead(2 * HOUR_MS);
  for (const windowKey of ["gemini-2.5-flash", "gemini-2.5-pro"]) {
    saveSnapshotAt(
      {
        provider: "antigravity",
        connection_id: connectionId,
        window_key: windowKey,
        remaining_percentage: 0,
        is_exhausted: 1,
        next_reset_at: resetAt,
      },
      isoAgo(10 * 60 * 1000)
    );
  }

  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "real exhaustion (every window at 0%) must still survive a restart"
  );
  assert.equal(
    quotaCache.getQuotaCache(connectionId)?.nextResetAt,
    resetAt,
    "the reset time must come from the exhausted windows"
  );
});

test("a fresh 0% window with no reset time is still trusted within the TTL", () => {
  const connectionId = "conn-antigravity-fresh-429";
  quotaCache.__clearForTests();

  saveSnapshotAt(
    {
      provider: "antigravity",
      connection_id: connectionId,
      window_key: "gemini-2.5-flash",
      remaining_percentage: 0,
      is_exhausted: 1,
      next_reset_at: null,
    },
    isoAgo(60 * 1000)
  );

  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "a just-observed 0% window must still hydrate as exhausted (#5015)"
  );
});
