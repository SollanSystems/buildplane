---
"@buildplane/kernel": patch
---

fix(kernel): reject the acceptance gate when the worktree HEAD advances off the recorded base SHA

The M4 acceptance finalization gate diffs the worktree against `HEAD`. A worker (or an
unsandboxed check) that `git commit`s inside the detached worktree during execution
advances HEAD, so `git diff HEAD` reports an empty diff and the diff-scope arm would let a
committed — possibly out-of-scope — delta merge on a zero exit. The gate now compares the
live worktree HEAD against the immutable recorded base SHA and rejects fail-closed on any
advance, closing the diff-scope fail-open surfaced by the M4-S3 adversarial bypass review.
