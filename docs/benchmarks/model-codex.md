# Model Codex benchmark summary

This document is the checked-in benchmark summary for Buildplane's current `model-codex` suite.

It is the Phase 5 source of truth for what the repo currently proves about model-backed memory help, strategy/reviewer help, and the combined memory-plus-strategy path.

## How to rerun

The default run is local and deterministic. It uses the built-in Codex eval stub
so CI and local development can exercise the suite without calling a model.

```bash
npx pnpm eval --suite model-codex --json
```

Use that command when you want the current JSON `EvalReport` for the
`model-codex` suite. Set `BUILDPLANE_EVAL_MODEL=1` only when you explicitly want
to exercise the real Codex CLI instead of the local stub.

## Current aggregate snapshot

The current suite contains:
- `4` fixtures
- `16` total conditions

The aggregate block currently uses these fields:
- `passRate`
- `memoryInjectedRate`
- `memoryHelpedRate`
- `strategyHelpedRate`
- `combinedHelpedRate`
- `meanDurationMs`

Current checked-in snapshot from one local stub-backed run:

| Aggregate field | Current snapshot | Meaning |
| --- | --- | --- |
| `passRate` | `43.75% (7/16)` | Snapshot from that local stub-backed run; not guaranteed to reproduce in every environment |
| `memoryInjectedRate` | `100% (4/4 fixtures)` | Every current fixture has a memory-on path where memories were injected in that snapshot |
| `memoryHelpedRate` | `25% (1/4 fixtures)` | Memory changed the outcome on one current fixture in that snapshot |
| `strategyHelpedRate` | `50% (2/4 fixtures)` | Strategy changed the outcome on two current fixtures in that snapshot |
| `combinedHelpedRate` | `25% (1/4 fixtures)` | Only the combined memory-plus-strategy path succeeds on one current fixture in that snapshot |
| `meanDurationMs` | `645ms` in one verified local stub run | Useful for rough comparison only; environment-sensitive and not a pass/fail contract |

The default local-stub run should not require a working Codex CLI. A
`BUILDPLANE_EVAL_MODEL=1` run does require a working Codex/eval environment and
may fail before producing comparable output if the current host lacks the native
Codex optional dependency.

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

### `memory-strategy-combined-only`

- `memory+strategy`: pass
- `memory+raw`: fail
- `nomemory+strategy`: fail
- `nomemory+raw`: fail

This fixture is the combined-only proof: run 1 creates a missing-output verification trail for the exact artifact path, and run 2 requires both injected memory and the implement-then-review recovery loop to produce the approved artifact. It protects the regression case where memory alone or strategy alone can look useful but the operator-trust story depends on both layers working together.

## Concrete rescue/recovery story

The `reviewer-rescue` fixture is the current concrete comparison against raw one-shot execution:

| Condition | Outcome | Operator meaning |
| --- | --- | --- |
| `memory+raw` | fail | The raw one-shot path writes `output/reviewer-rescue.js`, but the draft remains reviewer-rejected because there is no corrective review loop. |
| `memory+strategy` | pass | Buildplane's implement-then-review strategy records reviewer feedback after round 1, reruns the implementer with that feedback, and produces the accepted `approved reviewer rescue` result. |
| `nomemory+raw` | fail | Removing memory does not rescue the raw path; the failure is about absent review/recovery, not just missing context. |
| `nomemory+strategy` | pass | The same implement-then-review loop still rescues the task, so this fixture proves strategy/reviewer help rather than memory dependence. |

This is the current proof that Buildplane's control-plane loop can change a meaningful outcome: inspect/review evidence identifies a rejected draft, the strategy path feeds that evidence back into the worker, and the second attempt lands an accepted artifact. Treat it as a rescue/recovery demo story, not a broad performance benchmark.

## What this benchmark currently proves

Buildplane currently has checked-in benchmark evidence that:
- the model-backed Codex eval path executes end-to-end
- memory changes the outcome on at least one model-backed fixture
- strategy changes the outcome on at least one model-backed fixture
- the combined-only memory-plus-strategy path exists: `memory+strategy` passes while `memory+raw`, `nomemory+strategy`, and `nomemory+raw` fail on `memory-strategy-combined-only`

## How to compare across changes

When you update the eval harness or fixtures:
1. rerun `npx pnpm eval --suite model-codex --json`
2. compare the aggregate block (`passRate`, `memoryInjectedRate`, `memoryHelpedRate`, `strategyHelpedRate`, `combinedHelpedRate`, `meanDurationMs`)
3. compare each fixture outcome matrix
4. keep the current core proofs intact unless intentionally replacing them:
   - model-backed smoke via `hello-memory-smoke`
   - memory help via `memory-helped-path`
   - strategy help via `reviewer-rescue`
   - combined memory-plus-strategy help via `memory-strategy-combined-only`
5. if a combined-only proof changes, document the fixture and update this summary in the same slice

If the fixture set changes, update this document in the same slice so the checked-in benchmark summary stays aligned with the current suite.
