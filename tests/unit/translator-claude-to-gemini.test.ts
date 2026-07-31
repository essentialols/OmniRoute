import test from "node:test";
import assert from "node:assert/strict";

const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { DEFAULT_SAFETY_SETTINGS } =
  await import("../../open-sse/translator/helpers/geminiHelper.ts");
const { buildGeminiThoughtSignatureKey, storeGeminiThoughtSignature } =
  await import("../../open-sse/services/geminiThoughtSignatureStore.ts");

function seedSignature(namespace: string, toolCallId: string, signature: string) {
  storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(namespace, toolCallId), signature);
}

function flattenParts(contents: unknown): Record<string, unknown>[] {
  return (contents as Array<{ parts: Record<string, unknown>[] }>).flatMap(
    (content) => content.parts
  );
}

type UnknownRecord = Record<string, unknown>;

function getFunctionDeclarationParameters(parameters: unknown) {
  assert.ok(
    parameters && typeof parameters === "object",
    "expected function declaration parameters"
  );
  return parameters as UnknownRecord & {
    properties?: Record<string, UnknownRecord>;
    examples?: unknown;
  };
}

function getFunctionCall(part: unknown) {
  assert.ok(part && typeof part === "object", "expected Gemini part");
  const functionCall = (part as UnknownRecord).functionCall;
  assert.ok(functionCall && typeof functionCall === "object", "expected functionCall");
  return functionCall as { name: string };
}

function getFunctionResponse(part: unknown) {
  assert.ok(part && typeof part === "object", "expected Gemini part");
  const functionResponse = (part as UnknownRecord).functionResponse;
  assert.ok(functionResponse && typeof functionResponse === "object", "expected functionResponse");
  return functionResponse as { name: string };
}

test("Claude -> Gemini maps system, thinking, tool use, tool result and tools", () => {
  const ns = "conn-map-basics";
  seedSignature(ns, "tu_1", "SIG_MAP_BASICS");
  const result = claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      system: [{ text: "Rules" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "need tool" },
            { type: "tool_use", id: "tu_1", name: "weather", input: { city: "Tokyo" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "text", text: "20C" }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: ["string", "null"] } },
          },
        },
      ],
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.8,
      thinking: { type: "enabled", budget_tokens: 512 },
    },
    false,
    { _signatureNamespace: ns }
  );

  assert.deepEqual(result.systemInstruction, {
    role: "system",
    parts: [{ text: "Rules" }],
  });
  assert.equal(result.contents[0].role, "model");
  assert.deepEqual(result.contents[0].parts[0] as any, { thought: true, text: "need tool" });
  assert.deepEqual(result.contents[0].parts[1] as any, {
    thoughtSignature: "SIG_MAP_BASICS",
    functionCall: { id: "tu_1", name: "weather", args: { city: "Tokyo" } },
  });
  assert.deepEqual(result.contents[1].parts[0] as any, {
    functionResponse: {
      id: "tu_1",
      name: "weather",
      response: { result: { result: "20C" } },
    },
  });
  assert.equal(result.generationConfig.maxOutputTokens, 256);
  assert.match((result as any).tools[0].functionDeclarations[0].name, /^[a-zA-Z0-9_]+$/);
  assert.equal(result.generationConfig.temperature, 0.4);
  assert.equal(result.generationConfig.topP, 0.8);
  assert.deepEqual(result.generationConfig.thinkingConfig, {
    thinkingBudget: 512,
    includeThoughts: true,
  });
  assert.deepEqual(result.safetySettings, DEFAULT_SAFETY_SETTINGS);
  assert.deepEqual((result as any).tools[0].functionDeclarations[0].parameters, {
    type: "object",
    properties: { city: { type: "string" } },
  });
});

test("Claude -> Gemini clamps maxOutputTokens to the model cap", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-flash",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      max_tokens: 999999,
    },
    false
  );

  // #3358 added the gemini-2.5-flash model spec (real cap 65536, not the old
  // 8192 default). An over-cap request clamps to the model's true max output.
  assert.equal(result.generationConfig.maxOutputTokens, 65536);
});

