---
"@buildplane/storage": minor
"@buildplane/kernel": minor
---

S4: append-only run_outcomes write path

Adds the layer-5 outcome-memory write path: a new append-only `run_outcomes`
table (one row per finished run, with a `(repo_id, source_run_id)` unique index
for idempotency), `WorkerLabel`/`AppendRunOutcomeInput`/`RunOutcome` types,
idempotent `appendRunOutcome`/`listRunOutcomes` on `BuildplaneStoragePort`, and a
recorder at `finalizeRun` that appends each model run's `(taskType, worker,
success)`. Model packets only (`packet.model !== undefined`); command/non-model
packets and executor infra-crashes append no row. No routing behavior changes —
a write-only outcome row is added per in-scope terminal run.
