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
  tools: Record<string, unknown>[]
): Record<string, unknown>[] {
  return tools
    .filter((t) => !t.type || t.type === "function" || !!t.function || !!t.name)
    .flatMap((t) => {
      if (!t.type || t.type === "function" || t.function) return [t];
      if (t.type === "namespace" && Array.isArray(t.tools)) {
        return (t.tools as Record<string, unknown>[])
          .filter((sub) => typeof sub.name === "string" && (sub.name as string).trim().length > 0)
          .map((sub) => ({
            type: "function",
            name: sub.name,
            ...(sub.description === undefined ? {} : { description: sub.description }),
            parameters: sub.parameters ?? sub.input_schema ?? { type: "object", properties: {} },
          }));
      }
      // Named non-function tool: normalise to function format.
      return [
        {
          type: "function",
          function: {
            name: t.name,
            ...(t.description === undefined ? {} : { description: t.description }),
            ...(t.parameters !== undefined || t.input_schema !== undefined
              ? { parameters: t.parameters ?? t.input_schema ?? {} }
              : {}),
            ...(t.strict === undefined ? {} : { strict: t.strict }),
          },
        },
      ];
    });
}
