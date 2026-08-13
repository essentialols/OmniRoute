# Local turn recovery

Detects and repairs "dead turns" from local model providers: responses that announce an action
("I'll search for that now") and then stop without ever producing the result.

Key files:

- `open-sse/services/localTurnRecovery.ts` (detector, fallback builder, event log)
- `open-sse/handlers/chatCore.ts` (`resolveLocalTurnRecoveryPlan`, and the non-streaming force)

## Current state, as of 2026-08-13

**The feature is DISABLED at runtime by an explicit env override**, not by missing code:

```
plutil -extract EnvironmentVariables.OMNIROUTE_LOCAL_TURN_RECOVERY raw \
  ~/Library/LaunchAgents/com.omniroute.gateway.plist
# -> 0
```

The fix is already deployed. The live checkout's `dist` contains it, and the running daemon came up
after that build. **There is no pending deploy.** Re-enabling is a flag flip plus a restart, nothing
more. Do not rebuild to "ship" this.

## Why it was disabled: the retry storm

The original incident looked like "nothing arrives in the client". The tempting diagnosis, that the
response is merely buffered and you should wait longer, is WRONG. What actually happened: the client
aborted (three requests with status 499 and `tokens_out 0`) and retried, and each retry re-prefilled
about 16,828 tokens.

Root cause was **not** the detector regex. It was that every streaming request to a local provider
was forced non-streaming at `chatCore.ts:2173-2175`:

```ts
if (localTurnRecoveryPlan.active) {
  translatedBody.stream = false;
  delete translatedBody.stream_options;
}
```

Buffering the whole upstream turn starves the client's progress watchdog, which then aborts.

`50c1e1f92` narrowed the gate so `active`, and therefore the non-streaming force, only fires when the
request declares a bridgeable tool (WebSearch / WebFetch). Measured in that commit: no-tool
time-to-first-byte fell from **12.80s to 1.74s**. Tool-bridge turns stay around 9.4s, which is
inherent: inspecting and executing tools server-side requires the full completion.

## Residual risk, not eliminated

Turns that DO declare a bridgeable tool are still forced non-streaming **by design**. A slow local
model on a tool-bridge turn can still exceed `STREAM_READINESS_TIMEOUT_MS` / `_MAX` (240s / 300s, set
in the plist) and retry-storm.

This is a narrower slice of traffic, not a removed failure mode. After re-enabling, watch TTFB and
timeout rates **on tool-bridge turns specifically**; aggregate numbers will hide it.

## The false-positive fixes layered on top

Three later commits fix a compounding bug: false-positive dead-turn detection on long, healthy
tool-bridge turns. That wasted an extra resample, which made an already-buffered wait longer, and
then **overwrote 200 tokens of good output with a 12-word apology**.

- `7a89cb374` Stop discarding correct local answers as fabrication
- `f051dd916` Never destroy a successful turn when the rescue fails
- `47563edac` Record dead-turn classifications to disk so the branch is knowable

Two invariants came out of this, both load-bearing:

1. `localTurnRecovery.ts:283` requires **both** `ANNOUNCE_RE` and `RESULTS_CLAIM_RE`. `ANNOUNCE_RE`
   alone over-fires: a long, correct answer whose last sentence happens to announce something was
   being classified as a dead turn.
2. `buildTerminalFallback(resp, originalTurn?)` (around line 574) prefers the original content, then
   `reasoning_content`, and only then the canned text. Never emit canned text over real output.

### The event log uses a DYNAMIC IMPORT on purpose

`recordRecoveryEvent()` writes JSON lines to `~/.omniroute/local-recovery.log`. It uses
`await import(...)`, not `require`. An earlier version used `require`, which is **undefined under
ESM**, so it threw silently and recorded nothing while appearing to work.

If you touch that function, keep the dynamic import, and keep the test that asserts the log file
actually grows. "It didn't crash" is not evidence that it wrote.

## Tests

```
npx vitest run tests/unit/local-turn-recovery.test.ts    # 47/47
```

Oracle-verified: reverting line 283 to `ANNOUNCE_RE.test(norm)` alone produces exactly two failures,
`"LONG planning prose that announces actions is NOT a dead turn, tool available"` and
`"a LONG correct answer whose last sentence announces is NOT a dead turn"`, both reproducing the
historical incident. Restore, and 47/47 is green again.

Fixtures must be **over 500 characters**. An earlier round of regression tests used sub-500-char
fixtures, which hit a different branch entirely and proved nothing.

Note: this suite appends real lines to the live `~/.omniroute/local-recovery.log`, by design, because
the test targets that exact path.

## Enabling and rolling back

`kickstart -k` alone will NOT pick up a plist env change on an already-loaded job. You need
bootout plus bootstrap:

```
plutil -replace EnvironmentVariables.OMNIROUTE_LOCAL_TURN_RECOVERY -string 1 ~/Library/LaunchAgents/com.omniroute.gateway.plist && launchctl bootout gui/$(id -u)/com.omniroute.gateway; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omniroute.gateway.plist
```

Roll back with the same command and `-string 0`.

### ROLLBACK TRAP

Do **not** roll back by restoring `com.omniroute.gateway.plist.bak-20260813-071721`. That backup has
no `OMNIROUTE_LOCAL_TURN_RECOVERY` key at all, which means the **code default of enabled** applies.
Restoring it does the exact opposite of a safe rollback. Always set the key explicitly to `0`.

### Restarting :20128 has a blast radius

Port 20128 is the proxy chain that local Claude Code sessions ride on. A bootout/bootstrap drops
in-flight requests and can kill other people's running sessions mid-task. Coordinate before flipping
the flag; the disabled state is stable, so there is rarely any urgency.

## Build note

`npm run build:release` currently exits 1 at an unrelated, pre-existing step:
`@omniroute/opencode-plugin` fails `npm install --allow-scripts` with `EALLOWSCRIPTS` under
npm 11.19.0. The same failure appears in build logs from 2026-08-12. The Next.js standalone build
completes cleanly before that step, but `write-build-sha.mjs` is chained after it and so never runs.
Run it manually if you need `dist/BUILD_SHA` stamped; its own guard requires the standalone dir to
exist, so it cannot stamp a build that did not happen.

To verify a deployed bundle, grep for a **string literal** that survives minification, such as
`local-recovery.log`. Identifier names like `originalTurn` are minified away and are useless as
deployment markers.
