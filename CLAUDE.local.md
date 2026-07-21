# OmniRoute (this fork): Operational Learnings and Pitfalls

Local, proprietary companion to `CLAUDE.md`. Read this BEFORE operating or patching the
running daemon. Scope: the private fork at `~/Documents/GitHub/OmniRoute` (branch
`feat/codex-passthrough-impl`), served by the launchd daemon `com.omniroute.gateway` on
`http://localhost:20128`. Sources: `~/.claude/skills/omniroute-maintain/SKILL.md`,
`~/.omniroute/OMNIROUTE_SETUP.md`, `~/.omniroute/PROXY_MISCONFIG_REGRESSION_2026-07-14.md`,
omniroute memory files, the repo `CLAUDE.md`, protected-ledger, plus live verification.

## 0. USER POLICY: this is a PROPRIETARY fork (read first)

- **This fork is proprietary. Push to `origin` (`essentialols/OmniRoute`) ONLY. NEVER open an
  upstream PR to `diegosouzapw`.** The repo has an `upstream` remote
  (`github.com/diegosouzapw/OmniRoute`) configured, which makes accidental upstream PRs easy.
  Do local daemon operation and private patches only. (Verified 2026-07-20: zero PRs have ever
  been opened to `diegosouzapw`; all 18 OmniRoute PRs target `essentialols/OmniRoute`, and the
  account has read-only access to upstream.)
- **All the PR-campaign / release-freeze / VPS-validation machinery in the repo `CLAUDE.md`**
  (Hard Rules #18, #21, the `diegosouzapw` VPS `192.168.0.15`, `/generate-release`,
  `/port-upstream-*`) is UPSTREAM-oriented and does NOT apply to local operation. Ignore it here.
- **Non-private gateway.** Per protected-ledger (`~/.claude/protected-ledger.d/m2-mbp.yml`, entry
  `omniroute-gateway`): opt-in only and NON-PRIVATE (prompts leave the machine). NEVER point the
  main Anthropic session at it; only the sandbox `cc-sbx` instance and specific relay/`re-*`
  focused-agents route through it. No PII, credentials, dissertation, or work data through
  OmniRoute. Do not stop/unload the daemon without approval (hook-enforced).

## 1. How the daemon loads code: editing source is INERT without a rebuild

- **The daemon serves a BUNDLED build, not loose `.ts` source.** Launched via `bin/omniroute.mjs
serve` to `serve.mjs` which spawns `dist/server-ws.mjs`; the request-handling Next.js app runs
  from webpack/turbopack chunks in `dist/.build/next/server/chunks/*.js`, NOT `open-sse/**.ts` or
  the loose `dist/open-sse/*.ts` copies. **Editing loose source is INERT until you rebuild.**
  (Incident 2026-07-14: a `chrome_124` to `chrome_142` tlsClient edit looked applied but was inert
  because only the `.ts` was changed.)
- **Rebuild (two-step, verified working 2026-07-20):**
  ```
  cd ~/Documents/GitHub/OmniRoute
  npm run build       # regenerates .build/next/standalone (Next 16 standalone; slow, memory-heavy, ~5 min)
  npm run build:cli   # assembles dist/ from the standalone
  launchctl kickstart -k gui/$(id -u)/com.omniroute.gateway   # only after build succeeds
  ```
  (A `npm run build:release` shortcut appears in one memory note; the two-step above is the
  documented, verified path. Prefer it unless you confirm the shortcut.)
- **`npm run build:cli` exits non-zero at the `opencode-plugin` step under `--allow-scripts`
  (`EALLOWSCRIPTS`), but this is NON-FATAL:** the standalone-to-dist assembly steps complete FIRST
  and are what matter. Do not treat that non-zero exit as a failed build.
- **Verify a code change landed in the served bundle:** `grep -rl "<your token>"
dist/.build/next/server/chunks/`. Incremental builds can leave STALE duplicate chunks; the live
  one is whatever the target route's `route.js`/`.nft.json` pulls.
