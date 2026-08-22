import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Per-provider PII trust tiering (operator-approved, see piiTrust.ts).
//
// PII redaction is decided by the DESTINATION provider's trust tier when no
// explicit global override is set:
//   - TRUSTED (gemini / cc / local / privatemode / codex / antigravity …) → NOT mutated
//   - UNTRUSTED (deepseek / glm-web / zai / kimi / qwen …)                → mutated
// An explicit global PII flag (env or DB) overrides uniformly for all providers.
//
// This complements (does not replace) the opt-in default guard in
// pii-opt-in-default.test.ts: with no override AND no destination provider,
// bare sanitizePII() still passes data through untouched.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-pii-trust-"));
process.env.DATA_DIR = tmpDir;

// Ensure a clean, override-free baseline so the trust-tiered DEFAULT is exercised.
delete process.env.PII_REDACTION_ENABLED;
delete process.env.PII_RESPONSE_SANITIZATION;
delete process.env.INPUT_SANITIZER_MODE;
delete process.env.PII_RESPONSE_SANITIZATION_MODE;

const { clearAllFeatureFlagOverrides } = await import("@/lib/db/featureFlags");
clearAllFeatureFlagOverrides();

const { isTrustedProvider, shouldRedactPiiForProvider, PII_TRUSTED_PROVIDERS } =
  await import("@/lib/guardrails/piiTrust");
const { PIIMaskerGuardrail } = await import("@/lib/guardrails/piiMasker");

const EMAIL = "reach me at jane.doe@example.com";

const requestPayload = () => ({
  messages: [{ role: "user", content: EMAIL }],
});
const responsePayload = () => ({
  choices: [{ message: { role: "assistant", content: EMAIL } }],
});

test("trust classification", async (t) => {
  await t.test("trusted providers are classified trusted", () => {
    for (const p of ["gemini", "cc", "claude", "codex", "antigravity", "agy", "privatemode"]) {
      assert.equal(isTrustedProvider(p), true, `${p} should be trusted`);
    }
    // local-ish heuristics
    assert.equal(isTrustedProvider("local"), true);
    assert.equal(isTrustedProvider("local-custom"), true);
    assert.equal(isTrustedProvider("ollama-remote"), true);
  });

  await t.test("untrusted providers are classified untrusted", () => {
    for (const p of [
      "deepseek",
      "deepseek-web",
      "kimi",
      "qwen-web",
      "glm",
      "glm-web",
      "zai",
      "zai-web",
      "siliconflow",
      "baidu",
      "tencent",
      "bazaarlink",
    ]) {
      assert.equal(isTrustedProvider(p), false, `${p} should be untrusted`);
    }
  });

  await t.test("missing provider is treated as trusted (no context → no mutation)", () => {
    assert.equal(isTrustedProvider(null), true);
    assert.equal(isTrustedProvider(undefined), true);
    assert.equal(isTrustedProvider(""), true);
  });

  await t.test("PII_TRUSTED_PROVIDERS contains the operator-approved core set", () => {
    for (const p of [
      "local",
      "privatemode",
      "cc",
      "claude",
      "codex",
      "gemini",
      "agy",
      "antigravity",
    ]) {
      assert.equal(PII_TRUSTED_PROVIDERS.has(p), true, `set should contain ${p}`);
    }
  });
});

test("shouldRedactPiiForProvider default (no override) is trust-tiered", () => {
  clearAllFeatureFlagOverrides();
  for (const flag of ["PII_REDACTION_ENABLED", "PII_RESPONSE_SANITIZATION"]) {
    assert.equal(shouldRedactPiiForProvider("gemini", flag), false, `${flag}/gemini`);
    assert.equal(shouldRedactPiiForProvider("cc", flag), false, `${flag}/cc`);
    assert.equal(shouldRedactPiiForProvider("local", flag), false, `${flag}/local`);
    assert.equal(shouldRedactPiiForProvider("deepseek", flag), true, `${flag}/deepseek`);
    assert.equal(shouldRedactPiiForProvider("glm-web", flag), true, `${flag}/glm-web`);
    assert.equal(shouldRedactPiiForProvider("zai", flag), true, `${flag}/zai`);
    // No destination context → do not mutate by default
    assert.equal(shouldRedactPiiForProvider(null, flag), false, `${flag}/null`);
  }
});

test("explicit global override wins uniformly for all providers", () => {
  clearAllFeatureFlagOverrides();
  // Force ON via env → even trusted providers redact.
  process.env.PII_RESPONSE_SANITIZATION = "true";
  assert.equal(shouldRedactPiiForProvider("gemini", "PII_RESPONSE_SANITIZATION"), true);
  assert.equal(shouldRedactPiiForProvider("deepseek", "PII_RESPONSE_SANITIZATION"), true);
  // Force OFF via env → even untrusted providers pass through.
  process.env.PII_RESPONSE_SANITIZATION = "false";
  assert.equal(shouldRedactPiiForProvider("deepseek", "PII_RESPONSE_SANITIZATION"), false);
  assert.equal(shouldRedactPiiForProvider("gemini", "PII_RESPONSE_SANITIZATION"), false);
  delete process.env.PII_RESPONSE_SANITIZATION;
});

test("PIIMaskerGuardrail request-side is trust-tiered by destination provider", async (t) => {
  clearAllFeatureFlagOverrides();
  const guardrail = new PIIMaskerGuardrail();

  await t.test("gemini/cc/local requests are NOT mutated", async () => {
    for (const provider of ["gemini", "cc", "local"]) {
      const res = await guardrail.preCall(requestPayload(), { provider });
      assert.equal(res?.modifiedPayload, undefined, `${provider} request must not be mutated`);
    }
  });

  await t.test("deepseek/glm-web/zai requests ARE mutated", async () => {
    for (const provider of ["deepseek", "glm-web", "zai"]) {
      const res = await guardrail.preCall(requestPayload(), { provider });
      assert.ok(res?.modifiedPayload, `${provider} request must be mutated`);
      const payload = res!.modifiedPayload as { messages: Array<{ content: string }> };
      const content = String(payload.messages?.[0]?.content);
      assert.match(content, /\[EMAIL_REDACTED\]/, `${provider} email must be redacted`);
    }
  });
});

test("PIIMaskerGuardrail response-side is trust-tiered by destination provider", async (t) => {
  clearAllFeatureFlagOverrides();
  const guardrail = new PIIMaskerGuardrail();

  await t.test("gemini/cc/local responses are NOT mutated", async () => {
    for (const provider of ["gemini", "cc", "local"]) {
      const res = await guardrail.postCall(responsePayload(), { provider });
      assert.equal(res?.modifiedResponse, undefined, `${provider} response must not be mutated`);
    }
  });

  await t.test("deepseek/glm-web/zai responses ARE mutated", async () => {
    for (const provider of ["deepseek", "glm-web", "zai"]) {
      const res = await guardrail.postCall(responsePayload(), { provider });
      assert.ok(res?.modifiedResponse, `${provider} response must be mutated`);
      const resp = res!.modifiedResponse as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = String(resp.choices?.[0]?.message?.content);
      assert.match(content, /\[EMAIL_REDACTED\]/, `${provider} email must be redacted`);
    }
  });
});
