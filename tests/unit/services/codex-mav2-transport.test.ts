import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Deterministic 32-byte keys for the active + grace-period slots. Set BEFORE importing the
// codec so loadKey() sees them (the module reads process.env lazily per call).
const ACTIVE_KEY = randomBytes(32).toString("base64");
const OLD_KEY = randomBytes(32).toString("base64");
process.env.OMNIROUTE_MAV2_KEY_B64 = ACTIVE_KEY;
process.env.OMNIROUTE_MAV2_KEY_B64_OLD = OLD_KEY;

const {
  MAV2_PREFIX,
  baseToolName,
  isMav2MessageTool,
  sealMav2Message,
  openMav2Message,
  sealFunctionArguments,
  stripEncryptedMarkerFromToolDefs,
  isAgentMessageItem,
  convertAgentMessageItem,
  requestContainsAgentMessage,
} = await import("../../../open-sse/services/codexMultiAgentV2Transport.ts");

const header = (over = {}) => ({
  v: 1,
  kid: "primary",
  tool: "spawn_agent",
  callId: "call_1",
  ...over,
});

test("baseToolName strips namespace prefixes (dot / slash / __)", () => {
  assert.equal(baseToolName("spawn_agent"), "spawn_agent");
  assert.equal(baseToolName("agents.spawn_agent"), "spawn_agent");
  assert.equal(baseToolName("agents__spawn_agent"), "spawn_agent");
  assert.equal(baseToolName("x/y/send_message"), "send_message");
});

test("isMav2MessageTool matches only the 3 message tools, namespaced or not", () => {
  for (const n of [
    "spawn_agent",
    "send_message",
    "followup_task",
    "agents.spawn_agent",
    "agents__followup_task",
  ]) {
    assert.equal(isMav2MessageTool(n), true, n);
  }
  for (const n of [
    "wait_agent",
    "list_agents",
    "interrupt_agent",
    "exec_command",
    "agents.wait_agent",
  ]) {
    assert.equal(isMav2MessageTool(n), false, n);
  }
});

test("seal -> open round-trips plaintext and preserves header", () => {
  const h = header({ targetHint: "impl" });
  const token = sealMav2Message("delegate: fix the bug", h);
  assert.ok(token.startsWith(MAV2_PREFIX));
  const { plaintext, header: got } = openMav2Message(token);
  assert.equal(plaintext, "delegate: fix the bug");
  assert.deepEqual(got, h);
});

test("open fails closed on a missing prefix (foreign ciphertext)", () => {
  assert.throws(
    () => openMav2Message("gAAAAA-some-openai-ciphertext"),
    /Unsupported Multi-Agent V2 ciphertext/
  );
});

test("open fails closed on a tampered ciphertext (GCM tag mismatch)", () => {
  const token = sealMav2Message("secret task", header());
  // Flip a byte in the base64url envelope body.
  const body = token.slice(MAV2_PREFIX.length);
  const tampered =
    MAV2_PREFIX + (body.slice(0, -2) + (body.at(-2) === "A" ? "B" : "A") + body.at(-1));
  assert.throws(() => openMav2Message(tampered));
});

test("open fails closed when sealed under a wrong/unknown key", () => {
  const token = sealMav2Message("x", header());
  const saved = process.env.OMNIROUTE_MAV2_KEY_B64;
  process.env.OMNIROUTE_MAV2_KEY_B64 = randomBytes(32).toString("base64"); // rotate active key, no OLD match
  try {
    assert.throws(() => openMav2Message(token));
  } finally {
    process.env.OMNIROUTE_MAV2_KEY_B64 = saved;
  }
});

