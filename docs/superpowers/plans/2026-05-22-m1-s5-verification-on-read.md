# M1-S5 verification-on-read and replay status

| | |
|---|---|
| **Status** | Active implementation slice plan |
| **Date** | 2026-05-22 |
| **Milestone** | Buildplane v0.5 M1 — signed event tape |
| **Card** | `M1-S5` from the Buildplane Kanban queue |
| **Base** | Stacked on M1-S3 branch `feat/m1-s3-signature-persistence-20260522225603` at `1d3498ef7fb4f62a0e449408db54975420678b2c` |
| **Owning layer** | L0 Tape: `native/crates/bp-ledger` read-side verification |
| **Depends on** | M1-S3 signature persistence table and append-only protections |
| **Blocks** | M1-S7 external verifier and M1-GATE strict signed-tape acceptance |

## Goal

Expose explicit verification state when reading ledger events with detached signatures. Unsigned historical events remain readable, but no caller can silently treat them as verified. This slice adds the read-side status surface and tests all M1 verification statuses.

## Scope

Allowed changes:

- `native/crates/bp-ledger/src/signing.rs`
  - Add `VerificationStatus` with the six M1 states.
  - Add a local explicit public-key registry surface for read-side verification.
  - Add Ed25519 signature verification over canonical event bytes.
- `native/crates/bp-ledger/src/storage/sqlite.rs`
  - Add append/read helpers for detached signatures.
  - Add `verified_events_for_run` returning event row, optional signature, and explicit status.
- `native/crates/bp-ledger/src/canonicalize.rs`
  - Expose canonical event bytes for signing/verification use.
- `native/crates/bp-ledger/tests/verification_on_read.rs`
  - Cover `verified`, `unsigned`, `missing_key`, `hash_mismatch`, `bad_signature`, and `unsupported_algorithm`.
- Cargo dependency updates required for real Ed25519 verification (`ed25519-dalek`) and base64url decoding (`base64`).

Out of scope:

- No private-key creation, loading, or local keyring path handling.
- No signing-on-append behavior.
- No checkpoint events.
- No TypeScript wire protocol changes in this slice.
- No external verifier script.
- No GitHub Actions, release, auto-merge, or branch-protection changes.

## Acceptance criteria

- `verified` status is returned for an event whose stored canonical hash matches and whose Ed25519 signature verifies against a trusted public key.
- `unsigned` status is returned when no detached signature row exists.
- `missing_key` status is returned when a signature exists but no trusted public key is available.
- `hash_mismatch` status is returned when the stored canonical hash differs from the event row.
- `bad_signature` status is returned when the key exists but signature verification fails.
- `unsupported_algorithm` status is returned for non-Ed25519 signature rows.
- Historical unsigned reads remain possible.
- Existing M1-S3 append-only tests still pass.

## Verification commands

Focused gate:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test verification_on_read
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test append_only
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test round_trip
cargo test --manifest-path native/Cargo.toml -p bp-ledger
```

Full pre-PR local gate:

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
- Required verdict to proceed: `PASS` from both lanes, or explicit operator acceptance of documented non-blocking risk.
- Reviewers must confirm this slice does not create/load private keys and does not implement signing-on-append.

## Side-effect boundaries

- Do not merge PR #124 or #125 from this slice.
- Do not push this branch until deterministic local gates and review receipts are recorded.
- Do not create, load, or persist private key material.
- Do not edit `.github/`, release automation, branch protection, labels, or auto-merge plumbing.
