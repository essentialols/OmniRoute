/**
 * Local-turn recovery + tool-call bridge for local chat-completion models (task #17).
 *
 * WHY: local models (lfm2 / ornith / gemma served via rapid-mlx / llama-swap) periodically end a
 * turn with finish_reason "stop", NO tool_call, and empty or announce-only content, which makes an
 * agentic client (Claude Code) halt mid-flow ("abrupt stop"). They also emit function-form
 * WebSearch / WebFetch tool calls that neither side executes ("Did 0 searches").
 *
 * WHAT: this module runs AFTER the (forced non-streaming) upstream completion is known but BEFORE
 * the response is re-emitted to the client, operating purely on OpenAI chat-completion JSON:
 *   1. Tool bridge (CHANGE 1): if the model called ONLY bridged tools
 *      (WebSearch / WebFetch / omniroute_web_search), execute them server-side, append role:"tool"
 *      results, and resample so the model incorporates the results. A turn that also contains a
 *      native (client) tool call is handed back untouched so the client still executes it.
 *   2. Dead-turn recovery (CHANGE 2): if the final turn is empty / a raw-tool-call leak /
 *      an action-announcement-without-action / a false-capability refusal, resample ONCE with a
 *      directive nudge. If that also dead-stops, emit an explicit terminal message.
 *
 * HOW IT PRESERVES STREAMING: the caller re-emits the returned OpenAI JSON as an SSE stream
 * (synthesizeOpenAiSseFromJson) that flows through the normal OpenAI->Claude streaming translation,
 * so the client contract (Anthropic SSE) is preserved. This deliberately trades token-level
 * streaming granularity on these local turns for correctness: server-side tool execution and
 * resample are impossible on a truly-incremental stream that has already forwarded the tool_use /
 * partial-text blocks to the client. Only allowlisted local providers are affected; cloud /
 * passthrough / Responses / Codex traffic is a strict no-op.
 */

type JsonRecord = Record<string, unknown>;

/** Header set on internal resample calls so a bridged upstream never re-enters recovery. */
export const RECOVERY_ATTEMPT_HEADER = "x-omniroute-recovery-attempt";

/**
 * Sampling override applied to the recovery / tool-bridge resample calls. `null` = inherit the
 * request's own sampling (the DEFAULT). Eval data for this model class shows default sampling
 * beats greedy for tool-call recall, and the directive nudge does the forcing. To switch to
 * greedy set e.g. `{ temperature: 0, top_p: 1 }`. Single named constant so it is easy to change.
 */
export const RECOVERY_SAMPLING: JsonRecord | null = null;

/** Hidden user nudge appended before the single recovery resample. */
export const RECOVERY_NUDGE =
  "[Internal continuation] The previous attempt ended before completing the task. Take the next " +
  "required action now. If a tool is required, emit the tool call immediately. Do not announce or " +
  "explain the action. If no tool is required, provide the completed final answer.";

/** Terminal text emitted when even the recovery resample dead-stops (never a blank/silent halt). */
export const TERMINAL_FALLBACK_TEXT = "I wasn't able to complete the next action in this turn.";

/** Upper bound on server-side tool-bridge resamples, guards against a runaway search/fetch loop. */
export const MAX_BRIDGE_TOOL_ITERATIONS = 3;

/** Cap the serialized tool result appended to the conversation so it cannot blow the context. */
const MAX_TOOL_RESULT_CHARS = 100_000;

/**
 * Bridged tool name -> canonical builtin handler. Kept here (not imported from webSearchFallback)
 * to avoid a circular import; consumers (webSearchFallback, interception) import FROM this module.
 * `omniroute_web_search` is the fallback tool OmniRoute injects for native web_search; the rest are
 * Claude Code's function-form tools.
 */
export const BRIDGED_TOOL_ALIASES: Record<string, string> = {
  WebSearch: "web_search",
  web_search: "web_search",
  omniroute_web_search: "web_search",
  WebFetch: "web_fetch",
  web_fetch: "web_fetch",
};

export const BRIDGED_TOOL_NAMES = new Set(Object.keys(BRIDGED_TOOL_ALIASES));

export function canonicalBridgedName(name: string | null | undefined): string | null {
  if (!name || typeof name !== "string") return null;
  return BRIDGED_TOOL_ALIASES[name] ?? null;
}

