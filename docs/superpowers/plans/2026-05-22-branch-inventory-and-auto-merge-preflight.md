# Buildplane Branch and Orchestration Hygiene Snapshot — 2026-05-22

## Purpose

This note captures the read-only hygiene tasks listed in the canonical operating model after M0:

1. Pre-flight the auto-merge probe on a recent PR.
2. Inventory feature branches related to PlanForge/admission/run-loop/inspector work so M2 consolidation starts from reality rather than stale assumptions.

No branches were deleted, renamed, force-pushed, closed, or modified while producing this note.

## Mainline state

- `origin/main`: `86cc2d37cfff657ac0040a91ac8c7c7b279306be`
- Open PRs at snapshot time: none.
- Latest default-branch checks after release PR #121 merge:
  - `release`: success
  - `verify`: success
  - `verify-wrong-node`: success
- Deployment probe for the latest merge commit returned no deployments.

## Auto-merge probe pre-flight

Command:

```bash
node scripts/ci/pr-auto-merge-eligibility.mjs --pr 116 --review-pass --json
```

Observed result:

- Probe returned structured reconciliation output. Because PR #116 is already merged, the command reports `RECONCILE_ALREADY_MERGED` rather than `AUTO_MERGE_READY`.
- The probe still observed the expected surfaces:
  - required checks were successful,
  - `buildplane:auto-merge` label was present,
  - deployment list was empty,
  - PR metadata was returned.

Conclusion: the probe is callable locally and returns structured reconciliation output for a recent merged PR. For a live auto-merge candidate, rerun with `--expected-head <sha>` and any required approval flags.

## Remote branch inventory

Read-only command:

```bash
git ls-remote --heads origin | grep -Ei 'planforge|admission|run-loop|inspector|bp5|bp6|gsd2|m1|sign'
```

Matching remote branches:

| Branch | SHA | Notes |
|---|---:|---|
| `bp6b-run-loop-admission-wiring` | `46095118a55d799fe77fac3382ccad2c14e38ba2` | Only matching remote feature branch found. Likely relevant to M2 PlanForge/admission/run-loop consolidation. Do not mutate until it is inspected against current `origin/main`. |

No open PR currently owns this branch.

## Local worktree signals relevant to future consolidation

The local machine has several stale or in-progress worktrees that may represent historical branch state but are not authoritative without remote reconciliation.

Relevant local worktrees include:

| Worktree | Branch / state | HEAD | Relevance |
|---|---|---:|---|
| `.worktrees/m1-s1-signed-ledger-schema` | `feat/m1-s1-signed-ledger-schema` | `2ec2d97975f5b10021b3886d8836b609085fcb03` | Already merged by PR #116 as `41c4977`; keep only as local evidence unless operator requests cleanup. |
| `.worktrees/bp5bf-admission-secret-hygiene` | `bp5bf-admission-secret-hygiene-t_3e95e686` | `186309d410dd8aee8b34169326671fe4a3754c2b` | Admission secret-hygiene lineage referenced by the v0.5 design as BP5BF. Not observed as a matching remote branch in this snapshot; inspect and classify before M2/BP5 consolidation. |
| `.worktrees/t_ff479f8e` | `bp5a-admission-event-contract-t_ff479f8e` | `7f8b535edac8b540b6b57ad4294b6c7fcdee3bd8` | Admission event contract lineage; inspect before M2/BP5 consolidation. |
| `.worktrees/t_f1b97884` | `bp5b-admission-receipt-persistence-t_f1b97884` | `6f7ff7747963cc73b96ae94d68082023ff3e818d` | Admission persistence lineage; inspect before M2/BP5 consolidation. |
| `.worktrees/t_402505c9` | `bp6a-run-loop-admission-checkpoint-t_402505c9` | `819f447eaa4c3962027c6d77a5ab397ca2174d0d` | Run-loop checkpoint/admission lineage; inspect before M2/BP6 consolidation. |
| `.worktrees/planforge-doc-contract-reconcile` | `docs/planforge-doc-contract-reconcile` | `5010b7a101bda2c1cd7c28628a3abe0725e7b762` | PlanForge doc-contract reconciliation candidate. |
| `.worktrees/planforge-schema-extraction` | `feat/planforge-schema-extraction` | `5010b7a101bda2c1cd7c28628a3abe0725e7b762` | PlanForge schema extraction candidate. |
| `.worktrees/planforge-dryrun-contract-audit` | `audit/planforge-dryrun-contract` | `b46a88d26f1990dc25180cbc31785ceab5bc84bc` | Historical audit branch; also points at the pack-export feature commit that fed the release changeset. |
| `C:/Dev/worktrees/buildplane-inspector-mvp` | `SollanSystems/buildplane-inspector-mvp` | `c403c52fbedda577a1ab2455d4316305d7168bff` | Prunable Windows-path worktree; may be relevant to future run-inspector/Mission Control work, but not a live remote branch from this snapshot. |

Other local worktrees exist for already-merged or unrelated maintenance slices. Do not use any local worktree as source-of-truth until it is compared to `origin/main` and remote branch state.

## M2 consolidation implication

Before starting M2 PlanForge consolidation, do a dedicated branch audit slice from fresh `origin/main`:

1. Fetch and list remote branches.
2. For `bp6b-run-loop-admission-wiring`, inspect diff/stat/log against `origin/main`.
3. For local-only BP5/BP6 worktrees, decide whether they are superseded by `bp6b-run-loop-admission-wiring`, already landed, or still contain salvageable commits.
4. Capture any salvage work as new clean branches from current `origin/main`; do not resurrect stale branches directly.
5. Keep inspector/Mission Control work separate from M2 unless it only supplies read-only run-inspection fixtures.

## Open decisions

- No cleanup was performed. The operator should explicitly approve any branch/worktree pruning.
- The GitHub repository setting currently forbids Actions-created PRs. We worked around this once by manually creating PR #121 from `changeset-release/main`; if automated release PR creation is desired, the operator must enable the repository setting or provide an approved token strategy.
