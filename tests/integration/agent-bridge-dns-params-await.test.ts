/**
 * Bonus bug: POST /api/tools/agent-bridge/agents/[id]/dns wrote rows to
 * agent_bridge_state with an EMPTY agent_id because it read the Next.js 16
 * dynamic route `params` synchronously (`const { id } = params`) while Next 16
 * passes `params` as a Promise. Destructuring the Promise yields
 * `id === undefined`, so provisionDnsEntries could not map enabled agents to
 * hosts.
 *
 * The route now `await`s params. This test passes params as a Promise (the real
 * Next 16 shape) and asserts the row is written under the correct agent_id.
 *
 * DNS side effect is a no-op here: with `enabled: false` the route calls
 * removeDNSEntry, which silently skips hosts that are not present in /etc/hosts
 * (the antigravity hosts are not present in a clean/test environment), so no
 * sudo is invoked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ab-dns-params-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const dnsRoute = await import("../../src/app/api/tools/agent-bridge/agents/[id]/dns/route.ts");
const { getAgentBridgeState, getAllAgentBridgeStates } =
  await import("../../src/lib/db/agentBridgeState.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => resetDb());
test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function dnsRequest(enabled: boolean): Request {
  return new Request("http://localhost/api/tools/agent-bridge/agents/copilot/dns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

test("dns route resolves id from awaited (Promise) params, not the Promise itself", async () => {
  const res = await dnsRoute.POST(dnsRequest(false), {
    params: Promise.resolve({ id: "copilot" }),
  });
  assert.equal(res.status, 200, "route must succeed");
  const body = (await res.json()) as { ok: boolean; dns_enabled: boolean };
  assert.equal(body.ok, true);

  // The row must exist under the REAL agent id, not an empty string.
  const row = getAgentBridgeState("copilot");
  assert.ok(row, "agent_bridge_state row must be written under agent_id='copilot'");
  assert.equal(row?.agent_id, "copilot");
  assert.equal(row?.dns_enabled, false);

  // And there must be no row written under an empty agent_id.
  const all = getAllAgentBridgeStates();
  assert.ok(
    !all.some((r) => r.agent_id === "" || r.agent_id == null),
    "no agent_bridge_state row may have an empty agent_id"
  );
});

test("dns route rejects an empty id with 400 (guard)", async () => {
  const res = await dnsRoute.POST(dnsRequest(false), {
    params: Promise.resolve({ id: "" }),
  });
  assert.equal(res.status, 400, "empty agent id must be rejected, not written");
  const all = getAllAgentBridgeStates();
  assert.equal(all.length, 0, "no row may be written for an empty id");
});
