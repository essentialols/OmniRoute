import { FORMATS } from "../translator/formats.ts";
import { BRIDGED_TOOL_NAMES, isLocalBridgeProvider } from "./localTurnRecovery.ts";

export const OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME = "omniroute_web_search";
// Prefix match. Anthropic sends date-suffixed variants (web_search_20250305, etc).
// The other two detectors (openai-responses/helpers.ts, webSearchRouting.ts) already
// use /^web_search/ prefix matching; this aligns the fallback detector with them.
const WEB_SEARCH_TOOL_TYPES = /^web_search/;
const SEARCH_CONTEXT_DEFAULTS: Record<string, number> = {
  low: 5,
  medium: 8,
  high: 10,
};

type JsonRecord = Record<string, unknown>;
type WebSearchFallbackBody = JsonRecord & {
  tools?: unknown;
  tool_choice?: unknown;
};

export interface WebSearchFallbackPlan {
  enabled: boolean;
  toolName: string | null;
  convertedToolCount: number;
  // All tool names the builtin-tool execution loop should auto-run for this request: the injected
  // omniroute_web_search fallback (when a native web_search tool was converted) PLUS any
  // function-form bridged tools (WebSearch/WebFetch/web_search/web_fetch) the client sent directly
  // (task #17). Empty when nothing is auto-executable.
  builtinToolNames: string[];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isBuiltInWebSearchTool(tool: unknown): tool is JsonRecord {
  const toolRecord = toRecord(tool);
  const toolType = typeof toolRecord.type === "string" ? toolRecord.type : "";
  return WEB_SEARCH_TOOL_TYPES.test(toolType) && !toolRecord.function;
}

function isBuiltInWebSearchToolChoice(toolChoice: unknown): boolean {
  const choice = toRecord(toolChoice);
  const toolType = typeof choice.type === "string" ? choice.type : "";
  return WEB_SEARCH_TOOL_TYPES.test(toolType);
}

// Function-form bridged tools (task #17): Claude Code sends WebSearch/WebFetch as ordinary
// `type:"function"` tools (name in BRIDGED_TOOL_NAMES). Unlike native `type:"web_search"` server
// tools, these need NO rewrite (the model already calls them by name), only registration so the
// builtin-tool execution loop runs them. Returns the original (deduped) names present in the body.
function detectFunctionBridgeToolNames(tools: unknown[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    const toolRecord = toRecord(tool);
    const functionRecord = toRecord(toolRecord.function);
    const name =
      typeof functionRecord.name === "string"
        ? functionRecord.name
        : typeof toolRecord.name === "string"
          ? toolRecord.name
          : "";
    // Only function-shaped tools (skip the native web_search server-tool form handled above).
    const isFunctionShaped = toolRecord.function != null || toolRecord.type === "function";
    if (isFunctionShaped && name && BRIDGED_TOOL_NAMES.has(name)) {
      names.add(name);
    }
  }
  return [...names];
}

function buildFallbackDescription(tool: JsonRecord): string {
  const externalWebAccess = tool.external_web_access !== false;
  const contextSize =
    typeof tool.search_context_size === "string"
      ? tool.search_context_size.trim().toLowerCase()
      : "";
  const defaultMaxResults = SEARCH_CONTEXT_DEFAULTS[contextSize] || SEARCH_CONTEXT_DEFAULTS.medium;
  const accessMode = externalWebAccess ? "public web" : "configured search index";

  return [
    `Search the ${accessMode} for recent, factual information and return cited results.`,
    "Use this when the answer depends on current events, external documents, or fresh facts.",
    `If max_results is omitted, prefer about ${defaultMaxResults} results.`,
  ].join(" ");
}

function buildFallbackParameters(tool: JsonRecord): JsonRecord {
  const contextSize =
    typeof tool.search_context_size === "string"
      ? tool.search_context_size.trim().toLowerCase()
      : "";
  const defaultMaxResults = SEARCH_CONTEXT_DEFAULTS[contextSize] || SEARCH_CONTEXT_DEFAULTS.medium;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The web search query to execute.",
      },
      search_type: {
        type: "string",
        enum: ["web", "news"],
        description: "Use 'news' for recent headlines or reporting; otherwise use 'web'.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: defaultMaxResults,
        description: "Maximum number of results to retrieve.",
      },
      country: {
        type: "string",
        description: "Optional 2-letter country code for localization, e.g. US or BR.",
      },
      language: {
        type: "string",
        description: "Optional language code such as en or pt-BR.",
      },
      time_range: {
        type: "string",
        enum: ["any", "day", "week", "month", "year"],
        description: "Optional recency filter.",
      },
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of domains to include.",
          },
          exclude_domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of domains to exclude.",
          },
        },
      },
    },
    required: ["query"],
  };
}

function buildFallbackTool(tool: JsonRecord, targetFormat?: string | null): JsonRecord {
  const name = OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME;
  const description = buildFallbackDescription(tool);
  const parameters = buildFallbackParameters(tool);

  // Responses API expects FLAT function tools ({ type, name, parameters }), whereas
  // Chat Completions expects NESTED ({ type, function: { name, parameters } }). On the
  // Responses→Responses passthrough path nothing flattens the injected tool, so a nested
  // shape reaches the upstream as `tools[0].function.name` and is rejected with
  // "Missing required parameter: 'tools[0].name'." (issue #2390).
  if (targetFormat === FORMATS.OPENAI_RESPONSES) {
    return { type: "function", name, description, parameters };
  }

  return {
    type: "function",
    function: { name, description, parameters },
  };
}

