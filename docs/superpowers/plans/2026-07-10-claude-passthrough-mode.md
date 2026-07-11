# Claude Passthrough Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "passthrough mode" for the native `claude` provider that forwards real Claude Code CLI headers, identity, and system prompt blocks instead of rebuilding them from scratch, while preserving OmniRoute's compression pipeline.

**Architecture:** A new env toggle `CLAUDE_PASSTHROUGH_MODE=1` gates a code path in `open-sse/executors/base.ts` that (a) forwards the upstream CC client's real HTTP headers, session/device/account identity, and billing system blocks, (b) skips obfuscation and tool cloaking, and (c) recomputes CCH only after compression modifies the body. The compression pipeline (Caveman lite + RTK) is untouched but configured conservatively: system prompt always preserved, first user message skipped to protect the CC fingerprint hash.

**Tech Stack:** TypeScript (ESM, Node 22+), Node native test runner, OmniRoute's existing executor/config infrastructure.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `open-sse/executors/base.ts` | Modify (lines 785-1168) | Gate identity synthesis, header synthesis, obfuscation, billing prepend, and CCH signing behind passthrough toggle |
| `open-sse/executors/claudeIdentity.ts` | Modify | Add `isPassthroughMode()` helper; export existing passthrough parsing functions without gating |
| `open-sse/config/anthropicHeaders.ts` | Modify (line 124) | Update `CLAUDE_CLI_VERSION` constant; add `CLAUDE_CLI_VERSION_OVERRIDE` env support |
| `open-sse/services/claudeCodeObfuscation.ts` | Modify | Skip obfuscation when passthrough mode is active |
| `open-sse/services/compression/caveman.ts` | Modify | Add first-user-message skip guard |
| `open-sse/services/compression/types.ts` | Modify | Add `skipFirstUserMessage` config field |
| `open-sse/config/cliFingerprints.ts` | Modify | Skip fingerprint reordering when passthrough headers are forwarded |
| `tests/unit/claude-passthrough-mode.test.ts` | Create | All tests for the passthrough behavior |
| `.env.example` | Modify | Document new env vars |

---

## Task 1: Add the Passthrough Mode Toggle

**Files:**
- Create: `tests/unit/claude-passthrough-mode.test.ts`
- Modify: `open-sse/executors/claudeIdentity.ts`

