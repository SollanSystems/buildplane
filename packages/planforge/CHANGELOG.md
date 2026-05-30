# @buildplane/planforge

## 0.2.0

### Minor Changes

- e11cf0f: m2-s1: extract @buildplane/planforge package + runtime contract + canonical digest

  Lifts the PlanForge dry-run pipeline (`compile → validate → preview`) out of the
  CLI into a new, unit-testable `@buildplane/planforge` workspace package. The
  package owns the schema (constants + interfaces) and now exports the promoted
  runtime types `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt`
  alongside `compile`/`validate`/`preview` and `createPlanForgeDryRunPlan`. The CLI
  `planforge dry-run` handler delegates to the package, and
  `apps/cli/src/planforge-schema.ts` becomes a non-breaking re-export shim.

  `planDigest`/`inputDigest` now use a canonical, key-sorted serializer
  (`canonicalJson` + `digest`) shared with the signed-tape path, replacing the
  insertion-order `JSON.stringify`. Dry-run output is otherwise unchanged: the
  golden fixture is identical except a one-time digest update
  (`inputDigest sha256:1a2924… → sha256:ac29ab…`,
  `planDigest sha256:d73b27… → sha256:510fa9…`). The subcommand gate, the
  `--write/--execute/--admit` block, and the hardcoded dry-run stubs
  (`dryRun`/`sideEffects`/`admittedBy`/`generatedAt`) are untouched.
