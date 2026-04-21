# Reviewer-Rescue Comparison Requirements

## Goal

Advance Phase 5 with the next smallest useful raw-agent comparison slice: add one deterministic model-backed fixture that proves Buildplane's implement-then-review strategy can recover and produce an approved outcome where a comparable raw one-shot attempt does not.

## User story

As a Buildplane operator, I want the eval harness to show at least one fixture where strategy beats raw on the same model path, so I have concrete evidence that Buildplane's reviewer loop adds value beyond a plain single-shot agent run.

## In scope

Keep the existing `model-codex` suite and add one additional fixture that compares strategy vs raw behavior.

This slice must:
- preserve the existing `model-codex` suite id and opt-in gate
- keep existing fixtures unchanged
- add one new fixture under `eval/suites/model-codex/`
- keep the four existing eval conditions:
  - `memory+strategy`
  - `memory+raw`
  - `nomemory+strategy`
  - `nomemory+raw`
- use the same model-backed implementer path for raw and strategy comparisons
- measure raw success using the same approval standard strategy uses, but without granting a retry loop
- make at least one strategy condition succeed where the corresponding raw condition fails
- surface a narrow strategy-vs-raw aggregate such as `strategyHelpedRate`

## Exact behavior

### New fixture behavior

The new fixture must be designed so that:
- the first implementer attempt produces an artifact that satisfies basic output existence checks but does not satisfy reviewer approval
- the reviewer emits deterministic rejection feedback
- a second implementer round can use that feedback to produce the approved artifact
- the raw path receives no retry and is judged against the same reviewer standard

### Comparison semantics

For this slice:
- strategy conditions may use the existing implement-then-review retry loop
- raw conditions must remain single-shot from the implementer's perspective
- raw conditions must be judged against the same approval standard as strategy, but without granting a retry or second model pass
- the raw comparison path may use a deterministic measurement-only approval check over produced artifacts as long as it matches the reviewer acceptance rule for the fixture

### Aggregate proof

Add one narrow aggregate that captures strategy advantage over raw, for example:
- `strategyHelpedRate`

The aggregate should count fixtures where a strategy condition produced an approved outcome and the corresponding raw condition did not.

## Constraints

- Keep this slice TypeScript-first
- Keep provider support limited to Codex only
- Keep `BUILDPLANE_EVAL_MODEL=1` as the only model-suite opt-in gate
- Keep the raw-vs-strategy comparison local-only for now
- Do not add CI-backed model evaluation yet
- Do not widen into benchmark docs publication, multi-provider matrices, or broader eval-harness redesign
- Keep any harness changes narrow to raw-vs-strategy comparison and aggregate reporting

## Out of scope

- new suite ids beyond `model-codex`
- benchmark docs publication (Phase 5C)
- CI workflow additions for eval
- multi-provider or Claude-backed model fixtures
- broad report redesign beyond one additive strategy comparison metric
- host/provider autodetection or auth doctoring

## Acceptance criteria

- `BUILDPLANE_EVAL_MODEL=1 pnpm eval --suite model-codex --json` reports the new comparison fixture
- at least one strategy condition for the new fixture passes while the corresponding raw condition fails
- the suite JSON/report includes a narrow strategy-vs-raw aggregate reflecting that win
- existing `hello-memory-smoke` and `memory-helped-path` fixtures remain green
- focused tests cover the comparison fixture and the additive aggregate behavior
- `pnpm eval --suite local --json` remains unchanged and passes
