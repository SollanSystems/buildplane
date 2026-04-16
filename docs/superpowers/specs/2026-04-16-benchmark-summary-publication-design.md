# Benchmark Summary Publication Design

## Slice name

Phase 5 / Slice 5C1: publish benchmark summary in repo docs

## Why this slice

5A1 through 5B2 established the first model-backed evaluation evidence:
- the `model-codex` suite runs locally behind an explicit opt-in gate
- memory changes outcomes on at least one fixture
- strategy changes outcomes on at least one fixture
- one fixture now proves only `memory+strategy` succeeds

The next smallest useful step is not more harness infrastructure. It is to publish the evidence already produced by the harness so the repo has a durable, reviewable benchmark summary.

This keeps scope narrow:
- one new benchmark summary doc
- one README pointer
- contract tests for both surfaces
- no new runtime or provider behavior

## Architecture

### 1. Add one benchmark summary doc

Create:
- `docs/benchmarks/model-codex.md`

Recommended shape:
- purpose
- how to rerun
- current aggregate snapshot
- fixture-by-fixture evidence
- comparison guidance

The doc should use the existing `EvalReport` vocabulary instead of inventing new benchmark terms.

### 2. Keep the benchmark doc as the source of truth

Prefer:
- a concise README pointer to the benchmark doc
- the full benchmark narrative and matrix living in `docs/benchmarks/model-codex.md`

Avoid:
- duplicating the full benchmark content inside `README.md`
- turning the README into a second benchmark source of truth

### 3. Add contract tests for docs surfaces

Add a new workflow-level contract test that reads `docs/benchmarks/model-codex.md` and asserts it contains:
- the opt-in gate and rerun command
- the current aggregate field names
- the current fixture names
- plain-language proof summaries for memory help, strategy help, and memory-plus-strategy help

Also extend the README contract test so the README must keep linking to the benchmark summary doc.

### 4. Keep the slice narrow

Prefer touching only:
- `docs/benchmarks/model-codex.md`
- `README.md`
- `test/workflow/benchmark-summary-contract.test.ts`
- `test/workflow/readme-contract.test.ts`
- new slice docs

Avoid runtime changes unless a tiny doc/example correction proves strictly necessary.

## Likely files

### New
- `docs/benchmarks/model-codex.md`
- `test/workflow/benchmark-summary-contract.test.ts`
- `docs/superpowers/specs/2026-04-16-benchmark-summary-publication-requirements.md`
- `docs/superpowers/specs/2026-04-16-benchmark-summary-publication-design.md`
- `docs/superpowers/plans/2026-04-16-benchmark-summary-publication-tasks.md`

### Modified
- `README.md`
- `test/workflow/readme-contract.test.ts`

## Verification set

Focused tests:

```bash
npx vitest run \
  test/workflow/benchmark-summary-contract.test.ts \
  test/workflow/readme-contract.test.ts \
  test/eval/model-codex-suite.test.ts
```

Supporting checks:

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no CI eval workflow
- no multi-provider benchmark publication
- no report-format or runner-schema redesign
- no benchmark generation automation
- no new eval fixtures
