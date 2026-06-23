# @buildplane/capability-broker

## 0.2.2

### Patch Changes

- a5de446: GAP-10: authorization envelope. Add `AuthorizationEnvelopeV0` + `EnvelopeProposal` policy vocabulary, a pure `evaluateEnvelopeAdmission` subset-admission gate, a canonical envelope digest + canonical-JSON, and carry the `authorize-envelope` subject + `envelope` field on the `operator_decision_recorded` ledger payload. The capability broker now denies a worker-binary (`claude`) `run_command` invocation that carries a permission-escape flag (e.g. `--dangerously-skip-permissions`), closing the GAP-4 carry-forward where argv0/prefix matching ignored args.
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
  - @buildplane/planforge@1.0.0

## 0.2.1

### Patch Changes

- Updated dependencies [4e29efd]
  - @buildplane/planforge@0.5.1

## 0.2.0

### Minor Changes

- 6e11495: Add `@buildplane/capability-broker` package: CapabilityBundleV0 schema, parse/validate (fail closed), and `bundleDigest` via PlanForge canonical digest (M3-S1).
