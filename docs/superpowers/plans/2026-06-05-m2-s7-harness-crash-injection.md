# M2-S7-HARNESS — deterministic crash-injection replay harness

Date: 2026-06-05
Base: `origin/main` @ `148ad7333d15f7ddc2246f76fbc18cb2046cf01a`
Branch: `feat/m2-s7-harness`

## Goal

Land the M2-S7 test-infrastructure harness before production replay/recovery work. The harness creates deterministic PlanForge crash-point tapes, simulates a halted kernel at named boundaries, opens a fresh read-only durable tape probe against the same `events.db`, and asserts the durable state S7a/S7b/S8 must consume. It does not boot the production kernel or exercise startup/resume behavior; those remain S7b scope unless the M2 spec is deliberately tightened.

## Scope

Allowed changes:

- `test/ledger-integration/crash-harness.ts` — reusable test utility.
- `test/ledger-integration/crash-harness.test.ts` — self-tests.
- This plan document.

Non-goals:

- No production code changes.
- No `bp-replay` transition implementation (S7a).
- No kernel startup scan / resume / skip-reinvocation implementation (S7b).
- No merge, branch cleanup, or worktree pruning. Pushing and opening a draft PR are allowed only by the board task gate for this slice.

## Crash points

The harness exposes exactly three PlanForge crash boundaries:

1. `admit-before-execute` — signed `plan_admitted`, no activity events, no receipt.
2. `after-activity-completed` — signed admission plus one completed activity result, no receipt.
3. `execute-before-receipt` — signed admission plus all fixture activities completed, no receipt.

All events are written through the real signed ledger subprocess into a real `events.db`; the harness flushes after the requested boundary and then kills the subprocess to model a halted kernel. The fresh read-only probe re-opens the same database and reconstructs state from the tape, not from in-memory objects or production kernel recovery code.

## TDD steps

1. RED: add `crash-harness.test.ts` expecting the public harness API and run:
   `pnpm -C /mnt/c/Dev/projects/buildplane-m2-s7-harness exec vitest run test/ledger-integration/crash-harness.test.ts`
2. GREEN: implement `crash-harness.ts` with the smallest signed tape builder + read-only probe + boundary assertion helpers.
3. Verify focused gate:
   `pnpm -C /mnt/c/Dev/projects/buildplane-m2-s7-harness exec vitest run test/ledger-integration/crash-harness.test.ts`
4. Run adjacent regression gate:
   `pnpm -C /mnt/c/Dev/projects/buildplane-m2-s7-harness exec vitest run test/ledger-integration/crash-harness.test.ts test/ledger-integration/crash-recovery.test.ts test/ledger-integration/planforge-receipt.test.ts --maxWorkers=1 --no-file-parallelism`
5. Typecheck if feasible: `pnpm -C /mnt/c/Dev/projects/buildplane-m2-s7-harness typecheck`.

## Review ceremony

Per `CLAUDE.md`, S7-HARNESS is test infrastructure only: one independent reviewer, no adversarial Codex. S7a/S7b remain L0 and require the heavier review ceremony.
