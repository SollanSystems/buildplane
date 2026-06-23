---
"@buildplane/kernel": minor
"@buildplane/storage": minor
"@buildplane/adapters-git": minor
---

Add the M5-S4 operator-decision port and reconciler. `OperatorDecisionPort` +
`recordOperatorDecision` validate before sign (D5/F2/F3/F7: strict RFC3339, a
present `mergeCommit` rejected in the live path, and a merge decision only
signable when acceptance passed AND a retained worktree exists), fail closed
when no port is present (F4), emit + flush the signed `operator_decision_recorded`
write-ahead (D1, `merge_commit` absent in the live path), mirror it to Tier-1,
then apply the side effect (resume/reject/merge/quarantine) and mark it executed.
`recoverPendingDecisions` re-drives a decided-but-unexecuted side effect exactly
once (D2/D4) — a marker check-and-claim gates each side effect, never re-emitting
Tier-2. The crash-after-merge-before-marker double-merge window is closed at two
layers: `@buildplane/adapters-git` `commitAndMergeWorkspace` is now idempotent by
runId (it detects this run's prior merge commit in the project git history and
returns its SHA without creating a second merge), and the orchestrator
check-and-claims the execution marker before each side effect. Adds the storage
anchors `recordOperatorDecisionShadow` / `markOperatorDecisionExecuted` /
`isOperatorDecisionExecuted` / `getRunAcceptanceOutcome` /
`listDecidedUnexecutedDecisions` (now one row per run) / `rejectMergeDecision`,
and excludes decided suspended runs from `listPendingOperatorDecisions` (F6).
