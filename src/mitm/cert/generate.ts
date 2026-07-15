import path from "path";
import fs from "fs";
import { resolveMitmDataDir } from "../dataDir.ts";

// The MITM listener presents a per-host leaf minted at TLS-handshake time by
// `server.cjs` (see `_internal/dynamicCert.cjs`). For those leaves to validate
// on real clients, `server.key`/`server.crt` must be a ROOT CA (CA:TRUE), and
// the operator trusts THAT CA, not a per-host leaf. A single static leaf (the
// old behavior) only ever validated one host; every other SNI failed with a
// hostname mismatch. The #6494 per-host SAN list was a partial workaround that
// the per-SNI leaf minting now supersedes (server.cjs covers every host,
// including ones added later, without regenerating the CA). install.ts already
// trusts this file as "OmniRoute MITM Root CA".
const CA_NAME = "OmniRoute MITM Root CA";

/**
 * Generate the MITM ROOT CA using selfsigned (pure JS, no openssl needed).
 * Writes the CA key/cert to `server.key`/`server.crt`; `server.cjs` loads them
 * and mints per-SNI leaves signed by this CA on demand.
 */
export async function generateCert(): Promise<{ key: string; cert: string }> {
  const certDir = path.join(resolveMitmDataDir(), "mitm");
  const keyPath = path.join(certDir, "server.key");
  const certPath = path.join(certDir, "server.crt");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log("✅ SSL certificate already exists");
    return { key: keyPath, cert: certPath };
  }

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  // Dynamic import for optional dependency
  const { default: selfsigned } = await import("selfsigned");
  const attrs = [{ name: "commonName", value: CA_NAME }];
  const notAfter = new Date();
  // Long-lived CA (10y): reinstalling/re-trusting the CA in the OS store is a
  // manual (sudo) step, so it must not expire on the old 1-year cadence.
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  console.log(`✅ Generated MITM root CA (${CA_NAME})`);
  return { key: keyPath, cert: certPath };
}
