---
"@buildplane/kernel": minor
"buildplane": minor
---

M2-S5: activity bracketing — `executeOnce` emits a write-ahead, kernel-signed
`activity_started` (durably flushed before invoke) and an `activity_completed`
(recorded result + canonical `result_digest`) via a new kernel `LedgerActivityPort`.
The CLI supplies the concrete signed-emitter adapter (`createLedgerActivityPort`)
and wires it into `planforge dispatch` on a kernel-signed tape; a fail-fast
`assertKernelSigningKey()` precondition guards the signed-ledger path.
