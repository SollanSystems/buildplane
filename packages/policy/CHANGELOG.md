# @buildplane/policy

## 0.2.2

### Patch Changes

- Updated dependencies [6e6cf64]
  - @buildplane/kernel@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [676ecda]
  - @buildplane/kernel@0.6.0

## 0.2.0

### Minor Changes

- a5de446: GAP-10: authorization envelope. Add `AuthorizationEnvelopeV0` + `EnvelopeProposal` policy vocabulary, a pure `evaluateEnvelopeAdmission` subset-admission gate, a canonical envelope digest + canonical-JSON, and carry the `authorize-envelope` subject + `envelope` field on the `operator_decision_recorded` ledger payload. The capability broker now denies a worker-binary (`claude`) `run_command` invocation that carries a permission-escape flag (e.g. `--dangerously-skip-permissions`), closing the GAP-4 carry-forward where argv0/prefix matching ignored args.

### Patch Changes

- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [716b8db]
  - @buildplane/kernel@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [4e29efd]
- Updated dependencies [2704f4f]
  - @buildplane/kernel@0.4.2

## 0.1.4

### Patch Changes

- @buildplane/kernel@0.4.1

## 0.1.3

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/kernel@0.2.0
