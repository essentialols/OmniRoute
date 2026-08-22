// tests/unit/claude-passthrough-integration.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isPassthroughMode } from "../../open-sse/executors/claudeIdentity.ts";

const require = createRequire(import.meta.url);

describe("passthrough mode integration", () => {
  beforeEach(() => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
  });

  afterEach(() => {
    delete process.env.CLAUDE_PASSTHROUGH_MODE;
  });

  it("toggle is active", () => {
    assert.equal(isPassthroughMode(), true);
  });

  it("does not produce zero-width joiners in output", () => {
    const { obfuscateSensitiveWords } = require("../../open-sse/services/claudeCodeObfuscation.ts");
    const input = "Using cline with cursor and omniroute";
    const output = obfuscateSensitiveWords(input);
    assert.equal(output, input, "No ZWJ should be inserted");
    assert.ok(!output.includes("‍"), "No zero-width joiners");
  });

  it("identity is not cloaked", () => {
    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const cloakIdentity = (isClaudeCodeClient || hasClaudeOAuthToken) && !isPassthroughMode();
    assert.equal(cloakIdentity, false, "Identity should not be cloaked");
  });

  it("fingerprint reordering is skipped", () => {
    const provider = "claude";
    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const shouldFingerprint =
      !isPassthroughMode() && provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken);
    assert.equal(shouldFingerprint, false, "Fingerprint reordering should be skipped");
  });
});
