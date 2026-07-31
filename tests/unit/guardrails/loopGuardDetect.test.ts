/**
 * TDD (RED → GREEN) for the local-model loop detector core.
 * Run: node --import tsx/esm --test tests/unit/guardrails/loopGuardDetect.test.ts
 *
 * Contract: analyzeMessagesForLoop() is a PURE function over a transcript tail.
 * It detects an agentic loop — the same tool action (name + args) recurring, or an
 * identical assistant text block recurring — within a sliding window, and returns a
 * tiered decision: "none" | "steer" (>= steerThreshold) | "stop" (>= stopThreshold).
 * It must be fail-open: any malformed/empty input yields { decision: "none" }.
 *
 * Detection is frequency-in-window (NOT just consecutive) so interleaved loops
 * (X, Y, X, Y, X …) are caught — the exact failure mode the weak-model-harness fix
 * (commit b8d9160) hardened against.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMessagesForLoop,
  type LoopGuardDetectConfig,
} from "../../../src/lib/guardrails/loopGuardDetect.ts";

const CFG: LoopGuardDetectConfig = { window: 6, steerThreshold: 3, stopThreshold: 5 };

// ─── builders ───────────────────────────────────────────────────────────────

function anthropicToolTurn(name: string, input: Record<string, unknown>) {
  return { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] };
}
function anthropicResult(text: string) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] };
}
function anthropicText(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function openaiToolTurn(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}
function openaiResult(text: string) {
  return { role: "tool", tool_call_id: "c", content: text };
}

/** N assistant tool turns of the SAME (name,input), each followed by a distinct result. */
function repeatAnthropic(n: number, name: string, input: Record<string, unknown>) {
  const out: unknown[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < n; i++) {
    out.push(anthropicToolTurn(name, input));
    out.push(anthropicResult(`result ${i}`));
  }
  return out;
}

// ─── repeated tool call: tiered thresholds ────────────────────────────────────

describe("analyzeMessagesForLoop: repeated identical tool call", () => {
  it("5 identical Anthropic tool_use → stop", () => {
    const res = analyzeMessagesForLoop(
      repeatAnthropic(5, "Bash", { command: "ls" }),
      "anthropic",
      CFG
    );
    assert.equal(res.decision, "stop");
    assert.ok(res.repeatCount >= 5, `repeatCount=${res.repeatCount}`);
    assert.match(res.reason, /Bash/);
  });

  it("3 identical Anthropic tool_use → steer", () => {
    const res = analyzeMessagesForLoop(
      repeatAnthropic(3, "Bash", { command: "ls" }),
      "anthropic",
      CFG
    );
    assert.equal(res.decision, "steer");
  });

  it("2 identical Anthropic tool_use → none", () => {
    const res = analyzeMessagesForLoop(
      repeatAnthropic(2, "Bash", { command: "ls" }),
      "anthropic",
      CFG
    );
    assert.equal(res.decision, "none");
  });

  it("5 identical OpenAI tool_calls → stop", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 5; i++) {
      msgs.push(openaiToolTurn("Bash", { command: "ls" }));
      msgs.push(openaiResult(`r${i}`));
    }
    const res = analyzeMessagesForLoop(msgs, "openai", CFG);
    assert.equal(res.decision, "stop");
  });
});

// ─── interleaved loop (the anti-hardening case) ───────────────────────────────

describe("analyzeMessagesForLoop: interleaved loop", () => {
  it("X,Y,X,Y,X (X thrice in window) → steer, not fooled by novel Y", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    const seq = ["X", "Y", "X", "Y", "X"];
    seq.forEach((cmd, i) => {
      msgs.push(anthropicToolTurn("Bash", { command: cmd }));
      msgs.push(anthropicResult(`r${i}`));
    });
    const res = analyzeMessagesForLoop(msgs, "anthropic", CFG);
    assert.equal(res.decision, "steer");
    assert.match(res.reason, /command.*X|X/);
  });
});

// ─── no loop / fail-open ──────────────────────────────────────────────────────

