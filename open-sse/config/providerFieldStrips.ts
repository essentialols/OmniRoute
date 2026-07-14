// Fields that, when literally named in an upstream 400 body, are safe to strip and
// retry once (FCC NIM-style recovery). Mirrors the existing context_management 400
// fallback in base.ts, generalized to these OpenAI-compat / NIM reasoning fields.
// `context_management` (9router#1468): Claude Code sends it top-level; strict
// anthropic-compatible gateways 400 with "context_management: Extra inputs are not
// permitted". The dedicated base.ts fallback only fires when OmniRoute's own
// contextEditing feature is enabled, so a client-sent field passed through
// untouched when the feature is off — this generic strip covers that case.
export const KNOWN_OFFENDING_FIELDS: readonly string[] = [
  "reasoning_budget",
  "chat_template",
  "reasoning_content",
  "context_management",
];

/** Return the first known-offending field literally named in a 400 body, or null. */
export function findOffendingField(bodyText: string): string | null {
  if (typeof bodyText !== "string" || !bodyText) return null;
  for (const field of KNOWN_OFFENDING_FIELDS) {
    if (bodyText.includes(field)) return field;
  }
  return null;
}

// Tool-field capability strips (Codex CLI / Responses-API compatibility).
//
// Codex always injects `tools`, `tool_choice:"auto"` and `parallel_tool_calls:true`
// on every request. A few strict OpenAI-compatible upstreams reject those fields and
// return a 4xx before streaming any content, which surfaces to the Responses client
// as "stream closed before response.completed" (5x reconnect). These are proactive,
// provider-capability strips (mirrors the prompt_cache_key/groq precedent) so a codex
// request completes instead of failing on an unsupported field.

/**
 * OpenAI-format providers that reject the `parallel_tool_calls` field.
 * cohere's OpenAI-compatibility endpoint returns HTTP 422
 * "unprocessable entity: parallel_tool_calls is not supported".
 */
export const PROVIDERS_WITHOUT_PARALLEL_TOOL_CALLS: ReadonlySet<string> = new Set(["cohere"]);

/**
 * OpenAI-format providers whose upstream cannot do tool calling at all, so the whole
 * `tools`/`tool_choice`/`parallel_tool_calls` trio must be dropped. publicai serves
 * apertus via a litellm/vLLM backend that is not started with
 * `--enable-auto-tool-choice`, so ANY request carrying tools (with or without an
 * explicit tool_choice) 400s with
 * `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser`.
 */
export const PROVIDERS_WITHOUT_TOOL_CALLING: ReadonlySet<string> = new Set(["publicai"]);

/**
 * Drop tool-related request fields the given OpenAI-format provider cannot accept.
 * Returns a new object only when something was stripped; otherwise returns `body`
 * unchanged (referential no-op for the common case).
 */
export function stripUnsupportedToolFields<T extends Record<string, unknown>>(
  body: T,
  provider: string | null | undefined
): T {
  if (!body || typeof body !== "object") return body;
  const id = (provider ?? "").trim().toLowerCase();
  if (!id) return body;

  if (PROVIDERS_WITHOUT_TOOL_CALLING.has(id)) {
    if (
      body.tools !== undefined ||
      body.tool_choice !== undefined ||
      body.parallel_tool_calls !== undefined
    ) {
      const next: Record<string, unknown> = { ...body };
      delete next.tools;
      delete next.tool_choice;
      delete next.parallel_tool_calls;
      return next as T;
    }
    return body;
  }

  if (PROVIDERS_WITHOUT_PARALLEL_TOOL_CALLS.has(id) && body.parallel_tool_calls !== undefined) {
    const next: Record<string, unknown> = { ...body };
    delete next.parallel_tool_calls;
    return next as T;
  }

  return body;
}

/**
 * Reactive counterpart to the proactive strips above: detect an upstream 4xx that means
 * "this model cannot do tool calling (or rejects the multipart content tools imply)".
 * Model-precise and provider-agnostic, so it catches per-model gaps a provider-wide list
 * cannot (e.g. llm7 serves both tool-capable models AND gemma3:27b, which returns
 * "Model 'gemma3:27b' does not support tools." / "does not support vision input.").
 * Also covers the litellm/vLLM auto-tool-choice message. Matched case-insensitively.
 */
const TOOL_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /does not support tools/i,
  /does not support (?:vision|image) input/i,
  /tool(?:s| calling| use)? (?:is |are )?not supported/i,
  /tool choice requires --enable-auto-tool-choice/i,
  /enable-auto-tool-choice/i,
];

/** True when an upstream error body indicates the model cannot accept tools/tool_choice. */
export function isToolUnsupportedError(bodyText: string): boolean {
  if (typeof bodyText !== "string" || !bodyText) return false;
  return TOOL_UNSUPPORTED_PATTERNS.some((re) => re.test(bodyText));
}

/**
 * Drop the entire tool-calling trio from a body in place. Returns true when any field was
 * present (i.e. a retry is worthwhile). Used by the reactive base.ts downgrade.
 */
export function stripAllToolFields(body: Record<string, unknown>): boolean {
  if (!body || typeof body !== "object") return false;
  const had =
    body.tools !== undefined ||
    body.tool_choice !== undefined ||
    body.parallel_tool_calls !== undefined;
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  return had;
}

/** Immutably drop request fields Groq rejects with a 400. */
export function stripGroqUnsupportedFields<T extends Record<string, unknown>>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const next: Record<string, unknown> = { ...body };
  delete next.logprobs;
  delete next.logit_bias;
  delete next.top_logprobs;
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((m) => {
      if (m && typeof m === "object" && "name" in m) {
        const { name: _name, ...rest } = m as Record<string, unknown>;
        return rest;
      }
      return m;
    });
  }
  return next as T;
}
