// Regression: isImageOnlyModel() must distinguish pure image-generation models from
// dual-purpose ids that are registered as BOTH an image model and a chat model.
//
// Bug: the chat endpoint guarded with getImageModelEntry(modelStr) truthiness, which
// rejected codex/gpt-5.5 (a legit chat model that ALSO backs codex image generation)
// with "is an image-generation model and cannot be used on /v1/chat/completions".
// The correct discriminator is: image-registered AND not also a curated chat model.
import test from "node:test";
import assert from "node:assert/strict";

import { isImageOnlyModel, getImageModelEntry } from "@omniroute/open-sse/config/imageRegistry.ts";
import { getProviderModels } from "@omniroute/open-sse/config/providerModels.ts";

test("codex/gpt-5.5 is dual-purpose: image-registered but NOT image-only", () => {
  // Preconditions that make this a real dual-purpose collision.
  assert.ok(
    getImageModelEntry("codex/gpt-5.5"),
    "precondition: gpt-5.5 is in the codex image registry"
  );
  assert.ok(
    getProviderModels("codex").some((m) => m.id === "gpt-5.5"),
    "precondition: gpt-5.5 is a curated codex chat model"
  );
  assert.equal(isImageOnlyModel("codex/gpt-5.5"), false, "dual-purpose id must not be image-only");
  assert.equal(isImageOnlyModel("cx/gpt-5.5"), false, "alias form must resolve identically");
});

test("pure image models remain image-only", () => {
  // chatgpt-web/gpt-5.3-instant is in the image registry but is NOT a chatgpt-web chat model.
  assert.ok(getImageModelEntry("chatgpt-web/gpt-5.3-instant"), "precondition: image-registered");
  assert.equal(
    getProviderModels("chatgpt-web").some((m) => m.id === "gpt-5.3-instant"),
    false,
    "precondition: not a curated chatgpt-web chat model"
  );
  assert.equal(isImageOnlyModel("chatgpt-web/gpt-5.3-instant"), true);
});

test("non-image chat models are not flagged", () => {
  assert.equal(
    isImageOnlyModel("openai/gpt-4o"),
    false,
    "chat-only model is not in the image registry"
  );
});
