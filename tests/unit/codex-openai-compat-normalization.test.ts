// Regression tests for the Codex CLI / Responses-API OpenAI-compat upstream
// normalizations that make the remaining chat providers routable through the Codex
// orchestrator:
//   - uncloseai: "System message must be at the beginning" (developer -> system created
//     a second, non-leading system message) -> merge adjacent system messages.
//   - llm7 (gemma3:27b): "does not support vision input" (text-only multipart content
//     arrays rejected as multimodal) -> flatten text-only content to a string.
//   - cohere: 422 "parallel_tool_calls is not supported" -> strip parallel_tool_calls.
//   - publicai (apertus): 400 "auto tool choice requires --enable-auto-tool-choice"
//     -> strip tools/tool_choice/parallel_tool_calls.
import test from "node:test";
import assert from "node:assert/strict";

import {
  flattenTextOnlyContent,
  mergeConsecutiveSystemMessages,
  normalizeOpenAICompatMessages,
} from "../../open-sse/handlers/chatCore/openaiCompatMessages.ts";
import {
  stripUnsupportedToolFields,
  PROVIDERS_WITHOUT_PARALLEL_TOOL_CALLS,
  PROVIDERS_WITHOUT_TOOL_CALLING,
} from "../../open-sse/config/providerFieldStrips.ts";

test("flattenTextOnlyContent collapses a text-only content array to a string", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const out = flattenTextOnlyContent(msgs);
  assert.equal(out[0].content, "hello");
});

test("flattenTextOnlyContent joins multiple text parts with newlines", () => {
  const msgs = [
    {
      role: "system",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    },
  ];
  const out = flattenTextOnlyContent(msgs);
  assert.equal(out[0].content, "a\nb");
});

test("flattenTextOnlyContent preserves arrays containing a non-text (image) part", () => {
  const content = [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ];
  const msgs = [{ role: "user", content }];
  const out = flattenTextOnlyContent(msgs);
  assert.deepEqual(out[0].content, content); // untouched (genuine multimodal)
});

test("flattenTextOnlyContent leaves string content and returns same reference when nothing changes", () => {
  const msgs = [{ role: "user", content: "plain" }];
  const out = flattenTextOnlyContent(msgs);
  assert.equal(out, msgs);
});

test("mergeConsecutiveSystemMessages merges two leading system messages into one", () => {
  const msgs = [
    { role: "system", content: "sys1" },
    { role: "system", content: "sys2" },
    { role: "user", content: "hi" },
  ];
  const out = mergeConsecutiveSystemMessages(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, "sys1\n\nsys2");
  assert.equal(out[1].role, "user");
});

test("mergeConsecutiveSystemMessages does not merge non-adjacent system messages", () => {
  const msgs = [
    { role: "system", content: "s1" },
    { role: "user", content: "u" },
    { role: "system", content: "s2" },
  ];
  const out = mergeConsecutiveSystemMessages(msgs);
  assert.equal(out, msgs); // no adjacent run -> unchanged reference
  assert.equal(out.length, 3);
});

test("normalizeOpenAICompatMessages fixes the exact Codex shape (uncloseai + llm7)", () => {
  // What Codex produces after developer -> system role normalization.
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "instructions" },
      {
        role: "system", // was developer
        content: [
          { type: "text", text: "perm1" },
          { type: "text", text: "perm2" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "env" }] },
      { role: "user", content: [{ type: "text", text: "reply one word: routable" }] },
    ],
  };
  const out = normalizeOpenAICompatMessages(body) as typeof body;
  // Single leading system message with string content (uncloseai constraint).
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "instructions\n\nperm1\nperm2");
  // No array-form content anywhere (llm7 vision constraint).
  for (const m of out.messages) {
    assert.equal(typeof m.content, "string", `role ${m.role} content should be a string`);
  }
  assert.equal(out.messages[2].content, "reply one word: routable");
});

test("normalizeOpenAICompatMessages preserves a real vision request", () => {
  const imgContent = [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: "https://x/y.png" } },
  ];
  const body = { model: "m", messages: [{ role: "user", content: imgContent }] };
  const out = normalizeOpenAICompatMessages(body) as typeof body;
  assert.deepEqual(out.messages[0].content, imgContent);
});

test("stripUnsupportedToolFields: cohere drops only parallel_tool_calls", () => {
  assert.ok(PROVIDERS_WITHOUT_PARALLEL_TOOL_CALLS.has("cohere"));
  const body = {
    model: "command-a-03-2025",
    tools: [{ type: "function", function: { name: "shell" } }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const out = stripUnsupportedToolFields(body, "cohere");
  assert.equal(out.parallel_tool_calls, undefined);
  assert.ok(Array.isArray(out.tools), "tools preserved for cohere");
  assert.equal(out.tool_choice, "auto");
});

test("stripUnsupportedToolFields: publicai drops the whole tool trio", () => {
  assert.ok(PROVIDERS_WITHOUT_TOOL_CALLING.has("publicai"));
  const body = {
    model: "swiss-ai/apertus-8b-instruct",
    tools: [{ type: "function", function: { name: "shell" } }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const out = stripUnsupportedToolFields(body, "publicai");
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.parallel_tool_calls, undefined);
});

test("stripUnsupportedToolFields: unaffected provider keeps all tool fields (no regression)", () => {
  const body = {
    model: "x",
    tools: [{ type: "function", function: { name: "shell" } }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const out = stripUnsupportedToolFields(body, "mistral");
  assert.equal(out, body); // referential no-op
  assert.equal(out.parallel_tool_calls, true);
});
