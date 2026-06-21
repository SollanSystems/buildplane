# M4-GATE — Acceptance contract

| | |
|---|---|
| **Status** | Gate CONFIRMED + code-clean review; **pending close-PR admin-merge** (CI/merge rows finalized post-merge) |
| **Date** | 2026-06-21 |
| **Gate** | `M4-GATE` |
| **Milestone** | M4 — Acceptance contract (diff-scope + CI/lint check gating on finalization) |
| **Close branch** | `feat/m4-s4-gate` (cut from `origin/main` @ `2704f4f`) |
| **Close commit** | `____` (S4 close commit on this PR) |
| **Scope** | S4 GATE — end-to-end workflow test + architecture doc + this receipt + CLAUDE.md close |

## Verdict

**M4 acceptance enforcement is COMPLETE and enforceable.** When a PlanForge run is dispatched
with `--enforce-acceptance`, the kernel derives a per-task acceptance contract (diff-scope +
check commands), runs the checks in the worktree, **re-collects** the changed files *after* the
checks, evaluates the contract, and appends a signed `acceptance_recorded` L0 event **write-ahead**
— all **before** the merge. A passed verdict proceeds to the existing squash-merge; a rejected
verdict short-circuits with **no merge** and preserves the worktree as the quarantine artifact.

The full M4 gate is green and an independent adversarial 3-lens review (bypass · correctness ·
acceptance) returned **CONFIRMED**: there is **no reachable path that merges an out-of-scope or
check-failing run**. The milestone-close ceremony is closed by this receipt + the CLAUDE.md
milestone-map update committed alongside it.

## Slice ledger

| Slice | Subject | Landed as |
|---|---|---|
| — | M4 spec + S1 TDD plan | PR #191 (`df40326`) |
| S1 | `packages/policy` acceptance contract schema + pure evaluator (`AcceptanceContractV0`, `contract_digest`, `deriveAcceptanceContract`, `evaluateAcceptanceContract`) | PR #192 (`dc740c3`); receipt `2026-06-19-m4-s1-acceptance-finalization-gate-slice-receipt.md` |
| S2 | L0 signed `acceptance_recorded` event (Rust+TS derivation, bp-replay transition, digest guards, fixtures) | PR #194 (`e61e3f2`); receipt `2026-06-19-m4-s2-acceptance-recorded-slice-receipt.md` |
| S3 | finalization gate wiring + independent check runner + emit + quarantine + CLI `--enforce-acceptance` dispatch | PR #196 (`4e29efd`) |
| — | version packages | PR #195 (`74008ce`) |
| S3-fix | **diff-scope fail-open closed** — reject when the worktree HEAD advances off the recorded base SHA (CRITICAL, surfaced by the S3 adversarial bypass review) | PR #198 (`2704f4f`) |
| S4 | M4-GATE: e2e workflow test · architecture doc · this receipt · CLAUDE.md close | this PR — `test/workflow/acceptance-contract-m4-gate.test.ts`, `docs/architecture/acceptance-contract.md` |

## Full-gate evidence

S4 is **docs/test-infra only** — it adds no product code, no Rust, no new event kind, and no
payload change, so the whole-workspace `cargo test` and ledger-fixture-freshness rows are
unaffected by this slice (verified: `git status` shows only the two new files + this receipt +
CLAUDE.md). The CI `verify` + `Analyze` jobs on the PR are the canonical full-suite closure.

```
M4-GATE workflow test     4 passed (4) · 0 failed   (re-run twice; independently re-run by the adversarial reviewer)
cargo test (whole native) unaffected — no Rust change this slice (CI-canonical)
ledger fixture freshness  unaffected — no payload change this slice (CI-canonical)
pnpm check / CI verify     canonical on the PR head (rows finalized post-merge)
```

## Acceptance evidence

`test/workflow/acceptance-contract-m4-gate.test.ts` drives the **real** `planforge dispatch
--enforce-acceptance` path (real native binary, real git worktrees, real signed `events.db`) over
the toy `goal-input.md` fixture, steering the run via a `pnpm` shim prepended to PATH, and proves
all three terminal outcomes plus replay reconstruction:

