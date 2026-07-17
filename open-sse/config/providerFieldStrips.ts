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
 * Codex CLI's sub-agent orchestration tool group. Codex injects it on every request as a
 * Responses-API `namespace` tool (`multi_agent_v1`); the responses→chat translator flattens
 * it into these five individual Chat functions (`spawn_agent` alone carries a multi-paragraph
 * delegation guide). Their combined schema is ~2.9k tokens — ~23% of a minimal codex request.
 * They are codex-internal orchestration primitives that a plain Chat Completions provider
 * cannot act on, so dropping them for budget-constrained providers is lossless in practice.
 */
const CODEX_SUBAGENT_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "resume_agent",
  "send_input",
]);

/**
 * OpenAI-format providers whose per-request token budget is too small to fit codex's full
 * injected tool catalog. Groq's free tier caps each request at 12,000 tokens-per-minute; a
 * bare `codex exec` request measures ~12,957 tokens (system instructions ~5.3k + the tool
 * schemas ~5.5k, of which the sub-agent group is ~2.9k), so groq 413s the whole request
 * ("Request too large ... Limit 12000, Requested 12957") before streaming — surfacing to the
 * Codex/Responses client as "stream closed before response.completed" (5x reconnect). Prompt
 * compression cannot help: it operates on messages/tool-outputs, not tool *definitions* or the
 * (cache-preserved) system prompt, so it saves ~0 tokens here. Dropping the sub-agent
 * orchestration group brings the request to ~10k tokens, under the cap.
 */
export const PROVIDERS_WITH_LOW_TOOL_TOKEN_BUDGET: ReadonlySet<string> = new Set(["groq"]);

/** Extract a tool's function name from either Chat (`function.name`) or Responses (`name`) shape. */
function toolFunctionName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const record = tool as Record<string, unknown>;
  const fn = record.function as Record<string, unknown> | undefined;
  const name = fn && typeof fn === "object" ? fn.name : record.name;
  return typeof name === "string" ? name : "";
}

/**
 * Drop codex's heavy sub-agent orchestration tools for providers whose per-request token
 * budget cannot fit the full codex tool catalog. Returns a new object only when something was
 * stripped; otherwise returns `body` unchanged (referential no-op for the common case). Never
 * touches `tool_choice`/`parallel_tool_calls` and leaves every other tool intact, so the model
 * keeps `exec_command`, file, and MCP tools.
 */
export function stripHeavyCodexToolsForBudget<T extends Record<string, unknown>>(
  body: T,
  provider: string | null | undefined
): T {
  if (!body || typeof body !== "object" || !Array.isArray(body.tools)) return body;
  const id = (provider ?? "").trim().toLowerCase();
  if (!PROVIDERS_WITH_LOW_TOOL_TOKEN_BUDGET.has(id)) return body;

  const filtered = body.tools.filter(
    (tool) => !CODEX_SUBAGENT_ORCHESTRATION_TOOLS.has(toolFunctionName(tool))
  );
  if (filtered.length === body.tools.length) return body;
  return { ...body, tools: filtered };
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

// ── JSON Schema pattern anchoring (llama.cpp grammar engine compatibility) ────
//
// llama.cpp's grammar-based constrained decoding requires every `pattern` in a JSON
// schema to be fully anchored (`^…$`). Without anchors llama-server rejects the
// request with:
//   "Pattern must start with '^' and end with '$'"
// Cloud providers (OpenAI, Anthropic, Gemini, …) accept anchored patterns, so this
// is safe to apply broadly for OpenAI-compat local backends.

const MAX_SCHEMA_DEPTH = 32;

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Recursively anchor every `pattern` value in a JSON Schema object.
 *  Returns the original object when nothing changed (identity-preserving). */
function anchorPatternsInSchema(schema: unknown, depth = 0): unknown {
  if (depth > MAX_SCHEMA_DEPTH || !isPlainObj(schema)) return schema;

  let changed = false;
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(schema)) {
    if (k === "pattern" && typeof v === "string") {
      let p = v;
      if (!p.startsWith("^")) p = "^" + p;
      if (!p.endsWith("$")) p = p + "$";
      if (p !== v) changed = true;
      result[k] = p;
    } else if (
      (k === "properties" || k === "$defs" || k === "definitions" || k === "dependentSchemas") &&
      isPlainObj(v)
    ) {
      const cleaned: Record<string, unknown> = {};
      let subChanged = false;
      for (const [pk, pv] of Object.entries(v)) {
        const anchored = anchorPatternsInSchema(pv, depth + 1);
        if (anchored !== pv) subChanged = true;
        cleaned[pk] = anchored;
      }
      if (subChanged) {
        changed = true;
        result[k] = cleaned;
      } else {
        result[k] = v;
      }
    } else if (k === "patternProperties" && isPlainObj(v)) {
      const cleaned: Record<string, unknown> = {};
      let subChanged = false;
      for (const [pk, pv] of Object.entries(v)) {
        let anchoredKey = pk;
        if (!pk.startsWith("^")) anchoredKey = "^" + anchoredKey;
        if (!pk.endsWith("$")) anchoredKey = anchoredKey + "$";
        if (anchoredKey !== pk) subChanged = true;
        const anchoredVal = anchorPatternsInSchema(pv, depth + 1);
        if (anchoredVal !== pv) subChanged = true;
        cleaned[anchoredKey] = anchoredVal;
      }
      if (subChanged) {
        changed = true;
        result[k] = cleaned;
      } else {
        result[k] = v;
      }
    } else if (
      (k === "items" ||
        k === "additionalProperties" ||
        k === "not" ||
        k === "if" ||
        k === "then" ||
        k === "else" ||
        k === "contains" ||
        k === "unevaluatedProperties" ||
        k === "unevaluatedItems") &&
      isPlainObj(v)
    ) {
      const anchored = anchorPatternsInSchema(v, depth + 1);
      if (anchored !== v) changed = true;
      result[k] = anchored;
    } else if (
      (k === "anyOf" || k === "oneOf" || k === "allOf" || k === "prefixItems") &&
      Array.isArray(v)
    ) {
      const mapped = v.map((s) => anchorPatternsInSchema(s, depth + 1));
      const arrayChanged = mapped.some((m, i) => m !== v[i]);
      if (arrayChanged) changed = true;
      result[k] = arrayChanged ? mapped : v;
    } else {
      result[k] = v;
    }
  }

  return changed ? result : schema;
}

