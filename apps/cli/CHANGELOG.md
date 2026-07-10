# buildplane

## 0.14.2

### Patch Changes

- Updated dependencies [096d314]
  - @buildplane/planforge@1.1.2
  - @buildplane/adapters-tools@0.1.11
  - @buildplane/kernel@0.8.2
  - @buildplane/adapters-models@0.2.5
  - @buildplane/adapters-codex@0.1.11
  - @buildplane/adapters-git@0.4.3
  - @buildplane/adapters-honcho@0.1.11
  - @buildplane/mission-control-server@0.1.3
  - @buildplane/policy@0.2.5
  - @buildplane/runtime@0.1.11
  - @buildplane/storage@0.4.3
  - @buildplane/ui-tui@0.1.11

## 0.14.1

### Patch Changes

- c539eff: unify path-glob semantics across the envelope admission gate and the acceptance diff-scope gate on the broker's minimatch semantics: a new shared `segment-glob` module in `@buildplane/policy` decides matching (differentially tested against real minimatch) and language-inclusion subset (brute-force verified), so middle-wildcard vocabulary globs like `packages/**/src/**` now cover concrete proposals at admission and match changed files at acceptance instead of being dead patterns
- 0079caa: fail closed with source-checkout guidance when `bp web` runs from a published install (the optional `@buildplane/mission-control-server` package is not bundled), surface a `bootstrap doctor` note that the published native binary is packaged for linux-x64 only, and report entrypoint promise rejections as a clean exit 1 instead of an unhandled rejection
- 824b9a6: wire the per-tool-call ledger sink into the PlanForge resume/recover executed-suffix path, so a cold-resumed run's worker tool_use/tool_result events land on the signed tape (stamped with the executed suffix packet's unit id and parented to its activity bracket) instead of recording zero tool activity — closing the resume-path evidence-trail gap left open at the M6 gate

## 0.14.0

### Minor Changes

- 74dc5f1: M6 watched-demo fixes for running the admit → dispatch cycle against an external target repo: lockfile-aware worktree dependency provisioning (`pnpm install --frozen-lockfile` / `npm ci` / `npm install`, skip when no `package.json`), standalone `planforge dispatch` worker flags (`--model`, `--max-turns`, `--worker-allowed-tools`, `--worker-timeout-ms` — R7 parity with the loop, tool grant defaults to the spike-proven set), and `bp web` serving the UI from the CLI checkout's `apps/web/dist` instead of the operator's cwd.
- e7b6af6: M6-F2: emit per-tool-call tape events (`tool_request`/`ToolRequestStoredV1`, `tool_result`/`ToolResultV1`) on the `planforge dispatch` path. S8 wired the Claude worker's tool-stream sink only on the `bp run` path, so the dispatch tape showed activity bracketing but no per-tool-call events. `runPlanForgeDispatchCommand` now threads `onClaudeToolEvent` into `loadCliOrchestrator` on both the acceptance-enforced and no-enforce branches, bound to `createClaudeToolLedgerEmitter` over the same serialized signed dispatch emitter. A new dispatch unit-ctx tracker observes the activity-bracketing emitter to capture each in-flight packet's `activity_started` event id and unit id, so tool_request events carry the correct `unit_id` and parent event id. The resume path (`resumePlanForgePlanFromInput`) is a deliberate residual (M6-F1 rewires that region).

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
- Updated dependencies [74dc5f1]
- Updated dependencies [74dc5f1]
  - @buildplane/kernel@0.8.1
  - @buildplane/storage@0.4.2
  - @buildplane/mission-control-server@0.1.2
  - @buildplane/planforge@1.1.1
  - @buildplane/adapters-codex@0.1.10
  - @buildplane/adapters-git@0.4.2
  - @buildplane/adapters-honcho@0.1.10
  - @buildplane/adapters-models@0.2.4
  - @buildplane/adapters-tools@0.1.10
  - @buildplane/policy@0.2.4
  - @buildplane/runtime@0.1.10
  - @buildplane/ui-tui@0.1.10

