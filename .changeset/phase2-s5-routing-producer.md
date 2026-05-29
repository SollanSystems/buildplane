---
"@buildplane/kernel": minor
---

S5: outcome aggregation + opt-in score-driven routing producer

Closes the layer-5 outcome-memory loop on the read/steer side. Adds a pure
`outcome-scoring` module (`aggregateOutcomeScores` with read-time recency decay
plus an undecayed `rawSamples` count, and `chooseWorker` with a seed-free
least-sampled cold-start rotation that converges, exploit-best-rate, and an
optional per-run epsilon hook) and a `fillRoutingHints` producer that fills
`routingHints.preferredWorker` from those scores. The producer runs inside
`prepareRun` before `createRun`, so the persisted `unit_snapshot` route equals
the executed route and the S4 recorder's reading (recorded route == actual
route). Model packets only, fill-not-override, `sdk`/undefined leaves the hint
absent. Opt-in via `outcomeRouting` on the orchestrator options, default OFF —
when disabled the producer is never called, `listRunOutcomes` is never queried,
and routing is unchanged.
