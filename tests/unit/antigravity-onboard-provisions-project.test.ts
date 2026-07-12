// Regression guard for the Antigravity "Missing Google projectId" 422 dead account.
//
// A Google account that has never completed Gemini Code Assist onboarding gets an empty
// cloudaicompanionProject from loadCodeAssist. The account can only be provisioned by
// calling onboardUser (free tier), which returns a project id in its long-running-operation
// response envelope. The original postExchange had the guard inverted (`if (projectId)`),
// so it ran onboardUser only when a project already existed and skipped it in exactly the
// case that needed it. Result: the connection was persisted with an empty projectId and
// every request 422'd. The request-time bootstrap did not compensate either (it only ever
// called loadCodeAssist, never onboardUser), so no code path could ever recover the account.
//
// This test proves BOTH paths now provision the project:
//   1. postExchange onboards a project-less account (blocking, bounded).
//   2. ensureAntigravityProjectAssigned onboards a project-less account at request time.
//
// Flip-proof: revert postExchange to `if (projectId)` -> test 1 gets projectId "" -> fails.
// Remove the onboard call from ensureAntigravityProjectAssigned -> test 2 fails.

import test from "node:test";
import assert from "node:assert/strict";
import { antigravity } from "../../src/lib/oauth/providers/antigravity.ts";
import {
  ensureAntigravityProjectAssigned,
  clearAntigravityProjectCache,
} from "../../open-sse/services/antigravityProjectBootstrap.ts";

const originalFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// loadCodeAssist payload for an account that owns no project yet: free-tier is the default
// allowed tier, exactly what Google returns for a never-onboarded consumer account.
const NO_PROJECT_LOAD = {
  allowedTiers: [{ id: "free-tier", name: "Antigravity", isDefault: true }],
  paidTier: { id: "free-tier" },
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAntigravityProjectCache();
});

test("postExchange onboards a project-less account and returns the provisioned project", async () => {
  let onboardCalls = 0;
  const seenTierIds: unknown[] = [];

  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("userinfo")) return jsonRes({ email: "user@example.com" });
    if (u.includes("loadCodeAssist")) return jsonRes(NO_PROJECT_LOAD);
    if (u.includes("onboardUser")) {
      onboardCalls++;
      seenTierIds.push(JSON.parse(String(init?.body ?? "{}")).tier_id);
      // First poll: LRO not done yet. Second poll: done, project provisioned.
      if (onboardCalls === 1) return jsonRes({ done: false });
      return jsonRes({ done: true, response: { cloudaicompanionProject: "evident-result-cj4jh" } });
    }
    return jsonRes({});
  }) as typeof fetch;

  const result = await antigravity.postExchange({ access_token: "tok" } as never);

  assert.equal(
    result.projectId,
    "evident-result-cj4jh",
    "postExchange must provision a project via onboardUser when loadCodeAssist returns none"
  );
  assert.ok(onboardCalls >= 1, "onboardUser must actually be called for a project-less account");
  assert.deepEqual(
    seenTierIds.filter(Boolean),
    seenTierIds.filter(Boolean).map(() => "free-tier"),
    "onboarding must use the free tier only (no billed tier)"
  );
});

test("ensureAntigravityProjectAssigned onboards a project-less account at request time", async () => {
  let onboardCalls = 0;

  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("loadCodeAssist")) return jsonRes(NO_PROJECT_LOAD);
    if (u.includes("onboardUser")) {
      onboardCalls++;
      return jsonRes({ done: true, response: { cloudaicompanionProject: "evident-result-cj4jh" } });
    }
    return jsonRes({});
  }) as typeof fetch;

  const projectId = await ensureAntigravityProjectAssigned("tok-request-time");

  assert.equal(
    projectId,
    "evident-result-cj4jh",
    "request-time bootstrap must self-heal a project-less account via onboardUser"
  );
  assert.ok(onboardCalls >= 1, "bootstrap must call onboardUser when loadCodeAssist returns none");
});

test("postExchange does NOT block on onboarding when loadCodeAssist itself fails", async () => {
  // If loadCodeAssist could not even be reached, we do not know the account has no project,
  // so we must not enter the (bounded but slow) onboarding loop. projectId stays empty and
  // the login returns promptly; the request-time bootstrap will retry later.
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("userinfo")) return jsonRes({ email: "user@example.com" });
    if (u.includes("loadCodeAssist")) return jsonRes({ error: "boom" }, 500);
    if (u.includes("onboardUser")) {
      throw new Error("onboardUser must not be called when loadCodeAssist failed");
    }
    return jsonRes({});
  }) as typeof fetch;

  const start = Date.now();
  const result = await antigravity.postExchange({ access_token: "tok" } as never);
  const elapsed = Date.now() - start;

  assert.equal(result.projectId, "", "no project when loadCodeAssist fails outright");
  assert.ok(elapsed < 5000, `must not enter the onboarding poll loop; took ${elapsed}ms`);
});