## 0.13.0

### Minor Changes

- 20e0a7e: add the `bp web` subcommand — serve the Mission Control web UI. It lazy-imports `@buildplane/mission-control-server`, constructs the ledger-backed `OperatorDecisionPort` + the orchestrator/store deps, and static-serves `apps/web/dist` (loopback by default; `--allow-external`/`BUILDPLANE_WEB_ALLOW_EXTERNAL=1` to widen, `--port N` to choose the port, default 4173). `--check` runs a no-listen self-test that proves the dependency graph wires up (synthetic `GET /api/status`) without binding a socket; SIGINT/SIGTERM trigger a graceful close. The root `build` script now also builds `apps/web` (vite), and `apps/web` is typechecked as its own `tsc --noEmit` step (kept out of the root project-reference graph).
- a22712f: cut the public v0.5 release wiring (M6-S13): add an MIT `LICENSE`, flip changesets `access` to `public`, remove `apps/cli`'s `private` flag + add `publishConfig.access: public`, and drop the stale `gsd2` bin from the published surface (operator decision O5 — `src/gsd2*.ts` + its tests stay, source cleanup is post-v0.5). The release workflow now wires `changeset publish` guarded by `NPM_TOKEN` (fails loud on a release-landing push when the token is missing), with `RELEASE_TOKEN` fed to checkout + the changesets step and a `GITHUB_TOKEN` fallback. The GitHub-release tag `v0.5.0` is independent of npm semver — the published npm version continues upward from `0.12.2` (npm rejects downgrades), so this bump lands as `>=0.13.0`, not `0.5.0`.
- c71628d: add the `bp goal "<text>"` subcommand (M6 demo step 1) — turn a raw operator goal into a compiled-and-previewed PlanForge plan JSON. It auto-detects the trusted base from git `HEAD` and the remote from `origin` (overridable with `--trusted-base <sha>`), synthesizes the PlanForge input markdown (`## Goal` / `## Repository context` incl. a `Trusted base:` line / `## Safety constraints` / `## Tasks`), runs the `compile → validate → preview` pipeline, and emits JSON surfacing `planDigest`, `trustedBase`, `remote`, `riskClass`, `status`, `missingEvidence`, and the full plan. A dirty worktree warns (and pins to HEAD) unless `--trusted-base` is given. A bare goal validates to `INSUFFICIENT_EVIDENCE` (empty `## Tasks`) — `bp goal` is display-only and exits 0 regardless of validation status; it never admits, executes, or causes side effects.
- ba49394: thread an optional worker-model override through the PlanForge loop and dispatch. `dispatchAdmittedPlan` accepts a new optional `model` on its input and stamps it onto every dispatched packet's `model.model` (defaulting to the unchanged `DISPATCH_WORKER_MODEL`). The CLI exposes it as `buildplane planforge loop --model <id>`: the flag is parsed in the loop command and passed through `makeDefaultLoopDispatch` → `runPlanForgeDispatchCommand` → `dispatchAdmittedPlan`, so the dogfood can run workers on `claude-opus-4-8` without changing the global default. Omitting `--model` leaves dispatch byte-for-byte unchanged.

  The override is also **durable across `planforge resume`/`recover`**: the model is persisted in the dispatch crash-recovery manifest (`PlanForgeDispatchManifest.model`) before the run loop, and `resumePlanForgePlanFromInput` recovers it (via `resolvePlanForgeResumeModel`) so a crashed-and-resumed run re-dispatches its remaining suffix on the same model rather than silently reverting to the default — the exact crash-and-resume path the M6 demo exercises.

### Patch Changes

