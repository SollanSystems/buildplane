---
"@buildplane/kernel": minor
"@buildplane/ledger-client": minor
---

emit the signed `result_ready` and `run_completed` L0 events write-ahead at a run's
terminal outcome (M6-S7). New kernel seams `ResultReadyPort.recordResultReady(runId,
admissionEventId, acceptanceEventId)` and `RunCompletionPort.recordRunCompleted(...)`
are injected into the orchestrator; `BuildplaneAcceptancePort.recordAcceptance` now
resolves to the signed `acceptance_recorded` event id so a terminal `result_ready`
can chain to it.

`result_ready` fires only once a run reaches its terminal `passed` outcome (after
`policy.evaluateRun`'s terminal advance — NOT when a per-attempt acceptance resolves
`passed`, A1), so a run that passes acceptance on an attempt but terminates `failed`
signs no false `result_ready`. `run_completed` fires write-ahead on every terminal
branch of the operator decision (merge+approved → `passed`; merge/resume rejection →
`failed`; A2); the emit stays synchronous/`void` and its fields are supplied
synchronously from the inspect snapshot.

`RunCompletedV1.{duration_ms,event_count,unit_count}` now serialize as strings on the
wire (per-field override on that struct only — the global `U64 = number` typeshare
mapping is untouched), matching `ResultReadyV1`'s all-string shape for byte-identical
Rust↔TS digests (A3). Safe with no tape migration: `run_completed` was never emitted
onto any real tape.
