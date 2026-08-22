/**
 * Message-rewrite rules — hot-reloadable config loader for `messageRewriter.ts`.
 *
 * D3 (why this is NOT a sync-snapshot-of-async): `translateRequest` is
 * synchronous, so the hot path must read the rules SYNCHRONOUSLY. But a
 * module-local `let` snapshot is duplicated per webpack module graph in the
 * Next.js standalone build (the #5312-class bug documented in
 * `systemTransforms.ts:452-459`), so a boot-time load never reaches the request
 * path. This mirrors `systemTransforms`'s **globalThis frozen singleton**:
 *   - the hot path calls `getMessageRewriteRulesSnapshot()` (sync, frozen read),
 *   - the snapshot is hydrated once at boot (`preloadMessageRewriteRules`),
 *   - and refreshed OUT OF BAND by an interval watcher (never per-request),
 *     which atomically swaps the frozen object (never mutates in place).
 *
 * File hot-reload borrows `payloadRules.ts`'s mtime-cache + singleflight shape,
 * but runs entirely off the request hot path.
 *
 * Fail-open: missing file ⇒ default `{rules:[]}` (no-op); malformed file ⇒ keep
 * last-good snapshot + log once; first-request-before-preload ⇒ default no-op.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  MessageRewriteRule,
  RewriteMatch,
  RewriteOp,
  RewriteTarget,
} from "./messageRewriter.ts";

export interface MessageRewriteRulesConfig {
  rules: MessageRewriteRule[];
}

const DEFAULT_CONFIG: MessageRewriteRulesConfig = Object.freeze({ rules: [] });

const MIN_RELOAD_MS = 1_000;
const DEFAULT_RELOAD_MS = 5_000;

// ────────────────────────────────────────────────────────────────────────────
// globalThis frozen singleton (mirrors systemTransforms.ts:460-468)
// ────────────────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "__omniroute_messageRewriteRules_config__";
const _store = globalThis as unknown as Record<string, MessageRewriteRulesConfig | undefined>;

function getStore(): MessageRewriteRulesConfig {
  if (!_store[GLOBAL_KEY]) {
    _store[GLOBAL_KEY] = DEFAULT_CONFIG;
  }
  return _store[GLOBAL_KEY]!;
}

/** Sync, frozen read for the translator hot path. Never throws; never mutates. */
export function getMessageRewriteRulesSnapshot(): MessageRewriteRulesConfig {
  return getStore();
}

/** Replace the active snapshot (globalThis writer, mirrors setSystemTransformsConfig). */
export function setMessageRewriteRulesConfig(input: unknown): void {
  _store[GLOBAL_KEY] = freezeConfig(normalizeMessageRewriteRulesConfig(input));
}

export function resetMessageRewriteRulesConfig(): void {
  _store[GLOBAL_KEY] = DEFAULT_CONFIG;
}

// ────────────────────────────────────────────────────────────────────────────
// Validation / normalization (fail-open per-rule: drop invalid entries)
// ────────────────────────────────────────────────────────────────────────────

const KNOWN_OP_KINDS = new Set([
  "strip_list_block",
  "regex_replace",
  "replace_list",
  "remove_between",
  "inject",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTarget(value: unknown): RewriteTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "system_field") return { kind: "system_field" };
  if (value.kind === "message" && typeof value.role === "string" && value.role) {
    return { kind: "message", role: value.role };
  }
  return null;
}

function normalizeMatch(value: unknown): RewriteMatch | undefined {
  if (!isRecord(value)) return undefined;
  const match: RewriteMatch = {};
  if (typeof value.model === "string") match.model = value.model;
  if (typeof value.provider === "string") match.provider = value.provider;
  if (typeof value.sourceFormat === "string") match.sourceFormat = value.sourceFormat;
  if (typeof value.targetFormat === "string") match.targetFormat = value.targetFormat;
  return Object.keys(match).length > 0 ? match : undefined;
}

function normalizeOp(value: unknown): RewriteOp | null {
  if (!isRecord(value)) return null;
  if (typeof value.kind !== "string" || !KNOWN_OP_KINDS.has(value.kind)) return null;
  // Keep the op verbatim (unknown extra fields tolerated) once the kind is valid;
  // per-op parameter defaults are applied by the engine executors.
  return value as unknown as RewriteOp;
}

function normalizeRule(value: unknown): MessageRewriteRule | null {
  if (!isRecord(value)) return null;
  const target = normalizeTarget(value.target);
  const op = normalizeOp(value.op);
  if (!target || !op) return null;
  const rule: MessageRewriteRule = { target, op };
  if (typeof value.id === "string") rule.id = value.id;
  if (typeof value.enabled === "boolean") rule.enabled = value.enabled;
  if (value.phase === "pre_source" || value.phase === "post_target") rule.phase = value.phase;
  const match = normalizeMatch(value.match);
  if (match) rule.match = match;
  return rule;
}

export function normalizeMessageRewriteRulesConfig(value: unknown): MessageRewriteRulesConfig {
  const rawRules = isRecord(value) && Array.isArray(value.rules) ? value.rules : [];
  const rules: MessageRewriteRule[] = [];
  for (const raw of rawRules) {
    const rule = normalizeRule(raw);
    if (rule) rules.push(rule);
  }
  return { rules };
}

