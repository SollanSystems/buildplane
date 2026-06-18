# M4 Acceptance Contract Spec

> **Status:** design approved 2026-06-18. Supersedes nothing; first M4 design doc.
> **Milestone:** M4 — Acceptance Contract (diff-scope + CI + lint gating on finalization).
> **Predecessor:** M3 Capability Broker (`docs/superpowers/specs/2026-06-10-capability-broker-m3.md`), closed at M3-GATE (`docs/operations/2026-06-15-m3-gate-receipt.md`, `main` tip `403f91f`).
> **North-star spec:** `docs/superpowers/specs/2026-05-21-buildplane-v05-design.md` line 266 — *"Acceptance Contract validator (diff scope + CI + lint). Receipt verification by tape replay. Quarantine path for failed contracts."*

## Goal

Make the kernel **independently verify a completed run against an acceptance contract before the worktree is merged**, and record the verdict as a signed tape event. M4 is the finalization-time mirror of M3: M3 gates **per-tool-call, pre-side-effect**; M4 gates **once at finalization, over the whole diff**, fail-closed. This is the trust-thesis payoff — *"advance only when reality matches the contract"* — and the first place the M3 capability bundle is verified post-hoc (declared surface ⊇ actual diff) rather than enforced pre-call.

## Current state (on `main`, post M3-GATE)

- **Most machinery already exists.** `finalizeRun` (kernel `orchestrator.ts:888`) has a proven pre-merge rejection path: `evaluateArchitectureDiffScope(changedFiles, gate)` (`packages/policy/src/diff-scope.ts:17`) → `RejectedPolicyDecision{kind:"architecture.diff_scope"}` short-circuits **before** `commitAndMergeWorkspace` (`orchestrator.ts:~1014`). The worktree is still on disk at that point.
- **The diff-scope gate is dead code in the live path.** `loadCliOrchestrator` (`run-cli.ts:~1106`) passes no `profileRegistry`, so `resolvedProfile` is always `undefined` and the gate at `orchestrator.ts:~1416` never fires. Only integration/unit tests configure it.
- The actual post-execution diff is already captured: `collectWorkspaceChangedFiles` (`orchestrator.ts:296`) runs `git diff --name-only HEAD` + `git ls-files --others` and stores `currentReceipt.changedFiles`.
- The plan's declared surface is `capability_bundle.fsWrite` globs, produced per-task by `buildDefaultCapabilityBundleForTask` (`packages/planforge/src/bundle.ts:62`) and union'd per-plan by `buildDefaultCapabilityBundleForPlan` (`bundle.ts:87`). This is **shape-compatible** with `ArchitectureDiffScopeGate.allowedPaths` (`packages/kernel/src/policy.ts:37`).
- `UnitPacket.acceptance_contract` is reserved (`run-loop.ts:52`, typed `unknown`, unused). `RejectedPolicyDecision` already carries `kind:"architecture.diff_scope"` (`run-loop.ts:97`).
- `plan_receipt` (`PlanReceiptRecordedV1`) is the upstream signed anchor; its `side_effects` carries **declared** scopes only — observed-write reconciliation was explicitly deferred to M4 (`run-cli.ts:~3789`).

## Architecture decisions (defaults for M4 — change only via operator fork)

Resolved with the operator on 2026-06-18:

1. **Scope = core gate + signed event.** `AcceptanceContractV0` + a signed `acceptance_recorded` event + diff-scope + CI/lint gating, fail-closed before merge, minimal quarantine. Deferred (see Non-goals): `run_outcomes` trust scoring, observed-write reconciliation, code-edit vocabulary.
2. **Verdict source = independent kernel re-run.** At the gate (worktree alive) the kernel itself runs the contract's check commands and digests the real results into the signed event. The worker's own `receipt.exitCode` is **not** trusted as the acceptance signal — the kernel re-verifies against reality.
3. **Accept = gate the existing merge.** `finalizeRun`'s auto-merge-on-success is retained, but only after the contract passes. Operator-approval inbox is M5; M4 does not introduce a `result-ready`/approve handoff.
4. **code-edit vocabulary is a separate (deferred) slice;** the gate is wired and tested on the existing doc-oriented toy fixture first. Real dogfooding through `planforge admit` is the M6 demo.

Sub-choices (defaults; flagged for review):

