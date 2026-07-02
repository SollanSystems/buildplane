---
"@buildplane/kernel": patch
"@buildplane/mission-control-server": patch
---

wire the M5-S4 crash reconciler into startup and isolate its records per-item (R2).

The `recoverPendingDecisions` reconciler previously had no production call site — it was interface + tests only, so a crash between an operator decision's Tier-1 mirror and its execution marker was never re-driven on the next boot. The mission-control-server now invokes it exactly once on boot (inside `listen`, before binding) and logs the recovered count; a failed record is logged and startup proceeds.

`recoverPendingDecisions` now resolves with a `PendingDecisionRecovery` summary (`{ recovered, failed }`) instead of `void`, and wraps each record's side-effect re-drive in a try/catch so one poisoned record can no longer wedge the whole batch. A record whose re-drive throws is reported under `failed` (keeping its missing execution marker so a later pass retries it) while the remaining records still recover.
