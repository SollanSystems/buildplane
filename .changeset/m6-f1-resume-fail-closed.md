---
"buildplane": patch
"@buildplane/kernel": patch
"@buildplane/storage": patch
---

fail-close PlanForge `resume`/`recover` on unverified recorded work (M6-F1).

Crash recovery was receipt-grade, not pipeline-grade: `resume`/`recover` executed the
remaining suffix with ZERO acceptance machinery and counted every recorded-prefix
activity as `passed` without checking that acceptance ever evaluated, then minted a
`completed` receipt — a fail-open on the product's core trust surface.

Now the resumed suffix runs under acceptance enforcement equivalent to `dispatch`
(per-task `deriveAcceptanceContract` profiles + `profileRegistry`, a per-task-identity
`acceptancePort`, `resultReadyPort`, and provisioned worktree deps), and a recorded
activity only counts toward a `completed` receipt when the tape carries a matching
signed `acceptance_recorded` verdict (`plan_id` + `admission_event_id` + the re-derived
`contract_digest` + `outcome == "passed"`). Passed verdicts are consumed once, counted as
a multiset keyed by `contract_digest`: because the digest intentionally excludes the task
id, sibling tasks with identical allowed-side-effects + verification-commands share a
digest, so N recorded-passed tasks with digest D require N distinct passed verdicts for D —
one verdict can never clear a sibling task whose acceptance never ran. Missing/rejected
evidence, with enforcement
on, fail-closes: receipt outcome `failed`, exit 1, and a machine-readable per-task reason
`acceptance-not-evaluated` in both the JSON output and the receipt's committed result.

Enforcement is ON by default for both `resume` and `recover`; a new
`--no-enforce-acceptance` flag opts out. The decision comes only from the CLI flag —
never the unsigned dispatch-manifest sidecar. At the terminal receipt (and in the
`already_receipted` short-circuit) the orphaned `running` storage rows are reconciled to
a terminal status consistent with the outcome (new
`BuildplaneStoragePort.reconcilePlanForgeDispatchRuns`), closing the M2 "receipt on tape
but running in storage → reconcile" line and making a second `recover` pass report
`no_orphans`. Recorded-prefix reused runs still get no synthetic `result_ready` — only
executed-suffix packets emit it via the threaded ports, exactly as dispatch does.
