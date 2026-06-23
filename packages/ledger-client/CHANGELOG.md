# @buildplane/ledger-client

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
