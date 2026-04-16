# Memory-Strategy Comparison Requirements

## Goal

Advance Phase 5 with the next smallest useful comparison slice: add one deterministic `model-codex` fixture that proves Buildplane's full memory-plus-strategy loop can succeed where raw and no-memory variants do not.

## User story

As a Buildplane operator, I want at least one model-backed eval fixture where only `memory+strategy` succeeds, so I have concrete evidence that Buildplane's remembered context and reviewer loop work together rather than as isolated wins.

## In scope

Keep the existing `model-codex` suite and add one additional fixture under it.

This slice must:
- preserve the existing `model-codex` suite id and opt-in gate
- keep existing fixtures unchanged
- add one new fixture under `eval/suites/model-codex/`
- keep the four existing eval conditions:
  - `memory+strategy`
  - `memory+raw`
  - `nomemory+strategy`
  - `nomemory+raw`
- design the fixture so the hidden target path is available only through injected memories
- require reviewer-guided retry to convert the first draft into the approved artifact
- make `memory+strategy` succeed while the other three conditions fail
- reuse the existing `memoryHelpedRate` and `strategyHelpedRate` metrics without broad report redesign

## Exact behavior

### New fixture behavior

The new fixture must be designed so that:
- run 1 seeds a memory containing an exact artifact path or approval hint not revealed directly in run 2's visible objective
- run 2's first implementer attempt can produce a draft artifact that the reviewer rejects
- a strategy retry can use reviewer feedback to produce the approved artifact
- without injected memory, neither raw nor strategy can discover the correct target/approval path

### Comparison semantics

For this slice:
- `memory+strategy` should pass
- `memory+raw` should fail because it has no retry path
- `nomemory+strategy` should fail because it lacks the hidden memory needed for the correct artifact
- `nomemory+raw` should fail for both reasons

## Constraints

- Keep this slice TypeScript-first
- Keep provider support limited to Codex only
- Keep `BUILDPLANE_EVAL_MODEL=1` as the only model-suite opt-in gate
- Keep the comparison local-only for now
- Do not add CI-backed model evaluation yet
- Do not widen into benchmark docs publication, multi-provider matrices, or broader eval-harness redesign
- Prefer fixture/test changes over new runtime abstractions

## Out of scope

- new suite ids beyond `model-codex`
- benchmark docs publication (Phase 5C)
- CI workflow additions for eval
- multi-provider or Claude-backed model fixtures
- broad report redesign
- host/provider autodetection or auth doctoring

## Acceptance criteria

- `BUILDPLANE_EVAL_MODEL=1 pnpm eval --suite model-codex --json` reports the new comparison fixture
- the new fixture shows only `memory+strategy` passing
- existing `memoryHelpedRate` and `strategyHelpedRate` remain non-zero and the new fixture strengthens both proofs
- existing fixtures remain green
- focused tests cover the new fixture and its deterministic stub behavior
- `pnpm eval --suite local --json` remains unchanged and passes
