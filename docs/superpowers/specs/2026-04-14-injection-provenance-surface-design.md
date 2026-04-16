# Injection Provenance Surface — Design

**Date:** 2026-04-14
**Scope:** Phase 1 / Slice 1D — operator-visible injection reasons

## Summary

Slice 1D should stop treating structured-memory injection as purely transient. The simplest robust design is to persist injection provenance per run in storage, then thread that data into run-result and inspect formatters.

## Proposed design

### 1. New storage table

Add a table such as `injected_memories` to `.buildplane/state.db`:

- `id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL`
- `memory_kind TEXT NOT NULL`
- `memory_id TEXT NOT NULL`
- `display_text TEXT NOT NULL`
- `match_reason TEXT NOT NULL`
- `match_class TEXT NOT NULL`
- `scope_preference_index INTEGER`
- `created_at TEXT NOT NULL`

Index:
- `CREATE INDEX injected_memories_run_id_idx ON injected_memories(run_id, rowid)`

Why this shape:
- enough to explain the prompt payload later
- no need to denormalize full memory objects yet
- stable across repo facts, procedures, and searchable documents

### 2. Packet enrichment return shape

Keep `TaskIntent.context.memories` unchanged for renderers, but enrichers should also produce structured provenance records in-process before run execution.

Recommended pattern:
- add an internal helper that returns:
  - `memories: string[]`
  - `structuredRecords: InjectedMemoryRecord[]`
- `enrichPacketWithMemories()` still returns an enriched packet for backward compatibility
- the CLI/run path captures the structured records and asks storage to persist them against the created run id

### 3. Storage port additions

Add methods on the storage side for:
- `recordInjectedMemories(runId, records)`
- `listInjectedMemories(runId)`

Thread the latter into `inspectTarget(...)` so inspect snapshots can include persisted provenance.

### 4. CLI surfaces

#### `buildplane run`
Human mode:
- keep current compact output
- when structured injections exist, append a short summary block, for example:
  - `injected-memories: 3`
  - `  - [repo-fact] commands.typecheck (fuzzy-fact-key)`
  - `  - [procedure] fix TypeScript build (exact-task-type)`

JSON mode:
- include `injectedMemories: [...]`

#### `buildplane inspect <run-id>`
Human mode:
- add section:
  - `injected-memories:`
  - one line per record with kind, label/display text, reason, optional scope index

JSON mode:
- include the persisted structured array on the snapshot

### 5. Scope boundaries

Keep Slice 1D limited to text CLI + storage + kernel snapshot plumbing.
Do not expand into:
- TUI changes
- history aggregate rollups
- new memory commands

## Likely files

- `apps/cli/src/packet-enrichment.ts`
- `apps/cli/src/run-cli.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/test/packet-enrichment.test.ts`
- `apps/cli/test/run-cli.test.ts`
- `packages/kernel/src/ports.ts`
- `packages/kernel/src/run-loop.ts` or inspect snapshot types as needed
- `packages/storage/src/store.ts`
- storage tests for injected-memory persistence

## Risk notes

- the main design constraint is run-id availability: injection happens before execution, while run ids are created by storage/orchestrator. The implementation should avoid rewriting renderer contracts just to carry provenance.
- keep the persistence format narrow so later slices can evolve matching/ranking without large schema churn.