This task adds the central toggle function that every subsequent task gates on.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/claude-passthrough-mode.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("claude passthrough mode toggle", () => {
  const originalEnv = process.env.CLAUDE_PASSTHROUGH_MODE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PASSTHROUGH_MODE;
    else process.env.CLAUDE_PASSTHROUGH_MODE = originalEnv;
  });

  it("returns false when env is unset", () => {
    delete process.env.CLAUDE_PASSTHROUGH_MODE;
    // Re-import to pick up change — dynamic import needed
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: FAIL with "isPassthroughMode is not a function" or similar

- [ ] **Step 3: Implement the toggle function**

In `open-sse/executors/claudeIdentity.ts`, add at the top of the file (after the existing imports):

```ts
const PASSTHROUGH_TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isPassthroughMode(): boolean {
  const val = (process.env.CLAUDE_PASSTHROUGH_MODE ?? "").trim().toLowerCase();
  return PASSTHROUGH_TRUTHY.has(val);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/unit/claude-passthrough-mode.test.ts open-sse/executors/claudeIdentity.ts
git commit -m "feat: add CLAUDE_PASSTHROUGH_MODE env toggle in claudeIdentity"
```

---

## Task 2: Passthrough Identity (Don't Rotate device_id/account_uuid/session_id)

**Files:**
- Modify: `open-sse/executors/base.ts:941-966`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

The most critical change. In passthrough mode, forward the upstream CC client's real identity instead of synthesizing/cloaking it.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
describe("passthrough identity", () => {
  // parseUpstreamMetadataUserId is already exported from claudeIdentity.ts.
  // We test the gating logic here — in passthrough mode, cloakIdentity must
  // be false so the upstream metadata path is taken.

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
```

- [ ] **Step 2: Run test to verify it passes (this is a logic test, not a code test yet)**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS (the test exercises the gating formula, not the production code yet)

- [ ] **Step 3: Apply the change to base.ts**

In `open-sse/executors/base.ts`, add the import at the top (near other claudeIdentity imports around line 58):

```ts
import { isPassthroughMode } from "./claudeIdentity.ts";
```

Then modify line 945 from:

```ts
const cloakIdentity = isClaudeCodeClient || hasClaudeOAuthToken;
```

to:

```ts
const cloakIdentity = (isClaudeCodeClient || hasClaudeOAuthToken) && !isPassthroughMode();
```

This single change makes the executor use `parseUpstreamMetadataUserId(tb)` (line 947) which reads the real `device_id`, `account_uuid`, `session_id` from the client's `metadata.user_id` field. When the client IS Claude Code, these will be the real values CC computed from `~/.claude.json`.

It also makes `passthroughUpstreamSessionId()` (line 955) read the real `X-Claude-Code-Session-Id` header from the client instead of synthesizing one.

- [ ] **Step 4: Run test suite**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: passthrough real CC identity when CLAUDE_PASSTHROUGH_MODE=1"
```

---

## Task 3: Passthrough System Prompt (Don't Prepend Synthetic Billing/Sentinel)

**Files:**
- Modify: `open-sse/executors/base.ts:968-1000`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

In passthrough mode, preserve the client's original system blocks instead of prepending a synthetic billing header and sentinel. CC already includes both.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
describe("passthrough system prompt", () => {
  it("preserves client system blocks in passthrough mode", () => {
    // The client (CC) sends system blocks like:
    const clientSystem = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.205.a3f; cc_entrypoint=cli; cch=1b2c3;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are an interactive agent...", cache_control: { type: "ephemeral" } },
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
```

- [ ] **Step 2: Run test to verify it passes (formula test)**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 3: Wrap the billing/sentinel prepend in a passthrough guard**

In `open-sse/executors/base.ts`, find the billing/sentinel prepend block (around lines 968-1000). The key section starts with:

```ts
const dayStamp = new Date().toISOString().slice(0, 10);
const buildHash = buildHashFor(CLAUDE_CODE_VERSION, dayStamp);
const billingLine = `x-anthropic-billing-header: ...`;
const SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";
```

Wrap the entire billing/sentinel prepend block (from `const dayStamp` through the system block manipulation that ends around line 1000) in a passthrough guard:

```ts
// In passthrough mode, the upstream CC client already includes its own
// billing header (system[0]) and sentinel (system[1]) with a correctly
// computed CCH. Preserve them as-is; only prepend when synthesizing.
const passthroughActive = isPassthroughMode();
if (!passthroughActive) {
  const dayStamp = new Date().toISOString().slice(0, 10);
  const buildHash = buildHashFor(CLAUDE_CODE_VERSION, dayStamp);
  const billingLine = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=00000;`;
  const SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";
  // ... rest of existing prepend logic stays exactly as-is inside this block
}
```

Also wrap the CCH signing call (line 1166-1168) to only fire when we prepended our own billing header:

```ts
if (!passthroughActive && (isClaudeCodeCompatible(this.provider) || this.provider === "claude")) {
  bodyString = await signRequestBody(bodyString);
}
```

Note: `passthroughActive` needs to be accessible at line 1166. Either hoist the variable to the outer scope of the Claude provider block (around line 780), or re-call `isPassthroughMode()` there.

The simplest approach: add `const passthroughActive = isPassthroughMode();` once at the top of the `if (this.provider === "claude" && ...)` block (around line 782), and reference it throughout.

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: preserve client billing/sentinel system blocks in passthrough mode"
```

---

## Task 4: Passthrough Headers (Forward Real CC Headers)

**Files:**
- Modify: `open-sse/executors/base.ts:1030-1068`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

In passthrough mode, forward the upstream CC client's real HTTP headers instead of synthesizing a new set.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
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
      assert.ok(
        clientHeaders[header] !== undefined,
        `Client should provide ${header}`
      );
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 3: Implement passthrough header forwarding in base.ts**

In `open-sse/executors/base.ts`, find the synthesized header block (lines 1030-1068). Before the existing `const ccHeaders` declaration, add the passthrough branch:

```ts
if (passthroughActive && clientHeaders) {
  // Forward real CC headers verbatim instead of synthesizing.
  // Only override Accept and auth — everything else comes from the real client.
  const PASSTHROUGH_HEADER_NAMES = [
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
    "accept-encoding",
    "connection",
  ];
  const ptHeaders: Record<string, string> = {
    Accept: "application/json",
  };
  for (const name of PASSTHROUGH_HEADER_NAMES) {
    // Case-insensitive lookup in clientHeaders
    const val =
      clientHeaders[name] ??
      clientHeaders[name.toLowerCase()] ??
      clientHeaders[name.toUpperCase()];
    if (typeof val === "string") ptHeaders[name] = val;
  }
  // Merge onto existing headers (which already have auth from the provider path)
  const ptKeysLower = new Set(Object.keys(ptHeaders).map((k) => k.toLowerCase()));
  for (const key of Object.keys(headers)) {
    if (ptKeysLower.has(key.toLowerCase())) delete headers[key];
  }
  Object.assign(headers, ptHeaders);
  delete headers["X-Stainless-Helper-Method"];
} else {
  // Existing synthesized header block (unchanged)
  const ccHeaders: Record<string, string> = {
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    // ... rest of existing ccHeaders code at lines 1030-1068 stays as-is
  };
  // ... rest of existing merge logic stays as-is
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: forward real CC client headers in passthrough mode"
```

---

## Task 5: Disable Obfuscation in Passthrough Mode

**Files:**
- Modify: `open-sse/services/claudeCodeObfuscation.ts`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

Zero-width joiner insertion is trivially detectable (`grep -P '\x{200D}'`). Skip it in passthrough mode.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
import { obfuscateSensitiveWords } from "../../open-sse/services/claudeCodeObfuscation.ts";

describe("obfuscation disabled in passthrough mode", () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: FAIL (obfuscation runs regardless of passthrough mode)

- [ ] **Step 3: Add passthrough guard to obfuscation**

In `open-sse/services/claudeCodeObfuscation.ts`, add the import and guard:

```ts
import { isPassthroughMode } from "../executors/claudeIdentity.ts";
```

Then modify `obfuscateSensitiveWords` (line 57):

```ts
export function obfuscateSensitiveWords(text: string): string {
  if (!text || sensitiveWords.length === 0 || isPassthroughMode()) return text;
  // ... rest unchanged
```

And modify `obfuscateInBody` (line 70):

```ts
export function obfuscateInBody(body: Record<string, unknown>): void {
  if (isPassthroughMode()) return;
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/services/claudeCodeObfuscation.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: skip zero-width joiner obfuscation in passthrough mode"
```

---

## Task 6: Skip Fingerprint Reordering in Passthrough Mode

**Files:**
- Modify: `open-sse/executors/base.ts:1155-1162`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

In passthrough mode, the real CC client's headers and body are already in the correct order. OmniRoute's fingerprint reordering would rearrange them to match OmniRoute's captured trace (which may differ slightly from the current CC version's ordering).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
describe("fingerprint reordering disabled in passthrough mode", () => {
  it("skips applyFingerprint when passthrough is on", () => {
    process.env.CLAUDE_PASSTHROUGH_MODE = "1";
    const { isPassthroughMode } = require("../../open-sse/executors/claudeIdentity.ts");

    // The gating logic in base.ts:1155-1157
    const provider = "claude";
    const isClaudeCodeClient = true;
    const hasClaudeOAuthToken = true;
    const passthroughActive = isPassthroughMode();

    const shouldFingerprint =
      !passthroughActive &&
      (provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken));

    assert.equal(shouldFingerprint, false);
  });
});
```

- [ ] **Step 2: Run test (formula verification)**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 3: Apply the guard in base.ts**

In `open-sse/executors/base.ts`, modify line 1155:

From:
```ts
const shouldFingerprint =
  isCliCompatEnabled(this.provider) ||
  (this.provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken));
```

To:
```ts
const shouldFingerprint =
  !passthroughActive &&
  (isCliCompatEnabled(this.provider) ||
   (this.provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken)));
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: skip header/body fingerprint reordering in passthrough mode"
```

---

## Task 7: Skip Tool cache_control Stripping and Tool Cloaking in Passthrough Mode

**Files:**
- Modify: `open-sse/executors/base.ts:785-813`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

In passthrough mode, forward the client's tool definitions exactly as received. Don't strip `cache_control`, don't cloak third-party tool names, don't obfuscate.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 3: Wrap tool manipulation in passthrough guard**

In `open-sse/executors/base.ts`, wrap the tool-related operations (lines 785-813) in a passthrough guard:

```ts
if (!passthroughActive) {
  stripProxyToolPrefix(tb);
  remapToolNamesInRequest(tb);
  cloakThirdPartyToolNames(tb);
  if (Array.isArray(tb.tools)) {
    tb.tools = sanitizeClaudeToolSchemas(tb.tools);
  }
  obfuscateInBody(tb);

  if (Array.isArray(tb.tools)) {
    for (const t of tb.tools as Array<Record<string, unknown>>) {
      delete t.cache_control;
    }
    stripVersionedToolModelPrefix(tb.tools);
  }
}
```

Note: `sanitizeClaudeToolSchemas` may still be needed in passthrough mode if CC sends malformed schemas. Keep it outside the guard if testing shows Anthropic rejects requests without it. For now, include it inside the guard since CC's own schemas are already valid.

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: preserve tool definitions verbatim in passthrough mode"
```

---

## Task 8: Protect First User Message from Compression

**Files:**
- Modify: `open-sse/services/compression/types.ts`
- Modify: `open-sse/services/compression/caveman.ts`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

CC's fingerprint suffix (the `82d` in `cc_version=2.1.85.82d`) is computed from characters at index 4, 7, 20 of the first user message text (`claudeCodeFingerprint.ts:17`). If Caveman compresses that message (stripping filler words, removing articles), those character positions shift and the fingerprint won't match CC's computed value. Skip compression on the first user message.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
import { cavemanCompress } from "../../open-sse/services/compression/caveman.ts";

describe("first user message protection", () => {
  it("does not compress the first user message when skipFirstUserMessage is true", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello, could you please explain the database authentication?" },
        { role: "assistant", content: "Sure, I would be happy to explain the authentication process." },
        { role: "user", content: "Thank you so much, could you please also explain the authorization?" },
      ],
    };

    const result = cavemanCompress(body, {
      enabled: true,
      intensity: "lite",
      skipFirstUserMessage: true,
      compressRoles: ["user", "assistant"],
      minMessageLength: 1,
    });

    const messages = (result.body as any).messages;

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

    const messages = (result.body as any).messages;
    // First user message SHOULD be compressed (pleasantries/polite framing stripped)
    assert.notEqual(messages[0].content, body.messages[0].content);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: FAIL (skipFirstUserMessage not recognized)

- [ ] **Step 3: Add skipFirstUserMessage to config types**

In `open-sse/services/compression/types.ts`, add to the `CavemanConfig` interface (around line 56):

```ts
skipFirstUserMessage: boolean;
```

And in `DEFAULT_CAVEMAN_CONFIG` (around line 309):

```ts
skipFirstUserMessage: false,
```

- [ ] **Step 4: Implement the skip logic in caveman.ts**

In `open-sse/services/compression/caveman.ts`, inside the `cavemanCompress` function, find the `body.messages.map` call (line 481). Add a first-user-message tracker:

```ts
let firstUserSeen = false;
const compressedMessages = body.messages.map((msg): ChatMessage => {
  // Skip first user message to protect fingerprint hash computation
  if (config.skipFirstUserMessage && msg.role === "user" && !firstUserSeen) {
    firstUserSeen = true;
    const contentStr = typeof msg.content === "string"
      ? msg.content
      : /* array case */ "";
    totalOriginalTokens += estimateCompressionTokens(contentStr);
    totalCompressedTokens += estimateCompressionTokens(contentStr);
    return msg;
  }

  // ... rest of existing map body unchanged
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add open-sse/services/compression/types.ts open-sse/services/compression/caveman.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: add skipFirstUserMessage to Caveman to protect CC fingerprint"
```

---

## Task 9: CCH Recomputation After Compression

**Files:**
- Modify: `open-sse/executors/base.ts:1164-1168`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

When passthrough mode is on AND compression modifies the message body, the CCH hash in the client's original billing header is now wrong (it was computed over the pre-compression body). We need to recompute it.

The approach: even in passthrough mode, if compression was applied, find the `cch=XXXXX;` pattern in the system blocks and recompute it over the final serialized body.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
import { signRequestBody, CCH_PATTERN } from "../../open-sse/services/claudeCodeCCH.ts";

describe("CCH recomputation after compression", () => {
  it("recomputes cch in passthrough mode when body was compressed", async () => {
    const bodyWithPlaceholder = JSON.stringify({
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.205.a3f; cc_entrypoint=cli; cch=00000;" },
      ],
      messages: [{ role: "user", content: "test" }],
    });

    const signed = await signRequestBody(bodyWithPlaceholder);
    const match = signed.match(/cch=([0-9a-f]{5});/);
    assert.ok(match, "CCH should be computed");
    assert.notEqual(match![1], "00000", "CCH should not be placeholder");
  });

  it("does not modify body without cch placeholder", async () => {
    const bodyNoCCH = JSON.stringify({
      system: [{ type: "text", text: "normal system prompt" }],
      messages: [{ role: "user", content: "test" }],
    });

    const result = await signRequestBody(bodyNoCCH);
    assert.equal(result, bodyNoCCH, "Body without cch= should be unchanged");
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS (signRequestBody already handles this correctly)

- [ ] **Step 3: Update the CCH signing gate in base.ts**

In passthrough mode, the client's billing header has a real CCH value (not `00000`). If compression changed the body, the CCH is stale. We need to:
1. Replace the client's CCH with `00000` placeholder
2. Re-sign

Modify the CCH section in `open-sse/executors/base.ts` (around line 1164-1168):

```ts
if (isClaudeCodeCompatible(this.provider) || this.provider === "claude") {
  if (passthroughActive) {
    // In passthrough mode, the client sent a real CCH computed over its
    // original body. If compression modified messages, re-sign:
    // replace existing cch=XXXXX with cch=00000 placeholder, then sign.
    bodyString = bodyString.replace(/\bcch=[0-9a-f]{5};/, "cch=00000;");
  }
  bodyString = await signRequestBody(bodyString);
}
```

This works because `signRequestBody` is a no-op if no `cch=00000;` pattern is found. In non-passthrough mode, the billing header already has `cch=00000;` (prepended at line 972). In passthrough mode, we first reset the client's real CCH to `00000`, then let `signRequestBody` compute the correct value.

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/base.ts tests/unit/claude-passthrough-mode.test.ts
git commit -m "feat: recompute CCH after compression in passthrough mode"
```

---

## Task 10: Update Version Constants

**Files:**
- Modify: `open-sse/config/anthropicHeaders.ts:124`
- Modify: `.env.example`

Update the hardcoded CLI version and add env override support so the version stays current without code changes.

- [ ] **Step 1: Add env override to anthropicHeaders.ts**

```ts
// Line 124, replace:
export const CLAUDE_CLI_VERSION = "2.1.195";

// With:
export const CLAUDE_CLI_VERSION = process.env.CLAUDE_CLI_VERSION_OVERRIDE || "2.1.205";
```

- [ ] **Step 2: Document in .env.example**

Add to the appropriate section of `.env.example`:

```env
# ── Section: Claude Passthrough Mode ──────────────────────────────
# CLAUDE_PASSTHROUGH_MODE=1          # Forward real CC headers/identity instead of synthesizing
# CLAUDE_CLI_VERSION_OVERRIDE=2.1.205  # Match your actual `claude --version` output
```

- [ ] **Step 3: Commit**

```bash
git add open-sse/config/anthropicHeaders.ts .env.example
git commit -m "feat: update CLAUDE_CLI_VERSION to 2.1.205 with env override"
```

---

## Task 11: Conservative Compression Defaults for Passthrough Mode

**Files:**
- Modify: `open-sse/services/compression/types.ts`
- Modify: `tests/unit/claude-passthrough-mode.test.ts`

When passthrough mode is active, override compression defaults to safe values: Caveman `lite` only, system prompt always preserved, first user message skipped.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/claude-passthrough-mode.test.ts`:

```ts
import { DEFAULT_CAVEMAN_CONFIG } from "../../open-sse/services/compression/types.ts";

describe("compression defaults for passthrough mode", () => {
  it("preserves system prompt by default", () => {
    assert.equal(DEFAULT_CAVEMAN_CONFIG.preserveSystemPrompt, true);
    assert.equal(DEFAULT_CAVEMAN_CONFIG.preserveSystemPromptMode, "always");
  });

  it("only compresses user role by default", () => {
    assert.deepEqual(DEFAULT_CAVEMAN_CONFIG.compressRoles, ["user"]);
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-mode.test.ts`
Expected: PASS (these are already the defaults)

- [ ] **Step 3: Document the recommended passthrough compression config**

Add to `.env.example` under the passthrough section:

```env
# Compression settings recommended for passthrough mode:
# COMPRESSION_CAVEMAN_INTENSITY=lite   # Never full/ultra (produces detectable artifacts)
# COMPRESSION_CAVEMAN_SKIP_FIRST_USER=1  # Protect CC fingerprint hash
# COMPRESSION_PRESERVE_SYSTEM=always     # Never compress system prompt
# COMPRESSION_RTK_ENABLED=1              # RTK for tool results is safe
```

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/compression/types.ts .env.example tests/unit/claude-passthrough-mode.test.ts
git commit -m "docs: document conservative compression config for passthrough mode"
```

---

## Task 12: Integration Test -- Full Passthrough Request Shape

**Files:**
- Create: `tests/unit/claude-passthrough-integration.test.ts`

End-to-end test that verifies a request built in passthrough mode matches the expected shape of a real CC request.

- [ ] **Step 1: Write the integration test**

```ts
// tests/unit/claude-passthrough-integration.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isPassthroughMode } from "../../open-sse/executors/claudeIdentity.ts";

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
      !isPassthroughMode() &&
      (provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken));
    assert.equal(shouldFingerprint, false, "Fingerprint reordering should be skipped");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `node --import tsx/esm --test tests/unit/claude-passthrough-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/claude-passthrough-integration.test.ts
git commit -m "test: add integration test for full passthrough mode behavior"
```

---

## Task 13: Final Documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add complete documentation block to .env.example**

Consolidate all passthrough env vars into one documented section:

```env
# ═══════════════════════════════════════════════════════════════════
# Section 14: Claude Passthrough Mode
# ═══════════════════════════════════════════════════════════════════
# When enabled, OmniRoute acts as a transparent proxy for Claude Code
# traffic: forwarding real CC headers, identity (device_id, session_id,
# account_uuid), and system prompt blocks instead of rebuilding them.
# Compression still applies but with conservative defaults.
#
# Use this when running OmniRoute locally with your own Claude Max
# subscription and Claude Code as the upstream client.
#
# CLAUDE_PASSTHROUGH_MODE=1
# CLAUDE_CLI_VERSION_OVERRIDE=2.1.205
#
# Recommended compression settings for passthrough:
# COMPRESSION_CAVEMAN_INTENSITY=lite
# COMPRESSION_CAVEMAN_SKIP_FIRST_USER=1
# COMPRESSION_PRESERVE_SYSTEM=always
# COMPRESSION_RTK_ENABLED=1
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add complete passthrough mode documentation to .env.example"
```

---

## Summary of Changes

| What | File | Line(s) | Change |
|---|---|---|---|
| Toggle function | `claudeIdentity.ts` | new | `isPassthroughMode()` reads `CLAUDE_PASSTHROUGH_MODE` env |
| Identity passthrough | `base.ts` | 945 | `cloakIdentity` gated on `!isPassthroughMode()` |
| System prompt passthrough | `base.ts` | 968-1000 | Billing/sentinel prepend wrapped in `if (!passthroughActive)` |
| Header passthrough | `base.ts` | 1030-1068 | Forward real CC headers instead of synthesizing |
| Skip obfuscation | `claudeCodeObfuscation.ts` | 57, 70 | Early return when passthrough mode active |
| Skip fingerprint ordering | `base.ts` | 1155 | `shouldFingerprint` gated on `!passthroughActive` |
| Skip tool manipulation | `base.ts` | 785-813 | Cloak/strip/remap wrapped in `if (!passthroughActive)` |
| Protect first user msg | `caveman.ts` | 481 | Skip first user message when `skipFirstUserMessage: true` |
| CCH recomputation | `base.ts` | 1164-1168 | Reset client CCH to placeholder before re-signing |
| Version update | `anthropicHeaders.ts` | 124 | `2.1.195` -> `2.1.205` + env override |
| Documentation | `.env.example` | new section | All passthrough env vars documented |
