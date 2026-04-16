# TUI Lifecycle and Trust Alerts — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into replay, TUI controls, multi-run dashboards, or storage/CLI surface changes.

**Goal:** Make the live TUI lifecycle-correct and operator-aware for graph runs, suspension, budget breaches, policy reasons, and optional event context.

**Architecture:** Reuse the existing event bus. Export a pure TUI reducer/helper, extend state with a few operator-summary fields, and render compact operator trust signals in the existing Ink UI.

**Tech Stack:** TypeScript, pnpm workspaces, Ink, React, Vitest, Biome.

---

### Task 1: Add failing TUI contract tests for lifecycle correctness

**Objective:** Prove the TUI stays alive for graph-backed runs and terminates correctly for suspended/raw runs.

**Files:**
- Modify: `test/event-stream/tui-contract.test.ts`

**Steps:**
1. Replace duplicated inline reducer logic with tests against the real exported reducer/helper.
2. Add a graph lifecycle test proving child `run-completed` does not finish the session while a graph is active.
3. Add a graph completion test proving `graph-completed` finishes the session.
4. Add a suspension test proving `run-suspended` enters a suspended state and marks the session done.
5. Run the focused TUI contract test and verify failure before implementation.

### Task 2: Add failing TUI contract tests for trust alerts and context

**Objective:** Prove budget alerts, policy reasons, and optional event context are captured by the real reducer.

**Files:**
- Modify: `test/event-stream/tui-contract.test.ts`

**Steps:**
1. Add a budget breach alert test.
2. Add a policy-reasons visibility test.
3. Add an optional context capture test for strategy/provider/model/cost metadata.
4. Re-run the focused TUI contract test and verify failure before implementation.

### Task 3: Implement reducer/state support

**Objective:** Add the smallest real state changes needed for operator-aware TUI behavior.

**Files:**
- Modify: `packages/ui-tui/src/hooks/use-run-state.ts`
- Modify: `packages/ui-tui/src/index.ts`

**Steps:**
1. Export a pure reducer/helper from `use-run-state.ts`.
2. Extend `RunViewState` with graph, suspension, alert, and optional context fields.
3. Implement lifecycle rules for `graph-started`, `graph-completed`, `run-suspended`, `run-resumed`, and `policy-budget-breached`.
4. Preserve existing raw-run behavior for non-graph runs.
5. Re-run focused TUI contract tests until they pass.

### Task 4: Implement compact operator-summary rendering

**Objective:** Surface the new state in the live TUI without turning this slice into a layout rewrite.

**Files:**
- Modify: `packages/ui-tui/src/app.tsx`

**Steps:**
1. Add a compact operator-summary pane or status section.
2. Render graph status when present.
3. Render suspension reason when present.
4. Render budget alert and policy reasons when present.
5. Render optional strategy/provider/model/cost metadata when present.
6. Keep the current overall TUI structure intact.

### Task 5: Run focused verification

**Objective:** Verify the slice cleanly before review/ship.

**Run:**
```bash
npx vitest run test/event-stream/tui-contract.test.ts
npx vitest run test/event-stream/operator-suspension.test.ts test/event-stream/budget-enforcement.test.ts test/graph/orchestrator-graph.test.ts

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

### Task 6: Review and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 3B.

**Steps:**
1. Inspect the final diff for scope creep.
2. Request independent review focused on TUI lifecycle correctness and trust alerts only.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice3b-workspace-list-cleanup`.
6. Watch CI and mark ready when green.