5. **Acceptance logic lives in `packages/policy`**, not a new `@buildplane/acceptance-contract` package — the v0.5 spec places acceptance at "L7 — Policy", `diff-scope.ts` already lives there, and a new `apps/cli`-imported package would trigger the published-bootstrap-closure dance for no benefit.
6. **Per-task grain.** The contract is derived per-task from the task's `capability_bundle`, evaluated per-task at the gate — preserving the least-privilege guarantee already on each dispatched packet. Plan-level aggregate checks are a later option.
7. **One event with an outcome enum** (`acceptance_recorded`, `outcome: passed|rejected`), mirroring `PlanReceiptRecordedV1{outcome}` — not two separate kinds.
8. **Minimal quarantine** = no-merge + preserved worktree (the inspection artifact) + signed `acceptance_recorded{rejected}`. Operator quarantine-release mechanics are deferred to M5.
9. **The contract is not separately signed.** It is deterministically derivable from the already-signed `plan_admitted`; the signed `acceptance_recorded` event carries a `contract_digest`, so tape replay reconstructs the contract from `plan_admitted` + that digest. The gate is driven through the runtime **policy profile**, not by populating the L0 `UnitPacket.acceptance_contract` wire field (which stays reserved).

## Non-goals for M4

- `run_outcomes` trust scoring / per-pack success-rate consumption (the designated *first consumer*, but a later M4 slice — the memory freeze stays until then; M4 core is memory-neutral).
- Observed-write reconciliation in `plan_receipt.side_effects` (declared vs. actual) — later M4 slice.
- `code-edit` side-effect vocabulary (`packages/**/src/**`, `packages/**/test/**`) + argv0-only `run_command` ceiling tightening — deferred slice, prerequisite for the M6 dogfood.
- Operator quarantine-release flow / approval inbox — M5.
- `result-ready` event + operator-gated merge handoff — M5.
- Semantic ("no out-of-scope behavior") diff analysis — v0.5 is file-path-based only; semantic is v1.
- Plan-level aggregate acceptance checks (e.g. repo-wide CI) — per-task is the M4 grain.

## Acceptance contract schema (v0)

In `packages/policy`. Derived deterministically from the admitted plan, per-task:

```ts
interface AcceptanceContractV0 {
  contract_version: "v0";
  diff_scope: { allowed_globs: string[]; denied_globs?: string[] }; // from task capability_bundle.fsWrite
  checks: { command: string }[];                                    // deduped from task.verificationCommands
}
```

- `deriveAcceptanceContract(plan, task): AcceptanceContractV0` — `allowed_globs` = the task's `capability_bundle.fsWrite`; `checks` = the task's `verificationCommands`, order-preserved and de-duplicated.
- `contract_digest = "sha256:" + sha256Hex(canonicalJson(contract))` — the `sha256:` is a content-address **label** on the output, not part of the hashed input — using **the same `canonicalJson` as `planDigest`/`inputDigest`** (`packages/planforge/src/digest.ts`), matching the M3 `bundleDigest` convention. Lock this digest before any payload references it (mirrors M3-S1 locking `CapabilityBundleV0`).

## Acceptance evaluation (pure)

In `packages/policy`:

```ts
type AcceptanceEvidence = {
  changedFiles: string[];
  checkResults: { command: string; exitCode: number }[];
};
type AcceptanceVerdict =
  | { outcome: "passed" }
  | { outcome: "rejected"; diffScopeStatus: "passed" | "blocked"; outOfScopeFiles: string[]; failedChecks: { command: string; exitCode: number }[] };

function evaluateAcceptanceContract(contract: AcceptanceContractV0, evidence: AcceptanceEvidence): AcceptanceVerdict;
```

- The diff-scope arm **reuses `evaluateArchitectureDiffScope(changedFiles, {allowedPaths: contract.diff_scope.allowed_globs, deniedPaths: contract.diff_scope.denied_globs})`** — do not fork it.
- The checks arm: any `exitCode !== 0` → rejected.
- Pure and synchronous: it interprets evidence; it does **not** run commands or emit events.

## The signed tape event (L0)

One event, outcome enum. **Every numeric field is a `String`** (the U64 → TS-`number` wire hazard — `admission_event_id`, `exit_code`, `evaluated_at`):

```
kind: "acceptance_recorded"
payload AcceptanceRecordedV1 {
  plan_id: String,
  admission_event_id: String,              // chains to plan_admitted; String, matching PlanReceiptRecordedV1.admission_event_id
  contract_digest: String,                 // sha256: of the evaluated contract
  outcome: String,                         // "passed" | "rejected"
  diff_scope_status: String,               // "passed" | "blocked"
  out_of_scope_files: Vec<String>,         // empty on pass
  checks: Vec<AcceptanceCheckResultV1>,    // { command: String, exit_code: String, status: String }
  evaluated_at: String,                    // RFC3339
}
```

Multi-file derivation (mirrors how `capability_denied` was added — see CLAUDE.md §"Adding a new event kind to bp-ledger"):

