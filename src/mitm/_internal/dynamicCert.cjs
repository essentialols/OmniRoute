"use strict";

// =========================================================================
// Per-SNI dynamic certificate store (CJS) — consumed by the standalone
// `server.cjs` proxy, which cannot import the TypeScript ESM
// `src/mitm/tproxy/dynamicCert.ts`.
//
// This is the CommonJS mirror of `tproxy/dynamicCert.ts`. Bug fix: the
// AgentBridge DNS-spoof proxy used to serve ONE static leaf certificate
// (CN=daily-cloudcode-pa.googleapis.com) for EVERY SNI, so only that single
// host validated on real TLS clients — chatgpt.com, api.anthropic.com, etc.
// all failed with a hostname mismatch. The correct design (already used by
// the TPROXY capture mode) is a local ROOT CA that mints a per-host leaf,
// signed by the CA, at TLS-handshake time keyed on the SNI (cached per host).
//
// Built on `selfsigned` (already a dependency; v5 supports CA-signing via
// `options.ca`). The CA cert is what the operator installs/trusts; every
// issued leaf then chains to it. The CA private key never leaves the machine.
// =========================================================================

const tls = require("node:tls");
const selfsigned = require("selfsigned");

const DEFAULT_CA_NAME = "OmniRoute MITM Root CA";

/**
 * Generate a long-lived local ROOT CA (basicConstraints CA:TRUE, keyCertSign).
 * Mirrors `generateMitmCa()` in tproxy/dynamicCert.ts. Returns PEM strings.
 */
async function generateCaPems(name, years) {
  const caName = typeof name === "string" && name ? name : DEFAULT_CA_NAME;
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + (Number.isFinite(years) ? years : 10));
  const pems = await selfsigned.generate([{ name: "commonName", value: caName }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

/**
 * Issue a leaf certificate for `hostname`, signed by `ca` ({ key, cert } PEM).
 * Mirrors `issueLeafCert()` in tproxy/dynamicCert.ts. Returns the leaf key plus
 * a cert bundle (leaf + CA) so clients can build the trust path.
 */
async function issueLeafPems(hostname, ca, years) {
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + (Number.isFinite(years) ? years : 1));
  const pems = await selfsigned.generate([{ name: "commonName", value: hostname }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: hostname }] }],
    ca: { key: ca.key, cert: ca.cert },
  });
  return { key: pems.private, cert: `${pems.cert.trim()}\n${ca.cert.trim()}\n` };
}

/**
 * Create a per-SNI certificate store backed by a fixed CA. Lazily issues and
 * caches one `tls.SecureContext` per SNI host. Mirrors `DynamicCertStore`.
 *
 * @param {{ key: string, cert: string }} ca — the ROOT CA PEM pair.
 */
function createCertStore(ca) {
  if (!ca || typeof ca.key !== "string" || typeof ca.cert !== "string") {
    throw new Error("createCertStore requires a CA { key, cert } PEM pair");
  }
  const contexts = new Map();

  async function getSecureContext(hostname) {
    const host = String(hostname || "").toLowerCase() || "localhost";
    const cached = contexts.get(host);
    if (cached) return cached;
    const leaf = await issueLeafPems(host, ca);
    const ctx = tls.createSecureContext({ key: leaf.key, cert: leaf.cert });
    contexts.set(host, ctx);
    return ctx;
  }

  // Node's SNICallback signature: (servername, cb) => void. Async issuance is
  // allowed — we call cb once the per-host context is ready.
  function createSNICallback() {
    return (servername, cb) => {
      getSecureContext(servername)
        .then((ctx) => cb(null, ctx))
        .catch((err) => cb(err instanceof Error ? err : new Error(String(err))));
    };
  }

  return {
    getSecureContext,
    createSNICallback,
    get size() {
      return contexts.size;
    },
  };
}

module.exports = {
  DEFAULT_CA_NAME,
  generateCaPems,
  issueLeafPems,
  createCertStore,
};
