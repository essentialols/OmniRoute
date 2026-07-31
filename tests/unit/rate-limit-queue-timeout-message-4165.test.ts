/**
 * #4165 plus the 2026-07-30 follow-up: the request-queue budget must measure
 * QUEUE WAIT, and the error it raises must read as a local queue drop.
 *
 * #4165 (original): OmniRoute scheduled every rate-limited request through
 * Bottleneck and surfaced its raw `"This job timed out after <N> ms."`, which is
 * indistinguishable from an upstream gateway timeout. An operator spent ~3h
 * misdiagnosing local queue saturation as a provider outage. The message is now
 * rewritten to name `resilienceSettings.requestQueue.maxWaitMs`, disclaim an
 * upstream timeout, and carry `.code = "RATE_LIMIT_QUEUE_TIMEOUT"`.
 *
 * 2026-07-30 follow-up: the budget was implemented as Bottleneck's `expiration`,
 * whose clock starts when the job STARTS EXECUTING. That made `maxWaitMs` a cap
 * on total request runtime rather than on queue wait, so requests that never
 * queued at all were killed mid-generation. Observed against a local 35B model:
 * a prefix-cache hit with essentially zero prefill was dropped at exactly 240s,
 * and any response longer than roughly 5k tokens crossed the budget purely by
 * decoding. The budget is now a timer started at enqueue and cleared the instant
 * the job body begins, so a running request may take as long as it needs.
 *
 * Note these two properties pull in opposite directions, which is why both are
 * pinned here: a job must be dropped for WAITING too long, and must NOT be
 * dropped for RUNNING too long.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-queue-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyQueueSettings(maxWaitMs: number) {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs,
  });
}

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/**
 * Occupy the single concurrency slot with a long job, then submit a second job
 * that has to WAIT for it. Only the second job should be dropped.
 */
async function occupySlotThenQueue(connectionId: string, blockerMs: number) {
  let queuedStarted = false;
  const blocker = rateLimitManager.withRateLimit("openai", connectionId, "gpt-4o", async () => {
    await wait(blockerMs);
    return "blocker-done";
  });
  // Let the blocker actually take the slot before the second job enqueues.
  await wait(20);

  let queuedSignal: AbortSignal | undefined;
  const queued = rateLimitManager.withRateLimit(
    "openai",
    connectionId,
    "gpt-4o",
    async (signal?: AbortSignal) => {
      queuedSignal = signal;
      queuedStarted = true;
      return "should-not-reach";
    }
  );

  return { blocker, queued, getQueuedSignal: () => queuedSignal, didStart: () => queuedStarted };
}

test("a job dropped for waiting too long surfaces a clear OmniRoute error, not an upstream-looking string", async () => {
  await applyQueueSettings(60);
  rateLimitManager.enableRateLimitProtection("conn-queue-wait");

  const { blocker, queued } = await occupySlotThenQueue("conn-queue-wait", 600);

  let caught: (Error & { code?: string }) | undefined;
  try {
    await queued;
    assert.fail("expected the queued job to be dropped for waiting too long");
  } catch (err) {
    caught = err as Error & { code?: string };
  }
  assert.ok(caught, "an error should have been thrown");

  // Tagged so combo / callers can classify it as a local queue drop.
  assert.equal(caught.code, "RATE_LIMIT_QUEUE_TIMEOUT", "error must carry the queue-timeout code");

  // The surfaced message must read as a local queue limit, naming the knob, and
  // must not masquerade as an upstream gateway error.
  assert.match(caught.message, /maxWaitMs/, "message should name the maxWaitMs knob");
  assert.match(
    caught.message,
    /not an upstream/i,
    "message should explicitly disclaim an upstream timeout"
  );
  assert.doesNotMatch(
    caught.message,
    /This job timed out/,
    "raw Bottleneck/upstream-looking string must not leak into the surfaced message"
  );

  await blocker;
});

