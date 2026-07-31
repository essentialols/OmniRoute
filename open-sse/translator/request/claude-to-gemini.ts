import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import {
  DEFAULT_SAFETY_SETTINGS,
  tryParseJSON,
  cleanJSONSchemaForAntigravity,
} from "../helpers/geminiHelper.ts";
import { DEFAULT_THINKING_GEMINI_SIGNATURE } from "../../config/defaultThinkingSignature.ts";
import { buildGeminiTools, sanitizeGeminiToolName } from "../helpers/geminiToolsSanitizer.ts";
import { capMaxOutputTokens, capThinkingBudget } from "../../../src/lib/modelCapabilities.ts";
import {
  buildGeminiThoughtSignatureKey,
  resolveGeminiThoughtSignature,
} from "../../services/geminiThoughtSignatureStore.ts";
import {
  buildHistoricalToolResultContext,
  extractClientThoughtSignature,
} from "./openai-to-gemini/helpers.ts";
import { mergeConsecutiveSameRoleContents } from "./openai-to-gemini.ts";

/**
 * Direct Claude → Gemini request translator.
 * Converts Claude Messages API body directly to Gemini format,
 * skipping the OpenAI hub intermediate step.
 */
export function claudeToGeminiRequest(model, body, stream, credentials = null) {
  const toolNameMap = new Map<string, string>();
  const sanitizeToolName = (name: string) =>
    sanitizeGeminiToolName(name, {
      toolNameMap,
    });
  // Vertex AI rejects the `id` field inside function_call / function_response parts
  // (#3440). The public Gemini API keeps it for Gemini 3+ signature matching, so this
  // is scoped to the routed vertex provider only (threaded via credentials._provider).
  const provider = credentials && typeof credentials === "object" ? credentials._provider : null;
  const stripFunctionCallId = provider === "vertex" || provider === "vertex-partner";
  // Only thinking-tier Gemini models validate thought_signature on historical
  // functionCall parts. Same heuristic openaiToAntigravityRequest uses
  // (openai-to-gemini.ts), so non-thinking targets keep their native tool history
  // instead of being flattened into context text they never needed.
  const modelLower = String(model || "").toLowerCase();
  const isThinkingGemini =
    !modelLower.includes("claude") &&
    (modelLower.includes("thinking") ||
      modelLower.includes("gemini-3") ||
      modelLower.includes("gemini-2.5") ||
      modelLower.includes("gemini-pro"));
  const result: {
    model: string;
    contents: Array<Record<string, unknown>>;
    generationConfig: Record<string, unknown>;
    safetySettings: unknown;
    systemInstruction?: { role: string; parts: Array<{ text: string }> };
    tools?: Array<{
      functionDeclarations?: Array<Record<string, unknown>>;
      googleSearch?: Record<string, unknown>;
      googleSearchRetrieval?: Record<string, unknown>;
    }>;
    _toolNameMap?: Map<string, string>;
  } = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS,
  };

  // ── Generation config ──────────────────────────────────────────
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.max_tokens !== undefined) {
    const maxOutputTokens = capMaxOutputTokens(model, body.max_tokens);
    if (maxOutputTokens !== null) {
      result.generationConfig.maxOutputTokens = maxOutputTokens;
    }
  }

  // ── System instruction ─────────────────────────────────────────
  if (body.system) {
    let systemText;
    if (Array.isArray(body.system)) {
      systemText = body.system.map((s) => s.text || "").join("\n");
    } else {
      systemText = String(body.system);
    }
    if (systemText) {
      result.systemInstruction = {
        role: "system",
        parts: [{ text: systemText }],
      };
    }
  }

  // ── Build tool_use name lookup (for tool_result matching) ──────
  // Also resolve the cached thoughtSignature for every historical tool_use id.
  // Gemini 3+ thinking models reject a functionCall part that carries no
  // thought_signature (400 "Function call is missing a thought_signature ...
  // position N"). The signature is captured on the response turn by
  // gemini-to-claude.ts under `<connectionId>:<toolCallId>` and re-attached here
  // (#2504). Tool calls we cannot sign are represented as inert context instead of
  // being sent unsigned, the same context-mode fallback the hub path uses (#3688).
  const signatureNamespace =
    credentials &&
    typeof credentials === "object" &&
    typeof credentials._signatureNamespace === "string"
      ? credentials._signatureNamespace
      : null;
  const toolUseNames = {};
  const rawToolUseNames: Record<string, string> = {};
  const resolvedSignatures = new Map<string, string>();
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolUseNames[block.id] = sanitizeToolName(block.name);
            rawToolUseNames[block.id] = block.name;
            const resolved = resolveGeminiThoughtSignature(
              buildGeminiThoughtSignatureKey(signatureNamespace, block.id),
              extractClientThoughtSignature(block)
            );
            if (typeof resolved === "string" && resolved.length > 0) {
              resolvedSignatures.set(block.id, resolved);
            }
          }
        }
      }
    }
  }

  // ── Convert messages ───────────────────────────────────────────
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const parts = [];

      // Gemini wants the signature on the FIRST functionCall part of a model turn
      // only; repeating it across a parallel tool-call batch is rejected (#1316).
      // Pick the first resolvable signature in this turn and spend it once.
      let turnSignature: string | undefined;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id && resolvedSignatures.has(block.id)) {
            turnSignature = resolvedSignatures.get(block.id);
            break;
          }
        }
      }
      let turnSignatureUnspent = turnSignature !== undefined;

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          switch (block.type) {
            case "text":
              if (block.text) parts.push({ text: block.text });
              break;

            case "thinking":
              // Preserve thinking blocks as thought parts
              if (block.thinking) {
                parts.push({ thought: true, text: block.thinking });
              }
              break;

            case "tool_use": {
              if (isThinkingGemini && !resolvedSignatures.has(block.id)) {
                // Context-mode fallback (#3688): standard Gemini rejects an unsigned
                // historical functionCall part, so omit it here. The paired
                // tool_result is emitted as inert context in the branch below, which
                // keeps the transcript readable without a pseudo tool-call record the
                // model can echo back as its visible answer.
                break;
              }
              const partSignature = turnSignatureUnspent ? turnSignature : undefined;
              if (partSignature) turnSignatureUnspent = false;
              parts.push({
                ...(partSignature ? { thoughtSignature: partSignature } : {}),
                functionCall: {
                  ...(stripFunctionCallId ? {} : { id: block.id }),
                  name: sanitizeToolName(block.name),
                  args: block.input || {},
                },
              });
              break;
            }

            case "tool_result": {
              let content = block.content;
              if (Array.isArray(content)) {
                content = content
                  .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                  .join("\n");
              }
              if (isThinkingGemini && !resolvedSignatures.has(block.tool_use_id)) {
                // The matching functionCall was omitted above, so a native
                // functionResponse here would be an orphan. Emit the result as
                // inert context text instead (#3688).
                parts.push({
                  text: buildHistoricalToolResultContext(
                    rawToolUseNames[block.tool_use_id] || "unknown",
                    content
                  ),
                });
                break;
              }
              let parsedContent = tryParseJSON(content);
              if (parsedContent === null) {
                parsedContent = { result: content };
              } else if (typeof parsedContent !== "object") {
                parsedContent = { result: parsedContent };
              }
              parts.push({
                functionResponse: {
                  ...(stripFunctionCallId ? {} : { id: block.tool_use_id }),
                  name: toolUseNames[block.tool_use_id] || "unknown",
                  response: { result: parsedContent },
                },
              });
              break;
            }

            case "image":
              // Base64 image → Gemini inlineData
              if (block.source?.type === "base64") {
                parts.push({
                  inlineData: {
                    mimeType: block.source.media_type,
                    data: block.source.data,
                  },
                });
              }
              break;
          }
        }
      } else if (typeof msg.content === "string" && msg.content) {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        // Map Claude roles to Gemini roles
        const geminiRole = msg.role === "assistant" ? "model" : "user";

        // Gemini 3+ expects the signature on the functionCall part itself. It is
        // attached above from the signature cache; a fake one is never injected
        // because the Gemini API validates it strictly and returns 400.
        result.contents.push({ role: geminiRole, parts });
      }
    }

    // A model turn whose only content was unsigned tool_use blocks is dropped by the
    // context-mode fallback above, which can leave two adjacent user turns. Gemini
    // rejects consecutive same-role contents with 400 INVALID_ARGUMENT, so apply the
    // same merge the hub path already does.
    result.contents = mergeConsecutiveSameRoleContents(
      result.contents as Parameters<typeof mergeConsecutiveSameRoleContents>[0]
    ) as typeof result.contents;
  }

  // ── Convert tools ──────────────────────────────────────────────
  const geminiTools = buildGeminiTools(body.tools, {
    toolNameMap,
  });
  if (geminiTools) {
    result.tools = geminiTools;
  }

  // ── Thinking config ────────────────────────────────────────────
  // Priority: thinking.budget_tokens (Claude native) > output_config.effort (Claude Code).
  if (model.startsWith("gemma-4")) {
    // gemma-4 models returns - 400: Thinking budget is not supported for this model
  } else if (body.thinking?.type === "enabled" && body.thinking.budget_tokens) {
    result.generationConfig.thinkingConfig = {
      thinkingBudget: body.thinking.budget_tokens,
      includeThoughts: true,
    };
  } else if (typeof body.output_config?.effort === "string") {
    const effort = body.output_config.effort.toLowerCase();
    const effortBudgetMap: Record<string, number> = {
      none: 0,
      low: 1024,
      medium: 10240,
      high: 32768,
      max: 131072,
      xhigh: 131072,
    };
    const rawBudget = effortBudgetMap[effort];
    // #3842: clamp to the model's real thinking-budget cap. This path previously
    // sent the raw value with no cap, so a Claude-Code client hitting a Flash-tier
    // Gemini target via output_config.effort="high" sent 32768 (> 24576) → 400.
    // capThinkingBudget narrows 32768 to e.g. gemini-2.5-flash's 24576 while leaving
    // pro-tier (real cap 32768) untouched.
    const budget = rawBudget !== undefined ? capThinkingBudget(model, rawBudget) : undefined;
    if (budget !== undefined && budget > 0) {
      result.generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      };
    }
  }

  const changedToolNameMap = new Map(
    [...toolNameMap.entries()].filter(
      ([sanitizedName, originalName]) => sanitizedName !== originalName
    )
  );
  if (changedToolNameMap.size > 0) {
    result._toolNameMap = changedToolNameMap;
  }

  return result;
}

// Register direct path only for plain Gemini API.
// Antigravity requires Cloud Code envelope wrapping,
// so they must use the existing hub path (Claude -> OpenAI -> target).
register(FORMATS.CLAUDE, FORMATS.GEMINI, claudeToGeminiRequest, null);
