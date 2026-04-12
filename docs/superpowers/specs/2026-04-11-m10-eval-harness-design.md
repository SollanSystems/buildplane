# M10 T3: Eval Harness — Design Spec

**Date:** 2026-04-11
**Scope:** Create `pnpm eval` command that runs fixtures through a 4-condition matrix and proves the flywheel injects memories
**Goal:** Produce a `memory_injected_rate` number that proves learnings from run 1 reach run 2's prompt

## Problem

The flywheel is wired (T1+T2 shipped), but there's no automated proof that it works beyond the demo command. No eval harness exists to benchmark memory on vs off, or strategy vs raw. The JTBD doc lists "no eval harness to benchmark against raw agents" as a gap.

## Design

### 1. Eval Runner

New file: `eval/runner.ts` — main entry point invoked via `pnpm eval [--suite local] [--json]`.

**Per-fixture flow:**
1. Discover fixture directories in `eval/suites/<suite>/` (each has `run-1.json`, `run-2.json`, `meta.json`)
2. For each fixture, run under 4 conditions (each gets its own fresh temp project):
   - **memory+strategy**: run-1 seeds learnings → enrich run-2 with memories → wrap as strategy → execute
   - **memory+raw**: run-1 seeds learnings → enrich run-2 with memories → single-shot
   - **nomemory+strategy**: run-1 seeds learnings → skip enrichment on run-2 → wrap as strategy → execute
   - **nomemory+raw**: run-1 seeds learnings → skip enrichment on run-2 → single-shot
3. Collect per-condition result: `{ passed: boolean, rounds: number, learningsWritten: number, memoriesInjected: number, durationMs: number }`

**Bootstrapping per condition:** Same two-phase pattern as `demo.ts`:
- `mkdtempSync` → `git init` → `git commit --allow-empty` → `initializeProject()`
- Open read-only + read-write `DatabaseSync` connections
- Create orchestrator with `memoryPort: writeMemoryPort`
- Run run-1 packet (always with full memory — this seeds the workspace)
- Then run run-2 under the condition's settings

**Memory on vs off:** When memory is "off" for run-2, call `orchestrator.runPacket(packet)` directly without `enrichPacketWithMemories`. When memory is "on", call `enrichPacketWithMemories(packet, readMemoryPort, undefined, undefined)` before execution.

**Strategy on vs off:** When strategy is "on", call `wrapAsStrategy(packet)` → `orchestrator.runStrategy()`. When "off" (`raw`), call `orchestrator.runPacket()` or `orchestrator.runPacketAsync()`.

**Dynamic imports:** Same `as unknown as { ... }` cast pattern used by `demo.ts` and `run-cli.ts`.

### 2. Fixtures

Each fixture in `eval/suites/local/` is a directory containing:
- `run-1.json` — first packet (seeds workspace with learnings)
- `run-2.json` — second packet (benefits from memories if injected)
- `meta.json` — `{ "name": "...", "description": "..." }`

All fixtures use `node -e "..."` commands — deterministic, no model, no host detection.

**5 starter fixtures:**

**`write-then-verify/`** — Run 1 writes `output/result.txt` (succeeds, generates verification-gate-win learning). Run 2 writes `output/summary.txt` (succeeds). Proves: learning from run 1 injected into run 2.

**`fail-then-learn/`** — Run 1 exits with code 1 (fails, generates rejection constraint + forbidden-path learning). Run 2 is a command that succeeds. Proves: rejection learnings stored and available as memories.

**`multi-output/`** — Run 1 writes 3 output files (generates verification-gate-win listing all 3 paths). Run 2 writes 1 file. Proves: multi-path learning injected.

**`empty-outputs/`** — Run 1 succeeds with no expected outputs (no learnings generated — Rule 7 requires outputChecks). Run 2 succeeds with outputs. Proves: zero-learning case doesn't break the pipeline; `memoriesInjected` is 0.

**`duplicate-runs/`** — Run 1 and run 2 are the same packet. Proves: dedup increments `seen_count`, fetch returns deduplicated result.

### 3. Report

New file: `eval/report.ts` — formats results as a table (text) or JSON.

