# M1 Tape Per-Event Signing Spec

| | |
|---|---|
| **Status** | Draft implementation contract for M1 |
| **Date** | 2026-05-22 |
| **Milestone** | Buildplane v0.5 M1 — signed event tape |
| **Owning layer** | L0 Tape: `bp-ledger` + `packages/ledger-client` |
| **Depends on** | M0 permissions verification/hardening merged; M1-S1 schema contract merged in PR #116 |
| **Companion docs** | [v0.5 design](./2026-05-21-buildplane-v05-design.md) · [operating model](../../architecture/buildplane-agent-operating-system.md) · [ledger](../../ledger.md) · [run admission receipts](../../architecture/run-admission-receipts.md) |

## Goal

Make every ledger event independently verifiable without trusting the live Buildplane process. M1 adds detached Ed25519 signatures for canonical events, verifies signatures on read, emits periodic tape-root checkpoints, and exposes enough TypeScript wire-protocol surface for external tools to verify a sample tape.

## Current state

M1 is already underway.

- PR #116 (`feat(ledger): add signed event schema contract`) landed M1-S1.
- `native/crates/bp-ledger/src/signing.rs` defines:
  - `SignatureAlgorithm::Ed25519`
  - `ActorKeyRef`
  - `EventSignatureV1`
- `packages/ledger-client/fixtures/event-signature-v1.json` and `packages/ledger-client/test/signing-schema.test.ts` lock the TypeScript-visible detached-signature shape.
- The existing seven-field event envelope in `native/crates/bp-ledger/src/event.rs` remains unchanged.
- SQLite currently stores only `events` and `runs`; there is no persisted signature table, signing implementation, verification-on-read behavior, checkpoint event, or keyring.

This spec starts from that state. Do not redo S1.

## Architecture decision

Use detached signatures stored alongside immutable event rows. Do not add signature fields to the canonical event envelope.

Rationale:

1. The v1 event envelope is already documented as frozen: `id`, `run_id`, `parent_event_id`, `schema_version`, `kind`, `occurred_at`, `payload`.
2. Detached signatures let existing replay code keep parsing historical unsigned events while M1 introduces an explicit verification status.
3. External verifiers can independently canonicalize the event bytes, load `EventSignatureV1`, and verify against the actor public key without trusting Buildplane's runtime.
4. Later pack signing, transparency log publication, or federation can build on the same detached-signature record without forcing event-envelope migration.

## Non-goals for M1

M1 does not add:

- Sigstore/Rekor or public transparency log integration.
- SLSA L3 claims.
- Pack signing or OCI registry publishing.
- Cross-operator federation.
- Hardware-backed keys, OS keychain integration, FaceID, or remote KMS.
- Cryptographic capability tokens.
- Deterministic LLM replay beyond preserving already-recorded event payloads.

Those are v1+ or v∞ work. M1 is local-first signed provenance.

## Key-management decision required before code

The operating model requires an operator decision before implementation changes that create or load signing keys.

Recommended M1 default:

- Store local per-machine keys under `~/.buildplane/keys/`.
- Use actor-scoped key files, not a single global key:
  - `kernel/<key-id>.ed25519`
  - `worker/<worker-id>/<key-id>.ed25519`
  - `operator/<operator-id>/<key-id>.ed25519` only after approval events are implemented.
- Persist public-key metadata next to private keys and inside the ledger key registry:
  - `actor_id`
  - `key_id`
  - `algorithm`
  - `public_key_hash`
  - `created_at`
  - optional `retired_at`
- Never commit key material or public-key fixtures that look like real operator keys.
- Tests must use deterministic fixture keys stored under test fixtures only.

Why per-machine first:

- Buildplane v0.5 is explicitly local-first and single-operator/single-machine.
- Per-machine keys are simple enough to implement and verify now.
- Actor-scoped paths preserve a clean migration path to per-operator keys later.
- The tape can record `actor_id` and `key_id` now without requiring cloud identity.

