import test from "node:test";
import assert from "node:assert/strict";

// Regression for Codex Multi-Agent V2 native subagents over a local openai-compatible
// provider. Codex declares the collaboration tools under a namespace
// (`{type:"namespace", name:"agents", tools:[{name:"spawn_agent"}, ...]}`) and looks up the
// executor by an EXACT ToolName{namespace:"agents", name:"spawn_agent"}. OmniRoute flattens
// the namespace into BARE sub-tools on the request so the chat-only local model can call them,
// which strips the namespace -> the model emits a bare `spawn_agent`. Codex reconstructs the
// namespace from a SEPARATE `namespace` field on the wire function_call item (protocol
// FunctionCall + router build_tool_call -> ToolName::new(namespace, name)), NOT by splitting the
// name. Without re-attaching it, codex rejects the call: "unsupported call: spawn_agent".
// This test locks in: (1) the request->response namespace map, and (2) the transformer
// re-attaching that namespace to matching function_call items while leaving plain/MCP tools alone.

const { buildToolNamespaceMap } =
  await import("../../open-sse/handlers/chatCore/openaiCompatibleTools.ts");
const { createResponsesApiTransformStream } =
  await import("../../open-sse/transformer/responsesTransformer.ts");

test("buildToolNamespaceMap maps namespace sub-tools and ignores plain/MCP function tools", () => {
  const tools = [
    {
      type: "namespace",
      name: "agents",
      tools: [
        { name: "spawn_agent", parameters: { type: "object", properties: {} } },
        { name: "wait_agent", parameters: { type: "object", properties: {} } },
      ],
    },
    // A plain flat function tool (e.g. an MCP tool) must never enter the map.
    { type: "function", function: { name: "mcp__memory__create", parameters: {} } },
    { type: "function", name: "shell", parameters: {} },
  ];

  assert.deepEqual(buildToolNamespaceMap(tools), {
    spawn_agent: "agents",
    wait_agent: "agents",
  });
});

test("buildToolNamespaceMap returns null when there are no namespace tool groups", () => {
  assert.equal(buildToolNamespaceMap([{ type: "function", name: "shell" }]), null);
  assert.equal(buildToolNamespaceMap(undefined), null);
  assert.equal(buildToolNamespaceMap([]), null);
});

// Drive a chat-completions SSE stream (one tool call) through the Responses transform and
// return the parsed `response.output_item.done` function_call item.
async function runToolCall(
  toolName: string,
  namespaceMap: Record<string, string> | null
): Promise<Record<string, unknown>> {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: toolName } }] },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"agent_type":"x"}' } }] },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];

  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const transform = createResponsesApiTransformStream(null, undefined, namespaceMap);
  const out = source.pipeThrough(transform);
  const decoder = new TextDecoder();
  let text = "";
  for await (const bytes of out as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(bytes, { stream: true });
  }

  // Find the function_call item on the authoritative response.output_item.done event.
  const events = text.split("\n\n");
  for (const ev of events) {
    const dataLine = ev.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataLine.slice(dataLine.indexOf(":") + 1).trim());
    } catch {
      continue;
    }
    const item = parsed.item as Record<string, unknown> | undefined;
    if (parsed.type === "response.output_item.done" && item?.type === "function_call") {
      return item;
    }
  }
  throw new Error("no function_call output_item.done emitted");
}

test("transformer re-attaches the namespace to a flattened collaboration tool call", async () => {
  const item = await runToolCall("spawn_agent", { spawn_agent: "agents" });
  assert.equal(item.name, "spawn_agent", "bare tool name is preserved (ToolName.name)");
  assert.equal(item.namespace, "agents", "namespace is re-attached as a separate field");
});

test("transformer leaves non-namespace (MCP/plain) tool calls untouched", async () => {
  const item = await runToolCall("mcp__memory__create", { spawn_agent: "agents" });
  assert.equal(item.name, "mcp__memory__create");
  assert.equal(item.namespace, undefined, "plain/MCP tools must NOT get a namespace field");
});

test("transformer is a no-op when no namespace map is supplied", async () => {
  const item = await runToolCall("spawn_agent", null);
  assert.equal(item.name, "spawn_agent");
  assert.equal(item.namespace, undefined);
});

// The ACTUAL handleChat path uses the openai-responses translator
// (open-sse/translator/response/openai-responses.ts), NOT the responsesHandler transformer.
// This locks in the namespace re-tag on THAT path: the chat-to-responses translator emits the
// function_call `response.output_item.done` item with the reconstructed `namespace` field.
const { openaiToOpenAIResponsesResponse } =
  await import("../../open-sse/translator/response/openai-responses.ts");

function freshTranslatorState(toolNamespaceByName: Record<string, string> | null) {
  return {
    seq: 0,
    responseId: "resp_test",
    created: 0,
    funcArgsBuf: {},
    funcNames: {},
    funcCallIds: {},
    funcArgsDone: {},
    funcItemDone: {},
    msgItemAdded: {},
    completedOutputItems: [],
    completedSent: false,
    customToolNames: null,
    toolNamespaceByName,
  } as Record<string, unknown>;
}

function runTranslatorToolCall(
  toolName: string,
  toolNamespaceByName: Record<string, string> | null
): Record<string, unknown> {
  const state = freshTranslatorState(toolNamespaceByName);
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: toolName } }] },
        },
      ],
    },
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const c of chunks) {
    for (const e of openaiToOpenAIResponsesResponse(c, state)) events.push(e);
  }
  for (const e of events) {
    const item = e.data?.item as Record<string, unknown> | undefined;
    if (e.event === "response.output_item.done" && item?.type === "function_call") return item;
  }
  throw new Error("no function_call output_item.done emitted by openai-responses translator");
}

test("openai-responses translator (real handleChat path) re-attaches the namespace", () => {
  const item = runTranslatorToolCall("spawn_agent", { spawn_agent: "agents" });
  assert.equal(item.name, "spawn_agent");
  assert.equal(item.namespace, "agents");
});

test("openai-responses translator leaves plain/MCP tool calls untouched", () => {
  const item = runTranslatorToolCall("mcp__memory__create", { spawn_agent: "agents" });
  assert.equal(item.name, "mcp__memory__create");
  assert.equal(item.namespace, undefined);
});
