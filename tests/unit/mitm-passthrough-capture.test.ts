/**
 * Bug 2 regression: the AgentBridge MITM proxy (server.cjs) must record
 * PASSTHROUGH (non-intercepted) traffic in the Traffic Inspector, not only
 * intercepted antigravity chat requests.
 *
 * Root cause: `captureToInspector()` was only ever called from `intercept()`.
 * Every host that is not an antigravity `:generateContent` chat request
 * (chatgpt.com/codex, copilot, cursor, non-chat antigravity, unmapped models)
 * flows through `passthrough()` instead, which never captured. So a real
 * round-trip (e.g. a 401 from chatgpt.com) never appeared in /requests.
 *
 * server.cjs cannot be `require()`d in tests (it binds a TLS server and
 * process.exit()s when ROUTER_API_KEY is missing), so the call-site guard is a
 * source-level assertion (the repo's established pattern for server.cjs, see
 * mitm-server-connect.test.ts). The capture payload builder is exercised
 * directly via the `_internal/ingest.cjs` shim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(here, "../../src/mitm/server.cjs"), "utf-8");

// Isolate the passthrough() function body so the assertions target the right
// call site (not intercept()).
function passthroughBody(src: string): string {
  const start = src.indexOf("async function passthrough(");
  assert.ok(start >= 0, "server.cjs must define passthrough()");
  const nextFn = src.indexOf("\nfunction ", start + 1);
  const nextAsyncFn = src.indexOf("\nasync function ", start + 1);
  const ends = [nextFn, nextAsyncFn].filter((n) => n > start);
  const end = ends.length ? Math.min(...ends) : src.length;
  return src.slice(start, end);
}

test("passthrough() captures to the inspector (bug 2 call-site guard)", () => {
  const body = passthroughBody(serverSrc);
  assert.match(
    body,
    /captureToInspector\(/,
    "passthrough() must call captureToInspector() so non-intercepted traffic is recorded"
  );
  // The response must be teed so the captured copy does not disturb streaming.
  assert.match(body, /forwardRes\.on\("data"/, "passthrough() must tee the response body");
  assert.match(body, /forwardRes\.on\("end"/, "passthrough() must fire capture on response end");
});

test("passthrough() accepts a capture flag and the self-loop opts OUT", () => {
  assert.match(
    serverSrc,
    /async function passthrough\(req, res, bodyBuffer, capture/,
    "passthrough() must accept a capture flag"
  );
  // The OmniRoute self-loop passthrough must pass capture=false (internal
  // traffic, not client traffic).
  assert.match(
    serverSrc,
    /passthrough\(req, res, bodyBuffer, false\)/,
    "the x-omniroute-source self-loop must skip capture"
  );
});

// ── Executable: the capture payload builder handles passthrough shape ────────

const requireCjs = createRequire(import.meta.url);
const ingestShim = requireCjs("../../src/mitm/_internal/ingest.cjs") as {
  buildIngestEntry: (opts: Record<string, unknown>) => Record<string, unknown>;
  postIngestEntry: (
    baseUrl: string,
    token: string,
    entry: unknown,
    fetchImpl?: (u: string, init: unknown) => Promise<{ ok: boolean; status: number }>
  ) => Promise<boolean>;
};

test("buildIngestEntry: passthrough shape (real upstream status, no model map)", () => {
  const entry = ingestShim.buildIngestEntry({
    method: "POST",
    host: "chatgpt.com",
    path: "/backend-api/codex/responses",
    agentId: "codex",
    // passthrough has no alias mapping
    mappedModel: null,
    status: 401,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"error":"unauthorized"}',
    responseSize: 24,
  });
  assert.equal(entry.source, "agent-bridge");
  assert.equal(entry.host, "chatgpt.com");
  assert.equal(entry.status, 401);
  assert.equal(entry.agent, "codex");
  assert.ok(!("mappedModel" in entry), "passthrough entry must omit mappedModel");
});

test("postIngestEntry: posts with Bearer token, true on 2xx / false on non-2xx", async () => {
  const seen: { url?: string; auth?: string } = {};
  const ok = await ingestShim.postIngestEntry(
    "http://localhost:20128",
    "tok-123",
    { id: "x" },
    async (u, init) => {
      seen.url = u;
      seen.auth = (init as { headers: Record<string, string> }).headers.Authorization;
      return { ok: true, status: 200 };
    }
  );
  assert.equal(ok, true);
  assert.match(seen.url ?? "", /\/api\/tools\/traffic-inspector\/internal\/ingest$/);
  assert.equal(seen.auth, "Bearer tok-123");

  const bad = await ingestShim.postIngestEntry(
    "http://localhost:20128",
    "tok-123",
    { id: "x" },
    async () => ({ ok: false, status: 403 })
  );
  assert.equal(bad, false, "a 403 (bad token) must report failure");
});
