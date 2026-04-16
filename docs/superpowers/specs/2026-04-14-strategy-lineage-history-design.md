# Strategy Lineage and Memory Summary in Inspect/History — Design

**Date:** 2026-04-14
**Scope:** Phase 3 / Slice 3A — enrich inspect/history for strategies and memory provenance

## Summary

The smallest useful Slice 3A is to enrich existing CLI inspect/history surfaces with two pieces of durable operator context:

1. which runs belonged to a strategy
2. whether those runs injected or promoted structured memory

This stays PR-sized by reusing current storage projections and current CLI commands instead of introducing a new strategy inspect target or broad operator console work.

## Why this slice

Current slices already provide:
- detailed inspect-time injected-memory provenance
- detailed inspect-time promoted-memory lineage
- native memory doctor checks for promotion noise

The remaining operator gap is fast, durable visibility:
- history remains too thin
- inspect does not explicitly call out strategy lineage

This slice closes that gap with summary-level data rather than widening into full strategy audit UIs.

## Proposed behavior

### 1. Persist strategy id for CLI strategy executions

For CLI strategy paths (`run` default strategy mode and explicit `run-strategy`):
- after strategy execution completes, annotate each real child run with the originating `strategyId`
- keep this slice limited to `strategyId` only
- defer broader parent/child hierarchy semantics

### 2. Inspect strategy summary

Extend `InspectSnapshot` with an optional strategy summary object:
- `strategyId`

When present, human inspect output should add a compact line such as:
- `strategy: <strategyId>`

### 3. History summary fields

Extend history entries with:
- `strategyId?`
- `injectedMemoryCount`
- `promotedStructuredMemoryCount`

Use summary counts only, not full lists.

### 4. Human history formatting

Keep history compact. Add two small summary columns/markers:
- strategy identifier or `-` when absent
- memory summary like `mem=<injected>/<promoted>`

Example shape:
- `... strategy=auto-implement-foo mem=2/1`

Exact spacing can follow formatter constraints as long as it remains terminal-readable.

## Storage approach

### Inspect

`inspectTarget(...)` should read `strategy_id` from the selected run row and include it in the inspect snapshot.

### History

`getRunHistory()` should return the new summary fields using the existing projections:
- injected count from `injected_memories` by `run_id`
- promoted count from structured memory rows whose `source_run_id = run.id`
  - for this slice, procedures are sufficient because current promoted lineage is procedure-backed

## Likely files

- `packages/kernel/src/run-loop.ts`
- `packages/kernel/src/index.ts`
- `packages/kernel/src/index.d.ts`
- `packages/storage/src/store.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/src/run-cli.ts`
- `packages/storage/test/store.test.ts`
- `apps/cli/test/formatters.test.ts`
- `apps/cli/test/run-cli.test.ts`

## Non-goals

- new `inspect strategy <id>` behavior
- graph lineage surfaces
- replay changes
- TUI changes
- full strategy-round history rendering
- new hierarchy semantics for `parentRunId`
