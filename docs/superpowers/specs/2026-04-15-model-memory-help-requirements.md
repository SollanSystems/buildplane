# Model Memory-Help Fixture Requirements

## Goal

Advance Phase 5 with the next smallest useful model-backed eval slice: add one additional Codex-backed fixture that proves injected memories can materially improve outcome on a model path, not just appear in the prompt.

## User story

As a Buildplane operator, I want at least one model-backed eval fixture where memory-on outperforms memory-off, so I can point to concrete behavioral evidence that the memory flywheel helps on a real model-worker route.

## In scope

Keep the existing opt-in `model-codex` suite and add one new fixture under it.

This slice must:

- preserve the existing `model-codex` suite id and opt-in gate
- keep the existing `hello-memory-smoke` fixture unchanged
- add one second fixture whose outcome depends on injected memories
- keep all four existing eval conditions for the new fixture:
  - `memory+strategy`
  - `memory+raw`
  - `nomemory+strategy`
  - `nomemory+raw`
- make `memory+strategy` pass while `nomemory+strategy` fails or performs worse for the new fixture
- cause the suite-level `memoryHelpedRate` to become greater than `0`
- remain fully local-only and testable with a stub `codex` binary

## Exact behavior

### New fixture shape

The new fixture must be designed so that:

- run 1 fails in a deterministic way that seeds a learning containing an exact output path
- run 2 is a Codex-backed model packet whose intent does not reveal that output path directly
- the injected memory block for run 2 contains the exact missing output path from run 1
- a prompt-sensitive test stub can therefore succeed only when memories are injected

### Behavioral proof

For the new fixture:

- `memory+strategy` must pass
- `memory+raw` should pass
- `nomemory+strategy` must fail or require more rounds than `memory+strategy`
- `nomemory+raw` should fail

This slice may use the existing `memoryHelpedRate` definition in `eval/report.ts`; do not redesign the report schema.

## Constraints

- Keep the slice narrow to fixture/test/doc work unless a tiny harness adjustment is unavoidable
- Keep provider support limited to Codex only
- Keep `BUILDPLANE_EVAL_MODEL=1` as the only model-suite opt-in gate
- Do not add CI-backed model evaluation yet
- Do not widen into multi-provider fixtures, benchmark publication, or raw-agent comparison suites
- Do not change CLI/runtime routing semantics unless required for the fixture to run deterministically

## Out of scope

- new suites beyond `model-codex`
- raw-agent comparison suites (Phase 5B)
- benchmark docs publication (Phase 5C)
- CI workflow additions for evals
- multi-provider or Claude-backed model fixtures
- report schema redesign
- host/provider autodetection or auth doctoring

## Acceptance criteria

- `BUILDPLANE_EVAL_MODEL=1 pnpm eval --suite model-codex --json` now reports two fixtures
- the existing `hello-memory-smoke` fixture still passes unchanged
- the new fixture proves a behavioral delta:
  - `memory+strategy` passes
  - `nomemory+strategy` does not match that outcome
- suite aggregates show `memoryHelpedRate > 0`
- focused tests cover the new fixture and the prompt-sensitive Codex stub behavior
- `pnpm eval --suite local --json` remains unchanged and passes
