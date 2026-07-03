# @buildplane/mission-control-server

## 0.1.1

### Patch Changes

- 0f1b42e: wire the M5-S4 crash reconciler into startup and isolate its records per-item (R2).

  The `recoverPendingDecisions` reconciler previously had no production call site — it was interface + tests only, so a crash between an operator decision's Tier-1 mirror and its execution marker was never re-driven on the next boot. The mission-control-server now invokes it exactly once on boot (inside `listen`, before binding) and logs the recovered count; a failed record is logged and startup proceeds.

  `recoverPendingDecisions` now resolves with a `PendingDecisionRecovery` summary (`{ recovered, failed }`) instead of `void`, and wraps each record's side-effect re-drive in a try/catch so one poisoned record can no longer wedge the whole batch. A record whose re-drive throws is reported under `failed` (keeping its missing execution marker so a later pass retries it) while the remaining records still recover.

- 790ff11: harden the mission-control READ API against DNS-rebinding and error leakage. Every request now passes a `Host`/`Origin` allowlist (loopback names plus the configured bind host) before any route runs, so a browser page on a rebound attacker domain is rejected with 403 instead of exfiltrating run data; the guard is disabled only for an explicit external bind, where legitimate hostnames cannot be enumerated. Unhandled request failures now return a generic `{ error: "internal_error" }` body with the detailed error logged server-side, rather than leaking `error.message` to the client.
- Updated dependencies [0f1b42e]
- Updated dependencies [fb96406]
  - @buildplane/kernel@0.8.0
