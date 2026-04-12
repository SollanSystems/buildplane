# M10 T4: Inspect Surfaces — Design Spec

**Date:** 2026-04-12
**Scope:** Add TS-native memory list/inspect commands and augment run inspector with learnings
**Goal:** Make the flywheel visible to operators without requiring the Rust native binary

## Problem

The flywheel is wired and proven (T3 eval shows 80% memory-injected rate), but opaque. An operator cannot see what was learned, why it was surfaced, or how many times it fired. The existing `buildplane memory <action>` dispatches to the Rust native binary, which requires a separate build step and isn't available in pure TS flows. The existing `buildplane inspect <run-id>` shows workspace, events, and decisions — but nothing about what the flywheel learned from the run.

## Design

### 1. TS-Native Memory Subcommands

Intercept `memory list` and `memory inspect` in the TS CLI before the native fallthrough. All other `memory` subcommands continue to dispatch to native.

#### `buildplane memory list [--scope X] [--kind X] [--json]`

Shows a table of all active learnings. Uses the existing `fetchLearnings()` method on the read-only memory port already constructed in `loadCliOrchestrator()`.

**Text output:**

```
ID           Scope      Kind                  Seen  Title
a1b2c3d4     workspace  constraint            3     Run rejected
e5f6g7h8     workspace  fact                  1     Verification gate passed
i9j0k1l2     session    provider_heuristic    2     Required retry to pass
```

**JSON output (`--json`):** Array of `StoredLearning` objects.

**Flags:**
- `--scope session|workspace|user` — filter by scope
- `--kind fact|constraint|workflow|provider_heuristic|decision|preference` — filter by kind
- `--json` — JSON output

#### `buildplane memory inspect <id> [--json]`

Shows full detail for one learning. Requires a new `fetchLearningById(id)` method.

**Text output:**

```
ID:         a1b2c3d4
Title:      Run rejected
Scope:      workspace
Kind:       constraint
Status:     active
Seen:       3
Run:        run_xyz123
Created:    2026-04-12T01:00:00Z

Body:
Rejected: exit code 1. Missing output: output/result.txt. Contract: exit-0-and-required-outputs.
```

**JSON output (`--json`):** Single `StoredLearning` object.

#### Dispatch Logic

In `run-cli.ts`, the `memory` case currently dispatches everything to native:

```typescript
if (command === "memory") {
  return await runNativeCommand(rest, { ... });
}
```

Changed to intercept `list` and `inspect`:

```typescript
if (command === "memory") {
  const subcommand = rest[0];
  if (subcommand === "list" || subcommand === "inspect") {
    // Handle in TS using the read-only memory port
  }
  // Fall through to native for all other subcommands
  return await runNativeCommand(rest, { ... });
}
```

The TS handler needs the read-only memory port. Currently `loadCliOrchestrator()` is only called for run commands and observe commands. For `memory list/inspect`, we need a lighter path that only opens the read-only database connection without constructing the full orchestrator, event bus, runtime router, etc.

**New function `loadReadOnlyMemoryPort(projectRoot: string)`:**

```typescript
async function loadReadOnlyMemoryPort(
  projectRoot: string,
): Promise<MemoryPortLike | undefined> {
  try {
    const { resolveProjectLayout, createLearningStore } = await import("@buildplane/storage");
    const { DatabaseSync } = await import("node:sqlite");
    const layout = resolveProjectLayout(projectRoot);
    if (existsSync(layout.stateDbPath)) {
      const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
      return createLearningStore(readDb);
    }
  } catch {
    // Memory port unavailable
  }
  return undefined;
}
```

This avoids the full orchestrator bootstrap cost for read-only memory commands.

### 2. Augmented Run Inspector

The existing `buildplane inspect <run-id>` handler gains a **learnings** section showing what the flywheel learned from this specific run.

**Output (appended after existing fields):**

