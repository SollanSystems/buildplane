# Benchmark Summary Publication Requirements

## Goal

Advance Phase 5 with the next smallest useful follow-up slice: publish the current `model-codex` benchmark summary in repo docs so Buildplane's new memory/strategy evidence is easy to discover and compare across changes.

## User story

As a Buildplane operator or reviewer, I want a checked-in benchmark summary that explains what the current `model-codex` suite proves and how to rerun it, so I can evaluate Buildplane's claims without reverse-engineering the eval harness.

## In scope

Keep this slice narrow and documentation-first.

This slice must:
- add one checked-in benchmark summary doc for the current `model-codex` suite
- document the exact rerun command for the opt-in Codex model suite
- summarize the current aggregate metrics already emitted by `eval/report.ts`
- summarize what each current `model-codex` fixture proves
- add a README pointer to the benchmark summary instead of duplicating the whole report in the README
- add contract tests that pin the benchmark-summary doc surface and README pointer

## Exact behavior

### Benchmark summary doc

The new benchmark summary doc must:
- live under `docs/benchmarks/`
- be focused on the existing `model-codex` suite only
- include the opt-in env gate:
  - `BUILDPLANE_EVAL_MODEL=1`
- include the rerun command:
  - `npx pnpm eval --suite model-codex --json`
- describe the current aggregate fields:
  - `passRate`
  - `memoryInjectedRate`
  - `memoryHelpedRate`
  - `strategyHelpedRate`
  - `meanDurationMs`
- explain the current fixture-level evidence for:
  - `hello-memory-smoke`
  - `memory-helped-path`
  - `reviewer-rescue`
  - `memory-strategy-rescue`
- explicitly state the three strongest proofs now present:
  - memory helps on at least one model-backed fixture
  - strategy helps on at least one model-backed fixture
  - memory plus strategy together help on at least one model-backed fixture
- explain that duration is environment-sensitive and should be treated as advisory rather than as a strict contract

### README pointer

The README must:
- point readers to the benchmark summary doc
- mention the eval/benchmark surface briefly
- avoid duplicating the full benchmark table or becoming the benchmark source of truth

## Constraints

- Keep this slice docs-first and reviewable
- Reuse the existing `model-codex` suite and report semantics
- Do not add new eval suite ids, new providers, or new runner flags
- Do not widen into CI eval workflow, benchmark automation, or report-schema redesign
- Keep verification local and deterministic

## Out of scope

- CI-backed eval execution
- multi-provider benchmark docs
- auto-generated benchmark publishing scripts
- broad README rewrite
- new aggregates or changes to report semantics
- new eval fixtures beyond the current `model-codex` set

## Acceptance criteria

- `docs/benchmarks/model-codex.md` exists and documents the current `model-codex` benchmark surface
- the new doc names the current aggregate metrics and current fixtures
- the new doc explains the memory-help, strategy-help, and memory-plus-strategy proofs in plain language
- the README links to the benchmark summary doc
- focused contract tests cover the benchmark-summary doc and README pointer
- existing `model-codex` suite assertions remain green
