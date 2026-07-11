// tests/unit/codex-passthrough-mode.test.ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