- eb7b2ec: give the `planforge loop` supervisor honest terminal-reason fidelity plus a reset path (M6 R1). A failed dispatch is now split into two terminal reasons: `dispatch-error` when the worker produced NO durable side effects (empty worktree diff + no merged HEAD) — the fingerprint of an infra death such as a 429 rejection (0 tokens, 0 turns) — versus the existing `acceptance-fail` when the worker ran and built a diff the acceptance contract rejected. The dispatch outcome now surfaces `producedSideEffects` (derived from `receipt.changedFiles` / a merged HEAD) and the failing task's `decision.reasons`, which are threaded verbatim into the terminal `detail` instead of the previous hardcoded `"dispatch/acceptance failed"` string. A new `planforge loop --reset` clears `.buildplane/loop-state.json` and exits, so a loop that halted on a sticky terminal (e.g. `dispatch-error` from the 2026-07-01 dogfood 429) can be re-fired without manually deleting state.
- 9075722: make the PlanForge dogfood worker able to actually work (R7). Three fixes surfaced by a live loop dispatch whose worker made ten `Write` requests, all denied (`Claude requested permissions to write … but you haven't granted it yet`), zero edits, then killed by a hardcoded 300000ms timeout:

  - **Tool-permission grant.** `createClaudeCodeExecutor` gains an `allowedTools?: readonly string[]` option, emitted as `--allowedTools <tool...>`. The `planforge loop` dispatch defaults it to the spike-proven headless grant `Edit,Write,Read,Glob,Grep,Bash` (overridable via `--worker-allowed-tools`), so a headless worker can edit files and run bash. This is the safe alternative to `--dangerously-skip-permissions` (still denied by the GAP-10 guard) — it names the exact allowed tools instead of bypassing all permission checks. Scope stays bounded post-hoc by the M4 diff-scope + acceptance contract, not by withholding the grant.
  - **Configurable worker timeout.** The executor's `timeoutMs` is now threaded from the loop through `runPlanForgeDispatchCommand` → `loadCliOrchestrator`. `planforge loop` defaults the per-dispatch worker timeout to its `--wall-clock-ms` budget (overridable via `--worker-timeout-ms`, floored at 60000ms) instead of the executor's 300000ms default, which is far too short for a real multi-file derivation.
  - **Reset re-seed.** A fresh `planforge loop` (including after a bare `--reset`) now seeds `trustedBase` from the workspace git HEAD (mirroring `bp goal`), so a bare `--reset` then re-fire has a trusted base rather than dying with the planner reporting INSUFFICIENT_EVIDENCE before dispatch.

  Omitting the new flags leaves the executor/dispatch behaviour unchanged for callers that pass no grant or timeout.

- 96c866e: emit per-tool-call tape events from the Claude Code worker (M6-S8, demo step 7).

  The `claude-code-executor` now parses `tool_use` (assistant) and `tool_result`
  (user) content blocks out of the `--output-format stream-json` worker stream and
  forwards them to a new optional `onToolEvent` callback (`ClaudeToolEvent`),
  mirroring the `onCapabilityDenied` shape. The executor stays transport-agnostic
  — it never builds ledger payloads. Existing token-delta, terminal-result, and
  usage handling is unchanged; absent the callback the tool blocks are parsed
  silently.

  `apps/cli` wires the concrete emitter (`createClaudeToolLedgerEmitter`) that maps
  the callback data onto the signed tape as `ToolRequestStoredV1` / `ToolResultV1`,
  correlating each result to its request event id by `tool_use_id`. The sink is
  bound per-run alongside the activity emitter, so a non-ledger run is a no-op.

- Updated dependencies [ba49394]
- Updated dependencies [0f1b42e]
- Updated dependencies [790ff11]
- Updated dependencies [9075722]
- Updated dependencies [2ce5e9d]
- Updated dependencies [18bccd0]
- Updated dependencies [b197580]
- Updated dependencies [fb96406]
- Updated dependencies [96c866e]
- Updated dependencies [7c77a39]
- Updated dependencies [ba49394]
  - @buildplane/planforge@1.1.0
  - @buildplane/kernel@0.8.0
  - @buildplane/mission-control-server@0.1.1
  - @buildplane/adapters-models@0.2.3
  - @buildplane/ledger-client@0.3.0
  - @buildplane/adapters-codex@0.1.9
  - @buildplane/adapters-git@0.4.1
  - @buildplane/adapters-honcho@0.1.9
  - @buildplane/adapters-tools@0.1.9
  - @buildplane/policy@0.2.3
  - @buildplane/runtime@0.1.9
  - @buildplane/storage@0.4.1
  - @buildplane/ui-tui@0.1.9

