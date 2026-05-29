# Buildplane Branch & Auto-Merge Preflight Snapshot — 2026-05-29 (M2-PREP-1)

## Purpose

Refreshes the stale [2026-05-22 snapshot](./2026-05-22-branch-inventory-and-auto-merge-preflight.md) against current `origin/main`, per Kanban card **M2-PREP-1**. Establishes the salvage reality before M2 PlanForge kickoff. **Read-only:** no branch was deleted, renamed, force-pushed, closed, or modified while producing this note.

## Mainline state

- `origin/main`: `8a98ea634` (was `86cc2d3` in the 2026-05-22 snapshot — ~55 commits of M1-S2…S7, Phase-1/Phase-2 memory, and releases have landed since).
- M1 (per-event signing) slices **S1–S7 complete on `main`**; M1-GATE signed.
- Open PRs at snapshot: **#159** (`docs(ops): M1-GATE receipt`, docs-only, awaiting operator merge). Verify with `gh pr list` before acting.

## Auto-merge probe preflight

```bash
node scripts/ci/pr-auto-merge-eligibility.mjs --pr 158 --review-pass --json
```

- `decision: RECONCILE_ALREADY_MERGED` (PR #158 already merged).
- Surface intact — returns `autoMergeOptIn / blockers / checks / deployments / eligible / review / status`. The probe is callable and the eligibility surface is healthy. For a live candidate, rerun with `--expected-head <sha>` plus the required approval flags.

## Headline change vs 2026-05-22: the admission lineage is fully consolidated on `main`

The 2026-05-22 snapshot flagged `bp6b-run-loop-admission-wiring` + the local BP5/BP6 worktrees as admission/run-loop salvage to inspect before M2. **That work has since landed on `main`:**

- Mainline commits: **#133** (`feat(ledger): add run admission event contract`) and **#138** (`feat(kernel): expose admission recorded payload helper`), plus run-loop follow-ons.
- `main` carries the full admission surface: `packages/kernel/src/admission-receipts.ts` (~35 KB), `packages/kernel/test/orchestrator-admission.test.ts` (~13 KB), admission-receipt fixtures (`pass` / `insufficient-evidence` / `unsafe-to-run`), `native/crates/bp-ledger/tests/run_admission.rs`, and docs `run-admission-receipts.md` (~20 KB) + `bp6a-run-loop-admission-checkpoint.md`. `orchestrator.ts` / `run-cli.ts` are saturated with admission wiring (80 / 71 references).
- The local BP5/BP6 worktrees (`.worktrees/bp5bf-*`, `t_ff479f8e`, `t_f1b97884`, `t_402505c9`) and PlanForge worktrees (`planforge-*`) from the 2026-05-22 snapshot are **gone** (pruned since).

→ **Implication:** M2 PlanForge does not need to salvage the admission stack. Admission consolidation is done.

## Remote branch inventory (`origin`, 2026-05-29)

| Branch | SHA | Classification |
|---|---|---|
| `bp6b-run-loop-admission-wiring` | `4609511` | **FULLY SUPERSEDED.** Its 9-commit admission stack (bp5a/bp5b/bp5bf/bp6a + run-loop wiring) is on `main` via #133/#138 + follow-ons; merge-base is 55 commits stale. Prune candidate — **no salvage**. |
| `feat/m1-s4-keyring-signing` | `bb440a9` | Merged (#150) — lingering squash head. Prunable. |
| `feat/phase2-s1-cross-layer-injection-dedup` | `d7dec41` | Merged (#149). Prunable. |
| `feat/phase2-s2-repo-fact-branch-filtering` | `922075d` | Merged (#148). Prunable. |
| `feat/phase2-s3-episodes-read-path` | `fd45825` | Merged (#146). Prunable. |
| `chore/phase1-changeset` | `9458bf2` | Merged (#142). Prunable. |
| `docs/memory-program-reconcile` | `cb4bdc5` | Merged (#144). Prunable. |
| `docs/phase2-memory-contract` | `d6feebf` | Merged (#145). Prunable. |
| `fix/repo-merge-rules` | `792685b` | Merged (#151). Prunable. |
| `chore/pr135-retire-executor-hardening` | `1528f12` | **No merged PR found** — investigate (closed-not-merged or abandoned) before pruning. |
| `docs/m1-gate-receipt` | `e9de371` | **OPEN** — PR #159 (this milestone's M1-GATE receipt). Keep until merged. |
| `prototype-main` | `67e5def` | Parked — out of M2 scope (historical prototype). |
| `docs/salvage-jtbd-runs-artifacts-20260503` | `76a3562` | Parked — JTBD runs/artifacts salvage; out of M2 scope. |

GitHub auto-deletes merged head branches, but the `feat/*` / `phase2-*` / `chore/*` / `docs/*` / `fix/*` heads above predate that (or were merged before it was enabled). Harmless, but clutter.

## Local-only state

- ~30 local `backup/*` and `archive/*` branches are machine-local snapshots from prior sessions — out of scope; prune at operator discretion.
- Local tracking branches `SollanSystems/buildplane-{eval-proof,fork-vcr,inspector-mvp,native-packaging,pack-export,trace-export,trust-v1}` exist. **`inspector-mvp` (`c403c52`)** is the run-inspector / Mission Control lineage — keep **separate** from M2 unless it supplies read-only run-inspection fixtures (per 2026-05-22 guidance).
- Worktrees: only the `main` checkout + 3 locked `agent-*` worktrees (harness) + `.worktrees/phase0-ref` (detached) remain. The BP5/BP6/PlanForge worktrees are gone.

## M2 consolidation implication (revised)

1. **Admission / run-loop: DONE on `main`.** No salvage.
2. **PlanForge: starts clean.** The 2026-05-22 experimental branches (`planforge-schema-extraction`, `planforge-doc-contract-reconcile`, `planforge-dryrun-contract-audit`) are gone. M2 PlanForge begins from the v0.5 spec §"M2 PlanForge consolidation" (`compile → validate → preview → admit → execute → receipt` as a signed ledger event; replay survives mid-cycle crash), building on the now-shipped signed tape (M1) + admission surface — **not** by resurrecting stale branches.
3. **Inspector / Mission Control: keep separate** (read-only fixtures only) unless explicitly folded in.

## Open decisions (operator)

- Prune the merged-and-lingering remote branches (`bp6b` + the 8 merged `feat/*` / `phase2-*` / `chore/*` / `docs/*` / `fix/*` heads) — read-only here; approve per-branch or batch.
- Investigate `chore/pr135-retire-executor-hardening` (no merged PR).
- Merge **#159** (M1-GATE receipt) to formally close M1.

## Side-effect boundary

Docs-only. No branch deletion, force-push, PR mutation, or label change was performed. This is a fresh dated snapshot; the 2026-05-22 snapshot is preserved for lineage.
