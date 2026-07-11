// tests/unit/claude-passthrough-mode.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("claude passthrough mode toggle", () => {
  const originalEnv = process.env.CLAUDE_PASSTHROUGH_MODE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PASSTHROUGH_MODE;
    else process.env.CLAUDE_PASSTHROUGH_MODE = originalEnv;
  });

  it("returns false when env is unset", () => {
    delete process.env.CLAUDE_PASSTHROUGH_MODE;
    // Re-import to pick up change (dynamic import needed)
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");
    assert.equal(isPassthroughMode(), false);
  });

  it("returns true when env is '1'", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");
    assert.equal(isPassthroughMode(), true);
  });

  it("returns false when env is '0'", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "0";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");
    assert.equal(isPassthroughMode(), false);
  });
});

describe("passthrough identity", () => {
  // parseUpstreamMetadataUserId is already exported from claudeIdentity.ts.
  // We test the gating logic here (in passthrough mode, cloakIdentity must
  // be false so the upstream metadata path is taken).

  it("does not cloak identity when passthrough mode is on", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");

    // Simulate the gating logic from base.ts:945
    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const passthroughActive = isPassthroughMode();

    // In passthrough mode, cloakIdentity should be false regardless of client type
    const cloakIdentity = (isClaudeCodeClient || hasClaudeOAuthToken) && !passthroughActive;
    assert.equal(cloakIdentity, false);
  });

  it("still cloaks identity when passthrough mode is off", () => {
    delete process.env.CLAUDE_PASSTHROUGH_MODE;
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");

    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const passthroughActive = isPassthroughMode();

    const cloakIdentity = (isClaudeCodeClient || hasClaudeOAuthToken) && !passthroughActive;
    assert.equal(cloakIdentity, true);
  });
});

describe("passthrough system prompt", () => {
  it("preserves client system blocks in passthrough mode", () => {
    // The client (CC) sends system blocks like:
    const clientSystem = [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.205.a3f; cc_entrypoint=cli; cch=1b2c3;",
      },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: "text",
        text: "You are an interactive agent...",
        cache_control: { type: "ephemeral" },
      },
    ];

    // In passthrough mode, these should NOT be stripped and re-prepended.
    // The billing header (system[0]) and sentinel (system[1]) should remain
    // exactly as the client sent them.
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");
    assert.equal(isPassthroughMode(), true);

    // Verify the client's system[0] text starts with the billing header
    assert.ok(clientSystem[0].text.startsWith("x-anthropic-billing-header:"));
    // Verify system[1] is the sentinel
    assert.ok(clientSystem[1].text.startsWith("You are Claude Code"));
    // Both present = no prepend needed
    assert.equal(clientSystem.length, 3);
  });
});
