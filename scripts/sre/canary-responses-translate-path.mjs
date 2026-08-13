#!/usr/bin/env node
/**
 * scripts/sre/canary-responses-translate-path.mjs
 *
 * Live post-deploy canary for the Codex Responses -> Claude TRANSLATE path
 * (open-sse/translator/response/openai-responses.ts), touched by the
 * fix/codex-responses-commentary-translation merge. Run this against the
 * RUNNING gateway after a deploy to confirm the merge behaves sanely with a
 * real upstream call, not just under unit tests.
 *
 * This is a SMOKE CHECK, not a test suite: it sends one or two small real
 * requests through /v1/messages (the endpoint Claude Code and Claude Code
 * subagents use) to a Codex-backed model, and asserts:
 *   - the request succeeds (HTTP 200, no error envelope)
 *   - a real, non-empty visible answer comes back (guards the loud bug:
 *     commentary leaking as the visible answer would still pass this coarse
 *     check, so this is a SANITY check, not a leak detector -- the unit
 *     tests in tests/unit/responses-translate-overdrop-protection.test.ts
 *     and responses-commentary-phase-leak-translation.test.ts are the
 *     precise guards)
 *   - the answer is not truncated to the known empty-deliverable placeholder
 *     ("...") for a prompt that demands real content -- this is the
 *     over-drop canary: it directly probes the dangerous failure mode (a
 *     real answer silently eaten) with a prompt shaped to trigger it if a
 *     future change makes the drop filter too aggressive
 *
 * Safety:
 *   - Read-only from the gateway's point of view: a normal chat completion,
 *     nothing that creates, deletes, or reconfigures any resource.
 *   - Does NOT restart, bootout, kickstart, or otherwise touch the daemon.
 *   - Idempotent / safe to run repeatedly: each call is a fresh, cheap,
 *     max_tokens-capped request; no state is created or left behind.
 *   - Never touches ports other than the one you pass in (default 20128).
 *
 * Usage:
 *   CANARY_MODEL=codex/gpt-5.1-codex node scripts/sre/canary-responses-translate-path.mjs
 *
 * Env vars:
 *   CANARY_MODEL     REQUIRED. The provider/model string routed to a
 *                     Codex (OpenAI Responses API) upstream on THIS gateway,
 *                     e.g. "codex/gpt-5.1-codex". Must be a model you have
 *                     configured; this script does not create one.
 *   CANARY_BASE_URL   Gateway base URL. Default: http://127.0.0.1:20128
 *   CANARY_API_KEY    Bearer token, if this gateway has REQUIRE_API_KEY=true.
 *                      Fetch it via the omniroute-maintain admin-token flow;
 *                      this script does not fetch secrets itself.
 *
 * Exit code: 0 on PASS, non-zero on any FAIL. Prints a diagnostic on failure.
 */

const BASE_URL = process.env.CANARY_BASE_URL ?? "http://127.0.0.1:20128";
const MODEL = process.env.CANARY_MODEL ?? null;
const API_KEY = process.env.CANARY_API_KEY ?? null;
const TIMEOUT_MS = 30_000;

function headers() {
  const h = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

async function postMessages(body) {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body; leave json null, status/ok still checked below
  }
  return { status: res.status, ok: res.ok, json };
}

function extractText(anthropicResponse) {
  const content = anthropicResponse?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

let failures = 0;
function pass(name, detail = "") {
  console.log(`PASS  [${name}]${detail ? ": " + detail : ""}`);
}
function fail(name, detail = "") {
  failures += 1;
  console.error(`FAIL  [${name}]${detail ? ": " + detail : ""}`);
}

async function checkBaselineAnswer() {
  const name = "baseline-answer";
  const nonce = Date.now();
  const { status, ok, json } = await postMessages({
    model: MODEL,
    max_tokens: 64,
    stream: false,
    messages: [
      {
        role: "user",
        content: `Canary check ${nonce}. In exactly one short sentence, name the capital of France.`,
      },
    ],
  });

  if (!ok || status !== 200) {
    fail(name, `HTTP ${status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
    return;
  }
  const text = extractText(json).trim();
  if (!text) {
    fail(name, "response had no visible text content");
    return;
  }
  if (!/paris/i.test(text)) {
    fail(name, `answer did not mention Paris (over-drop or upstream issue?): ${text.slice(0, 200)}`);
    return;
  }
  pass(name, text.slice(0, 120));
}

async function checkOverDropCanary() {
  const name = "overdrop-canary";
  const nonce = Date.now();
  // Shaped to plausibly trigger a plan-then-deliver / trailing-announcement
  // pattern in the model's own phrasing, the exact shape the over-drop
  // protection unit tests guard against. If a future change makes the drop
  // filter content-based instead of phase-based, THIS is the live probe most
  // likely to catch it before a user does.
  const { status, ok, json } = await postMessages({
    model: MODEL,
    max_tokens: 96,
    stream: false,
    messages: [
      {
        role: "user",
        content:
          `Canary check ${nonce}. First state your one-sentence plan, then on a new line ` +
          `give the final answer: what is 2 + 2? End your answer by saying what you will ` +
          `do next.`,
      },
    ],
  });

  if (!ok || status !== 200) {
    fail(name, `HTTP ${status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
    return;
  }
  const text = extractText(json).trim();
  if (!text) {
    fail(name, "response had no visible text content at all (total over-drop or upstream failure)");
    return;
  }
  if (text === "…" || text === "...") {
    fail(name, "response was the known empty-deliverable placeholder, not a real answer (over-drop)");
    return;
  }
  if (!/\b4\b/.test(text)) {
    fail(name, `answer did not contain the expected content (possible over-drop): ${text.slice(0, 200)}`);
    return;
  }
  pass(name, text.slice(0, 160));
}

async function main() {
  if (!MODEL) {
    console.error(
      "CANARY_MODEL is required: set it to a Codex-backed model configured on this gateway, e.g.\n" +
        "  CANARY_MODEL=codex/gpt-5.1-codex node scripts/sre/canary-responses-translate-path.mjs"
    );
    process.exit(2);
  }

  console.log(`=== Responses TRANSLATE-path canary ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Model:    ${MODEL}`);
  console.log(`Auth:     ${API_KEY ? "Bearer set" : "none"}`);
  console.log();

  try {
    await checkBaselineAnswer();
    await checkOverDropCanary();
  } catch (err) {
    fail("unexpected-error", err instanceof Error ? err.message : String(err));
  }

  console.log();
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All checks PASSED.");
  process.exit(0);
}

main();
