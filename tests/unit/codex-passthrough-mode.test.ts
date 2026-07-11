// tests/unit/codex-passthrough-mode.test.ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  applyCodexClientIdentityHeaders,
  applyCodexClientMetadata,
  createCodexClientIdentity,
} from "../../open-sse/config/codexIdentity.ts";

const require = createRequire(import.meta.url);

describe("codex passthrough mode toggle", () => {
  const originalEnv = process.env.CODEX_PASSTHROUGH_MODE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CODEX_PASSTHROUGH_MODE;
    else process.env.CODEX_PASSTHROUGH_MODE = originalEnv;
  });

  it("returns false when env is unset", () => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
    const { isCodexPassthroughMode } = require("../../open-sse/config/codexIdentity.ts");
    assert.equal(isCodexPassthroughMode(), false);
  });

  it("returns true when env is '1'", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";
    const { isCodexPassthroughMode } = require("../../open-sse/config/codexIdentity.ts");
    assert.equal(isCodexPassthroughMode(), true);
  });

  it("returns false when env is '0'", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "0";
    const { isCodexPassthroughMode } = require("../../open-sse/config/codexIdentity.ts");
    assert.equal(isCodexPassthroughMode(), false);
  });
});

describe("passthrough identity headers", () => {
  afterEach(() => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
  });

  it("does not inject identity headers when passthrough is on", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";
    const headers: Record<string, string> = { Authorization: "Bearer test" };
    const identity = createCodexClientIdentity("test-session-id", null);
    applyCodexClientIdentityHeaders(headers, identity);

    // In passthrough mode, these should NOT be set by OmniRoute
    assert.equal(headers["session_id"], undefined);
    assert.equal(headers["x-client-request-id"], undefined);
    assert.equal(headers["x-codex-window-id"], undefined);
    assert.equal(headers["x-codex-turn-metadata"], undefined);
  });

  it("still injects identity headers when passthrough is off", () => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
    const headers: Record<string, string> = { Authorization: "Bearer test" };
    const identity = createCodexClientIdentity("test-session-id", null);
    applyCodexClientIdentityHeaders(headers, identity);

    assert.ok(headers["session_id"]);
    assert.ok(headers["x-client-request-id"]);
    assert.ok(headers["x-codex-window-id"]);
    assert.ok(headers["x-codex-turn-metadata"]);
  });
});

describe("passthrough body metadata", () => {
  afterEach(() => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
  });

  it("does not inject client_metadata when passthrough is on", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";
    const body: Record<string, unknown> = { input: [], model: "gpt-5.5" };
    const identity = createCodexClientIdentity("test-session-id", null);
    applyCodexClientMetadata(body, identity);

    assert.equal(body.client_metadata, undefined);
  });

  it("still injects client_metadata when passthrough is off", () => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
    const body: Record<string, unknown> = { input: [], model: "gpt-5.5" };
    const identity = createCodexClientIdentity("test-session-id", null);
    applyCodexClientMetadata(body, identity);

    assert.ok(body.client_metadata !== undefined);
  });
});