Code implementation must not begin until the operator accepts or overrides this key-location decision.

## Canonical event hash

Every signature covers the canonical serialized event bytes, not a lossy display form.

M1 should define one Rust helper and one TypeScript/reference-verifier equivalent:

```text
canonical_event_hash = "sha256:" + sha256(canonical_event_bytes(event)).hex
```

Rules:

- Canonical bytes must be deterministic across Rust and TypeScript.
- Use the same canonicalization path already used by `bp-ledger` fixtures where possible.
- Include every event-envelope field and the exact payload variant.
- Exclude detached signatures and checkpoint aggregates from the individual event's own canonical bytes.
- Preserve schema-version separation: v1 events hash as v1 events.

Acceptance requires a Rust fixture and a TypeScript/reference-verifier fixture that compute the same hash for the same event JSON.

## Persistence model

Add an append-only signature side table rather than mutating `events`.

Proposed SQLite shape:

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

Required protections:

- `event_signatures_no_update` trigger rejects updates.
- `event_signatures_no_delete` trigger rejects deletes.
- Append of a signature for a missing event fails.
- Append of a duplicate signature for an event fails.
- Event append succeeds only if the signing path can append the matching signature before returning success in signed mode.

Unsigned legacy events are allowed during migration but must surface as `unsigned` during verification, not silently pass.

## Verification-on-read semantics

Read APIs must report verification state explicitly.

Suggested statuses:

- `verified` — event hash matches and Ed25519 signature verifies against the actor public key.
- `unsigned` — no detached signature exists for this event.
- `missing_key` — signature exists, but the public key is unavailable.
- `hash_mismatch` — stored canonical hash does not match the event row.
- `bad_signature` — hash matches the stored canonical hash, but the signature does not verify.
- `unsupported_algorithm` — algorithm is not supported by this binary.

Fail-closed rule:

- Normal replay may display unsigned historical events with an explicit warning.
- Any M1+ acceptance, admission, approval, merge, or checkpoint verification path must fail closed on `unsigned`, `missing_key`, `hash_mismatch`, `bad_signature`, or `unsupported_algorithm` unless the caller explicitly asks for legacy read-only inspection.

## Tape-root checkpoint events

M1 adds periodic checkpoint events so an external verifier can validate a compact tape prefix.

Checkpoint cadence:

- Default every 256 events per run.
- Always emit a final checkpoint at `run_completed` if the run has at least one signed event since the last checkpoint.
- Tests may use a smaller cadence.

Checkpoint payload sketch:

```rust
pub struct TapeCheckpointV1 {
    pub run_id: RunId,
    pub checkpoint_index: u64,
    pub through_event_id: EventId,
    pub through_event_count: u64,
    pub previous_checkpoint_event_id: Option<EventId>,
    pub tape_root_hash: String,
    pub algorithm: TapeRootAlgorithm,
}
```

Root algorithm for v0.5:

```text
tape_root_hash = sha256(join("\n", ordered canonical_event_hash values through through_event_id))
```

This is not a Merkle transparency log. It is a monotonic local checkpoint optimized for replay verification and crash recovery. Public transparency and inclusion proofs are deferred.

Checkpoint event ordering:

1. Append ordinary event.
2. Append and flush detached signature for ordinary event.
3. If cadence is reached, build checkpoint over signed event hashes.
4. Append checkpoint event.
5. Append and flush detached signature for checkpoint event.

## Ledger-client and wire protocol

M1 must update the TypeScript client in a way that preserves existing event-emitter behavior.

Expected additions:

- Generated TypeScript types for any new Rust checkpoint payload types.
- Hand-written exports for verification status and detached signature types where needed.
- A read-side API or helper that can return `{ event, signature, verification }` for replay/inspect callers.
- Fixture updates:
  - `packages/ledger-client/fixtures/event-signature-v1.json`
  - `packages/ledger-client/fixtures/payload-variants.json` if checkpoint payload variants are added.
- Tests proving existing envelopes do not grow a `signature` field.

