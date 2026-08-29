import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { REGISTRY, getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { PROVIDERS } from "../../open-sse/config/constants.ts";
import { getModelsByProviderId, isValidModel } from "../../src/shared/constants/models.ts";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.ts";
import { providerSupportsSystemMessage } from "../../src/lib/memory/injection.ts";

// `qianfan` was a duplicate registration of the same qianfan.baidubce.com ERNIE
// endpoint as `baidu`. It was merged into `baidu`; the retired id still routes.

test("the retired qianfan id resolves to the canonical baidu provider", () => {
  assert.equal(REGISTRY.qianfan, undefined, "qianfan must no longer be its own entry");
  assert.equal(APIKEY_PROVIDERS.qianfan, undefined, "and must not be offered in the picker");

  const resolved = getRegistryEntry("qianfan");
  assert.ok(resolved, "qianfan must still resolve for stored connections and legacy refs");
  assert.equal(resolved.id, "baidu");
});

test("baidu registers the ERNIE endpoint as an OpenAI-compatible API key provider", () => {
  const entry = getRegistryEntry("baidu");

  assert.ok(entry);
  assert.equal(entry.id, "baidu");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "default");
  assert.equal(PROVIDERS.baidu.baseUrl, "https://qianfan.baidubce.com/v2/chat/completions");
  // Folded in from qianfan, which was the only side that carried it. modelsUrl lives on
  // the registry entry; the legacy PROVIDERS shape does not carry it.
  assert.equal(entry.modelsUrl, "https://qianfan.baidubce.com/v2/models");
});

test("baidu exposes the merged ERNIE catalog", () => {
  const ids = getModelsByProviderId("baidu").map((model) => model.id);

  assert.ok(ids.includes("ernie-5.1"));
  assert.ok(ids.includes("ernie-x1.1"));
  // Inherited from qianfan by the merge.
  assert.ok(ids.includes("ernie-5.0-thinking-latest"));
  assert.equal(isValidModel("baidu", "ernie-5.1"), true);
});

test("ERNIE system-role normalization survives the merge", () => {
  // qianfan was the only id flagged here before the merge; baidu serves the same
  // upstream, which rejects a system role.
  assert.equal(providerSupportsSystemMessage("baidu"), false);
  assert.equal(providerSupportsSystemMessage("qianfan"), false);
});

test("the qianfan icon asset is retained for legacy connections", () => {
  assert.ok(existsSync(join(process.cwd(), "public", "providers", "qianfan.svg")));
});
