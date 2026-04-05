# Flywheel Cold Path MVP — Design Spec

**Date:** 2026-04-04
**Scope:** Wire memory flywheel stages 4-7 end-to-end in TypeScript
**Goal:** A second run is demonstrably smarter than the first because of what the first run learned

## Problem

The flywheel hot path (dispatch → observe → verify, stages 1-3) is fully working. The cold path (extract → write → promote → reuse, stages 4-8) has all schema and domain types built but no wiring between run outcomes and memory. Every run starts cold. Until the cold path closes, Buildplane is a dispatcher, not a self-learning system.

## Approach

TS-only with a new `run_learnings` SQLite table in the existing storage package. No Rust changes, no NAPI bridge. The Rust memory layer (`bp-memory`, `bp-storage-sqlite`) stays as-is — this MVP proves the flywheel concept in TS so the Rust port can be done with confidence about the right abstractions.

Honcho stays as optional parallel enrichment, not the primary memory path.

## Design

### 1. Schema — `run_learnings` Table

Added to `bootstrapStorageProjectionSchema()` in `packages/storage/src/store.ts`:

```sql
CREATE TABLE IF NOT EXISTS run_learnings (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  scope            TEXT NOT NULL,    -- 'session' | 'workspace' | 'user' | 'pack'
  kind             TEXT NOT NULL,    -- 'fact' | 'decision' | 'constraint' | 'preference' | 'workflow' | 'provider_heuristic'
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded' | 'archived'
  promoted_from_id TEXT,
  source_run_id    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_learnings_run_id ON run_learnings (run_id);
CREATE INDEX IF NOT EXISTS idx_run_learnings_scope ON run_learnings (scope);
CREATE INDEX IF NOT EXISTS idx_run_learnings_status ON run_learnings (status);
```

**Backwards-compatible migration:** Following the existing pattern (`ensureEvidenceMessageColumn`, `ensureRunsUsedWorkspaceColumn`, `ensureRunsStrategyColumns` at lines 126-149 of `store.ts`), add an `ensureRunLearningsTable()` function that uses `CREATE TABLE IF NOT EXISTS`. Call it from `bootstrapStorageProjectionSchema()`. Do **not** add `run_learnings` to `assertStorageProjectionSchema()` — this table is additive and optional; older databases without it should not error, they simply have no learnings yet.

Mirrors the Rust `memory_items` schema shape (scope, kind, status, promoted_from_id) but drops columns only needed at scale (tags_json, applicable_packs_json, origin_pack, source_type). The `source_run_id` column creates lineage: learning → originating run → evidence.

### 2. Outcome Extractor

New file: `packages/kernel/src/outcome-extractor.ts`

Pure function — no I/O, no storage calls. Takes run data in, returns structured learnings out.

```typescript
export interface ExtractedLearning {
  readonly kind: 'fact' | 'decision' | 'constraint' | 'preference' | 'workflow' | 'provider_heuristic';
  readonly scope: 'session' | 'workspace' | 'user' | 'pack';
  readonly title: string;
  readonly body: string;
}

export interface OutcomeExtractionInput {
  readonly run: Run;
  readonly receipt: ExecutionReceipt;
  readonly decision: PolicyDecision;
  readonly packet: UnitPacket;
  readonly strategyResult?: StrategyResult;
  readonly attemptCount?: number;
}

export function extractLearnings(input: OutcomeExtractionInput): ExtractedLearning[];
```

Note: The input takes `run`, `receipt`, and `decision` as separate fields (not a full `RunPacketResult`) because at the hook point in `finalizeRun()`, these are the variables in scope. The extractor must narrow `decision` internally — on the success path it will be `ApprovedPolicyDecision`, on the failure path `RejectedPolicyDecision`.

**Extraction rules:**