// ── Dead-turn detector (regexes validated against real captures; do NOT revert to a
//    start-anchored announcement regex -- it misses real cases). ────────────────────────────────

// Raw-tool-call leak: the model spilled a tool call as plain text instead of a structured call.
// Uses the multiline flag so the `^\s*\[Name(` bare-call anchor matches per line.
const LEAK_RE =
  /<\s*tool_call|<\/?\s*function|<\s*parameter|tool_call_start|\bCall:\s*tools?\.|^\s*\[[A-Z][A-Za-z0-9_]*\(|"tool_name"\s*:/m;

// Trailing action announcement ("I'll call ...", "let me search ...", "next action: dispatch").
const ANNOUNCE_RE =
  /(?:i(?:'ll| will| am going to)|i'?m going to|let me|let's|next[, ]+i(?:'ll| will))\s+(?:actually\s+)?(?:call|use|run|read|inspect|check|search|browse|fetch|dispatch|delegate|open|look up|make (?:those|these|the) calls?)|next action:\s*(?:dispatch|search|run|read|fetch|call|use|browse)|make (?:those|these|the) calls? now/i;

// False-capability refusal ("I don't have the ability to search the web", "I can't browse online").
//
// The refusal must name a CAPABILITY or TOOLING object, not just any object. An unqualified
// `i can't … access` also matched legitimate answers like "I can't access the file because it
// doesn't exist", so a correct refusal got overwritten by a recovery nudge. Bounded quantifiers
// (`[^.!?]{0,160}?`) keep this to a single clause and prevent catastrophic backtracking.
const REFUSAL_RE =
  /\b(?:i (?:do not|don't) have (?:the )?(?:ability|capability|access)|i cannot|i can't)\b[^.!?]{0,160}?\b(?:search|browse|read|run|access|use|dispatch)\b[^.!?]{0,160}?\b(?:web|internet|online|real[-\s]?time|browser|browsing|external|tool|tools|command|commands|shell|terminal|subagent|agent)\b/i;

/**
 * Kill switch for leak salvage (below). Defaults ON; set OMNIROUTE_LEAK_SALVAGE=0 to disable
 * without a rebuild. Salvage runs on a hot path and synthesises a tool call the model never
 * structurally emitted, so it must be switchable from config alone.
 */
export function isLeakSalvageEnabled(): boolean {
  const v = (process.env.OMNIROUTE_LEAK_SALVAGE ?? "1").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// A leaked search call, in the dialects local models actually emit. Observed from H1 gemma:
//   <|tool_call>call:google_search:search{queries:[{"query":"X"}]}<tool_call|>
//   <|tool_call>call:google_search:search{queries:["X"]}<tool_call|>
// and the generic <tool_call>{"name":"web_search","arguments":{"query":"X"}}</tool_call>.
// Bounded quantifiers only; these run on model-controlled text.
const LEAKED_QUERY_PATTERNS = [
  /"query"\s*:\s*"((?:[^"\\]|\\.){1,400})"/i,
  /queries\s*:\s*\[\s*"((?:[^"\\]|\\.){1,400})"/i,
  /queries\s*:\s*\[\s*\{\s*"query"\s*:\s*"((?:[^"\\]|\\.){1,400})"/i,
];

/**
 * Pull a search query out of a leaked (plain-text) tool call.
 *
 * Returns null unless the leak actually looks like a SEARCH: a leak for some other tool must not
 * be silently turned into a web search. Detection of the leak itself is LEAK_RE's job; this only
 * extracts the argument.
 */
