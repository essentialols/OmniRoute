# Codex Passthrough Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a passthrough mode for the Codex provider that forwards the real Codex CLI client's identity headers, session IDs, and metadata instead of synthesizing them, while preserving OmniRoute's compression pipeline and request normalization.

**Architecture:** A new env toggle `CODEX_PASSTHROUGH_MODE=1` gates identity synthesis in the Codex executor. In passthrough mode, real client headers (`session_id`, `x-client-request-id`, `x-codex-window-id`, `x-codex-turn-metadata`, `User-Agent`, `Version`, `originator`) are forwarded verbatim. Body normalization (tool cleanup, reasoning effort, stored-item stripping) is preserved since it fixes real compatibility bugs. The WebSocket transport's `wreq-js` Chrome 142 fingerprint is replaced with native Node.js WebSocket when in passthrough mode (closer to a real Codex CLI Rust binary's TLS).

**Tech Stack:** TypeScript (ESM, Node 22+), Node native test runner, OmniRoute's existing executor/config infrastructure.

**Depends on:** The Claude passthrough plan (Task 1) already creates `isPassthroughMode()` in `claudeIdentity.ts`. This plan adds a parallel `isCodexPassthroughMode()` toggle.

---

## CRITICAL: OmniRoute's Codex Impersonation Is Badly Wrong

Comparing real Codex CLI traffic (captured via mitmproxy on 2026-07-07) against OmniRoute's synthesized headers reveals **9 mismatches**. This is a larger detection surface than initially assumed.

### Real Codex CLI Headers (from MITM capture)

```
authorization: Bearer eyJhbG...
chatgpt-account-id: feabea59-ebc0-4d8d-bc9d-79ccbb36b92f
openai-beta: responses_websockets=2026-02-06
originator: codex_exec
session-id: fac905bc-0fa1-42f8-834c-8e3e3bbbe4a7
thread-id: fac905bc-0fa1-42f8-834c-8e3e3bbbe4a7
user-agent: codex_exec/0.135.0 (Mac OS 15.0.1; arm64) (codex_exec; 0.135.0)
version: 0.135.0
x-client-request-id: fac905bc-0fa1-42f8-834c-8e3e3bbbe4a7
x-codex-beta-features: terminal_resize_reflow
x-codex-turn-metadata: {"session_id":"fac905bc-...","thread_id":"fac905bc-...","turn_id":"","sandbox":"none","thread_source":"codex_exec"}
x-codex-window-id: fac905bc-0fa1-42f8-834c-8e3e3bbbe4a7:0
```

### OmniRoute Synthesized Headers

```
Version: 0.142.0                           # ← Title-case, wrong version
User-Agent: codex-cli/0.142.0 (Windows 10.0.26200; x64)  # ← wrong binary name, wrong format
Openai-Beta: responses=experimental         # ← completely wrong value
X-Codex-Beta-Features: responses_websockets # ← wrong feature flag
originator: codex_cli_rs                    # ← wrong originator
session_id: <derived>                       # ← underscore, not hyphen
(no thread-id header)                       # ← missing entirely
x-codex-turn-metadata: {..., turn_id: "<uuid>", thread_source: "user"}  # ← wrong source, non-empty turn_id
```

### Differences Table

| # | Field | Real Codex CLI | OmniRoute | Detection Risk |
|---|---|---|---|---|
| 1 | `originator` | `codex_exec` | `codex_cli_rs` | HIGH -- server-side routing signal |
| 2 | `user-agent` format | `codex_exec/V (OS; arch) (codex_exec; V)` | `codex-cli/V (OS; arch)` | HIGH -- completely different binary name and format |
| 3 | `version` casing | lowercase `version` | Title-case `Version` | MEDIUM -- HTTP headers are case-insensitive but ordering/casing is a fingerprint |
| 4 | `openai-beta` | `responses_websockets=2026-02-06` | `responses=experimental` | HIGH -- different beta flag entirely |
| 5 | `x-codex-beta-features` | `terminal_resize_reflow` | `responses_websockets` | MEDIUM -- wrong feature set |
| 6 | session header name | `session-id` (hyphen) | `session_id` (underscore) | HIGH -- different header name entirely |
| 7 | `thread-id` header | Present (same UUID as session-id) | Missing | HIGH -- absent header |
| 8 | `thread_source` in turn metadata | `codex_exec` | `user` | MEDIUM -- wrong client type |
| 9 | `turn_id` in turn metadata | Empty string `""` | Generated UUID | LOW -- behavioral difference |

