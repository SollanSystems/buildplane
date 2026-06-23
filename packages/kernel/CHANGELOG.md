# @buildplane/kernel

## 0.6.0

### Minor Changes

- 676ecda: Add createInspectorProjection / InspectorProjection to @buildplane/kernel (extracted from apps/cli, retyped against the strict InspectSnapshot).

## 0.5.0

### Minor Changes

- a5de446: GAP-10: authorization envelope. Add `AuthorizationEnvelopeV0` + `EnvelopeProposal` policy vocabulary, a pure `evaluateEnvelopeAdmission` subset-admission gate, a canonical envelope digest + canonical-JSON, and carry the `authorize-envelope` subject + `envelope` field on the `operator_decision_recorded` ledger payload. The capability broker now denies a worker-binary (`claude`) `run_command` invocation that carries a permission-escape flag (e.g. `--dangerously-skip-permissions`), closing the GAP-4 carry-forward where argv0/prefix matching ignored args.
- a5de446: add S7 crash recovery: `buildplane planforge recover` scans storage for orphaned `running` runs, replays the signed tape, and auto-resumes each dispatch (the tape is authoritative over the storage status field — recover re-runs the suffix and emits the receipt on the tape, never rewriting the `running` row). Adds `BuildplaneStoragePort.listRunsByStatus` and a `.buildplane/planforge/dispatch` manifest sidecar so recovery can map a `running` run back to its admitted `--input` plan, plus a `plan_receipt` dedup-on-append guard keyed on the deterministic tape run id (derived from `idempotency_key`) so a partial-flush crash cannot double-receipt on resume. The worktree clean-tree check now excludes `.buildplane/planforge/**` (ephemeral dispatch state, like `runs/**` and `ledger/**`).
- a5de446: Serial worktree re-anchor (GAP-8): commitAndMergeWorkspace now returns the project-root post-merge HEAD ({ mergedHeadSha }), surfaced on RunPacketResult.mergedHeadSha so a serial loop driver anchors the next unit on the just-merged commit. prepareWorkspace now asserts the requested base commit resolves before cutting a worktree. Closes the PR #198 stale-base risk class for serial multi-unit runs.
- 716b8db: add the Mission Control storage read surface and the Tier-1 acceptance shadow. `listRunsByStatus` now returns a paginated `RunPage` (array carrying an opaque `cursor`) with `limit`/`cursor` support; `recordAcceptanceShadow` writes the additive `runs.acceptance_outcome` column from the M4 acceptance path; `listPendingOperatorDecisions` returns the operator inbox feed (suspended runs as `resume`, accepted-undecided runs as `merge`, excluding runs with an `operator_decision_recorded` event). `parentRunId` is now threaded through `toRun` → `inspectTarget` → `InspectSnapshot.run`.

### Patch Changes

- a5de446: add optional `provisionDeps` hook to `CreateBuildplaneOrchestratorOptions`. When provided, the orchestrator invokes it with the isolated worktree path after `prepareWorkspace` succeeds and before the workspace row is recorded / admission proceeds, so dependency provisioning (e.g. `pnpm install --frozen-lockfile`) runs before acceptance-check commands. A thrown error surfaces as a `workspace-provision-failed` infrastructure failure with the worktree retained for inspection.
- Updated dependencies [a5de446]
  - @buildplane/capability-broker@0.2.2

## 0.4.2

### Patch Changes

- 4e29efd: feat(m4): wire the acceptance-contract finalization gate

  The kernel now records an independent acceptance verdict before a PlanForge run
  is merged. `planforge dispatch --enforce-acceptance` derives a per-task
  acceptance contract (`deriveAcceptanceContract`: diff-scope = the task
  capability-bundle fsWrite, checks = its verificationCommands), resolves it
  through a per-task policy profile, and the kernel runs the checks in the
  worktree, evaluates the contract, and appends a signed `acceptance_recorded`
  event via an injected acceptance port **before** the merge (write-ahead). A
  passed verdict proceeds to the existing merge; a rejected verdict short-circuits
  with no merge and preserves the worktree as the quarantine artifact.

  Opt-in: the gate is off by default, so plain `planforge dispatch` is
  byte-for-byte unchanged. (A freshly-created worktree has no installed
  dependencies yet, so a task's `pnpm`-based verificationCommands cannot run there
  until a later slice provisions worktree dependencies — until then the gate is
  opt-in via the flag.)

- 2704f4f: fix(kernel): reject the acceptance gate when the worktree HEAD advances off the recorded base SHA

  The M4 acceptance finalization gate diffs the worktree against `HEAD`. A worker (or an
  unsandboxed check) that `git commit`s inside the detached worktree during execution
  advances HEAD, so `git diff HEAD` reports an empty diff and the diff-scope arm would let a
  committed — possibly out-of-scope — delta merge on a zero exit. The gate now compares the
  live worktree HEAD against the immutable recorded base SHA and rejects fail-closed on any
  advance, closing the diff-scope fail-open surfaced by the M4-S3 adversarial bypass review.

  - @buildplane/capability-broker@0.2.1

## 0.4.1

### Patch Changes

- Updated dependencies [6e11495]
  - @buildplane/capability-broker@0.2.0

## 0.4.0

### Minor Changes

- 6156fbf: M2-S5: activity bracketing — `executeOnce` emits a write-ahead, kernel-signed
  `activity_started` (durably flushed before invoke) and an `activity_completed`
  (recorded result + canonical `result_digest`) via a new kernel `LedgerActivityPort`,
  for both model and command activities. The CLI supplies the concrete signed-emitter
  adapter (`createLedgerActivityPort` / `createDeferredLedgerActivityPort`) and wires
  it into both `planforge dispatch` and `buildplane run` on a kernel-signed tape; a
  fail-fast `assertKernelSigningKey()` precondition guards every signed-ledger path.

## 0.3.0

### Minor Changes

- b1b7842: M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
  gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
  on the packet + admission receipt and a verified worktree_clean git status.

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

- ad3cde8: S5: outcome aggregation + opt-in score-driven routing producer

  Closes the layer-5 outcome-memory loop on the read/steer side. Adds a pure
  `outcome-scoring` module (`aggregateOutcomeScores` with read-time recency decay
  plus an undecayed `rawSamples` count, and `chooseWorker` with a seed-free
  least-sampled cold-start rotation that converges, exploit-best-rate, and an
  optional per-run epsilon hook) and a `fillRoutingHints` producer that fills
  `routingHints.preferredWorker` from those scores. The producer runs inside
  `prepareRun` before `createRun`, so the persisted `unit_snapshot` route equals
  the executed route and the S4 recorder's reading (recorded route == actual
  route). Model packets only, fill-not-override, `sdk`/undefined leaves the hint
  absent. Opt-in via `outcomeRouting` on the orchestrator options, default OFF —
  when disabled the producer is never called, `listRunOutcomes` is never queried,
  and routing is unchanged.
