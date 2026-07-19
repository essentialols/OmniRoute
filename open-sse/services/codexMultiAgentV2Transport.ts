// Codex Multi-Agent V2 transport codec for OmniRoute.
//
// Codex V2 marks the `message` arg of spawn_agent / send_message / followup_task as
// encrypted. OpenAI's Responses backend encrypts the model-generated arg; Codex stores only
// ciphertext and delivers it to the child as a nonstandard `agent_message` Responses item
// (`content:[{type:"encrypted_content", encrypted_content:"<ciphertext>"}]`). Local
// chat-only providers (rapid-mlx, llama.cpp) understand neither the `"encrypted": true`
// JSON-schema extension nor `agent_message`/OpenAI ciphertext.
//
// This codec keeps V2's ciphertext-history privacy property while making the round-trip work
// through OmniRoute:
//   1. strip the `encrypted:true` schema marker from ONLY the 3 message tools' `message`
//      param before dispatching tool defs to the model (base.ts / request translation);
//   2. SEAL the model's returned plaintext `message` arg with OmniRoute's OWN AES-256-GCM
//      key before returning to Codex (parent history / rollout stay ciphertext);
//   3. DECRYPT Codex's `agent_message` items (OmniRoute's own ciphertext) on the child req;
//   4. CONVERT the decrypted agent_message into an ordinary user message so the model never
//      sees agent_message / encrypted_content.
//
// Fail closed: only accept ciphertext with the `omr-mav2-v1.` prefix that authenticates
// (AES-GCM tag). Foreign/tampered ciphertext is rejected.
//
// Key: `openssl rand -base64 32` -> OMNIROUTE_MAV2_KEY_B64 in the daemon env (NOT the repo).
// A versioned `kid` + keyring supports an old-key grace period for resumed threads that hold
// pre-rotation ciphertext.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const MAV2_PREFIX = "omr-mav2-v1.";

// The 3 V2 tools whose `message` arg Codex marks encrypted. Names may arrive namespaced
// (e.g. `agents.spawn_agent`, `agents__spawn_agent`) depending on tool_namespace config.
const MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

export type Mav2EnvelopeHeader = {
  v: 1;
  kid: string;
  tool: string;
  callId: string;
  targetHint?: string;
};

type Mav2Envelope = {
  header: Mav2EnvelopeHeader;
  nonce: string;
  ciphertext: string;
  tag: string;
};

/** Strip any namespace prefix (`agents.spawn_agent`, `a__b__spawn_agent`, `x/spawn_agent`). */
export function baseToolName(name: string): string {
  return name.split(/[./]/).at(-1)?.split("__").at(-1) ?? name;
}

/** True when the (possibly namespaced) tool is one of the 3 encrypted-message V2 tools. */
export function isMav2MessageTool(name: string): boolean {
  return MESSAGE_TOOLS.has(baseToolName(name));
}

/**
 * Keyring: `OMNIROUTE_MAV2_KEY_B64` is the active (kid "primary") key. Optional
 * `OMNIROUTE_MAV2_KEY_B64_OLD` supplies a grace-period decrypt-only key for ciphertext
 * sealed before a rotation. Both must decode to exactly 32 bytes.
 */
function decodeKey(encoded: string | undefined, label: string): Buffer {
  if (!encoded) throw new Error(`${label} is required`);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
}

function activeKey(): Buffer {
  return decodeKey(process.env.OMNIROUTE_MAV2_KEY_B64, "OMNIROUTE_MAV2_KEY_B64");
}

/** Resolve a decrypt key by kid. "primary" -> active key; anything else -> the OLD key. */
function keyForKid(kid: string): Buffer {
  if (kid === "primary") return activeKey();
  return decodeKey(process.env.OMNIROUTE_MAV2_KEY_B64_OLD, "OMNIROUTE_MAV2_KEY_B64_OLD");
}

function encode(v: Buffer | string): string {
  return Buffer.from(v).toString("base64url");
}
function decode(v: string): Buffer {
  return Buffer.from(v, "base64url");
}

