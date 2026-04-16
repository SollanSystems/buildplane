# Promotion Lineage in Inspect Output — Task Plan

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into repo-fact/doc lineage or memory doctor work.

**Goal:** Land Phase 2 / Slice 2B so `inspect` explains which durable procedures were promoted from a run's workflow learnings.

**Architecture:** Extend the inspect snapshot with promoted structured-memory lineage, populate it from storage using existing Slice 2A provenance, and surface it in human/JSON inspect output.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, SQLite (`node:sqlite`)

---

### Task 1: Define failing lineage tests

**Files:**
- Modify: `packages/storage/test/store.test.ts`
- Modify: `apps/cli/test/formatters.test.ts`
- Modify: `apps/cli/test/run-cli.test.ts`

- [ ] Add failing storage test proving inspect snapshots include promoted procedures for a run and preserve superseded lineage.
- [ ] Add failing formatter test proving human inspect output includes a `promoted-memories:` section safely.
- [ ] Add failing CLI test proving `buildplane inspect` surfaces promoted procedure lineage in human and JSON output.
- [ ] Run the focused tests and verify they fail for the expected reason.

### Task 2: Implement inspect lineage surface

**Files:**
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.d.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `apps/cli/src/formatters.ts`

- [ ] Add a promoted structured-memory record type to the inspect contract.
- [ ] Populate inspect snapshots from storage using existing procedure promotion provenance.
- [ ] Include superseded promoted procedures in the lineage view.
- [ ] Render a terminal-safe `promoted-memories:` section in human inspect output.

### Task 3: Verify the slice

- [ ] Run focused storage/formatter/CLI inspect tests.
- [ ] Run `npx pnpm lint`.
- [ ] Run `npx pnpm typecheck`.
- [ ] Run `npx pnpm build`.
- [ ] Run independent review before commit/push.
