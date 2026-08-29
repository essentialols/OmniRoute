import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeResponsesInputItems } from "../../open-sse/services/responsesInputSanitizer.ts";

/**
 * Regression guard for the upstream 400:
 *   "Invalid value: 'output_text'. Supported values are: 'input_text',
 *    'input_image', 'input_file', and 'scoped_content'."
 *   param: input[69].output[1]
 *
 * A *_call_output item is a tool RESULT, i.e. content fed back INTO the model,
 * so every part of its `output` array must be an input-side content type.
 * sanitizeOutputContent used to pick the role by exact match on
 * "function_call_output", so "custom_tool_call_output" fell through to
 * "assistant" and its image part was rewritten to `output_text`, which the
 * Responses API rejects. Seen live on a vanilla codex session whose shell tool
 * returned a screenshot.
 */

const INPUT_CONTENT_TYPES = new Set(["input_text", "input_image", "input_file", "scoped_content"]);

type ContentPart = { type: string };
type ToolOutputItem = { output: ContentPart[] };
type MessageItem = { content: ContentPart[] };

const TOOL_OUTPUT_TYPES = ["custom_tool_call_output", "function_call_output"];

for (const itemType of TOOL_OUTPUT_TYPES) {
  test(`${itemType} keeps input-side content types for an image part`, () => {
    const items = [
      {
        type: itemType,
        call_id: "call_0pZe1YQAsjWxSmeBF1GQfJBT",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\n" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ];

    const sanitized = sanitizeResponsesInputItems(items) as ToolOutputItem[];

    for (const part of sanitized[0].output) {
      assert.ok(
        INPUT_CONTENT_TYPES.has(part.type),
        `${itemType} output part must be an input content type, got "${part.type}"`
      );
    }
  });

  test(`${itemType} normalizes a legacy image_url part to input_image`, () => {
    const items = [
      {
        type: itemType,
        call_id: "call_legacy",
        output: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
      },
    ];

    const sanitized = sanitizeResponsesInputItems(items) as ToolOutputItem[];

    assert.equal(sanitized[0].output[0].type, "input_image");
  });
}

test("assistant message content still collapses an image to output_text", () => {
  // The assistant branch is correct and must not regress: replayed assistant
  // output is validated against OUTPUT content part types, where input_image
  // is not allowed.
  const items = [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "input_image", image_url: "https://example.test/b.png" }],
    },
  ];

  const sanitized = sanitizeResponsesInputItems(items) as MessageItem[];

  assert.equal(sanitized[0].content[0].type, "output_text");
});

test("user message content keeps input_image", () => {
  const items = [
    {
      type: "message",
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.test/c.png" } }],
    },
  ];

  const sanitized = sanitizeResponsesInputItems(items) as MessageItem[];

  assert.equal(sanitized[0].content[0].type, "input_image");
});