/**
 * Walk all JSON Schema locations in a Chat Completions request body and anchor every
 * `pattern` field with `^` / `$` so llama.cpp's grammar engine can compile them.
 *
 * Locations: `tools[].function.parameters`, `response_format.json_schema.schema`.
 * Returns a new object only when something was changed; otherwise returns `body`
 * unchanged (referential no-op).
 */
export function anchorJsonSchemaPatterns<T extends Record<string, unknown>>(body: T): T {
  if (!body || typeof body !== "object") return body;

  let changed = false;
  let next: Record<string, unknown> = body;

  // 1. tools[].function.parameters
  if (Array.isArray(body.tools)) {
    const originalTools = body.tools as unknown[];
    const anchored = originalTools.map((tool) => {
      if (!isPlainObj(tool)) return tool;
      const fn = tool.function as Record<string, unknown> | undefined;
      if (!isPlainObj(fn) || !isPlainObj(fn.parameters)) return tool;
      const anchoredParams = anchorPatternsInSchema(fn.parameters);
      if (anchoredParams === fn.parameters) return tool;
      return { ...tool, function: { ...fn, parameters: anchoredParams } };
    });
    if (anchored.some((t, i) => t !== originalTools[i])) {
      if (!changed) {
        next = { ...body };
        changed = true;
      }
      next.tools = anchored;
    }
  }

  // 2. response_format.json_schema.schema
  const rf = body.response_format;
  if (isPlainObj(rf)) {
    const js = rf.json_schema;
    if (isPlainObj(js) && isPlainObj(js.schema)) {
      const anchoredSchema = anchorPatternsInSchema(js.schema);
      if (anchoredSchema !== js.schema) {
        if (!changed) {
          next = { ...body };
          changed = true;
        }
        next.response_format = { ...rf, json_schema: { ...js, schema: anchoredSchema } };
      }
    }
  }

  return next as T;
}

// ── Tool & schema canonicalization (prefix-cache hit maximization) ──────────
//
// llama-server (and MLX-VLM APC) reuses the KV cache for the longest matching
// token prefix. Tool definitions are part of the prompt, so if the same set of
// tools arrives in a different JSON key order or array order across requests,
// the tokenized prefix diverges and the cache misses. Sorting the tools array
// into a deterministic order ensures identical tool sets produce the same prefix.
//
// We intentionally do NOT sort keys within each tool's JSON Schema (parameters).
// llama-server's grammar engine generates production rules based on property key
// order; reordering them can produce unparseable grammars on some backends.

/**
 * Sort the `tools` array in a Chat Completions request body by (type, function.name)
 * so identical tool sets always occupy the same position in the token prefix.
 *
 * Tool internals (key order, schema structure) are left untouched to avoid breaking
 * llama-server grammar generation.
 *
 * Returns `body` unchanged (referential no-op) when there are no tools.
 */
export function canonicalizeTools<T extends Record<string, unknown>>(body: T): T {
  if (!body || typeof body !== "object" || !Array.isArray(body.tools) || body.tools.length === 0) {
    return body;
  }

  const tools = body.tools as unknown[];
  const sorted = [...tools].sort((a, b) => {
    const recA = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const recB = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const typeA = String(recA.type ?? "");
    const typeB = String(recB.type ?? "");
    if (typeA !== typeB) return typeA < typeB ? -1 : 1;
    const nameA = toolFunctionName(a);
    const nameB = toolFunctionName(b);
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return 0;
  });

  // Only allocate a new object if the order actually changed.
  if (sorted.every((t, i) => t === tools[i])) return body;
  return { ...body, tools: sorted };
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
