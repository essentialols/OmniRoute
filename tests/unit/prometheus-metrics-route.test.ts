import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../src/app/api/metrics/route.ts";
import { RequestTelemetry, recordTelemetry } from "../../src/shared/utils/requestTelemetry.ts";

test("metrics route exports Prometheus text for authenticated local requests", async () => {
  const telemetry = new RequestTelemetry("metrics-route");
  telemetry.startPhase("parse");
  telemetry.endPhase();
  recordTelemetry(telemetry);

  const response = await GET(new Request("http://localhost:20128/api/metrics"));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/plain/);
  assert.match(body, /# HELP omniroute_requests_recent_total/);
  assert.match(body, /omniroute_requests_recent_total(?:\{[^}]*\})? \d+/);
  assert.match(body, /# HELP omniroute_request_latency_ms/);
});
