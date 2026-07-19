import { isLocalProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";

type StreamReadinessBody = Record<string, unknown> | null | undefined;

export type StreamReadinessPolicyInput = {
  baseTimeoutMs: number;
  provider?: string | null;
  model?: string | null;
  body?: StreamReadinessBody;
  maxTimeoutMs?: number;
};

export type StreamReadinessPolicyResult = {
  timeoutMs: number;
  baseTimeoutMs: number;
  reasons: string[];
};

const DEFAULT_MAX_TIMEOUT_MS = 180_000;
const LARGE_ITEM_THRESHOLD = 150;
const VERY_LARGE_ITEM_THRESHOLD = 400;
const TOOL_HEAVY_THRESHOLD = 15;
const LARGE_CHAR_THRESHOLD = 250_000;
const VERY_LARGE_CHAR_THRESHOLD = 750_000;

function countArrayField(body: StreamReadinessBody, field: "input" | "messages" | "tools"): number {
  const value = body?.[field];
  return Array.isArray(value) ? value.length : 0;
}

function estimateBodyChars(body: StreamReadinessBody): number {
  if (!body) return 0;
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

function isCodexGpt5x(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = (provider || "").toLowerCase();
  const normalizedModel = (model || "").toLowerCase();
  // Match the gpt-5.x family (gpt-5, gpt-5.1, gpt-5.5, ...) on the codex provider.
  return normalizedProvider === "codex" && /gpt-5(\.\d+)?/.test(normalizedModel);
}

/**
 * High-reasoning Codex GPT-5.x targets do a cold, expensive reasoning warm-up
 * (~78s TTFB) even for small prompts. Detect "high" reasoning effort either from
 * the model alias suffix (`...-high`) or from the request body's reasoning effort
 * field (OpenAI `reasoning_effort` or Responses API `reasoning.effort`).
 */
function isHighReasoningEffort(
  model: string | null | undefined,
  body: StreamReadinessBody
): boolean {
  const normalizedModel = (model || "").toLowerCase();
  if (/-high\b/.test(normalizedModel) || normalizedModel.endsWith("-high")) return true;

  const effort = (() => {
    const direct = body?.["reasoning_effort"];
    if (typeof direct === "string") return direct;
    const reasoning = body?.["reasoning"];
    if (reasoning && typeof reasoning === "object") {
      const nested = (reasoning as Record<string, unknown>)["effort"];
      if (typeof nested === "string") return nested;
    }
    return "";
  })();
  return effort.toLowerCase() === "high";
}

export function resolveStreamReadinessTimeout(
  input: StreamReadinessPolicyInput
): StreamReadinessPolicyResult {
  const baseTimeoutMs = Math.max(0, Math.floor(input.baseTimeoutMs || 0));
  if (baseTimeoutMs <= 0) {
    return { timeoutMs: baseTimeoutMs, baseTimeoutMs, reasons: ["disabled"] };
  }

  const isLocal = isLocalProvider(input.provider) || isOpenAICompatibleProvider(input.provider);
  const defaultMax = isLocal ? 1_800_000 : DEFAULT_MAX_TIMEOUT_MS;
  const maxTimeoutMs = Math.max(baseTimeoutMs, input.maxTimeoutMs ?? defaultMax);
  const reasons: string[] = [];
  let timeoutMs = baseTimeoutMs;

  const inputCount = countArrayField(input.body, "input");
  const messageCount = countArrayField(input.body, "messages");
  const itemCount = Math.max(inputCount, messageCount);
  const toolCount = countArrayField(input.body, "tools");
  const estimatedChars = estimateBodyChars(input.body);
  const codexGpt5x = isCodexGpt5x(input.provider, input.model);
  const codexHighReasoning = codexGpt5x && isHighReasoningEffort(input.model, input.body);

  if (itemCount > VERY_LARGE_ITEM_THRESHOLD) {
    timeoutMs += 45_000;
    reasons.push("very_large_history");
  } else if (itemCount > LARGE_ITEM_THRESHOLD) {
    timeoutMs += 20_000;
    reasons.push("large_history");
  }

  if (toolCount >= TOOL_HEAVY_THRESHOLD) {
    timeoutMs += 15_000;
    reasons.push("tool_heavy");
  }

  if (estimatedChars > VERY_LARGE_CHAR_THRESHOLD) {
    timeoutMs += 45_000;
    reasons.push("very_large_payload");
  } else if (estimatedChars > LARGE_CHAR_THRESHOLD) {
    timeoutMs += 20_000;
    reasons.push("large_payload");
  }

  // Local/self-hosted models on consumer GPUs can take minutes for prompt
  // processing on cache miss (e.g. 25k tokens at 16 tok/s = 25 min). The
  // stream readiness timeout guards against dead network connections, which
  // is not a risk for local models. Skip straight to the max.
  if (isLocal) {
    timeoutMs = maxTimeoutMs;
    reasons.push("local_or_self_hosted");
  }

  // #3825: high-reasoning Codex GPT-5.x cold-starts at ~78s TTFB even for
  // tiny prompts, so the +30s readiness budget must fire UNCONDITIONALLY for
  // the high-effort case (the 80s base alone produced intermittent 504s at
  // the readiness window). The legacy large-request bump still applies to
  // non-high codex GPT-5.x requests (large history / tool-heavy).
  if (codexHighReasoning) {
    timeoutMs += 30_000;
    reasons.push("codex_gpt_5_5_high_reasoning");
  } else if (
    codexGpt5x &&
    (itemCount > LARGE_ITEM_THRESHOLD || toolCount >= TOOL_HEAVY_THRESHOLD)
  ) {
    timeoutMs += 30_000;
    reasons.push("codex_gpt_5_5_large_responses");
  }

  timeoutMs = Math.min(timeoutMs, maxTimeoutMs);
  if (timeoutMs === baseTimeoutMs) reasons.push("base");

  return { timeoutMs, baseTimeoutMs, reasons };
}
