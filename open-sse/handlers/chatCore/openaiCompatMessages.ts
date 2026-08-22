/**
 * OpenAI-compatible upstream message normalization (Codex CLI / Responses-API
 * compatibility).
 *
 * Two normalizations applied only to OpenAI-format upstreams (see prepareUpstreamBody,
 * gated on targetFormat === "openai"), so gemini/claude/anthropic paths with their own
 * dedicated system/content handling are never touched:
 *
 *  1. flattenTextOnlyContent — collapse a multipart content array that contains ONLY
 *     text parts into a single joined string. Responses clients (Codex) always emit
 *     content as `[{type:"text",text}]`; some strict text-only OpenAI-compat models
 *     (e.g. llm7's gemma3:27b via Ollama) reject ANY array-form content as
 *     "does not support vision input". Arrays carrying image_url/file parts (genuine
 *     multimodal input) are left intact.
 *
 *  2. mergeConsecutiveSystemMessages — coalesce a run of adjacent `system` messages
 *     into one. After the developer -> system role normalization, Codex's
 *     `[system(instructions), developer, user, user]` becomes `[system, system, ...]`,
 *     and strict upstreams (e.g. uncloseai / hermes) reject a second system message
 *     with "System message must be at the beginning." Merging the leading system run
 *     into a single system message satisfies that constraint. Only ADJACENT system
 *     messages are merged, so a legitimate mid-conversation shape is never reordered.
 *
 * Both helpers are pure and return the original array reference unchanged when there is
 * nothing to normalize (referential no-op for the common case).
 */

type JsonRecord = Record<string, unknown>;

function isTextPart(part: unknown): part is { type: "text"; text?: unknown } {
  return (
    !!part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part as JsonRecord).type === "text"
  );
}

/** Extract the concatenated text of a content value (string or text-part array). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isTextPart(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

/**
 * Collapse text-only multipart content arrays to a single string. Content arrays that
 * contain any non-text part (image_url, file, input_audio, ...) are preserved as-is.
 */
export function flattenTextOnlyContent<T extends JsonRecord>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const content = (msg as JsonRecord).content;
    if (!Array.isArray(content) || content.length === 0) return msg;
    if (!content.every(isTextPart)) return msg; // has a non-text (multimodal) part
    changed = true;
    return { ...msg, content: contentToText(content) };
  });
  return changed ? out : messages;
}

/**
 * Merge adjacent `system` messages into a single system message with string content.
 */
export function mergeConsecutiveSystemMessages<T extends JsonRecord>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const out: T[] = [];
  let merged = false;
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      msg &&
      typeof msg === "object" &&
      (msg as JsonRecord).role === "system" &&
      (prev as JsonRecord).role === "system"
    ) {
      const prevText = contentToText((prev as JsonRecord).content);
      const curText = contentToText((msg as JsonRecord).content);
      const combined = [prevText, curText].filter((t) => t.length > 0).join("\n\n");
      out[out.length - 1] = { ...prev, content: combined };
      merged = true;
      continue;
    }
    out.push(msg);
  }
  return merged ? out : messages;
}

/**
 * Apply both OpenAI-compat message normalizations. Flattening runs first so a
 * developer-turned-system message with array content becomes a string before the
 * system-merge concatenates it.
 */
export function normalizeOpenAICompatMessages(body: JsonRecord): JsonRecord {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return body;
  const original = body.messages as JsonRecord[];
  let messages = flattenTextOnlyContent(original);
  messages = mergeConsecutiveSystemMessages(messages);
  if (messages === original) return body;
  return { ...body, messages };
}