describe("analyzeMessagesForLoop: negatives + fail-open", () => {
  it("all-distinct actions → none", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    ["a", "b", "c", "d", "e"].forEach((cmd, i) => {
      msgs.push(anthropicToolTurn("Bash", { command: cmd }));
      msgs.push(anthropicResult(`r${i}`));
    });
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "none");
  });

  it("empty / malformed → none (never throws)", () => {
    assert.equal(analyzeMessagesForLoop([], "anthropic", CFG).decision, "none");
    assert.equal(
      analyzeMessagesForLoop(undefined as unknown as unknown[], "anthropic", CFG).decision,
      "none"
    );
    assert.equal(
      analyzeMessagesForLoop([{ role: "assistant" }, 42, null] as unknown[], "anthropic", CFG)
        .decision,
      "none"
    );
  });

  it("window bounds detection to recent turns (old repeats age out)", () => {
    // 4 old identical calls, then 5 distinct recent calls → should NOT fire (window=6).
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 4; i++) {
      msgs.push(anthropicToolTurn("Bash", { command: "old" }));
      msgs.push(anthropicResult(`o${i}`));
    }
    ["a", "b", "c", "d", "e"].forEach((cmd, i) => {
      msgs.push(anthropicToolTurn("Bash", { command: cmd }));
      msgs.push(anthropicResult(`r${i}`));
    });
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "none");
  });
});

// ─── repeated assistant text (degenerate generation) ──────────────────────────

describe("analyzeMessagesForLoop: repeated assistant text", () => {
  it("identical assistant text block 5x → stop", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 5; i++) {
      msgs.push(anthropicText("I am now going to solve the task."));
      msgs.push({ role: "user", content: "continue" });
    }
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "stop");
  });
});

// ─── finding 1: multiple / parallel tool calls in one assistant turn ───────────

describe("analyzeMessagesForLoop: multiple tool calls per turn", () => {
  it("Anthropic: a repeated 2nd tool_use block is counted, not just the first", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 3; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Read", input: { path: `f${i}` } },
          { type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } },
        ],
      });
      msgs.push(anthropicResult(`r${i}`));
    }
    const res = analyzeMessagesForLoop(msgs, "anthropic", CFG);
    assert.equal(res.decision, "steer");
    assert.match(res.reason, /Bash/);
  });

  it("OpenAI: a repeated 2nd parallel tool_call is counted", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 3; i++) {
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ p: i }) },
          },
          {
            id: "b",
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
          },
        ],
      });
      msgs.push(openaiResult(`r${i}`));
    }
    const res = analyzeMessagesForLoop(msgs, "openai", CFG);
    assert.equal(res.decision, "steer");
    assert.match(res.reason, /Bash/);
  });
});

// ─── finding 2: short repeated assistant text ─────────────────────────────────

describe("analyzeMessagesForLoop: short repeated text", () => {
  it("short assistant text 'OK' repeated 5x → stop", () => {
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 5; i++) {
      msgs.push(anthropicText("OK"));
      msgs.push({ role: "user", content: "continue" });
    }
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "stop");
  });
});

// ─── finding 3: canonicalization safety (bounded + unicode-stable) ─────────────

describe("analyzeMessagesForLoop: canonicalization safety", () => {
  it("deeply nested args never throw (fail-open)", () => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 20000; i++) {
      const next: Record<string, unknown> = {};
      cur.x = next;
      cur = next;
    }
    const msgs = [anthropicToolTurn("Bash", { deep: root })];
    const res = analyzeMessagesForLoop(msgs, "anthropic", CFG);
    assert.ok(["none", "steer", "stop"].includes(res.decision));
  });

  it("huge identical args repeated 5x → stop (stable, bounded fingerprint)", () => {
    const big = "x".repeat(200000);
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 5; i++) {
      msgs.push(anthropicToolTurn("Bash", { blob: big }));
      msgs.push(anthropicResult(`r${i}`));
    }
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "stop");
  });

  it("unicode-equivalent args (NFC vs NFD) dedupe to one fingerprint → stop", () => {
    const nfc = "caf\u00e9"; // NFC: precomposed e-acute
    const nfd = "cafe\u0301"; // NFD: e + combining acute (same grapheme)
    const msgs: unknown[] = [{ role: "user", content: "start" }];
    [nfc, nfd, nfc, nfd, nfc, nfd].forEach((v, i) => {
      msgs.push(anthropicToolTurn("Bash", { name: v }));
      msgs.push(anthropicResult(`r${i}`));
    });
    assert.equal(analyzeMessagesForLoop(msgs, "anthropic", CFG).decision, "stop");
  });
});
