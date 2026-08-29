import test from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import { buildErrorBody } from "../../open-sse/utils/error.ts";

/**
 * CHARACTERIZATION TEST — documents a known, accepted gap. Does NOT assert
 * desired behavior, and this gap should not be "fixed" by changing this
 * test's expectations without a deliberate follow-up change to
 * sentryServer.ts (e.g. a `beforeSend` scrubber), which is out of scope here.
 *
 * Once a DSN IS configured, Sentry's global `uncaughtException` /
 * `unhandledRejection` handlers (and any direct `Sentry.captureException`
 * call) forward the raw `Error` object, including its raw `.message` text
 * and stack frames, straight to Sentry's transport. That path is completely
 * separate from `buildErrorBody()` / `sanitizeErrorMessage()`, which only
 * guard HTTP responses this app constructs and sends to API clients.
 *
 * Concretely: `sanitizeErrorMessage()` strips absolute file paths (and
 * everything after the first newline, e.g. stack traces) from a message
 * before it reaches an HTTP response body. Sentry's raw capture path does
 * no such stripping — the full message, including any absolute path or
 * embedded secret-looking text a caller put in `Error.message`, reaches the
 * configured Sentry transport untouched. Sentry's own redaction
 * (`_INTERNAL_filterKeyValueData`, see sentry-no-secrets-by-default.test.ts)
 * is name-based over structured header/cookie/query-param objects; it does
 * not inspect or scrub free-text error messages.
 */

test("known gap: raw Error.message/stack reaches the Sentry transport unredacted, unlike buildErrorBody()", async () => {
  const secretMessage = "boom while loading /Users/ingmar/secret-project/config.ts:99";

  let capturedEnvelope: unknown;
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    transport: () => ({
      send: (envelope: unknown) => {
        capturedEnvelope = envelope;
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });

  Sentry.captureException(new Error(secretMessage));
  await Sentry.flush(2000);

  const rawEnvelope = JSON.stringify(capturedEnvelope);

  // This assertion documents the GAP: the absolute path (which the app's own
  // sanitizer strips before it ever reaches an HTTP response) is present,
  // untouched, in what actually gets sent to Sentry.
  assert.ok(
    rawEnvelope.includes("/Users/ingmar/secret-project/config.ts"),
    "expected the known gap to reproduce: raw absolute path present in the " +
      "captured Sentry envelope. If this now fails, either a beforeSend " +
      "scrubber was added (great — update/remove this characterization " +
      "test deliberately) or something else changed; do not silently relax " +
      "this assertion."
  );

  // Contrast: the app's own response-body path DOES strip it.
  const body = buildErrorBody(500, secretMessage);
  assert.equal(body.error.message, "boom while loading <path>");
  assert.ok(!body.error.message.includes("/Users/ingmar/secret-project"));
});
