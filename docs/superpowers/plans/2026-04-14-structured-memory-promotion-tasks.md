# Structured Memory Promotion — Task Plan

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into lineage UI or non-procedure promotion.

**Goal:** Land Phase 2 / Slice 2A so selected multi-round strategy workflow learnings are promoted into durable procedure memory.

**Architecture:** Use the strategy post-run hook to derive a canonical procedure candidate from workflow learnings and persist it via existing procedure storage.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, SQLite (`node:sqlite`)

---

### Task 1: Define focused promotion tests

**Files:**
- Modify: `packages/kernel/test/orchestrator-memory.test.ts`
- Maybe modify: `packages/kernel/test/outcome-extractor.test.ts`

- [ ] Add failing test for promoting a multi-round strategy workflow learning into a procedure.
- [ ] Add failing idempotency test for identical repeated promotion.
- [ ] Add failing supersede test when the canonical procedure body changes.
- [ ] Run only the new focused tests to verify they fail for the expected reason.

### Task 2: Implement canonical procedure promotion

**Files:**
- Modify: `packages/kernel/src/orchestrator.ts`

- [ ] Add a small helper that builds a canonical procedure candidate from strategy workflow learning + implementer packet intent.
- [ ] Persist the candidate via existing procedure storage.
- [ ] Make identical candidates a no-op.
- [ ] Supersede prior canonical procedure when the body changes.
- [ ] Keep existing `run_learnings` writes and `promoteLearnings(...)` behavior unchanged.

### Task 3: Verify the slice

- [ ] Run focused kernel tests for orchestrator memory behavior.
- [ ] Run any touched outcome extractor / procedure tests.
- [ ] Run `npx pnpm lint`.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] Run independent review before commit/push.
