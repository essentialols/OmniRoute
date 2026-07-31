import test from "node:test";
import assert from "node:assert/strict";

const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");

function flatten(items) {
  return items.flatMap((item) => item || []);
}

test("Gemini -> Claude stream: text block stays open across sequential text chunks", () => {
  const state = {};
  const first = geminiToClaudeResponse(
    {
      responseId: "resp-1",
      modelVersion: "gemini-2.5-pro",
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
    },
    state
  );
  const second = geminiToClaudeResponse(
    {
      candidates: [{ content: { parts: [{ text: " world" }] } }],
    },
    state
  );
  const result = flatten([first, second]);

  assert.equal(result[0].type, "message_start");
  assert.equal(result[1].type, "content_block_start");
  assert.equal(result[1].index, 0);
  assert.equal(result[2].delta.text, "Hello");
  assert.equal(result[3].type, "content_block_delta");
  assert.equal(result[3].index, 0);
  assert.equal(result[3].delta.text, " world");
});

test("Gemini -> Claude stream: thinking chunk closes text block and emits thinking block", () => {
  const state = {};
  geminiToClaudeResponse(
    {
      responseId: "resp-2",
      modelVersion: "gemini-2.5-pro",
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
    },
    state
  );

  const result = geminiToClaudeResponse(
    {
      candidates: [{ content: { parts: [{ thought: true, text: "Plan" }] } }],
    },
    state
  );

  assert.equal(result[0].type, "content_block_stop");
  assert.equal(result[0].index, 0);
  assert.equal(result[1].content_block.type, "thinking");
  assert.equal(result[2].delta.thinking, "Plan");
  assert.equal(result[3].type, "content_block_stop");
});

test("Gemini -> Claude stream: functionCall becomes tool_use and MAX_TOKENS maps to max_tokens", () => {
  const state = {
    toolNameMap: new Map([
      [
        "read_multiple_files_bundle_ab12cd34",
        "mcp__filesystem__read_multiple_files_with_validation_and_metadata_bundle_v2",
      ],
    ]),
  };
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-3",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "read_multiple_files_bundle_ab12cd34",
                  args: { path: "/tmp/a" },
                },
              },
            ],
          },
          finishReason: "MAX_TOKENS",
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
        cachedContentTokenCount: 1,
      },
    },
    state
  );

  assert.equal(result[1].content_block.type, "tool_use");
  assert.equal(
    result[1].content_block.name,
    "mcp__filesystem__read_multiple_files_with_validation_and_metadata_bundle_v2"
  );
  assert.match(result[1].content_block.id, /^toolu_/);
  assert.equal(result[2].delta.partial_json, JSON.stringify({ path: "/tmp/a" }));
  assert.equal(result[3].type, "content_block_stop");
  assert.equal(result[4].delta.stop_reason, "tool_use");
  assert.equal(result[4].usage.input_tokens, 5);
  assert.equal(result[4].usage.output_tokens, 5);
  assert.equal(result[4].usage.cache_read_input_tokens, 1);
  assert.equal(result[5].type, "message_stop");
});

test("Gemini -> Claude stream: STOP after prior tool use still maps to tool_use", () => {
  const state = {};
  geminiToClaudeResponse(
    {
      responseId: "resp-4",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "weather", args: { city: "Sao Paulo" } } }],
          },
        },
      ],
    },
    state
  );

  const result = geminiToClaudeResponse(
    {
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
    },
    state
  );

  assert.equal(result[0].type, "message_delta");
  assert.equal(result[0].delta.stop_reason, "tool_use");
  assert.equal(result[1].type, "message_stop");
});

test("Gemini -> Claude stream: response wrapper is supported and promptFeedback-only chunk is ignored", () => {
  const wrapped = geminiToClaudeResponse(
    {
      response: {
        responseId: "resp-5",
        modelVersion: "gemini-2.5-pro",
        candidates: [{ content: { parts: [{ text: "wrapped" }] } }],
      },
    },
    {}
  );

  assert.equal(wrapped[0].type, "message_start");
  assert.equal(wrapped[2].delta.text, "wrapped");
  assert.equal(geminiToClaudeResponse({ promptFeedback: { blockReason: "SAFETY" } }, {}), null);
});

