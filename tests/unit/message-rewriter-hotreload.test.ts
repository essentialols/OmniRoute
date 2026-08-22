import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getMessageRewriteRulesSnapshot,
  setMessageRewriteRulesConfig,
  resetMessageRewriteRulesConfig,
  refreshMessageRewriteRulesFromFile,
  preloadMessageRewriteRules,
  stopMessageRewriteRulesWatcher,
  getMessageRewriteRulesPath,
} from "../../open-sse/services/messageRewriteRules.ts";

const ENV_KEY = "OMNIROUTE_MESSAGE_REWRITE_RULES_PATH";
let tmpDir = "";

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-rewrite-"));
});

test.after(async () => {
  stopMessageRewriteRulesWatcher();
  delete process.env[ENV_KEY];
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

const SAMPLE_RULE = {
  id: "roster",
  target: { kind: "message", role: "system" },
  op: { kind: "strip_list_block", marker: "M", entryPattern: "^- (\\w+):", whitelist: ["keep"] },
};

test("default snapshot is {rules:[]} before any load", () => {
  resetMessageRewriteRulesConfig();
  assert.deepEqual(getMessageRewriteRulesSnapshot(), { rules: [] });
});

test("boot preload populates the globalThis snapshot; sync getter non-empty (no empty-rules-after-boot)", async () => {
  const file = tmpFile("preload.json");
  await fs.writeFile(file, JSON.stringify({ rules: [SAMPLE_RULE] }));
  process.env[ENV_KEY] = file;
  resetMessageRewriteRulesConfig();

  await preloadMessageRewriteRules();
  const snap = getMessageRewriteRulesSnapshot();
  assert.equal(snap.rules.length, 1);
  assert.equal(snap.rules[0].id, "roster");
  stopMessageRewriteRulesWatcher();
});

test("file edit then out-of-band refresh swaps the frozen snapshot (no rebuild)", async () => {
  const file = tmpFile("reload.json");
  await fs.writeFile(file, JSON.stringify({ rules: [SAMPLE_RULE] }));
  process.env[ENV_KEY] = file;
  resetMessageRewriteRulesConfig();

  await refreshMessageRewriteRulesFromFile(true);
  assert.equal(getMessageRewriteRulesSnapshot().rules.length, 1);
  const firstSnap = getMessageRewriteRulesSnapshot();

  // Edit the file (new mtime + content) and refresh.
  await fs.writeFile(
    file,
    JSON.stringify({ rules: [SAMPLE_RULE, { ...SAMPLE_RULE, id: "second" }] })
  );
  await refreshMessageRewriteRulesFromFile(true);

  const secondSnap = getMessageRewriteRulesSnapshot();
  assert.equal(secondSnap.rules.length, 2);
  assert.equal(secondSnap.rules[1].id, "second");
  // Atomic swap: a new frozen object, not a mutation of the old snapshot.
  assert.notEqual(secondSnap, firstSnap);
  assert.equal(firstSnap.rules.length, 1);
});

test("malformed file: last-good snapshot retained, request still served", async () => {
  const file = tmpFile("malformed.json");
  await fs.writeFile(file, JSON.stringify({ rules: [SAMPLE_RULE] }));
  process.env[ENV_KEY] = file;
  resetMessageRewriteRulesConfig();

  await refreshMessageRewriteRulesFromFile(true);
  const good = getMessageRewriteRulesSnapshot();
  assert.equal(good.rules.length, 1);

  // Corrupt the file: the next refresh must keep the last-good snapshot.
  await fs.writeFile(file, "{ this is not valid json ");
  await refreshMessageRewriteRulesFromFile(true);
  assert.equal(getMessageRewriteRulesSnapshot(), good); // same last-good frozen object
  assert.equal(getMessageRewriteRulesSnapshot().rules.length, 1);
});

test("missing file: default no-op snapshot (fail-open, never crashes)", async () => {
  process.env[ENV_KEY] = tmpFile("does-not-exist.json");
  resetMessageRewriteRulesConfig();
  await refreshMessageRewriteRulesFromFile(true);
  assert.deepEqual(getMessageRewriteRulesSnapshot(), { rules: [] });
});

test("invalid rules are dropped on load (per-rule fail-open)", async () => {
  const file = tmpFile("partial-invalid.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      rules: [
        SAMPLE_RULE,
        { target: { kind: "message", role: "system" } }, // missing op
        { op: { kind: "regex_replace", pattern: "x", replacement: "" } }, // missing target
        { target: { kind: "system_field" }, op: { kind: "unknown_op" } }, // unknown op kind
      ],
    })
  );
  process.env[ENV_KEY] = file;
  resetMessageRewriteRulesConfig();
  await refreshMessageRewriteRulesFromFile(true);
  const snap = getMessageRewriteRulesSnapshot();
  assert.equal(snap.rules.length, 1);
  assert.equal(snap.rules[0].id, "roster");
});

test("immutability: the hot-path snapshot is deeply frozen", () => {
  setMessageRewriteRulesConfig({ rules: [SAMPLE_RULE] });
  const snap = getMessageRewriteRulesSnapshot();
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap.rules), true);
  assert.equal(Object.isFrozen(snap.rules[0]), true);
  assert.equal(Object.isFrozen(snap.rules[0].op), true);
  assert.throws(() => {
    // @ts-expect-error intentional mutation attempt on a frozen array.
    snap.rules.push({});
  }, TypeError);
});

test("config path honors env override, else defaults under DATA_DIR/~/.omniroute", () => {
  process.env[ENV_KEY] = "/tmp/pinned/messageRewriteRules.json";
  assert.equal(getMessageRewriteRulesPath(), "/tmp/pinned/messageRewriteRules.json");
  delete process.env[ENV_KEY];
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = "/var/omniroute-data";
  assert.equal(getMessageRewriteRulesPath(), "/var/omniroute-data/messageRewriteRules.json");
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
});
