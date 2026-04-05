# Buildplane Demo Command — Design Spec

**Date:** 2026-04-05
**Scope:** Add `buildplane demo [--model]` command that proves the flywheel compounding thesis
**Goal:** In under 60 seconds, demonstrate that a second run is smarter than the first because of what the first run learned

## Problem

The flywheel cold path (stages 4-7) is wired: runs store learnings, subsequent runs receive them. But there's no way to see it work without manually creating packets, running them, and inspecting the database. The JTBD score (6.5/10) is held back by "no proof-of-value demo." A single command should prove the thesis.

## Approach

Hybrid demo: a fast deterministic command-packet path that always works (~2s), plus an optional `--model` flag that runs real model packets through a detected host (Claude Code or Codex) to show the model actually receiving prior learnings.

The demo is thin glue over existing infrastructure — `loadCliOrchestrator`, `enrichPacketWithMemories`, `orchestrator.runPacket`, `fetchLearnings`. It proves the real system works, not a separate harness.

## Design

### 1. Command & UX Flow

`buildplane demo [--model]`

**Phase 1 — Setup (always runs):**
1. Create temp directory via `mkdtempSync`
2. Initialize git repo: `git init`, create `.gitkeep`, `git add .`, `git commit -m "init"` (the orchestrator's `assertRunnableRepository` requires a valid HEAD SHA)
3. Strip `GIT_*` environment variables from all `execSync` calls to prevent interference from the user's git config (follows existing test pattern in `run-cli.test.ts`)
4. Initialize Buildplane project via `orchestrator.initializeProject()` (creates `.buildplane/state.db`)
5. **Open memory ports AFTER init** — `state.db` doesn't exist until `initializeProject()` completes. `runDemo()` must open its own `DatabaseSync` connections after init, not rely on `loadCliOrchestrator()` which opens them at load time. See Section 4 for the bootstrapping sequence.
6. Print banner: `"Buildplane Flywheel Demo — proving runs get smarter"`

**Phase 2 — Command flywheel (always runs, ~2s):**
1. **Run 1:** Execute a command packet — `node -e` script that writes a file. Policy approves (exit 0 + output exists). Narrator prints: run ID, outcome, extracted learnings.
2. **Show stored learnings:** Query `run_learnings` table, display what was captured.
3. **Run 2:** Call `enrichPacketWithMemories(packet2, memoryPort, undefined, undefined)` on the second packet before execution. Read back `intent.context.memories` from the returned enriched packet for narrator display. Narrator highlights: `"Injecting N memories from prior runs..."` then prints each memory string from the array. Execute the enriched packet. Policy approves.
4. Print: `"✓ Flywheel closed — run 2 received learnings from run 1"`

**Phase 3 — Model flywheel (only with `--model`):**
1. Detect host (Claude Code or Codex). If none found, print `"No model host detected. Install Claude Code or Codex to see the model demo."` and skip.
2. **Run 3:** Model packet — "Write a hello world Node.js script to output/hello.js". Routed through detected host. Show the packet's `intent.context.memories` array (empty — no prior model runs in this workspace).
3. **Run 4:** Model packet — "Write another script to output/goodbye.js". Enrich with `enrichPacketWithMemories()`. Show the packet's `intent.context.memories` array — now contains learnings from runs 1-3. The model host receives these memories in its rendered prompt (but we display the raw array, not the host-internal rendered format).
4. Print: `"✓ Model received prior learnings — the flywheel compounds"`

**Phase 4 — Cleanup:**
- Print summary: runs completed, learnings stored, memories injected
- Leave temp dir for inspection, print its path

### 2. Packet Design

**Run 1 — Command packet (write a file, succeed):**

```json
{
  "unit": {
    "id": "demo-cmd-1",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["output/result.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": ["-e", "require('fs').mkdirSync('output',{recursive:true}); require('fs').writeFileSync('output/result.txt','computed value: 42')"]
  },
  "verification": {
    "requiredOutputs": ["output/result.txt"]
  },
  "intent": {
    "objective": "Compute and write result",
    "taskType": "implement",
    "context": { "files": [] },
    "constraints": { "scope": [], "verification": [] },
    "features": { "ambiguity": "low", "reversibility": "easy", "verifierStrength": "strong" }
  }
}
```

**Run 2 — Command packet (different task, same workspace):**

```json
{
  "unit": {
    "id": "demo-cmd-2",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["output/summary.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": ["-e", "require('fs').mkdirSync('output',{recursive:true}); require('fs').writeFileSync('output/summary.txt','summary: all tasks passed')"]
  },
  "verification": {
    "requiredOutputs": ["output/summary.txt"]
  },
  "intent": {
    "objective": "Summarize workspace state",
    "taskType": "implement",
    "context": { "files": ["output/result.txt"] },
    "constraints": { "scope": [], "verification": [] },
    "features": { "ambiguity": "low", "reversibility": "easy", "verifierStrength": "strong" }
  }
}
```

**Model packets (Phase 3):** Same `unit` + `verification` + `intent` shape, but with a `model` block (`provider`, `model`, `systemPrompt`) instead of `execution`. The host detection picks the executor. Model packets use `kind: "model"` and `verificationContract: "exit-0-and-required-outputs"`.

### 3. Narrator Output

Colored terminal output via `process.stdout.write` with ANSI codes. Not a TUI, not Ink — matches the existing CLI output style.

```
━━━ Buildplane Flywheel Demo ━━━━━━━━━━━━━━━━━━

Setting up temporary workspace...
  ✓ Initialized .buildplane project

── Phase 1: First Run ──────────────────────────

Running: "Compute and write result"
  ✓ Passed — exit 0, output/result.txt created
  Policy: approved
  
  Learnings extracted (read from run_learnings table):
    [fact] Run approved: Approved: run completed successfully
    [decision] implement task outcome: A implement task passed on this codebase.

── Phase 2: Flywheel Proof ─────────────────────

Fetching memories from prior runs...
  → 2 learnings found

  Injected into run 2's prompt:
    [fact] Run approved: Approved: run completed successfully
    [decision] implement task outcome: A implement task passed on this codebase.

Running: "Summarize workspace state"
  ✓ Passed — exit 0, output/summary.txt created
  Policy: approved

── Result ──────────────────────────────────────

  Run 1: stored 2 learnings
  Run 2: received 2 memories from run 1
  ✓ Flywheel closed — second run was informed by the first

  Workspace: /tmp/bp-demo-xxxxx (inspect with buildplane history)
```

With `--model`, Phases 3-4 append and show the `intent.context.memories` array on the enriched model packet (not the rendered prompt itself, which is internal to the host executor). This proves the memories are being injected without requiring visibility into the host's internal rendering.

### 4. Architecture & Files

**New file:** `apps/cli/src/demo.ts`

Single module, one exported function: `runDemo(options: { model?: boolean })`.

Contains:
- Packet factory functions that return the 4 packet objects (2 command, 2 model)
- `runDemo()` — orchestrates the phases, prints narrator output
- Host detection for `--model` flag — check for `claude` / `codex` on PATH via `execFileSync("which", ["claude"])` (safe, no shell injection)
- Bootstrapping sequence (see below)

**Modified file:** `apps/cli/src/run-cli.ts`

Add `if (command === "demo")` as an **early-return path** before the `loadCliOrchestrator(cwd)` call — same `if`-statement pattern as `memory`, `pack show`, `install`, `uninstall` which are dispatched before the orchestrator is loaded (lines 476-529 of `run-cli.ts`). The demo manages its own temp directory and orchestrator; it must not load one for the user's `cwd`.

```typescript
if (command === "demo") {
  const modelFlag = args.includes("--model");
  const { runDemo } = await import("./demo.js");
  await runDemo({ model: modelFlag });
  return;
}
```

**Bootstrapping sequence inside `runDemo()`:**

`loadCliOrchestrator()` cannot be reused as-is because it opens memory port DB connections at load time, but `state.db` doesn't exist until after `initializeProject()`. The demo constructs its own orchestrator in two phases:

1. Create temp dir, init git repo (using `execFileSync("git", [...])` with stripped `GIT_*` env vars)
2. Create initial orchestrator WITHOUT `memoryPort` — call `initializeProject()` to create `state.db`
3. Open `DatabaseSync` connections NOW (read-only for enrichment, read-write for orchestrator)
4. Re-create orchestrator WITH `memoryPort: writeMemoryPort` for post-run learning hooks
5. Run 1 via the memory-aware orchestrator (writes learnings)
6. Read learnings via `readMemoryPort.fetchLearnings()` for narrator display
7. Enrich Run 2 packet via `enrichPacketWithMemories(packet2, readMemoryPort, undefined, undefined)`
8. Run 2 via the memory-aware orchestrator (receives enriched packet)

**Reused infrastructure (no changes needed):**
- `enrichPacketWithMemories()` — in `packet-enrichment.ts`
- `createLearningStore()` — exported from `@buildplane/storage`
- `resolveProjectLayout()` — exported from `@buildplane/storage`
- `bootstrapStorageProjectionSchema()` — handles `run_learnings` table
- `createBuildplaneOrchestrator()` — accepts `memoryPort` option
- `extractLearnings()` — called internally by orchestrator hooks

## Files Changed

| File | Change |
|------|--------|
| `apps/cli/src/demo.ts` | **Create** — demo orchestration, packet factories, narrator output |
| `apps/cli/src/run-cli.ts` | **Modify** — add `case "demo":` with `--model` flag parsing |
| `apps/cli/test/demo.test.ts` | **Create** — integration test: 2 runs complete, learnings stored, memories injected on run 2 |

## Tests

| Test File | Coverage |
|-----------|----------|
| `apps/cli/test/demo.test.ts` | Run `runDemo({ model: false })` against temp dir. Assert: 2 runs pass, `run_learnings` has entries after run 1, run 2's enriched packet contains memories. |

## Explicitly Out of Scope

- **TUI rendering** — plain stdout, not Ink
- **Progress bars / spinners** — narrator prints lines as they complete
- **`--model` without host detection** — no direct API key fallback; if no host, skip model phase
- **Cleanup of temp dir** — left for user inspection
- **Demo for graphs or strategies** — single-packet runs only; strategy demo is a future feature

## Success Criteria

1. `buildplane demo` runs in under 5 seconds, prints the full narrator output, and exits 0
2. The narrator clearly shows learnings extracted from run 1 and injected into run 2
3. `buildplane demo --model` (with Claude Code or Codex installed) shows the `intent.context.memories` array populated with prior learnings on the model packet
4. `buildplane demo --model` (without host) gracefully skips the model phase with a message
5. One integration test proves the command flywheel works end-to-end
