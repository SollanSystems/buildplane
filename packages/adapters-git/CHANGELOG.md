# @buildplane/adapters-git

## 0.4.3

### Patch Changes

- @buildplane/kernel@0.8.2

## 0.4.2

### Patch Changes

- Updated dependencies [3c0c348]
  - @buildplane/kernel@0.8.1

## 0.4.1

### Patch Changes

- Updated dependencies [0f1b42e]
- Updated dependencies [fb96406]
  - @buildplane/kernel@0.8.0

## 0.4.0

### Minor Changes

- 6e6cf64: Add the M5-S4 operator-decision port and reconciler. `OperatorDecisionPort` +
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

### Patch Changes

- Updated dependencies [6e6cf64]
  - @buildplane/kernel@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [676ecda]
  - @buildplane/kernel@0.6.0

## 0.3.0

### Minor Changes

- a5de446: Serial worktree re-anchor (GAP-8): commitAndMergeWorkspace now returns the project-root post-merge HEAD ({ mergedHeadSha }), surfaced on RunPacketResult.mergedHeadSha so a serial loop driver anchors the next unit on the just-merged commit. prepareWorkspace now asserts the requested base commit resolves before cutting a worktree. Closes the PR #198 stale-base risk class for serial multi-unit runs.

### Patch Changes

- a5de446: add S7 crash recovery: `buildplane planforge recover` scans storage for orphaned `running` runs, replays the signed tape, and auto-resumes each dispatch (the tape is authoritative over the storage status field — recover re-runs the suffix and emits the receipt on the tape, never rewriting the `running` row). Adds `BuildplaneStoragePort.listRunsByStatus` and a `.buildplane/planforge/dispatch` manifest sidecar so recovery can map a `running` run back to its admitted `--input` plan, plus a `plan_receipt` dedup-on-append guard keyed on the deterministic tape run id (derived from `idempotency_key`) so a partial-flush crash cannot double-receipt on resume. The worktree clean-tree check now excludes `.buildplane/planforge/**` (ephemeral dispatch state, like `runs/**` and `ledger/**`).
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [716b8db]
  - @buildplane/kernel@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [4e29efd]
- Updated dependencies [2704f4f]
  - @buildplane/kernel@0.4.2

## 0.2.2

### Patch Changes

- @buildplane/kernel@0.4.1

## 0.2.1

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0

## 0.2.0

### Minor Changes

- b1b7842: M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
  gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
  on the packet + admission receipt and a verified worktree_clean git status.

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/kernel@0.2.0
