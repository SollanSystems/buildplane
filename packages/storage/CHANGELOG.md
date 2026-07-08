# @buildplane/storage

## 0.4.2

### Patch Changes

- 3c0c348: fail-close PlanForge `resume`/`recover` on unverified recorded work (M6-F1).

  Crash recovery was receipt-grade, not pipeline-grade: `resume`/`recover` executed the
  remaining suffix with ZERO acceptance machinery and counted every recorded-prefix
  activity as `passed` without checking that acceptance ever evaluated, then minted a
  `completed` receipt — a fail-open on the product's core trust surface.

  Now the resumed suffix runs under acceptance enforcement equivalent to `dispatch`
  (per-task `deriveAcceptanceContract` profiles + `profileRegistry`, a per-task-identity
  `acceptancePort`, `resultReadyPort`, and provisioned worktree deps), and a recorded
  activity only counts toward a `completed` receipt when the tape carries a matching
  signed `acceptance_recorded` verdict (`plan_id` + `admission_event_id` + the re-derived
  `contract_digest` + `outcome == "passed"`). Passed verdicts are consumed once, counted as
  a multiset keyed by `contract_digest`: because the digest intentionally excludes the task
  id, sibling tasks with identical allowed-side-effects + verification-commands share a
  digest, so N recorded-passed tasks with digest D require N distinct passed verdicts for D —
  one verdict can never clear a sibling task whose acceptance never ran. Missing/rejected
  evidence, with enforcement
  on, fail-closes: receipt outcome `failed`, exit 1, and a machine-readable per-task reason
  `acceptance-not-evaluated` in both the JSON output and the receipt's committed result.

  Enforcement is ON by default for both `resume` and `recover`; a new
  `--no-enforce-acceptance` flag opts out. The decision comes only from the CLI flag —
  never the unsigned dispatch-manifest sidecar. At the terminal receipt (and in the
  `already_receipted` short-circuit) the orphaned `running` storage rows are reconciled to
  a terminal status consistent with the outcome (new
  `BuildplaneStoragePort.reconcilePlanForgeDispatchRuns`), closing the M2 "receipt on tape
  but running in storage → reconcile" line and making a second `recover` pass report
  `no_orphans`. Recorded-prefix reused runs still get no synthetic `result_ready` — only
  executed-suffix packets emit it via the threaded ports, exactly as dispatch does.

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
