# M1-S3 signature persistence slice receipt

| | |
|---|---|
| **Status** | Implementation ready for independent review |
| **Date** | 2026-05-22 |
| **Card** | `M1-S3` |
| **Branch** | `feat/m1-s3-signature-persistence-20260522225603` |
| **Base** | `origin/main` at `99bb8e38839e306504c089e650cefc05c45c7819` |
| **Scope** | `bp-ledger` SQLite detached-signature persistence and append-only protections |
| **Operator side effects** | Local worktree only. No push, PR, merge, deploy, branch deletion, GitHub mutation, key creation, signing-on-append, or worker dispatch. |

## Changed files

- `docs/superpowers/plans/2026-05-22-m1-s3-signature-persistence.md`
- `native/crates/bp-ledger/src/storage/sqlite.rs`
- `native/crates/bp-ledger/tests/append_only.rs`
- `native/crates/bp-ledger/tests/round_trip.rs`

## Implementation summary

- Added `event_signatures` SQLite side table beside immutable `events` rows.
- Added `event_signatures_no_update` and `event_signatures_no_delete` triggers.
- Kept detached signatures outside the canonical event envelope.
- Added integration tests for:
  - table creation;
  - update/delete rejection;
  - duplicate signature rejection;
  - missing-event signature rejection;
  - unsigned historical event readability.
- Did not add key management, private-key paths, signing-on-append, verification statuses, checkpoint payloads, TypeScript generated types, CI changes, or auto-merge policy changes.

## TDD evidence

### RED

Command:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test append_only
```

Result: expected failure before storage implementation.

Observed failures:

- `event_signatures_table_exists` failed: table count was `0`, expected `1`.
- `update_on_event_signatures_is_rejected` failed with `no such table: event_signatures`.
- `delete_on_event_signatures_is_rejected` failed with `no such table: event_signatures`.
- `duplicate_signature_append_is_rejected` failed with `no such table: event_signatures`.

Four pre-existing event append-only tests still passed.

### GREEN / focused

Command:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test append_only
```

Result: PASS — 8 passed, 0 failed.

Command:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test round_trip
```

Result: PASS — 3 passed, 0 failed.

Command:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger
```

Result: PASS — all `bp-ledger` unit, integration, and doc tests passed.

## Broader verification evidence

Command:

```bash
git diff --check
```

Result: PASS — exit 0.

Command:

```bash
pnpm lint
```

Result: PASS with one pre-existing warning in `packages/policy/src/diff-scope.ts` (`lint/complexity/useOptionalChain`). Exit 0. No files in this slice were flagged.

Command:

```bash
pnpm typecheck
```

Result: PASS — exit 0.

Command:

```bash
pnpm test
```

Result: DEFAULT PARALLEL RUN FAILED — 968 passed, 1 skipped, 1 failed. Failure was `test/ledger-integration/backpressure.test.ts` timing out at 60s under parallel load, plus one unhandled `EPIPE` attributed to concurrent `test/event-stream/e2e-events.test.ts` execution.

Follow-up deterministic serial checks:

```bash
pnpm vitest --run test/ledger-integration/backpressure.test.ts --maxWorkers=1 --no-file-parallelism
```

Result: PASS — 1 passed, 0 failed, 21.8s.

```bash
pnpm vitest --run test/event-stream/e2e-events.test.ts --maxWorkers=1 --no-file-parallelism
```

Result: PASS — 2 passed, 0 failed.

```bash
pnpm native:build && pnpm vitest --run --maxWorkers=1 --no-file-parallelism
```

Result: PASS — 134 files passed, 1 skipped; 968 tests passed, 1 skipped; duration 172.25s.

Command:

```bash
pnpm build
```

Result: PASS — exit 0.

Command:

```bash
cargo test --manifest-path native/Cargo.toml
```

Result: PASS — all native crate unit, integration, and doc tests passed.

Command:

```bash
pnpm verify:published-bootstrap
```

Result before commit: BLOCKED by expected clean-worktree precondition. The verifier refused to run because the worktree had uncommitted slice changes.

Result after commit: BLOCKED by the verifier's internal default `pnpm test` invocation timing out in `test/ledger-integration/backpressure.test.ts` at 60s. The verifier's repo-dev smoke also created two local Buildplane run commits (`457e565`, `c454281`) before the failure; those verification side-effect commits were removed with `git reset --hard a8379a3` to restore the intended feature-branch head.

Follow-up evidence: running the same backpressure file directly passed in 26.6s, and the full Vitest suite passed under deterministic serial execution (`pnpm native:build && pnpm vitest --run --maxWorkers=1 --no-file-parallelism`). Treat `verify:published-bootstrap` as inconclusive in this local WSL run, not as evidence that M1-S3 behavior failed.

## Acceptance checklist

- [x] `event_signatures` table exists.
- [x] Signature rows cannot be updated.
- [x] Signature rows cannot be deleted.
- [x] Duplicate signature append for an event fails.
- [x] Missing-event signature append fails.
- [x] Historical unsigned event reads remain possible.
- [x] Event envelope columns unchanged.
- [x] No keyring/signing-on-append behavior introduced.
- [x] No CI/release/auto-merge policy changed.
- [x] No real or placeholder private keys added.

## Review gates

Pending:

- Independent Reviewer: Claude Code Opus, fresh read-only session, no edits.
- Adversarial Reviewer: Codex, read-only diff review.

Required verdict before PR handoff: `PASS` or explicit operator acceptance of documented non-blocking risk.

## Remaining blocker

M1-S4 remains blocked on `OPERATOR-DECISION-A`: the operator must approve or override the M1 key-location policy before code that creates/loads signing keys begins.
