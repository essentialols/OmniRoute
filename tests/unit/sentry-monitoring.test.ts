import test from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_ENV = {
  SENTRY_DSN: process.env.SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
};

test.afterEach(() => {
  if (ORIGINAL_ENV.SENTRY_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_ENV.SENTRY_DSN;

  if (ORIGINAL_ENV.NEXT_PUBLIC_SENTRY_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = ORIGINAL_ENV.NEXT_PUBLIC_SENTRY_DSN;
});

test("Sentry monitoring is opt-in via DSN env vars", async () => {
  const { isClientSentryEnabled, isServerSentryEnabled } =
    await import("../../src/lib/monitoring/sentry.ts");

  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  assert.equal(isServerSentryEnabled(), false);
  assert.equal(isClientSentryEnabled(), false);

  process.env.SENTRY_DSN = "https://public@example.invalid/1";
  assert.equal(isServerSentryEnabled(), true);
  assert.equal(isClientSentryEnabled(), false);

  delete process.env.SENTRY_DSN;
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@example.invalid/1";
  assert.equal(isServerSentryEnabled(), true);
  assert.equal(isClientSentryEnabled(), true);
});
