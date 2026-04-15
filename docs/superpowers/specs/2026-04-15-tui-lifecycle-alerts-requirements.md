# TUI Lifecycle and Trust Alerts — Requirements

**Date:** 2026-04-15
**Scope:** Phase 3 / Slice 3C — turn the TUI into a real operator console

## Goal

Make the live TUI lifecycle-correct and operator-aware for the highest-signal run states that already exist in the event stream.

## Problem

Buildplane already emits richer execution events than the TUI currently understands:

- graph lifecycle events (`graph-started`, `graph-completed`)
- operator suspension events (`run-suspended`, `run-resumed`)
- budget breach alerts (`policy-budget-breached`)
- optional event context metadata (`strategyId`, `parentRunId`, `role`, `provider`, `model`, `cost`)

But the current TUI still behaves like a stub:

- it treats the first `run-completed` event as terminal even when a strategy/graph is still active
- it does not surface operator suspension or budget breach state
- it tracks policy reasons internally but does not show them
- it does not expose strategy/model lineage already present on the event bus

This makes the TUI misleading during real supervision, especially for strategy-backed runs and approval-gated flows.

## In scope

- make TUI state graph-aware so a strategy/graph-backed run stays live until the enclosing graph completes
- surface run suspension as a visible terminal operator state
- surface budget breaches as operator-facing trust alerts
- surface existing policy reasons in the TUI
- surface optional event context metadata when present
- add focused TUI contract tests against real reducer logic rather than duplicated inline test logic

## Out of scope

- replay or event-log rehydration into the TUI
- TUI approval/reject controls
- resume/recover automation from the TUI
- multi-run dashboards
- DAG visualization or graph navigation
- storage schema or inspect/history changes
- requiring every kernel event producer to populate all optional context metadata
- broad TUI layout rewrites beyond what is needed for the new operator panes

## Functional requirements

1. For graph-backed runs, the TUI must not mark the session done on the first child `run-completed` event.
2. The TUI must mark the session done when the enclosing `graph-completed` event arrives.
3. For non-graph raw runs, `run-completed` must continue to mark the TUI done.
4. `run-suspended` must transition the TUI into a visible suspended/operator-attention state and allow the session to terminate cleanly.
5. `policy-budget-breached` must be recorded as an operator-facing alert that includes at least:
   - budget type
   - limit
   - actual
6. `policy-decision` reasons must be visible in the TUI when present.
7. Optional event context metadata must be captured and shown when present without breaking runs where it is absent.
8. Focused TUI contract tests must exercise the real reducer/helper logic used by the UI, not a hand-copied approximation.

## Acceptance criteria

- a graph-backed TUI run stays live until `graph-completed`
- a suspended raw TUI run surfaces the suspension reason and exits cleanly
- a budget-breached run shows an explicit trust alert in the TUI state/view
- policy reasons are visible in the TUI
- strategy/model context is visible when present and absent safely when missing
- focused TUI contract tests pass