/** AES-256-GCM seal of a plaintext delegation message; header is authenticated as AAD. */
export function sealMav2Message(plaintext: string, header: Mav2EnvelopeHeader): string {
  const key = activeKey();
  const nonce = randomBytes(12);
  const aad = Buffer.from(JSON.stringify(header), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: Mav2Envelope = {
    header,
    nonce: encode(nonce),
    ciphertext: encode(ciphertext),
    tag: encode(cipher.getAuthTag()),
  };
  return MAV2_PREFIX + encode(JSON.stringify(envelope));
}

/** Authenticated open of an OmniRoute-sealed message. Throws (fail-closed) on foreign/tampered input. */
export function openMav2Message(token: string): { plaintext: string; header: Mav2EnvelopeHeader } {
  if (!token.startsWith(MAV2_PREFIX)) throw new Error("Unsupported Multi-Agent V2 ciphertext");
  const envelope = JSON.parse(
    decode(token.slice(MAV2_PREFIX.length)).toString("utf8")
  ) as Mav2Envelope;
  if (!envelope || typeof envelope !== "object" || !envelope.header || envelope.header.v !== 1) {
    throw new Error("Unsupported envelope version");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyForKid(envelope.header.kid),
    decode(envelope.nonce)
  );
  decipher.setAAD(Buffer.from(JSON.stringify(envelope.header), "utf8"));
  decipher.setAuthTag(decode(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(decode(envelope.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
  return { plaintext, header: envelope.header };
}

/**
 * Seal the `message` arg of a completed V2 message-tool call. `rawArguments` is the complete
 * JSON arg string emitted by the model (reassembled from streaming deltas). Non-message tools
 * pass through unchanged. Already-sealed messages (idempotent replays) pass through unchanged.
 */
export function sealFunctionArguments(
  toolName: string,
  callId: string,
  rawArguments: string
): string {
  if (!isMav2MessageTool(toolName)) return rawArguments;
  const args = JSON.parse(rawArguments) as Record<string, unknown>;
  if (typeof args.message !== "string") throw new Error(`${toolName}.message must be a string`);
  if (!args.message.startsWith(MAV2_PREFIX)) {
    args.message = sealMav2Message(args.message, {
      v: 1,
      kid: "primary",
      tool: baseToolName(toolName),
      callId,
      targetHint:
        typeof args.task_name === "string"
          ? args.task_name
          : typeof args.target === "string"
            ? args.target
            : undefined,
    });
  }
  return JSON.stringify(args);
}

// ---------------------------------------------------------------------------
// Request-side helpers (tool-def marker strip + agent_message decrypt/convert)
// ---------------------------------------------------------------------------

/**
 * Strip `"encrypted": true` from ONLY the `message` param of the 3 V2 message tools, in a
 * Responses `tools` array (function tools flat `{type:"function", name, parameters}` or
 * namespace groups `{type:"namespace", name, tools:[...]}`). Returns true if anything changed.
 * Deliberately narrow: never touches other schema props or other tools.
 */
export function stripEncryptedMarkerFromToolDefs(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  let changed = false;
  const stripOne = (tool: unknown): void => {
    if (!tool || typeof tool !== "object") return;
    const t = tool as Record<string, unknown>;
    if (t.type === "namespace" && Array.isArray(t.tools)) {
      for (const sub of t.tools) stripOne(sub);
      return;
    }
    const name = typeof t.name === "string" ? t.name : undefined;
    if (!name || !isMav2MessageTool(name)) return;
    // parameters may live at top-level (Responses flat) or under function (Chat shape).
    const params =
      (t.parameters as Record<string, unknown> | undefined) ??
      ((t.function as Record<string, unknown> | undefined)?.parameters as
        Record<string, unknown> | undefined);
    const props = params?.properties as Record<string, unknown> | undefined;
    const message = props?.message as Record<string, unknown> | undefined;
    if (message && message.encrypted === true) {
      delete message.encrypted;
      changed = true;
    }
  };
  for (const tool of tools) stripOne(tool);
  return changed;
}

/** A Responses input item that is a Codex V2 agent_message (author->recipient + encrypted content). */
export function isAgentMessageItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  return (item as Record<string, unknown>).type === "agent_message";
}

/**
 * Convert one Codex V2 `agent_message` item into an ordinary Responses user message the local
 * model can read. Decrypts the OmniRoute-sealed `encrypted_content` (fail-closed on foreign
 * ciphertext) and wraps the plaintext with a NEW_TASK header carrying author/recipient routing.
 */
export function convertAgentMessageItem(item: Record<string, unknown>): Record<string, unknown> {
  const author = typeof item.author === "string" ? item.author : "/root";
  const recipient = typeof item.recipient === "string" ? item.recipient : "";
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    if (rec.type === "encrypted_content" && typeof rec.encrypted_content === "string") {
      parts.push(openMav2Message(rec.encrypted_content).plaintext);
    } else if (rec.type === "input_text" && typeof rec.text === "string") {
      parts.push(rec.text);
    } else if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  const header = `[NEW_TASK from ${author}${recipient ? ` to ${recipient}` : ""}]`;
  const text = `${header}\n${parts.join("\n")}`;
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/** True if any input item in a Responses body is an agent_message (=> disable semantic cache). */
export function requestContainsAgentMessage(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const input = (body as Record<string, unknown>).input;
  if (!Array.isArray(input)) return false;
  return input.some(isAgentMessageItem);
}
