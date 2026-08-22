import test from "node:test";
import assert from "node:assert/strict";

const { openaiResponsesToOpenAIRequest, extractResponsesCustomToolNames } =
  await import("../../open-sse/translator/request/openai-responses.ts");
const { openaiToOpenAIResponsesResponse } =
  await import("../../open-sse/translator/response/openai-responses.ts");
const { initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

// End-to-end custom-tool mapping for Codex composer/exec mode.
//
// Codex packs its tools into a Responses `input` item of type "additional_tools".
// Among them, `exec` (and `apply_patch`) are declared with `type:"custom"`; the
// request-side fix converts those to a { input: string } function schema so the
// upstream model emits a structured tool_call { function:{ name:"exec", arguments:
// '{"input":"..."}' } }. The RESPONSE side must then surface that returned tool_call
// as a Responses `custom_tool_call` (not a `function_call`), or Codex rejects it with
// "Fatal error: tool exec invoked with incompatible payload". Ordinary `function`
// tools must keep the `function_call` lifecycle unchanged.
function collectEvents(chunks, customToolNames) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  if (customToolNames) state.customToolNames = new Set(customToolNames);
  const events = [];
  for (const chunk of chunks) {
    const result = openaiToOpenAIResponsesResponse(chunk, state);
    if (result) events.push(...result);
  }
  return events;
}

test("Codex exec (type:custom) maps to a custom_tool_call; ordinary function stays a function_call", () => {
  // ── Request side: parse the Responses request, discover the custom-tool set ──
  const responsesBody = {
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "custom", name: "exec", description: "Run JS to orchestrate tools" },
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
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
    ],
    tool_choice: "auto",
  };

  // The request translation must still succeed (custom → { input:string } function).
  const req = openaiResponsesToOpenAIRequest("m2/M1y", responsesBody, true, {});
  assert.equal(Array.isArray(req.tools), true);

  // The threaded custom-tool set: names originally declared as type:"custom".
  const customToolNames = extractResponsesCustomToolNames(responsesBody);
  assert.deepEqual([...customToolNames].sort(), ["exec"]);

  // ── Response side: a chat-completions stream carrying exec (custom) + wait (fn) ──
  const events = collectEvents(
    [
      {
        id: "chatcmpl-9",
        model: "m2/M1y",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_exec_1",
                  type: "function",
                  function: { name: "exec", arguments: '{"input":"tools.exec' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-9",
        model: "m2/M1y",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '_command([\\"ls\\"])"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-9",
        model: "m2/M1y",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_wait_1",
                  type: "function",
                  function: { name: "wait", arguments: '{"seconds":5}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-9",
        model: "m2/M1y",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ],
    customToolNames
  );

  // ── exec → custom_tool_call with the UNWRAPPED input string ──
  const execAdded = events.find(
    (e) => e.event === "response.output_item.added" && e.data.item.name === "exec"
  );
  assert.ok(execAdded, "expected an output_item.added for exec");
  assert.equal(execAdded.data.item.type, "custom_tool_call");
  assert.equal(execAdded.data.item.call_id, "call_exec_1");
  assert.equal(execAdded.data.item.input, "");

  assert.ok(
    events.some((e) => e.event === "response.custom_tool_call_input.delta"),
    "exec must stream via custom_tool_call_input.delta"
  );

  const execInputDone = events.find((e) => e.event === "response.custom_tool_call_input.done");
  assert.ok(execInputDone, "expected a custom_tool_call_input.done for exec");
  assert.equal(execInputDone.data.input, 'tools.exec_command(["ls"])');
  assert.equal(execInputDone.data.item_id, "fc_call_exec_1");

  const execItemDone = events.find(
    (e) => e.event === "response.output_item.done" && e.data.item.type === "custom_tool_call"
  );
  assert.ok(execItemDone, "expected an output_item.done custom_tool_call for exec");
  assert.equal(execItemDone.data.item.input, 'tools.exec_command(["ls"])');
  assert.equal(execItemDone.data.item.call_id, "call_exec_1");

  // ── No function_call lifecycle events may reference the exec item_id ──
  const execFunctionEvents = events.filter(
    (e) =>
      (e.event === "response.function_call_arguments.delta" ||
        e.event === "response.function_call_arguments.done") &&
      e.data.item_id === "fc_call_exec_1"
  );
  assert.equal(execFunctionEvents.length, 0, "exec must not emit any function_call events");
  const execAsFunction = events.find(
    (e) =>
      e.event === "response.output_item.added" &&
      e.data.item.type === "function_call" &&
      e.data.item.name === "exec"
  );
  assert.equal(execAsFunction, undefined, "exec must never be added as a function_call");

  // ── wait → ordinary function_call lifecycle, unchanged ──
  const waitAdded = events.find(
    (e) => e.event === "response.output_item.added" && e.data.item.name === "wait"
  );
  assert.ok(waitAdded, "expected an output_item.added for wait");
  assert.equal(waitAdded.data.item.type, "function_call");
  assert.equal(waitAdded.data.item.call_id, "call_wait_1");

  const waitArgsDone = events.find(
    (e) =>
      e.event === "response.function_call_arguments.done" && e.data.item_id === "fc_call_wait_1"
  );
  assert.ok(waitArgsDone, "wait must emit function_call_arguments.done");
  assert.equal(waitArgsDone.data.arguments, '{"seconds":5}');
  assert.ok(
    !events.some(
      (e) =>
        e.event === "response.custom_tool_call_input.done" && e.data.item_id === "fc_call_wait_1"
    ),
    "wait must not emit custom_tool_call events"
  );

  // ── Final snapshot carries both items with stable ids ──
  const completed = events.find((e) => e.event === "response.completed");
  assert.ok(completed);
  const output = completed.data.response.output;
  const execItem = output.find((o) => o.type === "custom_tool_call");
  const waitItem = output.find((o) => o.type === "function_call");
  assert.ok(execItem && execItem.call_id === "call_exec_1");
  assert.equal(execItem.input, 'tools.exec_command(["ls"])');
  assert.ok(waitItem && waitItem.call_id === "call_wait_1");
  assert.equal(waitItem.arguments, '{"seconds":5}');

  // ── sequence_number strictly increasing across all events ──
  const seqs = events.map((e) => e.data.sequence_number);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], "sequence_number must be strictly increasing");
  }
});