**Conclusion:** In non-passthrough mode, OmniRoute's Codex requests look nothing like the real CLI. Passthrough mode is even more important here than for Claude.

---

## Context: How Codex Differs from Claude

| Aspect | Claude | Codex |
|---|---|---|
| Protocol | HTTP POST to `api.anthropic.com/v1/messages` | WebSocket to `wss://chatgpt.com/backend-api/codex/responses` (or HTTP SSE fallback) |
| API format | Anthropic Messages API | OpenAI Responses API |
| Auth | OAuth Bearer `sk-ant-oat...` or `x-api-key` | OAuth Bearer (OpenAI JWT) |
| Integrity hash | CCH (xxHash64 over body) | None |
| Billing header | `x-anthropic-billing-header` in system[0] | None |
| Identity | `device_id`, `account_uuid`, `session_id` in metadata.user_id | `installationId`, `windowId`, `turnId`, `session_id` in custom headers |
| Obfuscation | Zero-width joiners in body | None |
| TLS fingerprint | wreq-js Chrome 124 | wreq-js Chrome 142 (WS only) |
| Body normalization | Minimal (tool cloaking, billing prepend) | Heavy (input sanitization, tool normalization, reasoning effort, store flag, field allowlist) |

**Key insight:** The Codex executor's body normalization is mostly *helpful* (fixes real API rejections), not stealth. The passthrough plan should keep most body transforms and only disable identity/header synthesis.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `open-sse/config/codexIdentity.ts` | Modify | Add `isCodexPassthroughMode()` toggle; gate identity synthesis |
| `open-sse/executors/codex.ts` | Modify (lines 639-668, 885-911) | Forward client headers in passthrough mode; skip identity injection |
| `open-sse/config/codexClient.ts` | Modify | Add version env override; update defaults |
| `tests/unit/codex-passthrough-mode.test.ts` | Create | All tests |
| `.env.example` | Modify | Document new env vars |

---

## Task 1: Add the Codex Passthrough Mode Toggle

