# M2-S7b phase 2a — crash-replay integration tests

Evidence for S7-HARNESS-boundary resume regression coverage (test-only slice).

## Slice identity

- Slice id: M2-S7b phase 2a
- Depends on: PR #179 merged @ `7ac334d`
- Goal: `test/ledger-integration/crash-replay.test.ts` exercises `planforge resume` at all three harness kill-point names.
- Non-goals: orchestrator startup scan (phase 2b); harness tape direct consumption (future bridge).

## Verification

```bash
pnpm vitest --run test/ledger-integration/crash-replay.test.ts test/ledger-integration/planforge-resume.test.ts --maxWorkers=1 --no-file-parallelism
```

## Review tier

Test coverage for L0 resume path — pair with phase 1 review discipline; no production kernel surface in this PR.