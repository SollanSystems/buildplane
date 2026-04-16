# Injection Provenance Surface — Task Plan

> **For Hermes:** This slice is schema-touching and inspect-surface work. Keep it narrow, test-first, and do not widen into TUI or unrelated memory commands.

**Goal:** Land Phase 1 / Slice 1D so operators can see which structured memories were injected into a run and why.

**Architecture:** Persist injected-memory provenance per run, then expose it through run-result and inspect formatters.

**Tech Stack:** TypeScript, Vitest, SQLite (`node:sqlite`), pnpm workspace

---

### Task 1: Add storage contract and persistence tests

**Files:**
- Modify: `packages/kernel/src/ports.ts`
- Modify: storage snapshot/result types as needed
- Modify: `packages/storage/src/store.ts`
- Test: storage test file for injected memories

- [ ] Add failing tests for recording and listing injected memories by run id.
- [ ] Add schema bootstrap/migration support for `injected_memories`.
- [ ] Add storage read/write helpers and inspect snapshot plumbing.
- [ ] Re-run the focused storage tests until green.

### Task 2: Capture injection provenance in the CLI path

**Files:**
- Modify: `apps/cli/src/packet-enrichment.ts`
- Modify: `apps/cli/src/run-cli.ts`
- Test: `apps/cli/test/packet-enrichment.test.ts`
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] Write failing tests for returning/persisting structured injection records.
- [ ] Keep plain `intent.context.memories` output intact.
- [ ] Persist records against the created run id.
- [ ] Re-run focused CLI tests until green.

### Task 3: Surface provenance in operator output

**Files:**
- Modify: `apps/cli/src/formatters.ts`
- Modify: inspect/run CLI output paths
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] Add failing tests for human and JSON inspect/run output.
- [ ] Add compact run summary lines plus detailed inspect section.
- [ ] Keep no-record paths backward-compatible.
- [ ] Re-run focused output tests until green.

### Task 4: Verify the slice

- [ ] Run focused storage + CLI tests.
- [ ] Run `npx pnpm lint`.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] Validate on ext4 before push.
