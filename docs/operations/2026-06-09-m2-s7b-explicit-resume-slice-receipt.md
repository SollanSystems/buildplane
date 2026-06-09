# M2-S7b slice receipt — explicit-input PlanForge resume (phase 1)

Evidence packet for the first shippable S7b boundary: CLI `planforge resume` with explicit `--input`, not full kernel startup scan.

## Slice identity

- Slice id: M2-S7b (phase 1 — explicit resume)
- Milestone: M2 (PlanForge admission cycle)
- Goal: Resume an admitted PlanForge plan from durable tape state when the operator supplies the same plan input; skip recorded activities; execute only the suffix; emit terminal `plan_receipt`.
- Non-goals: `packages/kernel` orchestrator startup scan; automatic discovery of in-flight runs; `crash-replay.test.ts` harness kills; default-strategy recovery; new wire event kinds.
- Operator approval scope: L0 CLI recovery surface; adversarial Codex review required before merge (no `buildplane:auto-merge`).
- Started at: 2026-06-09 (interactive DWF continuation)
- Completed at: 2026-06-09T17:48:39Z (PR #179 merged)

## Source of truth

- Base branch: `main`
- Base SHA: `7ac334d` (PR #179 merged)
- Spec: `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md` lines 273–291 (full kernel resume deferred; explicit-input boundary chosen per `CLAUDE.md`).

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane-m2-s7b-explicit-resume`
- Branch: `feat/m2-s7b-explicit-resume`
- Local HEAD SHA: `6b5e35a` (implementation commit; docs/changeset follow)
- Git identity: `Sollan Systems <khall0239@gmail.com>`

## Scope

- Files changed (implementation commit):
  - `apps/cli/src/run-cli.ts`
  - `apps/cli/test/run-cli.test.ts`
  - `test/ledger-integration/planforge-resume.test.ts`

## Verification (parent-run)

```text
pnpm native:build — OK
pnpm typecheck — OK
pnpm vitest --run test/ledger-integration/planforge-resume.test.ts apps/cli/test/run-cli.test.ts — 104 passed
pnpm lint — 2 warnings, 2 infos (no errors)
```

## Boundary note

Full S7b acceptance in the M2 spec still includes orchestrator startup scan and S7-HARNESS kill-point replay tests. This PR lands the explicit-input CLI path and ledger-integration regression coverage so S7b phase 2 can wire kernel/orchestrator recovery on proven tape semantics.

## Next after merge

- S7b phase 2: kernel `orchestrator.ts` startup scan + skip-reinvocation + `crash-replay.test.ts`
- S8: M2-GATE vertical slice