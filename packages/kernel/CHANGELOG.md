# @buildplane/kernel

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
