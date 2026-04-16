# Model Codex benchmark summary

This document is the checked-in benchmark summary for Buildplane's current `model-codex` suite.

It is the Phase 5 source of truth for what the repo currently proves about memory help, strategy help, and the combined memory-plus-strategy path.

## How to rerun

Model-backed eval suites stay opt-in.

```bash
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
```

Use that command when you want the current JSON `EvalReport` for the `model-codex` suite.

## Current aggregate snapshot

The current suite contains:
- `4` fixtures
- `16` total conditions

The aggregate block currently uses these fields:
- `passRate`
- `memoryInjectedRate`
- `memoryHelpedRate`
- `strategyHelpedRate`
- `meanDurationMs`

Current checked-in snapshot:

| Aggregate field | Current snapshot | Meaning |
| --- | --- | --- |
| `passRate` | `56.25% (9/16)` | Overall pass rate across the four condition variants for each fixture |
| `memoryInjectedRate` | `100% (4/4 fixtures)` | Every fixture now has a memory-on path where memories were injected |
| `memoryHelpedRate` | `50% (2/4 fixtures)` | Memory changes the outcome on at least two fixtures |
| `strategyHelpedRate` | `50% (2/4 fixtures)` | Strategy changes the outcome on at least two fixtures |
| `meanDurationMs` | `216ms` in one verified local run | Useful for rough comparison only |

`meanDurationMs` is intentionally advisory. Duration is environment-sensitive and should not be treated as the primary pass/fail contract.

## Fixture-by-fixture evidence

### `hello-memory-smoke`

- all four conditions pass
- proves the `model-codex` suite and Codex worker path execute end-to-end
- acts as the basic model-backed smoke fixture

### `memory-helped-path`

- `memory+strategy`: pass
- `memory+raw`: pass
- `nomemory+strategy`: fail
- `nomemory+raw`: fail

This fixture proves memory changes the outcome: the exact output path arrives through injected memories, and the no-memory variants do not recover it.

### `reviewer-rescue`

- `memory+strategy`: pass
- `memory+raw`: fail
- `nomemory+strategy`: pass
- `nomemory+raw`: fail

This fixture proves strategy changes the outcome: Buildplane's reviewer loop rescues a draft that the raw one-shot path leaves rejected.

### `memory-strategy-rescue`

- `memory+strategy`: pass
- `memory+raw`: fail
- `nomemory+strategy`: fail
- `nomemory+raw`: fail

This fixture proves only `memory+strategy` succeeds: memory alone is not enough, and strategy without the hidden memory path still fails.

## What this benchmark now proves

Buildplane now has checked-in benchmark evidence that:
- memory changes the outcome on at least one model-backed fixture
- strategy changes the outcome on at least one model-backed fixture
- only `memory+strategy` succeeds on at least one model-backed fixture

## How to compare across changes

When you update the eval harness or fixtures:
1. rerun `BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json`
2. compare the aggregate block (`passRate`, `memoryInjectedRate`, `memoryHelpedRate`, `strategyHelpedRate`, `meanDurationMs`)
3. compare each fixture outcome matrix
4. keep the three core proofs intact:
   - memory help via `memory-helped-path`
   - strategy help via `reviewer-rescue`
   - combined memory-plus-strategy help via `memory-strategy-rescue`

If the fixture set changes, update this document in the same slice so the checked-in benchmark summary stays aligned with the current suite.
