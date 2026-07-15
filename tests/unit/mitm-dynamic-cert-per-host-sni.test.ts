/**
 * Bug 1 regression: the AgentBridge MITM must present a valid per-host leaf
 * certificate for the requested SNI, minted on demand and signed by a local
 * ROOT CA. The old behavior served ONE static leaf
 * (CN=daily-cloudcode-pa.googleapis.com) for EVERY SNI, so only that single
 * host validated on real TLS clients; every other host (chatgpt.com, etc.)
 * failed with a hostname mismatch.
 *
 * This test drives:
 *   1. the CJS cert store used by server.cjs (`_internal/dynamicCert.cjs`)
 *   2. an end-to-end TLS handshake proving the served leaf CN tracks the SNI
 *   3. that `cert/generate.ts` now writes a CA (basicConstraints CA:TRUE),
 *      not a leaf.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const certShim = requireCjs("../../src/mitm/_internal/dynamicCert.cjs") as {
  generateCaPems: (name?: string, years?: number) => Promise<{ key: string; cert: string }>;
  issueLeafPems: (
    hostname: string,
    ca: { key: string; cert: string },
    years?: number
  ) => Promise<{ key: string; cert: string }>;
  createCertStore: (ca: { key: string; cert: string }) => {
    getSecureContext: (h: string) => Promise<tls.SecureContext>;
    createSNICallback: () => (
      servername: string,
      cb: (err: Error | null, ctx?: tls.SecureContext) => void
    ) => void;
    readonly size: number;
  };
};

test("generateCaPems produces a ROOT CA (basicConstraints CA:TRUE)", async () => {
  const ca = await certShim.generateCaPems();
  const x = new X509Certificate(ca.cert);
  assert.equal(x.ca, true, "generated cert must be a CA");
  assert.match(x.subject, /OmniRoute MITM Root CA/);
});

test("issueLeafPems mints a per-host leaf signed by the CA", async () => {
  const ca = await certShim.generateCaPems();
  const leaf = await certShim.issueLeafPems("chatgpt.com", ca);
  const leafX = new X509Certificate(leaf.cert);
  const caX = new X509Certificate(ca.cert);
  assert.match(leafX.subject, /CN=chatgpt\.com/);
  assert.equal(leafX.issuer, caX.subject, "leaf must be issued by the CA");
  assert.equal(leafX.verify(caX.publicKey), true, "leaf must verify against the CA key");
  assert.equal(leafX.ca, false, "a leaf must NOT be a CA");
});

test("createCertStore issues a DISTINCT leaf per SNI host and caches", async () => {
  const ca = await certShim.generateCaPems();
  const store = certShim.createCertStore(ca);
  await store.getSecureContext("chatgpt.com");
  await store.getSecureContext("example.com");
  await store.getSecureContext("chatgpt.com"); // cached, no growth
  assert.equal(store.size, 2, "one cached context per distinct host");
});

test("end-to-end TLS: served leaf CN tracks the SNI (not one static cert)", async () => {
  const ca = await certShim.generateCaPems();
  const store = certShim.createCertStore(ca);

  const server = https.createServer(
    {
      // Default context for the no-SNI edge case; per-SNI leaves come from the
      // callback. This mirrors server.cjs sslOptions.
      key: ca.key,
      cert: ca.cert,
      SNICallback: store.createSNICallback(),
    },
    (_req, res) => res.end("ok")
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  async function peerCn(servername: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const socket = tls.connect(
        { port, host: "127.0.0.1", servername, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          resolve((cert.subject && (cert.subject as { CN?: string }).CN) || "");
        }
      );
      socket.on("error", reject);
    });
  }

  try {
    const cn1 = await peerCn("chatgpt.com");
    const cn2 = await peerCn("example.com");
    assert.equal(cn1, "chatgpt.com", "SNI chatgpt.com must get a chatgpt.com leaf");
    assert.equal(cn2, "example.com", "SNI example.com must get an example.com leaf");
    assert.notEqual(cn1, cn2, "different SNI must yield different certs (bug 1 fix)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cert/generate.ts now writes a ROOT CA to server.crt (not a static leaf)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ca-gen-"));
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const { generateCert } = await import("../../src/mitm/cert/generate.ts");
    const res = await generateCert();
    const pem = fs.readFileSync(res.cert, "utf8");
    const x = new X509Certificate(pem);
    assert.equal(x.ca, true, "generateCert must emit a CA (CA:TRUE), not a leaf");
    assert.match(x.subject, /OmniRoute MITM Root CA/);
  } finally {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