// Regression for the 400 "Function call is missing a thought_signature in functionCall
// parts ... position N" seen by Claude Code focused-agents on the direct Claude <-> Gemini
// path. The Claude wire format has nowhere to carry the signature, so the response
// translator has to cache it under `<connectionId>:<toolCallId>` (#2504) and the request
// translator re-attaches it on the follow-up turn.
test("Gemini -> Claude stream: caches the thoughtSignature for the emitted tool_use id", async () => {
  const { getGeminiThoughtSignature, buildGeminiThoughtSignatureKey } =
    await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
  const ns = "conn-resp-cache";
  const state = { signatureNamespace: ns };

  geminiToClaudeResponse(
    {
      responseId: "resp-sig-1",
      modelVersion: "gemini-3.5-flash",
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "planning", thoughtSignature: "SIG_FROM_THOUGHT" },
              { functionCall: { id: "tu_resp_1", name: "Bash", args: { command: "ls" } } },
            ],
          },
        },
      ],
    },
    state
  );

  assert.equal(
    getGeminiThoughtSignature(buildGeminiThoughtSignatureKey(ns, "tu_resp_1")),
    "SIG_FROM_THOUGHT"
  );
});

test("Gemini -> Claude stream: caches a signature carried on the functionCall part itself", async () => {
  const { getGeminiThoughtSignature, buildGeminiThoughtSignatureKey } =
    await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
  const ns = "conn-resp-cache-inline";
  geminiToClaudeResponse(
    {
      responseId: "resp-sig-2",
      modelVersion: "gemini-3.5-flash",
      candidates: [
        {
          content: {
            parts: [
              {
                thoughtSignature: "SIG_INLINE",
                functionCall: { id: "tu_resp_2", name: "Read", args: { file: "a" } },
              },
            ],
          },
        },
      ],
    },
    { signatureNamespace: ns }
  );

  assert.equal(
    getGeminiThoughtSignature(buildGeminiThoughtSignatureKey(ns, "tu_resp_2")),
    "SIG_INLINE"
  );
});

// Full round trip: six sequential tool-using turns. Each turn's Gemini response is run
// through the response translator (which caches the signature), the resulting tool_use is
// appended to the Claude-format transcript, and the whole transcript is re-translated to
// Gemini. Every historical functionCall must come back signed, which is what the live
// route needs at "position 5" and beyond.
test("Claude <-> Gemini round trip: six sequential tool calls all stay signed", async () => {
  const { claudeToGeminiRequest } =
    await import("../../open-sse/translator/request/claude-to-gemini.ts");
  const ns = "conn-roundtrip-six";
  const messages: Record<string, unknown>[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
  ];

  for (let turn = 1; turn <= 6; turn++) {
    const toolId = `tu_rt_${turn}`;
    geminiToClaudeResponse(
      {
        responseId: `resp-rt-${turn}`,
        modelVersion: "gemini-3.5-flash",
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: `step ${turn}`, thoughtSignature: `SIG_RT_${turn}` },
                { functionCall: { id: toolId, name: "Bash", args: { command: `echo ${turn}` } } },
              ],
            },
          },
        ],
      },
      { signatureNamespace: ns }
    );

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

    const outbound = claudeToGeminiRequest("gemini-3.5-flash", { messages }, true, {
      _signatureNamespace: ns,
    });
    const calls = (outbound.contents as Array<{ parts: Record<string, unknown>[] }>)
      .flatMap((content) => content.parts)
      .filter((part) => part.functionCall !== undefined);

    assert.equal(calls.length, turn, `turn ${turn}: expected ${turn} functionCall parts`);
    calls.forEach((part, index) => {
      assert.equal(
        part.thoughtSignature,
        `SIG_RT_${index + 1}`,
        `turn ${turn}: functionCall at position ${index + 1} lost its thoughtSignature`
      );
    });
  }
});