test("keyring grace period: kid!=primary decrypts with the OLD key", () => {
  // Seal with the OLD key acting as active, then restore and decrypt via the OLD-key branch.
  const savedActive = process.env.OMNIROUTE_MAV2_KEY_B64;
  process.env.OMNIROUTE_MAV2_KEY_B64 = OLD_KEY;
  const token = sealMav2Message("resumed thread msg", header({ kid: "rot-2025" }));
  process.env.OMNIROUTE_MAV2_KEY_B64 = savedActive; // active is back to ACTIVE_KEY; OLD_KEY still in _OLD
  const { plaintext } = openMav2Message(token);
  assert.equal(plaintext, "resumed thread msg");
});

test("sealFunctionArguments seals spawn_agent.message and leaves task_name intact", () => {
  const raw = JSON.stringify({
    task_name: "impl",
    agent_type: "gemma_worker",
    message: "read README.md",
  });
  const out = sealFunctionArguments("agents.spawn_agent", "call_9", raw);
  const parsed = JSON.parse(out);
  assert.equal(parsed.task_name, "impl");
  assert.equal(parsed.agent_type, "gemma_worker");
  assert.ok(parsed.message.startsWith(MAV2_PREFIX));
  const { plaintext, header: h } = openMav2Message(parsed.message);
  assert.equal(plaintext, "read README.md");
  assert.equal(h.tool, "spawn_agent");
  assert.equal(h.targetHint, "impl");
});

test("sealFunctionArguments is idempotent (already-sealed message untouched) and passes non-message tools through", () => {
  const sealed = sealFunctionArguments("spawn_agent", "c1", JSON.stringify({ message: "hi" }));
  const again = sealFunctionArguments("spawn_agent", "c1", sealed);
  assert.deepEqual(JSON.parse(again).message, JSON.parse(sealed).message);
  const passthrough = JSON.stringify({ foo: "bar" });
  assert.equal(sealFunctionArguments("wait_agent", "c2", passthrough), passthrough);
});

test("stripEncryptedMarkerFromToolDefs removes encrypted:true only from the 3 tools' message param", () => {
  const tools = [
    {
      type: "namespace",
      name: "agents",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", encrypted: true },
              task_name: { type: "string" },
            },
          },
        },
        {
          type: "function",
          name: "wait_agent",
          parameters: { type: "object", properties: { target: { type: "string" } } },
        },
      ],
    },
    {
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string", encrypted: true } } },
    },
  ];
  const changed = stripEncryptedMarkerFromToolDefs(tools);
  assert.equal(changed, true);
  assert.equal(tools[0].tools[0].parameters.properties.message.encrypted, undefined);
  // wait_agent has no message param; exec_command is NOT a message tool -> its marker is preserved.
  assert.equal(tools[1].parameters.properties.cmd.encrypted, true);
});

test("agent_message detection + conversion to an ordinary user message (decrypts our ciphertext)", () => {
  const token = sealMav2Message(
    "Read README.md and return the first heading.",
    header({ tool: "spawn_agent", targetHint: "worker" })
  );
  const item = {
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "encrypted_content", encrypted_content: token }],
  };
  assert.equal(isAgentMessageItem(item), true);
  assert.equal(isAgentMessageItem({ type: "message" }), false);
  const converted = convertAgentMessageItem(item);
  assert.equal(converted.type, "message");
  assert.equal(converted.role, "user");
  const text = converted.content[0].text;
  assert.match(text, /\[NEW_TASK from \/root to \/root\/worker\]/);
  assert.match(text, /Read README\.md and return the first heading\./);
});

test("convertAgentMessageItem fails closed on foreign ciphertext", () => {
  const item = {
    type: "agent_message",
    author: "/root",
    recipient: "/root/w",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAAforeign" }],
  };
  assert.throws(() => convertAgentMessageItem(item), /Unsupported Multi-Agent V2 ciphertext/);
});

test("requestContainsAgentMessage detects agent_message in the input array", () => {
  assert.equal(
    requestContainsAgentMessage({ input: [{ type: "message" }, { type: "agent_message" }] }),
    true
  );
  assert.equal(requestContainsAgentMessage({ input: [{ type: "message" }] }), false);
  assert.equal(requestContainsAgentMessage({}), false);
});