```
kind: run
run-id: run_xyz123
...existing fields...

learnings:
  [workspace/constraint] Run rejected (seen: 3)
  [workspace/fact] Verification gate passed (seen: 1)
```

**How it works:**
- The CLI `inspect` handler already has the `run.id` from the snapshot
- After calling `orchestrator.inspect(id)`, query the memory port with `fetchLearningsByRunId(runId)`
- Pass the learnings array into `formatInspectDetail()` as an optional parameter
- If no memory port or no learnings, the section is omitted (backward compatible)

**New method on `BuildplaneMemoryPort`:**

```typescript
fetchLearningsByRunId(runId: string): readonly StoredLearning[];
```

Implementation in `learning-store.ts`: `SELECT ... FROM run_learnings WHERE run_id = ? AND status = 'active' ORDER BY created_at ASC` — no limit, since a single run produces at most 3-4 learnings.

**Not included:** "memories injected into this run" — injection is transient (happens in `enrichPacketWithMemories()` and isn't persisted). Storing injection provenance would be a schema change for a future milestone.

### 3. New Port Methods

Added to `BuildplaneMemoryPort` in `packages/kernel/src/ports.ts`:

```typescript
fetchLearningById(id: string): StoredLearning | undefined;
fetchLearningsByRunId(runId: string): readonly StoredLearning[];
```

Both are synchronous (backed by `DatabaseSync`). Both filter by `status = 'active'`.

### 4. Help Menu Update

```
  Project:
    init                   Initialize .buildplane in this repo
    memory list            Show stored learnings
    memory inspect <id>    Detail for one learning
    memory <action>        Advanced memory operations (native)
    pack show <id>         Inspect a pack
```

## Files Changed

| File | Change |
|------|--------|
| `packages/kernel/src/ports.ts` | Add `fetchLearningById` and `fetchLearningsByRunId` to `BuildplaneMemoryPort` |
| `packages/storage/src/learning-store.ts` | Implement `fetchLearningById` and `fetchLearningsByRunId` |
| `apps/cli/src/run-cli.ts` | Intercept `memory list` and `memory inspect` in TS; add `loadReadOnlyMemoryPort()` helper; augment existing `inspect` handler to query + display learnings |
| `apps/cli/src/formatters.ts` | Add `formatLearningsList()` (table), `formatLearningDetail()` (full detail), augment `formatInspectDetail()` with optional learnings parameter |

## Tests

| Test File | Coverage |
|-----------|----------|
| `packages/storage/test/learning-store.test.ts` | 2 new tests: `fetchLearningsByRunId` returns learnings for that run only; `fetchLearningById` returns single learning or undefined for missing ID |
| `apps/cli/test/run-cli.test.ts` | 3 new tests: `memory list` returns formatted table; `memory inspect <id>` returns detail; `inspect <run-id>` includes learnings section |

## Explicitly Out of Scope

- **`memory search`, `memory forget`, `memory promote`** — Phase 1 contract commands, future milestone
- **Injection provenance** ("what memories were injected into this run") — requires schema change to persist injection records
- **Any Rust changes** — TS-only scope
- **Closing the read-only database connection** — `DatabaseSync` connections are closed on GC; the CLI process exits after the command

## Success Criteria

1. `buildplane memory list` shows a formatted table of active learnings from `state.db` — no Rust binary needed
2. `buildplane memory list --json` produces a JSON array of `StoredLearning` objects
3. `buildplane memory list --scope workspace` filters to workspace-scoped learnings only
4. `buildplane memory inspect <id>` shows full detail for one learning
5. `buildplane memory inspect <id> --json` produces a single `StoredLearning` JSON object
6. `buildplane memory inspect <nonexistent-id>` exits with error message
7. `buildplane inspect <run-id>` includes a `learnings:` section when the run produced learnings
8. `buildplane inspect <run-id>` omits the learnings section when no memory port or no learnings (backward compat)
9. Unknown `memory` subcommands still fall through to native dispatch
10. All existing tests pass (`pnpm test`)