test("Claude -> Gemini preserves requested maxOutputTokens when the model cap is unknown", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      max_tokens: 32000,
    },
    false
  );

  assert.equal(result.generationConfig.maxOutputTokens, 32000);
});

test("Claude -> Gemini converts text and base64 images to Gemini parts", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-flash",
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc" },
            },
          ],
        },
      ],
    },
    false
  );

  assert.deepEqual(result.contents, [
    {
      role: "user",
      parts: [{ text: "Hello" }, { inlineData: { mimeType: "image/png", data: "abc" } }],
    },
  ]);
});

test("Claude -> Gemini never invents a thoughtSignature for an unsigned tool call", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-flash",
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_unsigned_1", name: "read_file", input: {} }],
        },
      ],
    },
    false
  );

  for (const part of flattenParts(result.contents)) {
    assert.equal(part.thoughtSignature, undefined);
  }
});

// Regression for the 400 "Function call is missing a thought_signature in functionCall
// parts ... position N" that Claude Code focused-agents hit on the direct Claude ->
// Gemini path. A thinking-tier target must never receive an unsigned historical
// functionCall; the call is dropped and its result is carried as inert context (#3688).
test("Claude -> Gemini contextualizes unsigned historical tool calls on thinking models", () => {
  const result = claudeToGeminiRequest(
    "gemini-3.5-flash",
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "list the files" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_ctx_1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_ctx_1",
              content: [{ type: "text", text: "a\nb" }],
            },
          ],
        },
      ],
    },
    false,
    { _signatureNamespace: "conn-ctx-unsigned" }
  );

  const allParts = flattenParts(result.contents);
  assert.equal(
    allParts.some((part) => part.functionCall !== undefined),
    false,
    "unsigned historical functionCall must not reach a thinking Gemini model"
  );
  assert.equal(
    allParts.some((part) => part.functionResponse !== undefined),
    false,
    "an orphaned functionResponse must not reach a thinking Gemini model"
  );
  assert.equal(
    allParts.some(
      (part) => typeof part.text === "string" && part.text.includes("previous_tool_result_context")
    ),
    true,
    "the tool result must survive as inert context"
  );
  // Dropping the model turn must not leave two adjacent user turns (Gemini 400
  // "Request contains consecutive messages with the same role").
  for (let i = 1; i < result.contents.length; i++) {
    assert.notEqual(result.contents[i].role, result.contents[i - 1].role);
  }
});

test("Claude -> Gemini re-attaches a cached thoughtSignature across six sequential tool calls", () => {
  const ns = "conn-six-turns";
  const messages: UnknownRecord[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  for (let turn = 1; turn <= 6; turn++) {
    const toolId = `tu_seq_${turn}`;
    seedSignature(ns, toolId, `SIG_SEQ_${turn}`);
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: `echo ${turn}` } }],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: `${turn}` }] },
      ],
    });
  }

  const result = claudeToGeminiRequest("gemini-3.5-flash", { messages }, false, {
    _signatureNamespace: ns,
  });

  const allParts = flattenParts(result.contents);
  const functionCallParts = allParts.filter((part) => part.functionCall !== undefined);
  assert.equal(functionCallParts.length, 6);
  for (let turn = 1; turn <= 6; turn++) {
    assert.equal(functionCallParts[turn - 1].thoughtSignature, `SIG_SEQ_${turn}`);
  }
  assert.equal(allParts.filter((part) => part.functionResponse !== undefined).length, 6);
});

test("Claude -> Gemini keeps native tool history for non-thinking targets", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.0-flash",
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_plain_1", name: "read_file", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_plain_1", content: "ok" }],
        },
      ],
    },
    false
  );

  assert.equal(result.contents.length, 2);
  const modelParts = flattenParts([result.contents[0]]);
  assert.equal(getFunctionCall(modelParts[0]).name, "read_file");
  assert.equal(modelParts[0].thoughtSignature, undefined);
  assert.equal(getFunctionResponse(flattenParts([result.contents[1]])[0]).name, "read_file");
});

