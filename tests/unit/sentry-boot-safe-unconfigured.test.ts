import test from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";

/**
 * Proof: the gateway boots safely with Sentry monitoring unconfigured.
 *
 * The meaningful assertion is NOT "initSentry() does not throw" — it never
 * throws either way. The meaningful assertion is that `Sentry.getClient()`
 * stays `undefined` with no SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN set.
 *
 * Critical subtlety: `Sentry.init({ dsn: undefined })` does NOT throw and DOES
 * create a client anyway — the SDK is fail-open by design (see the raw-SDK
 * control case below). What actually protects the gateway from running an
 * unconfigured Sentry client is the repo's own
 * `if (!isServerSentryEnabled()) return;` guard in
 * `src/lib/monitoring/sentryServer.ts`. This test exists to catch a
 * regression where that guard is removed or bypassed, which the SDK itself
 * will not catch.
 */

const ORIGINAL_ENV = {
  SENTRY_DSN: process.env.SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
};

function restoreEnv() {
  if (ORIGINAL_ENV.SENTRY_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_ENV.SENTRY_DSN;

  if (ORIGINAL_ENV.NEXT_PUBLIC_SENTRY_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = ORIGINAL_ENV.NEXT_PUBLIC_SENTRY_DSN;
}

test.afterEach(() => {
  restoreEnv();
  // Sentry's current client is a process-wide singleton (via the global
  // scope), not scoped per-test. Reset it so one test's Sentry.init() call
  // cannot leak a live client into the next test's getClient() assertion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- clearing the singleton client between tests
  Sentry.setCurrentClient(undefined as any);
});

test("control: the raw Sentry SDK is fail-open — Sentry.init({dsn: undefined}) creates a client anyway", async () => {
  // This is NOT the gateway's behavior; it demonstrates why the guard in
  // sentryServer.ts is load-bearing rather than redundant. Sentry.init()
  // itself does not refuse to run without a DSN.
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;

  assert.equal(Sentry.getClient(), undefined);

  Sentry.init({ dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN });

  const client = Sentry.getClient();
  assert.ok(client, "Sentry.init({dsn: undefined}) unexpectedly refused to create a client");
  assert.equal(client?.constructor?.name, "NodeClient");
});

test("initSentry() leaves Sentry.getClient() undefined when no DSN is configured", async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;

  // Re-import so the module graph is fresh for this env state; Sentry.init
  // itself is idempotent per-process but we want a clean assertion point.
  const { initSentry } = await import("../../src/lib/monitoring/sentryServer.ts");

  initSentry();

  assert.equal(
    Sentry.getClient(),
    undefined,
    "initSentry() created a Sentry client with no DSN configured — the " +
      "isServerSentryEnabled() guard in sentryServer.ts is the only thing " +
      "preventing this (the SDK itself is fail-open); check it has not been " +
      "removed or short-circuited."
  );
});