- **DB/config values do NOT need a rebuild.** `proxy_enabled`, `quota_snapshots`, credentials, and
  feature flags in `storage.sqlite` are read at runtime. Only CODE changes require a rebuild.
- **Build gotchas (learned the hard way):** (1) NEVER add `./.build/**/*` to `next.config.mjs`
  `outputFileTracingExcludes`, `.build` IS the distDir, so excluding it strips runtime deps and
  every route 500s; only `./dist/**/*` is safe. (2) The daemon branch can regrow a `dist/dist`
  recursion on rebuild until rebased onto release; clean with `rm -rf dist/dist`. (3)
  `feat/codex-passthrough-impl` has DIVERGED from `release/v3.8.47`.
- **Build is memory-heavy (OOM-prone on 32GB).** Check free RAM first; ensure any worktree lives
  under `.claude/worktrees/` (excluded from build scope) so `tsconfig`'s `**/*` glob does not
  balloon the build (incident 2026-06-25).

## 2. The golden reconcile command

- **After ANY update, deletion, or weird state:** `~/.omniroute/bin/omniroute-reconcile.sh`. It
  re-asserts every fix and only restarts if needed (never opens a browser, never loops).
- **What it restores:** the start wrapper (orphan reaping + port free), `serve --no-open`, the
  hardened gateway + watchdog plists, the guardrail feature flags (step 10), and stale-quota
  clearing (step 11 calls `clear-stale-quota.sh`). Its gateway-plist heredoc sets
  `PII_REDACTION_ENABLED=true`, `INPUT_SANITIZER_MODE=redact`, and
  `STREAM_READINESS_TIMEOUT_MS=240000` / `STREAM_READINESS_MAX_TIMEOUT_MS=300000` as daemon env.

## 3. Codex passthrough specifics

- **`CODEX_CLIENT_VERSION` in `~/.omniroute/.env` must match the installed `codex --version`, or
  new models 400 with "upgrade Codex".** Incident 2026-07-20: env was stale at `0.142.5` while
  installed was `0.144.6`, which blocked `gpt-5.6-sol`; bumping the env value and reloading fixed
  it. When Codex updates, bump this env var and kickstart the daemon.
- **`.env` is secret-bearing** (`STORAGE_ENCRYPTION_KEY` etc.) and is hook-blocked from being read
  wholesale into context. Grep only the specific non-secret key you need (e.g.
  `grep CODEX_CLIENT_VERSION ~/.omniroute/.env`). To edit one known line without reading the file,
  use a targeted `sed` on the exact line.
- **Native `claude` passthrough forwards the client's real identity**, so a plain curl with forged
  CC headers gets throttled/rejected regardless. Only a real Claude Code client tests that path.

## 4. Recurring incident classes and their fixes

