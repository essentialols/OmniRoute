/**
 * Request-body sampling marker normalization.
 *
 * External definition tools can append a compact `@sampling(...)` marker to the request `model`
 * string to carry provider-agnostic numeric sampling parameters beside the selected model id.
 * OmniRoute does not know about profiles, agents, roles, or policy names here. It only parses raw
 * numeric key=value pairs, applies them to the ordinary request fields, and removes the marker so
 * routing and upstream providers see the clean model id.
 */

const SAMPLING_MARKER_RE = /@sampling\(([^)]*)\)/;

const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
  "repeat_penalty",
  "seed",
] as const;

type SamplingKey = (typeof SAMPLING_KEYS)[number];

const SAMPLING_KEY_SET = new Set<string>(SAMPLING_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSamplingValue(key: SamplingKey, value: number): number {
  switch (key) {
    case "temperature":
      return clamp(value, 0, 2);
    case "top_p":
    case "min_p":
      return clamp(value, 0, 1);
    case "top_k":
      return Math.max(0, Math.trunc(value));
    case "presence_penalty":
    case "frequency_penalty":
      return clamp(value, -2, 2);
    case "repeat_penalty":
      return clamp(value, 0, 2);
    case "seed":
      return Math.trunc(value);
  }
}

function parseSamplingPairs(raw: string): Partial<Record<SamplingKey, number>> {
  const parsed: Partial<Record<SamplingKey, number>> = {};

  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    const key = pair.slice(0, separator).trim();
    if (!SAMPLING_KEY_SET.has(key)) continue;

    const rawValue = pair.slice(separator + 1).trim();
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    parsed[key as SamplingKey] = normalizeSamplingValue(key as SamplingKey, value);
  }

  return parsed;
}

/**
 * Consume a `@sampling(key=value,...)` marker from `body.model`.
 *
 * Pure function: returns the same reference untouched when there is no marker to consume, otherwise
 * returns a shallow copy with the marker stripped from `model` and recognized numeric sampling
 * fields populated. Unknown keys and non-finite numeric values are ignored for forward
 * compatibility.
 *
 * Backward compatibility rule: an explicit client field always wins. If the request already has a
 * sampling field, the marker never overwrites that value.
 */
export function normalizeSamplingRequest<T>(body: T): T {
  if (!isPlainObject(body)) return body;
  if (typeof body.model !== "string") return body;

  const match = body.model.match(SAMPLING_MARKER_RE);
  if (!match) return body;

  const next: Record<string, unknown> = {
    ...body,
    model: body.model.replace(SAMPLING_MARKER_RE, ""),
  };
  const parsed = parseSamplingPairs(match[1] ?? "");

  for (const key of SAMPLING_KEYS) {
    if (body[key] !== undefined) continue;
    const value = parsed[key];
    if (value === undefined) continue;
    next[key] = value;
  }

  return next as T;
}
