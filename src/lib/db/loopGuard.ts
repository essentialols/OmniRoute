/**
 * db/loopGuard.ts — Local-model loop-guard configuration.
 *
 * Stores the guard's tunables in the key_value table under the "loopGuard"
 * namespace. Read PER CALL (no process-lifetime cache) so a dashboard/DB edit
 * hot-reloads on the very next request — the guard must react to a config change
 * without a restart. Fail-open: any read/parse error yields the built-in
 * defaults so the guard degrades to safe defaults rather than throwing on the
 * request hot path. Mirrors the per-call read pattern in db/featureFlags.ts.
 */

import { getDbInstance } from "./core";

const NAMESPACE = "loopGuard";

export interface LoopGuardConfig {
  /** Master on/off switch. */
  enabled: boolean;
  /** Number of most-recent assistant actions the detector inspects. */
  window: number;
  /** In-window frequency of one action that triggers a soft steer. */
  steerThreshold: number;
  /** In-window frequency that triggers a hard stop (force final answer). */
  stopThreshold: number;
  /** Case-insensitive regex source; only matching models are guarded. */
  modelPattern: string;
}

export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
  enabled: true,
  window: 6,
  steerThreshold: 3,
  stopThreshold: 5,
  modelPattern: "ornith|M1y|gemma",
};

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function boundedInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/**
 * Read the effective loop-guard config from the key_value store, per call.
 * Each field independently falls back to its default when its row is missing or
 * malformed; a total read failure yields the full defaults.
 */
export function getLoopGuardConfig(): LoopGuardConfig {
  try {
    const db = getDbInstance();
    const rows = db
      .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
      .all(NAMESPACE) as Array<{ key: string; value: string }>;

    const config: LoopGuardConfig = { ...DEFAULT_LOOP_GUARD_CONFIG };
    for (const row of rows) {
      const parsed = parseJsonSafe(row?.value);
      if (parsed === undefined) continue;
      switch (row.key) {
        case "enabled":
          config.enabled = parsed !== false;
          break;
        case "window":
          config.window = boundedInt(parsed, DEFAULT_LOOP_GUARD_CONFIG.window, 1);
          break;
        case "steerThreshold":
          config.steerThreshold = boundedInt(parsed, DEFAULT_LOOP_GUARD_CONFIG.steerThreshold, 1);
          break;
        case "stopThreshold":
          config.stopThreshold = boundedInt(parsed, DEFAULT_LOOP_GUARD_CONFIG.stopThreshold, 1);
          break;
        case "modelPattern":
          if (typeof parsed === "string" && parsed.trim()) config.modelPattern = parsed;
          break;
      }
    }
    return config;
  } catch {
    return { ...DEFAULT_LOOP_GUARD_CONFIG };
  }
}
