# buildplane

## 0.3.0

### Minor Changes

- 72416c2: Phase 1 memory subsystem slices:

  - **Repo-fact seeding** — `bootstrap seed [--json]` detects repo signals (primary language, test/build/typecheck/lint commands) and seeds durable `repo.*` structured facts via the existing `upsertRepoFact` port.
  - **Memory CLI reads** — `memory facts [--scope --json]` and `memory procedures [--task-type --json]` subcommands over the existing `listRepoFacts`/`listProcedures` reads; storage errors now surface instead of being swallowed.
  - **Reviewer memory injection** — reviewer packets now carry a review `intent` and the reviewer leg's enriched memories are persisted (`recordInjectedMemories`) on both the `run-strategy` and default `run --packet` paths.

## 0.2.0

### Minor Changes

- b46a88d: Add `buildplane pack export` for GitHub custom-agent and skill guidance exports.
