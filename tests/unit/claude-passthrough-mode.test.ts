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
