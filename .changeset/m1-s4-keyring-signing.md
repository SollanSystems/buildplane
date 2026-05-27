---
"buildplane": minor
---

M1 · S4 — local keyring + signing-on-append: add the producer half of the signed
event tape in `bp-ledger`. `signing::sign_event` signs `canonical_event_bytes`
with an ed25519 key and emits an `EventSignatureV1` (base64url-no-pad signature
that round-trips with the verify path; `signer.public_key_hash` set to
`sha256:<hex(sha256(verifying_key))>` so it matches the `TrustedPublicKeys`
lookup; deterministic for the same key+event). A new `keyring` module loads raw
32-byte ed25519 seeds from `~/.buildplane/keys/<actor>/<key-id>.ed25519`
(`$HOME`-resolved, actor-scoped per OPERATOR-DECISION-A); errors carry only the
attempted path and an opaque reason, never key bytes. `SqliteStore::append_signed`
signs first, then inserts the event row and the matching `event_signatures` row
inside one transaction and commits only if all succeed — any signing or insert
failure rolls back so no event row persists (fail closed). Signing is opt-in via
`ledger serve --sign [--signing-key-id <id>]` (default OFF / unsigned, preserving
legacy behavior; applies to the `kernel` actor); only a key reference crosses the
config boundary. No event-envelope, generated-TS, or fixture changes.

Review-gate hardening (cross-model L0 trust-surface review): keyring identifiers
(`actor_id`/`key_id`) are now validated before any path join — anything with a
path separator, `..`, a leading `.`, an absolute path, or a char outside
`[A-Za-z0-9._-]` is rejected with a typed `UnsafeKeyringId` error (carries only
the offending id descriptor, no key bytes), so `--signing-key-id ../../foo`,
`/tmp/foo`, `a/b`, and `..` can no longer escape the actor-scoped dir.
`verify_event_signature` now (a) rebinds the retrieved trusted key to its claimed
`public_key_hash` and fails closed (`MissingKey`) if the registry maps a claimed
hash to mismatched key bytes, and (b) rejects a signature whose `event_id` differs
from the event under verification (`HashMismatch`). A new integration test proves
the atomic-rollback guarantee by forcing the signature insert to fail *after* the
event insert succeeds within the same transaction (PK collision) and asserting the
event row is rolled back.

Deferred follow-ups (documented, intentionally not implemented this slice):
- R-003: `SigningKey` is not zeroized on drop. M2 should wrap the loaded seed in a
  zeroizing container so private-key material is scrubbed from memory on drop.
- R-004: signing is currently all-under-kernel (the `signer` is always the kernel
  actor). Per-actor signing authorship is a multi-actor follow-up, not in scope here.
