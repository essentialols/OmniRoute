export type FieldCategory = "content" | "reasoning" | "toolArgs" | "partialJson";

const CATEGORY_MAP: Record<string, FieldCategory> = {
  reasoning: "reasoning",
  thinking: "reasoning",
  reasoning_content: "reasoning",
  arguments: "toolArgs",
  partial_json: "partialJson",
};

export function getFieldCategory(key: string): FieldCategory {
  return CATEGORY_MAP[key] || "content";
}

// OpenAI Responses API events whose `delta` field carries tool-argument / apply_patch
// JSON, NOT prose. Only `response.output_text.delta` should be sanitized as text; the
// tool-argument delta variants must pass through untouched (routing them into the PII
// rolling-content buffer scrambles them exactly like the item_id/status class did).
const TOOL_ARG_DELTA_EVENT_TYPES = new Set([
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

// Resolve a string field's category with awareness of the enclosing SSE event type.
// The `delta` key is prose only for response.output_text.delta; for the tool-argument
// delta events it is structured JSON and is treated as toolArgs (passthrough).
export function resolveFieldCategory(key: string, eventType?: unknown): FieldCategory {
  if (
    key === "delta" &&
    typeof eventType === "string" &&
    TOOL_ARG_DELTA_EVENT_TYPES.has(eventType)
  ) {
    return "toolArgs";
  }
  return getFieldCategory(key);
}

const STOP_EVENT_TYPES = new Set([
  "response.done",
  "response.completed",
  "response.cancelled",
  "response.failed",
]);

export function checkIfStopSignal(json: any): boolean {
  if (!json || typeof json !== "object") return false;
  if (json.choices && Array.isArray(json.choices) && json.choices.some((c: any) => c.finish_reason))
    return true;
  if (
    json.candidates &&
    Array.isArray(json.candidates) &&
    json.candidates.some((c: any) => c.finishReason)
  )
    return true;
  if (json.type === "content_block_stop") return true;
  if (json.type === "message_stop") return true;
  if (json.type === "message_delta" && json.delta?.stop_reason) return true;
  if (STOP_EVENT_TYPES.has(json.type)) return true;
  return false;
}

export function checkIfSnapshot(json: any): boolean {
  if (!json || typeof json !== "object") return false;
  if (typeof json.type === "string") {
    const t = json.type;
    if (t.endsWith(".done") || t.endsWith(".completed") || STOP_EVENT_TYPES.has(t)) return true;
  }
  return false;
}

const fallbackDecoder = new TextDecoder();

export function createSseTextTransform(
  processor: (
    text: string,
    field: FieldCategory,
    isStopSignal?: boolean,
    index?: string | number,
    isSnapshot?: boolean
  ) => string,
  onFlush?: (lastJson: any, isJsonStream?: boolean, lastContentJson?: any) => any,
  onCancel?: () => void
): TransformStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";
  let lastPrefix = "data: ";
  let lastJson: any = null;
  let lastContentJson: any = null;
  let isJsonStream = false;
  let flushed = false;
  let errored = false;
  let currentEventLine = "";
  let lastEventLine = "";
  let pendingEventLine = "";

  const handleLine = (line: string, controller: TransformStreamDefaultController) => {
    const trimmed = line.trim();
    if (trimmed === "" || line.startsWith(":")) {
      // Pass comments and empty lines through unchanged
      if (trimmed === "") {
        currentEventLine = "";
      }
      if (pendingEventLine) {
        controller.enqueue(encoder.encode(pendingEventLine + "\n"));
        pendingEventLine = "";
      }
      controller.enqueue(encoder.encode(line + "\n"));
      return;
    }

    if (line.startsWith("data:")) {
      const prefix = line.startsWith("data: ") ? "data: " : "data:";
      lastPrefix = prefix;
      const segment = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      if (segment === "[DONE]") {
        if (onFlush && !flushed) {
          const flushedValue = onFlush(lastJson, isJsonStream, lastContentJson);
          if (flushedValue) {
            const prefix = lastPrefix || "data: ";
            const payload =
              typeof flushedValue === "string" ? flushedValue : JSON.stringify(flushedValue);
            if (lastEventLine) {
              controller.enqueue(encoder.encode(lastEventLine + "\n"));
            }
            controller.enqueue(encoder.encode(prefix + payload + "\n\n"));
          }
          flushed = true;
        }
        if (pendingEventLine) {
          controller.enqueue(encoder.encode(pendingEventLine + "\n"));
          pendingEventLine = "";
        }
        controller.enqueue(encoder.encode(line + "\n"));
        return;
      }

      const trimmedSegment = segment.trim();
      if (trimmedSegment.startsWith("{") || trimmedSegment.startsWith("[")) {
        try {
          const json = JSON.parse(trimmedSegment);
          isJsonStream = true;

          let matched = false;

          const isStopSignal = checkIfStopSignal(json);
          const isSnapshot = checkIfSnapshot(json);

          const METADATA_KEYS = [
            "id",
            // OpenAI Responses API structural identifier repeated on every event
            // (response.output_text.delta / .content_part.* / .output_item.*).
            // It is not model output, so it must never be buffered/sanitized: doing
            // so funneled it into the shared rolling-content buffer and cross-
            // contaminated the sibling `delta` text (fields scrambled, #responses-stream).
            "item_id",
            // function_call / custom_tool_call correlation id (bare non-snapshot string
            // on response.output_item.added, openai-responses.ts ~L393/400). Same
            // scrambling class as item_id; codex relies on it to correlate tool calls.
            "call_id",
            // custom_tool_call / custom_tool_call_input.done raw apply_patch payload
            // (openai-responses.ts ~L392/452/458). Structured patch, must not be PII-split.
            "input",
            "model",
            "object",
            "created",
            // Responses API lifecycle enum ("in_progress"/"completed"/...). Structural,
            // never PII; buffering it leaked "in_progress" into visible deltas.
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

          // Recursively sanitize all string properties (except system metadata)
          const sanitizeObject = (obj: any, currentChoiceIdx = 0, currentToolIdx = 0) => {
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
                const val = obj[key];
                const field: FieldCategory = resolveFieldCategory(key, json.type);
                if (field === "toolArgs" || field === "partialJson") {
                  obj[key] = val;
                  matched = true;
                  continue;
                }
                obj[key] = processor(val, field, isStopSignal, compositeKey, isSnapshot);
                matched = true;
              } else if (typeof obj[key] === "object") {
                sanitizeObject(obj[key], choiceIdx, toolIdx);
              }
            }
          };

          sanitizeObject(json, 0, 0);

          if (!matched) {
            console.warn(
              "[SSE-TRANSFORM] No string fields sanitized in SSE JSON chunk. Keys:",
              Object.keys(json).slice(0, 5).join(", ")
            );
          } else {
            lastContentJson = json;
          }

          if (isStopSignal && onFlush && !flushed) {
            const flushedValue = onFlush(
              lastJson || json,
              isJsonStream,
              lastContentJson || lastJson || json
            ); // Use json as fallback just in case
            if (flushedValue) {
              const prefix = lastPrefix || "data: ";
              const payload =
                typeof flushedValue === "string" ? flushedValue : JSON.stringify(flushedValue);
              // Only enqueue if the flushed value actually has content (onFlush usually returns null if buffer is empty now)
              if (lastEventLine) {
                controller.enqueue(encoder.encode(lastEventLine + "\n"));
              }
              controller.enqueue(encoder.encode(prefix + payload + "\n\n"));
            }
            flushed = true;
          }

          if (!isStopSignal && !isSnapshot) {
            lastEventLine = currentEventLine;
          }

          lastJson = json;
          if (pendingEventLine) {
            controller.enqueue(encoder.encode(pendingEventLine + "\n"));
            pendingEventLine = "";
          }
          controller.enqueue(encoder.encode(prefix + JSON.stringify(json) + "\n"));
        } catch (err: any) {
          if (err?.message?.startsWith("[PII]")) {
            throw err;
          }
          if (err instanceof SyntaxError) {
            // JSON parsing failed. Check if it looks like JSON that failed to parse.
            if (trimmedSegment.startsWith("{") || trimmedSegment.startsWith("[")) {
              console.warn(
                "[SSE-TRANSFORM] Dropping malformed JSON chunk to prevent syntax injection:",
                trimmedSegment.slice(0, 100)
              );
              pendingEventLine = "";
            } else {
              if (pendingEventLine) {
                controller.enqueue(encoder.encode(pendingEventLine + "\n"));
                pendingEventLine = "";
              }
              // Treat segment as raw text delta (fail-open)
              const processed = processor(segment, "content");
              controller.enqueue(encoder.encode(prefix + processed + "\n"));
            }
          } else {
            throw err;
          }
        }
      } else {
        // Starts with data: but not JSON, process as raw text
        lastEventLine = currentEventLine;
        const processed = processor(segment, "content");
        if (pendingEventLine) {
          controller.enqueue(encoder.encode(pendingEventLine + "\n"));
          pendingEventLine = "";
        }
        controller.enqueue(encoder.encode(prefix + processed + "\n"));
      }
    } else {
      // Non-data line, pass through (e.g. event: content_block_delta)
      if (line.startsWith("event:")) {
        if (pendingEventLine) {
          controller.enqueue(encoder.encode(pendingEventLine + "\n"));
        }
        currentEventLine = line;
        pendingEventLine = line;
      } else {
        if (pendingEventLine) {
          controller.enqueue(encoder.encode(pendingEventLine + "\n"));
          pendingEventLine = "";
        }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      try {
        const chunkStr = decoder.decode(chunk, { stream: true });
        lineBuffer += chunkStr;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
          handleLine(line, controller);
        }
      } catch (err: any) {
        let context = "[REDACTED_DUE_TO_PII]";
        if (!err?.message?.startsWith("[PII]")) {
          if (typeof chunk === "string") {
            context = chunk.slice(0, 200);
          } else if (chunk instanceof Uint8Array) {
            context = fallbackDecoder.decode(chunk.slice(0, 200));
          } else {
            context = String(chunk).slice(0, 200);
          }
        }
        console.error("[SSE-TRANSFORM] Error in transform:", err, "chunk:", context);
        lineBuffer = "";
        errored = true;
        controller.error(err);
      }
    },
    flush(controller) {
      if (errored) return;
      try {
        const remaining = decoder.decode() + lineBuffer;
        if (remaining) {
          handleLine(remaining, controller);
        }
        if (pendingEventLine) {
          controller.enqueue(encoder.encode(pendingEventLine + "\n"));
          pendingEventLine = "";
        }
        if (onFlush && !flushed) {
          const flushedValue = onFlush(lastJson, isJsonStream, lastContentJson);
          if (flushedValue) {
            const prefix = lastPrefix || "data: ";
            const payload =
              typeof flushedValue === "string" ? flushedValue : JSON.stringify(flushedValue);
            if (lastEventLine) {
              controller.enqueue(encoder.encode(lastEventLine + "\n"));
            }
            controller.enqueue(encoder.encode(prefix + payload + "\n\n"));
          }
        }
      } catch (err) {
        console.error("[SSE-TRANSFORM] Error in flush:", err);
        controller.error(err);
      }
    },
    cancel(reason: any) {
      if (onCancel) {
        onCancel();
      }
    },
  } as any);
}
