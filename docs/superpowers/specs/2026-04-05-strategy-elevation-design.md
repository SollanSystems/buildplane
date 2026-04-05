# Strategy Elevation + CLI IA Redesign — Design Spec

**Date:** 2026-04-05
**Scope:** Make `buildplane run` default to implement-then-review; restructure CLI help into grouped sections
**Goal:** The strongest differentiator becomes the default experience — every run is self-correcting unless the user explicitly opts out

## Problem

The implement-then-review strategy executor is fully implemented and tested. But it's buried behind `buildplane run-strategy --strategy <path>`, a power-user command nobody discovers. `buildplane run --packet task.json` does single-shot execution — the least impressive thing Buildplane does. The CLI help is a flat list of 13 commands with no signal about what matters.

## Approach

CLI-layer auto-wrapping: a pure function `wrapAsStrategy()` in a new file transforms any `UnitPacket` into a `StrategyPacket` with an auto-generated reviewer. The `case "run"` block dispatches to `orchestrator.runStrategy()` by default. `--raw` opts out. No kernel changes.

## Design

### 1. Auto-Wrapping Logic

New file: `apps/cli/src/strategy-wrapper.ts`

One exported pure function: `wrapAsStrategy(packet: UnitPacket): StrategyPacket`

**Packet type detection:** If a packet has `.model`, treat it as a model packet. If it has `.execution` (and no `.model`), treat it as a command packet. `parseUnitPacket()` enforces that packets don't have both.

**For model packets** (packet has `.model`):

