import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-discovery-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const discoveryRoute = await import("../../src/app/api/providers/[id]/models/discovery/route.ts");

const originalFetch = globalThis.fetch;

interface DiscoveryModel {
  id: string;
  name: string;
  owned_by: string;
}

interface DiscoveryBody {
  supported: boolean;
  provider: string;
  models: DiscoveryModel[];
  count?: number;
}

interface ErrorBody {
  error: { message: string; type?: string; code?: string };
}

async function resetStorage() {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: (overrides.authType as string) || "apikey",
    name: (overrides.name as string) || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey as string | undefined,
    accessToken: overrides.accessToken as string | undefined,
    isActive: (overrides.isActive as boolean) ?? true,
    testStatus: (overrides.testStatus as string) || "active",
    providerSpecificData: (overrides.providerSpecificData as Record<string, unknown>) || {},
  });
}

async function callRoute(connectionId: string) {
  return discoveryRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models/discovery`),
    { params: { id: connectionId } }
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("returns the normalized served set for an OpenAI-like provider (supported:true)", async () => {
  // venice is a named OpenAI-style provider not in PROVIDER_MODELS_CONFIG, so the
  // route resolves the generic `<baseUrl>/models` endpoint from the connection.
  const connection = await seedConnection("venice", {
    apiKey: "venice-key",
    providerSpecificData: { baseUrl: "https://api.venice.ai/v1" },
  });

  let probed: string | null = null;
  globalThis.fetch = async (url) => {
    probed = String(url);
    return Response.json({
      object: "list",
      data: [
        { id: "venice-alpha", owned_by: "acme" },
        { id: "venice-beta", display_name: "Venice Beta" },
      ],
    });
  };

  const response = await callRoute(connection.id);
  assert.equal(response.status, 200);
  assert.equal(probed, "https://api.venice.ai/v1/models");

  const body = (await response.json()) as DiscoveryBody;
  assert.equal(body.supported, true);
  assert.equal(body.provider, "venice");
  assert.equal(body.count, 2);

  const alpha = body.models.find((m) => m.id === "venice-alpha");
  const beta = body.models.find((m) => m.id === "venice-beta");
  assert.ok(alpha && beta, "both models should be present");
  // owned_by preserved when present, otherwise falls back to the provider id.
  assert.equal(alpha?.owned_by, "acme");
  assert.equal(alpha?.name, "venice-alpha");
  assert.equal(beta?.owned_by, "venice");
  assert.equal(beta?.name, "Venice Beta");
});

test("normalizes a PROVIDER_MODELS_CONFIG served set (claude)", async () => {
  const connection = await seedConnection("claude", { apiKey: "claude-key" });

  let probed: string | null = null;
  globalThis.fetch = async (url) => {
    probed = String(url);
    return Response.json({
      data: [{ id: "claude-opus-4", display_name: "Claude Opus 4" }, { id: "claude-sonnet-4" }],
    });
  };

  const response = await callRoute(connection.id);
  assert.equal(response.status, 200);
  assert.equal(probed, "https://api.anthropic.com/v1/models");

  const body = (await response.json()) as DiscoveryBody;
  assert.equal(body.supported, true);
  assert.equal(body.count, 2);
  const opus = body.models.find((m) => m.id === "claude-opus-4");
  assert.equal(opus?.name, "Claude Opus 4");
  assert.equal(opus?.owned_by, "claude");
});

test("unsupported provider returns {supported:false, models:[]} with HTTP 200 (never throws)", async () => {
  // linkup-search has no models-list endpoint (no config, not OpenAI-style, no baseUrl).
  const connection = await seedConnection("linkup-search", { apiKey: "linkup-key" });

  // No fetch should be issued for an unsupported provider.
  globalThis.fetch = async () => {
    throw new Error("upstream should not be contacted for an unsupported provider");
  };

  const response = await callRoute(connection.id);
  assert.equal(response.status, 200);

  const body = (await response.json()) as DiscoveryBody;
  assert.equal(body.supported, false);
  assert.equal(body.provider, "linkup-search");
  assert.deepEqual(body.models, []);
  assert.equal(body.count, undefined, "unsupported response omits count");
});

test("upstream failure yields a sanitized error body with no stack-trace leak", async () => {
  const connection = await seedConnection("claude", { apiKey: "claude-key" });

  globalThis.fetch = async () => new Response("upstream boom", { status: 502 });

  const response = await callRoute(connection.id);
  assert.equal(response.status, 502);

  const body = (await response.json()) as ErrorBody;
  assert.ok(body.error, "error body present");
  assert.ok(typeof body.error.message === "string" && body.error.message.length > 0);
  // Sanitization guard (hard rule #12): no absolute-path / stack-frame leakage.
  assert.ok(!body.error.message.includes("at /"), "error message must not leak a stack trace");
});

test("missing connection returns a sanitized 404", async () => {
  const response = await callRoute("does-not-exist");
  assert.equal(response.status, 404);

  const body = (await response.json()) as ErrorBody;
  assert.ok(body.error, "error body present");
  assert.ok(!body.error.message.includes("at /"), "404 message must not leak a stack trace");
});
