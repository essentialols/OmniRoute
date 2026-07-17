import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findOffendingField,
  stripGroqUnsupportedFields,
  stripHeavyCodexToolsForBudget,
  canonicalizeTools,
} from "../../open-sse/config/providerFieldStrips.ts";

test("findOffendingField matches known field names in a 400 body", () => {
  assert.equal(
    findOffendingField("Invalid argument: reasoning_budget not supported"),
    "reasoning_budget"
  );
  assert.equal(findOffendingField("unexpected field chat_template"), "chat_template");
  assert.equal(findOffendingField("reasoning_content is not allowed"), "reasoning_content");
  // #1468: Claude Code's top-level context_management field rejected by strict
  // anthropic-compatible gateways → strip + retry regardless of the contextEditing flag.
  assert.equal(
    findOffendingField("context_management: Extra inputs are not permitted"),
    "context_management"
  );
  assert.equal(findOffendingField("all good"), null);
  assert.equal(findOffendingField(""), null);
});

test("stripGroqUnsupportedFields drops non-empty messages[].name", () => {
  const out = stripGroqUnsupportedFields({
    messages: [{ role: "user", content: "hi", name: "bob" }],
  });
  assert.equal("name" in out.messages[0], false);
  assert.equal(out.messages[0].content, "hi");
});

test("stripGroqUnsupportedFields drops logprobs/logit_bias/top_logprobs", () => {
  const out = stripGroqUnsupportedFields({
    messages: [],
    logprobs: true,
    logit_bias: { 1: 2 },
    top_logprobs: 5,
  });
  assert.equal("logprobs" in out, false);
  assert.equal("logit_bias" in out, false);
  assert.equal("top_logprobs" in out, false);
});

test("stripGroqUnsupportedFields is immutable (does not mutate input)", () => {
  const input = { messages: [{ role: "user", content: "hi", name: "bob" }], logprobs: true };
  stripGroqUnsupportedFields(input);
  assert.equal(input.messages[0].name, "bob");
  assert.equal(input.logprobs, true);
});

// stripHeavyCodexToolsForBudget: drop codex's ~2.9k-token sub-agent orchestration
// tool group for Groq (12k TPM/request cap) so a codex request fits under the limit.

const codexTools = () => [
  { type: "function", function: { name: "exec_command", description: "run a command" } },
  { type: "function", function: { name: "spawn_agent", description: "spawn a sub-agent" } },
  { type: "function", function: { name: "wait_agent", description: "wait" } },
  { type: "function", function: { name: "close_agent", description: "close" } },
  { type: "function", function: { name: "resume_agent", description: "resume" } },
  { type: "function", function: { name: "send_input", description: "send" } },
  { type: "function", function: { name: "update_plan", description: "plan" } },
];

test("stripHeavyCodexToolsForBudget drops sub-agent orchestration tools for groq", () => {
  const out = stripHeavyCodexToolsForBudget({ tools: codexTools() }, "groq");
  const names = out.tools.map((t) => (t as { function: { name: string } }).function.name);
  assert.deepEqual(names, ["exec_command", "update_plan"]);
});

test("stripHeavyCodexToolsForBudget is case/whitespace-insensitive on provider", () => {
  const out = stripHeavyCodexToolsForBudget({ tools: codexTools() }, "  Groq  ");
  const names = out.tools.map((t) => (t as { function: { name: string } }).function.name);
  assert.deepEqual(names, ["exec_command", "update_plan"]);
});

test("stripHeavyCodexToolsForBudget leaves non-budget providers untouched (referential no-op)", () => {
  const input = { tools: codexTools() };
  const out = stripHeavyCodexToolsForBudget(input, "openai");
  assert.equal(out, input);
});

test("stripHeavyCodexToolsForBudget is a no-op when no tools present", () => {
  const input = { messages: [{ role: "user", content: "hi" }] };
  const out = stripHeavyCodexToolsForBudget(input, "groq");
  assert.equal(out, input);
});

test("stripHeavyCodexToolsForBudget does not mutate the input body", () => {
  const input = { tools: codexTools() };
  stripHeavyCodexToolsForBudget(input, "groq");
  assert.equal(input.tools.length, 7);
});

// canonicalizeTools: deterministic tool array ordering for prefix cache hits

function toolFnName(t: Record<string, unknown>): string {
  const fn = t.function as Record<string, unknown> | undefined;
  return typeof fn?.name === "string" ? fn.name : "";
}

test("canonicalizeTools sorts tools by type then function.name", () => {
  const input = {
    tools: [
      { type: "function", function: { name: "zebra", description: "z" } },
      { type: "function", function: { name: "alpha", description: "a" } },
      { type: "function", function: { name: "middle", description: "m" } },
    ],
  };
  const out = canonicalizeTools(input);
  const names = out.tools.map(
    (t: Record<string, unknown>) => (t.function as Record<string, unknown>).name
  );
  assert.deepEqual(names, ["alpha", "middle", "zebra"]);
});

test("canonicalizeTools preserves internal key order (grammar safety)", () => {
  const input = {
    tools: [
      {
        type: "function",
        function: {
          name: "test",
          description: "d",
          parameters: {
            type: "object",
            properties: { z_param: { type: "string" }, a_param: { type: "number" } },
          },
        },
      },
    ],
  };
  const out = canonicalizeTools(input);
  const fn = (out.tools[0] as Record<string, unknown>).function as Record<string, unknown>;
  const params = fn.parameters as Record<string, unknown>;
  const props = params.properties as Record<string, unknown>;
  // Internal key order must NOT be sorted (would break llama-server grammar generation)
  assert.deepEqual(Object.keys(props), ["z_param", "a_param"]);
  assert.deepEqual(Object.keys(fn), ["name", "description", "parameters"]);
});

test("canonicalizeTools is a referential no-op when already sorted", () => {
  const input = {
    tools: [
      { type: "function", function: { name: "alpha", description: "a" } },
      { type: "function", function: { name: "beta", description: "b" } },
    ],
  };
  assert.equal(canonicalizeTools(input), input);
});

test("canonicalizeTools is a no-op for empty or missing tools", () => {
  const noTools = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(canonicalizeTools(noTools), noTools);

  const emptyTools = { tools: [] as unknown[] };
  assert.equal(canonicalizeTools(emptyTools), emptyTools);
});

test("canonicalizeTools does not mutate the input body", () => {
  const input = {
    tools: [
      { type: "function", function: { name: "b", description: "b" } },
      { type: "function", function: { name: "a", description: "a" } },
    ],
  };
  const originalFirst = input.tools[0];
  canonicalizeTools(input);
  assert.equal(input.tools[0], originalFirst);
  assert.equal(input.tools.length, 2);
});

test("canonicalizeTools produces same array order regardless of input order", () => {
  const toolA = { type: "function", function: { name: "exec", parameters: { b: 1, a: 2 } } };
  const toolB = { type: "function", function: { name: "read", parameters: { y: 3, x: 4 } } };
  const order1 = { tools: [toolA, toolB] };
  const order2 = { tools: [toolB, toolA] };
  const out1 = canonicalizeTools(order1);
  const out2 = canonicalizeTools(order2);
  const names1 = out1.tools.map((t: Record<string, unknown>) => toolFnName(t));
  const names2 = out2.tools.map((t: Record<string, unknown>) => toolFnName(t));
  assert.deepEqual(names1, names2);
  assert.deepEqual(names1, ["exec", "read"]);
});
