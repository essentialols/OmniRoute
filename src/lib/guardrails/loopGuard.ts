/**
 * loopGuard.ts — Local-model loop-guard guardrail.
 *
 * Wires the pure detector (loopGuardDetect.analyzeMessagesForLoop) into a
 * request-side guardrail. Weak local models (Ornith, Gemma, M1y) driven by an
 * agent harness can get stuck re-issuing the same tool call or emitting the same
 * text. Because the harness resends the full transcript every turn, this
 * stateless guardrail inspects the tail of payload.messages and, for a matching
 * model, either:
 *   - steer: appends ONE nudge message asking for a materially different step, or
 *   - stop:  appends a terminal instruction AND forces tool_choice to none so the
 *            model must finalize instead of calling another tool.
 *
 * Fully fail-open: disabled config, a non-matching model, malformed input, or any
 * thrown error all yield a no-op { block:false } with the payload untouched. It
 * never throws and never mutates the (possibly frozen) input — the modified body
 * is always a fresh clone.
 */

import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import { analyzeMessagesForLoop, type LoopDecision, type WireFormat } from "./loopGuardDetect";
import { getLoopGuardConfig, type LoopGuardConfig } from "@/lib/db/loopGuard";

export interface LoopGuardDependencies {
  /** Injectable config reader (defaults to the per-call DB read) for tests. */
  getConfig?: () => LoopGuardConfig;
}

const NOOP: GuardrailResult<unknown> = { block: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Map a request sourceFormat, else the payload shape, to the detector's wire format. */
function resolveWireFormat(
  sourceFormat: string | null | undefined,
  body: Record<string, unknown>
): WireFormat {
  if (typeof sourceFormat === "string" && sourceFormat) {
    const sf = sourceFormat.toLowerCase();
    if (sf.includes("claude") || sf.includes("anthropic") || sf.includes("antigravity")) {
      return "anthropic";
    }
    if (sf.includes("openai") || sf.includes("chat")) return "openai";
  }
  return detectFormatFromPayload(body);
}

/**
 * Derive the wire format from the request body when sourceFormat is unavailable
 * (the chat.ts caller does not populate it). Anthropic Messages API carries a
 * top-level `system` field and tool_use/tool_result content blocks; OpenAI chat
 * carries `tool_calls` on assistant messages.
 */
function detectFormatFromPayload(body: Record<string, unknown>): WireFormat {
  if ("system" in body) return "anthropic";
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (Array.isArray(message.tool_calls)) return "openai";
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && (block.type === "tool_use" || block.type === "tool_result")) {
            return "anthropic";
          }
        }
      }
    }
  }
  return "openai";
}

function steerText(reason: string): string {
  return (
    `Loop guard: you have repeated the same action (${reason}). ` +
    "Do NOT repeat it. Take a materially different step, or give your final answer now."
  );
}

function stopText(reason: string): string {
  return (
    `Loop guard: you are stuck repeating the same action (${reason}). ` +
    "Stop calling tools now and give your final answer to the user using what you already have."
  );
}

/** Build the appended nudge message with a role valid for the wire format. */
function buildNudge(format: WireFormat, decision: LoopDecision, reason: string) {
  // Anthropic has no `system` role inside the messages array (system is top-level),
  // so the nudge lands as a `user` turn; OpenAI accepts an inline `system` directive.
  const role = format === "anthropic" ? "user" : "system";
  const content = decision === "stop" ? stopText(reason) : steerText(reason);
  return { role, content };
}

export class LoopGuardGuardrail extends BaseGuardrail {
  private readonly deps: LoopGuardDependencies;

  constructor(
    options: { enabled?: boolean; priority?: number; deps?: LoopGuardDependencies } = {}
  ) {
    super("loop-guard", { enabled: options.enabled, priority: options.priority ?? 30 });
    this.deps = options.deps ?? {};
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    try {
      const getConfig = this.deps.getConfig ?? getLoopGuardConfig;
      const config = getConfig();
      if (!config.enabled) return NOOP;

      const body = isRecord(payload) ? payload : null;
      const model =
        context.model || (body && typeof body.model === "string" ? body.model : undefined);
      if (!model) return NOOP;

      let pattern: RegExp;
      try {
        pattern = new RegExp(config.modelPattern, "i");
      } catch {
        // Malformed operator-supplied pattern: fail-open (guard nothing).
        return NOOP;
      }
      if (!pattern.test(model)) return NOOP;

      if (!body || !Array.isArray(body.messages)) return NOOP;
      const messages = body.messages;

      const format = resolveWireFormat(context.sourceFormat, body);
      const analysis = analyzeMessagesForLoop(messages, format, {
        window: config.window,
        steerThreshold: config.steerThreshold,
        stopThreshold: config.stopThreshold,
      });
      if (analysis.decision === "none") return NOOP;

      const nudge = buildNudge(format, analysis.decision, analysis.reason);
      const modifiedPayload: Record<string, unknown> = {
        ...body,
        messages: [...messages, nudge],
      };
      if (analysis.decision === "stop") {
        modifiedPayload.tool_choice = format === "anthropic" ? { type: "none" } : "none";
      }

      return {
        block: false,
        meta: {
          decision: analysis.decision,
          repeatCount: analysis.repeatCount,
          reason: analysis.reason,
        },
        modifiedPayload,
      };
    } catch {
      // Any unexpected failure: pass the request through untouched.
      return NOOP;
    }
  }
}
