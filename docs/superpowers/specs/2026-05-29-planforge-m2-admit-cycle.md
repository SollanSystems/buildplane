# M2 PlanForge Admission-Cycle Spec

| | |
|---|---|
| **Status** | Draft implementation contract for M2 |
| **Date** | 2026-05-29 |
| **Milestone** | Buildplane v0.5 M2 — PlanForge admission cycle (`compile → validate → preview → admit → dispatch → execute → receipt`) |
| **Owning layers** | L6 PlanForge (`packages/planforge`, new) · L1 Kernel (`packages/kernel`) · L0 Tape (`bp-ledger` + `packages/ledger-client`) |
| **Depends on** | M1 complete on `main` (`8a98ea6`: signed tape S1–S7 + external verifier); run-admission contract landed (#133 `9598c0e`, #138 `ee212b2`); PlanForge dry-run on `main` |
| **Companion docs** | [v0.5 design §6 L6 / §8](./2026-05-21-buildplane-v05-design.md) · [M1 signing spec](./2026-05-22-tape-per-event-signing.md) · [planforge architecture](../../architecture/planforge.md) · [run admission receipts](../../architecture/run-admission-receipts.md) · [ledger](../../ledger.md) |

## Goal

Complete the PlanForge admission cycle on `main`. `compile → validate → preview` already ship as the side-effect-free dry-run. M2 adds **`admit → dispatch → execute → receipt`**, where:

- the **admission** decision and the terminal **receipt** are **signed events on the L0 tape** (M1 Ed25519 spine), independently verifiable by the external verifier;
- the kernel survives a **mid-cycle crash** via **full Temporal-style replay** — every I/O activity result is recorded as a signed event, and on replay the kernel reads the recorded result and **never re-invokes the model or tool**;
- admission requires **single-operator approval** through a CLI subcommand.

This is the single largest v0.5 work item (v0.5 §6 L6).

## Current state (on `main`, `8a98ea6`)

- **PlanForge dry-run** ships: `createPlanForgeDryRunPlan` (`apps/cli/src/run-cli.ts:5531`) drives compile (markdown section parse) → validate (five fail-closed checks, `PASS`/`INSUFFICIENT_EVIDENCE`/`UNSAFE_TO_RUN`) → preview (`PlanForgeReceiptPreview`). The `planforge` subcommand gate (`run-cli.ts:3454`) **explicitly blocks `--write`/`--execute`/`--admit`**. Schema runtime types live in `apps/cli/src/planforge-schema.ts`; `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt` are **doc-only** (`docs/architecture/planforge.md:113–205`). `dryRun:true`, `sideEffects:[]`, `admittedBy:"buildplane-kernel"`, and `generatedAt` are hardcoded stubs; task IDs are hardcoded `PF1`/`PF2`; `planDigest` uses non-canonical `JSON.stringify`.
- **M1 signed tape** is complete: `bp-ledger` signs every event on append (`append_signed_with_checkpoint`, `storage/sqlite.rs`); keys at `~/.buildplane/keys/<actor>/<key-id>.ed25519`; tape-root checkpoints; external verifier `scripts/verify-signed-tape.mjs`. Adding an event kind = `kind.rs` + payload struct + `payload/mod.rs` + `canonicalize.rs` arms + typeshare regen + hand-edit `packages/ledger-client/src/payload.ts` + `pnpm ledger:gen-fixtures`.
- **Run-admission** (`run_admission_recorded`, `RunAdmissionRecordedV1`) is wired into the run loop — `admitPreparedRunSync`/`Async` (`orchestrator.ts:1060`/`1177`) run after `prepareRun()`, before `execution-started`, and gate dispatch on `decision === "PASS" && will_execute_worker === true`. **But the admission record persists to a JSONL sidecar (`.git/buildplane/admission/events.jsonl`), NOT the signed tape**; `bp-replay` treats `RunAdmissionRecordedV1` as a no-op (`transitions.rs:24`); the `will_execute_worker` trust is an in-memory `WeakSet` (`admission-receipts.ts:18`) lost on restart.
- **Replay/fork**: `bp-replay` (`ReplayEngine`) and `bp-fork` (`build_fork_plan`) ship; `buildplane ledger replay --run-id` works. **No kernel startup recovery** exists; no `activity_started`/`activity_completed` bracket events exist; recorded `model_*`/`tool_*` events are never read back to skip re-invocation. `buildplane ledger export-signed-tape` (live `events.db` → `buildplane.signed-tape.v1`) is **not implemented** (`docs/ledger.md`).

This spec starts from that state.

## Architecture decisions (operator-confirmed 2026-05-29)

1. **PlanForge code home → new `packages/planforge`.** Extract `compile`/`validate`/`preview` out of `run-cli.ts` into a package consumed by both the kernel and the CLI, so admission/receipt logic is unit-testable in isolation and reusable from the kernel. The CLI becomes a thin command layer.
2. **Admit event model → coexist.** Introduce a new signed tape event `plan_admitted` as the PlanForge dispatch authority. The existing `run_admission_recorded` (#133/#138) **continues** as the per-`UnitPacket` gate but is **mirrored onto the signed tape** (today it is only a JSONL sidecar). Do **not** rework the landed admission wiring.
3. **Replay depth → full Temporal-style.** Introduce signed `activity_started`/`activity_completed` events that bracket every I/O activity and record its result. On replay the kernel reads the recorded result and never re-invokes the model/tool. This is the rigorous reading of v0.5 §6 L1.
4. **Approval UX → `buildplane planforge admit <plan> --approve`.** A signed admission event; scriptable and forward-compatible with the M5 web inbox (same event).
5. **Signing authority → kernel key.** All M2 events are signed by the kernel key (`actor_id="kernel"`, `key_id="kernel-main"`); the operator's identity is recorded as a payload field. Operator-key signing is deferred.
6. **Dispatch path → `runPacketAsync` only.** PlanForge dispatch routes exclusively through the async path (async tape append via `ledger-client`). The sync `runPacket` path is confirmed not load-bearing for PlanForge and is left untouched.

## Non-goals for M2

M2 does **not** add (each deferred to the named milestone):

- Sealed capability bundles + per-tool-call capability validation — **M3**. S4 reserves typed-optional `UnitPacket` fields (`provenance_ref` required; `capability_bundle?`/`acceptance_contract?`/`trust_scope?` typed but unused) only.
- Acceptance-contract gating (diff-scope + CI + lint) — **M4**. M2 records a receipt but does not gate finalization on an acceptance contract.
- Mission Control web UI / approval inbox — **M5**. M2 approval is CLI-only.
- Multi-sig admission or operator-key signing.
- Vector/semantic memory, multi-provider routing, sandbox tiers beyond worktree.

## Canonical digest contract (load-bearing)

Anything that gets **signed** (the admitted plan digest, the receipt digest) MUST use a **stable canonical serialization** shared by Rust and TypeScript — reuse the `bp-ledger` `canonicalize.rs` path (`serde_json::to_vec` of a frozen field order), not insertion-order `JSON.stringify`. The current `planDigest` (`run-cli.ts:5752`) is replaced in S1. Repeating the same input at the same trusted base with the same evidence MUST produce the same `idempotencyKey`, `inputDigest`, and `planDigest`, and therefore the same signed admission identity.

**Lock this contract before S3 (hard pre-S3 gate, not a follow-up).** Once a `plan_admitted` event is signed and in production, a wrong wire shape forces a tape migration. Two concrete pre-flight requirements: (1) **map `u64` → TS `string` in typeshare** and regenerate fixtures — TS `number` cannot faithfully represent a Rust `u64`, so any signed payload field carrying one silently diverges across languages; (2) the **S2/S3 adversarial Codex pass must explicitly target byte-identical digest output** for the four new kinds (`plan_admitted`/`plan_receipt`/`activity_started`/`activity_completed`), not just "the tests pass."

## Tape event vocabulary (new kinds)

M2 adds four signed event kinds, each via the M1 add-event-kind procedure:

| Wire kind | Payload struct | Emitted at | Purpose |
|---|---|---|---|
| `plan_admitted` | `PlanAdmittedV1` | admit stage | operator-approved admission; the dispatch authority. Fields ≥ `plan_id`, `plan_digest`, `input_digest`, `trusted_base`, `decided_by` (operator identity), `decided_at`, `idempotency_key`, `authorized_next_step` |
| `plan_receipt` | `PlanReceiptRecordedV1` | receipt stage | terminal signed receipt. Fields ≥ `plan_id`, `admission_event_id`, `outcome`, `side_effects`, `result_digest`, `decided_at` |
| `activity_started` | `ActivityStartedV1` | before each I/O activity | write-ahead bracket. Fields ≥ `run_id`, `activity_id`, `activity_type` (`model`/`tool`/`command`), `input_digest` |
| `activity_completed` | `ActivityCompletedV1` | after each I/O activity | records the result for replay. Fields ≥ `run_id`, `activity_id`, `result_digest`, `result` (recorded model/tool output) |

`run_admission_recorded` is **unchanged** but is additionally mirrored to the tape (decision 2).

## Replay & crash-recovery contract

On kernel startup, scan storage for runs in `running` status; for each, replay the tape (`bp-replay` reconstructs state; new transitions track admit/receipt/activity phase). **The tape (`events.db`) is authoritative over the storage status field.** Resume rules:

| Last durable tape state | Resume action |
|---|---|
| no `plan_admitted` | not admitted → require operator re-approval (no silent dispatch) |
| `plan_admitted`, no execution | re-dispatch **without re-approval**; re-establish `will_execute_worker` trust **from the tape `plan_admitted` event**, not the lost in-memory `WeakSet` |
| mid-execute, an `activity_completed` is on the tape | read the recorded result; **do NOT re-invoke** the model/tool; continue from the next activity |
| executed, no `plan_receipt` | re-emit the signed `plan_receipt` |
| `plan_receipt`/`run_completed` on tape but `running` in storage | reconcile storage to complete; do **not** re-run |

Write-ahead ordering is mandatory: `activity_started` is appended (and signed) **before** the activity is invoked, so a crash mid-invoke is recoverable.

## Persistence & known-bug closures folded into M2

- The admission JSONL-sidecar→tape move must be **atomic with respect to the dispatch decision** (no split-brain where the receipt artifact exists but the tape event is missing).
- `createRunAdmissionReceiptInput` (`orchestrator.ts:394`) hardcodes `worktree_clean: true` — S4 replaces this with a **verified git status** (security-relevant; PlanForge mid-cycle worktrees may carry uncommitted artifacts).
- The `core.bare=true` workspace misconfig can fatal `execFileSync('git', …)` admission paths (see `MEMORY.md`); tests must guard against it.

## Implementation slices

Critical path: **S1 ∥ S2 → S3 → S4 → S5 → S6 → S7-HARNESS → S7a → S7b → S8**. S2 may start in parallel with S1 but rebases onto S1's canonical-digest contract before finalizing. Dependent slices stack on the prior slice branch (M1-style) or rebase on merge. S7 — the highest-complexity unbuilt slice and the literal precondition for the M6 crash-and-resume demo — is split into a test-harness task plus two implementation slices: the **crash-replay harness lands first** (so both halves and the M6 demo verify against it), then **S7a** (Rust `bp-replay` transitions) and **S7b** (kernel startup scan / resume / CLI).

### M2-S1 — `packages/planforge` extraction + runtime contract + canonical digest

Files likely to change:

- `packages/planforge/` (new): `src/{schema,compile,validate,preview,digest,index}.ts`, `package.json`, `tsconfig.json`, `test/`
- `apps/cli/src/run-cli.ts` (dry-run delegates to the package)
- `apps/cli/src/planforge-schema.ts` (re-export from / fold into the package)
- `apps/cli/test/fixtures/planforge/expected-plan.json` (golden output preserved)
- `.changeset/*.md` (minor — new package)

Acceptance:

- `packages/planforge` exports `PlanForgeInput`, `PlanForgePlan`, and the full `PlanForgeReceipt` as runtime types, plus `compile`/`validate`/`preview` functions.
- `buildplane planforge dry-run --input … --json` output equals the existing golden fixture (any digest change from canonicalization is a one-time, documented fixture update with the prior↔new digest equivalence shown).
- `planDigest`/`inputDigest` computed via the canonical serializer shared with the signed path.

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/planforge apps/cli/test/planforge-schema.test.ts
pnpm -C <worktree> exec vitest run apps/cli/test/run-cli.test.ts -t planforge
```

Review: 1 independent Reviewer (no L0 surface).

### M2-S2 — Admission-cycle + activity tape event vocabulary (Rust + TS)

Files likely to change:

- `native/crates/bp-ledger/src/kind.rs` (`PlanAdmitted`, `PlanReceiptRecorded`, `ActivityStarted`, `ActivityCompleted`)
- `native/crates/bp-ledger/src/payload/plan_lifecycle.rs` (new: `PlanAdmittedV1`, `PlanReceiptRecordedV1`), `payload/activity.rs` (new: `ActivityStartedV1`, `ActivityCompletedV1`)
- `native/crates/bp-ledger/src/payload/mod.rs`, `src/canonicalize.rs` (`kind_to_variant` + `payload_variant_name` arms)
- `native/crates/bp-ledger/tests/plan_lifecycle.rs`, `tests/activity.rs`
- `packages/ledger-client/src/payload.ts` (hand-edited union), `src/generated/index.ts` (typeshare), `fixtures/payload-variants.json`

Acceptance:

- the four kinds round-trip, canonicalize, and sign-on-append; the external verifier validates a tape containing them.
- fixture freshness is byte-stable on regeneration.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger plan_lifecycle activity
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
pnpm -C <worktree> exec vitest run packages/ledger-client/test/payload-drift.test.ts
```

Review: **2 (independent Opus Reviewer + adversarial Codex)** — L0 trust surface.

### M2-S3 — Admit stage: operator approval → signed `plan_admitted`

Files likely to change:

- `packages/planforge/src/admit.ts` (validate `PASS`, build `PlanAdmittedV1`, emit via `ledger-client`)
- `apps/cli/src/run-cli.ts` (`planforge admit <plan> --approve` subcommand; route the admitted path before the `--admit` block)
- admission store that mirrors `run_admission_recorded` onto the tape (coexist; `admission-receipts.ts` `appendAdmissionEvent` port)
- tests

Acceptance:

- admit on a `PASS` plan writes a signed `plan_admitted`; non-`PASS` fails closed with **no tape write**; idempotent (dedup by `idempotency_key` against the tape); records operator identity; signed by the kernel key; external verifier validates the event.

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/planforge/test/admit.test.ts test/ledger-integration/planforge-admit.test.ts
node scripts/verify-signed-tape.mjs --fixture <exported-admit-tape>
```

Review: **2 (Opus + Codex)** — L0.

### M2-S4 — Dispatch stage: admitted plan → `UnitPacket(provenance_ref)` → run loop

Files likely to change:

- `packages/kernel/src/run-loop.ts` (`UnitPacket.provenance_ref` required; `capability_bundle?`/`acceptance_contract?`/`trust_scope?` typed-optional), `src/packet.ts` (`parseUnitPacket`)
- `packages/kernel/src/orchestrator.ts` (thread `provenance_ref` into `createRunAdmissionReceiptInput`; gate dispatch on a prior `plan_admitted`; replace hardcoded `worktree_clean` with verified git status)
- `packages/planforge/src/dispatch.ts` + `apps/cli` `planforge dispatch <plan-id>`
- tests

Acceptance:

- dispatch of an admitted plan spawns one run/`UnitPacket` per `PlanForgeTask` in an isolated worktree with `provenance_ref` recorded in the packet and the admission receipt; dispatch of an unadmitted plan is rejected; `worktree_clean` reflects real git status.

Verification:

```bash
pnpm -C <worktree> exec vitest run test/ledger-integration/planforge-dispatch.test.ts packages/kernel/test/packet.test.ts
```

Review: 1 independent Reviewer (Codex if the admission-gate logic changes).

### M2-S5 — Activity bracketing: record model/tool results as signed tape events

Files likely to change:

- `packages/kernel/src/events.ts` (`activity-started`/`activity-completed` `ExecutionEvent` kinds mapped to ledger `activity_started`/`activity_completed`)
- `packages/kernel/src/orchestrator.ts` `executeOnce` (bracket every I/O activity; write-ahead `activity_started` to the tape **before** invoke; `activity_completed` with the recorded result after)
- `packages/adapters-models`, `packages/adapters-tools` (surface results into the `activity_completed` payload)
- tests

Acceptance:

- every model/tool/command activity is bracketed; `activity_completed` carries the recorded result + digest; events are on the signed tape; `activity_started` is durably appended before invocation.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger activity
pnpm -C <worktree> exec vitest run test/ledger-integration/activity-bracketing.test.ts
```

Review: **2 (Opus + Codex)** — L0.

### M2-S6 — Receipt stage: signed `plan_receipt` + live-tape export

Files likely to change:

- `packages/planforge/src/receipt.ts` + `packages/kernel/src/orchestrator.ts` `finalizeRun` hook (emit `plan_receipt` chaining to the `plan_admitted` event id; real `sideEffects`/`generatedAt`/`admittedBy` = signing-key identity)
- `native/crates/bp-cli/src/ledger_cli.rs` (+ `bp-ledger`): `buildplane ledger export-signed-tape` (live `events.db` → `buildplane.signed-tape.v1`) — the M1 follow-up the verifier needs
- tests

Acceptance:

- a completed dispatch emits a signed `plan_receipt` chaining to the admission event and recording actual side effects; `export-signed-tape` produces a tape the external verifier validates end-to-end (admit → activities → receipt).

Verification:

```bash
pnpm -C <worktree> exec vitest run test/ledger-integration/planforge-receipt.test.ts
buildplane ledger export-signed-tape --run-id <id> --out <dir> && node scripts/verify-signed-tape.mjs --fixture <dir>
```

Review: **2 (Opus + Codex)** — L0.

### M2-S7-HARNESS — Crash-injection replay test harness (lands first)

S7 is the highest-complexity unbuilt slice and the literal precondition for the M6 crash-and-resume demo, so the **deterministic crash-injection harness is written first as a standalone test-infrastructure task** — both S7a and S7b verify against it, and so does the S8 vertical slice. It changes no production code.

Files likely to change:

- `test/ledger-integration/crash-harness.ts` (new): a deterministic fault-injection utility that halts a run at named tape boundaries (`admit↔execute`, mid-execute after an `activity_completed`, `execute↔receipt`), then boots a **fresh kernel** against the same `events.db` and asserts tape state at each kill point
- `test/ledger-integration/crash-harness.test.ts` (new): self-tests for the harness against fixture tapes
- `test/fixtures/` (crash-point tapes)

Acceptance:

- the harness can deterministically stop a run at each named tape boundary and resume a fresh kernel against the same `events.db`, asserting the durable tape state at every kill point; **no production-code change**; the harness exposes a stable API consumed by S7a/S7b/S8.

Verification:

```bash
pnpm -C <worktree> exec vitest run test/ledger-integration/crash-harness.test.ts
```

Review: **1 independent Reviewer** — test infrastructure only, no L0 trust surface, **no adversarial Codex** (per the tiered review ceremony).

### M2-S7a — Replay engine: transitions + recorded-result state (Rust `bp-replay`)

Files likely to change:

- `native/crates/bp-replay/src/transitions.rs`, `src/state.rs` (transitions for the four new kinds; `ReplayState` cycle phase + recorded activity results)
- `native/crates/bp-replay/tests/transitions.rs`

Acceptance:

- replaying a tape containing `plan_admitted` / `activity_started` / `activity_completed` / `plan_receipt` deterministically reconstructs cycle phase + recorded activity results; the kind match is **exhaustive** (no `_` catch-all — guard against the #163-class break where a new kind silently no-ops); fast-forward is idempotent.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay transitions
# enum-variant slice → also run the whole workspace (no -p) to catch downstream match breaks:
cargo test --manifest-path native/Cargo.toml
```

Review: **2 (Opus + Codex)** — L0 replay surface.

### M2-S7b — Kernel crash recovery: startup scan + resume + skip-reinvocation

Files likely to change:

- `packages/kernel/src/orchestrator.ts` (startup scan for `running` runs; resume per the recovery contract; read activity result from the tape and **skip re-invocation**; re-establish `will_execute_worker` trust from the tape `plan_admitted` event)
- `apps/cli/src/run-cli.ts` (startup recovery entry / `buildplane resume`)
- crash-replay integration tests built on the **S7-HARNESS**

Acceptance:

- kill the kernel between admit↔execute, mid-execute (after an `activity_completed`), and execute↔receipt; restart; replay resumes at the correct point; the recorded model/tool result is reused (the model is **not** re-invoked); final state is identical; no duplicate work; no re-approval.

Verification:

```bash
pnpm -C <worktree> exec vitest run test/ledger-integration/crash-replay.test.ts
```

Review: **2 (Opus + Codex)** — L0 + kernel recovery.

### M2-S8 — M2-GATE: vertical slice + receipt + docs

Files likely to change:

- `test/` end-to-end vertical slice (toy fixture; one injected mid-cycle crash; external-verifier on the exported tape)
- `docs/architecture/planforge.md` (cycle complete; remove the non-dry-run "not implemented" list; document the admit→receipt + replay contract)
- `docs/operations/2026-MMDD-m2-gate-receipt.md`
- `.changeset/*.md` (minor)

Acceptance:

- full `compile → validate → preview → admit → dispatch → execute → receipt` passes with a recovered mid-cycle crash, all events externally verifiable; CI `verify` green.

Verification:

```bash
pnpm -C <worktree> exec vitest run test/workflow/planforge-m2-vertical-slice.test.ts
# Full M2 gate (CI verify job is canonical).
```

Review: **2 (Opus + Codex)** + M2-GATE receipt.

## Full M2 gate

Before any M2 implementation PR is marked ready for review:

```bash
pnpm lint        # CI verify job is canonical — biome check . OOMs locally in WSL
pnpm typecheck
pnpm test        # native:build + vitest --run
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen-fixtures
git diff --exit-code   # fixtures byte-stable on regeneration
```

For slices touching generated TS bindings, also:

```bash
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```

Per-slice process: TDD (RED → GREEN → commit); local tests via `pnpm -C <worktree> exec vitest run` (**never** `pnpm --filter buildplane test` — alias trap); changeset only if a published `packages/*`/`apps/*` surface changes; conventional commits with a lowercase verb (commitlint); solo PRs need admin-merge; **route every push/PR through a fresh subagent** (whole-repo `biome check .` OOMs in the orchestrator session); `EnterWorktree(baseRef=head)` requires a prior FF so the worktree cuts from current `origin/main`.

## Review requirements

M2 touches L0/L1 trust surfaces. Every implementation PR requires an independent read-only Reviewer (Opus, fresh session) verdict `PASS` with the reviewed SHA equal to the PR head. **L0 slices (S2, S3, S5, S6, S7a, S7b)** additionally require an **adversarial Codex reviewer** and are **not auto-merge eligible** — do not apply `buildplane:auto-merge`. The **S7-HARNESS** task is test-infrastructure only (no L0 trust surface) and takes a single independent Reviewer — no adversarial Codex. Docs/fixture-only changes may follow the operating-model auto-merge criteria.

## First next task

S1 (#161) and S2 (#163) are merged on `main`. **M2-S3 (admit stage)** is next: operator approval → signed `plan_admitted` via `buildplane planforge admit <plan> --approve`. Before starting S3, **lock the cross-language digest contract** (see "Canonical digest contract (load-bearing)" above) — the `u64 → string` typeshare fix and byte-identical digest output are a hard pre-S3 gate, not a follow-up, because S3 is the first slice to sign an admission identity in production.
