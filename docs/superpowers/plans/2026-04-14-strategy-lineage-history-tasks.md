# Strategy Lineage and Memory Summary in Inspect/History — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into TUI work, replay changes, graph lineage UI, or new inspect target kinds.

**Goal:** Enrich existing CLI inspect/history surfaces so operators can see strategy lineage and memory provenance summaries at a glance.

**Architecture:** Persist `strategyId` for CLI strategy-created child runs, extend storage inspect/history projections with strategy/memory summary fields, then surface those fields in existing human/JSON CLI outputs.

**Tech Stack:** TypeScript, pnpm workspaces, SQLite (`node:sqlite`), Vitest, Biome.

---

### Task 1: Add failing storage tests for strategy + history summaries

**Objective:** Prove storage inspect/history projections expose strategy lineage and memory summary counts.

**Files:**
- Modify: `packages/storage/test/store.test.ts`

**Steps:**
1. Add a focused test that creates a run with `strategyId` and attached injected/promoted memory records.
2. Assert `inspectTarget(runId)` exposes strategy summary.
3. Assert `getRunHistory()` exposes `strategyId`, `injectedMemoryCount`, and `promotedStructuredMemoryCount`.
4. Run the focused test and verify failure before implementation.

### Task 2: Add failing formatter tests

**Objective:** Prove human inspect/history output renders the new strategy/memory summaries.

**Files:**
- Modify: `apps/cli/test/formatters.test.ts`

**Steps:**
1. Add a history formatting test for strategy + `mem=<injected>/<promoted>` output.
2. Add an inspect formatting test for compact strategy summary.
3. Run the focused tests and verify failure before implementation.

### Task 3: Implement storage inspect/history projections

**Objective:** Extend storage result shapes with the minimum fields needed for the new operator summaries.

**Files:**
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.d.ts`
- Modify: `packages/storage/src/store.ts`

**Steps:**
1. Extend inspect/history types with optional strategy and summary-count fields.
2. Read `strategy_id` from run rows into inspect snapshots.
3. Add history summary counts for injected and promoted structured memories.
4. Re-run focused storage tests until they pass.

### Task 4: Persist strategy ids for CLI strategy paths

**Objective:** Make CLI-created strategy child runs carry the originating `strategyId` durably.

**Files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `packages/storage/src/store.ts` if a small helper is needed

**Steps:**
1. Add the narrowest storage update/helper needed to annotate completed child runs with `strategyId`.
2. Call it from both CLI strategy paths:
   - default `run` strategy mode
   - explicit `run-strategy`
3. Keep this slice limited to `strategyId`; do not widen into new parent-run semantics.

### Task 5: Implement formatter updates

**Objective:** Surface strategy lineage and memory summaries in human inspect/history output.

**Files:**
- Modify: `apps/cli/src/formatters.ts`

**Steps:**
1. Add compact history rendering for strategy + memory summary.
2. Add compact inspect rendering for strategy summary.
3. Keep output quiet when fields are absent.
4. Re-run focused formatter tests until they pass.

### Task 6: Add CLI integration tests

**Objective:** Prove real CLI history/inspect surfaces carry the new fields for strategy runs.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`

**Steps:**
1. Add a focused CLI test that runs a strategy path and then checks `history --json`.
2. Add a focused CLI inspect regression for strategy summary via run or unit inspect.
3. Run the focused tests and verify they pass.

### Task 7: Run focused verification

**Objective:** Verify the slice cleanly before review/ship.

**Run:**
```bash
npx vitest run \
  packages/storage/test/store.test.ts \
  apps/cli/test/formatters.test.ts \
  apps/cli/test/run-cli.test.ts

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

### Task 8: Review and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 2C.

**Steps:**
1. Inspect final diff for scope creep.
2. Request independent review focused on strategy lineage + history summaries only.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice2c-memory-doctor-noise`.
6. Watch CI and mark ready when green.
