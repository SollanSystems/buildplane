# Reviewer-Rescue Comparison Design

## Slice name

Phase 5 / Slice 5B1: reviewer-rescue raw-agent comparison

## Why this slice

Slice 5A2 already proves memory can help on a model-backed path.
The next unproven product claim is that Buildplane's strategy loop improves outcomes compared with a raw one-shot agent.

This slice keeps scope narrow:
- one new fixture in `model-codex`
- one additive aggregate in the eval report
- no new provider
- no CI integration
- no benchmark publication work

## Architecture

### 1. Add one comparison fixture under `model-codex`

Create a fixture such as:
- `eval/suites/model-codex/reviewer-rescue/`

Shape:
- `run-1.json`: deterministic command packet that seeds a benign workspace state or memory
- `run-2.json`: model packet for an artifact whose first attempt should be reviewer-rejected but whose second attempt can be corrected using reviewer feedback

The fixture should be deterministic under the existing stub-Codex approach.

### 2. Judge raw attempts with the same approval standard

The current raw conditions only look at direct run success, which is too weak for a fair strategy-vs-raw comparison when the strategy loop's value comes from reviewer approval.

Add one narrow comparison rule inside `eval/runner.ts`:
- strategy conditions keep using `wrapAsStrategy(...)` and `orchestrator.runStrategy(...)`
- raw conditions remain single-shot implementer execution
- after a raw model execution for the comparison fixture, run a measurement-only reviewer packet against the produced output
- if that reviewer rejects, mark the raw condition as failed for eval purposes
- do not feed the reviewer response back into the raw implementer

This preserves the distinction:
- raw = one shot, no recovery
- strategy = reviewer-guided retry allowed

### 3. Add a narrow strategy-vs-raw aggregate

Extend `eval/report.ts` with one additive aggregate field:
- `strategyHelpedRate`

Computation:
- compare strategy vs raw under the same memory setting for each fixture
- count a fixture as strategy-helped when a strategy condition passes and the corresponding raw condition fails
- keep existing `memoryInjectedRate` and `memoryHelpedRate` semantics unchanged

### 4. Make the test Codex stub support reviewer rescue

Extend `test/eval/model-codex-suite.test.ts` so the stub can model three states for the new fixture:
- initial implementer prompt → writes a draft artifact that reviewers reject
- reviewer prompt for the fixture → rejects unless the artifact contains the approved/fixed form
- implementer prompt containing reviewer feedback from round 1 → writes the corrected artifact

This gives deterministic outcomes:
- `*+strategy` can pass after reviewer-guided retry
- `*+raw` fails because the measurement-only reviewer rejects the single-shot draft

### 5. Keep the slice narrow

Prefer touching only:
- `eval/runner.ts`
- `eval/report.ts`
- `test/eval/model-codex-suite.test.ts`
- new fixture files
- new slice docs

Avoid wider CLI/runtime/router changes unless a tiny adjustment is strictly required.

## Likely files

### New
- `eval/suites/model-codex/reviewer-rescue/meta.json`
- `eval/suites/model-codex/reviewer-rescue/run-1.json`
- `eval/suites/model-codex/reviewer-rescue/run-2.json`

### Modified
- `eval/runner.ts`
- `eval/report.ts`
- `test/eval/model-codex-suite.test.ts`
- `docs/superpowers/specs/2026-04-15-reviewer-rescue-comparison-requirements.md`
- `docs/superpowers/specs/2026-04-15-reviewer-rescue-comparison-design.md`
- `docs/superpowers/plans/2026-04-15-reviewer-rescue-comparison-tasks.md`

## Verification set

Focused tests:

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Harness checks:

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
node --import tsx ./eval/runner.ts --suite model-codex --json
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no benchmark publication/docs work
- no CI eval workflow
- no multi-provider model fixture expansion
- no broad report-format redesign
