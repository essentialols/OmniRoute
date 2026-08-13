import test from "node:test";
import assert from "node:assert/strict";

// Baseline characterization guard — written on `main` BEFORE merging
// omniroute-setup-audit (3ea4c86b5, "feat(monitoring): add metrics and sentry setup",
// PR #20). That branch adds src/lib/monitoring/prometheus.ts, which collects metrics
// by calling into EXISTING modules and assumes a specific return shape from each:
//   - getTelemetrySummary(windowMs) from shared/utils/requestTelemetry.ts
//       -> reads .count, .p50, .p95, .p99
//   - getAllCircuitBreakerStatuses() from shared/utils/circuitBreaker.ts
//       -> reads .name, .state per entry
// Neither module is touched by the monitoring branch — it only reads them. This test
// does not exercise the new /api/metrics route (that route does not exist on main);
// it pins the CURRENT contract of the two dependencies most load-bearing for it, so
// that if the metrics route ships and either dependency's shape drifts afterward
// (from an unrelated change), the break is attributed correctly instead of blamed on
// the monitoring merge.
const { RequestTelemetry, recordTelemetry, getTelemetrySummary } =
  await import("../../src/shared/utils/requestTelemetry.ts");
const { getCircuitBreaker, getAllCircuitBreakerStatuses, resetAllCircuitBreakers } =
  await import("../../src/shared/utils/circuitBreaker.ts");

test("baseline: getTelemetrySummary returns the {count,p50,p95,p99} numeric shape prometheus.ts expects", () => {
  const t = new RequestTelemetry("monitoring-baseline-probe");
  t.startPhase("parse");
  t.endPhase();
  recordTelemetry(t);

  const summary = getTelemetrySummary(300000);
  assert.equal(typeof summary.count, "number");
  assert.ok(summary.count >= 1, "the just-recorded request must be counted");
  assert.equal(typeof summary.p50, "number");
  assert.equal(typeof summary.p95, "number");
  assert.equal(typeof summary.p99, "number");
});

test("baseline: getTelemetrySummary returns zeroed shape (not undefined/throw) for an empty window", () => {
  // A negative windowMs pushes the cutoff strictly into the future relative to any
  // already-recorded entry, deterministically emptying the "recent" set regardless of
  // process-wide history left by other tests or of ms-resolution timing races (a
  // windowMs of 0 was tried first and was flaky: cutoff === Date.now() can tie with an
  // entry recorded in the same millisecond). Exercises the recent.length === 0 branch
  // prometheus.ts's Gauge.set() calls rely on staying numeric.
  const summary = getTelemetrySummary(-60000);
  assert.deepEqual(
    { count: summary.count, p50: summary.p50, p95: summary.p95, p99: summary.p99 },
    { count: 0, p50: 0, p95: 0, p99: 0 }
  );
});

test("baseline: getAllCircuitBreakerStatuses entries carry .name and .state prometheus.ts labels on", () => {
  resetAllCircuitBreakers();
  getCircuitBreaker("monitoring-baseline-probe-breaker");

  const statuses = getAllCircuitBreakerStatuses();
  const mine = statuses.find((s) => s.name === "monitoring-baseline-probe-breaker");
  assert.ok(mine, "the just-created breaker must appear in getAllCircuitBreakerStatuses()");
  assert.equal(typeof mine.name, "string");
  assert.equal(typeof mine.state, "string");
  assert.ok(
    ["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"].includes(mine.state),
    `state must be one of the four known circuit states, got ${mine.state}`
  );

  resetAllCircuitBreakers();
});