| Signal | Learning Kind | Scope | Example |
|--------|--------------|-------|---------|
| `decision.outcome === "approved"` + reasons | `fact` | `session` | "Tests passed with exit code 0 on first attempt" |
| `decision.outcome === "rejected"` + reasons | `constraint` | `session` | "Reviewer rejected: missing error handling in auth module" |
| Strategy round count > 1 | `workflow` | `workspace` | "Required 2 implement-review rounds; feedback was: [reasons]" |
| First attempt failed, retry succeeded | `provider_heuristic` | `workspace` | "Model needed retry with feedback for this task type" |
| `packet.intent?.taskType` + outcome pattern | `decision` | `workspace` | "implement tasks on this codebase tend to pass on first attempt" |

No LLM summarization — pattern matching only. No deduplication — storage handles volume via fetch limits. No promotion decisions — separate concern.

### 3. Memory Port

Added to `packages/kernel/src/ports.ts`. Requires new import:

```typescript
import type { ExtractedLearning } from "./outcome-extractor.js";
```

```typescript
export interface BuildplaneMemoryPort {
  writeLearnings(runId: string, learnings: readonly ExtractedLearning[]): void;
  fetchLearnings(options?: {
    scope?: 'session' | 'workspace' | 'user' | 'pack';
    kind?: ExtractedLearning['kind'];
    limit?: number;
  }): readonly StoredLearning[];
}

export interface StoredLearning extends ExtractedLearning {
  readonly id: string;
  readonly runId: string;
  readonly status: 'active' | 'superseded' | 'archived';
  readonly createdAt: string;
}
```

### 4. Learning Store Implementation

New file: `packages/storage/src/learning-store.ts`

- `writeLearnings()` → INSERT into `run_learnings` with `randomUUID()` IDs
- `fetchLearnings()` → SELECT WHERE `status = 'active'`, ordered by `created_at DESC`, optional scope/kind filters, default limit 20
- Uses the same `DatabaseSync` instance the existing store holds

### 5. Orchestrator Hook

In `packages/kernel/src/orchestrator.ts`, `finalizeRun()` gains an optional `memoryPort` parameter on `CreateBuildplaneOrchestratorOptions`:

```typescript
export interface CreateBuildplaneOrchestratorOptions {
  // ... existing fields ...
  readonly memoryPort?: BuildplaneMemoryPort;
}
```

**Success path** — after `commitRunSuccessOutcome()` (line ~363), before workspace cleanup (line ~377):

```typescript
if (memoryPort) {
  try {
    const learnings = extractLearnings({
      run: completedRun,
      receipt,
      decision: approvedDecision,
      packet: validatedPacket,
    });
    if (learnings.length > 0) {
      memoryPort.writeLearnings(completedRun.id, learnings);
    }
  } catch {
    // Silent — never break the run for memory
  }
}
```

**Failure path** — after `commitRunFailureOutcome()` in the **policy rejection branch only** (lines ~293-331 of `orchestrator.ts`, where `decision.outcome === "rejected"`). Do **not** hook into `finalizeInfrastructureFailure()` — infrastructure failures (workspace-prepare, runtime-execution) have no policy decision to extract learnings from. Same try/catch-swallow pattern.

Follows the established silent-side-effect convention (see `honcho-adapter.ts:134-140`).

### 6. CLI Memory Injection (Closing the Loop)

**Restructuring `loadCliOrchestrator`:** Currently the Honcho adapter is constructed inside `loadCliOrchestrator()` (lines 158-183 of `run-cli.ts`) and never surfaced to `runCli()`. To support memory injection, `loadCliOrchestrator` must return both the orchestrator and the optional adapters:

```typescript
interface CliOrchestratorBundle {
  orchestrator: BuildplaneCliOrchestrator;
  memoryPort?: BuildplaneMemoryPort;
  honchoAdapter?: HonchoPort;
  userId?: string;
}

async function loadCliOrchestrator(projectRoot: string): Promise<CliOrchestratorBundle> {
  // ... existing code ...
  // Construct memoryPort from LearningStore using the same database
  // Return { orchestrator, memoryPort, honchoAdapter, userId }
}
```

**Memory injection** — in `runCli()`, after loading the packet but before execution. Note: `packet` must be declared with `let` (not `const`) to allow reassignment, or use a separate `enrichedPacket` variable:

```typescript
const { orchestrator, memoryPort, honchoAdapter, userId } = await loadCliOrchestrator(projectRoot);

// ... load packet ...

let enrichedPacket = packet;
if (memoryPort && enrichedPacket.intent) {
  const localLearnings = memoryPort.fetchLearnings({ limit: 10 });

  // Honcho merge — fetchContext is async, fetchLearnings is sync (DatabaseSync)
  const honchoMemories = honchoAdapter && userId
    ? (await honchoAdapter.fetchContext(userId)).memories
    : [];

  const memories = [
    ...localLearnings.map(l => `[${l.kind}] ${l.title}: ${l.body}`),
    ...honchoMemories.map(m => `[honcho] ${m}`),
  ];

  if (memories.length > 0) {
    enrichedPacket = {
      ...enrichedPacket,
      intent: {
        ...enrichedPacket.intent,
        context: {
          ...enrichedPacket.intent.context,
          memories,
        },
      },
    };
  }
}
```

Same pattern for `run-graph` (inject into each graph node's intent) and `run-strategy` (inject into each strategy child's packet intent).

No renderer changes needed — `claude-renderer.ts:48-53` and the Codex renderer already handle `intent.context.memories`. They just never received data until now.

## Files Changed

**Existing files modified:**

| File | Change |
|------|--------|
| `packages/storage/src/store.ts` | Add `ensureRunLearningsTable()` migration + call from `bootstrapStorageProjectionSchema()`. Do NOT add to `assertStorageProjectionSchema()`. |
| `packages/kernel/src/ports.ts` | Add `import type { ExtractedLearning }` from `outcome-extractor.js`. Add `BuildplaneMemoryPort` + `StoredLearning` interfaces. |
| `packages/kernel/src/orchestrator.ts` | Add `memoryPort` option + extraction hook in `finalizeRun()` success path (after line ~363) + policy rejection path (lines ~293-331). |
| `packages/kernel/src/index.ts` | Re-export new types + `extractLearnings` |
| `packages/storage/src/index.ts` | Re-export `LearningStore` |
| `apps/cli/src/run-cli.ts` | Restructure `loadCliOrchestrator` to return `CliOrchestratorBundle` (orchestrator + memoryPort + honchoAdapter). Wrap `deps.createOrchestrator()` test-injection branch as `{ orchestrator: deps.createOrchestrator() }` so optional fields default to `undefined` (benign — memory injection is guarded by `if (memoryPort && ...)`). Add pre-run memory injection in `runCli` for run, run-graph, run-strategy. |

**New files created:**

| File | Purpose |
|------|---------|
| `packages/kernel/src/outcome-extractor.ts` | Pure extraction function + types |
| `packages/storage/src/learning-store.ts` | SQLite implementation of `BuildplaneMemoryPort` |

## Tests

| Test File | Coverage |
|-----------|----------|
| `packages/kernel/test/outcome-extractor.test.ts` | Every extraction rule — approved, rejected, retried, strategy multi-round |
| `packages/storage/test/learning-store.test.ts` | CRUD: write, fetch by scope/kind, limit, status filtering, promoted_from_id |
| `packages/kernel/test/orchestrator-memory.test.ts` | Integration: run completes → learnings persisted → next run gets memories. Both with and without memoryPort (backward compat) |

## Explicitly Out of Scope

- **Promotion logic** (session → workspace → user) — schema supports via `promoted_from_id`, wiring is a separate feature
- **LLM-powered extraction** — too slow for the run path, future enhancement
- **Memory CLI commands in TS** — currently Rust-only, not needed to prove the loop
- **Deduplication / superseding** — future; `limit` on fetch handles volume for now
- **FTS search on learnings** — Rust layer has this, TS doesn't need it yet
- **Any changes to the Rust native layer**

## Success Criteria

After this build, the following demo works:

1. `buildplane run --packet task.json` → run completes, learnings extracted and stored
2. `buildplane run --packet task2.json` → second run's prompt includes `## Relevant Memories` section with learnings from run 1
3. The model's behavior in run 2 is informed by what happened in run 1

This proves the flywheel compounding thesis. Everything else (promotion, LLM extraction, deduplication, Rust port) makes it better — this makes it exist.
