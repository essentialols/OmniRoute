const CLAUDE_CODE_COMPATIBLE_BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
];

export const CLAUDE_CODE_COMPATIBLE_REDACT_THINKING_BETA = "redact-thinking-2026-02-12";

export type ClaudeCodeCompatibleBetaOptions = {
  redactThinking?: boolean;
};

export function resolveClaudeCodeCompatibleAnthropicBeta(
  options: ClaudeCodeCompatibleBetaOptions = {}
): string {
  const betas = [...CLAUDE_CODE_COMPATIBLE_BASE_BETAS];
  if (options.redactThinking === true) {
    betas.push(CLAUDE_CODE_COMPATIBLE_REDACT_THINKING_BETA);
  }
  return betas.join(",");
}

export const CLAUDE_CODE_COMPATIBLE_ANTHROPIC_BETA = resolveClaudeCodeCompatibleAnthropicBeta();