- **Implementer `StrategyChild`:** `{ role: "implementer", packet: originalPacket }`
- **Reviewer `StrategyChild`:** `{ role: "reviewer", dependsOn: [originalPacket.unit.id], packet: reviewerPacket }`
  - Note: `dependsOn` is on the `StrategyChild` wrapper, NOT inside the reviewer's `UnitPacket`. This follows the `StrategyChild` interface in `types.ts` and the existing `smoke-strategy.json` convention. (The strategy executor hardcodes dependency ordering internally, but setting `dependsOn` maintains consistency with `parseStrategyPacket` validation.)
  - **Reviewer `UnitPacket`** — complete shape:
    - `unit.id`: `"${originalId}-reviewer"`
    - `unit.kind`: `"model"`
    - `unit.scope`: `"task"` (same as implementer)
    - `unit.inputRefs`: implementer's `unit.expectedOutputs` (reviewer reads what implementer produces)
    - `unit.expectedOutputs`: `[]` (reviewer produces no artifacts)
    - `unit.verificationContract`: `"exit-0-and-required-outputs"` (with empty `requiredOutputs`, this is effectively exit-0; `"exit-0"` is not a recognized contract value in the policy engine)
    - `unit.policyProfile`: `"default"`
    - `model`: same block as implementer (same provider/model)
    - `model.systemPrompt` replaced with: `"You are a code reviewer. The implementer was asked to: ${packet.intent?.objective ?? 'complete the assigned task'}. Examine the workspace and verify the output meets the objective. If the work is correct and complete, exit successfully. If there are issues, exit with a non-zero code and explain what's wrong."`
    - `verification`: `{ requiredOutputs: [] }`
    - No `intent` field (reviewer doesn't need task intent or memory enrichment)

**For command packets** (packet has `.execution`):

- **Implementer `StrategyChild`:** `{ role: "implementer", packet: originalPacket }`
- **Reviewer `StrategyChild`:** `{ role: "reviewer", dependsOn: [originalPacket.unit.id], packet: reviewerPacket }`
  - **Reviewer `UnitPacket`** — complete shape:
    - `unit.id`: `"${originalId}-reviewer"`
    - `unit.kind`: `"command"`
    - `unit.scope`: `"task"`
    - `unit.inputRefs`: implementer's `unit.expectedOutputs`
    - `unit.expectedOutputs`: `[]`
    - `unit.verificationContract`: `"exit-0-and-required-outputs"`
    - `unit.policyProfile`: `"default"`
    - `execution.command`: `"sh"`
    - `execution.args`: `["-c", "test -s output1.txt && test -s output2.txt"]` (one `test -s` per expected output, joined with `&&`)
    - If implementer has no `expectedOutputs` or it's empty, the command is `"true"` (always approves — nothing to check)
    - `verification`: `{ requiredOutputs: [] }`
    - No `intent` field

**Strategy packet wrapper:**

```typescript
{
  id: `auto-${packet.unit.id}`,
  mode: "implement-then-review",
  mergePolicy: "reviewer-must-approve",
  children: [implementerChild, reviewerChild]
}
```

### 2. CLI Run Path Changes

Modified: `apps/cli/src/run-cli.ts`, `case "run"` block.

**New flag:**
- `--raw` — bypass wrapping, use current single-shot behavior (shorthand for single-shot mode)
- Existing flags (`--packet`, `--tui`, `--json`) unchanged
- No `--mode` flag — YAGNI. `--raw` is sufficient. If more modes are needed later, add `--mode` then.

**Modified flow:**

```
1. Load packet from --packet path (unchanged)
2. Enrich implementer packet with memories via enrichPacketWithMemories (unchanged)
3. Check flags:
   a. If --raw → current path (runPacket / runPacketAsync) — backward compat
   b. Otherwise:
      - import wrapAsStrategy from "./strategy-wrapper.js"
      - const strategy = wrapAsStrategy(enrichedPacket)
      - Note: enrichStrategyWithMemories is NOT called again — the implementer was already
        enriched in step 2, and the reviewer has no `intent` field so enrichment is a no-op.
      - const result = await orchestrator.runStrategy(strategy, eventBus)
      - format StrategyResult output
4. Format and output result
```

**Note on reviewer feedback:** When the strategy executor injects feedback between rounds, it uses `decision.reasons` from the policy layer (not the model's raw stdout/stderr). For command-based reviewers this is sufficient (pass/fail). For model-based reviewers, the policy reasons may be generic ("run failed"). This is acceptable for the MVP — richer feedback extraction (parsing model stderr) is a future enhancement.

**Output formatting for strategy results:**

When running as strategy, the result is a `StrategyResult`. The formatter shows:
- Implementer outcome (passed/failed)
- Reviewer outcome (approved/rejected)
- Round count if > 1: `"Passed after N rounds — reviewer feedback incorporated"`
- Final verdict: passed/failed

For `--json`, output the raw `StrategyResult` object.

**Backward compatibility:** `buildplane run --packet task.json` now defaults to implement-then-review. Scripts depending on single-shot add `--raw`. This is a deliberate improvement — the default gets better.

**Note on `--tui`:** When `--tui` is combined with strategy mode (no `--raw`), create the event bus and pass it to `orchestrator.runStrategy()`. The TUI already handles strategy events.

### 3. CLI Help Restructuring

`formatTopLevelHelp()` rewritten with grouped sections:

```
━━━ Buildplane ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Execute:
    run --packet <path>    Run with implement-then-review (default)
    demo [--model]         Prove the flywheel in 30 seconds

  Observe:
    status [--json]        Project health snapshot
    history [--json]       List all runs
    inspect <id> [--json]  Deep-dive into a run
    replay <id> [--json]   Re-run with different settings

  Advanced:
    run-graph --graph <p>  Execute a DAG of tasks
    run-strategy --strat   Run a custom multi-role strategy

  Project:
    init                   Initialize .buildplane in this repo
    memory <action>        Manage stored learnings
    pack show <id>         Inspect a pack

  buildplane run --help    Show run options (--raw, --tui)
```

`install`/`uninstall` removed from help listing (still functional).

**Per-command help:** `buildplane run --help` shows:

```
buildplane run --packet <path> [options]

  By default, runs implement-then-review: an implementer executes the task,
  then a reviewer verifies the output. This is what makes Buildplane runs
  self-correcting.

  Options:
    --raw            Single-shot execution (no review loop)
    --tui            Interactive terminal UI
    --json           Machine-readable output
```

### 4. Architecture & Files

**New file:** `apps/cli/src/strategy-wrapper.ts`
- Pure function: `wrapAsStrategy(packet): StrategyPacket`
- No I/O, no storage/runtime imports — data transformation only
- Exports the reviewer system prompt template as a constant (testable)

**Modified file:** `apps/cli/src/run-cli.ts`
- `case "run"` — parse `--raw`, dispatch to `orchestrator.runStrategy()` when not raw
- `formatTopLevelHelp()` — grouped sections
- New `formatRunHelp()` — per-command help for `buildplane run --help`
- New `formatStrategyRunResult()` — formats `StrategyResult` for terminal output

**New file:** `apps/cli/test/strategy-wrapper.test.ts`
- Model packet → strategy with model reviewer (verify system prompt, dependsOn, role, inputRefs)
- Command packet → strategy with file-check reviewer (verify sh command, test -s checks)
- Packet with no expectedOutputs → reviewer runs `true`
- Strategy ID, mode, mergePolicy are set correctly

**No kernel, storage, or policy changes.** The strategy executor, orchestrator, and all infrastructure remain untouched.

## Files Changed

| File | Change |
|------|--------|
| `apps/cli/src/strategy-wrapper.ts` | **Create** — `wrapAsStrategy()` pure function |
| `apps/cli/src/run-cli.ts` | **Modify** — `case "run"` dispatches to strategy by default; `formatTopLevelHelp()` grouped; add `formatRunHelp()`; add `formatStrategyRunResult()` |
| `apps/cli/test/strategy-wrapper.test.ts` | **Create** — unit tests for wrapping logic |

## Tests

| Test File | Coverage |
|-----------|----------|
| `apps/cli/test/strategy-wrapper.test.ts` | Model packet wrapping, command packet wrapping, no-outputs fallback, strategy metadata |

## Explicitly Out of Scope

- **Kernel changes** — wrapping is a CLI concern
- **Pack-driven reviewers** — packs aren't ready
- **Custom reviewer prompts** — hardcoded template is sufficient for MVP
- **Per-command `--help` for other commands** — only `run` gets it
- **Strategy result TUI rendering changes** — existing TUI handles strategy events

## Success Criteria

1. `buildplane run --packet model-task.json` runs implement-then-review with a model reviewer
2. `buildplane run --packet cmd-task.json` runs implement-then-review with a file-check reviewer
3. `buildplane run --packet task.json --raw` runs single-shot (backward compat)
4. `buildplane` (no args) shows grouped help with `run` as the hero command
5. `buildplane run --help` shows strategy explanation and flag list
6. `buildplane demo` still works
7. All existing tests pass, new wrapper tests pass