test("Claude -> Gemini sanitizes long tool names and exposes a restore map", () => {
  const longToolName =
    "mcp__filesystem__read_multiple_files_with_validation_and_metadata_bundle_v2";
  const ns = "conn-long-tool-names";
  seedSignature(ns, "tu_long_1", "SIG_LONG_TOOL_NAME");
  const result = claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_long_1", name: longToolName, input: { path: "/tmp/a" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_long_1", content: "ok" }],
        },
      ],
      tools: [
        {
          name: longToolName,
          description: "Read files",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", "x-ui": "hidden" },
            },
            examples: [{ path: "/tmp/a" }],
          },
        },
      ],
    },
    false,
    { _signatureNamespace: ns }
  );

  const sanitizedToolName = (result as any).tools[0].functionDeclarations[0].name as string;
  const parameters = getFunctionDeclarationParameters(
    (result as any).tools[0].functionDeclarations[0].parameters
  );
  assert.ok(longToolName.length > 64);
  assert.equal(sanitizedToolName.length, 64);
  assert.equal((result as any)._toolNameMap.get(sanitizedToolName), longToolName);
  assert.equal(getFunctionCall(result.contents[0].parts[0] as any).name, sanitizedToolName);
  assert.equal(getFunctionResponse(result.contents[1].parts[0] as any).name, sanitizedToolName);
  assert.equal(parameters.examples, undefined);
  assert.equal(parameters.properties?.path?.["x-ui"], undefined);
});

test("Claude -> Gemini handles empty bodies without producing invalid content", () => {
  const result = claudeToGeminiRequest("gemini-2.5-flash", {}, false);

  assert.deepEqual(result.contents, []);
  assert.deepEqual(result.generationConfig, {});
  assert.deepEqual(result.safetySettings, DEFAULT_SAFETY_SETTINGS);
});

test("Claude -> Gemini maps output_config.effort to thinkingConfig when thinking absent", () => {
  const cases: Array<{ effort: string; expected: number }> = [
    { effort: "low", expected: 1024 },
    { effort: "medium", expected: 10240 },
    { effort: "high", expected: 32768 },
    { effort: "max", expected: 131072 },
    { effort: "xhigh", expected: 131072 },
  ];

  for (const { effort, expected } of cases) {
    const result = claudeToGeminiRequest(
      "gemini-2.5-pro",
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort },
      },
      false
    );
    assert.deepEqual(
      result.generationConfig.thinkingConfig,
      { thinkingBudget: expected, includeThoughts: true },
      `effort ${effort} should map to budget ${expected}`
    );
  }
});

// Regression for #3842: output_config.effort=high must be clamped to a Flash-tier
// Gemini model's real thinking-budget cap. gemini-2.5-flash's true max is 24576;
// the previous unclamped 32768 made the upstream return HTTP 400. Pro-tier
// (gemini-2.5-pro, real cap 32768) is asserted untouched by the test above.
test("Claude -> Gemini clamps output_config.effort=high to gemini-2.5-flash cap (#3842)", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-flash",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      output_config: { effort: "high" },
    },
    false
  );
  const budget = (result.generationConfig as any).thinkingConfig.thinkingBudget;
  assert.ok(budget <= 24576, `expected <= 24576 (real cap), got ${budget}`);
  assert.equal(budget, 24576);
});

test("Claude -> Gemini prefers thinking.budget_tokens over output_config.effort", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      output_config: { effort: "high" },
    },
    false
  );

  assert.deepEqual(result.generationConfig.thinkingConfig, {
    thinkingBudget: 4096,
    includeThoughts: true,
  });
});

test("Claude -> Gemini skips thinkingConfig for output_config.effort=none", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      output_config: { effort: "none" },
    },
    false
  );

  assert.equal((result.generationConfig as any).thinkingConfig, undefined);
});
