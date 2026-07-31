import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";

import { ANTIGRAVITY_TARGET } from "../../src/mitm/targets/antigravity.ts";

// #6494 (adapted): AgentBridge's MITM proxy terminates TLS locally for all 4
// antigravity/cloudcode hosts. The ORIGINAL bug was that a single static leaf
// cert only carried a SAN for the first host, so the other 3 served a
// mismatching cert. The Bug-1 cert rework supersedes the static-SAN workaround:
// `server.key`/`server.crt` is now a ROOT CA and `server.cjs` mints a per-host
// leaf (signed by the CA) at TLS-handshake time keyed on the SNI (see
// `_internal/dynamicCert.cjs`). So the #6494 guarantee ("every antigravity host
// gets a cert whose SAN matches") is now verified at the per-host-LEAF layer,
// not on the static file. This test was adapted from asserting `generateCert()`
// SANs (which now emits a CA with no host SANs) to asserting each per-host leaf.
const EXPECTED_HOSTS = ANTIGRAVITY_TARGET.hosts;

const requireCjs = createRequire(import.meta.url);
const certShim = requireCjs("../../src/mitm/_internal/dynamicCert.cjs") as {
  generateCaPems: (name?: string, years?: number) => Promise<{ key: string; cert: string }>;
  issueLeafPems: (
    hostname: string,
    ca: { key: string; cert: string },
    years?: number
  ) => Promise<{ key: string; cert: string }>;
};

test("ANTIGRAVITY_TARGET.hosts covers all 4 known antigravity/cloudcode-pa hosts", () => {
  assert.deepEqual(
    [...EXPECTED_HOSTS].sort(),
    [
      "autopush-cloudcode-pa.sandbox.googleapis.com",
      "cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.sandbox.googleapis.com",
    ].sort()
  );
});

test("per-host leaf minted for each antigravity host carries a matching SAN", async () => {
  const ca = await certShim.generateCaPems();

  for (const host of EXPECTED_HOSTS) {
    const leaf = await certShim.issueLeafPems(host, ca);
    const cert = new X509Certificate(leaf.cert);
    const san = cert.subjectAltName ?? "";
    assert.ok(san.includes(host), `expected per-host leaf SAN to include "${host}" - got: ${san}`);
    assert.match(cert.subject, new RegExp(`CN=${host.replace(/\./g, "\\.")}`));
  }
});