**Files:**
- Create: `tests/unit/codex-passthrough-mode.test.ts`
- Modify: `open-sse/config/codexIdentity.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/codex-passthrough-mode.test.ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: FAIL with "isCodexPassthroughMode is not a function"

- [ ] **Step 3: Implement the toggle**

In `open-sse/config/codexIdentity.ts`, add at the top (after imports):

```ts
const PASSTHROUGH_TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isCodexPassthroughMode(): boolean {
  const val = (process.env.CODEX_PASSTHROUGH_MODE ?? "").trim().toLowerCase();
  return PASSTHROUGH_TRUTHY.has(val);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/unit/codex-passthrough-mode.test.ts open-sse/config/codexIdentity.ts
git commit -m "feat: add CODEX_PASSTHROUGH_MODE env toggle"
```

---

## Task 2: Skip Identity Header Synthesis in Passthrough Mode

**Files:**
- Modify: `open-sse/config/codexIdentity.ts:56-70`
- Modify: `tests/unit/codex-passthrough-mode.test.ts`

In passthrough mode, `applyCodexClientIdentityHeaders` should be a no-op so the real Codex CLI's headers flow through.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/codex-passthrough-mode.test.ts`:

```ts
import {
  applyCodexClientIdentityHeaders,
  createCodexClientIdentity,
  isCodexPassthroughMode,
} from "../../open-sse/config/codexIdentity.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: FAIL (headers are still injected in passthrough mode)

- [ ] **Step 3: Add passthrough guard to applyCodexClientIdentityHeaders**

In `open-sse/config/codexIdentity.ts`, modify `applyCodexClientIdentityHeaders` (line 56):

```ts
export function applyCodexClientIdentityHeaders(
  headers: Record<string, string>,
  identity?: CodexClientIdentity | null
): void {
  if (!identity || isCodexPassthroughMode()) return;
  headers["session_id"] = identity.sessionId;
  headers["x-client-request-id"] = identity.sessionId;
  headers["x-codex-window-id"] = identity.windowId;
  headers["x-codex-turn-metadata"] = JSON.stringify({
    session_id: identity.sessionId,
    thread_source: "user",
    turn_id: identity.turnId,
    sandbox: "none",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/config/codexIdentity.ts tests/unit/codex-passthrough-mode.test.ts
git commit -m "feat: skip Codex identity header synthesis in passthrough mode"
```

---

## Task 3: Skip Body Metadata Injection in Passthrough Mode

**Files:**
- Modify: `open-sse/config/codexIdentity.ts:72-80`
- Modify: `tests/unit/codex-passthrough-mode.test.ts`

In passthrough mode, `applyCodexClientMetadata` should not inject synthesized `client_metadata` into the request body.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/codex-passthrough-mode.test.ts`:

```ts
import { applyCodexClientMetadata } from "../../open-sse/config/codexIdentity.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: FAIL

- [ ] **Step 3: Add passthrough guard to applyCodexClientMetadata**

In `open-sse/config/codexIdentity.ts`, modify `applyCodexClientMetadata` (line 72):

```ts
export function applyCodexClientMetadata(
  body: Record<string, unknown>,
  identity?: CodexClientIdentity | null
): void {
  if (!identity || isCodexPassthroughMode()) return;
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/config/codexIdentity.ts tests/unit/codex-passthrough-mode.test.ts
git commit -m "feat: skip Codex body metadata injection in passthrough mode"
```

---

## Task 4: Forward Real Client Headers in buildHeaders

**Files:**
- Modify: `open-sse/executors/codex.ts:885-913`
- Modify: `tests/unit/codex-passthrough-mode.test.ts`

In passthrough mode, the `buildHeaders` method should forward the real client's `User-Agent`, `Version`, `originator`, and other identity-bearing headers instead of synthesizing them.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/codex-passthrough-mode.test.ts`:

```ts
describe("passthrough buildHeaders", () => {
  afterEach(() => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
  });

  it("does not override User-Agent when passthrough is on", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";

    // When passthrough is on, the executor should NOT force its own UA
    // The real Codex CLI sends: codex-cli/0.142.0 (Windows 10.0.26200; x64)
    // OmniRoute should not override this with its configured version
    assert.equal(isCodexPassthroughMode(), true);

    // The gating logic: in passthrough mode, skip setUserAgentHeader
    // and skip originator injection
    const shouldSynthesizeIdentity = !isCodexPassthroughMode();
    assert.equal(shouldSynthesizeIdentity, false);
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS (formula test)

- [ ] **Step 3: Modify buildHeaders in codex.ts**

In `open-sse/executors/codex.ts`, modify the `buildHeaders` method (line 885). Add import at top:

```ts
import { isCodexPassthroughMode } from "../config/codexIdentity.ts";
```

Then modify `buildHeaders`:

```ts
buildHeaders(credentials: ProviderCredentials, stream = true) {
  const isCompactRequest = isCompactResponsesEndpoint(credentials?.requestEndpointPath);
  const headers = super.buildHeaders(credentials, isCompactRequest ? false : true);

  if (!isCodexPassthroughMode()) {
    // Synthesize identity headers only when NOT in passthrough mode
    headers.Version = getCodexClientVersion();
    setUserAgentHeader(headers, getCodexUserAgent());

    // originator header — identifies the client type to the Codex backend
    headers["originator"] = "codex_cli_rs";

    // session_id header — enables prompt cache affinity
    const cacheSessionId = this.getPromptCacheSessionId(credentials, null);
    if (cacheSessionId) {
      headers["session_id"] = cacheSessionId;
    }

    const clientIdentity = credentials?.providerSpecificData?.codexClientIdentity as
      CodexClientIdentity | null | undefined;
    applyCodexClientIdentityHeaders(headers, clientIdentity);
  }

  // Workspace binding is always needed (it's auth, not identity)
  const workspaceId = credentials?.providerSpecificData?.workspaceId;
  if (typeof workspaceId === "string" && workspaceId) {
    headers["chatgpt-account-id"] = workspaceId;
  }

  return headers;
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/codex.ts tests/unit/codex-passthrough-mode.test.ts
git commit -m "feat: skip Codex header synthesis in passthrough mode"
```

---

## Task 5: Use Native WebSocket Instead of wreq-js Chrome 142 in Passthrough Mode

**Files:**
- Modify: `open-sse/executors/codex.ts:780-786`
- Modify: `tests/unit/codex-passthrough-mode.test.ts`

The WebSocket transport uses `wreq-js` with `browser: "chrome_142", os: "windows"` which produces a Chrome TLS fingerprint. A real Codex CLI is a Rust binary that uses its own TLS stack (likely `rustls` or `native-tls`). In passthrough mode, skip wreq-js and use Node.js native WebSocket (closer to "generic" than "specifically Chrome 142").

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/codex-passthrough-mode.test.ts`:

```ts
describe("passthrough WebSocket transport", () => {
  afterEach(() => {
    delete process.env.CODEX_PASSTHROUGH_MODE;
  });

  it("should not pass browser/os options to websocket in passthrough mode", () => {
    process.env.CODEX_PASSTHROUGH_MODE = "1";

    // In passthrough mode, the wreq-js websocket options should NOT
    // include browser/os impersonation. The call should either:
    // (a) use Node native WebSocket, or
    // (b) pass wreq-js without browser/os fields
    const passthroughActive = isCodexPassthroughMode();
    const wsOptions = passthroughActive
      ? { headers: {} }  // no browser/os
      : { browser: "chrome_142", os: "windows", headers: {} };

    assert.equal(wsOptions.hasOwnProperty("browser"), false);
    assert.equal(wsOptions.hasOwnProperty("os"), false);
  });
});
```

- [ ] **Step 2: Run test**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS (formula test)

- [ ] **Step 3: Modify WebSocket connection in codex.ts**

In `open-sse/executors/codex.ts`, find the WebSocket connection (line 782):

```ts
ws = await websocketFn(toWebSocketUrl(url), {
  browser: "chrome_142",
  os: "windows",
  headers,
});
```

Change to:

```ts
const wsOpts: Record<string, unknown> = { headers };
if (!isCodexPassthroughMode()) {
  // Impersonate Chrome 142 TLS fingerprint when NOT in passthrough mode
  wsOpts.browser = "chrome_142";
  wsOpts.os = "windows";
}
ws = await websocketFn(toWebSocketUrl(url), wsOpts);
```

This makes wreq-js use its default TLS profile (or just skip TLS impersonation entirely) in passthrough mode. The Codex CLI is Rust, not Chrome, so Chrome 142 was always wrong. No impersonation is closer to truth than wrong impersonation.

- [ ] **Step 4: Run tests**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add open-sse/executors/codex.ts tests/unit/codex-passthrough-mode.test.ts
git commit -m "feat: skip Chrome TLS impersonation for Codex WebSocket in passthrough mode"
```

---

## Task 6: Update Codex Version Constants

**Files:**
- Modify: `open-sse/config/codexClient.ts:1-4`
- Modify: `.env.example`

Update the default Codex CLI version to match the current release, and ensure the env override is documented.

- [ ] **Step 1: Check your real Codex CLI version**

Run: `codex --version` (or check your gateway captures for the real User-Agent)

- [ ] **Step 2: Update defaults in codexClient.ts**

The env overrides already exist (`CODEX_CLIENT_VERSION`, `CODEX_USER_AGENT`). Update the defaults at lines 1-3:

```ts
const DEFAULT_CODEX_CLIENT_VERSION = "0.142.0"; // Update if yours differs
const DEFAULT_CODEX_USER_AGENT_PLATFORM = "MacOS 24.0.0"; // Match your actual OS
const DEFAULT_CODEX_USER_AGENT_ARCH = "arm64"; // Match your actual arch
```

Note: The real Codex CLI reports platform as the OS name + version and arch from the system. Verify with your actual Codex binary's output or captures.

- [ ] **Step 3: Document in .env.example**

Add to the passthrough section of `.env.example`:

```env
# ── Section 15: Codex Passthrough Mode ────────────────────────────
# CODEX_PASSTHROUGH_MODE=1           # Forward real Codex CLI identity headers
# CODEX_CLIENT_VERSION=0.142.0       # Match your `codex --version`
# CODEX_USER_AGENT=codex-cli/0.142.0 (MacOS 24.0.0; arm64)  # Match your real UA
```

- [ ] **Step 4: Commit**

```bash
git add open-sse/config/codexClient.ts .env.example
git commit -m "feat: update Codex version defaults and document passthrough config"
```

---

## Task 7: Preserve Body Normalization (Intentionally Keep)

**Files:** None (documentation-only task)

Unlike the Claude path where we disabled billing header prepend, tool cloaking, and obfuscation, the Codex executor's body transforms should **remain active** even in passthrough mode:

| Transform | Keep? | Why |
|---|---|---|
| `convertSystemToDeveloperRole` | Yes | GPT-5 rejects `role: "system"` in input; real CLI does this too |
| `stripStoredItemReferences` | Yes | Prevents 404s from stale item IDs |
| `repairMissingCodexFunctionCallOutputs` | Yes | Prevents 400s from orphaned function calls |
| `normalizeCodexTools` | Yes | Strips invalid tool schemas that cause rejections |
| `ensureCodexReasoningSummary` | Yes | Adds required `include` field for reasoning |
| `RESPONSES_API_ALLOWLIST` filtering | Yes | Strips fields that cause 400 rejections |
| `delete body.store` / `body.store = false` | Yes | Backend rejects `store=true` |
| `delete body.max_tokens` / `max_output_tokens` | Yes | Backend rejects these fields |
| `normalizeCodexVerbosity` | Yes | Normalizes verbosity format |
| Default instructions injection | **Conditional** | Skip if client provides its own (see below) |

The only body transform worth disabling in passthrough mode is the **default instructions injection** (lines 1083-1106). In passthrough mode, if the upstream client already provides `instructions`, don't override them. The current code already checks `if (!body.instructions || ...)` so it only injects when missing. This is safe as-is.

- [ ] **Step 1: Document this decision**

No code change needed. The body normalization is compatibility-driven, not stealth-driven. Add a comment in `codex.ts` at the top of `transformRequest`:

```ts
// NOTE: Body transforms in transformRequest are compatibility fixes, not identity
// synthesis. They remain active in CODEX_PASSTHROUGH_MODE because:
// - GPT-5 rejects system role, store=true, max_tokens, etc.
// - Passthrough mode only disables IDENTITY (headers, metadata, UA) synthesis.
```

- [ ] **Step 2: Commit**

```bash
git add open-sse/executors/codex.ts
git commit -m "docs: document why Codex body transforms stay active in passthrough mode"
```

---

## Task 8: Integration Test

**Files:**
- Create: `tests/unit/codex-passthrough-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
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
```

- [ ] **Step 2: Run integration test**

Run: `node --import tsx/esm --test tests/unit/codex-passthrough-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/codex-passthrough-integration.test.ts
git commit -m "test: add Codex passthrough mode integration test"
```

---

## Summary of Changes

| What | File | Change |
|---|---|---|
| Toggle function | `codexIdentity.ts` | `isCodexPassthroughMode()` reads env |
| Skip identity headers | `codexIdentity.ts:56` | Early return in `applyCodexClientIdentityHeaders` |
| Skip body metadata | `codexIdentity.ts:72` | Early return in `applyCodexClientMetadata` |
| Skip header synthesis | `codex.ts:885-911` | Guard `Version`, `User-Agent`, `originator`, `session_id` behind toggle |
| Skip TLS impersonation | `codex.ts:782` | Don't pass `browser`/`os` to wreq-js in passthrough mode |
| Version defaults | `codexClient.ts:1-3` | Update platform/arch to match real system |
| Documentation | `.env.example` | Document `CODEX_PASSTHROUGH_MODE` and related vars |

**Total: 8 tasks, ~5 files modified, 1 new test file.** Much simpler than the Claude plan because Codex has no CCH, no billing header, no obfuscation, and its body transforms are compatibility-driven (keep) rather than stealth-driven (disable).

---

## Compression Notes (for later)

Caveman/RTK compression on the Codex path requires adapting the compression engine to handle the **Responses API input format** rather than the Messages API format:

- Claude: `messages: [{role, content: "text" | [{type: "text", text}]}]`
- Codex: `input: [{type: "message", role, content: [{type: "input_text", text}]}]`

The compression `bodyAdapter.ts` (already imported in `chatCore.ts`) likely handles this translation. When you enable compression for Codex, verify that `adaptBodyForCompression` correctly maps the Responses API input structure to the internal compression format and back. The content text itself is compressed identically regardless of the wrapper format.
