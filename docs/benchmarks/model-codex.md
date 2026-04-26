# Model Codex benchmark summary

This document is the checked-in benchmark summary for Buildplane's current `model-codex` suite.

It is the Phase 5 source of truth for what the repo currently proves about model-backed memory help and strategy/reviewer help. It also records the current benchmark gap: the checked-in suite does not presently include a fixture where only the combined memory-plus-strategy path succeeds.

## How to rerun

Model-backed eval suites stay opt-in.

```bash
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
```

Use that command when you want the current JSON `EvalReport` for the `model-codex` suite.

## Current aggregate snapshot

The current suite contains:
- `3` fixtures
- `12` total conditions

The aggregate block currently uses these fields:
- `passRate`
- `memoryInjectedRate`
- `memoryHelpedRate`
- `strategyHelpedRate`
- `meanDurationMs`

Current checked-in snapshot from one local stub-backed run:

| Aggregate field | Current snapshot | Meaning |
| --- | --- | --- |
| `passRate` | `66.67% (8/12)` | Snapshot from that local stub-backed run; not guaranteed to reproduce in every environment |
| `memoryInjectedRate` | `100% (3/3 fixtures)` | Every current fixture has a memory-on path where memories were injected in that snapshot |
| `memoryHelpedRate` | `33.33% (1/3 fixtures)` | Memory changed the outcome on one current fixture in that snapshot |
| `strategyHelpedRate` | `33.33% (1/3 fixtures)` | Strategy changed the outcome on one current fixture in that snapshot |
| `meanDurationMs` | `233ms` in one verified local stub run | Useful for rough comparison only; environment-sensitive and not a pass/fail contract |

Re-running the benchmark requires a working Codex/eval environment. If the current host lacks the native Codex optional dependency, the rerun may fail before producing comparable output.

`meanDurationMs` is intentionally advisory. Duration is environment-sensitive and should not be treated as the primary pass/fail contract.

## Fixture-by-fixture evidence

### `hello-memory-smoke`

- `memory+strategy`: pass
- `memory+raw`: pass
- `nomemory+strategy`: pass
- `nomemory+raw`: pass

This fixture proves the `model-codex` suite and Codex worker path execute end-to-end. It acts as the basic model-backed smoke fixture and confirms memory-on variants receive injected memories, but it is not intended to prove memory or strategy changes the outcome.

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

This fixture proves strategy changes the outcome: Buildplane's reviewer loop rescues a draft that the raw one-shot path leaves rejected. It does not prove memory is required, because the no-memory strategy path also passes.

## What this benchmark currently proves

Buildplane currently has checked-in benchmark evidence that:
- the model-backed Codex eval path executes end-to-end
- memory changes the outcome on at least one model-backed fixture
- strategy changes the outcome on at least one model-backed fixture

Current benchmark gap:
- the checked-in suite does not currently prove a combined-only memory-plus-strategy path where `memory+strategy` passes while `memory+raw`, `nomemory+strategy`, and `nomemory+raw` all fail

## How to compare across changes

When you update the eval harness or fixtures:
1. rerun `BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json`
2. compare the aggregate block (`passRate`, `memoryInjectedRate`, `memoryHelpedRate`, `strategyHelpedRate`, `meanDurationMs`)
3. compare each fixture outcome matrix
4. keep the current core proofs intact unless intentionally replacing them:
   - model-backed smoke via `hello-memory-smoke`
   - memory help via `memory-helped-path`
   - strategy help via `reviewer-rescue`
5. if a combined-only proof is restored, document the fixture and update this summary in the same slice

If the fixture set changes, update this document in the same slice so the checked-in benchmark summary stays aligned with the current suite.
