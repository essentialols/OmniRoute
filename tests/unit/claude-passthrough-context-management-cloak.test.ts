// tests/unit/claude-passthrough-context-management-cloak.test.ts
//
// Request-shape regression guard for the Claude passthrough bug (verified live
// against Anthropic): with CLAUDE_PASSTHROUGH_MODE=1 OmniRoute shipped an INVALID
// request. Two symptoms, one env toggle:
//   - full Claude-Code headers -> 400 "context_management: Extra inputs are not
//     permitted" (OmniRoute's thinking pairing injected a top-level
//     context_management the forwarded anthropic-beta did not negotiate).
//   - minimal (non-CC) client   -> 429 (uncloaked synthesized identity: passthrough
//     disabled the identity cloak even when there was no genuine CC identity to
//     forward).
//
// These tests drive the exact helpers `open-sse/executors/base.ts` now calls
// (`passthroughForwardsRealCcIdentity`, `stripPassthroughInjectedContextManagement`,
// `shouldCloakClaudeIdentity`) so the outbound-body shape is asserted end-to-end.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  passthroughForwardsRealCcIdentity,
  shouldCloakClaudeIdentity,
  stripPassthroughInjectedContextManagement,
} from "../../open-sse/executors/claudeIdentity.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

// Headers a real claude-cli session forwards (minimal: just its session id).
const minimalCcHeaders: Record<string, string> = {
  "x-claude-code-session-id": SESSION_ID,
};

// Full captured Claude-Code header set.
const fullCcHeaders: Record<string, string> = {
  "x-claude-code-session-id": SESSION_ID,
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.195 (external, cli)",
  "x-stainless-package-version": "0.94.0",
  "x-stainless-lang": "js",
  "x-stainless-runtime": "node",
  "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
};

// A plain, non-Claude-Code client (no CC/Stainless identity to forward).
const nonCcHeaders: Record<string, string> = {
  "user-agent": "python-requests/2.31.0",
  accept: "application/json",
};

// The transformed body as it looks right before serialization, AFTER OmniRoute's
// thinking pairing has injected a top-level context_management (the exact field
// Anthropic 400'd on).
function bodyWithInjectedContextManagement(): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    thinking: { type: "adaptive" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
  };
}

describe("passthroughForwardsRealCcIdentity — genuine CC identity detection", () => {
  it("true when a valid CC session-id header is forwarded (minimal client)", () => {
    assert.equal(passthroughForwardsRealCcIdentity(minimalCcHeaders), true);
  });

  it("true for a full Claude-Code header set", () => {
    assert.equal(passthroughForwardsRealCcIdentity(fullCcHeaders), true);
  });

  it("true from the Stainless package-version marker alone", () => {
    assert.equal(
      passthroughForwardsRealCcIdentity({ "x-stainless-package-version": "0.94.0" }),
      true
    );
  });

  it("true from x-app:cli alone", () => {
    assert.equal(passthroughForwardsRealCcIdentity({ "x-app": "cli" }), true);
  });

  it("true from a claude-code / claude-cli user agent", () => {
    assert.equal(passthroughForwardsRealCcIdentity({ "user-agent": "claude-code/1.2" }), true);
    assert.equal(passthroughForwardsRealCcIdentity({ "User-Agent": "claude-cli/2.0" }), true);
  });

  it("false for a non-CC client, empty headers, and null", () => {
    assert.equal(passthroughForwardsRealCcIdentity(nonCcHeaders), false);
    assert.equal(passthroughForwardsRealCcIdentity({}), false);
    assert.equal(passthroughForwardsRealCcIdentity(null), false);
    assert.equal(passthroughForwardsRealCcIdentity(undefined), false);
  });

  it("false for a malformed (non-UUID) session id", () => {
    assert.equal(passthroughForwardsRealCcIdentity({ "x-claude-code-session-id": "nope" }), false);
  });
});

describe("outbound Claude request shape in passthrough — no top-level context_management", () => {
  // The bug: strict Anthropic rejects a top-level context_management the forwarded
  // beta does not negotiate. The outbound body must NOT carry it in passthrough.
  it("minimal CC client: context_management is stripped", () => {
    const forwardsRealCc = passthroughForwardsRealCcIdentity(minimalCcHeaders); // true
    const body = bodyWithInjectedContextManagement();
    stripPassthroughInjectedContextManagement(body, forwardsRealCc);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "context_management"),
      false,
      "minimal CC client must not ship a top-level context_management"
    );
    // Everything else the forwarded request needs is preserved.
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.model, "claude-opus-4-8");
  });

  it("full CC headers client: context_management is stripped", () => {
    const forwardsRealCc = passthroughForwardsRealCcIdentity(fullCcHeaders); // true
    const body = bodyWithInjectedContextManagement();
    stripPassthroughInjectedContextManagement(body, forwardsRealCc);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "context_management"),
      false,
      "full CC headers client must not ship a top-level context_management"
    );
  });
});

describe("non-CC passthrough fallback preserves the synthesis path", () => {
  // A non-CC caller falls back to full cloaked synthesis, which negotiates the
  // matching beta itself; its context_management must be LEFT intact (that path is
  // the same one that already returns 200 with passthrough off).
  it("strip is a no-op when not forwarding a real CC identity", () => {
    const forwardsRealCc = passthroughForwardsRealCcIdentity(nonCcHeaders); // false
    const body = bodyWithInjectedContextManagement();
    stripPassthroughInjectedContextManagement(body, forwardsRealCc);
    assert.deepEqual(body.context_management, {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
  });
});

describe("shouldCloakClaudeIdentity — identity cloak decision", () => {
  it("non-CC client in passthrough falls back to a CLOAKED identity (fixes 429)", () => {
    const cloak = shouldCloakClaudeIdentity({
      isClaudeCodeClient: false,
      hasClaudeOAuthToken: true,
      passthroughActive: true,
      clientHeaders: nonCcHeaders,
    });
    assert.equal(cloak, true, "no real CC identity to forward -> must cloak");
  });

  it("real CC client in passthrough forwards its identity verbatim (NOT cloaked)", () => {
    const cloak = shouldCloakClaudeIdentity({
      isClaudeCodeClient: true,
      hasClaudeOAuthToken: true,
      passthroughActive: true,
      clientHeaders: fullCcHeaders,
    });
    assert.equal(cloak, false, "genuine CC identity -> forward verbatim");
  });

  it("cloaks whenever passthrough is off (unchanged legacy behavior)", () => {
    assert.equal(
      shouldCloakClaudeIdentity({
        isClaudeCodeClient: true,
        hasClaudeOAuthToken: true,
        passthroughActive: false,
        clientHeaders: fullCcHeaders,
      }),
      true
    );
  });

  it("does not cloak a non-Claude request (no CC client, no OAuth token)", () => {
    assert.equal(
      shouldCloakClaudeIdentity({
        isClaudeCodeClient: false,
        hasClaudeOAuthToken: false,
        passthroughActive: false,
        clientHeaders: nonCcHeaders,
      }),
      false
    );
  });
});
