/**
 * Message / system-prompt rewriter — pure, block-aware rewrite engine.
 *
 * Config-driven successor to the hand-wired one-offs in the translator layer
 * (`stripBuiltinAgentRoster`, `stripAnthropicBillingHeader`, the Anthropic
 * system-field term sanitizer). See plan-v2 §2–§8.
 *
 * Design invariants (hard requirements):
 *   - **Block-aware, never stringify.** Operates on Claude-shaped content-block
 *     arrays (`text`/`image`/`thinking`/`tool_use`/`tool_result`). Only the
 *     `.text` of `type:"text"` blocks is edited; every other block and the block
 *     ORDER are preserved verbatim (tool adjacency invariant).
 *   - **`cache_control` (and every non-text field) is preserved** by cloning via
 *     `{ ...block, text }` — fatal for DashScope/alibaba/Xiaomi caching (#2069).
 *   - **Pure.** No I/O. The rules snapshot is read by the caller and passed in.
 *   - **Fail-open.** A non-matching rule returns the same object untouched; a
 *     throwing rule is logged once and skipped; an invalid model regex is a
 *     non-match. The engine never throws.
 *
 * Two hooks split the work across the translation boundary (D1):
 *   - `applyPreSourceRewrites`  — runs on the SOURCE Claude-shaped body (intact
 *     `role:"system"` messages + `system` field) BEFORE translation. Owns the
 *     roster strip + billing-header strip. Rules with `phase:"pre_source"`
 *     (the default).
 *   - `applyPostTargetRewrites` — runs on the TARGET Claude-shaped `result`
 *     AFTER `result.system` is built. Owns the system-field term sanitizer.
 *     Rules with `phase:"post_target"`.
 */

// ────────────────────────────────────────────────────────────────────────────
// Rule schema (shared with messageRewriteRules.ts loader)
// ────────────────────────────────────────────────────────────────────────────

export interface RewriteContext {
  model?: string | null;
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
}

export interface RewriteMatch {
  /** Regex string matched against ctx.model (try/catch; invalid ⇒ non-match). */
  model?: string;
  /** Exact string equality against ctx.provider. */
  provider?: string;
  /** Exact string equality against ctx.sourceFormat (a FORMATS value). */
  sourceFormat?: string;
  /** Exact string equality against ctx.targetFormat (a FORMATS value). */
  targetFormat?: string;
}

export type RewriteTarget = { kind: "system_field" } | { kind: "message"; role: string };

export interface StripListBlockOp {
  kind: "strip_list_block";
  /** Line prefix that opens the list block (matched via `line.startsWith`). */
  marker: string;
  /** Regex whose capture group 1 is the list-entry name. */
  entryPattern: string;
  /** Entry names to KEEP; all other entries inside the block are dropped. */
  whitelist: string[];
  /** Case-sensitive whitelist match. Default true. */
  caseSensitive?: boolean;
  /** A non-entry line inside the block ends it (kept). Default true. */
  stopAtFirstNonListLine?: boolean;
}

export interface RegexReplaceOp {
  kind: "regex_replace";
  pattern: string;
  flags?: string;
  replacement: string;
}

export interface ReplaceListOp {
  kind: "replace_list";
  /** `replaceAll` semantics for each mapping, applied in order. */
  replacements: Array<{ from: string; to: string }> | Record<string, string>;
}

export interface RemoveBetweenOp {
  kind: "remove_between";
  start: string;
  end: string;
  /** Remove the delimiters too. Default true. */
  inclusive?: boolean;
}

export interface InjectOp {
  kind: "inject";
  position: "prepend" | "append";
  text: string;
  /** Skip if already present (prefix/substring test). Defaults to `text`. */
  idempotencyKey?: string;
}

export type RewriteOp =
  StripListBlockOp | RegexReplaceOp | ReplaceListOp | RemoveBetweenOp | InjectOp;

export interface MessageRewriteRule {
  id?: string;
  enabled?: boolean;
  /** Which hook runs the rule. Default `"pre_source"`. */
  phase?: "pre_source" | "post_target";
  match?: RewriteMatch;
  target: RewriteTarget;
  op: RewriteOp;
}

// ────────────────────────────────────────────────────────────────────────────
// Body shape helpers (mirror ccBridgeTransforms shapes; kept local so the
// engine stays pure and dependency-free)
// ────────────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface Message {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

interface RewriteBody {
  system?: string | ContentBlock[] | unknown;
  messages?: Message[];
  [key: string]: unknown;
}

function isTextBlock(block: unknown): block is ContentBlock & { text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as ContentBlock).type === "text" &&
    typeof (block as ContentBlock).text === "string"
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Log-once (fail-open per-rule)
// ────────────────────────────────────────────────────────────────────────────

const _loggedOnce = new Set<string>();

function logOnce(ruleLabel: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const signature = `${ruleLabel}:${message}`;
  if (_loggedOnce.has(signature)) return;
  _loggedOnce.add(signature);
  console.warn(`[MESSAGE_REWRITE] rule "${ruleLabel}" failed, skipped: ${message}`);
}

