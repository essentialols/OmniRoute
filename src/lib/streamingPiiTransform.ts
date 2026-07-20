import { createSseTextTransform, FieldCategory, getFieldCategory } from "./sseTextTransform";
import { sanitizePII } from "./piiSanitizer";

export interface PiiTransformOptions {
  windowSize?: number;
  /**
   * Per-provider trust-tier override (see piiTrust.ts). When true, PII is
   * redacted even if the global PII_RESPONSE_SANITIZATION flag is off. When
   * undefined, the global flag governs each sanitizePII call.
   */
  forceEnabled?: boolean;
}

export function createPiiSseTransform(options?: PiiTransformOptions): TransformStream {
  const forceEnabled = options?.forceEnabled;
  const choiceBuffers = new Map<string, Record<FieldCategory, string>>();

  const getBuffers = (index: string | number): Record<FieldCategory, string> => {
    const key = String(index);
    let buf = choiceBuffers.get(key);
    if (!buf) {
      buf = {
        content: "",
        reasoning: "",
        toolArgs: "",
        partialJson: "",
      };
      choiceBuffers.set(index, buf);
    }
    return buf;
  };

  let windowSize = Math.max(
    200,
    options?.windowSize ?? (parseInt(process.env.PII_WINDOW_SIZE || "", 10) || 200)
  );
  if (options?.windowSize !== undefined && process.env.PII_TEST_BYPASS_MIN_WINDOW === "true") {
    windowSize = options.windowSize;
  }
  const W = windowSize;

  const processor = (
    text: string,
    field: FieldCategory,
    isStopSignal = false,
    index: string | number = "0_0",
    isSnapshot = false
  ): string => {
    if (field === "toolArgs" || field === "partialJson") {
      return text;
    }
    if (isSnapshot) {
      return sanitizePII(text, false, forceEnabled).text;
    }
    const buffers = getBuffers(index);
    buffers[field] += text;
    const { text: sanitized, endMatchIndex } = sanitizePII(
      buffers[field],
      !isStopSignal,
      forceEnabled
    );
    let emitLength = isStopSignal ? sanitized.length : Math.max(0, sanitized.length - W);

    // Cap emitLength at the start of any PII that touched the end of the buffer
    if (!isStopSignal && endMatchIndex !== undefined && emitLength > endMatchIndex) {
      emitLength = endMatchIndex;
    }

    // Prevent slicing in the middle of a UTF-16 surrogate pair (e.g. emojis)
    if (emitLength > 0 && emitLength < sanitized.length) {
      const charCode = sanitized.charCodeAt(emitLength - 1);
      // High surrogate range is 0xD800 - 0xDBFF
      if (charCode >= 0xd800 && charCode <= 0xdbff) {
        emitLength -= 1;
      }
    }

    const toEmit = sanitized.slice(0, emitLength);
    buffers[field] = sanitized.slice(emitLength);
    return toEmit;
  };

  const onFlush = (lastJson: any, isJsonStream = false, lastContentJson: any = null): any => {
    // Force final redaction on all buffers
    for (const [index, buffers] of choiceBuffers.entries()) {
      for (const key of Object.keys(buffers)) {
        const field = key as FieldCategory;
        if (buffers[field]) {
          buffers[field] = sanitizePII(buffers[field], false, forceEnabled).text;
        }
      }
    }

    let hasRemaining = false;
    for (const buffers of choiceBuffers.values()) {
      for (const key of Object.keys(buffers)) {
        if (buffers[key as FieldCategory].length > 0) {
          hasRemaining = true;
        }
      }
    }
    if (!hasRemaining) {
      return null;
    }

    if (!lastJson) {
      const buffers = getBuffers("0_0");
      if (buffers.content) {
        const remaining = buffers.content;
        buffers.content = "";

        if (isJsonStream) {
          // Wrap in a safe default OpenAI format to prevent client-side SDK crashes
          return {
            choices: [
              {
                delta: {
                  content: remaining,
                },
              },
            ],
          };
        } else {
          return remaining;
        }
      }
      return null;
    }

    // Explicitly target formats to prevent metadata corruption and leakage
    const METADATA_KEYS = [
      "id",
      // Keep aligned with sseTextTransform.ts METADATA_KEYS: `item_id`, `call_id`,
      // `status`, and `input` are OpenAI Responses API structural fields (identifiers,
      // lifecycle enum, apply_patch payload), not model output. Excluding them from the
      // sanitize/buffer path is what prevents them from cross-contaminating the visible
      // `delta` text (item_id/status on the text path, call_id/input on the tool path).
      "item_id",
      "call_id",
      "input",
      "model",
      "object",
      "created",
      "status",
      "finish_reason",
      "finishReason",
      "role",
      "type",
      "index",
      "stop_reason",
      "stop_sequence",
      "system_fingerprint",
      "service_tier",
      "usage",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "input_tokens",
      "output_tokens",
      "logprobs",
      "refusal",
      "name",
      "event",
    ];

    // 1. Claude format
    if (
      typeof lastJson.type === "string" &&
      (lastJson.type.startsWith("message") || lastJson.type.startsWith("content_block"))
    ) {
      // Claude buffers are keyed by content-block index (`${N}_0`); a hardcoded "0_0" only
      // ever read the FIRST block, so a text block at index 1 (after a thinking block at 0)
      // never flushed its held-back tail. Read the buffer for THIS block being closed.
      const blockIndex = typeof lastJson.index === "number" ? lastJson.index : 0;
      const buffers = getBuffers(`${blockIndex}_0`);
      // A Claude content_block_delta carries EXACTLY ONE typed delta that must match the
      // block it targets: reasoning => thinking_delta (thinking block), content =>
      // text_delta (text block), tool args => input_json_delta (tool_use block). The old
      // code hardcoded `type:"text_delta"` and attached buffered reasoning as
      // `delta.thinking`, so flushing a thinking block's held-back tail emitted a
      // text_delta on a thinking block. Claude Code rejects that
      // ("content_block_type_mismatch_text"), falls back to non-streaming, and re-issues
      // the identical request, doubling every reasoning turn on the local MLX path. Each
      // stop signal closes one block, so only the matching buffer is non-empty here; pick
      // the delta type that matches the buffered field so the flush stays valid.
      let delta: Record<string, unknown> | null = null;
      if (buffers.reasoning) {
        delta = { type: "thinking_delta", thinking: buffers.reasoning };
        buffers.reasoning = "";
      } else if (buffers.content) {
        delta = { type: "text_delta", text: buffers.content };
        buffers.content = "";
      } else if (buffers.partialJson) {
        delta = { type: "input_json_delta", partial_json: buffers.partialJson };
        buffers.partialJson = "";
      }
      if (delta) {
        return {
          type: "content_block_delta",
          index: blockIndex,
          delta,
        };
      }
      return null;
    }

    // 2. OpenAI Chat Completions
    if (lastJson.choices && Array.isArray(lastJson.choices)) {
      const finalJson = JSON.parse(JSON.stringify(lastJson));
      const presentIndexes = new Set(
        finalJson.choices.map((c: any) => c.index).filter((idx: any) => typeof idx === "number")
      );
      for (const [compositeKey, choiceBuf] of choiceBuffers.entries()) {
        const choiceIdx = parseInt(compositeKey.split("_")[0] || "0", 10);
        if (
          !presentIndexes.has(choiceIdx) &&
          (choiceBuf.content || choiceBuf.reasoning || choiceBuf.toolArgs)
        ) {
          finalJson.choices.push({ index: choiceIdx, delta: {} });
          presentIndexes.add(choiceIdx);
        }
      }

      for (const choice of finalJson.choices) {
        const choiceIdx = typeof choice.index === "number" ? choice.index : 0;

        // Find if we have tool buffers for this choice
        const toolEntries = Array.from(choiceBuffers.entries()).filter(
          ([key]) => key.startsWith(`${choiceIdx}_`) && key !== `${choiceIdx}_0`
        );

        const choiceBuf = getBuffers(`${choiceIdx}_0`);
        if (!choice.delta) choice.delta = {};
        const delta = choice.delta;

        if (choiceBuf.content) {
          delta.content = choiceBuf.content;
          choiceBuf.content = "";
        } else {
          delete delta.content;
        }
        if (choiceBuf.reasoning) {
          delta.reasoning_content = choiceBuf.reasoning;
          choiceBuf.reasoning = "";
        } else {
          delete delta.reasoning_content;
        }
        if (choiceBuf.toolArgs || toolEntries.length > 0) {
          if (!choice.delta.tool_calls) choice.delta.tool_calls = [];

          if (choiceBuf.toolArgs) {
            choice.delta.tool_calls.push({
              index: 0,
              function: { arguments: choiceBuf.toolArgs },
            });
            choiceBuf.toolArgs = "";
          }

          for (const [key, buf] of toolEntries) {
            if (buf.toolArgs) {
              const toolIdx = parseInt(key.split("_")[1] || "0", 10);
              choice.delta.tool_calls.push({
                index: toolIdx,
                function: { arguments: buf.toolArgs },
              });
              buf.toolArgs = "";
            }
          }
        } else {
          delete choice.delta.tool_calls;
        }
      }
      return finalJson;
    }

    // 3. Responses API
    if (typeof lastJson.type === "string" && lastJson.type.startsWith("response.")) {
      // Responses-format visible text is buffered under the "0_0" composite key
      // (Responses events have no top-level `index`, so sanitizeObject leaves
      // choiceIdx/toolIdx at 0). Residual visible content is normally already drained
      // as a proper response.output_text.delta at response.output_text.done via
      // onSnapshotDrain; this branch is the defensive fallback for streams that lack a
      // text snapshot. It MUST emit a properly-framed output_text.delta (event line and
      // payload type agree), NEVER a delta bolted onto the last (snapshot/stop) payload.
      const buffers = getBuffers("0_0");
      if (buffers.content) {
        const template =
          lastContentJson && lastContentJson.type === "response.output_text.delta"
            ? lastContentJson
            : lastJson;
        const payload: Record<string, unknown> = {
          type: "response.output_text.delta",
          item_id: template.item_id,
          output_index: typeof template.output_index === "number" ? template.output_index : 0,
          content_index: typeof template.content_index === "number" ? template.content_index : 0,
          delta: buffers.content,
          logprobs: [],
        };
        buffers.content = "";
        return payload;
      }
      // Nothing residual to emit: do NOT re-emit the snapshot/stop payload (that is what
      // duplicated the answer and mismatched the event line).
      return null;
    }

    // 4. Gemini format
    if (Array.isArray(lastJson.candidates)) {
      const finalJson = JSON.parse(JSON.stringify(lastJson));
      for (const cand of finalJson.candidates) {
        const idx = typeof cand.index === "number" ? cand.index : 0;
        const buffers = getBuffers(`${idx}_0`);
        if (!cand.content) cand.content = {};
        cand.content.parts = [];

        if (buffers.content) {
          cand.content.parts.push({ text: buffers.content });
          buffers.content = "";
        }
      }
      return finalJson;
    }

    // 5. Generic fallback
    const templateJson = lastContentJson || lastJson;
    const finalJson = JSON.parse(JSON.stringify(templateJson));
    const clearDeltas = (obj: any) => {
      if (!obj || typeof obj !== "object") return;
      for (const key of Object.keys(obj)) {
        if (METADATA_KEYS.includes(key)) {
          continue;
        }
        if (typeof obj[key] === "string") {
          obj[key] = "";
        } else if (typeof obj[key] === "object") {
          clearDeltas(obj[key]);
        }
      }
    };
    clearDeltas(finalJson);

    const populateRemaining = (obj: any, currentChoiceIdx = 0, currentToolIdx = 0) => {
      if (!obj || typeof obj !== "object") return;

      let choiceIdx = currentChoiceIdx;
      let toolIdx = currentToolIdx;

      if (typeof obj.index === "number") {
        if (obj.delta || obj.message || obj.finish_reason) {
          choiceIdx = obj.index;
        } else if (obj.function || obj.id || obj.type === "function") {
          toolIdx = obj.index;
        } else {
          choiceIdx = obj.index;
        }
      }

      const compositeKey = `${choiceIdx}_${toolIdx}`;

      for (const key of Object.keys(obj)) {
        if (METADATA_KEYS.includes(key)) {
          continue;
        }
        if (typeof obj[key] === "string") {
          const field: FieldCategory = getFieldCategory(key);
          const choiceBuf = getBuffers(compositeKey);
          if (choiceBuf[field]) {
            obj[key] = (obj[key] || "") + choiceBuf[field];
            choiceBuf[field] = "";
          }
        } else if (typeof obj[key] === "object") {
          populateRemaining(obj[key], choiceIdx, toolIdx);
        }
      }
    };

    populateRemaining(finalJson, 0, 0);

    // Clear all buffers
    for (const buffers of choiceBuffers.values()) {
      buffers.content = "";
      buffers.reasoning = "";
      buffers.toolArgs = "";
      buffers.partialJson = "";
    }

    return finalJson;
  };

  // Drain the window-held tail of a rolling buffer into a properly-framed delta event
  // right before the matching final-snapshot event, so the streamed deltas add up to the
  // full text exactly once and reasoning stays in its own event stream. Content drains at
  // response.output_text.done; reasoning drains at its own *.done event, never mixing.
  const onSnapshotDrain = (json: any): Array<{ type: string; payload: any }> => {
    if (!json || typeof json.type !== "string") return [];
    const type = json.type;
    const events: Array<{ type: string; payload: any }> = [];
    const buffers = getBuffers("0_0");

    if (type === "response.output_text.done" && buffers.content) {
      const drained = sanitizePII(buffers.content, false, forceEnabled).text;
      buffers.content = "";
      if (drained) {
        events.push({
          type: "response.output_text.delta",
          payload: {
            type: "response.output_text.delta",
            item_id: json.item_id,
            output_index: typeof json.output_index === "number" ? json.output_index : 0,
            content_index: typeof json.content_index === "number" ? json.content_index : 0,
            delta: drained,
            logprobs: [],
          },
        });
      }
    }

    if (
      (type === "response.reasoning_summary_text.done" ||
        type === "response.reasoning_text.done") &&
      buffers.reasoning
    ) {
      const drained = sanitizePII(buffers.reasoning, false, forceEnabled).text;
      buffers.reasoning = "";
      if (drained) {
        const deltaType =
          type === "response.reasoning_text.done"
            ? "response.reasoning_text.delta"
            : "response.reasoning_summary_text.delta";
        const payload: Record<string, unknown> = {
          type: deltaType,
          item_id: json.item_id,
          output_index: typeof json.output_index === "number" ? json.output_index : 0,
          delta: drained,
        };
        if (typeof json.summary_index === "number") payload.summary_index = json.summary_index;
        if (typeof json.content_index === "number") payload.content_index = json.content_index;
        events.push({ type: deltaType, payload });
      }
    }

    return events;
  };

  return createSseTextTransform(processor, onFlush, undefined, onSnapshotDrain);
}
