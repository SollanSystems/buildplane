# @buildplane/adapters-git

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