- **(a) in-scope diff + green checks** → `acceptance_recorded{passed}`, diff-scope passed, run **merges** (project-root git log carries the merge; receipt `completed`).
- **(b) out-of-scope diff** (shim exits 0 but writes `src/sneaky.ts` outside `docs/**` scope) → `acceptance_recorded{rejected, diff_scope_status:"blocked", out_of_scope_files:["src/sneaky.ts"]}` with all checks still green, **no merge** (project-root log unchanged, file absent from root), **worktree preserved** under `.buildplane/workspaces/<runId>/` carrying the artifact. This exercises the **post-check re-collection** — the load-bearing guard against a check that mutates the tree then exits 0.
- **(c) failing check** (shim exits 1) → `acceptance_recorded{rejected}` with a failed check, **no merge**, no `completed` receipt.

Replay reconstruction: after `ledger export-signed-tape`, the **external verifier**
(`scripts/verify-signed-tape.mjs`, invoked as a child `node` process — no hand-rolled signatures)
re-verifies canonical hash + Ed25519 of every signed event and confirms the ordered chain
`plan_admitted → acceptance_recorded → plan_receipt` (ids strictly increasing; the verdict's
`admission_event_id` chains back to the signed `plan_admitted`).

## Review ceremony (S4 — L3 + adversarial GATE)

- **L3 self-review:** docs/test-infra only; no product code modified, no changeset (M1-S7 precedent).
- **Adversarial GATE review (3-lens, independent Opus):** **VERDICT: CONFIRMED.**
  - **Bypass:** test drives the real production path (not a mock); `evaluateAndRecordAcceptanceAsync` runs inside the retry loop **before** `finalizeRun → commitAndMergeWorkspace`; a `rejected` decision returns early with `workspaceStatus:"retained"` and never reaches the merge call. "No merge"/"worktree preserved" asserted against **real filesystem + git-log state**, not a return value.
  - **Correctness:** the post-check re-collection (`orchestrator.ts:497-500`) is confirmed load-bearing and is exactly what case (b) exercises; the real external verifier is used for replay; no tautologies, `.skip`/`.only`, or over-mocking; reviewer re-ran the test 4/4 green.
  - **Acceptance:** S4 matches the spec checklist; `docs/architecture/acceptance-contract.md` spot-checked accurate against code on 4 claims; the known sync-path follow-up is disclosed.
  - **Blocking issues:** none.

## Memory program freeze (restated)

Outcome routing and memory-promotion expansions remain **OFF / opt-in / default-OFF** —
`run_outcomes` has **no consumer**; main behavior is byte-for-byte unchanged. **M4 core does not
unfreeze the memory program** (per the spec); the designated single rent-paying integration —
feeding `run_outcomes` into acceptance/trust scoring — is a *later, out-of-scope* M4 slice. M4 core
is memory-neutral.

## Deferred (tracked, non-blocking)

- **Sync `runPacket` acceptance path is unguarded** — `evaluateAcceptanceBeforeFinalization` has no HEAD-advance guard and reads `currentReceipt.changedFiles` rather than re-collecting, and does not emit `acceptance_recorded`. **Not reachable today** (PlanForge dispatch routes through `runPacketAsync` only, per CLAUDE.md), but a latent fail-open if anything ever routes acceptance through the sync path. Flagged by both the S3-fix and GATE adversarial reviews — keep the two paths from diverging silently.
- **`run_outcomes` trust-scoring consumption** (the memory-unfreeze rent-payer) — a later M4 slice, out of this gate's scope.
- **Observed-write reconciliation** in `plan_receipt.side_effects` (declared vs. actual) — later M4 slice.
- **`code-edit` side-effect vocabulary** (`packages/**/src/**`, `packages/**/test/**`) + argv0-only `run_command` ceiling tightening — deferred slice carried from M3; the prerequisite for real `planforge admit` **dogfooding** (open fork) and the M6 demo.
- **LOW (S3-fix review):** the `currentHeadSha ?? "unreadable"` reason-string fallback is dead under the guard condition — harmless defensive formatting.

## PR gate

- PR: single M4-close PR (S4 GATE). Base `main`, head `feat/m4-s4-gate`.
- L3 docs/test-infra — but per the milestone-close convention, **operator admin-merge**; no `buildplane:auto-merge` label.

## CI evidence (finalized post-merge)

| Check | Status | Run URL |
|---|---|---|
| `verify` (PR head) | pending | `____` |
| `Analyze (javascript-typescript)` | pending | `____` |

Post-merge `main` CI on the squash commit is the canonical ongoing-health gate.