- **Stale quota snapshots: DO NOT trust OmniRoute's "exhausted" 429 as real.** OmniRoute caches
  per-model `is_exhausted` in `quota_snapshots`; it goes stale/spurious and falsely gates a
  provider that still has quota (esp. antigravity/agy). VERIFY against the real account first (the
  provider's own CLI/dashboard). Incident 2026-07-14: agy CLI showed Claude/GPT at 100% and Gemini
  98% while OmniRoute 429'd all. Fix: `~/.omniroute/bin/clear-stale-quota.sh` then kickstart
  (reconcile runs it as step 11); clearing is safe because real exhaustion just re-reports 429 on
  the next upstream call. Distinguish from antigravity's real per-model ~5h capacity window
  (`"reset after 4h55m"`, often self-inflicted by test traffic), which self-resets and is separate
  from the weekly quota.
- **`proxy_enabled=1` with an EMPTY proxy pool causes Cloudflare 403s.** Cloudflare-fronted
  providers (groq, cerebras, publicai, oc, tllm) return intermittent `403`/`upstream_403` after a
  migration/fresh setup because connections route through a non-existent proxy. Root cause
  (2026-07-14): the M1 to M2 migration copied connections with `proxy_enabled=1` but did not
  migrate the proxy pool. Diagnose: `sqlite3 ~/.omniroute/storage.sqlite "select count(*) from
provider_connections where proxy_enabled=1;"` and confirm `select count(*) from proxy_registry;`
  = 0. Fix: `UPDATE provider_connections SET proxy_enabled=0 WHERE proxy_enabled=1;` then
  kickstart. Cold-start artifact: the first request(s) after kickstart can still 403, then warm to
  100%. Full write-up: `~/.omniroute/PROXY_MISCONFIG_REGRESSION_2026-07-14.md`.
- **Browser windows spawning every few seconds:** a crash-loop opening the dashboard (orphan
  holding port 20128, or a plist missing `--no-open`/throttle). Fix: `pkill -9 -f omniroute` then
  reconcile.
- **`EADDRINUSE` on start:** stale instance on the port; the start wrapper reaps it, reconcile if
  the wrapper is missing.
- **Daemon won't `bootstrap` (`Input/output error`):** it was disabled via `unload -w`. Fix:
  `launchctl enable gui/$(id -u)/com.omniroute.gateway` then bootstrap; kill stray procs first.
- **Hung but "running":** the watchdog (`com.omniroute.watchdog`) kickstarts after 2 failures;
  force now with `kickstart -k`.
- **npm update leaves native modules unbuilt:** npm 11 blocks install scripts by default;
  `~/.npmrc` `allow-scripts` makes `npm update -g omniroute` rebuild `better-sqlite3`/
  `tls-client-node` automatically. Without it the daemon crashes after update.

## 5. Guardrails are global feature flags re-asserted by reconcile

- Guardrails (PII / prompt-injection / TLS-stealth) are **feature flags**: rows in
  `storage.sqlite` table `key_value` (namespace `feature_flags`), read per-request (precedence: DB
  override, then `process.env`, then default), NOT a REST resource. They are GLOBAL (every outbound
  provider) and PERSIST across `npm update`.
- Reconcile step 10 asserts: `INPUT_SANITIZER_ENABLED=true`, `INJECTION_GUARD_MODE=warn`,
  `PII_REDACTION_ENABLED=true`, `PII_RESPONSE_SANITIZATION=true`,
  `PII_RESPONSE_SANITIZATION_MODE=redact`, `ENABLE_TLS_FINGERPRINT=true`.
- **CRITICAL: the request-side PII masker (`src/lib/guardrails/piiMasker.ts`) reads `process.env`
  directly, not the DB flag.** So `PII_REDACTION_ENABLED=true` + `INPUT_SANITIZER_MODE=redact` are
  ALSO set in the gateway plist `EnvironmentVariables`. Changing these requires a full daemon
  reload (bootout + bootstrap) to re-read env, not just a `kickstart`. Response-side PII flags are
  per-request (no restart).
- To change a flag: `sqlite3 ~/.omniroute/storage.sqlite "INSERT OR REPLACE INTO
key_value(namespace,key,value) VALUES('feature_flags','<KEY>','<VALUE>');"` then reload.
- Repo Hard Rule #20 keeps the two data-mutating PII flags `defaultValue:"false"` (opt-in). This
  deployment opts IN via env + DB override; do not change those upstream defaults in code.

## 6. 2026-07-20: dual-purpose image/chat model-id collision

- **Some model ids are registered as BOTH image and chat models:** `codex/gpt-5.5`, plus
  `antigravity/gemini-3.1-flash-image`, `haiper/gen2`, `leonardo/phoenix`, `leonardo/sdxl`,
  `ideogram/V_3`, `ideogram/V_2A`. The #6457 chat guard used a plain `getImageModelEntry()`
  truthiness check, so it wrongly 400'd these on `/v1/chat/completions` with "is an
  image-generation model". Only bare `codex/gpt-5.5` matters for Codex; the reasoning-suffixed
  variants (`gpt-5.5-high`, `-xhigh`, `gpt-5.6-sol`, ...) were never affected.
- **Fix (commit `0b2cd8865`):** added `isImageOnlyModel()` in `open-sse/config/imageRegistry.ts`
  (true only when a model is image-registered AND not also a curated chat model for its provider),
  and switched the guard in `src/sse/handlers/chat.ts` to use it. Regression tests:
  `tests/unit/chat-rejects-image-only-model.test.ts` + `tests/unit/image-only-dual-purpose-model.test.ts`.
- **Note the two chat-handler trees:** the actually-served handler is `src/sse/handlers/chat.ts`.
  The repo `CLAUDE.md` request-pipeline diagram points at `open-sse/handlers/chatCore.ts`; both
  trees exist, so verify which path your edit actually lands in before rebuilding.

## 7. Dev-process gotchas when patching THIS daemon

- **Worktree isolation is MANDATORY (repo Hard Rule #19).** Never develop on the shared main
  checkout; a `git checkout`/branch switch there silently discards other sessions' uncommitted
  work. Every task gets its own worktree under `.claude/worktrees/` and nowhere else (that path is
  gitignored and in the `tsconfig`/`.dockerignore` excludes; a worktree elsewhere escapes
  build-scope excludes and OOMs `next build`). To update the DAEMON, the fix must land on
  `feat/codex-passthrough-impl` in the MAIN checkout (the daemon serves that checkout's `dist/`),
  so develop in a worktree, then fast-forward-merge into `feat/codex-passthrough-impl` in the main
  checkout and rebuild there. Check `git worktree list` first and leave other sessions' worktrees
  (e.g. `stealth-staging`) untouched.
- **NEVER `git stash` / `git stash pop` anywhere in this repo (Hard Rule #22a),** including inside a
  worktree or a dispatched subagent. It operates on the shared object store and can clobber another
  session's changes (incident 2026-07-02). To compare against a base ref without stashing:
  `git show <ref>:<path>` or `git diff <ref> -- <path>`. Put this ban verbatim in any git-touching
  subagent prompt.
- **The em/en-dash PreToolUse hook HARD-BLOCKS edits containing an em dash or en dash.** Use plain
  punctuation (comma/period/parens, "to", or a hyphen) in all code, comments, and commit text.
- **No AI attribution in commits/PRs (Hard Rule #16, and the user's global no-coauthorship rule).**
  No `Co-Authored-By` naming an AI/bot, no "Generated with Claude Code" footers anywhere. Strip any
  harness-appended footer before committing.
- **Both test runners cover non-overlapping files:** `npm run test:unit` (Node native) AND
  `npm run test:vitest` (MCP/autoCombo/cache) must both pass; green on only one can silently ship
  broken MCP tools or routing regressions.

## 8. Quick ops reference

- **Health:** `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:20128/v1/models` (200 =
  ok). Crash-loop check: `launchctl print gui/$(id -u)/com.omniroute.gateway | grep -E
'state|runs|pid'` (`runs` climbing = looping).
- **Restart cleanly:** `launchctl kickstart -k gui/$(id -u)/com.omniroute.gateway`. **Diagnose:**
  `omniroute doctor`.
- **Logs:** `tail ~/.omniroute/daemon.log ~/.omniroute/daemon.err.log ~/.omniroute/watchdog.log`.
- **Acceptance harness (8 checks, briefly disrupts daemon):**
  `~/.omniroute/bin/test-omniroute-hardening.sh`.
- **Admin token:** Bitwarden item "Omni Route API Key" (`sk-...`); the server already knows it (do
  not re-install on update).
- **Test a provider with a real, varied prompt to a SPECIFIC model** (e.g. `cc/claude-sonnet-5`,
  `cx/gpt-5.5`), never `auto` (routes elsewhere) and never cliche filler ("say pong", "test 123").
- **24/7 raw capture** is on (`OMNIROUTE_RAWCAP=1`): 4 correlated JSONL legs per request under
  `~/.omniroute/captures/<provider>/<date>.jsonl`, PII-redacted, binaries placeholdered. Useful for
  reconstructing what model/version was actually sent upstream.
- **Non-versioned config lives outside git:** custom system prompts
  `~/.omniroute/system-prompts/{ornith,gemma}.md` synced into `~/.omniroute/messageRewriteRules.json`.
  Back up before editing; not recoverable from any repo.
