/**
 * POST /api/tools/agent-bridge/agents/[id]/dns
 * Enable or disable DNS entries for a specific agent.
 * LOCAL_ONLY + SPAWN_CAPABLE: registered in routeGuard.ts
 *
 * Body: AgentBridgeDnsActionSchema { enabled: boolean }
 */
import { AgentBridgeDnsActionSchema } from "@/shared/schemas/agentBridge";
import { addDNSEntry, removeDNSEntry } from "@/mitm/dns/dnsConfig";
import { upsertAgentBridgeState } from "@/lib/db/agentBridgeState";
import { getCachedPassword } from "@/mitm/manager";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { ALL_TARGETS } from "@/mitm/targets/index";

// Next.js 16: dynamic route `params` is a Promise and MUST be awaited. The
// old synchronous `{ params: { id } }` destructured the Promise itself, so
// `id` was `undefined` and rows were written to agent_bridge_state with an
// EMPTY agent_id (breaking provisionDnsEntries host mapping). Awaiting also
// stays compatible with tests that pass a plain object as params.
type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  if (!id) {
    return createErrorResponse({ status: 400, message: "Missing agent id" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }

  const parsed = AgentBridgeDnsActionSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid request body",
      details: parsed.error.flatten(),
    });
  }

  // Validate the agent ID maps to a known target.
  const target = ALL_TARGETS.find((t) => t.id === id);
  if (!target) {
    return createErrorResponse({ status: 404, message: `Unknown agent: ${id}` });
  }

  const { enabled } = parsed.data;
  const raw = body as Record<string, unknown>;
  const sudoPassword =
    typeof raw.sudoPassword === "string" ? raw.sudoPassword : (getCachedPassword() ?? "");

  try {
    if (enabled) {
      await addDNSEntry(sudoPassword, id);
    } else {
      await removeDNSEntry(sudoPassword, id);
    }

    upsertAgentBridgeState({ agent_id: id, dns_enabled: enabled });

    return Response.json({ ok: true, dns_enabled: enabled });
  } catch (err) {
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return createErrorResponse({ status: 500, message: msg });
  }
}
