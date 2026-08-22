// Tool-list normalization for `openai-compatible-*` providers.
//
// OpenAI-compatible chat upstreams only understand function tools. A Responses-API
// request downgraded to /chat/completions can still carry Responses-only tool shapes:
//   - `{ type:"namespace", name, tools:[{name, description, parameters}, ...] }`
//     (Codex collaboration / MCP tool groups) -> MUST be expanded into its BARE
//     sub-tools. Codex keys executors by the bare sub-tool name (Multi-Agent V2
//     spawn_agent/wait_agent/send_message/followup_task/interrupt_agent/list_agents),
//     so collapsing the group into one opaque function named after the namespace makes
//     the model emit a call to the namespace (e.g. `agents`), which codex then rejects
//     with `unsupported call: agents`.
//   - other named non-function tools -> normalised to function format so the translator
//     does not throw on the unknown type.
//   - unnamed non-function tools without a `function` wrapper -> dropped (unconvertible).
//
// Sub-tools are emitted in flat Responses shape (`{type:"function", name, parameters}`)
// to match the sibling function tools at this stage; the downstream Responses->Chat
// translator wraps each into chat `{type:"function", function:{...}}` uniformly.
//
// #10114: none of the above runs while the request is STILL in native Responses source
// format. The Responses translator has its own format-aware handling for custom,
// namespace, tool_search, local_shell and hosted tool types (see
// translator/request/openai-responses.ts and its namespaceFlatten seam, plus the
// response-side re-attach in translator/response/openai-responses.ts), and rewriting
// those shapes here would destroy information before that conversion can run. The
// expansion above therefore applies only to bodies that already left Responses format
// (e.g. converted via convertResponsesApiFormat), which is exactly where a `namespace`
// group would otherwise be flattened into the single opaque `agents` function.
import { FORMATS } from "../../translator/formats.ts";

type Tool = Record<string, unknown>;

// Build a `{ bareSubToolName -> namespace }` map from a Responses-API `tools` array, mirroring
// exactly what normalizeOpenAICompatibleTools flattens: every `{type:"namespace", name, tools}`
// group contributes each of its sub-tool names -> the group's namespace name. Used on the
// RESPONSE side (responsesTransformer) to re-attach the namespace codex stripped on the request,
// so a bare `spawn_agent` call round-trips back to the registered `agents/spawn_agent` executor
// instead of failing with "unsupported call: spawn_agent". Only namespace-flattened tools appear
// in the map, so plain function tools (incl. MCP `mcp__a__b`) are never re-tagged. Returns null
// when there is nothing to re-tag (keeps the common non-namespace path allocation-free).
export function buildToolNamespaceMap(tools: unknown): Record<string, string> | null {
  if (!Array.isArray(tools)) return null;
  const map: Record<string, string> = {};
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    if (tool.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
      continue;
    }
    const namespace = tool.name;
    for (const sub of tool.tools as Record<string, unknown>[]) {
      if (sub && typeof sub.name === "string" && sub.name.trim().length > 0) {
        map[sub.name] = namespace;
      }
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

export function normalizeOpenAICompatibleTools(
  tools: Tool[],
  sourceFormat: string
): { tools: Tool[]; dropped: number } {
  // The Responses translator has dedicated handling for custom, namespace,
  // tool_search, local_shell, and hosted tool types. Normalizing any of them
  // here destroys information before that format-aware conversion can run.
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return { tools, dropped: 0 };
  }

  const before = tools.length;
  // Unnamed non-function tools with no `function` wrapper carry nothing convertible.
  const convertible = tools.filter(
    (tool) => !tool.type || tool.type === "function" || !!tool.function || !!tool.name
  );
  let dropped = before - convertible.length;

  const normalized = convertible.flatMap((tool) => {
    // Responses custom tools carry free-form input. Preserve their native shape so
    // the Responses translator can produce the required { input: string } schema.
    if (!tool.type || tool.type === "function" || tool.function) {
      return [tool];
    }

    // Namespace tool group -> expand into its BARE sub-tools (see header comment).
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const subTools = (tool.tools as Tool[])
        .filter((sub) => typeof sub.name === "string" && (sub.name as string).trim().length > 0)
        .map((sub) => ({
          type: "function",
          name: sub.name,
          ...(sub.description === undefined ? {} : { description: sub.description }),
          parameters: sub.parameters ?? sub.input_schema ?? { type: "object", properties: {} },
        }));
      // A group with no usable sub-tools contributes nothing; count it as dropped so the
      // caller's debug log still reflects the tool that disappeared.
      if (subTools.length === 0) dropped += 1;
      return subTools;
    }

    // Named non-function tool: normalise to function format.
    return [
      {
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.parameters !== undefined || tool.input_schema !== undefined
            ? { parameters: tool.parameters ?? tool.input_schema ?? {} }
            : {}),
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      },
    ];
  });

  return { tools: normalized, dropped };
}
