# @buildplane/planforge

## 0.5.0

### Minor Changes

- 148ad73: M2-S6: receipt stage — a completed `planforge dispatch` emits one kernel-signed
  `plan_receipt` (chaining to the `plan_admitted` event id, canonical
  `result_digest`, declared `side_effects`); `buildplane ledger export-signed-tape`
  serializes a live `events.db` run into `buildplane.signed-tape.v1` for the
  external verifier, completing the admit → activities → receipt round-trip.

## 0.4.0

### Minor Changes

- b1b7842: M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
  gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
  on the packet + admission receipt and a verified worktree_clean git status.

## 0.3.0

### Minor Changes

- 253ea47: M2-S3: PlanForge admit stage — operator-approved signed `plan_admitted`.

  `buildplane planforge admit --input <file> --approve --operator <id>` records an
  operator-approved admission as a kernel-signed `plan_admitted` event on the L0
  tape (the first signed TS-spawned tape path). It fails closed with no tape write
  on a non-PASS plan, a missing `--approve`, or a missing `--operator`, and is
  idempotent by the plan's idempotency key. `@buildplane/planforge` adds the pure
  `buildPlanAdmittedPayload` builder.

## 0.2.1

### Patch Changes

- 77b2a14: add M2 plan/activity signed tape event kinds (plan_admitted, plan_receipt, activity_started, activity_completed) to the TS payload union + fixtures; fold M2-S1 planforge review nits

## 0.2.0

### Minor Changes

- e11cf0f: m2-s1: extract @buildplane/planforge package + runtime contract + canonical digest

  Lifts the PlanForge dry-run pipeline (`compile → validate → preview`) out of the
  CLI into a new, unit-testable `@buildplane/planforge` workspace package. The
  package owns the schema (constants + interfaces) and now exports the promoted
  runtime types `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt`
  alongside `compile`/`validate`/`preview` and `createPlanForgeDryRunPlan`. The CLI
  `planforge dry-run` handler delegates to the package, and
  `apps/cli/src/planforge-schema.ts` becomes a non-breaking re-export shim.

  `planDigest`/`inputDigest` now use a canonical, key-sorted serializer
  (`canonicalJson` + `digest`) shared with the signed-tape path, replacing the
  insertion-order `JSON.stringify`. Dry-run output is otherwise unchanged: the
  golden fixture is identical except a one-time digest update
  (`inputDigest sha256:1a2924… → sha256:ac29ab…`,
  `planDigest sha256:d73b27… → sha256:510fa9…`). The subcommand gate, the
  `--write/--execute/--admit` block, and the hardcoded dry-run stubs
  (`dryRun`/`sideEffects`/`admittedBy`/`generatedAt`) are untouched.
