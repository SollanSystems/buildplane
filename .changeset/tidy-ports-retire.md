---
"buildplane": patch
---

Default-wire the retired operator-decision ports. `createOperatorDecisionPort` / `createRunCompletionPort` spawn a signed `ledger serve --sign` append of `operator_decision_recorded` / `run_completed`, which the native signed-only denylist refuses as caller-supplied authority kinds — so every `bp web` approve/reject answered an opaque HTTP 500 and every boot re-failed the same historical recovery record. `loadCliOrchestrator` now supplies `createRetiredOperatorDecisionPort()` and `createRetiredRunCompletionPort()` (new `apps/cli/src/retired-decision-ports.ts`), which state one shared retirement reason; explicit `opts` injection still overrides both.

This is a retirement, not a repair: no surface emits `operator_decision_recorded` or `run_completed`. The ledger-backed modules are left in place and still covered by `test/ledger-integration/operator-decision-writers.test.ts`.
