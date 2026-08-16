---
"@buildplane/kernel": patch
---

Retire the operator-decision write surface at the kernel seam. `OperatorDecisionPort` and `RunCompletionPort` gain an optional `retired` marker; when either carries it, `recordOperatorDecision` throws the new `OperatorDecisionSurfaceRetiredError` before validation, the Tier-2 emit, the Tier-1 shadow row and the side effect — the same fail-closed position the existing port-absent guard holds. The surface is retired as one unit, so a live decision port paired with a retired completion port cannot emit a signed decision it could never terminally complete.

A retired completion port also makes startup recovery non-recurring. A historical decided-but-unexecuted terminal record previously re-failed on every boot (the signed `run_completed` emit throws, so the execution marker was never written and the record never left the pending feed). The terminal emit is now skipped, the Tier-1 side effect and its marker complete exactly once, and each such record is reported in the new required `PendingDecisionRecovery.completionEventsSkipped` field — the un-emitted tape evidence is disclosed, not dropped silently. Consumers reading a recovery summary must account for the new field.