The wire protocol should not put private key material on stdin/stdout/stderr. If a signing configuration is needed at process startup, pass only a key reference or keyring path; the Rust ledger process should load key material locally and redact paths in errors when needed.

## External verifier

M1 must include a small reference verifier under `scripts/`, for example:

```text
scripts/verify-signed-tape.mjs
```

Minimum behavior:

- Input: workspace path or explicit event/signature fixture files.
- Loads events and detached signatures.
- Loads public keys from a fixture/key registry path.
- Recomputes canonical event hashes.
- Verifies Ed25519 signatures.
- Verifies checkpoint roots.
- Exits non-zero on any non-legacy verification failure.

The verifier is evidence that a third party can check the tape without trusting the running Buildplane kernel.

## Implementation slices

### M1-S1 — Signed event schema contract (done)

Status: done in PR #116.

Scope already landed:

- Rust detached-signature contract types.
- Generated TypeScript types.
- Signature fixture.
- Ledger-client schema test.

### M1-S2 — Canonical event hash + fixture parity

Files likely to change:

- `native/crates/bp-ledger/src/canonicalize.rs`
- `native/crates/bp-ledger/src/signing.rs`
- `native/crates/bp-ledger/tests/canonicalize.rs`
- `packages/ledger-client/fixtures/event-signature-v1.json`
- `packages/ledger-client/test/signing-schema.test.ts`

Acceptance:

- Rust computes `sha256:<hex>` for a fixed canonical event fixture.
- TypeScript test or reference fixture asserts the same expected hash.
- Envelope shape remains unchanged.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger canonical
pnpm vitest --run packages/ledger-client/test/signing-schema.test.ts packages/ledger-client/test/envelope.test.ts
```

### M1-S3 — Signature persistence and append-only protections

Files likely to change:

- `native/crates/bp-ledger/src/storage/sqlite.rs`
- `native/crates/bp-ledger/tests/append_only.rs`
- `native/crates/bp-ledger/tests/round_trip.rs`

Acceptance:

- `event_signatures` table exists.
- Signature rows cannot be updated or deleted.
- Duplicate signature append for an event fails.
- Missing event signature append fails.
- Historical unsigned event reads remain possible and explicit.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger append_only signature
cargo test --manifest-path native/Cargo.toml -p bp-ledger round_trip
```

### M1-S4 — Local keyring + signing on append

Files likely to change after operator key-location approval:

- `native/crates/bp-ledger/src/signing.rs`
- `native/crates/bp-ledger/src/storage/sqlite.rs`
- `native/crates/bp-ledger/src/serve.rs`
- `native/crates/bp-cli/src/ledger_cli.rs`
- tests under `native/crates/bp-ledger/tests/`

Acceptance:

- Test fixture keys can sign events deterministically.
- Signed append stores both event and matching detached signature before reporting success.
- If signing fails in signed mode, event append fails closed.
- Errors do not print private key bytes.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger signing
cargo test --manifest-path native/Cargo.toml -p bp-cli ledger
```

### M1-S5 — Verification-on-read and replay status

Files likely to change:

- `native/crates/bp-ledger/src/storage/sqlite.rs`
- `native/crates/bp-ledger/src/canonicalize.rs`
- `native/crates/bp-ledger/src/signing.rs`
- `native/crates/bp-cli/src/ledger_cli.rs`
- `packages/ledger-client/src/` read-side helpers, if mirrored in TS
- ledger integration tests under `test/ledger-integration/`

Acceptance:

- `verified`, `unsigned`, `missing_key`, `hash_mismatch`, `bad_signature`, and `unsupported_algorithm` states are test-covered.
- Replay remains read-only.
- M1+ strict verification paths fail closed on non-verified events.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger verify
pnpm vitest --run test/ledger-integration/replay-basic.test.ts test/ledger-integration/replay-at-event.test.ts
```

### M1-S6 — Tape-root checkpoint payload and cadence

Files likely to change:

- `native/crates/bp-ledger/src/kind.rs`
- `native/crates/bp-ledger/src/payload/run_lifecycle.rs` or a new `payload/checkpoint.rs`
- `native/crates/bp-ledger/src/payload/mod.rs`
- `native/crates/bp-ledger/src/storage/sqlite.rs`
- `packages/ledger-client/src/generated/index.ts`
- `packages/ledger-client/src/payload.ts`
- `packages/ledger-client/fixtures/payload-variants.json`

Acceptance:

- Checkpoint payload is generated into TypeScript.
- Checkpoint events emit at configurable cadence in tests.
- Checkpoint root recomputes from canonical event hashes.
- Fixture freshness passes.

#### Checkpoint root contract (S7 load-bearing)

The external verifier (M1-S7) MUST reproduce the stored `tape_root_hash`
exactly as follows. Let `H` be the ordered list of stored
`event_signatures.canonical_event_hash` strings for the run's **signed,
non-`tape_checkpoint`** events — events that have a persisted signature row and
whose `kind != tape_checkpoint` — ordered by event `id` ascending (UUIDv7 = tape
order). Then:

```text
tape_root_hash = "sha256:" + hex(sha256(join("\n", H)))
```

Exact rules, with no room for a "full prefix including unsigned" reading:

- The hashed inputs are each event's exact stored `canonical_event_hash`
  *string* (`sha256:<hex>`). The verifier joins these stored strings; it does not
  re-hash event bytes at this step.
- Join with a single `\n` (U+000A) separator and **no trailing newline**: an
  `N`-element list produces `N-1` separators.
- `through_event_count` equals the number of signed, non-`tape_checkpoint`
  events covered — **not** the count of all run events.
- **Unsigned / legacy events are excluded** from `H` entirely (they carry no
  signature row). They do not contribute to the hash and are not counted.
- `tape_checkpoint` events are never members of `H` (they neither contribute to
  nor count toward any checkpoint).

Caller-supplied `tape_checkpoint` events are rejected by the signed-append entry
point before signing/persisting; only the ledger's own checkpoint emitter
creates them. The signed-append path also enforces a per-run strictly-monotonic
event id (single-producer, time-monotonic UUIDv7), so a checkpoint's id-ordered
coverage prefix can never be retroactively invalidated by a lower-id insert.

Verification:

```bash
pnpm ledger:gen
pnpm ledger:gen-fixtures
pnpm vitest --run packages/ledger-client/test/payload-drift.test.ts
cargo test --manifest-path native/Cargo.toml -p bp-ledger checkpoint
```

### M1-S7 — External verifier script

Files likely to change:

- `scripts/verify-signed-tape.mjs`
- `test/workflow/` or `packages/ledger-client/test/` verifier tests
- docs update in `docs/ledger.md`

Acceptance:

- The verifier succeeds on a valid signed tape fixture.
- The verifier fails on tampered event payload, bad signature, missing key, and bad checkpoint root.
- README/docs include one local command for operators.

Verification:

```bash
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/valid
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/tampered && exit 1 || true
pnpm vitest --run test/workflow/ledger-doc-contract.test.ts
```

## Full M1 gate

Before any M1 implementation PR is marked ready for review:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen-fixtures
# assert clean diff after fixture generation
```

For slices that touch generated TypeScript bindings, also run:

```bash
pnpm ledger:gen
pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```

## Review requirements

M1 touches L0/L1 trust surfaces. Every implementation PR requires:

- Independent read-only Reviewer verdict `PASS`.
- Adversarial reviewer for slices that add signing behavior, verification semantics, checkpoint payloads, or key handling.
- Exact reviewed SHA matching the PR head before merge.
- No auto-merge unless the slice is docs-only or fixture-only and meets the operating-model auto-merge criteria.

## First next task

Do M1-S2 first: canonical event hash + fixture parity.

Do not begin M1-S4 keyring/signing-on-append until the operator explicitly approves the recommended per-machine `~/.buildplane/keys/` default or provides an alternative key-location policy.
