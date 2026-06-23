# @buildplane/storage

## 0.3.1

### Patch Changes

- Updated dependencies [676ecda]
  - @buildplane/kernel@0.6.0

## 0.3.0

### Minor Changes

- a5de446: add S7 crash recovery: `buildplane planforge recover` scans storage for orphaned `running` runs, replays the signed tape, and auto-resumes each dispatch (the tape is authoritative over the storage status field — recover re-runs the suffix and emits the receipt on the tape, never rewriting the `running` row). Adds `BuildplaneStoragePort.listRunsByStatus` and a `.buildplane/planforge/dispatch` manifest sidecar so recovery can map a `running` run back to its admitted `--input` plan, plus a `plan_receipt` dedup-on-append guard keyed on the deterministic tape run id (derived from `idempotency_key`) so a partial-flush crash cannot double-receipt on resume. The worktree clean-tree check now excludes `.buildplane/planforge/**` (ephemeral dispatch state, like `runs/**` and `ledger/**`).
- 716b8db: add the Mission Control storage read surface and the Tier-1 acceptance shadow. `listRunsByStatus` now returns a paginated `RunPage` (array carrying an opaque `cursor`) with `limit`/`cursor` support; `recordAcceptanceShadow` writes the additive `runs.acceptance_outcome` column from the M4 acceptance path; `listPendingOperatorDecisions` returns the operator inbox feed (suspended runs as `resume`, accepted-undecided runs as `merge`, excluding runs with an `operator_decision_recorded` event). `parentRunId` is now threaded through `toRun` → `inspectTarget` → `InspectSnapshot.run`.

### Patch Changes

- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [716b8db]
  - @buildplane/kernel@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [4e29efd]
- Updated dependencies [2704f4f]
  - @buildplane/kernel@0.4.2

## 0.2.3

### Patch Changes

- @buildplane/kernel@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0

## 0.2.0

### Minor Changes

- c24dae5: S4: append-only run_outcomes write path

  Adds the layer-5 outcome-memory write path: a new append-only `run_outcomes`
  table (one row per finished run, with a `(repo_id, source_run_id)` unique index
  for idempotency), `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome` types,
  idempotent `appendRunOutcome`/`listRunOutcomes` on `BuildplaneStoragePort`, and a
  recorder at `finalizeRun` that appends each model run's `(taskType, worker,
success)`. Model packets only (`packet.model !== undefined`); command/non-model
  packets and executor infra-crashes append no row. No routing behavior changes —
  a write-only outcome row is added per in-scope terminal run.

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/kernel@0.2.0