**Text output:**
```
━━━ Buildplane Eval Report ━━━━━━━━━━━━━━━━━━━━

Fixture                  Condition           Passed  Rounds  Memories  Duration
write-then-verify        memory+strategy     ✓       1       1         45ms
write-then-verify        memory+raw          ✓       —       1         22ms
write-then-verify        nomemory+strategy   ✓       1       0         43ms
write-then-verify        nomemory+raw        ✓       —       0         21ms
...

━━━ Aggregates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Fixtures:              5
  Total conditions:      20
  Pass rate:             95% (19/20)
  Memory injected rate:  100% (5/5 memory-on fixtures had memories)
  Memory helped rate:    60% (3/5 where memory-on outperformed memory-off)
  Mean duration:         35ms
```

**`memory_injected_rate`:** Count of fixtures where memory-on conditions had `memoriesInjected > 0` / total fixtures. This is the primary M10 success metric.

**`memory_helped_rate`:** Count of fixtures where `memory+strategy` had a better outcome than `nomemory+strategy` — either: (a) memory passed but nomemory failed, or (b) memory used fewer rounds. For deterministic command fixtures, outcome parity is expected. The rate captures injection presence, not behavioral delta. Behavioral proof requires model fixtures (future `eval/suites/model/`).

**JSON output (`--json`):**
```typescript
interface ConditionResult {
  readonly condition: "memory+strategy" | "memory+raw" | "nomemory+strategy" | "nomemory+raw";
  readonly passed: boolean;
  readonly rounds: number;
  readonly learningsWritten: number;
  readonly memoriesInjected: number;
  readonly durationMs: number;
}

interface FixtureResult {
  readonly name: string;
  readonly description: string;
  readonly conditions: readonly ConditionResult[];
}

interface EvalReport {
  readonly suiteId: string;
  readonly fixtures: readonly FixtureResult[];
  readonly aggregates: {
    readonly totalFixtures: number;
    readonly totalConditions: number;
    readonly passRate: number;
    readonly memoryInjectedRate: number;
    readonly memoryHelpedRate: number;
    readonly meanDurationMs: number;
  };
}
```

### 4. Files + Integration

**New files:**

| File | Purpose |
|------|---------|
| `eval/runner.ts` | Main entry: fixture discovery, 4-condition matrix, orchestrator bootstrap |
| `eval/report.ts` | `EvalReport` type, text + JSON formatters |
| `eval/suites/local/write-then-verify/{run-1,run-2,meta}.json` | Fixture: passing run seeds learning |
| `eval/suites/local/fail-then-learn/{run-1,run-2,meta}.json` | Fixture: failing run seeds constraint |
| `eval/suites/local/multi-output/{run-1,run-2,meta}.json` | Fixture: 3 outputs in learning |
| `eval/suites/local/empty-outputs/{run-1,run-2,meta}.json` | Fixture: no learnings case |
| `eval/suites/local/duplicate-runs/{run-1,run-2,meta}.json` | Fixture: dedup proof |

**Modified files:**

| File | Change |
|------|--------|
| `package.json` | Add `"eval": "node --import tsx ./eval/runner.ts"` script |

**No changes to kernel, storage, CLI, or any existing package.**

## Reused Infrastructure (no changes)

- `@buildplane/kernel` — `createBuildplaneOrchestrator()`, `createEventBus()`
- `@buildplane/storage` — `createBuildplaneStorage()`, `resolveProjectLayout()`, `createLearningStore()`
- `@buildplane/runtime` — `executePacket()`
- `@buildplane/policy` — `evaluateRun()`
- `@buildplane/adapters-git` — `createGitWorktreeAdapter()`
- `apps/cli/src/packet-enrichment.ts` — `enrichPacketWithMemories()`
- `apps/cli/src/strategy-wrapper.ts` — `wrapAsStrategy()`

## Explicitly Out of Scope

- **CI integration** (`.github/workflows/eval.yml`) — follow-up after harness works locally
- **Model fixtures** (`eval/suites/model/`) — requires host detection, future work
- **Vitest tests for the eval harness itself** — the harness IS a test tool; it verifies itself by running
- **Custom fixture format** — JSON packets are the format, no DSL

## Success Criteria

1. `pnpm eval --suite local` exits 0 and prints a formatted report
2. `pnpm eval --suite local --json` produces a valid `EvalReport` JSON object
3. `memoryInjectedRate > 0` — at least one fixture shows memories were injected on run 2 under memory-on conditions
4. `memoriesInjected === 0` for all nomemory conditions (proves the toggle works)
5. `empty-outputs` fixture shows 0 learnings written and 0 memories injected (zero case handled)
6. All existing tests still pass (`pnpm test`)
