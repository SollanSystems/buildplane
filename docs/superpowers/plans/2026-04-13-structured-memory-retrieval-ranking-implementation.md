# Structured Memory Retrieval Ranking — Implementation Plan

> **For Hermes:** Use `test-driven-development` for code changes and keep this slice limited to contracts, storage retrieval, and focused tests.

**Goal:** Land Phase 1 / Slice 1A with ranked retrieval interfaces for repo facts, procedures, and searchable documents.

**Architecture:** Put the ranking contract in `packages/kernel`, keep storage responsible for collecting candidates from SQLite, and have storage return ranked, deduplicated read-model rows that later slices can inject into packets.

**Tech Stack:** TypeScript, Vitest, SQLite (`node:sqlite`)

---

### Task 1: Add the kernel ranking contract

**Files:**
- Create: `packages/kernel/src/memory-retrieval.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.d.ts`
- Test: `packages/kernel/test/memory-retrieval.test.ts`

- [x] Write failing tests for deterministic ranking and exact-first ordering.
- [x] Add retrieval query/result types plus the ranking helper.
- [x] Export the new contract from the kernel package.
- [x] Re-run the kernel test file until green.

### Task 2: Add ranked repo-fact retrieval

**Files:**
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/storage/src/store.ts`
- Test: `packages/storage/test/repo-facts.test.ts`

- [ ] Write failing tests for exact fact-key matches beating fuzzy matches and for caller-supplied scope order.
- [ ] Add the new storage-port method signature.
- [ ] Implement ranked candidate collection, deduplication, and limiting in `store.ts`.
- [ ] Re-run the repo-fact test file until green.

### Task 3: Add ranked procedure retrieval

**Files:**
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/storage/src/store.ts`
- Test: `packages/storage/test/procedures.test.ts`

- [ ] Write failing tests for exact task-type/name matches beating fuzzy body matches.
- [ ] Implement the storage-port method and procedure text fallback.
- [ ] Deduplicate rows matched by multiple exact/fuzzy rules.
- [ ] Re-run the procedure test file until green.

### Task 4: Add ranked searchable-document retrieval

**Files:**
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/storage/src/store.ts`
- Test: `packages/storage/test/searchable-documents.test.ts`

- [ ] Write failing tests for exact source/title matches beating FTS fallback.
- [ ] Implement the storage-port method on top of the existing FTS table.
- [ ] Deduplicate exact + FTS hits in favor of the exact explanation.
- [ ] Re-run the searchable-document test file until green.

### Task 5: Verify the slice

**Files:**
- Modify only if verification fails.

- [ ] Run targeted Vitest files for the touched kernel/storage areas.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] If Linux/ext4 parity looks suspicious, validate in a disposable `/tmp` worktree before pushing.
