# @buildplane/capability-broker

## 0.2.4

### Patch Changes

- Updated dependencies [74dc5f1]
  - @buildplane/planforge@1.1.1

## 0.2.3

### Patch Changes

- 7c77a39: add a declarative `netEgress` host allowlist to the capability bundle. The broker schema parses, validates (non-empty hosts, no whitespace/`/`/NUL), and digest-covers the field; PlanForge maps each task's `allowedSideEffects` to a deterministic egress union (every current side-effect declares zero egress — explicit default-deny — with the map as the single extension point, e.g. a future `npm-install` → `["registry.npmjs.org"]`) and surfaces the plan-wide union on the receipt preview alongside `riskClass`. Declarative-only in v0: the field is visible and digest-covered but NOT yet enforced at the worker boundary (no verified Claude Code subprocess network-restriction flag exists).
- Updated dependencies [ba49394]
- Updated dependencies [2ce5e9d]
- Updated dependencies [18bccd0]
- Updated dependencies [7c77a39]
- Updated dependencies [ba49394]
  - @buildplane/planforge@1.1.0

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
