/**
 * Local-model loop detector (pure core).
 *
 * Weak local models (Ornith-35B, Gemma-4-26B) driven by an agent harness (Claude Code,
 * Codex) can get stuck re-issuing the same tool action, or emitting the same text, with no
 * progress. Because the harness resends the FULL transcript every turn, a stateless proxy
 * can detect the loop by inspecting the tail of the `messages` array, so no session store
 * is needed.
 *
 * Detection is frequency-in-window (NOT merely consecutive), so an interleaved loop
 * (X, Y, X, Y, X ...) is caught. This mirrors the weak-model-harness controller's hardened
 * no-progress detector (commit b8d9160), which switched away from a counter a model could
 * hold at zero by interleaving novel no-op actions.
 *
 * Pure + fail-open: any malformed/empty input yields { decision: "none" }, never throws.
 */

import crypto from "node:crypto";

export type LoopDecision = "none" | "steer" | "stop";

export interface LoopGuardDetectConfig {
  /** Number of most-recent assistant actions to inspect. */
  window: number;
  /** Frequency (within the window) of one action that triggers a soft steer. */
  steerThreshold: number;
  /** Frequency that triggers a hard stop (force final answer). */
  stopThreshold: number;
}

export interface LoopAnalysis {
  decision: LoopDecision;
  reason: string;
  repeatCount: number;
  fingerprint: string | null;
}

export type WireFormat = "anthropic" | "openai";

/** Max recursion depth when canonicalizing args (bounds CPU/stack for adversarial nesting). */
const MAX_CANON_DEPTH = 64;
/** Fingerprints longer than this are replaced by a stable content hash (bounds memory/CPU). */
const MAX_FINGERPRINT_CHARS = 4096;

const NO_LOOP: LoopAnalysis = { decision: "none", reason: "", repeatCount: 0, fingerprint: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deterministic JSON with sorted keys, NFC-normalized strings, and a depth cap. Used only for
 * fingerprint equality, so beyond the depth cap we emit a constant sentinel rather than recurse.
 */
function stableStringify(value: unknown, depth: number): string {
  if (depth > MAX_CANON_DEPTH) return '"[max-depth]"';
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const entries = Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k], depth + 1)}`);
  return `{${entries.join(",")}}`;
}

/** Collapse an oversized fingerprint to a stable, bounded content hash. */
function boundFingerprint(canon: string): string {
  if (canon.length <= MAX_FINGERPRINT_CHARS) return canon;
  return `sha256:${crypto.createHash("sha256").update(canon).digest("hex")}`;
}

/** Canonicalize tool arguments: parse JSON strings, sort keys, NFC-normalize; bound the result. */
function canonicalArgs(args: unknown): string {
  let canon: string;
  if (typeof args === "string") {
    try {
      canon = stableStringify(JSON.parse(args), 0);
    } catch {
      canon = JSON.stringify(args.normalize("NFC"));
    }
  } else {
    canon = stableStringify(args ?? {}, 0);
  }
  return boundFingerprint(canon);
}

interface Action {
  fp: string;
  display: string;
}

function toolAction(name: string, args: unknown): Action {
  const canon = canonicalArgs(args);
  return { fp: `tool:${name}:${canon}`, display: `\`${name}\` ${truncate(canon)}` };
}

/**
 * Extract EVERY loop-relevant action a message represents. A tool-calling turn yields one action
 * per tool call (so a repeated 2nd/parallel call is not missed); otherwise a text turn yields at
 * most one text action.
 */
function extractActions(message: unknown, format: WireFormat): Action[] {
  if (!isRecord(message) || message.role !== "assistant") return [];
  const actions: Action[] = [];

  if (format === "openai") {
    const calls = message.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (isRecord(call) && isRecord(call.function) && typeof call.function.name === "string") {
          actions.push(toolAction(call.function.name, call.function.arguments));
        }
      }
    }
  } else {
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
          actions.push(toolAction(block.name, block.input));
        }
      }
    }
  }

  if (actions.length > 0) return actions;

  // No tool call: an assistant text emission (degenerate repetition). Any textual content counts,
  // regardless of length, so short loops like "OK"/"Done" are caught. The frequency threshold, not
  // a length floor, guards against flagging a single legitimate short reply.
  const { text, hadText } = normalizeText(message, format);
  if (hadText)
    actions.push({ fp: `text:${text.normalize("NFC")}`, display: `text "${truncate(text)}"` });
  return actions;
}

function normalizeText(
  message: Record<string, unknown>,
  format: WireFormat
): { text: string; hadText: boolean } {
  const content = message.content;
  if (typeof content === "string") return { text: content.trim(), hadText: content.length > 0 };
  if (format === "anthropic" && Array.isArray(content)) {
    const parts: string[] = [];
    let hadText = false;
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
        hadText = true;
      }
    }
    return { text: parts.join("\n").trim(), hadText };
  }
  return { text: "", hadText: false };
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Analyze a transcript tail for an agentic loop. Returns a tiered decision based on the
 * frequency of the most-repeated recent action within `window`.
 */
export function analyzeMessagesForLoop(
  messages: unknown,
  format: WireFormat,
  config: LoopGuardDetectConfig
): LoopAnalysis {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return NO_LOOP;

    const actions: Action[] = [];
    for (const message of messages) {
      for (const action of extractActions(message, format)) actions.push(action);
    }
    if (actions.length === 0) return NO_LOOP;

    const window = Math.max(1, config.window);
    const recent = actions.slice(-window);

    // Frequency of each fp; tie-break toward the most recent occurrence.
    const counts = new Map<string, { count: number; lastIndex: number; display: string }>();
    recent.forEach((action, index) => {
      const entry = counts.get(action.fp);
      if (entry) {
        entry.count += 1;
        entry.lastIndex = index;
      } else {
        counts.set(action.fp, { count: 1, lastIndex: index, display: action.display });
      }
    });

    let winnerFp: string | null = null;
    let winner = { count: 0, lastIndex: -1, display: "" };
    for (const [fp, entry] of counts) {
      if (
        entry.count > winner.count ||
        (entry.count === winner.count && entry.lastIndex > winner.lastIndex)
      ) {
        winnerFp = fp;
        winner = entry;
      }
    }

    let decision: LoopDecision = "none";
    if (winner.count >= config.stopThreshold) decision = "stop";
    else if (winner.count >= config.steerThreshold) decision = "steer";

    if (decision === "none")
      return { ...NO_LOOP, repeatCount: winner.count, fingerprint: winnerFp };

    const kind = winnerFp?.startsWith("text:") ? "assistant text" : "tool call";
    const detail = `${winner.display} ${winner.count}x in last ${recent.length} actions`;
    return {
      decision,
      reason: `repeated ${kind} ${detail}`,
      repeatCount: winner.count,
      fingerprint: winnerFp,
    };
  } catch {
    return NO_LOOP;
  }
}
