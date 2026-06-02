---
"@buildplane/kernel": minor
"buildplane": minor
---

M2-S5: activity bracketing — `executeOnce` emits a write-ahead, kernel-signed
`activity_started` (durably flushed before invoke) and an `activity_completed`
(recorded result + canonical `result_digest`) via a new kernel `LedgerActivityPort`,
for both model and command activities. The CLI supplies the concrete signed-emitter
adapter (`createLedgerActivityPort` / `createDeferredLedgerActivityPort`) and wires
it into both `planforge dispatch` and `buildplane run` on a kernel-signed tape; a
fail-fast `assertKernelSigningKey()` precondition guards every signed-ledger path.
