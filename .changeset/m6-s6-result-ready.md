---
"@buildplane/ledger-client": patch
---

add the `result_ready` signed L0 event kind (M6-S6). New tape vocabulary
`ResultReadyV1 { run_id, admission_event_id, acceptance_event_id }` (all `String`
on the wire — no `u64` precision hazard) signalling a run reached a terminal,
operator-reviewable accepted result, chaining to the `plan_admitted` and
`acceptance_recorded` events. Full nine-file derivation: `EventKind::ResultReady`,
the payload struct + `#[typeshare]` binding, the `Payload::ResultReadyV1`
registration, the `canonicalize.rs` `kind_to_variant`/`payload_variant_name` arms,
the mandatory `bp-replay` no-op transition arm (exhaustive match), round-trip +
canonicalize + golden-byte + signed-append tests, the regenerated TS types, the
hand-edited `Payload` union, and the regenerated `payload-variants.json` fixture.
No emit path yet — signing/emit lands in M6-S7.