1. `native/crates/bp-ledger/src/kind.rs` — add `AcceptanceRecordedV1` variant + `as_wire()` arm + exhaustive `as_wire_matches_serde_output` test arm.
2. `native/crates/bp-ledger/src/payload/acceptance.rs` (new) — `#[typeshare]` structs, all-`String` fields, no `u64`/`i64`.
3. `native/crates/bp-ledger/src/payload/mod.rs` — `pub mod acceptance` + add to the `Payload` enum.
4. `native/crates/bp-ledger/src/canonicalize.rs` — arms in both `payload_variant_name` and `kind_to_variant`.
5. `native/crates/bp-ledger/tests/acceptance.rs` (new) — round-trip + canonicalize-by-kind + sign-on-append-and-verify (mirror `tests/capability_denied.rs`).
6. `native/crates/bp-replay/src/transitions.rs` — add an arm to the exhaustive `match` in `apply()` that records the acceptance outcome into the PlanForge cycle state (no new phase enum unless the cycle state demands one). **Run whole-workspace `cargo test --manifest-path native/Cargo.toml` (NO `-p`) — the bp-replay exhaustive-match break is silent under scoped runs (PR #163).**
7. `pnpm ledger:gen` → regenerates `packages/ledger-client/src/generated/`.
8. **Hand-edit** `packages/ledger-client/src/payload.ts` — add `| { AcceptanceRecordedV1: AcceptanceRecordedV1 }` to the union.
9. `pnpm ledger:gen-fixtures` → regenerate `fixtures/payload-variants.json`.
10. `packages/ledger-client/test/payload-drift.test.ts` — bump the variant count + add the `kindName` switch case (the `never` default makes omissions a compile error).
11. Extend the digest-contract guards (`native/crates/bp-ledger/tests/m2_digest_contract.rs` + `packages/ledger-client/test/m2-signed-identity-contract.test.ts`) to cover the new payload **in the same slice** — not as a follow-up.
12. `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures` clean.

## Finalization gate + quarantine

Insertion at **Point A** — in `runPacketAsync`, after `collectWorkspaceChangedFiles`, **before** `finalizeRun → commitAndMergeWorkspace`. The worktree is alive; a rejection never touches the project root (fail-closed for free).

Flow (per task, when an acceptance contract is resolved for the packet):

1. Run each `contract.checks[].command` in `ctx.workspace.path` via a command runner (the orchestrator already shells out for git — extend that), collecting `{command, exitCode}`.
2. Assemble `AcceptanceEvidence{changedFiles: currentReceipt.changedFiles, checkResults}`.
3. `verdict = evaluateAcceptanceContract(contract, evidence)`.
4. Emit signed `acceptance_recorded` via an injected `acceptancePort` (wired in the CLI to the ledger emitter), recording the verdict. **The event is appended and signed before the merge** — replay-authoritative, consistent with M2 write-ahead discipline.
5. **passed →** proceed to the existing `finalizeRun → commitAndMergeWorkspace`.
6. **rejected →** call `finalizeRun` with a pre-evaluated `RejectedPolicyDecision{kind:"acceptance.contract", ...reasons}` (reuses the proven short-circuit — no merge), **preserve the worktree** (do not `deleteWorkspace`) as the quarantine artifact, mark the run quarantined. The dispatch loop breaks on the first non-passed task (same chain-break rule as today).

Wiring (the missing plumbing): at `planforge dispatch` in `run-cli.ts`, per task — `deriveAcceptanceContract(plan, task)` → build a `planforge-<planId>-<taskId>` `PolicyProfile` carrying it in a new `trustGates.acceptanceContract` slot → assemble a `profileRegistry` → pass it to `loadCliOrchestrator` → set `packet.unit.policyProfile` to that profile name. Wire `acceptancePort` to the ledger emitter (an `emitAcceptanceRecorded` helper in `apps/cli`, mirroring `ledger-capability-denied.ts`).

`RejectedPolicyDecision` gains `kind:"acceptance.contract"` (a runtime decision type in `run-loop.ts`/`policy.ts`; **not** a tape-wire shape — the durable record is the `acceptance_recorded` event). `TrustGateConfig`/`PolicyProfile` gain `acceptanceContract?: AcceptanceContractV0`.

## Implementation slices

### M4-S1 — `packages/policy` acceptance contract schema + pure evaluator
- `AcceptanceContractV0` type; `deriveAcceptanceContract(plan, task)`; `contract_digest` via shared `canonicalJson`.
- `evaluateAcceptanceContract(contract, evidence)` reusing `evaluateArchitectureDiffScope`.
- Extend `RejectedPolicyDecision` with `kind:"acceptance.contract"`; add `trustGates.acceptanceContract` to `TrustGateConfig`/`PolicyProfile`.
- **Tests (RED→GREEN):** derive-from-plan determinism + digest stability; diff-scope pass/block; check pass/fail; contract is byte-identical across two derivations of the same plan.
- **Tier:** L1 — 1 independent reviewer. **Changeset:** yes (`packages/policy` is published).

### M4-S2 — L0 signed `acceptance_recorded` event
- The full 12-step Rust+TS derivation above, including bp-replay transition + digest guards + drift test + fixtures.
- **Tests:** Rust round-trip/canonicalize/sign-verify; TS payload-drift; digest-contract guards; whole-workspace `cargo test`; fixture freshness `git diff --exit-code`.
- **Tier:** **L0 — full 4-role** (implementer TDD self-verify + independent Opus reviewer in a fresh session + adversarial Codex + independent acceptance-criteria verifier). Not auto-merge eligible; operator admin-merge. **Changeset:** yes (`packages/ledger-client`).

### M4-S3 — finalization gate wiring + independent check runner + emit + quarantine
- Orchestrator: resolve `trustGates.acceptanceContract`; run the check commands in the worktree; assemble evidence; call `evaluateAcceptanceContract`; emit `acceptance_recorded` via `acceptancePort`; on reject → `RejectedPolicyDecision{acceptance.contract}` (no merge) + preserve worktree + mark quarantined.
- CLI: per-task contract derivation, `profileRegistry` + `policyProfile` wiring into `loadCliOrchestrator`, `emitAcceptanceRecorded` helper.
- **Tests (RED→GREEN):** in-scope diff + green checks → `acceptance_recorded{passed}` + merge occurs; out-of-scope diff → `{rejected}` + no merge + worktree preserved; failing check → `{rejected}` + no merge; absent contract → unchanged behavior (opt-in, fail-open-when-unconfigured, fail-closed-when-configured).
- **Tier:** L1/L2 — 2-role (independent Opus reviewer) **+ adversarial bypass review** (the gate is a fail-closed trust boundary; a bypass defeats it — mirrors the M3 enforcement slices). **Changeset:** yes (`apps/cli`, `packages/kernel`). Heed the published-bootstrap closure if a new `packages/*` entrypoint is imported by `apps/cli`.

### M4-S4 — M4-GATE: end-to-end integration + receipt + docs
- `test/workflow/acceptance-contract-m4-gate.test.ts`: the real dispatch+finalization path over the toy fixture — pass→merge, out-of-scope→reject+quarantine+no-merge, red-check→reject — proving replay reconstructs `plan_admitted → acceptance_recorded → plan_receipt`.
- `docs/architecture/acceptance-contract.md` (new) + the GATE receipt `docs/operations/2026-06-18-m4-gate-receipt.md`.
- Update CLAUDE.md milestone table (M4 ✅) + the M4 slice archive line.
- **Tier:** L3 — single self-review for the docs/test-infra, **plus** the full-suite + adversarial GATE review (whole-workspace `cargo test` + full vitest + fixture freshness + an independent bypass/correctness/acceptance review, mirroring the M3-GATE 3-lens workflow). **Changeset:** none (docs/test-infra only — M1-S7 precedent).

## Full M4 gate

`pnpm check` equivalent + the CI `verify` + `Analyze` jobs green; whole-workspace `cargo test --manifest-path native/Cargo.toml`; fixture freshness clean; the M4-GATE workflow test green; the adversarial GATE review verdict CONFIRMED for the fail-closed boundary (no reachable path that merges an out-of-scope or check-failing run).

## Review requirements (M4)

| Slice | Tier | Reviewers |
|---|---|---|
| M4-S1 | L1 | 1 independent Opus reviewer |
| M4-S2 | **L0** | Full 4-role (Opus reviewer + adversarial Codex + acceptance-criteria verifier) |
| M4-S3 | L1/L2 | 2-role + adversarial bypass review of the fail-closed gate |
| M4-S4 | L3 | Self-review + full-suite + adversarial GATE review |

L0/L1 solo PRs are not auto-merge eligible (no `buildplane:auto-merge`); operator admin-merge. Reviewer verdict must be `PASS` with the reviewed SHA equal to the PR head.

## Memory program

M4 **core does not unfreeze the memory program.** `run_outcomes` trust-scoring consumption — the designated first rent-paying integration — is a *later* M4 slice, out of this spec's scope. M4 core is byte-for-byte memory-neutral; the freeze (opt-in / default-OFF, no consumer) holds until that slice. When it lands it wires exactly one `--outcome-routing-enabled`-class key feeding `run_outcomes` into acceptance/trust scoring.

## First next task

Hand this spec to the writing-plans skill to produce the M4-S1 TDD task plan. M4-S1 is the foundation (schema + pure evaluator + digest lock); it has no L0 surface and unblocks S2 (the event) and S3 (the wiring). Do **not** start S2 until S1's `AcceptanceContractV0` + `contract_digest` are locked.
