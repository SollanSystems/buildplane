# TUI Lifecycle and Trust Alerts — Design

**Date:** 2026-04-15
**Scope:** Phase 3 / Slice 3C — turn the TUI into a real operator console

## Summary

The smallest useful Slice 3C is to make the TUI lifecycle-correct and operator-aware for the highest-signal event types already emitted by the kernel.

This slice does not try to build a full console shell. It reuses the existing event bus and teaches the TUI to understand:

- graph lifecycle
- suspension
- budget breach alerts
- policy reasons
- optional strategy/model lineage metadata

## Why this slice

Current code already provides the right live data source:

- the kernel emits typed execution events
- `buildplane run --tui` already wires an event bus through async execution
- strategy/default runs already emit graph lifecycle events
- approval-gated flows already emit suspension events

What is missing is TUI state semantics and rendering.

This is smaller and safer than other interpretations of Slice 3C because it avoids:

- replay/event-log hydration
- multi-run dashboards
- TUI controls for approve/reject/resume
- broader storage or CLI contract changes
- major Ink layout architecture churn

## Proposed behavior

### 1. Export a real TUI state reducer/helper

Move the event-to-state transition logic into an exported pure helper in `packages/ui-tui/src/hooks/use-run-state.ts`, for example:

- `reduceRunState(state, event)`

The React hook should become a thin wrapper around that reducer.

Why:
- current tests duplicate reducer logic inline, which can drift from the real implementation
- this slice needs more lifecycle rules and should test the real logic directly

### 2. Extend TUI state with operator-console fields

Add minimal state for:

- `phase: "suspended"` in addition to existing phases
- graph summary:
  - `graphId?`
  - `graphUnitCount?`
  - `graphOutcome?`
  - `graphActive: boolean`
- suspension summary:
  - `suspensionProfile?`
  - `suspensionReason?`
- budget alert summary:
  - `budgetAlert?` with `budgetType`, `limit`, `actual`
- optional event context summary:
  - `strategyId?`
  - `parentRunId?`
  - `role?`
  - `provider?`
  - `model?`
  - `estimatedUsd?`

Do not add a general event-log buffer in this slice.

### 3. Lifecycle rule changes

- `graph-started`
  - mark graph active
  - record graph id and unit count
  - do not mark done
- child `run-completed`
  - continue to update phase
  - if graph is active, do not mark `done`
- `graph-completed`
  - record outcome
  - mark `done = true`
  - set phase based on graph outcome
- `run-suspended`
  - set `phase = "suspended"`
  - record suspension metadata
  - mark `done = true` so approval-gated raw TUI runs do not hang
- `run-resumed`
  - only update visible state if encountered before terminal completion; do not overbuild resume flows in this slice
- `policy-budget-breached`
  - record a budget alert
  - do not force terminal completion by itself

### 4. TUI rendering changes

Keep the current layout but add one small operator-summary pane above the status bar or inline with it.

Display compact, terminal-safe summaries for:

- graph: `graph <id> units=<n> outcome=<...>` when present
- suspension: `suspended by <profile>: <reason>`
- budget alert: `budget breached: <type> actual=<actual> limit=<limit>`
- policy reasons: join concise reasons when present
- context: strategy/provider/model/role/cost when available

The goal is not a new dashboard. The goal is to make the existing TUI trustworthy during live supervision.

## Likely files

- `packages/ui-tui/src/hooks/use-run-state.ts`
- `packages/ui-tui/src/app.tsx`
- `packages/ui-tui/src/index.ts`
- `test/event-stream/tui-contract.test.ts`

## Non-goals

- replay views
- workspace management in the TUI
- graph navigation or child-run drilldown
- approval controls
- storage-backed TUI queries
- new CLI flags or new TUI entrypoints
