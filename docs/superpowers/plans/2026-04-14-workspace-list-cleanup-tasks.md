# Workspace List and Cleanup Commands — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into resume/merge/replay/TUI work.

**Goal:** Add dedicated workspace list and cleanup commands so retained/cleanup-failed workspaces are operationally manageable.

**Architecture:** Reuse the existing actionable workspace storage projection. Add a dedicated workspace command surface and one narrow storage transition for operator cleanup.

**Tech Stack:** TypeScript, pnpm workspaces, SQLite (`node:sqlite`), Vitest, Biome.

---

### Task 1: Add failing storage tests for operator cleanup transitions

**Objective:** Prove retained and cleanup-failed workspaces can transition to deleted via an operator cleanup path.

**Files:**
- Modify: `packages/storage/test/store.test.ts`

**Steps:**
1. Add a focused test for retained -> deleted cleanup.
2. Add a focused test for cleanup-failed -> deleted cleanup.
3. Add a focused rejection test for non-actionable cleanup attempts.
4. Run focused storage tests and verify failure before implementation.

### Task 2: Add failing CLI tests for workspace list and cleanup

**Objective:** Prove the new command surface and output contracts.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`

**Steps:**
1. Add a human/json `workspace list` test.
2. Add a retained-workspace cleanup end-to-end test.
3. Add a cleanup-failed workspace cleanup test.
4. Add stable-error coverage for unknown/non-actionable run ids.
5. Run focused CLI tests and verify failure before implementation.

### Task 3: Implement storage support

**Objective:** Add the narrowest storage/read-model changes needed for operator cleanup.

**Files:**
- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/index.ts`

**Steps:**
1. Add a storage helper to list actionable workspaces directly or reuse the existing projection cleanly.
2. Add a narrow operator cleanup transition that allows retained/cleanup-failed -> deleted.
3. Keep existing passed-run deletion behavior intact.
4. Re-run focused storage tests until they pass.

### Task 4: Implement CLI command surface

**Objective:** Add the new workspace namespace without disturbing existing commands.

**Files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/formatters.ts`

**Steps:**
1. Add `workspace list [--json]`.
2. Add `workspace cleanup <run-id> [--json]`.
3. Wire cleanup through the workspace adapter delete path plus storage update.
4. Keep human output compact and operator-friendly.
5. Re-run focused CLI tests until they pass.

### Task 5: Run focused verification

**Objective:** Verify the slice cleanly before review/ship.

**Run:**
```bash
npx vitest run \
  packages/storage/test/store.test.ts \
  apps/cli/test/run-cli.test.ts

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

### Task 6: Review and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 3A.

**Steps:**
1. Inspect final diff for scope creep.
2. Request independent review focused on workspace list/cleanup only.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice3a-history-strategy-lineage`.
6. Watch CI and mark ready when green.
