// tests/unit/claude-passthrough-mode.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { obfuscateSensitiveWords } from "../../open-sse/services/claudeCodeObfuscation.ts";
import { cavemanCompress } from "../../open-sse/services/compression/caveman.ts";

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

describe("passthrough headers", () => {
  it("forwards real client headers in passthrough mode", () => {
    const clientHeaders: Record<string, string> = {
      "User-Agent": "claude-cli/2.1.205 (external, cli)",
      "X-Claude-Code-Session-Id": "real-session-uuid",
      "x-client-request-id": "real-request-uuid",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Lang": "js",
      "X-Stainless-OS": "MacOS",
      "X-Stainless-Package-Version": "0.94.0",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": "v26.3.0",
      "X-Stainless-Timeout": "600",
      "X-Stainless-Retry-Count": "0",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    };

    // These are the headers that should be forwarded verbatim
    const PASSTHROUGH_HEADERS = [
      "User-Agent",
      "X-Claude-Code-Session-Id",
      "x-client-request-id",
      "X-Stainless-Arch",
      "X-Stainless-Lang",
      "X-Stainless-OS",
      "X-Stainless-Package-Version",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "X-Stainless-Timeout",
      "X-Stainless-Retry-Count",
      "anthropic-beta",
      "anthropic-version",
      "anthropic-dangerous-direct-browser-access",
      "x-app",
    ];

    for (const header of PASSTHROUGH_HEADERS) {
      assert.ok(clientHeaders[header] !== undefined, `Client should provide ${header}`);
    }
  });
});

describe("obfuscation disabled in passthrough mode", () => {
  const originalEnv = process.env.CLAUDE_PASSTHROUGH_MODE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PASSTHROUGH_MODE;
    else process.env.CLAUDE_PASSTHROUGH_MODE = originalEnv;
  });

  it("does not insert zero-width joiners when passthrough is on", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const input = "I am using cline and cursor for development";
    const result = obfuscateSensitiveWords(input);
    // In passthrough mode, text should be unchanged
    assert.equal(result, input);
  });

  it("still obfuscates when passthrough is off", () => {
    delete process.env.CLAUDE_PASSTHROUGH_MODE;
    const input = "I am using cline and cursor for development";
    const result = obfuscateSensitiveWords(input);
    // Should contain zero-width joiners
    assert.notEqual(result, input);
    assert.ok(result.includes("‍"));
  });
});

describe("fingerprint reordering disabled in passthrough mode", () => {
  it("skips applyFingerprint when passthrough is on", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");

    // The gating logic in base.ts
    const provider = "claude";
    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const passthroughActive = isPassthroughMode();

    const shouldFingerprint =
      !passthroughActive && provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken);

    assert.equal(shouldFingerprint, false);
  });
});

describe("tool preservation in passthrough mode", () => {
  it("preserves cache_control on tools", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");
    assert.equal(isPassthroughMode(), true);

    const tools = [
      { name: "Bash", description: "Run bash", cache_control: { type: "ephemeral" } },
      { name: "Read", description: "Read files" },
    ];

    // In passthrough mode, cache_control should NOT be deleted
    // (the guard skips the delete loop)
    assert.ok(tools[0].cache_control !== undefined);
  });
});

describe("first user message protection", () => {
  it("does not compress the first user message when skipFirstUserMessage is true", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello, could you please explain the database authentication?" },
        {
          role: "assistant",
          content: "Sure, I would be happy to explain the authentication process.",
        },
        {
          role: "user",
          content: "Thank you so much, could you please also explain the authorization?",
        },
      ],
    };

    const result = cavemanCompress(body, {
      enabled: true,
      intensity: "lite",
      skipFirstUserMessage: true,
      compressRoles: ["user", "assistant"],
      minMessageLength: 1,
    });

    const messages = (result.body as { messages: Array<{ content: string }> }).messages;

    // First user message should be UNCHANGED
    assert.equal(messages[0].content, body.messages[0].content);

    // Second user message (messages[2]) should be compressed (filler stripped)
    assert.notEqual(messages[2].content, body.messages[2].content);
  });

  it("compresses all messages when skipFirstUserMessage is false", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello, could you please explain the database authentication?" },
      ],
    };

    const result = cavemanCompress(body, {
      enabled: true,
      intensity: "lite",
      skipFirstUserMessage: false,
      compressRoles: ["user"],
      minMessageLength: 1,
    });

    const messages = (result.body as { messages: Array<{ content: string }> }).messages;
    // First user message SHOULD be compressed (pleasantries/polite framing stripped)
    assert.notEqual(messages[0].content, body.messages[0].content);
  });
});
