import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeOpenAICompatibleTools } from "../../../open-sse/handlers/chatCore/openaiCompatibleTools.ts";

test("flattens a Codex collaboration namespace into bare sub-tools", () => {
  const tools = [
    {
      type: "namespace",
      name: "agents",
      tools: [
        { name: "spawn_agent", description: "spawn", parameters: { type: "object" } },
        { name: "wait_agent" },
        { name: "send_message" },
        { name: "followup_task" },
        { name: "interrupt_agent" },
        { name: "list_agents" },
      ],
    },
  ];

  const out = normalizeOpenAICompatibleTools(tools);

  // The opaque `agents` group must NOT survive; the 6 bare sub-tools must.
  const names = out.map((t) => (t as Record<string, unknown>).name);
  assert.deepEqual(names, [
    "spawn_agent",
    "wait_agent",
    "send_message",
    "followup_task",
    "interrupt_agent",
    "list_agents",
  ]);
  assert.ok(!names.includes("agents"), "namespace name must not leak as a tool");
  // Bare sub-tools are emitted in flat Responses shape (name at top level).
  for (const t of out) {
    const rec = t as Record<string, unknown>;
    assert.equal(rec.type, "function");
    assert.equal((rec as { function?: unknown }).function, undefined);
    assert.ok(rec.parameters, "each sub-tool gets a parameters object");
  }
});

test("preserves input_schema as parameters and defaults when absent", () => {
  const out = normalizeOpenAICompatibleTools([
    {
      type: "namespace",
      name: "agents",
      tools: [{ name: "spawn_agent", input_schema: { type: "object", properties: { a: {} } } }],
    },
  ]);
  assert.deepEqual((out[0] as Record<string, unknown>).parameters, {
    type: "object",
    properties: { a: {} },
  });

  const out2 = normalizeOpenAICompatibleTools([
    { type: "namespace", name: "agents", tools: [{ name: "wait_agent" }] },
  ]);
  assert.deepEqual((out2[0] as Record<string, unknown>).parameters, {
    type: "object",
    properties: {},
  });
});

test("passes plain function tools through untouched", () => {
  const fnFlat = { type: "function", name: "exec", parameters: { type: "object" } };
  const fnNested = { type: "function", function: { name: "apply_patch" } };
  const out = normalizeOpenAICompatibleTools([fnFlat, fnNested]);
  assert.equal(out.length, 2);
  assert.equal(out[0], fnFlat);
  assert.equal(out[1], fnNested);
});

test("normalises a named non-function tool to nested function format", () => {
  const out = normalizeOpenAICompatibleTools([
    { type: "image_gen", name: "image_gen", description: "gen", parameters: { type: "object" } },
  ]);
  assert.equal(out.length, 1);
  const rec = out[0] as Record<string, unknown>;
  assert.equal(rec.type, "function");
  assert.deepEqual(rec.function, {
    name: "image_gen",
    description: "gen",
    parameters: { type: "object" },
  });
});

test("drops unnamed non-function tools without a function wrapper", () => {
  const out = normalizeOpenAICompatibleTools([
    { type: "computer_use_preview" },
    { type: "function", name: "keep" },
  ]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as Record<string, unknown>).name, "keep");
});

test("skips namespace sub-tools with empty/blank names", () => {
  const out = normalizeOpenAICompatibleTools([
    { type: "namespace", name: "agents", tools: [{ name: "  " }, { name: "spawn_agent" }, {}] },
  ]);
  const names = out.map((t) => (t as Record<string, unknown>).name);
  assert.deepEqual(names, ["spawn_agent"]);
});
