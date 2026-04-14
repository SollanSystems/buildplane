# Structured Memory Injection — Task Plan

> **For Hermes:** Use `test-driven-development` for code changes. Write the failing packet-enrichment tests first, then implement the smallest code to pass.

**Goal:** Land Phase 1 / Slice 1B so packet enrichment injects ranked repo facts and procedures into `TaskIntent.context.memories`.

**Architecture:** Keep packet enrichment as the orchestration point. Reuse Slice 1A retrieval APIs, keep renderers unchanged, and format structured memories as plain strings.

**Tech Stack:** TypeScript, Vitest, SQLite (`node:sqlite`), pnpm workspace

---

### Task 1: Add the red tests for structured injection

**Files:**
- Modify: `apps/cli/test/packet-enrichment.test.ts`

- [ ] Add a failing test that injects repo facts and procedures into a packet with an intent.
- [ ] Add a failing test that proves deterministic mixed ordering across local learnings, structured memories, and Honcho memories.
- [ ] Add a failing test that keeps no-op behavior when no structured matches exist.
- [ ] Run only the packet-enrichment test file and confirm the new assertions fail for the expected reason.

### Task 2: Implement structured retrieval in packet enrichment

**Files:**
- Modify: `apps/cli/src/packet-enrichment.ts`

- [ ] Add a structured-memory port interface that exposes repo-fact and procedure retrieval.
- [ ] Add deterministic helpers for search-term extraction, scope-candidate derivation, deduplication, and formatting.
- [ ] Retrieve top-ranked repo facts and procedures and append their formatted strings to `intent.context.memories`.
- [ ] Re-run the packet-enrichment test file until green.

### Task 3: Wire the CLI to provide structured memory context

**Files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/demo.ts`
- Modify: `eval/runner.ts`

- [ ] Create a structured-memory storage port in the CLI when local Buildplane state exists.
- [ ] Resolve current branch on a best-effort basis and pass it into packet enrichment.
- [ ] Update demo/eval call sites to the new enrichment signature.
- [ ] Re-run the focused packet-enrichment tests after wiring changes.

### Task 4: Verify the slice

**Files:**
- Modify only if verification fails.

- [ ] Run `npx vitest run apps/cli/test/packet-enrichment.test.ts`.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] If a failure looks environment-specific, reproduce from the current `/tmp` ext4 worktree before making broader changes.