test("a job dropped for waiting too long aborts its job signal instead of orphaning it", async () => {
  await applyQueueSettings(60);
  rateLimitManager.enableRateLimitProtection("conn-queue-abort");

  const { blocker, queued, getQueuedSignal, didStart } = await occupySlotThenQueue(
    "conn-queue-abort",
    600
  );

  await assert.rejects(queued, /maxWaitMs/);

  // The dropped job must be told to stop, otherwise it can still fire upstream
  // (and burn provider quota) after the client already got its error.
  const signal = getQueuedSignal();
  if (signal) {
    assert.equal(signal.aborted, true, "dropped job signal must be aborted");
    assert.equal(
      (signal.reason as { code?: string } | undefined)?.code,
      "RATE_LIMIT_QUEUE_TIMEOUT",
      "abort reason should be the queue-timeout error"
    );
  } else {
    // Preferred outcome: the job never got a slot at all, so its body never ran.
    assert.equal(didStart(), false, "a dropped job must not have started executing");
  }

  await blocker;
});

test("REGRESSION: a job that RUNS longer than maxWaitMs is NOT dropped (maxWaitMs is queue wait, not runtime)", async () => {
  // This is the 2026-07-30 bug. With `expiration: maxWaitMs` this job was killed
  // at 60ms even though it never waited for a slot. It must now run to completion.
  await applyQueueSettings(60);
  rateLimitManager.enableRateLimitProtection("conn-long-running");

  let jobSignal: AbortSignal | undefined;
  const result = await rateLimitManager.withRateLimit(
    "openai",
    "conn-long-running",
    "gpt-4o",
    async (signal?: AbortSignal) => {
      jobSignal = signal;
      await wait(400); // 6.6x maxWaitMs, but zero queue wait
      return "completed";
    }
  );

  assert.equal(result, "completed", "a long-running but never-queued job must not be dropped");
  assert.equal(
    jobSignal?.aborted ?? false,
    false,
    "a job that ran long must not have been aborted by the queue budget"
  );
});

test("REGRESSION: the queue budget does not fire after a job has started, even on a slow job behind a blocker", async () => {
  // A job may wait a little, get its slot in time, then run well past maxWaitMs.
  // Clearing the timer at dispatch is what makes this safe.
  await applyQueueSettings(300);
  rateLimitManager.enableRateLimitProtection("conn-wait-then-run");

  const blocker = rateLimitManager.withRateLimit(
    "openai",
    "conn-wait-then-run",
    "gpt-4o",
    async () => {
      await wait(100);
      return "blocker-done";
    }
  );
  await wait(20);

  const queued = rateLimitManager.withRateLimit(
    "openai",
    "conn-wait-then-run",
    "gpt-4o",
    async () => {
      await wait(600); // starts within the budget, then runs far past it
      return "completed";
    }
  );

  assert.equal(await blocker, "blocker-done");
  assert.equal(
    await queued,
    "completed",
    "a job that got its slot in time must be allowed to run past maxWaitMs"
  );
});

test("a caller abort also cancels the in-flight job", async () => {
  await applyQueueSettings(5000);
  rateLimitManager.enableRateLimitProtection("conn-caller-abort");

  const controller = new AbortController();
  let jobSignal: AbortSignal | undefined;
  const promise = rateLimitManager.withRateLimit(
    "openai",
    "conn-caller-abort",
    "gpt-4o",
    async (signal?: AbortSignal) => {
      jobSignal = signal;
      await wait(400);
      return "should-not-reach";
    },
    controller.signal
  );

  await wait(50);
  controller.abort();
  await assert.rejects(promise, (err: Error) => err.name === "AbortError");
  assert.equal(jobSignal?.aborted, true, "caller abort must reach the running job");
});

test("a job that completes within maxWaitMs is unaffected", async () => {
  await applyQueueSettings(5000);
  rateLimitManager.enableRateLimitProtection("conn-fast");

  const result = await rateLimitManager.withRateLimit(
    "openai",
    "conn-fast",
    "gpt-4o",
    async () => "ok"
  );
  assert.equal(result, "ok");
});
