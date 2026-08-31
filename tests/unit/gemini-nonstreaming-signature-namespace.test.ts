import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression: the non-streaming Gemini response path stored thought signatures
 * under the bare tool-call id (`buildGeminiThoughtSignatureKey(null, toolCallId)`),
 * while every request-side lookup builds `<connectionId>:<toolCallId>`. Signatures
 * were therefore written and never read, so Gemini 3+ thinking models saw unsigned
 * historical functionCall parts and the request translator's context-mode fallback
 * silently dropped the tool history.
 *
 * The streaming path never had this bug (stream.ts threads `signatureNamespace`
 * from the same `connectionId`), so these tests pin the non-streaming path to the
 * same key shape.
 */

const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { openaiToGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { buildGeminiThoughtSignatureKey, clearGeminiThoughtSignatures, getGeminiThoughtSignature } =
  await import("../../open-sse/services/geminiThoughtSignatureStore.ts");

test.beforeEach(() => {
  clearGeminiThoughtSignatures();
});

function geminiToolCallResponse(
  toolCallId: string,
  parts: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    responseId: `resp-${toolCallId}`,
    modelVersion: "gemini-3-pro",
    createTime: "2026-07-30T12:00:00.000Z",
    candidates: [{ content: { parts }, finishReason: "STOP" }],
  };
}

test("Gemini non-stream: thought signature is stored under <connectionId>:<toolCallId>", () => {
  const connectionId = "conn-ns-1";
  const toolCallId = "call_ns_1";

  translateNonStreamingResponse(
    geminiToolCallResponse(toolCallId, [
      {
        thoughtSignature: "SIG_NS_1",
        functionCall: { id: toolCallId, name: "read_file", args: { path: "/tmp/a" } },
      },
    ]),
    FORMATS.GEMINI,
    FORMATS.OPENAI,
    null,
    null,
    { signatureNamespace: connectionId }
  );

  assert.equal(
    getGeminiThoughtSignature(buildGeminiThoughtSignatureKey(connectionId, toolCallId)),
    "SIG_NS_1"
  );
  // The pre-fix key. Must stay empty, otherwise the namespace was never applied.
  assert.equal(getGeminiThoughtSignature(toolCallId), null);
});

test("Gemini non-stream: signature from a preceding thinking-only part is namespaced too", () => {
  const connectionId = "conn-ns-2";
  const toolCallId = "call_ns_2";

  translateNonStreamingResponse(
    geminiToolCallResponse(toolCallId, [
      { thoughtSignature: "SIG_NS_2" },
      { functionCall: { id: toolCallId, name: "read_file", args: { path: "/tmp/b" } } },
    ]),
    FORMATS.GEMINI,
    FORMATS.OPENAI,
    null,
    null,
    { signatureNamespace: connectionId }
  );

  assert.equal(
    getGeminiThoughtSignature(buildGeminiThoughtSignatureKey(connectionId, toolCallId)),
    "SIG_NS_2"
  );
  assert.equal(getGeminiThoughtSignature(toolCallId), null);
});

test("Gemini non-stream: stored signature round-trips to the next request turn", () => {
  const connectionId = "conn-ns-3";
  const toolCallId = "call_ns_3";

  // Turn 1: provider responds with a signed tool call.
  translateNonStreamingResponse(
    geminiToolCallResponse(toolCallId, [
      {
        thoughtSignature: "SIG_NS_ROUNDTRIP",
        functionCall: { id: toolCallId, name: "Bash", args: { cmd: "ls" } },
      },
    ]),
    FORMATS.ANTIGRAVITY,
    FORMATS.OPENAI,
    null,
    null,
    { signatureNamespace: connectionId }
  );

  // Turn 2: the client replays that tool call; the request translator must find
  // the cached signature under the same namespace and re-attach it.
  const followUp = openaiToGeminiRequest(
    "gemini-3-pro",
    {
      messages: [
        { role: "user", content: "list the files" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: { name: "Bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: toolCallId, content: "a.txt" },
      ],
    },
    false,
    { _signatureNamespace: connectionId }
  );

  assert.ok(
    JSON.stringify(followUp).includes("SIG_NS_ROUNDTRIP"),
    "cached thoughtSignature must be re-attached to the replayed functionCall"
  );
});

test("Gemini non-stream: omitting the namespace keeps the legacy bare-id key", () => {
  const toolCallId = "call_ns_legacy";

  // executors/glm.ts and the existing translator tests call the 3/4-arg form.
  // Those callers must keep working unchanged.
  translateNonStreamingResponse(
    geminiToolCallResponse(toolCallId, [
      {
        thoughtSignature: "SIG_NS_LEGACY",
        functionCall: { id: toolCallId, name: "read_file", args: { path: "/tmp/c" } },
      },
    ]),
    FORMATS.GEMINI,
    FORMATS.OPENAI
  );

  assert.equal(getGeminiThoughtSignature(toolCallId), "SIG_NS_LEGACY");
});
