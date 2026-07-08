# @buildplane/planforge

## 1.1.1

### Patch Changes

- 74dc5f1: Re-export `DISPATCH_WORKER_MODEL` from the package root so CLI surfaces can report the effective worker model without duplicating the constant.

## 1.1.0

### Minor Changes

- ba49394: thread an optional worker-model override through the PlanForge loop and dispatch. `dispatchAdmittedPlan` accepts a new optional `model` on its input and stamps it onto every dispatched packet's `model.model` (defaulting to the unchanged `DISPATCH_WORKER_MODEL`). The CLI exposes it as `buildplane planforge loop --model <id>`: the flag is parsed in the loop command and passed through `makeDefaultLoopDispatch` → `runPlanForgeDispatchCommand` → `dispatchAdmittedPlan`, so the dogfood can run workers on `claude-opus-4-8` without changing the global default. Omitting `--model` leaves dispatch byte-for-byte unchanged.

  The override is also **durable across `planforge resume`/`recover`**: the model is persisted in the dispatch crash-recovery manifest (`PlanForgeDispatchManifest.model`) before the run loop, and `resumePlanForgePlanFromInput` recovers it (via `resolvePlanForgeResumeModel`) so a crashed-and-resumed run re-dispatches its remaining suffix on the same model rather than silently reverting to the default — the exact crash-and-resume path the M6 demo exercises.

### Patch Changes

- ba49394: cover the ledger fixtures directory in the `code-edit` diff-scope. The `code-edit` side-effect now maps to `packages/**/fixtures/**` (symmetric with the existing `packages/**/src/**` / `packages/**/test/**`), so an admitted code-edit plan can authorize the regenerated `packages/ledger-client/fixtures/payload-variants.json` that `pnpm ledger:gen-fixtures` produces. Because the M4 acceptance diff-scope (`deriveAcceptanceContract`) is derived from the same `capability_bundle.fsWrite`, a worker that regenerates and commits ledger fixtures (e.g. the `result_ready` dogfood derivation) no longer fails acceptance with an out-of-scope diff.
- 2ce5e9d: add a `riskClass` (`low` | `medium` | `high`) attribute to PlanForge validation and surface it on the receipt preview. It is computed during `validate`: `high` when the plan is unsafe to run, `medium` when evidence is missing or a clean plan declares allowed side effects, and `low` for a clean plan with no side effects. The field is additive — `riskClass` participates in the signed `planDigest` (validation is part of the digested review artifact), so the golden plan fixture's digest was regenerated.
- 18bccd0: map the `code-edit` side-effect to `native/crates/**/src/**` and `native/crates/**/tests/**` so admitted plans can authorize edits to native crate sources and tests (unblocks the dogfood worker writing ledger payloads/tests).
- 7c77a39: add a declarative `netEgress` host allowlist to the capability bundle. The broker schema parses, validates (non-empty hosts, no whitespace/`/`/NUL), and digest-covers the field; PlanForge maps each task's `allowedSideEffects` to a deterministic egress union (every current side-effect declares zero egress — explicit default-deny — with the map as the single extension point, e.g. a future `npm-install` → `["registry.npmjs.org"]`) and surfaces the plan-wide union on the receipt preview alongside `riskClass`. Declarative-only in v0: the field is visible and digest-covered but NOT yet enforced at the worker boundary (no verified Claude Code subprocess network-restriction flag exists).

## 1.0.0

### Major Changes

- a5de446: Dynamic task generation from ## Tasks Markdown section.

  Breaking changes:

  - `PLANFORGE_TASK_IDS` constant removed.
  - `PlanForgeTaskId` type removed.
  - `PlanForgeTask.id` widened from `PlanForgeTaskId` to `string`.
  - `PlanForgeTask.dependsOn` widened from `PlanForgeTaskId[]` to `string[]`.

  New exports:

  - `parseTasks(content: string): ParsedTask[]` — parses the `## Tasks` Markdown section.
  - `ParsedTask` interface.
  - `PlanForgeCompileResult.parsedTasks` field.

  Validation changes:

  - Plans without a `## Tasks` section now produce `INSUFFICIENT_EVIDENCE`.
  - New checks `tasks-present` and `tasks-valid` added to `PlanForgeValidation`.

### Minor Changes

- a5de446: GAP-5: add `PlanSummary`, `summarizePlanReceipt`, and `formatPriorWorkEntry` to planforge; add `injectPriorWorkIntoPacket`, `loadPriorWorkEntries`, and `writePlanSummaryToStorage` to cli. The dispatch path now persists a structured plan summary to storage after `plan_receipt`, and the supervisor can inject it as `TaskIntent.context.priorWork` into the next iteration's packet.
- a5de446: Add the PlanForge planning worker: a roadmap-driven next-slice plan.md generator gated by `planforge validate`.

  - New `buildplane planforge plan` command reads a dedicated machine-readable roadmap (`docs/roadmap.json`, schema id `buildplane.roadmap.v0`) plus the L0 tape's completed slices, deterministically emits the next eligible slice's `plan.md` in the canonical `## Tasks` grammar, and exits 0 only when the emitted plan validates PASS.
  - New `@buildplane/planforge` exports: `loadRoadmapFromString`, `selectNextRoadmapSlice`, `buildPlannerPlanMarkdown`, `PLANFORGE_ROADMAP_SCHEMA_VERSION`, and the `RoadmapDoc` / `RoadmapSlice` / `RoadmapSliceStatus` types.
  - Narrows the `forbiddenGoalIntent` guard so benign self-build goals that mention running their verification commands are no longer falsely rejected `UNSAFE_TO_RUN`; the truly-unsafe boundary-crossing phrasings (push/deploy/merge/PR/network/board/worker-spawn) stay rejected.
  - Extends the public `PLANFORGE_REQUIRED_EVIDENCE` tuple with `tasks` (a plan with no parsed tasks now reports `tasks` as missing evidence directly rather than via a runtime cast). The `done`-status roadmap slice is treated as a satisfied dependency so a hand-built prerequisite unblocks the next slice.

- a5de446: Dispatch real claude-code coding workers instead of the `true` placeholder.

  - `DispatchedUnitPacket` drops the `execution: { command }` field and gains `model`
    (`{ provider, model, prompt }`), `intent` (an inlined `DispatchTaskIntent`), and
    `routingHints: { preferredWorker: 'claude-code' }`. The run-loop router short-circuits
    any packet carrying `execution` to the command executor before checking
    `preferredWorker`, so removing it is what lets the real worker be selected.
  - New exports: `DISPATCH_WORKER_PROVIDER`, `DISPATCH_WORKER_MODEL`, `DispatchTaskIntent`,
    and `buildTaskIntent`.
  - `buildDefaultCapabilityBundleForTask` now always seeds `'claude'` into the
    `run_command` allowlist (the worker binary), so `run_command` is always present and
    the capability-bundle canonical digest changes.
  - `verification.requiredOutputs` and `unit.expectedOutputs` stay empty by design; the
    real assertion is `verificationCommands` run by the M4 acceptance gate.

### Patch Changes

- a5de446: add a `code-edit` side-effect kind mapping to `src/**`, `test/**`, `packages/**/src/**`, and `packages/**/test/**`, so an admitted plan can authorize source edits through the capability bundle. Extends `PLANFORGE_ALLOWED_SIDE_EFFECTS` and `SIDE_EFFECT_FS_WRITE_GLOBS`; no change to the toy dry-run plan or its golden fixture.

## 0.5.1

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
