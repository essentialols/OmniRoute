/**
 * Regression test: Codex CLI over OmniRoute -> Gemini failed with
 * "[400]: Function calling config is set without function_declarations."
 *
 * Codex always injects a `web_search` built-in tool alongside its real function tools
 * (shell, apply_patch, update_plan, ...). buildGeminiTools() previously short-circuited on
 * the googleSearch built-in and returned ONLY [{ googleSearch: {} }], discarding every
 * function declaration. The openai-to-gemini translator then still emitted
 * toolConfig.functionCallingConfig, so Gemini received a function-calling config with zero
 * declarations and rejected the whole request.
 *
 * The declarations must win when both are present (Gemini cannot mix the googleSearch
 * built-in with functionDeclarations in one request anyway).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGeminiTools } from "../../open-sse/translator/helpers/geminiToolsSanitizer.ts";

type GeminiToolShape = {
  functionDeclarations?: Array<{ name: string }>;
  googleSearch?: Record<string, unknown>;
};

describe("buildGeminiTools: web_search built-in must not drop function declarations", () => {
  it("keeps function declarations when a web_search tool is also present (Codex shape)", () => {
    const tools = buildGeminiTools([
      { type: "function", function: { name: "shell", parameters: { type: "object" } } },
      { type: "function", function: { name: "apply_patch", parameters: { type: "object" } } },
      { type: "web_search", external_web_access: false },
    ]) as GeminiToolShape[] | undefined;

    assert.ok(Array.isArray(tools), "expected a tools array");
    assert.equal(tools.length, 1, "expected a single functionDeclarations tool");
    const decls = tools[0].functionDeclarations;
    assert.ok(Array.isArray(decls), "expected functionDeclarations");
    assert.equal(decls.length, 2, "both function declarations preserved");
    assert.deepEqual(
      decls.map((d) => d.name),
      ["shell", "apply_patch"]
    );
    // No googleSearch entry should leak in alongside the declarations.
    assert.ok(
      !tools.some((t) => t.googleSearch),
      "googleSearch must not be mixed with functionDeclarations"
    );
  });

  it("still returns a googleSearch-only tool when there are no function declarations", () => {
    const tools = buildGeminiTools([{ type: "web_search", external_web_access: false }]) as
      GeminiToolShape[] | undefined;
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0], { googleSearch: {} });
  });
});
