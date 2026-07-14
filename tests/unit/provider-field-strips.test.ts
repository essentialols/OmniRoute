import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findOffendingField,
  stripGroqUnsupportedFields,
  stripHeavyCodexToolsForBudget,
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
