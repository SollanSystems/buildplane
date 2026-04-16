# Promotion Lineage in Inspect Output — Design

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2B — explain promotion lineage in inspect output

## Summary

The smallest useful follow-up to Slice 2A is to surface promoted structured-memory lineage directly in run/unit inspect output. Because Slice 2A currently promotes only procedures, Slice 2B should expose promoted procedures only, while keeping the record shape generic enough for future expansion.

## Proposed behavior

### 1. Inspect snapshot contract

Extend `InspectSnapshot` with a new optional field:
- `promotedStructuredMemories`

Each record should include:
- `memoryKind` (`procedure` for this slice)
- `memoryId`
- `title`
- `taskType?`
- `bodySummary?`
- `status`
- `promotionRule?`
- `sourceRunId?`
- `sourceTaskId?`
- `createdAt`

This keeps JSON output structured and human formatting simple.

### 2. Storage lookup

`inspectTarget(id)` should populate `promotedStructuredMemories` by querying structured memories with:
- `source_run_id = <inspected run id>`
- promotion metadata present

For Slice 2B, only procedures need to be queried.

Important detail:
- include both `active` and `superseded` promoted procedures
- otherwise lineage disappears after a later canonical replacement

### 3. Human formatting

`formatInspectDetail(...)` should render a new `promoted-memories:` section when lineage exists.

Suggested shape:
- `[procedure] <title>: <summary> (status=<status>, rule=<promotionRule>, source-task=<sourceTaskId>)`

Reuse terminal-safe sanitization.

### 4. Scope discipline

Keep the slice narrow:
- no new CLI command
- no memory-doctor work
- no repo-fact/doc lineage yet
- no schema migration required beyond existing provenance fields

## Likely files

- `packages/kernel/src/run-loop.ts`
- `packages/kernel/src/index.ts`
- `packages/kernel/src/index.d.ts`
- `packages/storage/src/store.ts`
- `packages/storage/test/store.test.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/test/formatters.test.ts`
- `apps/cli/test/run-cli.test.ts`

## Risks

1. If lineage only shows active procedures, superseded promotions become invisible and provenance appears broken.
2. If same-name non-promoted procedures are included, inspect output becomes noisy and misleading.
3. If human output prints raw body text, inspect output can regress terminal-safety guarantees.

## Non-goals

- memory lineage across all memory kinds
- promotion lineage in status/history/TUI
- memory-item inspect/explain redesign
