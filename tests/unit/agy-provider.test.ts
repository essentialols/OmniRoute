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
  isDiscoverableAntigravityModelId,
  isUserCallableAntigravityModelId,
  getClientVisibleAntigravityModelName,
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

test("agy ships the merged catalog (union of both former providers, reconciled against upstream's current live set)", () => {
  const ids = REGISTRY.agy.models.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-6-thinking"), "must expose Claude Opus 4.6 Thinking");
  assert.ok(ids.includes("claude-sonnet-4-6"), "must expose Claude Sonnet 4.6");
  assert.ok(ids.includes("gemini-3.7-flash-low"), "must expose Gemini 3.7 Flash Low");
  assert.ok(ids.includes("gemini-3.7-flash-medium"), "must expose Gemini 3.7 Flash Medium");
  assert.ok(ids.includes("gemini-3.7-flash-high"), "must expose Gemini 3.7 Flash High");
  assert.ok(ids.includes("gemini-3.7-flash-tiered"), "must expose Gemini 3.7 Flash Tiered");
  assert.ok(!ids.includes("gemini-3.6-flash-low"));
  assert.ok(!ids.includes("gemini-3.6-flash-medium"));
  assert.ok(!ids.includes("gemini-3.6-flash-high"));
  assert.ok(!ids.includes("gemini-3.5-flash"));
  // Retired as of v3.8.50's live catalog: no longer part of the merged union.
  assert.ok(!ids.includes("claude-sonnet-5"), "retired upstream, must not be exposed");
  assert.ok(!ids.includes("gemini-3-pro-preview"), "retired upstream, must not be exposed");
  assert.ok(!ids.includes("gemini-2.5-computer-use-preview-10-2025"), "retired upstream");
  assert.ok(!ids.includes("gemini-3.5-flash-extra-low"));
  assert.ok(!ids.includes("gemini-3.5-flash-low"));
  assert.ok(!ids.includes("gemini-3-flash-agent"));
  assert.ok(!ids.includes("gemini-3.5-flash-medium"));
  assert.ok(!ids.includes("gemini-3.5-flash-high"));
  assert.ok(!ids.includes("gemini-3.5-flash-preview"));
  assert.ok(!ids.includes("gemini-3-flash"));
  assert.ok(ids.includes("gemini-pro-agent"), "must expose callable Pro High id");
  assert.ok(!ids.includes("gemini-2.5-pro"), "must not expose unavailable Gemini 2.5 Pro");
  assert.ok(!ids.includes("gemini-2.5-flash"));
  assert.ok(!ids.includes("gemini-2.5-flash-lite"));
  // Tab-completion models are not chat-callable and must be excluded.
  assert.ok(!ids.includes("tab_flash_lite_preview"));
  assert.ok(!ids.includes("tab_jump_flash_lite_preview"));
  assert.equal(ids.length, ANTIGRAVITY_PUBLIC_MODELS.length);
});

test("agy model helpers resolve catalog ids and display names", () => {
  assert.equal(isUserCallableAntigravityModelId("claude-opus-4-6-thinking"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-pro"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-flash"), false);
  // Not separately advertised (the live discovery slot 400s), but still resolves via
  // ANTIGRAVITY_MODEL_ALIASES to gemini-pro-agent, so it stays callable rather than a
  // dead end for anyone holding the old id.
  assert.equal(isUserCallableAntigravityModelId("gemini-3.1-pro-high"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-pro-agent"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.7-flash-low"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.7-flash-medium"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.7-flash-high"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.7-flash-tiered"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.6-flash-low"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.6-flash-medium"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.6-flash-high"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash-extra-low"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash-low"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3-flash-agent"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash-medium"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash-high"), false);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.5-flash-preview"), false);
  assert.equal(isUserCallableAntigravityModelId("tab_flash_lite_preview"), false);
  assert.equal(isUserCallableAntigravityModelId(""), false);
  assert.equal(
    getClientVisibleAntigravityModelName("claude-opus-4-6-thinking"),
    "Claude Opus 4.6 (Thinking)"
  );
  assert.equal(getClientVisibleAntigravityModelName("gemini-pro-agent"), "Gemini 3.1 Pro (High)");
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.7-flash-low"),
    "Gemini 3.7 Flash (Low)"
  );
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.7-flash-medium"),
    "Gemini 3.7 Flash (Medium)"
  );
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.7-flash-high"),
    "Gemini 3.7 Flash (High)"
  );
  assert.equal(getClientVisibleAntigravityModelName("unknown-model", "Fallback"), "Fallback");
});

test("agy live discovery accepts new chat models while excluding tab-completion models", () => {
  assert.equal(isDiscoverableAntigravityModelId("gemini-new-live-tier"), true);
  assert.equal(isDiscoverableAntigravityModelId("gemini-3.6-flash-high"), false);
  assert.equal(isDiscoverableAntigravityModelId("gemini-3-flash-agent"), false);
  assert.equal(isDiscoverableAntigravityModelId("gemini-2.5-flash"), false);
  assert.equal(isDiscoverableAntigravityModelId("tab_flash_lite_preview"), false);
  assert.equal(isDiscoverableAntigravityModelId("tab_jump_flash_lite_preview"), false);
  assert.equal(isDiscoverableAntigravityModelId(""), false);
});

test("agy token refresh is wired on the Google (non-rotating) refresh path", () => {
  assert.equal(supportsTokenRefresh("agy"), true);
  // Same 15-minute proactive lead as antigravity (Google refresh tokens are permanent).
  assert.equal(REFRESH_LEAD_MS.agy, REFRESH_LEAD_MS.antigravity);
});
