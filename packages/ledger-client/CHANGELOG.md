# @buildplane/ledger-client

## 0.3.0

### Minor Changes

- fb96406: emit the signed `result_ready` and `run_completed` L0 events write-ahead at a run's
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

### Patch Changes

- b197580: add the `result_ready` signed L0 event kind (M6-S6). New tape vocabulary
  `ResultReadyV1 { run_id, admission_event_id, acceptance_event_id }` (all `String`
  on the wire — no `u64` precision hazard) signalling a run reached a terminal,
  operator-reviewable accepted result, chaining to the `plan_admitted` and
  `acceptance_recorded` events. Full nine-file derivation: `EventKind::ResultReady`,
  the payload struct + `#[typeshare]` binding, the `Payload::ResultReadyV1`
  registration, the `canonicalize.rs` `kind_to_variant`/`payload_variant_name` arms,
  the mandatory `bp-replay` no-op transition arm (exhaustive match), round-trip +
  canonicalize + golden-byte + signed-append tests, the regenerated TS types, the
  hand-edited `Payload` union, and the regenerated `payload-variants.json` fixture.
  No emit path yet — signing/emit lands in M6-S7.

## 0.2.0

### Minor Changes

- a5de446: GAP-10: authorization envelope. Add `AuthorizationEnvelopeV0` + `EnvelopeProposal` policy vocabulary, a pure `evaluateEnvelopeAdmission` subset-admission gate, a canonical envelope digest + canonical-JSON, and carry the `authorize-envelope` subject + `envelope` field on the `operator_decision_recorded` ledger payload. The capability broker now denies a worker-binary (`claude`) `run_command` invocation that carries a permission-escape flag (e.g. `--dangerously-skip-permissions`), closing the GAP-4 carry-forward where argv0/prefix matching ignored args.
- a5de446: add `operator_decision_recorded` signed L0 event kind (`OperatorDecisionRecordedV1` payload). Records operator approve/reject decisions on a merge or resume subject. Kernel-signed; the operator identity is the `decided_by` payload field. No emitter or consumer yet — this slice lands the kind + payload + cross-language derivation only.

## 0.1.2

### Patch Changes

- e61e3f2: feat(ledger): add M4 acceptance_recorded L0 payload and EventKind

## 0.1.1

### Patch Changes

- 77b2a14: add M2 plan/activity signed tape event kinds (plan_admitted, plan_receipt, activity_started, activity_completed) to the TS payload union + fixtures; fold M2-S1 planforge review nits
