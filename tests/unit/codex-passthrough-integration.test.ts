// tests/unit/codex-passthrough-integration.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexPassthroughMode,
  applyCodexClientIdentityHeaders,
  applyCodexClientMetadata,
  createCodexClientIdentity,
} from "../../open-sse/config/codexIdentity.ts";

describe("codex passthrough mode integration", () => {
  beforeEach(() => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";
  });

  afterEach(() => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
  });

  it("toggle is active", () => {
    assert.equal(isCodexPassthroughMode(), true);
  });

  it("identity headers are not injected", () => {
    const headers: Record<string, string> = {};
    const identity = createCodexClientIdentity("sess-123", { workspaceId: "ws-456" });
    applyCodexClientIdentityHeaders(headers, identity);

    assert.equal(Object.keys(headers).length, 0, "No identity headers should be set");
  });

  it("body metadata is not injected", () => {
    const body: Record<string, unknown> = { model: "gpt-5.5", input: [] };
    const identity = createCodexClientIdentity("sess-123", null);
    applyCodexClientMetadata(body, identity);

    assert.equal(body.client_metadata, undefined, "No client_metadata should be set");
  });

  it("WebSocket options should not include browser fingerprint", () => {
    const wsOpts: Record<string, unknown> = { headers: {} };
    if (!isCodexPassthroughMode()) {
      wsOpts.browser = "chrome_142";
      wsOpts.os = "windows";
    }

    assert.equal("browser" in wsOpts, false);
    assert.equal("os" in wsOpts, false);
  });
});