export function extractLeakedSearchQuery(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const window = text.slice(0, 4000);
  if (!/search/i.test(window)) return null;
  for (const re of LEAKED_QUERY_PATTERNS) {
    const m = re.exec(window);
    const q = m?.[1]?.replace(/\\"/g, '"').trim();
    if (q) return q.slice(0, 400);
  }
  return null;
}

/** Strip zero-width chars (ZWSP..ZWJ, BOM), collapse whitespace, trim. */
function normalize(text: string): string {
  return text
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Last 1-2 sentences of normalized text (the "trailing" window for the announcement check). */
function lastSentences(text: string, count = 2): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
  if (parts.length === 0) return text;
  return parts.slice(-count).join(" ");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFirstChoice(resp: JsonRecord): JsonRecord | null {
  const choices = resp.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  return isRecord(choices[0]) ? choices[0] : null;
}

function getFirstMessage(resp: JsonRecord): JsonRecord | null {
  const choice = getFirstChoice(resp);
  if (!choice) return null;
  return isRecord(choice.message) ? choice.message : null;
}

function rawContent(message: JsonRecord | null): string {
  if (!message) return "";
  return typeof message.content === "string" ? message.content : "";
}

interface BridgedCall {
  id: string;
  name: string;
  arguments: JsonRecord;
}

function parseArguments(raw: unknown): JsonRecord {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function extractToolCalls(message: JsonRecord | null): {
  id: string;
  name: string;
  arguments: JsonRecord;
}[] {
  if (!message || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls
    .map((tc, index) => {
      if (!isRecord(tc)) return null;
      const fn = isRecord(tc.function) ? tc.function : {};
      const name =
        typeof fn.name === "string" ? fn.name : typeof tc.name === "string" ? tc.name : "";
      const id =
        typeof tc.id === "string" && tc.id
          ? tc.id
          : typeof tc.call_id === "string" && tc.call_id
            ? tc.call_id
            : `call_${index}`;
      return { id, name, arguments: parseArguments(fn.arguments ?? tc.arguments) };
    })
    .filter((c): c is { id: string; name: string; arguments: JsonRecord } => c !== null);
}

export interface DeadTurnDetection {
  recover: boolean;
  reason: string;
}

/**
 * Decide whether a completed OpenAI turn is a "dead turn" that should be resampled. See the module
 * header + the regexes above for the exact validated rules.
 */
export function detectDeadTurn(
  resp: JsonRecord,
  /**
   * True when a bridged search/fetch tool was offered on THIS request. Gates the
   * announce-then-fabricate rule below: without it that rule would misfire on any long,
   * legitimate answer that happens to mention searching.
   */
  bridgedToolAvailable = false
): DeadTurnDetection {
  const choice = getFirstChoice(resp);
  const finish = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (finish !== "stop") return { recover: false, reason: "finish_not_stop" };

  const message = getFirstMessage(resp);
  if (extractToolCalls(message).length > 0) return { recover: false, reason: "has_tool_calls" };

  const raw = rawContent(message);
  const norm = normalize(raw);

  if (norm.length === 0) return { recover: true, reason: "empty" };
  if (LEAK_RE.test(raw)) return { recover: true, reason: "tool_call_leak" };

  if (norm.length <= 500 && !norm.endsWith("?")) {
    if (ANNOUNCE_RE.test(lastSentences(norm, 2))) return { recover: true, reason: "announcement" };
    if (REFUSAL_RE.test(norm)) return { recover: true, reason: "refusal" };
  }

  // Announce-then-fabricate. A weak model says "I'll search for X" and then, instead of emitting
  // the tool call, invents the answer -- observed verbatim: "I'll search for information related
  // to ... Here's what I found: ### Key Findings: 1. ... (Hypothetical Approach)" with invented
  // URLs. The two checks above cannot see it: they only inspect the TRAILING sentences and bail
  // above 500 chars, and fabricated answers are long and lead with the announcement.
  //
  // This is the most dangerous dead turn, because it reaches the user as confident sourced-looking
  // prose. Length is therefore deliberately NOT a limit here. Safety comes from
  // `bridgedToolAvailable`: a turn that never had a search tool cannot be failing to call one, so
  // an ordinary long answer that merely mentions searching is untouched.
  if (bridgedToolAvailable && ANNOUNCE_RE.test(norm) && !norm.endsWith("?")) {
    return { recover: true, reason: "announced_without_tool_call" };
  }

  return { recover: false, reason: "ok" };
}

// ── Gating ──────────────────────────────────────────────────────────────────────────────────

const DEFAULT_LOCAL_TURN_RECOVERY_PROVIDERS = [
  "rapid-mlx",
  "lfm2",
  "lfm2-8b",
  "ornith",
  "gemma",
  "llama-swap",
  "local",
  "lmstudio",
  "ollama",
  "mlx",
  // On-device (Pixel 7 Pro) models. The P7P node id is a hex UUID, so it can never match by
  // token; these entries let the MODEL name carry the "local" signal instead.
  "smallthinker",
  "lfm2.5",
];

/**
 * Match a provider id against the local allowlist.
 *
 * Exact match, plus a TOKEN match: real provider ids are composed
 * (`openai-compatible-chat-h1-llamaswap`, `openai-compatible-chat-m2-mlx-router`), so an
 * exact-only check never fired for the very backends this module exists to serve, leaving
 * raw-tool-call leaks unrecovered. Tokens are compared with separators stripped so the
 * allowlist can keep writing `llama-swap` while the id carries `llamaswap`.
 *
 * Deliberately token-exact rather than substring: a substring test would also match an
 * unrelated future provider like `mlxcloud`, and this allowlist now gates server-side tool
 * execution, so widening it wrongly would execute a cloud client's tools.
 */
function stripSeparators(value: string): string {
  return value.replace(/[-_]/g, "");
}

function providerMatchesLocalAllowlist(provider: string, allowlist: Set<string>): boolean {
  if (allowlist.has(provider)) return true;
  const normalizedAllowlist = new Set([...allowlist].map(stripSeparators));
  return provider
    .split(/[-_]/)
    .filter(Boolean)
    .some((token) => normalizedAllowlist.has(token));
}

function localTurnRecoveryProviders(): Set<string> {
  const env = process.env.OMNIROUTE_LOCAL_TURN_RECOVERY_PROVIDERS;
  if (env && env.trim()) {
    return new Set(
      env
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return new Set(DEFAULT_LOCAL_TURN_RECOVERY_PROVIDERS);
}

/** Feature flag; defaults ON. Set OMNIROUTE_LOCAL_TURN_RECOVERY=0 to disable globally. */
export function isLocalTurnRecoveryEnabled(): boolean {
  const v = (process.env.OMNIROUTE_LOCAL_TURN_RECOVERY ?? "1").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * True when `provider` is one of the allowlisted local backends this module targets.
 *
 * Shares the allowlist with `resolveLocalTurnRecoveryPlan` so the streaming recovery path and the
 * non-streaming function-form tool bridge can never disagree about what counts as "local". The
 * bridge executes a client's tool server-side instead of returning it, so any route that is not
 * provably local must be excluded.
 */
export function isLocalBridgeProvider(
  provider: string | null | undefined,
  model?: string | null
): boolean {
  if (!isLocalTurnRecoveryEnabled()) return false;
  return matchesLocalAllowlist(provider, model);
}

/**
 * True when either the provider id or the model id identifies an allowlisted local backend.
 *
 * Some node ids are opaque (`openai-compatible-chat-38f92fd5-…` for the Pixel 7 Pro), so the
 * provider alone cannot prove locality. The model id (`smallthinker-4b-a0.6b`) can. A `p7p/`
 * style prefix is stripped so the model's own name is what gets tokenised.
 */
function matchesLocalAllowlist(
  provider: string | null | undefined,
  model?: string | null
): boolean {
  const allowlist = localTurnRecoveryProviders();
  const p = (provider ?? "").toLowerCase();
  if (p && providerMatchesLocalAllowlist(p, allowlist)) return true;
  const m = (model ?? "").toLowerCase();
  if (!m) return false;
  const bare = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  return providerMatchesLocalAllowlist(bare, allowlist);
}

/** True when the inbound request already carries the internal recovery marker header. */
export function hasRecoveryAttemptHeader(headers: unknown): boolean {
  if (!headers) return false;
  const getter = (headers as { get?: (name: string) => string | null }).get;
  if (typeof getter === "function") {
    return Boolean(getter.call(headers, RECOVERY_ATTEMPT_HEADER));
  }
  if (isRecord(headers)) {
    return Boolean(headers[RECOVERY_ATTEMPT_HEADER]);
  }
  return false;
}

export interface LocalTurnRecoveryGateInput {
  provider?: string | null;
  /** Resolved model id. Carries the local signal when the provider id is an opaque UUID. */
  model?: string | null;
  isClaudeSource: boolean;
  clientWantsStream: boolean;
  nativeCodexPassthrough: boolean;
  isResponsesEndpoint: boolean;
  recoveryHeaderPresent: boolean;
}

/**
 * Decide whether local-turn recovery should engage for this request. Conservative by design: only
 * allowlisted local providers on the streaming Claude path, never cloud / passthrough / Responses /
 * Codex, never a recursive recovery call.
 */
export function resolveLocalTurnRecoveryPlan(input: LocalTurnRecoveryGateInput): {
  active: boolean;
} {
  if (!isLocalTurnRecoveryEnabled()) return { active: false };
  if (!input.isClaudeSource) return { active: false };
  if (!input.clientWantsStream) return { active: false };
  if (input.nativeCodexPassthrough || input.isResponsesEndpoint) return { active: false };
  if (input.recoveryHeaderPresent) return { active: false };
  if (!matchesLocalAllowlist(input.provider, input.model)) return { active: false };
  return { active: true };
}

// ── Orchestration ──────────────────────────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n[truncated]";
  }
  return text;
}

/** Map the model's tool-call args onto the builtin handler's input shape. */
function normalizeBridgedArgs(canonical: string, args: JsonRecord): JsonRecord {
  if (canonical === "web_fetch") {
    // Claude Code sends { url, prompt }; the builtin fetches by url (the model uses the prompt).
    return { ...args };
  }
  // web_search: { query, ... } passes straight through.
  return { ...args };
}

function buildAssistantToolCallMessage(message: JsonRecord | null): JsonRecord {
  return {
    role: "assistant",
    content: message && typeof message.content === "string" ? message.content : null,
    tool_calls: message && Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
}

function buildTerminalFallback(resp: JsonRecord): JsonRecord {
  const clone: JsonRecord = { ...resp };
  const choice = getFirstChoice(resp);
  const baseChoice = choice ? { ...choice } : { index: 0 };
  baseChoice.message = { role: "assistant", content: TERMINAL_FALLBACK_TEXT };
  baseChoice.finish_reason = "stop";
  clone.choices = [baseChoice];
  return clone;
}

export interface LocalTurnRecoveryContext {
  /** Resample the model non-streaming with the given OpenAI message array. Returns parsed OpenAI
   *  chat-completion JSON, or null when the resample failed (network / non-200 / unparseable). */
  reinvoke: (messages: JsonRecord[]) => Promise<JsonRecord | null>;
  /** OpenAI messages already sent upstream for the first attempt (translatedBody.messages). */
  baseMessages: JsonRecord[];
  /** Execute a bridged tool by canonical name ("web_search" | "web_fetch"). */
  executeBridgedTool: (canonicalName: string, args: JsonRecord) => Promise<unknown>;
  /** True when this request offered a bridged search/fetch tool. Enables the
   *  announce-then-fabricate rule in detectDeadTurn; see that function's comment. */
  bridgedToolAvailable?: boolean;
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  } | null;
}

/**
 * Execute any pending bridged tool calls and resample, up to the shared iteration budget. Returns
 * the (possibly updated) response and the remaining budget. Stops immediately if the turn has no
 * tool calls, or has a native (non-bridged) tool call the client must run.
 */
/**
 * Replace a turn's content with already-executed tool results and DROP its tool_calls.
 *
 * Used when the post-execution resample fails: returning the pre-resample turn would hand the
 * client bridged tool_calls nothing will ever execute AND silently discard results we already
 * paid for, which is the exact "Did 0 searches" shape this module exists to prevent.
 */
function withToolResultsAsContent(response: JsonRecord, results: string[]): JsonRecord {
  const choice = getFirstChoice(response);
  const message = getFirstMessage(response);
  if (!choice || !message) return response;

  const content = results.length
    ? `Tool results retrieved (the follow-up model call did not complete):\n\n${results.join("\n\n")}`
    : TERMINAL_FALLBACK_TEXT;
  const rest = Array.isArray(response.choices) ? response.choices.slice(1) : [];

  return {
    ...response,
    choices: [
      { ...choice, message: { role: "assistant", content }, finish_reason: "stop" },
      ...rest,
    ],
  };
}

async function bridgeToolLoop(
  start: JsonRecord,
  messages: JsonRecord[],
  ctx: LocalTurnRecoveryContext,
  budget: number
): Promise<{ response: JsonRecord; budget: number }> {
  let current = start;
  let remaining = budget;

  while (remaining > 0) {
    const message = getFirstMessage(current);
    const toolCalls = extractToolCalls(message);
    if (toolCalls.length === 0) break;

    const bridged: BridgedCall[] = [];
    let hasNative = false;
    for (const call of toolCalls) {
      if (canonicalBridgedName(call.name)) {
        bridged.push(call);
      } else {
        hasNative = true;
      }
    }
    // Mixed / purely-native turn: hand it back untouched so the client executes its own tools.
    if (hasNative || bridged.length === 0) break;

    remaining -= 1;
    messages.push(buildAssistantToolCallMessage(message));
    const executed: string[] = [];
    for (const call of bridged) {
      const canonical = canonicalBridgedName(call.name) as string;
      let result: unknown;
      try {
        result = await ctx.executeBridgedTool(
          canonical,
          normalizeBridgedArgs(canonical, call.arguments)
        );
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const serialized = safeStringify(result);
      executed.push(serialized);
      messages.push({ role: "tool", tool_call_id: call.id, content: serialized });
    }
    ctx.log?.info?.(
      "LOCAL_RECOVERY",
      `executed ${bridged.length} bridged tool call(s); resampling (budget left ${remaining})`
    );
    const next = await ctx.reinvoke(messages);
    if (!next) {
      ctx.log?.info?.(
        "LOCAL_RECOVERY",
        "resample failed after tool execution; surfacing tool results and dropping tool_calls"
      );
      return { response: withToolResultsAsContent(current, executed), budget: remaining };
    }
    current = next;
  }

  return { response: current, budget: remaining };
}

/**
 * Run the tool-bridge loop then the single dead-turn recovery resample. Returns the final OpenAI
 * chat-completion JSON to re-emit to the client.
 */
export async function runLocalTurnRecovery(
  firstResponse: JsonRecord,
  ctx: LocalTurnRecoveryContext
): Promise<JsonRecord> {
  const messages = [...ctx.baseMessages];

  // CHANGE 1 -- execute bridged tools + resample.
  const bridged = await bridgeToolLoop(firstResponse, messages, ctx, MAX_BRIDGE_TOOL_ITERATIONS);
  let current = bridged.response;

  // CHANGE 2 -- dead-turn recovery (ONE resample, guarded against recursion by the single pass).
  const detection = detectDeadTurn(current, ctx.bridgedToolAvailable === true);
  if (!detection.recover) return current;

  ctx.log?.info?.("LOCAL_RECOVERY", `dead-turn detected (${detection.reason}); resampling once`);

  // SALVAGE. A leaked tool call already contains the query the model wanted to run, so a bare
  // nudge-resample throws away work and usually just leaks again (observed: H1 gemma leaks,
  // gets nudged, leaks again, user sees "Did 0 searches"). Execute the leaked search server-side
  // through the SAME bridge that structured calls use, hand the results back as a tool message,
  // and let the model answer from them.
  const leakedQuery =
    detection.reason === "tool_call_leak" &&
    ctx.bridgedToolAvailable === true &&
    isLeakSalvageEnabled()
      ? extractLeakedSearchQuery(rawContent(getFirstMessage(current)))
      : null;

  if (leakedQuery) {
    ctx.log?.info?.("LOCAL_RECOVERY", `salvaging leaked search: ${leakedQuery.slice(0, 80)}`);
    let salvaged: unknown;
    try {
      salvaged = await ctx.executeBridgedTool("web_search", { query: leakedQuery });
    } catch (err) {
      salvaged = { error: err instanceof Error ? err.message : String(err) };
    }
    // Synthetic id: the model never emitted a structured call, so no upstream id exists.
    const callId = "salvaged_web_search";
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "web_search", arguments: safeStringify({ query: leakedQuery }) },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: safeStringify(salvaged) });

    const afterSalvage = await ctx.reinvoke(messages);
    if (afterSalvage) {
      const post = await bridgeToolLoop(afterSalvage, messages, ctx, bridged.budget);
      if (!detectDeadTurn(post.response, ctx.bridgedToolAvailable === true).recover) {
        return post.response;
      }
      // Salvage produced another dead turn: fall through to the nudge path below.
      current = post.response;
    }
  }

  const failedText = rawContent(getFirstMessage(current));
  if (failedText.trim().length > 0) {
    messages.push({ role: "assistant", content: failedText });
  }
  messages.push({ role: "user", content: RECOVERY_NUDGE });

  const recovered = await ctx.reinvoke(messages);
  if (!recovered) return buildTerminalFallback(current);

  // The recovery attempt may itself emit a bridged tool call; execute it within the leftover budget.
  const afterRecovery = await bridgeToolLoop(recovered, messages, ctx, bridged.budget);

  if (detectDeadTurn(afterRecovery.response, ctx.bridgedToolAvailable === true).recover) {
    ctx.log?.info?.(
      "LOCAL_RECOVERY",
      "recovery attempt also dead-stopped; emitting terminal fallback"
    );
    return buildTerminalFallback(afterRecovery.response);
  }
  return afterRecovery.response;
}
