# Canonical digest contract (L0)

> **Status:** locked pre-M2-S3 (2026-06-01). This is the load-bearing contract behind every value the signed tape commits to. Changes here go through the full L0 review ceremony.

Anything that is **signed** must be derived from a **stable canonical serialization**, so the same logical input always yields the same bytes — and therefore the same digest, idempotency key, and signed identity. There are two canonical serializations in the system, and the central invariant is that **they are disjoint**: no single logical object is ever digested by both.

## The two canonical forms

| Form | Where | Used for | Ordering |
|---|---|---|---|
| **Sorted-key canonical JSON** | TS — `packages/planforge/src/digest.ts` (`canonicalJson`/`digest`) and `packages/kernel/src/admission-receipts.ts` (`stableJson`) | Payload-**embedded** digests computed in TS: `plan_digest`, `input_digest`, `idempotency_key`, `result_digest`, the admission `receipt_digest` | Object keys sorted recursively; array order preserved |
| **Serde field-declaration-order bytes** | Rust — `native/crates/bp-ledger/src/canonicalize.rs` (`canonical_event_bytes` → `serde_json::to_vec`) | The event-**envelope** signing hash (`canonical_event_hash`), over which the Ed25519 detached signature is taken | Struct field declaration order (serde default) |

These never collide because they operate on different objects:

- TS computes digests **over plan/input/result objects** that exist only in TypeScript and embeds the resulting `sha256:<hex>` **string** into a payload field.
- Rust computes the envelope hash **over the whole `Event`** (envelope + already-built payload) at append time. The external verifier (`scripts/verify-signed-tape.mjs`) never re-serializes an event — it hashes the **stored** `canonical_event_hash`.

So a payload-embedded digest is a plain opaque string by the time Rust sees it; Rust never re-derives it, and TS never reproduces the envelope hash. **Do not introduce a path where one language must reproduce the other's bytes for the same object.** If cross-language reproduction ever becomes necessary, both sides must converge on sorted-key canonical JSON (the language-agnostic form), and that decision must be recorded here.

## No numeric field in a signed identity payload (the u64 → `number` hazard)

TypeScript `number` is an IEEE-754 double and cannot faithfully represent a Rust `u64`/`i64`/`usize` above 2^53. typeshare emits such a field as TS `number`, so a numeric field in a **signed** payload would silently diverge across languages — and once an event is signed in production, a wrong wire shape forces a tape migration.

**Rule:** any field of a signed payload that could carry a large integer MUST be modelled as a **string** in Rust (and therefore typeshare to TS `string`). The four M2 signed-identity payloads (`PlanAdmittedV1`, `PlanReceiptRecordedV1`, `ActivityStartedV1`, `ActivityCompletedV1`) satisfy this by construction: every typed field is a `String`, a string-serialized `Uuid` (`EventId`/`RunId` are `#[serde(transparent)]` over `Uuid`), a snake_case enum, or `Vec<String>`. The only non-typed field is `ActivityCompletedV1.result` — an opaque `serde_json::Value` recording verbatim model/tool output, which is exempt because it carries no precision contract.

### Enforcing guards

- **Rust source guard** — `native/crates/bp-ledger/tests/m2_digest_contract.rs` serializes each of the four payloads and asserts no JSON number appears in a typed field, and that `EventId`/`RunId` serialize as JSON strings. This fails closed at the struct definition, where a `u64` would be introduced.
- **TS wire-boundary guard** — `packages/ledger-client/test/m2-signed-identity-contract.test.ts` scans the generated fixtures and asserts the bytes TS consumers receive carry no numeric typed field.
- **Determinism** — `packages/planforge/test/digest.test.ts` pins that `canonicalJson`/`digest` are invariant to object-key order.

## Adding a new signed payload field — checklist

1. Model large integers / ids as `String` in Rust, never `u64`/`i64`. Add the field to the appropriate guard above.
2. Follow the add-event-kind procedure in `CLAUDE.md` (kind + payload + `mod.rs` + `canonicalize.rs` arms + typeshare regen + hand-edit `payload.ts` + `pnpm ledger:gen-fixtures`).
3. Run the **whole** native workspace (`cargo test --manifest-path native/Cargo.toml`, no `-p`) so a new enum variant can't silently break a sibling crate's exhaustive match (the #163-class break).
4. Confirm fixture freshness is byte-stable: `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures`.
