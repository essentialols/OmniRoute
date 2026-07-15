/**
 * Bug 2 end-to-end: a PASSTHROUGH capture produced by server.cjs must land in
 * `globalTrafficBuffer` and appear in GET /api/tools/traffic-inspector/requests.
 *
 * This drives the exact path server.cjs::passthrough() now uses:
 *   buildIngestEntry(passthrough shape) → POST /internal/ingest → buffer → /requests
 *
 * Before the fix, passthrough() never built or posted such an entry, so the
 * buffer stayed empty (total:0) for e.g. a 401 from chatgpt.com.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ti-pt-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Known token BEFORE importing the route so the module picks it up.
const VALID_TOKEN = "passthrough-capture-token-abc123-longer-than-16";
process.env.INSPECTOR_INTERNAL_INGEST_TOKEN = VALID_TOKEN;

const { globalTrafficBuffer } = await import("../../src/mitm/inspector/buffer.ts");
const ingestRoute =
  await import("../../src/app/api/tools/traffic-inspector/internal/ingest/route.ts");
const requestsRoute = await import("../../src/app/api/tools/traffic-inspector/requests/route.ts");

const requireCjs = createRequire(import.meta.url);
const ingestShim = requireCjs("../../src/mitm/_internal/ingest.cjs") as {
  buildIngestEntry: (opts: Record<string, unknown>) => Record<string, unknown>;
};

test.beforeEach(() => globalTrafficBuffer.clear());
test.after(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

test("passthrough capture (chatgpt.com 401) lands in buffer and shows in /requests", async () => {
  // Exactly what server.cjs::passthrough() builds for a non-intercepted host.
  const entry = ingestShim.buildIngestEntry({
    method: "POST",
    host: "chatgpt.com",
    path: "/backend-api/codex/responses",
    agentId: "codex",
    mappedModel: null,
    status: 401,
    requestHeaders: { "content-type": "application/json" },
    requestBody: '{"model":"gpt-5"}',
    requestSize: 17,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"error":"unauthorized"}',
    responseSize: 24,
    proxyLatencyMs: 3,
    upstreamLatencyMs: 42,
  });

  const ingestRes = await ingestRoute.POST(
    new Request("http://localhost/api/tools/traffic-inspector/internal/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify(entry),
    })
  );
  assert.equal(ingestRes.status, 200, "ingest must accept the passthrough capture");

  // It must be in the process-singleton buffer...
  const buffered = globalTrafficBuffer.get(entry.id as string);
  assert.ok(buffered, "passthrough capture must be in globalTrafficBuffer");
  assert.equal(buffered?.host, "chatgpt.com");
  assert.equal(buffered?.status, 401);

  // ...and visible via the read path used by the Traffic Inspector UI.
  const listRes = await requestsRoute.GET(
    new Request("http://localhost/api/tools/traffic-inspector/requests")
  );
  assert.equal(listRes.status, 200);
  const body = (await listRes.json()) as {
    total: number;
    requests: Array<{ id: string; host: string; status: number | string }>;
  };
  assert.ok(body.total >= 1, "GET /requests must no longer report total:0");
  const found = body.requests.find((r) => r.id === entry.id);
  assert.ok(found, "the passthrough capture must appear in GET /requests");
  assert.equal(found?.host, "chatgpt.com");
});
