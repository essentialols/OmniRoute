import test from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import * as SentryCore from "@sentry/core";

/**
 * Proof: no secrets in Sentry reporter output by default.
 *
 * `src/lib/monitoring/sentryServer.ts` never sets `sendDefaultPii`, which
 * defaults to `false`. Two independent things follow from that, and this
 * test checks both:
 *
 * 1. `httpBodies` resolves to `[]` (no request/response bodies collected at
 *    all) — this is the assertion that actually flips red/green if someone
 *    adds `sendDefaultPii: true` to sentryServer.ts.
 * 2. Sensitive HEADERS (Authorization, X-Api-Key, Cookie) are redacted to
 *    "[Filtered]" by `@sentry/core`'s name-based
 *    `_INTERNAL_filterKeyValueData`, while non-sensitive headers
 *    (Content-Type, X-Request-Id) pass through untouched. This holds
 *    regardless of sendDefaultPii — it is included to prove header
 *    protection is real name-based filtering, not merely "collection is
 *    off". (With sendDefaultPii: true, `httpBodies` fills in — see the RED
 *    case below — but header key-filtering does not relax.)
 *
 * Red/green (reproduced manually before writing this test, see task
 * evidence): adding `sendDefaultPii: true` to the real sentryServer.ts
 * makes assertion (1) fail (httpBodies becomes a 4-element array); removing
 * it restores `httpBodies === []`.
 */

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

test("sentryServer's resolved config collects no request/response bodies and redacts sensitive headers by name", async () => {
  process.env.SENTRY_DSN = "https://public@example.invalid/1";
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;

  const { initSentry } = await import("../../src/lib/monitoring/sentryServer.ts");
  initSentry();

  const client = Sentry.getClient();
  assert.ok(client, "expected initSentry() to create a client with a DSN configured");

  const dataCollection = client!.getDataCollectionOptions();

  // (1) The actual red/green lever: httpBodies must stay empty by default.
  assert.deepEqual(
    dataCollection.httpBodies,
    [],
    "httpBodies is not empty — request/response bodies are being collected. " +
      "This is what `sendDefaultPii: true` would do; sentryServer.ts must not set it."
  );

  // (2) Header redaction is name-based, not merely "collection is off".
  const headers = {
    Authorization: "Bearer sekrit-token-value",
    "X-Api-Key": "sk-live-abc123",
    Cookie: "session=abc123",
    "Content-Type": "application/json",
    "X-Request-Id": "req-42",
  };

  const filtered = SentryCore._INTERNAL_filterKeyValueData(headers, dataCollection.httpHeaders.request) as Record<
    string,
    string
  >;

  assert.equal(filtered["Authorization"], "[Filtered]");
  assert.equal(filtered["X-Api-Key"], "[Filtered]");
  assert.equal(filtered["Cookie"], "[Filtered]");
  assert.equal(filtered["Content-Type"], "application/json");
  assert.equal(filtered["X-Request-Id"], "req-42");
});
