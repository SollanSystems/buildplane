---
"@buildplane/planforge": minor
"buildplane": minor
---

M2-S6: receipt stage — a completed `planforge dispatch` emits one kernel-signed
`plan_receipt` (chaining to the `plan_admitted` event id, canonical
`result_digest`, declared `side_effects`); `buildplane ledger export-signed-tape`
serializes a live `events.db` run into `buildplane.signed-tape.v1` for the
external verifier, completing the admit → activities → receipt round-trip.