// Providers whose endpoint advertises Claude/Anthropic format but does NOT implement
// Anthropic's typed server tools (web_search_20250305, …). For these the Claude -> Claude
// bypass below must NOT apply: forwarding the native server tool makes the upstream 400
// (MiniMax returns `invalid params, function name or parameters is empty (2013)`), so the
// built-in web-search tool has to be converted to the omniroute_web_search function
// fallback — which these models accept as a normal function tool (#4481).
const CLAUDE_FORMAT_PROVIDERS_WITHOUT_SERVER_TOOLS = new Set(["minimax"]);

export function supportsNativeWebSearchFallbackBypass({
  provider,
  sourceFormat,
  targetFormat,
  nativeCodexPassthrough,
  interceptSearchOverride,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  nativeCodexPassthrough: boolean;
  // Per-model rule (#3384) — resolveInterceptSearch() in src/lib/db/interceptionRules.ts.
  // true = force interception (never bypass); false = force native bypass; undefined =
  // fall through to the native-bypass defaults below.
  interceptSearchOverride?: boolean;
}): boolean {
  if (typeof interceptSearchOverride === "boolean") {
    return !interceptSearchOverride;
  }
  // Native Codex (OpenAI Responses) passthrough: the upstream runs web search itself.
  if (nativeCodexPassthrough) return true;
  // Gemini target: the Gemini translator maps built-in web search to googleSearch natively.
  if (targetFormat === FORMATS.GEMINI) return true;
  // Claude -> Claude passthrough: the Anthropic Messages upstream (e.g. a Claude
  // subscription driven by Claude Code) natively runs web_search_20250305. Forward the
  // native tool untouched instead of rewriting it to omniroute_web_search. Mirrors the
  // Codex/Gemini bypasses so every native-web-search provider is treated symmetrically.
  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE) {
    // …except Anthropic-compatible providers that don't actually implement server tools.
    if (provider && CLAUDE_FORMAT_PROVIDERS_WITHOUT_SERVER_TOOLS.has(provider)) return false;
    return true;
  }
  return false;
}

export function prepareWebSearchFallbackBody<T extends WebSearchFallbackBody>(
  body: T,
  options: {
    provider?: string | null;
    /** Resolved model id; carries the local signal when the provider id is an opaque UUID. */
    model?: string | null;
    sourceFormat?: string | null;
    targetFormat?: string | null;
    nativeCodexPassthrough: boolean;
    interceptSearchOverride?: boolean;
  }
): { body: T; fallback: WebSearchFallbackPlan } {
  const tools = Array.isArray(body.tools) ? body.tools : null;
  if (!tools || tools.length === 0) {
    return {
      body,
      fallback: { enabled: false, toolName: null, convertedToolCount: 0, builtinToolNames: [] },
    };
  }

  const bypass = supportsNativeWebSearchFallbackBypass(options);
  // Function-form bridged tools (task #17) are registered ONLY on a non-bypass route to an
  // allowlisted LOCAL provider. `bypass` alone is not sufficient: it is false for ordinary
  // cloud routes (OpenAI->OpenAI, Claude->OpenAI), so gating on it by itself silently executed
  // a cloud client's own WebSearch/WebFetch tool server-side instead of returning it. The local
  // check shares its allowlist with resolveLocalTurnRecoveryPlan so the two paths cannot diverge.
  const functionBridgeNames =
    bypass || !isLocalBridgeProvider(options.provider, options.model)
      ? []
      : detectFunctionBridgeToolNames(tools);

  const builtInSearchTools = tools.filter(isBuiltInWebSearchTool);
  if (builtInSearchTools.length === 0) {
    // No native web_search server-tool to convert. Still surface any function-form bridged tools
    // so the builtin-tool execution loop runs them; otherwise there is nothing to do (no rewrite).
    return {
      body,
      fallback: {
        enabled: false,
        toolName: null,
        convertedToolCount: 0,
        builtinToolNames: functionBridgeNames,
      },
    };
  }

  if (bypass) {
    return {
      body,
      fallback: { enabled: false, toolName: null, convertedToolCount: 0, builtinToolNames: [] },
    };
  }

  const toolNames = new Set<string>();
  const preservedTools = tools.filter((tool) => {
    if (isBuiltInWebSearchTool(tool)) return false;
    const toolRecord = toRecord(tool);
    const functionRecord = toRecord(toolRecord.function);
    const name =
      typeof functionRecord.name === "string"
        ? functionRecord.name
        : typeof toolRecord.name === "string"
          ? toolRecord.name
          : "";
    if (name.trim().length > 0) {
      toolNames.add(name.trim());
    }
    return true;
  });

  const isResponsesTarget = options.targetFormat === FORMATS.OPENAI_RESPONSES;

  if (!toolNames.has(OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME)) {
    preservedTools.unshift(
      buildFallbackTool(toRecord(builtInSearchTools[0]), options.targetFormat)
    );
  }

  const nextBody: T = {
    ...body,
    tools: preservedTools as T["tools"],
  };

  if (isBuiltInWebSearchToolChoice(body.tool_choice)) {
    // Match the injected tool shape: flat for Responses API, nested for Chat Completions.
    nextBody.tool_choice = (
      isResponsesTarget
        ? { type: "function", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME }
        : { type: "function", function: { name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } }
    ) as T["tool_choice"];
  }

  return {
    body: nextBody,
    fallback: {
      enabled: true,
      toolName: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
      convertedToolCount: builtInSearchTools.length,
      builtinToolNames: [OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME, ...functionBridgeNames],
    },
  };
}
