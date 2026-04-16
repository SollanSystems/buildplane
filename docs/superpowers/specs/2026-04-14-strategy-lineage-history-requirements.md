# Strategy Lineage and Memory Summary in Inspect/History — Requirements

**Date:** 2026-04-14
**Scope:** Phase 3 / Slice 3A — enrich inspect/history for strategies and memory provenance

## Goal

Make Buildplane operator surfaces show, durably and at a glance, when a run belonged to a strategy and whether that run injected or promoted structured memory.

## Problem

Buildplane inspect already shows detailed injected-memory provenance and promoted-memory lineage for individual runs, but operator trust surfaces still have an important gap:

- `history` does not show whether a run was part of a strategy
- `history` does not summarize whether a run injected or promoted structured memory
- `inspect` does not show a compact strategy lineage summary for a run or unit even when that run came from strategy execution

This makes it hard to answer basic operator questions quickly:
- Was this run part of a strategy or just a single run?
- Did this run use structured memory?
- Did this run create durable promoted memory?

## In scope

- persist and surface a run-level `strategyId` for CLI strategy executions
- extend inspect output with a compact strategy lineage summary when present
- extend history output with compact strategy + memory provenance summary fields
- expose the new fields in both human and JSON CLI surfaces
- add focused storage, formatter, and CLI tests

## Out of scope

- new CLI commands or inspect target kinds
- TUI/operator console work
- replay behavior changes
- graph lineage UI
- retained-workspace recovery/status UX
- full per-history-entry lists of injected or promoted memories
- new parent/child run hierarchy semantics beyond strategy id

## Functional requirements

1. Strategy-executed child runs created through CLI strategy paths must persist the originating `strategyId`.
2. Inspecting a run that belongs to a strategy must surface a compact strategy summary.
3. Inspecting a unit must surface the same strategy summary through the latest run when that run belongs to a strategy.
4. Run history entries must expose a count of injected structured memories for each run.
5. Run history entries must expose a count of promoted structured memories linked to each run.
6. Human history output must remain compact while making strategy/memory summary visible at a glance.
7. Human inspect output must remain backward-compatible when no strategy context exists.
8. Existing inspect memory sections (`injected-memories`, `promoted-memories`, `learnings`) must remain intact.

## Acceptance criteria

- `buildplane history --json` includes `strategyId`, `injectedMemoryCount`, and `promotedStructuredMemoryCount` fields
- human `buildplane history` visibly marks strategy runs and memory provenance summaries
- `buildplane inspect <run-id>` shows strategy lineage when present
- `buildplane inspect <unit-id>` shows the same strategy lineage via the latest run
- default non-strategy runs remain quiet and unchanged apart from zero/absent summary fields
- focused tests pass
