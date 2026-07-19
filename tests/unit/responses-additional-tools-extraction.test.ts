import test from "node:test";
import assert from "node:assert/strict";

const { openaiResponsesToOpenAIRequest } =
  await import("../../open-sse/translator/request/openai-responses.ts");

// Newer Codex CLI (composer / experimental exec mode) does NOT declare tools at the
// top-level Responses `tools` field. Instead it packs them into an `input` item of
// `type: "additional_tools"` (role "developer") whose `.tools` array carries the real
// tool declarations (exec composer, function tools, and MCP `namespace` groups).
//
// Before the fix, the translator only read `root.tools`, so an additional_tools-only
// request produced NO structured `tools` array upstream. The local native-tool-capable
// model (rapid-mlx with --enable-auto-tool-choice) received tools=0, no tool grammar
// engaged, and Codex looped without ever making a real tool call. The additional_tools
// item was also silently dropped (matched no branch in the item loop), so the tools were
// not even inlined as text.
//
// The fix: extract tool declarations from every `additional_tools` input item and run
// them through the same conversion as top-level tools, so the upstream receives a real
// structured `tools` array; and skip the additional_tools item in the message loop so it
// never leaks into the conversation as a message.
test("Responses -> Chat: tools packed in an additional_tools input item become a structured tools array", () => {
  const result = openaiResponsesToOpenAIRequest(
    "m2/M1y",
    {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "custom", name: "exec", description: "Run JavaScript to orchestrate tools" },
            {
              type: "function",
              name: "wait",
              description: "Wait for a duration",
              parameters: {
                type: "object",
                properties: { seconds: { type: "number" } },
                required: ["seconds"],
              },
            },
            {
              type: "namespace",
              name: "collaboration",
              tools: [
                {
                  name: "mcp__collab__get_profile",
                  description: "Get a profile",
                  parameters: { type: "object", properties: { id: { type: "string" } } },
                },
              ],
            },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      ],
      tool_choice: "auto",
    },
    true,
    {}
  );

  // 1) A non-empty structured tools array must be produced (NOT inlined as text).
  assert.equal(Array.isArray(result.tools), true, "expected a structured tools array");
  assert.ok(result.tools.length >= 3, `expected >=3 tools, got ${result.tools?.length}`);

  const byName = new Map(result.tools.map((t) => [t.function?.name, t]));

  // exec: custom tool normalized to a { input: string } function schema.
  const exec = byName.get("exec");
  assert.ok(exec, "exec tool must be present");
  assert.equal(exec.type, "function");
  assert.deepEqual(exec.function.parameters, {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  });

  // wait: plain function tool preserved with its parameters.
  const wait = byName.get("wait");
  assert.ok(wait, "wait tool must be present");
  assert.equal(wait.type, "function");
  assert.deepEqual(wait.function.parameters, {
    type: "object",
    properties: { seconds: { type: "number" } },
    required: ["seconds"],
  });

  // namespace MCP group flattened to a standalone function.
  const mcp = byName.get("mcp__collab__get_profile");
  assert.ok(mcp, "flattened MCP namespace tool must be present");
  assert.equal(mcp.type, "function");

  // 2) The additional_tools item must NOT leak into the conversation as a message.
  const roles = result.messages.map((m) => m.role);
  assert.equal(
    roles.includes("developer"),
    false,
    "additional_tools item must not appear as a developer message"
  );
  // The genuine user message survives.
  assert.ok(
    result.messages.some((m) => m.role === "user"),
    "user message must be preserved"
  );
});

// Top-level tools and additional_tools tools must merge (a request may carry both).
test("Responses -> Chat: top-level tools and additional_tools tools are merged", () => {
  const result = openaiResponsesToOpenAIRequest(
    "m2/M1y",
    {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "custom", name: "exec", description: "exec" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      tools: [
        {
          type: "function",
          name: "top_level_fn",
          description: "a top level tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    true,
    {}
  );

  const names = new Set(result.tools.map((t) => t.function?.name));
  assert.ok(names.has("exec"), "additional_tools tool must be present");
  assert.ok(names.has("top_level_fn"), "top-level tool must be present");
});
