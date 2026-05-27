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
