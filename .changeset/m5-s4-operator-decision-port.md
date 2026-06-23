---
"@buildplane/kernel": minor
"@buildplane/storage": minor
---

Add the M5-S4 operator-decision port and reconciler. `OperatorDecisionPort` +
`recordOperatorDecision` validate (D5), emit + flush the signed
`operator_decision_recorded` write-ahead (D1, `merge_commit` absent in the live
path), mirror it to Tier-1, then apply the side effect (resume/reject/merge/
quarantine) and mark it executed. `recoverPendingDecisions` re-drives a
decided-but-unexecuted side effect exactly once (D2/D4) — gated on the Tier-1
execution marker, never re-emitting Tier-2 and never double-merging. Adds the
storage anchors `recordOperatorDecisionShadow` / `markOperatorDecisionExecuted` /
`listDecidedUnexecutedDecisions` / `rejectMergeDecision`.