/** Test helper — reset the log-once dedupe set. */
export function resetMessageRewriterLogState(): void {
  _loggedOnce.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// Matching
// ────────────────────────────────────────────────────────────────────────────

export function ruleMatches(ctx: RewriteContext, match: RewriteMatch | undefined): boolean {
  if (!match) return true;
  if (match.model != null) {
    let regex: RegExp;
    try {
      regex = new RegExp(match.model);
    } catch {
      return false; // invalid regex ⇒ non-match (fail-open)
    }
    if (!regex.test(String(ctx.model ?? ""))) return false;
  }
  if (match.provider != null && String(ctx.provider ?? "") !== match.provider) return false;
  if (match.sourceFormat != null && String(ctx.sourceFormat ?? "") !== match.sourceFormat) {
    return false;
  }
  if (match.targetFormat != null && String(ctx.targetFormat ?? "") !== match.targetFormat) {
    return false;
  }
  return true;
}

function selectRules(
  rules: MessageRewriteRule[] | undefined,
  ctx: RewriteContext,
  phase: "pre_source" | "post_target"
): MessageRewriteRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (rule) =>
      !!rule &&
      rule.enabled !== false &&
      (rule.phase ?? "pre_source") === phase &&
      ruleMatches(ctx, rule.match)
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Text-substitution op executors (operate on a plain string)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Byte-equivalent to the live `stripBuiltinAgentRoster` (claude-to-openai.ts):
 * case-sensitive whitelist, block ends at first non-list line, string content.
 */
export function stripListBlock(text: string, op: StripListBlockOp): string {
  const marker = op.marker;
  if (!marker || typeof text !== "string" || !text.includes(marker)) return text;

  let entryRegex: RegExp;
  try {
    entryRegex = new RegExp(op.entryPattern);
  } catch {
    return text; // invalid entry pattern ⇒ no-op
  }

  const caseSensitive = op.caseSensitive !== false;
  const stopAtFirstNonListLine = op.stopAtFirstNonListLine !== false;
  const whitelist = new Set(
    (op.whitelist || []).map((name) => (caseSensitive ? name : name.toLowerCase()))
  );

  const out: string[] = [];
  let inRoster = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(marker)) {
      inRoster = true;
      out.push(line);
      continue;
    }
    if (inRoster) {
      const entry = entryRegex.exec(line);
      if (entry) {
        const name = entry[1] ?? "";
        const key = caseSensitive ? name : name.toLowerCase();
        if (whitelist.has(key)) out.push(line);
        continue; // drop non-whitelisted entry line
      }
      if (stopAtFirstNonListLine) inRoster = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

function regexReplace(text: string, op: RegexReplaceOp): string {
  if (!op.pattern) return text;
  let regex: RegExp;
  try {
    regex = new RegExp(op.pattern, op.flags ?? "u");
  } catch {
    return text;
  }
  return text.replace(regex, op.replacement ?? "");
}

function normalizeReplacements(
  replacements: ReplaceListOp["replacements"]
): Array<[string, string]> {
  if (Array.isArray(replacements)) {
    return replacements
      .filter((r) => r && typeof r.from === "string")
      .map((r) => [r.from, typeof r.to === "string" ? r.to : ""]);
  }
  if (replacements && typeof replacements === "object") {
    return Object.entries(replacements).map(([from, to]) => [
      from,
      typeof to === "string" ? to : String(to),
    ]);
  }
  return [];
}

function replaceList(text: string, op: ReplaceListOp): string {
  let result = text;
  for (const [from, to] of normalizeReplacements(op.replacements)) {
    if (from && result.includes(from)) {
      // replaceAll semantics (byte-equivalent to String.prototype.replaceAll).
      result = result.split(from).join(to);
    }
  }
  return result;
}

function removeBetween(text: string, op: RemoveBetweenOp): string {
  const { start, end } = op;
  if (!start || !end) return text;
  const inclusive = op.inclusive !== false;
  let result = "";
  let cursor = 0;
  // Bounded loop over occurrences; each iteration advances `cursor`.
  while (cursor <= text.length) {
    const startIdx = text.indexOf(start, cursor);
    if (startIdx === -1) {
      result += text.slice(cursor);
      break;
    }
    const endIdx = text.indexOf(end, startIdx + start.length);
    if (endIdx === -1) {
      result += text.slice(cursor);
      break;
    }
    const endPos = endIdx + end.length;
    result += text.slice(cursor, inclusive ? startIdx : startIdx + start.length);
    cursor = inclusive ? endPos : endIdx;
  }
  return result;
}

function injectString(text: string, op: InjectOp): string {
  const key = op.idempotencyKey ?? op.text;
  if (op.position === "prepend") {
    if (key && text.startsWith(key)) return text;
    return op.text + text;
  }
  // append
  if (op.idempotencyKey ? text.includes(op.idempotencyKey) : text.endsWith(op.text)) return text;
  return text + op.text;
}

/** Apply a text-substitution op (everything except `inject`) to a plain string. */
function applyTextOp(text: string, op: RewriteOp): string {
  switch (op.kind) {
    case "strip_list_block":
      return stripListBlock(text, op);
    case "regex_replace":
      return regexReplace(text, op);
    case "replace_list":
      return replaceList(text, op);
    case "remove_between":
      return removeBetween(text, op);
    case "inject":
      return injectString(text, op);
    default:
      return text;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Block-aware target application (never stringify; preserve cache_control+order)
// ────────────────────────────────────────────────────────────────────────────

function injectBlockArray(blocks: ContentBlock[], op: InjectOp): ContentBlock[] {
  const key = op.idempotencyKey ?? op.text;
  const alreadyPresent = blocks.some(
    (b) => isTextBlock(b) && (key ? b.text.startsWith(key) : b.text === op.text)
  );
  if (alreadyPresent) return blocks;
  const block: ContentBlock = { type: "text", text: op.text };
  return op.position === "prepend" ? [block, ...blocks] : [...blocks, block];
}

/** Map only `text` blocks; clone via `{...block, text}` so cache_control etc. survive. */
function applyTextOpToBlocks(blocks: ContentBlock[], op: RewriteOp): ContentBlock[] {
  return blocks.map((block) => {
    if (!isTextBlock(block)) return block; // image/tool_use/tool_result/thinking untouched
    return { ...block, text: applyTextOp(block.text, op) };
  });
}

function applyToSystemField(system: unknown, op: RewriteOp): unknown {
  if (system === null || system === undefined) {
    // Only `inject` can materialize a system field out of nothing.
    return op.kind === "inject" ? injectBlockArray([], op) : system;
  }
  if (typeof system === "string") {
    // Preserve the original string shape for pure text substitutions.
    return applyTextOp(system, op);
  }
  if (Array.isArray(system)) {
    return op.kind === "inject"
      ? injectBlockArray(system as ContentBlock[], op)
      : applyTextOpToBlocks(system as ContentBlock[], op);
  }
  return system;
}

function applyToMessageContent(
  content: string | ContentBlock[] | undefined,
  op: RewriteOp
): string | ContentBlock[] | undefined {
  if (typeof content === "string") {
    return applyTextOp(content, op);
  }
  if (Array.isArray(content)) {
    return op.kind === "inject" ? injectBlockArray(content, op) : applyTextOpToBlocks(content, op);
  }
  return content;
}

function ruleLabel(rule: MessageRewriteRule, index: number): string {
  return rule.id || `${rule.op?.kind ?? "?"}#${index}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Hooks
// ────────────────────────────────────────────────────────────────────────────

/**
 * PRE-SOURCE hook. Rewrites the source Claude-shaped `body` in place (matching
 * the in-place mutation model of `translateRequest`). Rules with
 * `phase:"pre_source"`. No-match ⇒ `body` returned untouched.
 */
export function applyPreSourceRewrites(
  ctx: RewriteContext,
  body: RewriteBody,
  rules: MessageRewriteRule[] | undefined
): RewriteBody {
  if (!body || typeof body !== "object") return body;
  const applicable = selectRules(rules, ctx, "pre_source");
  applicable.forEach((rule, index) => {
    try {
      if (rule.target.kind === "system_field") {
        if (body.system !== undefined || rule.op.kind === "inject") {
          body.system = applyToSystemField(body.system, rule.op);
        }
      } else if (Array.isArray(body.messages)) {
        const role = rule.target.role;
        for (const msg of body.messages) {
          if (msg && msg.role === role) {
            msg.content = applyToMessageContent(msg.content, rule.op);
          }
        }
      }
    } catch (error) {
      logOnce(ruleLabel(rule, index), error);
    }
  });
  return body;
}

/**
 * POST-TARGET hook. Rewrites the built target Claude-shaped `result` in place
 * (chiefly `result.system`). Rules with `phase:"post_target"`. No-match ⇒
 * `result` returned untouched. Keyed by the caller on `targetFormat === CLAUDE`.
 */
export function applyPostTargetRewrites(
  ctx: RewriteContext,
  result: RewriteBody,
  rules: MessageRewriteRule[] | undefined
): RewriteBody {
  if (!result || typeof result !== "object") return result;
  const applicable = selectRules(rules, ctx, "post_target");
  applicable.forEach((rule, index) => {
    try {
      if (rule.target.kind === "system_field") {
        if (result.system !== undefined || rule.op.kind === "inject") {
          result.system = applyToSystemField(result.system, rule.op);
        }
      } else if (Array.isArray(result.messages)) {
        const role = rule.target.role;
        for (const msg of result.messages) {
          if (msg && msg.role === role) {
            msg.content = applyToMessageContent(msg.content, rule.op);
          }
        }
      }
    } catch (error) {
      logOnce(ruleLabel(rule, index), error);
    }
  });
  return result;
}