## 0.12.2

### Patch Changes

- Updated dependencies [6e6cf64]
  - @buildplane/kernel@0.7.0
  - @buildplane/storage@0.4.0
  - @buildplane/adapters-git@0.4.0
  - @buildplane/adapters-codex@0.1.8
  - @buildplane/adapters-honcho@0.1.8
  - @buildplane/adapters-models@0.2.2
  - @buildplane/adapters-tools@0.1.8
  - @buildplane/policy@0.2.2
  - @buildplane/runtime@0.1.8
  - @buildplane/ui-tui@0.1.8

## 0.12.1

### Patch Changes

- Updated dependencies [676ecda]
  - @buildplane/kernel@0.6.0
  - @buildplane/adapters-codex@0.1.7
  - @buildplane/adapters-git@0.3.1
  - @buildplane/adapters-honcho@0.1.7
  - @buildplane/adapters-models@0.2.1
  - @buildplane/adapters-tools@0.1.7
  - @buildplane/policy@0.2.1
  - @buildplane/runtime@0.1.7
  - @buildplane/storage@0.3.1
  - @buildplane/ui-tui@0.1.7

## 0.12.0

### Minor Changes

- a5de446: GAP-5: add `PlanSummary`, `summarizePlanReceipt`, and `formatPriorWorkEntry` to planforge; add `injectPriorWorkIntoPacket`, `loadPriorWorkEntries`, and `writePlanSummaryToStorage` to cli. The dispatch path now persists a structured plan summary to storage after `plan_receipt`, and the supervisor can inject it as `TaskIntent.context.priorWork` into the next iteration's packet.
- a5de446: Add the PlanForge planning worker: a roadmap-driven next-slice plan.md generator gated by `planforge validate`.

  - New `buildplane planforge plan` command reads a dedicated machine-readable roadmap (`docs/roadmap.json`, schema id `buildplane.roadmap.v0`) plus the L0 tape's completed slices, deterministically emits the next eligible slice's `plan.md` in the canonical `## Tasks` grammar, and exits 0 only when the emitted plan validates PASS.
  - New `@buildplane/planforge` exports: `loadRoadmapFromString`, `selectNextRoadmapSlice`, `buildPlannerPlanMarkdown`, `PLANFORGE_ROADMAP_SCHEMA_VERSION`, and the `RoadmapDoc` / `RoadmapSlice` / `RoadmapSliceStatus` types.
  - Narrows the `forbiddenGoalIntent` guard so benign self-build goals that mention running their verification commands are no longer falsely rejected `UNSAFE_TO_RUN`; the truly-unsafe boundary-crossing phrasings (push/deploy/merge/PR/network/board/worker-spawn) stay rejected.
  - Extends the public `PLANFORGE_REQUIRED_EVIDENCE` tuple with `tasks` (a plan with no parsed tasks now reports `tasks` as missing evidence directly rather than via a runtime cast). The `done`-status roadmap slice is treated as a satisfied dependency so a hand-built prerequisite unblocks the next slice.

