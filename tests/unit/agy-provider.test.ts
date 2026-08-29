import test from "node:test";
import assert from "node:assert/strict";

import { AI_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { PROVIDERS as LEGACY_PROVIDERS } from "../../open-sse/config/constants.ts";
import {
  PROVIDERS as OAUTH_PROVIDER_IDS,
  AGY_CONFIG,
} from "../../src/lib/oauth/constants/oauth.ts";
import { supportsTokenRefresh, REFRESH_LEAD_MS } from "../../open-sse/services/tokenRefresh.ts";
import {
  ANTIGRAVITY_PUBLIC_MODELS,
  isUserCallableAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";

test("agy is registered as an OAuth provider in the UI catalog", () => {
  const agy = AI_PROVIDERS.agy;
  assert.ok(agy, "AI_PROVIDERS.agy must exist");
  assert.equal(agy.id, "agy");
  assert.equal(agy.name, "Antigravity");
  assert.equal(agy.alias, "agy", "agy stays the advertised alias/prefix");
  assert.equal(agy.riskNoticeVariant, "oauth");
  assert.equal(agy.subscriptionRisk, true);
});

test("agy supports the usage/quota API", () => {
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("agy"));
});

test("agy registry entry reuses the antigravity backend (no duplicate executor/format)", () => {
  const agy = REGISTRY.agy;
  assert.ok(agy, "REGISTRY.agy must exist");
  assert.equal(agy.format, "antigravity");
  assert.equal(agy.executor, "antigravity");
  assert.equal(agy.authType, "oauth");
  assert.equal(agy.authHeader, "bearer");
  assert.equal(agy.passthroughModels, true);
});

test("agy carries the merged Antigravity Google OAuth credentials", () => {
  // `antigravity` was merged into `agy`; its OAuth client is now the only one.
  assert.ok(LEGACY_PROVIDERS.agy.clientId);
  assert.ok(LEGACY_PROVIDERS.agy.clientSecret);
  assert.equal(AGY_CONFIG.clientId, LEGACY_PROVIDERS.agy.clientId);
  assert.equal(OAUTH_PROVIDER_IDS.AGY, "agy");
  assert.equal(LEGACY_PROVIDERS.antigravity, undefined, "duplicate entry must be gone");
});

test("agy ships the merged catalog (union of both former providers)", () => {
  const ids = REGISTRY.agy.models.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-6-thinking"), "must expose Claude Opus 4.6 Thinking");
  assert.ok(ids.includes("claude-sonnet-4-6"), "must expose Claude Sonnet 4.6");
  // Inherited from the former `antigravity` catalog by the merge.
  assert.ok(ids.includes("claude-sonnet-5"), "must inherit Claude Sonnet 5");
  assert.ok(ids.includes("gemini-3-pro-preview"), "must inherit Gemini 3 Pro Preview");
  assert.ok(ids.includes("gemini-3.5-flash-low"), "must expose clean Flash Low tier");
  assert.ok(ids.includes("gemini-3.5-flash-medium"), "must expose clean Flash Medium tier");
  assert.ok(ids.includes("gemini-3.5-flash-high"), "must expose clean Flash High tier");
  assert.ok(!ids.includes("gemini-3-flash-agent"));
  assert.ok(!ids.includes("gemini-3-flash"));
  assert.ok(!ids.includes("gemini-3.5-flash-extra-low"));
  // Tab-completion models are not chat-callable and must be excluded.
  assert.ok(!ids.includes("tab_flash_lite_preview"));
  assert.ok(!ids.includes("tab_jump_flash_lite_preview"));
  assert.equal(ids.length, ANTIGRAVITY_PUBLIC_MODELS.length);
});

test("agy model helpers resolve catalog ids", () => {
  assert.equal(isUserCallableAntigravityModelId("claude-opus-4-6-thinking"), true);
  assert.equal(isUserCallableAntigravityModelId("tab_flash_lite_preview"), false);
  assert.equal(isUserCallableAntigravityModelId(""), false);
});

test("agy token refresh is wired on the Google (non-rotating) refresh path", () => {
  assert.equal(supportsTokenRefresh("agy"), true);
  // Same 15-minute proactive lead as antigravity (Google refresh tokens are permanent).
  assert.equal(REFRESH_LEAD_MS.agy, REFRESH_LEAD_MS.antigravity);
});
