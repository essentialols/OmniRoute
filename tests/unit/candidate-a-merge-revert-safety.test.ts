import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tripwire: revert-safety rehearsal for the candidate A merge
// (fix/codex-responses-commentary-translation, merge commit
// c6c49333663328ae416ddb1b34c8c45c0d8c1095). Pushing this repo auto-fast-forwards
// into a live gateway deploy, so before it ships we must know the rollback
// actually works, not just assume it does. "A revert nobody has rehearsed is
// not a rollback plan."
//
// This test performs the REAL rehearsal (`git revert --no-commit -m 1 <sha>`)
// against a disposable git worktree checked out from THIS repo's own object
// store, so it is:
//   - safe to run repeatedly (creates and destroys its own temp worktree
//     every time, never touches the caller's working tree or branch)
//   - a true rehearsal (runs the actual git revert machinery, not a simulation)
//   - fast (no npm install / build; it only proves the revert applies
//     cleanly at the git level, which is the load-bearing question: the
//     merge is two files with clean adds, so no other file can conflict)
//
// If this test ever goes RED, treat it as "the rollback plan is broken" and
// investigate before relying on `git revert -m 1` under pressure.

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Candidate A merge commit under test. Update this if the candidate is
// re-merged with a different SHA.
const MERGE_SHA = "c6c49333663328ae416ddb1b34c8c45c0d8c1095";
// This file is a brand-new addition of the merge (git diff --numstat shows
// 157/0): after a clean revert it must be gone entirely.
const MERGE_NEW_FILE = "tests/unit/responses-commentary-phase-leak-translation.test.ts";
// This file is modified by the merge (+27/-0 in an existing file): after a
// clean revert its wiring for the new drop call must be gone.
const MERGE_MODIFIED_FILE = "open-sse/translator/response/openai-responses.ts";
const MERGE_MODIFIED_FILE_MARKER = "shouldDropResponsesCommentaryEvent";

function isMergeCommitReachable() {
  try {
    execFileSync("git", ["cat-file", "-e", `${MERGE_SHA}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    execFileSync("git", ["merge-base", "--is-ancestor", MERGE_SHA, "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

test("candidate A merge can be reverted cleanly with `git revert -m 1`", (t) => {
  if (!isMergeCommitReachable()) {
    t.skip(
      `merge ${MERGE_SHA} is not reachable from HEAD in this checkout; skipping (not a rehearsal failure)`
    );
    return;
  }

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-a-revert-rehearsal-"));
  const worktreeDir = path.join(tmpParent, "wt");
  let worktreeAdded = false;

  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreeDir, MERGE_SHA], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    worktreeAdded = true;

    // The actual rehearsal: does the exact documented rollback command apply
    // without conflict?
    let revertError = null;
    try {
      execFileSync("git", ["revert", "--no-commit", "-m", "1", MERGE_SHA], {
        cwd: worktreeDir,
        stdio: "pipe",
      });
    } catch (err) {
      revertError = err;
    }

    assert.equal(
      revertError,
      null,
      `git revert -m 1 ${MERGE_SHA} did not apply cleanly: ${revertError?.stderr?.toString() ?? revertError?.message}`
    );

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreeDir,
      encoding: "utf8",
    });
    assert.ok(!/^(UU|AA|DD) /m.test(status), `revert left unmerged/conflicted paths:\n${status}`);

    // Confirm it actually undid the merge's changes (proves the revert did
    // real work, not a vacuous no-op).
    assert.ok(
      !fs.existsSync(path.join(worktreeDir, MERGE_NEW_FILE)),
      `revert did not remove ${MERGE_NEW_FILE}, which the merge added`
    );
    const modifiedFileContents = fs.readFileSync(
      path.join(worktreeDir, MERGE_MODIFIED_FILE),
      "utf8"
    );
    assert.ok(
      !modifiedFileContents.includes(MERGE_MODIFIED_FILE_MARKER),
      `revert did not undo the merge's wiring in ${MERGE_MODIFIED_FILE}`
    );
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
      } catch {
        // best-effort; fall through to prune below
      }
    }
    try {
      fs.rmSync(tmpParent, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      // best-effort
    }
  }
});
