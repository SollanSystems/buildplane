# M1-S3 signature persistence and append-only protections

| | |
|---|---|
| **Status** | Active implementation slice plan |
| **Date** | 2026-05-22 |
| **Milestone** | Buildplane v0.5 M1 — signed event tape |
| **Card** | `M1-S3` from the Buildplane Kanban queue |
| **Base** | `origin/main` at `99bb8e38839e306504c089e650cefc05c45c7819` |
| **Owning layer** | L0 Tape: `native/crates/bp-ledger` SQLite storage |
| **Depends on** | M1-S1 signed event schema contract; M1-S2 canonical event hash fixture parity |
| **Blocks** | M1-S5 verification-on-read; M1-S6 checkpoint cadence; M1-S4 signing-on-append storage integration |

## Goal

Persist detached event signatures beside immutable ledger events without changing the canonical event envelope. This slice creates the storage table and fail-closed append-only invariants only. It does not introduce key management, signing on append, signature verification, checkpoint events, TypeScript wire-protocol changes, or external verifier behavior.

## Sequencing decision

Execute this slice before M1-S4 because M1-S4 is blocked on the operator key-location decision. M1-S3 is unblocked: it is local SQLite schema/API/test work and gives later slices a durable place to store `EventSignatureV1` records.

## Scope

Allowed changes:

- `native/crates/bp-ledger/src/storage/sqlite.rs`
  - Create `event_signatures` table during store initialization.
  - Add append-only triggers for the table.
  - Add a small storage API for appending and reading detached signature rows if needed by tests and follow-on slices.
- `native/crates/bp-ledger/tests/append_only.rs`
  - Add RED/GREEN coverage for signature table immutability and constraints.
- `native/crates/bp-ledger/tests/round_trip.rs`
  - Add coverage that historical unsigned event reads still work after the new table exists.
- This plan file and the slice receipt under `docs/operations/`.

Out of scope:

- No private key files or keyring paths.
- No signing implementation.
- No verification statuses beyond storage-level explicit absence of a signature row if an API is added.
- No checkpoint payloads.
- No TypeScript generated type refresh.
- No changes to the `events` canonical envelope columns.
- No CI, release, auto-merge, branch-protection, or GitHub label changes.

## Storage contract

Add this side table, matching the M1 spec's detached-signature model:

```sql
CREATE TABLE IF NOT EXISTS event_signatures (
  event_id              TEXT PRIMARY KEY,
  canonical_event_hash  TEXT NOT NULL,
  actor_id              TEXT NOT NULL,
  key_id                TEXT NOT NULL,
  public_key_hash       TEXT,
  algorithm             TEXT NOT NULL,
  signature             TEXT NOT NULL,
  signed_at             TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id)
);
```

Required triggers:

- `event_signatures_no_update` rejects all updates.
- `event_signatures_no_delete` rejects all deletes.

Required constraints:

- Missing event signature append fails through the foreign key.
- Duplicate signature append for an event fails through the primary key.
- Existing unsigned historical event reads remain possible through `events_for_run` / canonicalize paths.

## Acceptance criteria

- `event_signatures` table exists for new in-memory and file-backed stores.
- Signature rows cannot be updated.
- Signature rows cannot be deleted.
- Appending a signature for a missing event fails.
- Appending a duplicate signature for an event fails.
- Reading historical unsigned events remains possible.
- The `events` table shape and event envelope are unchanged.
- No key-management code, private-key paths, signing implementation, or verification-on-read statuses are introduced.

## TDD plan

1. RED: Add a focused test in `native/crates/bp-ledger/tests/append_only.rs` asserting `event_signatures` exists after `SqliteStore::open_in_memory()`.
2. RED: Add focused tests asserting update/delete against `event_signatures` fail with append-only trigger errors.
3. RED: Add focused tests asserting duplicate and missing-event signature inserts fail.
4. RED/characterization: Add or confirm a test in `round_trip.rs` showing an event can be appended/read/canonicalized without a corresponding signature row.
5. GREEN: Add only the table/triggers/storage helper needed to satisfy the tests.
6. REFACTOR: Keep helper naming and row structs minimal; avoid broader signing semantics.

If a new public helper is added, prefer a storage-specific name such as `append_signature_for_tests` only if it is test-only; otherwise use `append_event_signature` with `EventSignatureV1` and no key-loading side effects.

## Verification commands

Focused RED/GREEN commands:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test append_only
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test round_trip
```

Before handoff/review:

```bash
git diff --check
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test append_only
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test round_trip
cargo test --manifest-path native/Cargo.toml -p bp-ledger
```

Full slice gate before PR/merge consideration:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

## Review requirements

- Independent Reviewer: Claude Code Opus, fresh read-only session, no edits.
- Adversarial Reviewer: Codex, read-only diff review.
- Required verdict to proceed: `PASS` from both review lanes, or explicit operator decision to accept a documented non-blocking risk.
- Reviewer must confirm this slice did not start M1-S4 keyring/signing work.

## Side-effect boundaries

- Do not push, open PRs, merge, deploy, delete branches/worktrees, edit branch protection, or apply labels without explicit operator approval.
- Do not edit `.github/`, release automation, or `scripts/ci/pr-auto-merge-eligibility.mjs`.
- Do not use or introduce ambient Claude `--dangerously-skip-permissions` behavior.
- Do not store real or placeholder private keys outside test fixtures.
- Do not add secret-shaped fixtures or environment-variable examples.

## Slice receipt requirements

Create a receipt under `docs/operations/` before review handoff. It must record:

- branch and head SHA;
- changed files;
- RED test evidence;
- GREEN/focused test evidence;
- full or partial gate evidence with exact commands and exit codes;
- reviewer verdicts and reviewed SHA;
- explicit statement that M1-S4 key-management work remains blocked on the operator key-location decision.