function freezeConfig(config: MessageRewriteRulesConfig): MessageRewriteRulesConfig {
  // Deep-freeze so the hot-path read can never mutate the shared snapshot.
  for (const rule of config.rules) {
    Object.freeze(rule.target);
    Object.freeze(rule.op);
    if (rule.match) Object.freeze(rule.match);
    Object.freeze(rule);
  }
  Object.freeze(config.rules);
  return Object.freeze(config);
}

// ────────────────────────────────────────────────────────────────────────────
// File hot-reload (mtime cache + singleflight; runs OFF the hot path)
// ────────────────────────────────────────────────────────────────────────────

let cachedFilePath = "";
let cachedFileMtimeMs = -1;
let lastFileCheckAt = 0;
let fileLoadPromise: Promise<void> | null = null;
let lastFileErrorSignature = "";

/**
 * Resolve the config path. Self-contained (no `src/` import) so the open-sse
 * module stays edge-safe. PIN `OMNIROUTE_MESSAGE_REWRITE_RULES_PATH` to an
 * absolute path in the daemon env (its cwd is not the repo) — D5.
 */
export function getMessageRewriteRulesPath(): string {
  const explicit = process.env.OMNIROUTE_MESSAGE_REWRITE_RULES_PATH;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const dataDir =
    typeof process.env.DATA_DIR === "string" && process.env.DATA_DIR.trim()
      ? process.env.DATA_DIR.trim()
      : path.join(os.homedir(), ".omniroute");
  return path.join(dataDir, "messageRewriteRules.json");
}

function getReloadIntervalMs(): number {
  const parsed = Number.parseInt(process.env.OMNIROUTE_MESSAGE_REWRITE_RULES_RELOAD_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < MIN_RELOAD_MS) return DEFAULT_RELOAD_MS;
  return parsed;
}

/**
 * Refresh the globalThis snapshot from the config file. mtime-gated +
 * singleflighted. On ENOENT → default no-op snapshot. On malformed JSON → keep
 * the last-good snapshot and log once. Never throws.
 */
export async function refreshMessageRewriteRulesFromFile(force = false): Promise<void> {
  const filePath = getMessageRewriteRulesPath();
  const now = Date.now();

  if (!force && filePath === cachedFilePath && now - lastFileCheckAt < getReloadIntervalMs()) {
    return;
  }

  if (fileLoadPromise) {
    await fileLoadPromise;
    return;
  }

  fileLoadPromise = (async () => {
    lastFileCheckAt = now;
    cachedFilePath = filePath;

    try {
      const stat = await fs.stat(filePath);
      if (!force && cachedFileMtimeMs === stat.mtimeMs) return;

      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      // Atomic swap of the frozen snapshot (never mutate in place).
      _store[GLOBAL_KEY] = freezeConfig(normalizeMessageRewriteRulesConfig(parsed));
      cachedFileMtimeMs = stat.mtimeMs;
      lastFileErrorSignature = "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Missing file ⇒ empty/no-op. Reset mtime so a later create is picked up.
        _store[GLOBAL_KEY] = DEFAULT_CONFIG;
        cachedFileMtimeMs = -1;
        lastFileErrorSignature = "";
        return;
      }
      // Malformed / unreadable ⇒ keep last-good snapshot, log once.
      const message = error instanceof Error ? error.message : String(error);
      const signature = `${filePath}:${message}`;
      if (signature !== lastFileErrorSignature) {
        console.warn(`[MESSAGE_REWRITE_RULES] Failed to load ${filePath}: ${message}`);
        lastFileErrorSignature = signature;
      }
    }
  })();

  try {
    await fileLoadPromise;
  } finally {
    fileLoadPromise = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Out-of-band interval watcher (never runs on the request hot path)
// ────────────────────────────────────────────────────────────────────────────

let watcherTimer: ReturnType<typeof setInterval> | null = null;

export function startMessageRewriteRulesWatcher(): void {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    void refreshMessageRewriteRulesFromFile(false).catch(() => {
      /* fail-open: keep last-good snapshot */
    });
  }, getReloadIntervalMs());
  // Never keep the process (or the test runner) alive on account of the watcher.
  if (typeof watcherTimer.unref === "function") watcherTimer.unref();
}

export function stopMessageRewriteRulesWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Boot preload (D3): resolve once at boot, then start the out-of-band watcher.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hydrate the snapshot at boot. Load order: file (`~/.omniroute/…`) then an
 * optional DB/Settings override (resolved once, off the hot path). Starts the
 * interval watcher so later file edits hot-reload without a rebuild.
 *
 * `dbOverride` is the `settings.messageRewriteRules` value when present (D6:
 * file-first now; a full Settings-UI section is a later follow-up).
 */
export async function preloadMessageRewriteRules(dbOverride?: unknown): Promise<void> {
  await refreshMessageRewriteRulesFromFile(true);
  if (dbOverride !== null && dbOverride !== undefined && typeof dbOverride === "object") {
    _store[GLOBAL_KEY] = freezeConfig(normalizeMessageRewriteRulesConfig(dbOverride));
  }
  startMessageRewriteRulesWatcher();
}
