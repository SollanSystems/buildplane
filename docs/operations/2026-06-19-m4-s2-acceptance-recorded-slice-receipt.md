# Buildplane slice receipt

## Slice identity

- Slice id: M4-S2
- Milestone: M4 Acceptance Contract
- Goal: Add L0 signed `acceptance_recorded` tape vocabulary (`AcceptanceRecordedV1`) with replay transition and TS/fixture drift guards.
- Non-goals: kernel emit wiring, CLI `emitAcceptanceRecorded`, finalization gate E2E (M4-S3).
- Base: `origin/main` @ `8a39b78`
- Worktree: `.worktrees/m4-s2-acceptance-recorded`
- Branch: `feat/m4-s2-acceptance-recorded`

## Verification

- `cargo test --manifest-path native/Cargo.toml` (workspace) — pass
- `cargo test -p bp-ledger acceptance` — 4 tests pass
- `pnpm ledger:gen` + `pnpm ledger:gen-fixtures` — pass
- `vitest run packages/ledger-client/test/payload-drift.test.ts packages/ledger-client/test/m2-signed-identity-contract.test.ts` — pass

## Review gate

- Tier: L0 (4-role before admin-merge)

## Next gate

- M4-S3: `acceptancePort` + CLI wiring + quarantine E2E tests