# M2-GATE — PlanForge admit cycle acceptance (draft)

| | |
|---|---|
| **Status** | **DRAFT** — finalize on `main` after S8 PR merge (S8-3) |
| **Date** | 2026-06-09 |
| **Gate** | `M2-GATE` |
| **Milestone** | M2 — PlanForge admit cycle |
| **Base** | `main` at `6fc5d40` (pre-S8); update head SHA when S8 lands |
| **Scope** | Vertical slice e2e + architecture doc refresh + this receipt |

## Verdict (target)

**M2 COMPLETE** when:

- `test/workflow/planforge-m2-vertical-slice.test.ts` passes locally and in CI `verify`
- Full gate (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `cargo test`, fixture freshness) green in CI on the S8 merge commit
- Slice ledger S1–S7b (phase 2a) + S8 documented below

## Gate C deviation (Path i)

Spec M2-S7b phase 2b (orchestrator startup-scan + automatic resume) is **waived**. Production recovery is **explicit-input** `planforge resume` plus harness-backed crash-replay tests (#179, #181). Documented in `docs/architecture/planforge.md`.

## Slice ledger

| Slice | Subject | Landed as |
|---|---|---|
| S1 | planforge package | PR #161 |
| S2 | tape vocabulary | PR #163 |
| S3 | admit | PR #166 |
| S4 | dispatch | PR #168 |
| S5 | activity bracketing | PR #171 |
| S6 | receipt + export | PR #173 |
| S7-HARNESS | crash harness | PR #174 |
| S7a | replay transitions | PR #177 |
| S7b phase 1 | explicit resume | PR #179 |
| S7b phase 2a | crash-replay tests | PR #181 |
| S7b phase 2b | orchestrator scan | **N/A (waived)** |
| S8 | vertical slice + GATE docs | *this PR* |

## S8 acceptance evidence

Commands (canonical):

```bash
pnpm vitest --run test/workflow/planforge-m2-vertical-slice.test.ts
# Full M2 gate: CI verify job (pnpm check equivalent)
```

Vertical slice proves:

- `dry-run` PASS → `admit` → simulated mid-cycle crash (one recorded activity) → `resume` → single `plan_receipt`
- Exported signed tape verifies with `scripts/verify-signed-tape.mjs`

## Memory program freeze

Outcome routing and memory promotion expansions remain **OFF** until post-M2-GATE unless operator explicitly reopens.

## Known debt (non-blocking)

Tracked from S4/S5 slice receipts: authorized_next_step guards, provenance literals, silent-degrade observability, write-ahead flush proofs — see steward `m2-gate-s8-prep-queue.md`.

## CI evidence (fill at S8-3)

| Check | Status | Run URL |
|---|---|---|
| `verify` | *pending S8 PR* | |
| CodeQL | *pending* | |

## Side-effect boundaries

- S8 implementation PR: tests + docs (+ changeset if published surfaces change).
- This receipt may land in the same PR or a follow-up docs-only commit on `main` after merge — operator choice at S8-3.