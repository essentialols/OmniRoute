import test from "node:test";
import assert from "node:assert/strict";

// Regression: management routes (e.g. /api/providers) authenticate via
// requireManagementAuth WITHOUT running the full authz pipeline, so
// AUTHZ_HEADER_PEER_LOCALITY is never stamped for them. cliTokenAuth must still
// authorize a loopback CLI call by resolving locality from the token-protected
// PEER_IP_HEADER the custom server stamps (the same trusted signal management.ts
// uses). Previously locality fell through to "remote" and the CLI got a 401 /
// Touch ID prompt for a legitimate local management call.

const STAMP = "unit-peer-stamp-token";
const ORIGINAL_STAMP = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
const ORIGINAL_DISABLE = process.env.OMNIROUTE_DISABLE_CLI_TOKEN;

delete process.env.OMNIROUTE_DISABLE_CLI_TOKEN;

const { isCliTokenAuthValid } = await import("@/lib/middleware/cliTokenAuth");
const { getMachineTokenSync } = await import("@/lib/machineToken");

const MACHINE_TOKEN = getMachineTokenSync();

function req(headers: Record<string, string>) {
  return new Request("http://127.0.0.1:20128/api/providers", { headers });
}

test.after(() => {
  if (ORIGINAL_STAMP === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = ORIGINAL_STAMP;
  if (ORIGINAL_DISABLE === undefined) delete process.env.OMNIROUTE_DISABLE_CLI_TOKEN;
  else process.env.OMNIROUTE_DISABLE_CLI_TOKEN = ORIGINAL_DISABLE;
});

test("loopback CLI token is authorized via the stamped PEER_IP_HEADER (no pipeline)", async (t) => {
  if (!MACHINE_TOKEN) {
    t.skip("node-machine-id unavailable in this environment");
    return;
  }
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;
  const ok = await isCliTokenAuthValid(
    req({
      "x-omniroute-cli-token": MACHINE_TOKEN,
      "x-omniroute-peer-ip": `${STAMP}|127.0.0.1`,
      "x-omniroute-via-proxy": `${STAMP}|0`,
    })
  );
  assert.equal(ok, true);
});

test("a forged/mismatched stamp token is not trusted as loopback", async () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;
  const ok = await isCliTokenAuthValid(
    req({
      "x-omniroute-cli-token": MACHINE_TOKEN || "x".repeat(64),
      // Attacker guesses the header name but not this process's stamp token.
      "x-omniroute-peer-ip": `wrong-token|127.0.0.1`,
      "x-omniroute-via-proxy": `wrong-token|0`,
    })
  );
  assert.equal(ok, false);
});

test("a stamped loopback socket behind a reverse proxy is downgraded to remote", async () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;
  const ok = await isCliTokenAuthValid(
    req({
      "x-omniroute-cli-token": MACHINE_TOKEN || "x".repeat(64),
      "x-omniroute-peer-ip": `${STAMP}|127.0.0.1`,
      // via-proxy marker = 1 → the loopback socket is the proxy hop, not local.
      "x-omniroute-via-proxy": `${STAMP}|1`,
    })
  );
  assert.equal(ok, false);
});

test("a forwarded request is never treated as a local CLI call", async () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;
  const ok = await isCliTokenAuthValid(
    req({
      "x-omniroute-cli-token": MACHINE_TOKEN || "x".repeat(64),
      "x-forwarded-for": "203.0.113.7",
      "x-omniroute-peer-ip": `${STAMP}|127.0.0.1`,
      "x-omniroute-via-proxy": `${STAMP}|0`,
    })
  );
  assert.equal(ok, false);
});