- a5de446: add S7 crash recovery: `buildplane planforge recover` scans storage for orphaned `running` runs, replays the signed tape, and auto-resumes each dispatch (the tape is authoritative over the storage status field — recover re-runs the suffix and emits the receipt on the tape, never rewriting the `running` row). Adds `BuildplaneStoragePort.listRunsByStatus` and a `.buildplane/planforge/dispatch` manifest sidecar so recovery can map a `running` run back to its admitted `--input` plan, plus a `plan_receipt` dedup-on-append guard keyed on the deterministic tape run id (derived from `idempotency_key`) so a partial-flush crash cannot double-receipt on resume. The worktree clean-tree check now excludes `.buildplane/planforge/**` (ephemeral dispatch state, like `runs/**` and `ledger/**`).
- a5de446: Add the `buildplane planforge loop` supervisor (an FSM over `.buildplane/loop-state.json`, persisted atomically per transition) that drives plan → dry-run → envelope-check → admit → dispatch → accept → merge → re-anchor across iterations, bounded by an operator-authorized envelope. Flags: `--once`, `--max-iterations=N`, `--max-turns=N`, `--max-tokens=N`, `--wall-clock-ms=N`, `--json`. The loop resumes from a persisted non-terminal state and halts on a distinct terminal reason (roadmap-complete, stop-file, acceptance-fail, envelope-breach, token-budget, max-iterations, planner-error). It enforces both the envelope's `max_iterations` and cumulative `token_budget` as cross-iteration caps and verifies the active envelope's kernel signature on read.

  To make the runaway guard fire, `ClaudeCodeExecutor.executePacketAsync` now accepts an `AbortSignal`, streams `--output-format stream-json`, emits one `model-token-delta` per assistant text block (so the orchestrator's budget `AbortController` can count tokens and abort a runaway worker), and honors abort — with a buffered-JSON fallback that keeps the legacy single-object output path working. The runtime router forwards the signal and a lowered `--max-turns` to the worker.

### Patch Changes

- a5de446: `planforge dispatch` now enforces the M4 acceptance gate by default. Pass `--no-enforce-acceptance` to opt out (e.g. during initial dogfood bringup or when the worktree has no pnpm workspace); the legacy `--enforce-acceptance` flag is still accepted but redundant. When the gate is active, worktree dependencies are provisioned via `pnpm install --frozen-lockfile` before checks run, so a task's `verificationCommands` have their binaries.
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [716b8db]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
  - @buildplane/planforge@1.0.0
  - @buildplane/policy@0.2.0
  - @buildplane/kernel@0.5.0
  - @buildplane/ledger-client@0.2.0
  - @buildplane/storage@0.3.0
  - @buildplane/adapters-git@0.3.0
  - @buildplane/adapters-models@0.2.0
  - @buildplane/adapters-codex@0.1.6
  - @buildplane/adapters-honcho@0.1.6
  - @buildplane/adapters-tools@0.1.6
  - @buildplane/runtime@0.1.6
  - @buildplane/ui-tui@0.1.6

## 0.11.2

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

- Updated dependencies [4e29efd]
- Updated dependencies [2704f4f]
  - @buildplane/kernel@0.4.2
  - @buildplane/planforge@0.5.1
  - @buildplane/adapters-codex@0.1.5
  - @buildplane/adapters-git@0.2.3
  - @buildplane/adapters-honcho@0.1.5
  - @buildplane/adapters-models@0.1.5
  - @buildplane/adapters-tools@0.1.5
  - @buildplane/policy@0.1.5
  - @buildplane/runtime@0.1.5
  - @buildplane/storage@0.2.4
  - @buildplane/ui-tui@0.1.5

## 0.11.1

### Patch Changes

- Updated dependencies [e61e3f2]
  - @buildplane/ledger-client@0.1.2

## 0.11.0

### Minor Changes

- 403f91f: planforge: add `buildDefaultCapabilityBundleForPlan` — the run-wide capability envelope (deterministic sorted union of every task's `fsWrite` globs + `run_command` allowlist) derived from an admitted plan (M3-S7).
- 403f91f: adapters-tools: enforce the capability bundle's `run_command.allowlist` before spawning (M3-S7b). A command whose argv0 is not allowlisted is denied fail-closed and never executed, and (when a tape context is present) emits a signed `capability_denied` event — mirroring the `write_file` gate (M3-S4/S6) and closing the gap where the allowlist was defined and broker-evaluable but never enforced on the tool surface.

## 0.10.1

### Patch Changes

- @buildplane/adapters-tools@0.1.4
- @buildplane/kernel@0.4.1
- @buildplane/adapters-models@0.1.4
- @buildplane/adapters-codex@0.1.4
- @buildplane/adapters-git@0.2.2
- @buildplane/adapters-honcho@0.1.4
- @buildplane/policy@0.1.4
- @buildplane/runtime@0.1.4
- @buildplane/storage@0.2.3
- @buildplane/ui-tui@0.1.4

## 0.10.0

### Minor Changes

- 7ac334d: Add PlanForge explicit-input resume: verify signed `plan_admitted`, skip recorded activities on the tape, execute suffix tasks, emit missing `plan_receipt`.

## 0.9.0

### Minor Changes

- 148ad73: M2-S6: receipt stage — a completed `planforge dispatch` emits one kernel-signed
  `plan_receipt` (chaining to the `plan_admitted` event id, canonical
  `result_digest`, declared `side_effects`); `buildplane ledger export-signed-tape`
  serializes a live `events.db` run into `buildplane.signed-tape.v1` for the
  external verifier, completing the admit → activities → receipt round-trip.

### Patch Changes

- Updated dependencies [148ad73]
  - @buildplane/planforge@0.5.0

## 0.8.0

### Minor Changes

- 6156fbf: M2-S5: activity bracketing — `executeOnce` emits a write-ahead, kernel-signed
  `activity_started` (durably flushed before invoke) and an `activity_completed`
  (recorded result + canonical `result_digest`) via a new kernel `LedgerActivityPort`,
  for both model and command activities. The CLI supplies the concrete signed-emitter
  adapter (`createLedgerActivityPort` / `createDeferredLedgerActivityPort`) and wires
  it into both `planforge dispatch` and `buildplane run` on a kernel-signed tape; a
  fail-fast `assertKernelSigningKey()` precondition guards every signed-ledger path.

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0
  - @buildplane/adapters-codex@0.1.3
  - @buildplane/adapters-git@0.2.1
  - @buildplane/adapters-honcho@0.1.3
  - @buildplane/adapters-models@0.1.3
  - @buildplane/adapters-tools@0.1.3
  - @buildplane/policy@0.1.3
  - @buildplane/runtime@0.1.3
  - @buildplane/storage@0.2.2
  - @buildplane/ui-tui@0.1.3

## 0.7.0

### Minor Changes

- b1b7842: M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
  gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
  on the packet + admission receipt and a verified worktree_clean git status.

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0
  - @buildplane/planforge@0.4.0
  - @buildplane/adapters-git@0.2.0
  - @buildplane/adapters-codex@0.1.2
  - @buildplane/adapters-honcho@0.1.2
  - @buildplane/adapters-models@0.1.2
  - @buildplane/adapters-tools@0.1.2
  - @buildplane/policy@0.1.2
  - @buildplane/runtime@0.1.2
  - @buildplane/storage@0.2.1
  - @buildplane/ui-tui@0.1.2

## 0.6.0

### Minor Changes

- 253ea47: M2-S3: PlanForge admit stage — operator-approved signed `plan_admitted`.

  `buildplane planforge admit --input <file> --approve --operator <id>` records an
  operator-approved admission as a kernel-signed `plan_admitted` event on the L0
  tape (the first signed TS-spawned tape path). It fails closed with no tape write
  on a non-PASS plan, a missing `--approve`, or a missing `--operator`, and is
  idempotent by the plan's idempotency key. `@buildplane/planforge` adds the pure
  `buildPlanAdmittedPayload` builder.

### Patch Changes

- Updated dependencies [253ea47]
  - @buildplane/planforge@0.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [77b2a14]
  - @buildplane/ledger-client@0.1.1
  - @buildplane/planforge@0.2.1

## 0.5.0

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

### Patch Changes

- Updated dependencies [e11cf0f]
  - @buildplane/planforge@0.2.0

## 0.4.1

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/storage@0.2.0
  - @buildplane/kernel@0.2.0
  - @buildplane/adapters-codex@0.1.1
  - @buildplane/adapters-git@0.1.1
  - @buildplane/adapters-honcho@0.1.1
  - @buildplane/adapters-models@0.1.1
  - @buildplane/adapters-tools@0.1.1
  - @buildplane/policy@0.1.1
  - @buildplane/runtime@0.1.1
  - @buildplane/ui-tui@0.1.1

## 0.4.0

### Minor Changes

- 00d8d92: M1 · S4 — local keyring + signing-on-append: add the producer half of the signed
  event tape in `bp-ledger`. `signing::sign_event` signs `canonical_event_bytes`
  with an ed25519 key and emits an `EventSignatureV1` (base64url-no-pad signature
  that round-trips with the verify path; `signer.public_key_hash` set to
  `sha256:<hex(sha256(verifying_key))>` so it matches the `TrustedPublicKeys`
  lookup; deterministic for the same key+event). A new `keyring` module loads raw
  32-byte ed25519 seeds from `~/.buildplane/keys/<actor>/<key-id>.ed25519`
  (`$HOME`-resolved, actor-scoped per OPERATOR-DECISION-A); errors carry only the
  attempted path and an opaque reason, never key bytes. `SqliteStore::append_signed`
  signs first, then inserts the event row and the matching `event_signatures` row
  inside one transaction and commits only if all succeed — any signing or insert
  failure rolls back so no event row persists (fail closed). Signing is opt-in via
  `ledger serve --sign [--signing-key-id <id>]` (default OFF / unsigned, preserving
  legacy behavior; applies to the `kernel` actor); only a key reference crosses the
  config boundary. No event-envelope, generated-TS, or fixture changes.

  Review-gate hardening (cross-model L0 trust-surface review): keyring identifiers
  (`actor_id`/`key_id`) are now validated before any path join — anything with a
  path separator, `..`, a leading `.`, an absolute path, or a char outside
  `[A-Za-z0-9._-]` is rejected with a typed `UnsafeKeyringId` error (carries only
  the offending id descriptor, no key bytes), so `--signing-key-id ../../foo`,
  `/tmp/foo`, `a/b`, and `..` can no longer escape the actor-scoped dir.
  `verify_event_signature` now (a) rebinds the retrieved trusted key to its claimed
  `public_key_hash` and fails closed (`MissingKey`) if the registry maps a claimed
  hash to mismatched key bytes, and (b) rejects a signature whose `event_id` differs
  from the event under verification (`HashMismatch`). A new integration test proves
  the atomic-rollback guarantee by forcing the signature insert to fail _after_ the
  event insert succeeds within the same transaction (PK collision) and asserting the
  event row is rolled back.

  Deferred follow-ups (documented, intentionally not implemented this slice):

  - R-003: `SigningKey` is not zeroized on drop. M2 should wrap the loaded seed in a
    zeroizing container so private-key material is scrubbed from memory on drop.
  - R-004: signing is currently all-under-kernel (the `signer` is always the kernel
    actor). Per-actor signing authorship is a multi-actor follow-up, not in scope here.

- eb9bb5f: M1 · S6 — tape-root checkpoint events: add periodic, signed tape-root checkpoints
  so an external verifier can validate a compact tape prefix without replaying every
  event. New `TapeCheckpoint` event kind (wire `tape_checkpoint`) and `#[typeshare]`
  payload `TapeCheckpointV1` (`run_id`, `checkpoint_index`, `through_event_id`,
  `through_event_count`, `previous_checkpoint_event_id`, `tape_root_hash`,
  `algorithm`). The root is a monotonic local checkpoint, NOT a Merkle tree:

  ```text
  tape_root_hash = "sha256:" + hex(sha256(join("\n", ordered canonical_event_hash strings through through_event_id)))
  ```

  `payload::checkpoint::tape_root_hash` is the pure-function contract an external
  verifier (S7) must mirror exactly: it hashes the per-event `sha256:<hex>` strings
  of the signed events in tape order (UUIDv7 id ascending), `\n`-joined with no
  trailing newline. Each checkpoint covers the full prefix of the run's signed
  ordinary (non-checkpoint) events from run start through `through_event_id`.

  Emission lives in the signed-append path. `SqliteStore::append_signed_with_checkpoint`
  appends the ordinary event + its detached signature atomically (as before), then
  — in signed mode with an enabled `CheckpointPolicy` — emits a checkpoint when the
  per-run cadence is reached (default 256 signed events; `CheckpointPolicy::every(n)`
  for tests) or when a `run_completed` event leaves ≥1 signed ordinary event
  uncheckpointed since the last checkpoint. `checkpoint_index` increments per run and
  `previous_checkpoint_event_id` chains the checkpoints. The checkpoint event is
  signed and appended together with its signature in a single transaction, so a
  checkpoint never persists without its signature (fail closed); a forced
  signature-insert failure rolls back the checkpoint event too. Checkpoints belong
  to signed mode only — the unsigned append path and a `Disabled` policy emit none.
  The live signed serve loop (`SigningConfig::Signed`) defaults to cadence 256.
  `tape_checkpoint` events are replay no-ops (tape-integrity metadata, not state
  transitions). The frozen 7-field event envelope is unchanged.

  Generated TypeScript bindings (`packages/ledger-client/src/generated/index.ts`),
  the hand-written `Payload` union (`payload.ts`), and the payload-variants fixture
  are regenerated to include `TapeCheckpointV1` / `TapeRootAlgorithm` (16 variants).

- b373716: Phase 2 · S1 — cross-layer injection dedup/precedence: introduce a pure `dedupeAcrossLayers` helper and apply it at the packet-enrichment injection assembly so a memory surfacing in more than one layer (structured repo-facts/procedures/documents, run_learnings, honcho) is injected once instead of concatenated verbatim. Cross-layer identity keys on normalized display text (layer tag stripped, whitespace/case folded) because only display strings survive to the assembly. Documented precedence is source-order `structured (repo-fact ≻ procedure ≻ document) ≻ run_learnings ≻ honcho`; the higher-precedence copy wins and distinct memories are preserved in stable order. Finer confidence/recency tie-breaks fall back to source order (the contract's documented fallback) because that data is not available at the assembly. Only `packet-enrichment.ts` (+ its test) changed; no port or DDL change.
- 2cb5874: Phase 2 · S2 — repo_facts branch-scoped filtering: add an optional `branch?` to `RepoFactRetrievalQuery`, thread it through `retrieveRepoFacts` and the store read helpers (`readRepoFactRows`/exact/fuzzy) with a `(branch = ? OR branch IS NULL)` clause so facts promoted on another branch no longer leak into unrelated runs (null-branch rows stay repo-global and always match), and have packet-enrichment pass the run's current branch. Additive/opt-in: omitting `branch` preserves today's unfiltered behavior. No DDL change; `valid_from_commit`/`valid_to_commit` and the ranking algorithm are untouched.
- 5548286: Phase 2 · S3 — episodes read path: add `listEvents({ runId, limit? })` to `BuildplaneStoragePort` (implemented via `EventStore.getEventsByRunId`) and a `memory episodes <runId> [--limit N] [--json]` CLI subcommand that lists a run's execution events with `--json` parity to `facts`/`procedures`; a missing `<runId>` exits non-zero with a clear message.

## 0.3.0

### Minor Changes

- 72416c2: Phase 1 memory subsystem slices:

  - **Repo-fact seeding** — `bootstrap seed [--json]` detects repo signals (primary language, test/build/typecheck/lint commands) and seeds durable `repo.*` structured facts via the existing `upsertRepoFact` port.
  - **Memory CLI reads** — `memory facts [--scope --json]` and `memory procedures [--task-type --json]` subcommands over the existing `listRepoFacts`/`listProcedures` reads; storage errors now surface instead of being swallowed.
  - **Reviewer memory injection** — reviewer packets now carry a review `intent` and the reviewer leg's enriched memories are persisted (`recordInjectedMemories`) on both the `run-strategy` and default `run --packet` paths.

## 0.2.0

### Minor Changes

- b46a88d: Add `buildplane pack export` for GitHub custom-agent and skill guidance exports.
