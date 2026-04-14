# Searchable Document Injection — Task Plan

> **For Hermes:** Use `test-driven-development` for code changes. Write the failing packet-enrichment tests first, then implement the smallest code to pass.

**Goal:** Land Phase 1 / Slice 1C so packet enrichment injects ranked searchable documents into `TaskIntent.context.memories`.

**Architecture:** Reuse the Slice 1A retrieval contract and the Slice 1B packet-enrichment pipeline. Add exact-source lookup from explicit input refs, exact-title lookup from the task objective, and FTS fallback from deterministic search terms.

**Tech Stack:** TypeScript, Vitest, SQLite (`node:sqlite`), pnpm workspace

---

### Task 1: Add failing searchable-document injection tests

**Files:**
- Modify: `apps/cli/test/packet-enrichment.test.ts`

- [ ] Add a failing test for exact-source searchable-document injection from `unit.inputRefs`.
- [ ] Add a failing test for exact-title/FTS searchable-document ranking and dedup.
- [ ] Update mixed-source ordering expectations to include searchable documents after procedures.
- [ ] Run the packet-enrichment test file and confirm the new assertions fail for the expected reason.

### Task 2: Implement searchable-document lookup in packet enrichment

**Files:**
- Modify: `apps/cli/src/packet-enrichment.ts`

- [ ] Extend the structured-memory port interface with `retrieveSearchableDocuments(...)`.
- [ ] Add helpers to parse exact source refs from `packet.unit.inputRefs`.
- [ ] Add exact-source, exact-title, and FTS retrieval + global reranking/dedup.
- [ ] Format searchable documents into concise plain memory strings.
- [ ] Re-run the packet-enrichment test file until green.

### Task 3: Verify the slice

**Files:**
- Modify only if verification fails.

- [ ] Run `npx vitest run apps/cli/test/packet-enrichment.test.ts apps/cli/test/run-cli.test.ts apps/cli/test/demo.test.ts apps/cli/test/honcho-wiring.test.ts`.
- [ ] Run `npx pnpm lint`.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] Keep validation in the ext4 worktree before pushing.
